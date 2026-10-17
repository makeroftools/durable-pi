#!/usr/bin/env tsx
// just sandbox — show and verify the per-session execution sandbox (see src/sandbox.ts).
//
//   just sandbox status     the policy in force, and how to enable or scope it
//   just sandbox check      run the real SandboxExecutionEnv and verify containment
//
// The check exercises the code the backend uses, not a copy of it: the path guard refuses an out-of-root
// secret, and a container run proves the working directory is reachable while the outside is not. Fail-closed:
// anything that cannot be verified is a failure, never a pass by default.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SANDBOX_SHELL, SandboxExecutionEnv, sandboxSettings, sandboxShellEnv, stopSandbox } from "../src/sandbox.js";

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

console.log(`sandbox: ${settings.enabled ? "on" : "off"}  (${envFile})`);
console.log(`  image   ${settings.enabled ? settings.image : "(unused)"}`);
console.log(`  network ${settings.enabled ? settings.network : "(unused)"}`);
console.log(`  limits  cpus=${settings.cpus} memory=${settings.memory} pids=${settings.pids}`);
console.log(
  `  roots   ${settings.enabled ? "session cwd (rw)" : "(unused)"}${settings.extraRoots.length ? ` + ${settings.extraRoots.join(", ")} (ro)` : ""}`,
);

if (!settings.enabled) {
  console.log(`
The sandbox is off: agent commands and file tools are not contained. Enable it in ${envFile}:

  DPI_SANDBOX=docker
  DPI_SANDBOX_IMAGE=node:24-slim                     # any image with bash; add your toolchain
  DPI_SANDBOX_NETWORK=bridge                         # needed for git/package registries; none blocks egress
  DPI_SANDBOX_ROOTS=~/github/cbp/worktrees:~/cbp-worktrees   # extra roots, read-only

Then restart the backend, and run \`just sandbox check\` to verify.`);
  process.exit(statusOnly ? 0 : 1);
}
if (statusOnly) process.exit(0);

try {
  await run("docker", ["info"]);
} catch {
  line(false, "docker is not available");
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), "dpi-sbx-check-"));
const work = join(root, "work");
await mkdir(work, { recursive: true });
const secret = join(root, "secret.txt");
await writeFile(secret, "classified", "utf8");
const container = `dpi-sbx-check-${process.pid}`;
const roots = [work, ...settings.extraRoots];
let failures = 0;
const expect = (condition: boolean, text: string) => {
  line(condition, text);
  if (!condition) failures += 1;
};

try {
  const env = new SandboxExecutionEnv({
    cwd: work,
    roots,
    shellPath: SANDBOX_SHELL,
    container,
    shellEnv: sandboxShellEnv({
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

  let out = "";
  const result = await env.exec(
    `pwd; if cat '${secret}' 2>/dev/null; then echo LEAKED; else echo CONTAINED; fi`,
    { onOutput: (text) => void (out += text) },
    ctx,
  );
  expect(result.ok, "the shell runs in the container");
  expect(out.includes(work), "the container sees the working directory");
  expect(out.includes("CONTAINED") && !out.includes("LEAKED"), "the container cannot read outside its roots");
} finally {
  await stopSandbox(container).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nsandbox check FAILED (${failures})` : "\nsandbox check passed");
process.exit(failures ? 1 : 0);
