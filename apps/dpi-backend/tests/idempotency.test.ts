import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { LaunchResult } from "../../dpi-sdk/src/api.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

// An Idempotency-Key promises "the same request, once". It is bound to the body it was first used with, so a
// retry replays that response and nothing else: a different body under the same key is refused, never answered
// with another request's session. A failed request is not remembered, so it can be retried under its key.
test("Idempotency-Key: replays the same request, refuses a different one, forgets failures", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "idem-box" });
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (key: string, body: unknown) =>
    fetch(`${server.base}/v1/sessions`, {
      method: "POST",
      headers: { ...auth, "idempotency-key": key },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    const client = new DpiClient(server.base, token);
    const body = { name: "Keeper", cwd: t.work, model: faux, prompt: "Go" };

    const first = await post("idem-1", body);
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("idempotent-replay"), null);
    const created = (await first.json()) as LaunchResult;

    // The same request replays: same session, marked as a replay, and no second session exists.
    const replay = await post("idem-1", body);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.equal(((await replay.json()) as LaunchResult).id, created.id);
    assert.equal((await client.sessions()).length, 1);

    // Key order and whitespace are not part of the request: the canonical body matches.
    const reordered = await post(
      "idem-1",
      JSON.stringify({ prompt: "Go", model: { modelId: faux.modelId, provider: faux.provider }, cwd: t.work, name: "Keeper" }),
    );
    assert.equal(reordered.status, 201);
    assert.equal(((await reordered.json()) as LaunchResult).id, created.id);
    assert.equal((await client.sessions()).length, 1);

    // A different body under the same key is a conflict, not another session.
    const changed = await post("idem-1", { ...body, name: "Impostor" });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "conflict");
    assert.equal((await client.sessions()).length, 1);

    // So is the same key on another create route.
    const fork = await fetch(`${server.base}/v1/sessions/${created.id}/agents/1/fork`, {
      method: "POST",
      headers: { ...auth, "idempotency-key": "idem-1" },
      body: JSON.stringify({ entryId: 1 }),
    });
    assert.equal(fork.status, 409);

    // A failed request is not remembered: the retry runs and succeeds.
    const denial = { name: "Doomed", cwd: join(t.root, "missing"), model: faux };
    const rejected = await post("idem-2", denial);
    assert.equal(rejected.status, 400);
    assert.equal((await post("idem-2", denial)).status, 400, "still not remembered");
    const fixed = await post("idem-2", { ...denial, cwd: t.work });
    assert.equal(fixed.status, 201);
    assert.equal(fixed.headers.get("idempotent-replay"), null);
    assert.equal((await client.sessions()).length, 2);

    // The key stays bound to the request that succeeded under it.
    assert.equal((await post("idem-2", denial)).status, 409);
    assert.deepEqual((await client.sessions()).map((s) => s.name).sort(), ["Doomed", "Keeper"]);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

// Upgrading a device must not leave a replay hole: a key stored before bodies were bound has no hash to check,
// so it is refused rather than trusted.
test("a catalog from before body binding migrates and never replays an unverifiable key", async () => {
  const t = await tempStore();
  const store = await t.open();
  const catalogPath = store.catalogPath;
  try {
    store.remember("legacy", "POST /v1/sessions", 201, { id: "old" }, "hash");
  } finally {
    await store.close();
  }
  const legacy = new DatabaseSync(catalogPath);
  try {
    // Simulate a catalog written before versioning: no bodyHash column and no recorded schema_version.
    legacy.exec("ALTER TABLE requests DROP COLUMN bodyHash");
    legacy.prepare("DELETE FROM meta WHERE key='schema_version'").run();
    legacy
      .prepare("INSERT INTO requests VALUES(?,?,?,?,?)")
      .run("ancient", "POST /v1/sessions", 201, '{"id":"a"}', Date.now());
  } finally {
    legacy.close();
  }
  const reopened = await t.open();
  try {
    const columns = (reopened.catalog.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert.ok(columns.includes("bodyHash"), "the column is added on open");
    // Rows that lost their hash cannot be verified, so they are a conflict, never a replay.
    assert.throws(() => reopened.replay("legacy", "POST /v1/sessions", "hash"), /already used for a different request/);
    assert.throws(() => reopened.replay("ancient", "POST /v1/sessions", "x"), /already used for a different request/);
    // New keys are bound and replay normally.
    reopened.remember("fresh", "POST /v1/sessions", 201, { id: "f" }, "hash-f");
    assert.deepEqual(reopened.replay("fresh", "POST /v1/sessions", "hash-f"), { status: 201, body: { id: "f" } });
    assert.throws(() => reopened.replay("fresh", "POST /v1/sessions", "other"), /already used for a different request/);
  } finally {
    await reopened.close();
    await t.cleanup();
  }
});

// The replay cache is a 24 h cache, not a permanent log: a running device must forget old keys too, or it both
// grows without bound and replays a retry that is older than the promise.
test("the replay cache is pruned by age while the device runs", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    store.remember("fresh", "POST /v1/sessions", 201, { id: "f" }, "hash-f");
    assert.deepEqual(store.replay("fresh", "POST /v1/sessions", "hash-f"), { status: 201, body: { id: "f" } });

    // Past the TTL the key is forgotten, so a stale retry is a new act rather than a replay.
    store.catalog.prepare("UPDATE requests SET createdAt=? WHERE key=?").run(Date.now() - 25 * 3600_000, "fresh");
    assert.equal(store.pruneRequests(), 1);
    assert.equal(store.replay("fresh", "POST /v1/sessions", "hash-f"), undefined);

    // Inside the TTL the response survives.
    store.remember("kept", "POST /v1/sessions", 201, { id: "k" }, "hash-k");
    assert.equal(store.pruneRequests(), 0);
    assert.deepEqual(store.replay("kept", "POST /v1/sessions", "hash-k"), { status: 201, body: { id: "k" } });
  } finally {
    await store.close();
    await t.cleanup();
  }
});

// The batch launch is the operator's "one brief, N worktrees" act. It must be safe to retry as a whole: a
// session that already exists is re-admitted, never duplicated, and the batch stops at the first failure.
test("batch launch: one session per spec, and a retry after a failure converges", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "batch-box" });
  try {
    const client = new DpiClient(server.base, token);
    const spec = (name: string) => ({ name, cwd: t.work, model: faux, prompt: `Brief for ${name}` });

    const batchKey = "launch-2026-10-17-morning";
    const first = await client.createSessions([spec("one"), spec("two")], batchKey);
    assert.equal(first.failedAt, undefined);
    assert.deepEqual(first.items.map((i) => i.result?.name), ["one", "two"]);
    for (const item of first.items) {
      assert.ok(item.result?.prompt?.submissionId, "the opening brief is admitted");
      assert.equal(item.result?.seedError, undefined);
    }
    assert.equal((await client.sessions()).length, 2);

    // Replaying the whole batch: the same sessions come back, with no duplicates and no second brief.
    const replay = await client.createSessions([spec("two"), spec("one")], batchKey);
    assert.equal(replay.failedAt, undefined);
    assert.deepEqual(
      replay.items.map((i) => i.result?.id),
      [first.items[1].result?.id, first.items[0].result?.id],
      "reordered specs address their own sessions",
    );
    const sessions = await client.sessions();
    assert.equal(sessions.length, 2);
    const entries = await client.agent(first.items[0].result!.id, "main").entries({ scope: "all" });
    assert.equal(
      entries.items.filter((e) => e.kind === "pi.user").length,
      1,
      "the brief is sent once, whatever the number of retries",
    );

    // A new act of launching is new sessions; the earlier ones are untouched.
    const fresh = await client.createSessions([spec("one")], "launch-2026-10-17-evening");
    assert.notEqual(fresh.items[0].result?.id, first.items[0].result?.id);
    assert.equal((await client.sessions()).length, 3);

    // A bad cwd in the middle stops the batch: the first session is created, the third never runs.
    const mixed = await client.createSessions(
      [spec("four"), { ...spec("five"), cwd: join(t.root, "missing") }, spec("six")],
      "launch-mixed",
    );
    assert.equal(mixed.failedAt, 1);
    assert.equal(mixed.items[0].result?.name, "four");
    assert.equal(mixed.items[1].error?.code, "invalid");
    assert.equal(mixed.items[2].result, undefined, "the batch stopped at the failure");
    assert.equal((await client.sessions()).length, 4);

    // Fixing the path and retrying under the same batchKey creates only what is missing.
    const retried = await client.createSessions(
      [spec("four"), { ...spec("five"), cwd: t.work }, spec("six")],
      "launch-mixed",
    );
    assert.equal(retried.failedAt, undefined);
    assert.deepEqual(retried.items.map((i) => i.result?.name), ["four", "five", "six"]);
    assert.equal(
      retried.items[0].result?.id,
      mixed.items[0].result?.id,
      "the session the stopped batch created is re-admitted, not duplicated",
    );
    assert.equal((await client.sessions()).length, 6);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
