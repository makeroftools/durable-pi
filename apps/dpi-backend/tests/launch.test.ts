import { test } from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore } from "./helpers.js";

// A seeded launch is the operator's "start an agent on this worktree with this brief" action. It must be
// idempotent by construction: the session is created once, and the opening brief is submitted under a
// deterministic requestId, so neither a retry nor a crash can start a second session or send the brief twice.
test("createSeeded: instructions and the opening brief land, and a replay seeds once", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.createSeeded({
      name: "Seeded",
      cwd: t.work,
      model: faux,
      instructions: "Always be brief.",
      prompt: "Hello from the brief",
    });
    assert.equal(session.seedError, undefined);
    assert.ok(session.prompt?.submissionId, "the opening brief is admitted");

    const { row, c } = await store.resolveAgent(session.id, "main");
    assert.equal((await store.agentDetail(row, c)).config.instructions, "Always be brief.");

    // Deterministic requestId: replaying the same brief returns the same submission and never a second copy.
    const replay = await store.send(c, {
      content: "Hello from the brief",
      requestId: `launch:${session.id}:prompt`,
    });
    assert.equal(replay.id, session.prompt!.submissionId);

    // A launch with no brief is a plain create: no seedError, no prompt.
    const plain = await store.createSeeded({ name: "Plain", cwd: t.work, model: faux });
    assert.equal(plain.seedError, undefined);
    assert.equal(plain.prompt, undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
