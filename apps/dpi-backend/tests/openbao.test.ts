// The OpenBao lifecycle must be idempotent and must never lose the unseal material that makes a restart recoverable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openbao,
  openbaoConfig,
  parseInit,
  parseStatus,
  unsealWithRetry,
  type CommandResult,
  type Runner,
  type UnsealTarget,
} from "../src/openbao.js";
import { freePort } from "./helpers.js";

const OPTIONS = {
  container: "dpi-openbao-test",
  home: "/tmp/unused",
  addr: "http://127.0.0.1:18200",
  image: "openbao/openbao",
};

/** The `bao` subcommand and its arguments inside a `docker exec -e … <container> bao …` invocation. */
const baoArgs = (argv: string[]): string[] => {
  const at = argv.indexOf("bao");
  return at < 0 ? [] : argv.slice(at + 1);
};
const ok = (): CommandResult => ({ code: 0, stdout: "", stderr: "" });

async function tempHome(prefix: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("openbaoConfig is raft storage over plain, tls-disabled HTTP with a cluster listener", () => {
  const config = openbaoConfig();
  assert.match(config, /storage "raft" \{/);
  assert.match(config, /path    = "\/openbao\/file"/);
  assert.match(config, /cluster_address = "0\.0\.0\.0:8201"/);
  assert.match(config, /tls_disable     = true/);
  assert.match(config, /api_addr     = "http:\/\/127\.0\.0\.1:8200"/);
});

test("status and init output are parsed strictly", () => {
  assert.deepEqual(parseStatus('{"initialized":true,"sealed":false}'), { initialized: true, sealed: false });
  assert.throws(() => parseStatus("not json"), /not answering/);
  assert.throws(() => parseStatus("{}"), /Unexpected/);
  assert.deepEqual(
    parseInit(JSON.stringify({ unseal_keys_b64: ["a", "b"], unseal_threshold: 2, root_token: "hvs.x" })),
    { keys: ["a", "b"], threshold: 2, rootToken: "hvs.x" },
  );
  assert.throws(() => parseInit("{}"), /Unexpected/);
});

test("up binds the data directory and creates a new container when none exists", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-up-");
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "container" && argv[2] === "inspect") return { code: 1, stdout: "", stderr: "No such container" };
    return ok();
  };
  try {
    const result = await openbao({ ...OPTIONS, home }, run).up();
    assert.equal(result.started, "new");
    const runCall = calls.find((c) => c[1] === "run");
    assert.ok(runCall, "runs a container");
    assert.ok(runCall!.includes(OPTIONS.container), "names the container");
    assert.ok(runCall!.includes(`${join(home, "openbao-data")}:/openbao/file`), "binds the data directory");
    assert.ok(runCall!.includes("127.0.0.1:18200:8200"), "publishes the configured port");
    assert.ok(runCall!.includes("--user"), "runs as the operator, not root");
  } finally {
    await cleanup();
  }
});

test("up starts an existing container instead of creating a second", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-up-");
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return ok();
  };
  try {
    const result = await openbao({ ...OPTIONS, home }, run).up();
    assert.equal(result.started, "existing");
    assert.ok(calls.some((c) => c[1] === "start" && c[2] === OPTIONS.container));
    assert.ok(!calls.some((c) => c[1] === "run"), "does not run a second container");
  } finally {
    await cleanup();
  }
});

test("init writes 0600 unseal material and unseals with the threshold", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-init-");
  const unsealed: string[] = [];
  const run: Runner = async (argv) => {
    const bao = baoArgs(argv);
    if (bao[0] === "status")
      return { code: 2, stdout: JSON.stringify({ initialized: false, sealed: true }), stderr: "" };
    if (bao[0] === "operator" && bao[1] === "init")
      return {
        code: 0,
        stdout: JSON.stringify({
          unseal_keys_b64: ["k1", "k2", "k3", "k4", "k5"],
          unseal_threshold: 3,
          root_token: "hvs.root",
        }),
        stderr: "",
      };
    if (bao[0] === "operator" && bao[1] === "unseal") {
      unsealed.push(bao[2]!);
      return ok();
    }
    return ok();
  };
  try {
    const result = await openbao({ ...OPTIONS, home }, run).init();
    assert.equal(result.threshold, 3);
    const material = JSON.parse(await readFile(result.initPath, "utf8")) as { keys: string[]; rootToken: string };
    assert.equal(material.keys.length, 5);
    assert.equal(material.rootToken, "hvs.root");
    assert.equal((await stat(result.initPath)).mode & 0o777, 0o600, "material is private");
    assert.deepEqual(unsealed, ["k1", "k2", "k3"], "applies exactly the threshold");
  } finally {
    await cleanup();
  }
});

test("init refuses an already-initialized vault rather than overwrite its material", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-init-");
  const run: Runner = async (argv) => {
    const bao = baoArgs(argv);
    if (bao[0] === "status")
      return { code: 0, stdout: JSON.stringify({ initialized: true, sealed: false }), stderr: "" };
    return ok();
  };
  try {
    await assert.rejects(() => openbao({ ...OPTIONS, home }, run).init(), /already initialized/);
  } finally {
    await cleanup();
  }
});

test("unseal is a no-op when the vault is already unsealed", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-unseal-");
  const run: Runner = async (argv) => {
    const bao = baoArgs(argv);
    if (bao[0] === "status")
      return { code: 0, stdout: JSON.stringify({ initialized: true, sealed: false }), stderr: "" };
    return ok();
  };
  try {
    assert.deepEqual(await openbao({ ...OPTIONS, home }, run).unseal(), { unsealed: true });
  } finally {
    await cleanup();
  }
});

test("unseal reads the stored keys and reports the vault unsealed", async () => {
  const { home, cleanup } = await tempHome("dpi-openbao-unseal-");
  let sealed = true;
  const applied: string[] = [];
  const run: Runner = async (argv) => {
    const bao = baoArgs(argv);
    if (bao[0] === "status")
      return { code: sealed ? 2 : 0, stdout: JSON.stringify({ initialized: true, sealed }), stderr: "" };
    if (bao[0] === "operator" && bao[1] === "unseal") {
      applied.push(bao[2]!);
      if (bao[2] === "k3") sealed = false;
      return ok();
    }
    return ok();
  };
  try {
    await writeFile(
      join(home, "openbao-init.json"),
      JSON.stringify({ keys: ["k1", "k2", "k3", "k4", "k5"], threshold: 3, rootToken: "hvs.root" }),
      { mode: 0o600 },
    );
    const result = await openbao({ ...OPTIONS, home }, run).unseal();
    assert.equal(result.unsealed, true);
    assert.deepEqual(applied, ["k1", "k2", "k3"]);
  } finally {
    await cleanup();
  }
});

test("unsealWithRetry retries an unreachable vault, then unseals it", async () => {
  let statusCalls = 0;
  let unsealCalls = 0;
  const vault: UnsealTarget = {
    async status() {
      statusCalls += 1;
      if (statusCalls < 3) throw Error("OpenBao is not answering; is the container running?");
      return { initialized: true, sealed: true };
    },
    async unseal() {
      unsealCalls += 1;
      return { unsealed: true };
    },
  };
  const result = await unsealWithRetry(vault, { timeoutMs: 1_000, intervalMs: 1 });
  assert.deepEqual(result, { unsealed: true });
  assert.equal(statusCalls, 3, "retried until the container answered");
  assert.equal(unsealCalls, 1);
});

test("unsealWithRetry reports an uninitialized vault without applying keys", async () => {
  let unsealCalls = 0;
  const vault: UnsealTarget = {
    async status() {
      return { initialized: false, sealed: true };
    },
    async unseal() {
      unsealCalls += 1;
      return { unsealed: true };
    },
  };
  assert.deepEqual(await unsealWithRetry(vault, { timeoutMs: 1_000, intervalMs: 1 }), {
    unsealed: false,
    reason: "uninitialized",
  });
  assert.equal(unsealCalls, 0, "nothing to unseal before init");
});

test("unsealWithRetry times out while the vault stays sealed", async () => {
  const vault: UnsealTarget = {
    async status() {
      return { initialized: true, sealed: true };
    },
    async unseal() {
      return { unsealed: false };
    },
  };
  const result = await unsealWithRetry(vault, { timeoutMs: 5, intervalMs: 1 });
  assert.equal(result.unsealed, false);
  if (!result.unsealed) {
    assert.equal(result.reason, "timeout");
    assert.match(result.lastError ?? "", /still sealed/);
  }
});

// Requires Docker and the openbao/openbao image. Opt in: DPI_OPENBAO_TEST=1 npm test.
test(
  "a real raft vault keeps its data and unseal material across a container restart",
  { skip: process.env.DPI_OPENBAO_TEST !== "1" },
  async () => {
    const { home, cleanup } = await tempHome("dpi-openbao-e2e-");
    const container = `dpi-openbao-test-${process.pid}`;
    const port = await freePort();
    const vault = openbao({ container, home, addr: `http://127.0.0.1:${port}`, image: "openbao/openbao" });
    const bao = (token: string, args: string[]) =>
      execFileSync(
        "docker",
        ["exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", `BAO_TOKEN=${token}`, container, "bao", ...args],
        { encoding: "utf8" },
      );
    try {
      await vault.up();
      await vault.init();
      const material = JSON.parse(await readFile(vault.initPath, "utf8")) as { rootToken: string };
      bao(material.rootToken, ["kv", "put", "secret/dpi-test", "value=persisted"]);

      // A restart seals the vault; the stored keys unseal it and the data is still there.
      execFileSync("docker", ["restart", container]);
      assert.equal((await vault.unseal()).unsealed, true);
      const read = JSON.parse(bao(material.rootToken, ["kv", "get", "-format=json", "secret/dpi-test"])) as {
        data: { data: { value: string } };
      };
      assert.equal(read.data.data.value, "persisted");
    } finally {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      await cleanup();
    }
  },
);
