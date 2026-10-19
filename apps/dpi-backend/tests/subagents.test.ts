import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient, type AgentHandle } from "../../dpi-sdk/src/client.js";
import {
  activeCount,
  addMessage,
  addSpawn,
  clampConcurrency,
  DEFAULT_SUBAGENTS_IN_FLIGHT,
  emptySubagents,
  failMessage,
  finishMessage,
  MAX_SUBAGENTS_IN_FLIGHT,
  queuedNames,
  stopAgent,
  takeStartable,
  type SubagentsDoc,
} from "../src/subagents.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "./helpers.js";

const subagentsDoc = async (main: AgentHandle) => (await main.doc<SubagentsDoc>("dpi.subagents")).value;

const toolText = async (main: AgentHandle, tool: string) => {
  const entry = (await main.entries({ scope: "all" })).items.find(
    (e) => e.kind === "pi.tool-result" && (e.model?.[0] as { toolName?: string } | undefined)?.toolName === tool,
  );
  return ((entry?.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
};

const countReports = async (main: AgentHandle, name: string) =>
  (await main.entries({ scope: "all" })).items.filter(
    (entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes(`[subagent ${name} finished]`),
  ).length;

test("subagents registry: bounded queue, spawn order, request dedupe and exactly-once answers", () => {
  assert.equal(clampConcurrency(undefined), DEFAULT_SUBAGENTS_IN_FLIGHT);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(99), MAX_SUBAGENTS_IN_FLIGHT);

  const state = emptySubagents();
  state.limit = 3;
  for (let i = 0; i < 7; i++) {
    assert.equal(
      addSpawn(state, {
        name: `child-${i}`,
        conversationId: 100 + i,
        anchorTaskId: 200 + i,
        task: `task ${i}`,
        messageId: `spawn:${i}`,
        now: i,
      }),
      true,
    );
  }
  assert.equal(addSpawn(state, {
    name: "child-0",
    conversationId: 999,
    anchorTaskId: 999,
    task: "duplicate",
    messageId: "spawn:again",
    now: 99,
  }), false);
  assert.equal(addSpawn(state, {
    name: "child-7",
    conversationId: 107,
    anchorTaskId: 207,
    task: "duplicate request",
    messageId: "spawn:0",
    now: 99,
  }), false);

  assert.deepEqual(queuedNames(state), state.order);
  assert.deepEqual(takeStartable(state).map((s) => s.name), ["child-0", "child-1", "child-2"]);
  // The session starts the first three reporters.
  for (const { name, messageId } of takeStartable(state)) {
    const agent = state.agents[name]!;
    const message = agent.messages.find((m) => m.id === messageId)!;
    message.state = "running";
    agent.status = "running";
  }
  assert.equal(activeCount(state), 3);
  assert.deepEqual(takeStartable(state), [], "no fourth child starts over the cap");
  assert.deepEqual(queuedNames(state).sort(), ["child-3", "child-4", "child-5", "child-6"]);

  // Finishing one child frees exactly one slot, and the next spawn in order takes it.
  const finished = finishMessage(state, "child-0", "spawn:0", { text: "first answer", entryId: 501 }, 10);
  assert.deepEqual(finished, { report: true, duplicate: false });
  assert.equal(activeCount(state), 2);
  assert.deepEqual(takeStartable(state).map((s) => s.name), ["child-3"]);

  // A replay of the same answer reports nothing and keeps one entry id.
  const replay = finishMessage(state, "child-0", "spawn:0", { text: "first answer", entryId: 501 }, 11);
  assert.deepEqual(replay, { report: false, duplicate: true });
  assert.deepEqual(state.agents["child-0"]!.reported, [501]);
  assert.equal(state.agents["child-0"]!.status, "done");

  // A new message to a finished child is queued without consuming another child slot.
  assert.equal(addMessage(state, "child-0", { messageId: "send:0", text: "more", followUp: false, now: 12 }), true);
  assert.equal(addMessage(state, "child-0", { messageId: "send:0", text: "more", followUp: false, now: 13 }), false);
  assert.equal(state.agents["child-0"]!.status, "queued");
  assert.deepEqual(takeStartable(state).filter((s) => s.name === "child-0").map((s) => s.messageId), ["send:0"]);

  // A failure is terminal for that message, not for the child.
  assert.equal(failMessage(state, "child-1", "spawn:1", "boom", 14), true);
  assert.equal(state.agents["child-1"]!.status, "failed");
  assert.equal(state.agents["child-1"]!.lastError, "boom");

  // Stop marks live work stopped and leaves the child reusable (idle, not terminal).
  assert.equal(stopAgent(state, "child-2", 15), true);
  assert.equal(state.agents["child-2"]!.status, "idle");
  assert.equal(state.agents["child-2"]!.messages[0]!.state, "stopped");
  assert.equal(addMessage(state, "child-2", { messageId: "send:2", text: "again", followUp: false, now: 16 }), true);
  assert.equal(state.agents["child-2"]!.status, "queued");
});

test("faux e2e: three subagents survive SIGKILL and each answer is reported exactly once", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Parallel restart", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");
    const filler = (name: string) => `${name}-` + "x".repeat(3000);
    const tasks = ["alpha", "bravo", "charlie"].map((name) => ({ name, task: `slow: ${filler(name)}` }));
    const spawned = await main.send(`subagents: ${JSON.stringify({ action: "fanout", tasks })}`, "followUp", "parallel-spawn", 15000);
    assert.equal(spawned.status, "done");

    await until(async () => {
      const doc = await subagentsDoc(main);
      return (
        doc.order.length === 3 &&
        tasks.every(({ name }) => doc.agents[name]?.status === "running" || doc.agents[name]?.messages[0]?.state === "done")
      );
    }, 15000, "three children to start");
    const before = await subagentsDoc(main);
    assert.equal(before.order.length, 3);
    assert.equal(before.limit, 4);
    assert.ok(
      tasks.some(({ name }) => before.agents[name]!.status === "running"),
      "at least one child is still working when the process dies",
    );
    // Children inherit the playground extension but not either subagent tool, so they cannot recurse.
    const child = await client.agent(session.id, String(before.agents.alpha!.conversationId)).get();
    assert.equal(child.tools.find((tool) => tool.name === "subagents")?.offered, false);
    assert.equal(child.tools.find((tool) => tool.name === "subagent")?.offered, false);

    // Kill the backend while the children run. The reporter and anchor tasks, not the parent turn, own this work.
    await server.stop("SIGKILL");
    await server.start();

    await until(async () => {
      const doc = await subagentsDoc(main);
      return tasks.every(({ name }) => doc.agents[name]?.status === "done" && doc.agents[name]?.reported.length === 1);
    }, 60000, "all three answers after restart");

    const after = await subagentsDoc(main);
    for (const { name } of tasks) {
      assert.equal(after.agents[name]!.status, "done");
      assert.equal(after.agents[name]!.messages.filter((m) => m.state === "done").length, 1);
      assert.deepEqual(after.agents[name]!.reported, after.agents[name]!.messages.map((m) => m.answerEntryId));
      assert.match(after.agents[name]!.latestAnswer ?? "", new RegExp(name));
    }

    // The parent receives one report per child, even though the answer was decided before and after the restart.
    await until(async () => (await Promise.all(tasks.map(({ name }) => countReports(main, name)))).every((n) => n === 1), 20000, "reports");
    await delay(300);
    for (const { name } of tasks) assert.equal(await countReports(main, name), 1, `${name} reported exactly once`);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("faux e2e: fanout is capped, wait drains the queue, stop keeps a child usable, failure surfaces", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Parallel limits", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");
    const names = ["n1", "n2", "n3", "n4", "n5", "n6"];
    const tasks = names.map((name) => ({ name, task: `slow: ${name}-` + "y".repeat(3000) }));
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "fanout", tasks, concurrency: 4 })}`, "followUp", "cap-spawn", 15000)).status,
      "done",
    );

    const initial = await subagentsDoc(main);
    assert.equal(initial.limit, 4);
    assert.equal(initial.order.length, 6);
    assert.equal(activeCount(initial), 4);
    assert.deepEqual(queuedNames(initial), ["n5", "n6"]);

    let maxActive = 0;
    for (let i = 0; i < 80; i++) {
      const doc = await subagentsDoc(main);
      maxActive = Math.max(maxActive, activeCount(doc));
      assert.ok(activeCount(doc) <= 4, `concurrency ${activeCount(doc)} never exceeds the cap`);
      if (queuedNames(doc).length === 0) break;
      await delay(50);
    }
    assert.equal(maxActive, 4, "the cap is actually used");

    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "wait", names })}`, "followUp", "cap-wait", 60000)).status,
      "done",
    );
    const waited = JSON.parse(await toolText(main, "subagents")) as {
      status: string;
      results: { name: string; status: string; answer?: string }[];
    };
    assert.equal(waited.status, "done");
    assert.deepEqual(waited.results.map((r) => r.name), names, "wait returns spawn order");
    assert.ok(waited.results.every((r) => r.status === "done" && r.answer?.includes(r.name)));

    // Stop one child mid-answer; it becomes idle and can still take a new message.
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "spawn", name: "stopper", task: `slow: ${"z".repeat(3000)}` })}`, "followUp", "stop-spawn", 15000)).status,
      "done",
    );
    await until(async () => (await subagentsDoc(main)).agents.stopper?.status === "running", 15000, "stopper running");
    // The parent turn ending and an abort stop at the background anchor; the child keeps working.
    assert.deepEqual(await main.abort(), { ok: true });
    await delay(300);
    assert.equal((await subagentsDoc(main)).agents.stopper!.status, "running", "parent abort does not stop the child");
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "stop", name: "stopper" })}`, "followUp", "stop-now", 15000)).status,
      "done",
    );
    const stopped = (await subagentsDoc(main)).agents.stopper!;
    assert.equal(stopped.status, "idle");
    assert.equal(stopped.messages.at(-1)!.state, "stopped");

    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "send", name: "stopper", message: "slow: recovered" })}`, "followUp", "stop-send", 15000)).status,
      "done",
    );
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "wait", names: ["stopper"] })}`, "followUp", "stop-wait", 30000)).status,
      "done",
    );
    const recovered = JSON.parse(await toolText(main, "subagents")) as { results: { status: string; answer?: string }[] };
    assert.equal(recovered.results[0]!.status, "done");
    assert.match(recovered.results[0]!.answer ?? "", /recovered/);

    // A failed child settles as failed; wait returns instead of hanging.
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "spawn", name: "broken", task: "fail: deliberate failure" })}`, "followUp", "fail-spawn", 15000)).status,
      "done",
    );
    assert.equal(
      (await main.send(`subagents: ${JSON.stringify({ action: "wait", names: ["broken"] })}`, "followUp", "fail-wait", 30000)).status,
      "done",
    );
    const failed = JSON.parse(await toolText(main, "subagents")) as {
      status: string;
      results: { name: string; status: string; error?: string }[];
    };
    assert.equal(failed.status, "settled");
    assert.equal(failed.results[0]!.name, "broken");
    assert.equal(failed.results[0]!.status, "failed");
    assert.match(failed.results[0]!.error ?? "", /failed/i);
    assert.equal((await subagentsDoc(main)).agents.broken!.status, "failed");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
