// Topology lifecycle behind `just net services`: the local dpi-backend, the web hub and the
// registered CBP device. `status` is read-only; `up`/`down`/`restart` drive the systemd user units.
// Tokens are read from CBP_DEVICE_TOKEN and inherited by `just net up`; this script never prints one.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadNetworkConfig, type NetworkConfig } from "../src/node/config.js";
import { validateToken } from "../src/node/registry.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const CBP_ID = "cbp-agent";
const DEFAULT_BACKEND_PORT = "4780";
const DEFAULT_HUB_PORT = "4781";
const HELP = `services <status|up|down|restart> [--dry-run]
  status    probe :4780/healthz, :4781/api/network and :8790/healthz + tokenless :8790/v1/device
  up        backend service install/start, hub service install/start, then just net up cbp-agent
  down      stop the hub and backend user services (the CBP device is external; left running)
  restart   restart the backend and hub user services, then status
  --dry-run print the commands without running them (up still refuses a missing CBP_DEVICE_TOKEN)`;

const fail = (message: string): never => {
  console.error(`services: ${message}`);
  process.exit(1);
};

function port(value: string | undefined, fallback: string, name: string): string {
  const candidate = value ?? fallback;
  if (!/^\d+$/.test(candidate) || Number(candidate) < 1 || Number(candidate) > 65535)
    throw Error(`${name} must be a TCP port (got ${JSON.stringify(candidate)})`);
  return candidate;
}

function runJust(args: string[], dryRun: boolean, allowFail = false): void {
  console.log(`→ just ${args.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync("just", args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  if (code !== 0 && !allowFail) throw Error(`just ${args.join(" ")} exited ${code}`);
  if (code !== 0) console.log(`  (exit ${code}; continuing)`);
}

/** The hub needs the built web client; build it once when `just check`/`just hub build` has not run yet. */
function ensureHubBuild(dryRun: boolean): void {
  const built = join(repoRoot, "apps/dpi-playground/apps/dpi-playground-fe/dist/index.html");
  if (existsSync(built)) return;
  console.log("hub UI is not built; building it first");
  runJust(["hub", "build"], dryRun);
}

interface ProbeTarget {
  service: string;
  endpoint: string;
  expected: number;
  note?: string;
}

async function status(config: NetworkConfig): Promise<boolean> {
  const backendPort = port(
    config.devices.local ? String(config.devices.local.port) : undefined,
    DEFAULT_BACKEND_PORT,
    "the local backend port",
  );
  const hubPort = port(process.env.DPI_HUB_PORT, DEFAULT_HUB_PORT, "DPI_HUB_PORT");
  const cbp = config.devices[CBP_ID];
  if (!cbp) throw Error(`${config.file} has no ${CBP_ID} device`);
  const targets: ProbeTarget[] = [
    { service: "backend", endpoint: `http://127.0.0.1:${backendPort}/healthz`, expected: 200 },
    { service: "hub", endpoint: `http://127.0.0.1:${hubPort}/api/network`, expected: 200 },
    { service: CBP_ID, endpoint: `${cbp.url}/healthz`, expected: 200 },
    { service: CBP_ID, endpoint: `${cbp.url}/v1/device`, expected: 401, note: "tokenless" },
  ];
  const rows = await Promise.all(
    targets.map(async (target) => {
      let actual = 0;
      try {
        actual = (await fetch(target.endpoint, { signal: AbortSignal.timeout(3000) })).status;
      } catch {
        actual = 0;
      }
      return { ...target, actual, ok: actual === target.expected };
    }),
  );
  const serviceWidth = Math.max(4, ...rows.map((row) => row.service.length));
  const endpointWidth = Math.max(8, ...rows.map((row) => row.endpoint.length));
  console.log(`${"service".padEnd(serviceWidth)}  ${"endpoint".padEnd(endpointWidth)}  expected  actual  result`);
  for (const row of rows) {
    const note = row.note ? ` (${row.note})` : "";
    console.log(
      `${row.service.padEnd(serviceWidth)}  ${row.endpoint.padEnd(endpointWidth)}  ${String(row.expected).padEnd(8)}  ${String(row.actual).padEnd(6)}  ${row.ok ? "ok" : "FAIL"}${note}`,
    );
  }
  return rows.every((row) => row.ok);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verb = argv.find((arg) => !arg.startsWith("-")) ?? "status";
  const dryRun = argv.includes("--dry-run");
  if (verb === "help" || verb === "--help") return console.log(HELP);
  if (!["status", "up", "down", "restart"].includes(verb))
    fail(`unknown verb "${verb}". Use: status, up, down, restart`);

  const config = loadNetworkConfig();
  if (!config.devices[CBP_ID]) fail(`${config.file} has no ${CBP_ID} device`);

  if (verb === "status") {
    const ok = await status(config);
    if (!ok) process.exitCode = 2;
    return;
  }

  if (verb === "up") {
    const token = process.env.CBP_DEVICE_TOKEN;
    if (!token) return fail(`CBP_DEVICE_TOKEN is not set; export the ${CBP_ID} token before: just net services up`);
    try {
      validateToken(token);
    } catch (error) {
      fail(`CBP_DEVICE_TOKEN is not usable: ${(error as Error).message}`);
    }
    // Validate the hub port before starting anything, so a typo cannot half-install the topology.
    port(process.env.DPI_HUB_PORT, DEFAULT_HUB_PORT, "DPI_HUB_PORT");
    ensureHubBuild(dryRun);
    runJust(["backend", "service", "install"], dryRun);
    runJust(["backend", "service", "start"], dryRun);
    runJust(["hub", "service", "install"], dryRun);
    runJust(["hub", "service", "start"], dryRun);
    runJust(["net", "up", CBP_ID], dryRun);
    if (!dryRun && !(await status(config))) process.exitCode = 2;
    return;
  }

  if (verb === "down") {
    runJust(["hub", "service", "stop"], dryRun, true);
    runJust(["backend", "service", "stop"], dryRun, true);
    if (!dryRun) console.log(`${CBP_ID}: external device, left running (stop it from the CBP worktree)`);
    return;
  }

  runJust(["backend", "service", "restart"], dryRun);
  runJust(["hub", "service", "restart"], dryRun);
  if (!dryRun && !(await status(config))) process.exitCode = 2;
}

main().catch((error) => fail((error as Error).message));
