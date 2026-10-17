#!/usr/bin/env tsx
// just openbao — create the OpenBao policy and AppRole the backend reads its model credential with.
//
// Operator-gated. `plan` is read-only and prints exactly what would be created. `apply` mutates the live
// OpenBao and only runs with `--operator` and a token; it never handles the model value itself.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const env = process.env;
const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-")) ?? "plan";
const operator = argv.includes("--operator");
const addr = (env.DPI_OPENBAO_ADDR ?? "http://127.0.0.1:8200").replace(/\/+$/, "");
const token = env.CBP_OPENBAO_TOKEN ?? env.BAO_TOKEN ?? "";
const secretPath = (env.DPI_OPENBAO_PATH ?? "secret/data/pro/dpi/model").replace(/^\/+/, "");
const role = env.DPI_OPENBAO_ROLE ?? "dpi-backend";
const policyName = env.DPI_OPENBAO_POLICY ?? "dpi-backend";
const home = env.DPI_HOME ?? join(homedir(), ".dpi");
const roleIdFile = resolve(env.DPI_OPENBAO_ROLE_ID_FILE ?? join(home, "openbao-role-id"));
const secretIdFile = resolve(env.DPI_OPENBAO_SECRET_ID_FILE ?? join(home, "openbao-secret-id"));
const keyField = env.DPI_OPENBAO_KEY_FIELD ?? "openrouter_api_key";

const policy = `# ${policyName}: read exactly this device's model credential.\npath "${secretPath}" {\n  capabilities = ["read"]\n}\n`;
const roleConfig = { token_policies: [policyName], token_ttl: "1h", token_max_ttl: "4h", secret_id_ttl: "720h" };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-vault-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A non-JSON body is reported by status only.
  }
  return { status: response.status, json };
}

function plan() {
  console.log(`OpenBao ${addr}`);
  console.log(`policy ${policyName}:\n${policy.split("\n").map((line) => `  ${line}`).join("\n")}`);
  console.log(`AppRole role ${role}: ${JSON.stringify(roleConfig)}`);
  console.log(`  role-id file    ${roleIdFile}`);
  console.log(`  secret-id file  ${secretIdFile}`);
  console.log(`\nThe model value is written by the operator, never here:`);
  console.log(`  bao kv put ${secretPath.replace(/^secret\/data\//, "secret/")} ${keyField}=<value>`);
}

async function apply() {
  if (!operator) throw Error("apply is operator-gated: pass --operator (and set CBP_OPENBAO_TOKEN or BAO_TOKEN)");
  if (!token) throw Error("apply needs an OpenBao token in CBP_OPENBAO_TOKEN or BAO_TOKEN");
  const enabled = await call("POST", "sys/auth/approle", { type: "approle" });
  if (enabled.status >= 400 && !/already in use/i.test(JSON.stringify(enabled.json)))
    throw Error(`could not enable AppRole: ${enabled.status}`);
  const wrotePolicy = await call("PUT", `sys/policies/acl/${policyName}`, { policy });
  if (wrotePolicy.status >= 400) throw Error(`could not write policy ${policyName}: ${wrotePolicy.status}`);
  const wroteRole = await call("POST", `auth/approle/role/${role}`, roleConfig);
  if (wroteRole.status >= 400) throw Error(`could not write role ${role}: ${wroteRole.status}`);
  const roleId = (await call("GET", `auth/approle/role/${role}/role-id`)).json.data as { role_id?: string } | undefined;
  const secretId = (await call("POST", `auth/approle/role/${role}/secret-id`)).json.data as { secret_id?: string } | undefined;
  if (!roleId?.role_id || !secretId?.secret_id) throw Error("OpenBao returned no role-id/secret-id");
  await mkdir(dirname(roleIdFile), { recursive: true });
  await writeFile(roleIdFile, `${roleId.role_id}\n`, { mode: 0o600 });
  await writeFile(secretIdFile, `${secretId.secret_id}\n`, { mode: 0o600 });
  console.log(`applied policy ${policyName} and AppRole role ${role}.`);
  console.log(`  role-id   -> ${roleIdFile} (0600)`);
  console.log(`  secret-id -> ${secretIdFile} (0600)`);
  console.log(`\nNext: set DPI_SECRETS=openbao in ~/.dpi/backend.env and restart the backend.`);
  console.log(`Store the model value yourself: bao kv put ${secretPath.replace(/^secret\/data\//, "secret/")} ${keyField}=<value>`);
}

try {
  if (command === "apply") await apply();
  else if (command === "plan" || command === "show") plan();
  else {
    console.log("Usage: just openbao <plan|apply>   (apply is operator-gated: --operator)");
    process.exit(1);
  }
} catch (error) {
  console.error(`openbao: ${(error as Error).message}`);
  process.exit(1);
}
