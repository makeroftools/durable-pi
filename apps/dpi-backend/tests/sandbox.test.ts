import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SANDBOX_SHELL, SandboxExecutionEnv, sandboxShellEnv, stopSandbox } from "../src/sandbox.js";
import { tempStore } from "./helpers.js";

const guardEnv = (work: string) =>
  new SandboxExecutionEnv({ cwd: work, roots: [work], shellPath: "/bin/true", container: "dpi-test-unused" });

test("sandbox env confines filesystem operations to its roots, symlinks included", async () => {
  const t = await tempStore();
  try {
    const env = guardEnv(t.work);
    const ctx = BACKGROUND_CONTEXT;

    assert.equal((await env.writeFile("inside.txt", "ok", ctx)).ok, true);
    assert.equal((await env.readTextFile("inside.txt", ctx)).ok, true);

    const outside = await env.writeFile(join(t.root, "escape.txt"), "no", ctx);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.error.code, "permission_denied");

    assert.equal((await env.readTextFile("/etc/passwd", ctx)).ok, false);

    // A symlink inside the worktree may not be used to reach outside it.
    await symlink("/etc/passwd", join(t.work, "link"), "file");
    const viaLink = await env.readTextFile("link", ctx);
    assert.equal(viaLink.ok, false);
    if (!viaLink.ok) assert.equal(viaLink.error.code, "permission_denied");

    // A temp dir is created inside the roots, never in the host temp dir.
    const temp = await env.createTempDir("probe-", ctx);
    assert.ok(temp.ok && temp.value.startsWith(t.work));
  } finally {
    await t.cleanup();
  }
});

// Requires Docker and an image with bash (default node:24-slim). Opt in: DPI_SANDBOX_TEST=1 npm test.
test("sandbox env runs commands in a container that cannot see outside its roots", { skip: process.env.DPI_SANDBOX_TEST !== "1" }, async () => {
  const t = await tempStore();
  const container = `dpi-sbx-test-${process.pid}-${Date.now()}`;
  try {
    const secret = join(t.root, "secret.txt");
    await writeFile(secret, "classified", "utf8");
    const image = process.env.DPI_SANDBOX_IMAGE ?? "node:24-slim";
    const env = new SandboxExecutionEnv({
      cwd: t.work,
      roots: [t.work],
      shellPath: SANDBOX_SHELL,
      container,
      shellEnv: sandboxShellEnv({ container, image, cwd: t.work, roots: [t.work], network: "none", cpus: "2", memory: "2g", pids: 512 }),
    });
    let out = "";
    const ctx = BACKGROUND_CONTEXT;
    const result = await env.exec(
      `pwd; if cat '${secret}' 2>/dev/null; then echo LEAKED; else echo MISSING; fi`,
      { onOutput: (text) => void (out += text) },
      ctx,
    );
    assert.ok(result.ok);
    assert.match(out, new RegExp(t.work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(out, /MISSING/);
    assert.doesNotMatch(out, /LEAKED|classified/);
  } finally {
    await stopSandbox(container).catch(() => {});
    await t.cleanup();
  }
});
