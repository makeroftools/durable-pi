import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SandboxExecutionEnv, sandboxSettings, sandboxShellEnv, sandboxShellPath, stopSandbox } from "../src/sandbox.js";
import { faux, tempStore } from "./helpers.js";

const settings = sandboxSettings();

const guardEnv = (work: string) =>
  new SandboxExecutionEnv({ mechanism: "docker", cwd: work, roots: [work], shellPath: "/bin/true", container: "dpi-test-unused" });

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

test("an extra root that overlaps the working root is refused, not silently shadowed", async () => {
  const t = await tempStore();
  try {
    const base = { mechanism: "docker" as const, cwd: t.work, shellPath: "/bin/true", container: "dpi-test-unused" };
    // An ancestor of the cwd is mounted read-only after it and would shadow the write.
    assert.throws(
      () => new SandboxExecutionEnv({ ...base, roots: [t.work, t.root] }),
      /overlaps the session working directory/,
    );
    // The same root twice is equally ambiguous.
    assert.throws(() => new SandboxExecutionEnv({ ...base, roots: [t.work, t.work] }), /overlaps/);
    // Disjoint roots are accepted.
    assert.doesNotThrow(() => new SandboxExecutionEnv({ ...base, roots: [t.work, join(t.root, "other")] }));
  } finally {
    await t.cleanup();
  }
});

test("a declared scope is persisted and used as the sandbox roots", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const readDir = join(t.root, "read");
    await mkdir(readDir, { recursive: true });
    await writeFile(join(readDir, "read.txt"), "read-ok", "utf8");
    const session = await store.create({
      name: "Scope",
      cwd: t.work,
      model: faux,
      scope: { read: [readDir], write: [t.work], extra: [] },
    });
    const row = store.list().find((r) => r.id === session.id);
    assert.ok(row?.scope, "the declared scope is persisted on the session row");
    const parsed = JSON.parse(row.scope) as { read: string[]; write: string[] };
    assert.deepEqual(parsed.write, [t.work]);
    assert.deepEqual(parsed.read, [readDir]);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the configured sandbox mechanism is available", () => {
  assert.notEqual(settings.mechanism, "none", `sandbox-off: ${settings.reason ?? "no mechanism"}`);
  assert.notEqual(settings.mechanism, "landlock", "sandbox-mechanism-unavailable: landlock is not implemented");
});

// The container test runs by default: an unavailable mechanism is a failure, never a skip.
test("sandbox env runs commands in a sandbox that cannot see outside its roots", async () => {
  assert.notEqual(settings.mechanism, "none", `sandbox-off: ${settings.reason ?? "no mechanism"}`);
  assert.notEqual(settings.mechanism, "landlock", "sandbox-mechanism-unavailable: landlock is not implemented");
  const t = await tempStore();
  const container = `dpi-sbx-test-${process.pid}-${Date.now()}`;
  let env: SandboxExecutionEnv | undefined;
  try {
    const secret = join(t.root, "secret.txt");
    await writeFile(secret, "classified", "utf8");
    env = new SandboxExecutionEnv({
      mechanism: settings.mechanism,
      cwd: t.work,
      roots: [t.work],
      shellPath: sandboxShellPath(settings.mechanism),
      container,
      shellEnv: sandboxShellEnv({
        mechanism: settings.mechanism,
        container,
        image: settings.image,
        cwd: t.work,
        roots: [t.work],
        network: settings.network,
        cpus: settings.cpus,
        memory: settings.memory,
        pids: settings.pids,
      }),
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
    if (settings.mechanism === "docker") await stopSandbox(container).catch(() => {});
    await env?.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await t.cleanup();
  }
});

// R4: the real credential and a directory outside the roots, from inside the confined actor. The probe proves
// those paths are absent from the confined mount namespace; it does not prove that a mounted path was denied.
// The outside directory is a throwaway under /tmp, not a real sibling under worktrees/.
// stdout is /dev/null, so a broken sandbox yields `rc=0` but never the bytes. A missing mechanism fails; never skips.
test("the confined actor cannot see the agent credential or a directory outside its roots", async () => {
  assert.notEqual(settings.mechanism, "none", `sandbox-off: ${settings.reason ?? "no mechanism"}`);
  assert.notEqual(settings.mechanism, "landlock", "sandbox-mechanism-unavailable: landlock is not implemented");
  const auth = join(homedir(), ".pi/agent/auth.json");
  assert.ok(existsSync(auth), `sandbox-negative-proof-unsettleable: ${auth} is not present on the host`);
  const t = await tempStore();
  const outside = join(t.root, "outside");
  await mkdir(outside, { recursive: true });
  const outsideSecret = join(outside, "secret.txt");
  await writeFile(outsideSecret, "outside-classified", "utf8");
  const container = `dpi-sbx-proof-${process.pid}-${Date.now()}`;
  let env: SandboxExecutionEnv | undefined;
  try {
    env = new SandboxExecutionEnv({
      mechanism: settings.mechanism,
      cwd: t.work,
      roots: [t.work],
      shellPath: sandboxShellPath(settings.mechanism),
      container,
      shellEnv: sandboxShellEnv({
        mechanism: settings.mechanism,
        container,
        image: settings.image,
        cwd: t.work,
        roots: [t.work],
        network: settings.network,
        cpus: settings.cpus,
        memory: settings.memory,
        pids: settings.pids,
      }),
    });
    const ctx = BACKGROUND_CONTEXT;
    const probe = async (path: string) => {
      let out = "";
      const result = await env!.exec(`cat '${path}' >/dev/null; echo "rc=$?"`, {
        onOutput: (text) => void (out += text),
      }, ctx);
      return { ok: result.ok, out };
    };
    const authProbe = await probe(auth);
    const outsideProbe = await probe(outsideSecret);
    assert.ok(authProbe.ok);
    assert.ok(outsideProbe.ok);
    assert.ok(!authProbe.out.includes("rc=0"), `agent credential was visible: ${authProbe.out}`);
    assert.ok(!outsideProbe.out.includes("rc=0"), `outside-root path was visible: ${outsideProbe.out}`);
    assert.match(authProbe.out, /No such file or directory|Permission denied/);
    assert.match(outsideProbe.out, /No such file or directory|Permission denied/);
    assert.doesNotMatch(authProbe.out, /outside-classified|classified/);
    assert.doesNotMatch(outsideProbe.out, /outside-classified|classified/);
  } finally {
    if (settings.mechanism === "docker") await stopSandbox(container).catch(() => {});
    await env?.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await t.cleanup();
  }
});
