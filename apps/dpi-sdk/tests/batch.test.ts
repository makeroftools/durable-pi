import { test } from "node:test";
import assert from "node:assert/strict";
import { DpiClient, launchKey } from "../src/client.js";
import type { CreateSessionBody, LaunchResult } from "../src/api.js";

// A batch launch is one act: N worktrees, one brief. It is sequential on purpose (a device opens one harness per
// session), it stops at the first failure, and every item carries a key derived only from the batch key and the
// spec — so a retry re-admits what already exists instead of starting a second session.

const spec = (name: string, cwd = `/work/${name}`): CreateSessionBody => ({
  name,
  cwd,
  model: { provider: "faux", modelId: "echo" },
  prompt: "Fix the failing test",
});

interface Call {
  method: string;
  url: string;
  key?: string;
  body?: unknown;
}

/** Replace fetch for one test; `respond` decides each call. Records every request in order. */
function stubFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: String(init?.method ?? "GET"),
      url: String(input),
      key: headers.get("idempotency-key") ?? undefined,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const launch = (call: Call, extra: Partial<LaunchResult> = {}): LaunchResult => ({
  id: `session-${String((call.body as CreateSessionBody).name)}`,
  name: (call.body as CreateSessionBody).name,
  cwd: (call.body as CreateSessionBody).cwd,
  model: "echo",
  createdAt: 1,
  dbPath: "/data/agent.sqlite",
  busy: false,
  agents: [{ id: 1, name: "Main", named: false, kind: "root", busy: false, background: 0 }],
  prompt: { submissionId: 1 },
  ...extra,
});

const launched = (call: Call, extra: Partial<LaunchResult> = {}) =>
  new Response(JSON.stringify(launch(call, extra)), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

test("batch: sequential, one deterministic key per item, results in order", async () => {
  const stub = stubFetch((call) => launched(call));
  try {
    const client = new DpiClient("http://device.test");
    const specs = [spec("a"), spec("b"), spec("c")];
    const seen: number[] = [];
    const result = await client.createSessions(specs, "act-1", {
      onProgress: (item) => seen.push(item.index),
    });

    assert.equal(result.failedAt, undefined);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.deepEqual(
      result.items.map((i) => i.result?.name),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      stub.calls.map((c) => c.body),
      specs,
      "every spec is sent verbatim, in order",
    );
    // Keys are the pure function of (batchKey, spec), independent of position.
    assert.deepEqual(
      stub.calls.map((c) => c.key),
      specs.map((s) => launchKey("act-1", s)),
    );
    for (const call of stub.calls) assert.ok(call.key!.length <= 128, "the device caps the key at 128 chars");
    assert.equal(new Set(stub.calls.map((c) => c.key)).size, 3, "each item has its own key");
  } finally {
    stub.restore();
  }
});

test("batch: a retry with the same batchKey sends identical keys, in any order", async () => {
  const stub = stubFetch((call) => launched(call));
  try {
    const client = new DpiClient("http://device.test");
    const [a, b, c] = [spec("a"), spec("b"), spec("c")];
    await client.createSessions([a, b, c], "act-1");
    const first = stub.calls.map((k) => k.key);
    stub.calls.length = 0;
    await client.createSessions([c, a, b], "act-1");
    assert.deepEqual(stub.calls.map((k) => k.key), [first[2], first[0], first[1]]);
    // A different act of launching is a different set of sessions.
    await client.createSessions([a], "act-2");
    assert.notEqual(stub.calls[3].key, first[0]);
    // Editing the brief is a different request, hence a different key: never a silent replay of the old one.
    await client.createSessions([{ ...a, prompt: "Another brief" }], "act-1");
    assert.notEqual(stub.calls[4].key, first[0]);
  } finally {
    stub.restore();
  }
});

test("batch: stops at the first failure and reports it; the rest are never sent", async () => {
  let broken = true;
  const stub = stubFetch((call) => {
    if ((call.body as CreateSessionBody).name !== "b" || !broken) return launched(call);
    broken = false;
    return fail(400, "invalid", "cwd must be an existing folder");
  });
  try {
    const client = new DpiClient("http://device.test");
    const result = await client.createSessions([spec("a"), spec("b"), spec("c")], "act-1");
    assert.equal(result.failedAt, 1);
    assert.equal(result.items[0].result?.name, "a");
    assert.deepEqual(result.items[1].error, { code: "invalid", message: "cwd must be an existing folder" });
    assert.deepEqual(result.items[2], {
      index: 2,
      spec: spec("c"),
      idempotencyKey: launchKey("act-1", spec("c")),
    });
    assert.equal(stub.calls.length, 2, "the items after the failure are not attempted");

    // The retry converges: the same keys go out (a replays the recorded launch), and the rest complete.
    stub.calls.length = 0;
    const retry = await client.createSessions([spec("a"), spec("b"), spec("c")], "act-1");
    assert.equal(retry.failedAt, undefined);
    assert.deepEqual(
      stub.calls.map((c) => c.key),
      [launchKey("act-1", spec("a")), launchKey("act-1", spec("b")), launchKey("act-1", spec("c"))],
    );
    assert.deepEqual(
      retry.items.map((i) => i.result?.name),
      ["a", "b", "c"],
    );
  } finally {
    stub.restore();
  }
});

test("batch: a seeding failure is reported on the item, not turned into a failed launch", async () => {
  const stub = stubFetch((call) => launched(call, { seedError: "Harness closed", prompt: undefined }));
  try {
    const client = new DpiClient("http://device.test");
    const result = await client.createSessions([spec("a")], "act-1");
    assert.equal(result.failedAt, undefined);
    assert.equal(result.items[0].result?.seedError, "Harness closed");
  } finally {
    stub.restore();
  }
});

test("batch: invalid input fails before any request is sent", async () => {
  const stub = stubFetch((call) => launched(call));
  try {
    const client = new DpiClient("http://device.test");
    await assert.rejects(() => client.createSessions([], "act-1"), /at least one session/);
    await assert.rejects(() => client.createSessions([spec("a")], ""), /batchKey is required/);
    await assert.rejects(() => client.createSessions([spec("a"), spec("b"), { ...spec("c"), cwd: " " }], "act-1"), /specs\[2\]\.cwd is required/);
    await assert.rejects(() => client.createSessions([spec("a"), { ...spec("b"), model: {} as never }], "act-1"), /specs\[1\]\.model/);
    await assert.rejects(
      () => client.createSessions([spec("a"), { ...spec("a") }], "act-1"),
      /specs\[1\] is identical to specs\[0\]/,
    );
    assert.equal(stub.calls.length, 0, "nothing is launched when the batch is not valid as a whole");
  } finally {
    stub.restore();
  }
});

test("batch: an abort stops before the next item and reports it", async () => {
  const abort = new AbortController();
  const stub = stubFetch((call) => {
    abort.abort();
    return launched(call);
  });
  try {
    const client = new DpiClient("http://device.test");
    const result = await client.createSessions([spec("a"), spec("b")], "act-1", { signal: abort.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.failedAt, undefined);
    assert.equal(result.items[0].result?.name, "a");
    assert.equal(result.items[1].result, undefined, "the aborted batch never reached the second item");
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
