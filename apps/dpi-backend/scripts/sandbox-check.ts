#!/usr/bin/env tsx
// just sandbox — show and verify the per-session execution sandbox (see src/sandbox.ts).
//
//   just sandbox status     the policy in force, and how to enable or scope it
//   just sandbox check      run the real SandboxExecutionEnv and verify containment
//
// The check exercises the code the backend uses, not a copy of it: the path guard refuses an out-of-root
// secret, and a namespace run proves the working directory is reachable while the outside is not. Fail-closed:
// an off/unavailable mechanism is a named refusal (rc 1), never a skip and never a zero. The negative proof
// includes the real agent credential and a sibling directory; neither content is ever printed.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SandboxExecutionEnv, sandboxSettings, sandboxShellEnv, sandboxShellPath, stopSandbox } from "../src/sandbox.js";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const statusOnly = argv.includes("--status");

// Load the device env file the backend reads, so the policy shown is the policy in force.
const envFile = flag("--env-file") ?? process.env.DPI_ENV_FILE ?? join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "backend.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const settings = sandboxSettings();
const line = (ok: boolean, text: string) => console.log(`${ok ? "  ok  " : " FAIL "} ${text}`);

console.log(`sandbox: ${settings.mechanism} (${settings.enabled ? "on" : "off"})  (${envFile})`);
console.log(`  image   ${settings.mechanism === "docker" ? settings.image : "(unused)"}`);
console.log(`  network ${settings.enabled ? settings.network : "(unused)"}`);
console.log(`  limits  cpus=${settings.cpus} memory=${settings.memory} pids=${settings.pids}`);
console.log(
  `  roots   ${settings.enabled ? "session cwd (rw)" : "(unused)"}${settings.extraRoots.length ? ` + ${settings.extraRoots.join(", ")} (ro)` : ""}`,
);

if (!settings.enabled) {
  console.log(`
REFUSED sandbox-off: agent commands and file tools are not contained (${settings.reason ?? "no mechanism"}).
Confinement is required. Set DPI_SANDBOX=docker|bwrap|landlock in ${envFile}, then restart the backend.`);
  process.exit(1);
}
if (settings.mechanism === "landlock") {
  console.log(`
REFUSED sandbox-mechanism-unavailable: landlock is not implemented in this revision.
Confinement is required: choose docker or bwrap.`);
  process.exit(1);
}
if (statusOnly) {
  console.log(`\nsandbox status: ${settings.mechanism} is the configured mechanism`);
  process.exit(0);
}

try {
  await run(settings.mechanism === "docker" ? (process.env.DPI_SANDBOX_DOCKER ?? "docker") : "bwrap",
    settings.mechanism === "docker" ? ["info"] : ["--version"]);
} catch {
  line(false, `${settings.mechanism} is not available`);
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), "dpi-sbx-check-"));
const work = join(root, "work");
await mkdir(work, { recursive: true });
const secret = join(root, "secret.txt");
await writeFile(secret, "classified", "utf8");
const sibling = join(root, "sibling");
await mkdir(sibling, { recursive: true });
const siblingSecret = join(sibling, "secret.txt");
await writeFile(siblingSecret, "sibling-classified", "utf8");
const auth = join(homedir(), ".pi/agent/auth.json");
const container = `dpi-sbx-check-${process.pid}`;
const roots = [work, ...settings.extraRoots];
let failures = 0;
const expect = (condition: boolean, text: string) => {
  line(condition, text);
  if (!condition) failures += 1;
};

let env: SandboxExecutionEnv | undefined;
try {
  env = new SandboxExecutionEnv({
    mechanism: settings.mechanism,
    cwd: work,
    roots,
    shellPath: sandboxShellPath(settings.mechanism),
    container,
    shellEnv: sandboxShellEnv({
      mechanism: settings.mechanism,
      container,
      image: settings.image,
      cwd: work,
      roots,
      network: settings.network,
      cpus: settings.cpus,
      memory: settings.memory,
      pids: settings.pids,
    }),
  });
  const ctx = BACKGROUND_CONTEXT;

  expect((await env.writeFile("inside.txt", "ok", ctx)).ok, "the file tools write inside a root");
  expect(!(await env.readTextFile(secret, ctx)).ok, "the file tools refuse a path outside every root");

  const exec = async (command: string) => {
    let out = "";
    const result = await env!.exec(command, { onOutput: (text) => void (out += text) }, ctx);
    return { ok: result.ok, out };
  };

  const canary = await exec(`pwd; if cat '${secret}' >/dev/null 2>&1; then echo LEAKED; else echo CONTAINED; fi`);
  expect(canary.ok, "the shell runs in the sandbox");
  expect(canary.out.includes(work), "the sandbox sees the working directory");
  expect(canary.out.includes("CONTAINED") && !canary.out.includes("LEAKED"), "the sandbox cannot read a sibling temp file");

  // Negative proof: the real credential and a sibling directory. stdout is /dev/null, so a broken sandbox
  // yields `rc=0` but never the file's bytes. stderr is the OS refusal, quoted as-is.
  const authProbe = await exec(`cat '${auth}' >/dev/null; echo "auth_rc=$?"`);
  const siblingProbe = await exec(`cat '${siblingSecret}' >/dev/null; echo "sibling_rc=$?"`);
  expect(authProbe.ok && !authProbe.out.includes("auth_rc=0"), `the sandbox cannot read ${auth}`);
  expect(siblingProbe.ok && !siblingProbe.out.includes("sibling_rc=0"), "the sandbox cannot read a sibling worktree");
  line(!authProbe.out.includes("auth_rc=0"), `auth refusal: ${authProbe.out.trim().split("\n").filter((l) => l.includes("cat:") || l.includes("auth_rc=")).join(" | ")}`);
  line(!siblingProbe.out.includes("sibling_rc=0"), `sibling refusal: ${siblingProbe.out.trim().split("\n").filter((l) => l.includes("cat:") || l.includes("sibling_rc=")).join(" | ")}`);
} finally {
  if (settings.mechanism === "docker") await stopSandbox(container).catch(() => {});
  await env?.cleanup(BACKGROUND_CONTEXT).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nsandbox check FAILED (${failures})` : "\nsandbox check passed");
process.exit(failures ? 1 : 0);
