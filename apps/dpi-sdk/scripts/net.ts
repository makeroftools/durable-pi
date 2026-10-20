// Network ops CLI behind every `just` recipe. Reads dpi-network.yaml, dispatches to the driver
// for the device's kind. Usage: net <verb> [device] [args...]
import { DpiClient } from "../src/client.js";
import { DpiError } from "../src/errors.js";
import { loadNetworkConfig, sameCodeDir, syncConfigToRegistry, type NetDevice, type NetworkConfig } from "../src/node/config.js";
import { drivers, type DriverContext, type Verb } from "../src/node/drivers.js";
import { NetworkRegistry } from "../src/node/registry.js";

const [verb = "help", id, ...args] = process.argv.slice(2);
const log = (line: string) => console.log(line);
const fail = (message: string): never => {
  console.error(`net: ${message}`);
  process.exit(1);
};

const HELP = `net <verb> [device] [args]
  ls | status [device]       devices from dpi-network.yaml (+ dpi-tui --save), probed live
  ids                        device ids from dpi-network.yaml, one per line
  up <device>                every step the device's kind supports (idempotent)
  create | provision | deploy | env | service | expose | register <device>
  restart | down | logs <device> [lines]
  rotate <device>            new token on the device, restart, re-register
  reconcile [device]         compare declared code_dir with deviceInfo().codeDir; refresh a stale row
  destroy <device> [--yes]   exe-dev only; only VMs named in dpi-network.yaml
  probe-unauth <device>      /healthz must be 200 and /v1/device without a token 401`;

async function probe(url: string, token: string | null) {
  if (!token) return { status: "unauthorized", detail: "no token (just net register <id>)" };
  try {
    const info = await new DpiClient(url, token).device({ timeoutMs: 5000 });
    const tree = await new DpiClient(url, token).tree();
    return {
      status: "online",
      detail: `${info.name} uid ${info.uid.slice(0, 8)} api v${info.apiVersion} ${tree.sessions.length} sessions${info.codeDir ? ` codeDir ${info.codeDir}` : ""}`,
    };
  } catch (e) {
    const err = e as DpiError;
    return { status: err.code === "unauthorized" ? "unauthorized" : "offline", detail: err.message };
  }
}

/** Compare a declared `code_dir` with the device's report; refresh the row when it probed successfully. */
async function reconcile(config: NetworkConfig, registry: NetworkRegistry, only?: string) {
  const ids = only ? [only] : Object.keys(config.devices);
  const width = Math.max(8, ...ids.map((name) => name.length));
  let failed = false;
  for (const id of ids) {
    const device = config.devices[id];
    if (!device) {
      console.log(`${id.padEnd(width)}  missing from ${config.file}`);
      failed = true;
      continue;
    }
    const declared = device.codeDirDeclared ? device.codeDir : `(default ${device.codeDir})`;
    const row = registry.get(id);
    let reported = row?.lastInfo?.codeDir ?? "unknown";
    if (row?.token) {
      try {
        const info = await new DpiClient(device.url, row.token).device({ timeoutMs: 5000 });
        reported = info.codeDir ?? "unknown";
        registry.recordStatus(id, { status: "online", error: null, seenAt: Date.now(), info });
      } catch {
        reported = row?.lastInfo?.codeDir ?? "unknown";
      }
    }
    const consistent =
      !device.codeDirDeclared || (reported !== "unknown" && sameCodeDir(device.codeDir, reported, device.kind));
    const result = consistent ? "ok" : reported === "unknown" ? "unverified" : "MISMATCH";
    console.log(`${id.padEnd(width)}  declared=${declared}  reported=${reported}  ${result}`);
    if (!consistent) failed = true;
  }
  if (failed) process.exitCode = 1;
}

async function main() {
  if (verb === "help" || verb === "--help") return console.log(HELP);
  const config = loadNetworkConfig();
  if (verb === "ids") return console.log(Object.keys(config.devices).join("\n"));
  const registry = new NetworkRegistry();
  syncConfigToRegistry(config, registry);
  if (verb === "reconcile") return reconcile(config, registry, id);
  if (verb === "ls" || verb === "status") {
    const rows = registry.list().filter((d) => !id || d.id === id);
    const results = await Promise.all(rows.map((d) => probe(d.url, d.token)));
    const width = Math.max(4, ...rows.map((d) => d.id.length));
    for (const [i, d] of rows.entries()) {
      const r = results[i];
      registry.recordStatus(d.id, { status: r.status as "online", error: r.status === "online" ? null : r.detail, ...(r.status === "online" ? { seenAt: Date.now() } : {}) });
      console.log(`${d.id.padEnd(width)}  ${d.kind.padEnd(7)}  ${r.status.padEnd(12)}  ${d.url}  ${r.detail}`);
    }
    if (results.some((r) => r.status !== "online")) process.exitCode = 2;
    return;
  }
  if (!id) fail(`${verb} needs a device id. Devices: ${Object.keys(config.devices).join(", ")}`);
  const device: NetDevice = config.devices[id] ?? fail(`No device "${id}" in ${config.file}. Devices: ${Object.keys(config.devices).join(", ")}`);
  if (verb === "probe-unauth") {
    const health = await fetch(`${device.url}/healthz`).then((r) => r.status).catch(() => 0);
    const anon = await fetch(`${device.url}/v1/device`).then((r) => r.status).catch(() => 0);
    console.log(`${id}: /healthz ${health}, /v1/device without token ${anon}`);
    if (health !== 200 || anon !== 401) process.exitCode = 1;
    return;
  }
  const driver = drivers[device.kind];
  const step = driver[verb as Verb];
  if (!step) fail(`"${verb}" is not supported for kind ${device.kind}. Supported: ${Object.keys(driver).join(", ")}`);
  const ctx: DriverContext = { config, registry, args, log };
  await step!(device, ctx);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
