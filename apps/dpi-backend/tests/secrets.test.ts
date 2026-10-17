import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fetchOpenBaoSecrets, secretFields, type SecretsSettings } from "../src/secrets.js";

async function stub(handler: (path: string, token: string | undefined, body: string) => { status: number; body?: unknown }): Promise<{ addr: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const token = req.headers["x-vault-token"] as string | undefined;
    seen.push(`${req.method} ${req.url} token=${token ?? "-"} ${body}`);
    const answer = handler(req.url ?? "", token, body);
    res.statusCode = answer.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { addr: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), seen };
}

const settingsFor = (root: string, addr: string): SecretsSettings => ({
  enabled: true,
  addr,
  path: "secret/data/pro/dpi/model",
  roleIdFile: join(root, "role-id"),
  secretIdFile: join(root, "secret-id"),
  tokenFile: join(root, "token"),
  keyField: "openrouter_api_key",
  typesafeField: "typesafe_api_key",
  timeoutMs: 5000,
});

test("OpenBao: AppRole login, KV-v2 read, and the value never touches disk or the log", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-secrets-"));
  const box = await stub((path) =>
    path.startsWith("/v1/auth/approle/login")
      ? { status: 200, body: { auth: { client_token: "tok-approle" } } }
      : { status: 200, body: { data: { data: { openrouter_api_key: "sk-model", typesafe_api_key: "ts-key" } } } },
  );
  try {
    await writeFile(join(root, "role-id"), "role-123\n", "utf8");
    await writeFile(join(root, "secret-id"), "secret-456\n", "utf8");
    const settings = settingsFor(root, box.addr);
    const secrets = await fetchOpenBaoSecrets(settings);
    assert.deepEqual(secrets, { openrouterApiKey: "sk-model", typesafeApiKey: "ts-key", via: "approle" });
    assert.match(box.seen[0]!, /role_id.*role-123/);
    assert.match(box.seen[1]!, /token=tok-approle/);

    // The resolved value stays in memory; the boot log names fields, never values.
    const resolved = await fetchOpenBaoSecrets(settings);
    assert.deepEqual(secretFields(resolved), ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]);
  } finally {
    await box.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenBao: a token file is used when no AppRole files exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-secrets-"));
  const box = await stub(() => ({ status: 200, body: { data: { data: { openrouter_api_key: "sk-token" } } } }));
  try {
    await writeFile(join(root, "token"), "tok-file\n", "utf8");
    const secrets = await fetchOpenBaoSecrets(settingsFor(root, box.addr));
    assert.equal(secrets.via, "token");
    assert.equal(secrets.openrouterApiKey, "sk-token");
  } finally {
    await box.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenBao: a refusal fails closed and never reports a success", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-secrets-"));
  const box = await stub(() => ({ status: 403, body: { errors: ["permission denied"] } }));
  try {
    await writeFile(join(root, "token"), "tok-file\n", "utf8");
    const settings = settingsFor(root, box.addr);
    await assert.rejects(() => fetchOpenBaoSecrets(settings), /answered 403/);
  } finally {
    await box.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenBao: no credential at all is an explicit failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-secrets-"));
  try {
    await assert.rejects(() => fetchOpenBaoSecrets(settingsFor(root, "http://127.0.0.1:1")), /No OpenBao credential/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
