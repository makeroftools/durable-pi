// Persistent OpenBao lifecycle: a file-storage container the operator initializes once and unseals after restarts.
//
// This manages the vault itself — start, init, unseal, status. The policy and AppRole the backend authenticates
// with are separate (`scripts/openbao-setup.ts`). Everything here is idempotent, and the CLI gates `init` behind
// `--operator` because it generates the unseal material the operator must keep.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OpenbaoOptions {
  /** Docker container name. */
  container: string;
  /** Host directory for the generated config, the data bind and the unseal-material file. */
  home: string;
  /** The address the backend dials, e.g. `http://127.0.0.1:8200`. */
  addr: string;
  image: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (argv: string[]) => Promise<CommandResult>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultRunner: Runner = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** The server config: integrated raft storage on the mounted data directory, plain HTTP on the container network. */
export function openbaoConfig(): string {
  return `ui = false
disable_mlock = true

storage "raft" {
  path    = "/openbao/file"
  node_id = "dpi-openbao"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable     = true
}

# Both are container-internal: every command runs through \`docker exec\`.
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
`;
}

export function parseStatus(json: string): { initialized: boolean; sealed: boolean } {
  let parsed: { initialized?: unknown; sealed?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw Error("OpenBao is not answering; is the container running?");
  }
  if (typeof parsed.initialized !== "boolean" || typeof parsed.sealed !== "boolean")
    throw Error("Unexpected `bao status` output");
  return { initialized: parsed.initialized, sealed: parsed.sealed };
}

export function parseInit(json: string): { keys: string[]; threshold: number; rootToken: string } {
  const parsed = JSON.parse(json) as {
    unseal_keys_b64?: unknown;
    unseal_threshold?: unknown;
    root_token?: unknown;
  };
  const keys = Array.isArray(parsed.unseal_keys_b64)
    ? parsed.unseal_keys_b64.filter((key): key is string => typeof key === "string")
    : [];
  const threshold = typeof parsed.unseal_threshold === "number" ? parsed.unseal_threshold : 0;
  const rootToken = typeof parsed.root_token === "string" ? parsed.root_token : "";
  if (!keys.length || !threshold || !rootToken) throw Error("Unexpected `bao operator init` output");
  return { keys, threshold, rootToken };
}

export interface UnsealMaterial {
  keys: string[];
  threshold: number;
  rootToken: string;
}

export interface UnsealTarget {
  status(): Promise<{ initialized: boolean; sealed: boolean }>;
  unseal(): Promise<{ unsealed: boolean }>;
}

export interface UnsealRetryOptions {
  /** Give up after this long. The container may still be starting, so unreachable is retried, not failed. */
  timeoutMs?: number;
  intervalMs?: number;
}

export type UnsealOutcome =
  | { unsealed: true }
  | { unsealed: false; reason: "uninitialized" | "timeout"; lastError?: string };

/**
 * Unseal an initialized-but-sealed vault, retrying until the container answers. Built for boot: Docker is often
 * still starting the vault, so an unreachable status is retried. An uninitialized vault is **not** an error (there
 * is nothing to unseal yet) and is reported so a boot service exits cleanly instead of restart-looping forever.
 */
export async function unsealWithRetry(vault: UnsealTarget, opts: UnsealRetryOptions = {}): Promise<UnsealOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  for (;;) {
    try {
      const state = await vault.status();
      if (!state.initialized) return { unsealed: false, reason: "uninitialized" };
      if (!state.sealed) return { unsealed: true };
      const result = await vault.unseal();
      if (result.unsealed) return { unsealed: true };
      lastError = "still sealed after applying the keys";
    } catch (error) {
      lastError = (error as Error).message;
    }
    if (Date.now() >= deadline) return { unsealed: false, reason: "timeout", lastError };
    await sleep(intervalMs);
  }
}

export function openbao(opts: OpenbaoOptions, run: Runner = defaultRunner) {
  const configPath = join(opts.home, "openbao.hcl");
  const initPath = join(opts.home, "openbao-init.json");
  /** The raft storage directory, bind-mounted so it is owned by the operator, not by root or a Docker volume. */
  const dataDir = join(opts.home, "openbao-data");
  const docker = (...args: string[]) => run(["docker", ...args]);
  // The CLI defaults to HTTPS; the container listens on plain HTTP, so point it there explicitly. A token is only
  // needed for authenticated calls; unseal and status do not carry one.
  const apiInContainer = "http://127.0.0.1:8200";
  const vox = (token: string | undefined, args: string[]) =>
    run([
      "docker",
      "exec",
      "-e",
      `BAO_ADDR=${apiInContainer}`,
      "-e",
      `VAULT_ADDR=${apiInContainer}`,
      ...(token ? ["-e", `BAO_TOKEN=${token}`, "-e", `VAULT_TOKEN=${token}`] : []),
      opts.container,
      "bao",
      ...args,
    ]);
  const bao = (...args: string[]) => vox(undefined, args);

  async function status(): Promise<{ initialized: boolean; sealed: boolean }> {
    const result = await bao("status", "-format=json");
    if (result.code !== 0 && result.code !== 2)
      throw Error(`bao status exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    return parseStatus(result.stdout);
  }

  /** Poll until the server answers a status call, so `up` may return before the API is listening. */
  async function waitReady(timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await status();
      } catch (error) {
        if (Date.now() > end) throw error;
        await sleep(500);
      }
    }
  }

  async function readMaterial(): Promise<UnsealMaterial> {
    const parsed = JSON.parse(await readFile(initPath, "utf8")) as UnsealMaterial;
    if (!Array.isArray(parsed.keys) || typeof parsed.threshold !== "number")
      throw Error(`Malformed unseal material at ${initPath}`);
    return parsed;
  }

  async function applyKeys(keys: string[]) {
    for (const key of keys) {
      const result = await bao("operator", "unseal", key);
      if (result.code !== 0) throw Error(`bao operator unseal exited ${result.code}: ${result.stderr.trim()}`);
    }
  }

  return {
    configPath,
    dataDir,
    initPath,
    status,
    /** Create the data bind and container, or start the existing one. Idempotent. */
    async up() {
      await mkdir(opts.home, { recursive: true, mode: 0o700 });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(configPath, openbaoConfig(), { mode: 0o600 });
      const existing = await docker("container", "inspect", opts.container);
      if (existing.code === 0) {
        await docker("start", opts.container);
        return { started: "existing" as const };
      }
      const port = new URL(opts.addr).port || "8200";
      const result = await docker(
        "run",
        "-d",
        "--name",
        opts.container,
        "--restart",
        "unless-stopped",
        // Run as the operator's uid, so the bind mount is readable and writable without root.
        "--user",
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        // The image's entrypoint chowns its mount points; they already belong to the operator.
        "-e",
        "SKIP_CHOWN=1",
        "-p",
        `127.0.0.1:${port}:8200`,
        "-v",
        `${dataDir}:/openbao/file`,
        "-v",
        `${configPath}:/openbao/config/openbao.hcl:ro`,
        opts.image,
        // The entrypoint loads every file in /openbao/config, which is where openbao.hcl is mounted.
        "server",
      );
      if (result.code !== 0) throw Error(`docker run exited ${result.code}: ${result.stderr.trim()}`);
      return { started: "new" as const };
    },
    /** Initialize a fresh vault, write the unseal material 0600, and unseal it. */
    async init() {
      const current = await waitReady();
      if (current.initialized)
        throw Error(`OpenBao is already initialized; unseal it with the existing material at ${initPath}`);
      const result = await bao("operator", "init", "-format=json", "-key-shares=5", "-key-threshold=3");
      if (result.code !== 0) throw Error(`bao operator init exited ${result.code}: ${result.stderr.trim()}`);
      const material = parseInit(result.stdout);
      await writeFile(
        initPath,
        `${JSON.stringify({ keys: material.keys, threshold: material.threshold, rootToken: material.rootToken }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await applyKeys(material.keys.slice(0, material.threshold));
      // A fresh non-dev vault has no KV mount; the model credential lives under `secret/`.
      const enabled = await vox(material.rootToken, ["secrets", "enable", "-path=secret", "kv-v2"]);
      if (enabled.code !== 0 && !/already in use|already exists/i.test(enabled.stderr + enabled.stdout))
        throw Error(`could not enable the secret/ KV-v2 mount: ${enabled.stderr.trim()}`);
      return { initPath, threshold: material.threshold };
    },
    /** Unseal a sealed vault from the stored material; a no-op when it is already unsealed. */
    async unseal() {
      const current = await waitReady();
      if (!current.initialized)
        throw Error("OpenBao is not initialized; run `just openbao init --operator` first");
      if (!current.sealed) return { unsealed: true };
      const material = await readMaterial();
      await applyKeys(material.keys.slice(0, material.threshold));
      const after = await status();
      return { unsealed: !after.sealed };
    },
  };
}
