import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_START_DIR, parseNetworkConfig, sameCodeDir, syncConfigToRegistry } from "../src/node/config.js";
import { NetworkRegistry } from "../src/node/registry.js";

test("dpi-network.example.yaml parses: defaults plus the local device", () => {
  const config = parseNetworkConfig(readFileSync(new URL("../../../dpi-network.example.yaml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.devices), ["local"]);
  assert.equal(config.devices.local.url, "http://127.0.0.1:4780");
  assert.deepEqual(config.devices.local.startDirs, [DEFAULT_START_DIR]);
  assert.deepEqual(config.devices.local.envKeys, ["OPENROUTER_API_KEY"]);
  for (const d of Object.values(config.devices)) {
    assert.ok(["local", "ssh", "exe-dev", "url"].includes(d.kind));
    assert.ok(d.port > 0 && d.node > 0 && d.codeDir && d.homeDir);
    if (d.kind === "exe-dev") assert.equal(d.ssh, `${d.vm}.exe.xyz`);
  }
});

test("validation rejects bad kinds, missing fields and bad ids; exe-dev derives url and ssh", () => {
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: cloud\n    url: http://x"), /kind must be one of/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    url: http://x\n    service: launchd"), /\.ssh must be/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: u@h\n    url: http://x"), /service is required/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: ssh\n    ssh: u@h\n    service: cron\n    url: http://x"), /launchd or systemd/);
  assert.throws(() => parseNetworkConfig("devices:\n  Bad_Id:\n    kind: url\n    url: http://x"), /id must match/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: url"), /url must be/);
  const c = parseNetworkConfig("defaults:\n  port: 5000\n  start_dirs: ['~/w']\ndevices:\n  vm:\n    kind: exe-dev\n    vm: my-vm-1\n  here:\n    kind: local");
  assert.equal(c.devices.vm.url, "https://my-vm-1.exe.xyz");
  assert.equal(c.devices.vm.ssh, "my-vm-1.exe.xyz");
  assert.equal(c.devices.vm.service, "systemd");
  assert.equal(c.devices.here.url, "http://127.0.0.1:5000");
  assert.deepEqual(c.devices.here.startDirs, ["~/w"]);
  assert.deepEqual(parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a.startDirs, [DEFAULT_START_DIR]);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    roots: ['~']"), /renamed to "start_dirs"/);
  // host defaults by kind; env merges defaults and device and refuses managed or duplicate keys.
  const e = parseNetworkConfig(
    "defaults:\n  env: { DPI_PROVIDER: openrouter, LOG_LEVEL: info }\ndevices:\n  a:\n    kind: local\n    env_keys: [OPENROUTER_API_KEY]\n    env: { DPI_PROVIDER: faux }\n  b:\n    kind: url\n    url: http://b\n    host: 10.0.0.5",
  );
  assert.equal(e.devices.a.host, "127.0.0.1");
  assert.equal(e.devices.b.host, "10.0.0.5");
  assert.deepEqual(e.devices.a.env, { DPI_PROVIDER: "faux", LOG_LEVEL: "info" });
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env: { DPI_PORT: 1 }"), /own setting/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [X]\n    env: { X: 1 }"), /also in env_keys/);
  // env_keys is a secret copied from .env: local only. A remote device must use its own vault instead.
  for (const remote of [
    "kind: ssh\n    ssh: u@h\n    service: systemd\n    url: http://x",
    "kind: exe-dev\n    vm: my-vm-1",
    "kind: url\n    url: http://x",
  ])
    assert.throws(() => parseNetworkConfig(`devices:\n  a:\n    ${remote}\n    env_keys: [OPENROUTER_API_KEY]`), /secrets are copied only to a local device/);
  // A defaults.env_keys must not leak to a remote device either.
  assert.throws(
    () => parseNetworkConfig("defaults:\n  env_keys: [OPENROUTER_API_KEY]\ndevices:\n  a:\n    kind: local\n  b:\n    kind: url\n    url: http://b"),
    /secrets are copied only to a local device/,
  );
  // env_keys names are validated: UPPER_SNAKE_CASE, not managed, not duplicated.
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [lower]"), /UPPER_SNAKE_CASE/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [DPI_TOKEN]"), /own setting/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [X, X]"), /duplicates/);
});

test("sync upserts config devices, keeps UI devices and prunes removed config devices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-cfg-"));
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  try {
    reg.upsert({ id: "adhoc", url: "https://a.test", source: "ui" });
    syncConfigToRegistry(parseNetworkConfig("devices:\n  one:\n    kind: url\n    url: http://one\n  two:\n    kind: url\n    url: http://two"), reg);
    assert.deepEqual(reg.list().map((d) => [d.id, d.source]).sort(), [["adhoc", "ui"], ["one", "config"], ["two", "config"]]);
    syncConfigToRegistry(parseNetworkConfig("devices:\n  one:\n    kind: url\n    url: http://one"), reg);
    assert.deepEqual(reg.list().map((d) => d.id).sort(), ["adhoc", "one"]);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a declared code_dir clears a stale report, keeps a matching one and never guesses a remote home", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-reconcile-"));
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  const info = (codeDir: string) => ({
    uid: "uid-1",
    name: "cbp",
    hostname: "denali",
    platform: "linux",
    apiVersion: 1 as const,
    durableVersion: "x",
    startedAt: 1,
    startDirs: ["/w"],
    models: [],
    defaultModel: "m",
    storage: { dataDir: "/d", catalogPath: "/c", appStatePath: "/a" },
    codeDir,
    capabilities: ["events"] as Array<"events" | "docs" | "demo" | "jobs">,
  });
  try {
    const real = parseNetworkConfig(
      "devices:\n  cbp:\n    kind: url\n    url: http://cbp:8790\n    code_dir: /real/cbp",
    );
    assert.equal(real.devices.cbp.codeDirDeclared, true);
    syncConfigToRegistry(real, reg);
    reg.recordStatus("cbp", { status: "online", info: info("/stale/cbp") });
    // The last report disagrees with the YAML: forget it so the next probe replaces it.
    syncConfigToRegistry(real, reg);
    assert.equal(reg.get("cbp")!.lastInfo, null);
    assert.equal(reg.get("cbp")!.lastStatus, "checking");
    // A matching report survives a sync.
    reg.recordStatus("cbp", { status: "online", info: info("/real/cbp") });
    syncConfigToRegistry(real, reg);
    assert.equal(reg.get("cbp")!.lastInfo!.codeDir, "/real/cbp");
    // An undeclared default is not truth; it never clears what the device reported.
    const implicit = parseNetworkConfig("devices:\n  cbp:\n    kind: url\n    url: http://cbp:8790");
    assert.equal(implicit.devices.cbp.codeDirDeclared, false);
    // An inherited defaults.code_dir is a deploy target, not truth about a local checkout.
    const inherited = parseNetworkConfig("defaults:\n  code_dir: ~/dpi\ndevices:\n  here:\n    kind: local");
    assert.equal(inherited.devices.here.codeDirDeclared, false);
    assert.equal(inherited.devices.here.codeDir, "~/dpi");
    reg.recordStatus("cbp", { status: "online", info: info("/anything") });
    syncConfigToRegistry(implicit, reg);
    assert.equal(reg.get("cbp")!.lastInfo!.codeDir, "/anything");
    // `~` is this machine's home for local/url, but a remote home is not ours to guess.
    assert.equal(sameCodeDir("~/cbp", "/home/op/cbp", "url", "/home/op"), true);
    assert.equal(sameCodeDir("~/cbp", "/home/op/cbp", "local", "/home/op"), true);
    assert.equal(sameCodeDir("~/cbp", "/home/other/cbp", "ssh", "/home/op"), true);
    assert.equal(sameCodeDir("/real/cbp/", "/real/cbp", "url"), true);
    assert.equal(sameCodeDir("/real/cbp", "/stale/cbp", "url"), false);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
