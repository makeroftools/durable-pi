#!/usr/bin/env tsx
// just doctor — a fail-closed health check for this device's operator harness.
//
// Asserts the guarantees the system depends on, in order: the env file and a real token; when
// `DPI_SECRETS=openbao`, the vault is initialized + unsealed and the AppRole material is present; the backend is
// healthy; it refuses a tokenless call; and it lists models — which only happens when the provider received a
// credential. The sandbox policy and the boot unseal service are reported (warnings, not failures). Any failed
// critical check exits non-zero, so a script or a human can trust a green `just doctor`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelCount, verdict, type Check } from "../src/doctor.js";
import { openbao } from "../src/openbao.js";
import { sandboxSettings } from "../src/sandbox.js";
import { secretsSettings } from "../src/secrets.js";

const home = process.env.DPI_HOME ?? join(homedir(), ".dpi");
const envFile = process.env.DPI_ENV_FILE ?? join(home, "backend.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const checks: Check[] = [];
const add = (name: string, ok: boolean, critical: boolean, detail: string) => void checks.push({ name, ok, critical, detail });

const token = process.env.DPI_TOKEN ?? "";
const port = process.env.DPI_PORT ?? "4780";
const base = `http://127.0.0.1:${port}`;
const secrets = secretsSettings();

add("env file", existsSync(envFile), true, envFile);
add("device token", token.length >= 32, true, token ? `len ${token.length}` : "missing (needs >=32 chars)");

if (secrets.enabled) {
  const opts = {
    container: process.env.DPI_OPENBAO_CONTAINER ?? "dpi-openbao",
    home,
    addr: process.env.DPI_OPENBAO_ADDR ?? "http://127.0.0.1:8200",
    image: process.env.DPI_OPENBAO_IMAGE ?? "openbao/openbao",
  };
  try {
    const state = await openbao(opts).status();
    add(
      "openbao vault",
      state.initialized && !state.sealed,
      true,
      state.initialized ? (state.sealed ? "sealed (run `just openbao unseal`)" : "initialized, unsealed") : "uninitialized",
    );
  } catch (error) {
    add("openbao vault", false, true, (error as Error).message);
  }
  const via =
    existsSync(secrets.roleIdFile) && existsSync(secrets.secretIdFile)
      ? "approle"
      : existsSync(secrets.tokenFile)
        ? "token file"
        : "none";
  add("openbao credential", via !== "none", true, via);
} else {
  add("secrets mode", true, false, "off (ambient OPENROUTER_API_KEY from backend.env)");
}

async function status(path: string, headers: Record<string, string> = {}, timeoutMs = 5_000): Promise<number> {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return response.status;
}

try {
  const code = await status("/healthz");
  add("backend health", code === 200, true, `${base}/healthz -> ${code}`);
} catch (error) {
  add("backend health", false, true, `${base} unreachable: ${(error as Error).message}`);
}

try {
  const code = await status("/v1/device");
  add("tokenless refused", code === 401, true, `GET /v1/device without token -> ${code}`);
} catch (error) {
  add("tokenless refused", false, true, (error as Error).message);
}

try {
  const response = await fetch(`${base}/v1/device`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = response.ok ? await response.json() : undefined;
  const count = modelCount(body);
  add(
    "model credential",
    count !== undefined && count > 0,
    true,
    count !== undefined && count > 0 ? `${count} models offered` : `none (HTTP ${response.status}) — the provider has no key`,
  );
} catch (error) {
  add("model credential", false, true, (error as Error).message);
}

const sandbox = sandboxSettings();
add("sandbox", true, false, sandbox.enabled ? `on (${sandbox.image}, network ${sandbox.network})` : "off (generic option; not CBP's boundary)");

if (process.platform === "linux") {
  const result = spawnSync("systemctl", ["--user", "is-enabled", "dpi-openbao-unseal.service"], { encoding: "utf8" });
  const state = (result.stdout ?? "").trim() || (result.status === 0 ? "unknown" : "not installed");
  add("boot unseal service", state === "enabled", false, state);
}

for (const check of checks) {
  const mark = check.ok ? "  ok  " : check.critical ? " FAIL " : " warn ";
  console.log(`${mark} ${check.name.padEnd(20)} ${check.detail}`);
}
const result = verdict(checks);
console.log(result.ok ? "\ndoctor: all critical checks pass" : `\ndoctor: FAILED (${result.failures.join(", ")})`);
process.exit(result.ok ? 0 : 1);
