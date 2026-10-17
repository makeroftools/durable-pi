// Model credentials from OpenBao, resolved at boot and held only in memory.
//
// When DPI_SECRETS=openbao the backend authenticates to OpenBao (AppRole preferred, else a token file), reads
// the model credential from a KV-v2 path, and places it in the process environment for the provider. The value
// is never written to backend.env, never logged, and never returned to a client. If OpenBao is configured but
// cannot be reached or authorised, the caller fails closed rather than starting without a key.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SecretsSettings = {
  enabled: boolean;
  addr: string;
  /** The KV-v2 data path, e.g. `secret/data/pro/dpi/model`. */
  path: string;
  roleIdFile: string;
  secretIdFile: string;
  tokenFile: string;
  keyField: string;
  typesafeField: string;
  timeoutMs: number;
};

export const SECRETS_OFF: SecretsSettings = {
  enabled: false,
  addr: "",
  path: "",
  roleIdFile: "",
  secretIdFile: "",
  tokenFile: "",
  keyField: "",
  typesafeField: "",
  timeoutMs: 0,
};

const defaultHome = (env: NodeJS.ProcessEnv) => env.DPI_HOME ?? join(homedir(), ".dpi");

export function secretsSettings(env: NodeJS.ProcessEnv = process.env): SecretsSettings {
  const base = defaultHome(env);
  return {
    enabled: (env.DPI_SECRETS ?? "off").toLowerCase() === "openbao",
    addr: (env.DPI_OPENBAO_ADDR ?? "http://127.0.0.1:8200").replace(/\/+$/, ""),
    path: (env.DPI_OPENBAO_PATH ?? "secret/data/pro/dpi/model").replace(/^\/+/, ""),
    roleIdFile: resolve(env.DPI_OPENBAO_ROLE_ID_FILE ?? join(base, "openbao-role-id")),
    secretIdFile: resolve(env.DPI_OPENBAO_SECRET_ID_FILE ?? join(base, "openbao-secret-id")),
    tokenFile: resolve(env.DPI_OPENBAO_TOKEN_FILE ?? join(base, "openbao.token")),
    keyField: env.DPI_OPENBAO_KEY_FIELD ?? "openrouter_api_key",
    typesafeField: env.DPI_OPENBAO_TYPESAFE_FIELD ?? "typesafe_api_key",
    timeoutMs: Number(env.DPI_OPENBAO_TIMEOUT_MS ?? "10000"),
  };
}

export type ResolvedSecrets = { openrouterApiKey?: string; typesafeApiKey?: string; via: "approle" | "token" };

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** One OpenBao call. On failure the error names the path and status only — never a response body, which can carry a secret. */
async function call(
  settings: SecretsSettings,
  method: "GET" | "POST" | "PUT",
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${settings.addr}/v1/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { "x-vault-token": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  if (!response.ok) throw Error(`OpenBao ${path} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Authenticate (AppRole first, else the token file) and read the model credential. Never logs a value. */
export async function fetchOpenBaoSecrets(settings: SecretsSettings): Promise<ResolvedSecrets> {
  let token = await readIfPresent(settings.tokenFile);
  let via: "approle" | "token" = "token";
  const roleId = await readIfPresent(settings.roleIdFile);
  const secretId = await readIfPresent(settings.secretIdFile);
  if (roleId && secretId) {
    const login = await call(settings, "POST", "auth/approle/login", undefined, { role_id: roleId, secret_id: secretId });
    const auth = login.auth as { client_token?: unknown } | undefined;
    if (typeof auth?.client_token !== "string") throw Error("OpenBao AppRole login returned no client token");
    token = auth.client_token;
    via = "approle";
  }
  if (!token)
    throw Error(
      `No OpenBao credential: provide ${settings.roleIdFile} + ${settings.secretIdFile} (AppRole), or ${settings.tokenFile} (token)`,
    );
  const body = await call(settings, "GET", settings.path, token);
  const data = (body.data as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) throw Error(`OpenBao ${settings.path} returned no KV-v2 data`);
  const field = (name: string) => {
    const value = data[name];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  return { openrouterApiKey: field(settings.keyField), typesafeApiKey: field(settings.typesafeField), via };
}

/**
 * Resolve the model credentials and place them in the process environment, replacing any plaintext value.
 * Returns which fields were set — the names only, never the values.
 */
export async function applySecrets(
  settings: SecretsSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ via: "approle" | "token"; fields: string[] }> {
  const secrets = await fetchOpenBaoSecrets(settings);
  const fields: string[] = [];
  if (secrets.openrouterApiKey) {
    env.OPENROUTER_API_KEY = secrets.openrouterApiKey;
    fields.push("OPENROUTER_API_KEY");
  }
  if (secrets.typesafeApiKey) {
    env.TYPESAFE_API_KEY = secrets.typesafeApiKey;
    fields.push("TYPESAFE_API_KEY");
  }
  return { via: secrets.via, fields };
}
