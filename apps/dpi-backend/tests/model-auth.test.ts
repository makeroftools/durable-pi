// The OpenBao key must reach the provider without ever being written to `process.env`. `bindApiKey` is the whole
// mechanism: it overrides the provider's ambient env resolution, and leaves the provider untouched when there is no
// key, so an operator who has not moved to OpenBao keeps the existing behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { bindApiKey } from "../src/model-auth.js";
import { Store } from "../src/store.js";

const signal = new AbortController().signal;
const ctx = (vars: Record<string, string>) => ({
  env: async (name: string) => vars[name],
  fileExists: async () => false,
});

test("bindApiKey leaves the provider untouched when no key is resolved", () => {
  const provider = openrouterProvider();
  assert.equal(bindApiKey(provider, undefined), provider);
});

test("bindApiKey resolves the OpenBao key, ignoring the environment, and does not mutate the original", async () => {
  const provider = openrouterProvider();
  const patched = bindApiKey(provider, "sk-openbao");
  assert.notEqual(patched, provider);
  const result = await patched.auth.apiKey!.resolve({
    ctx: ctx({ OPENROUTER_API_KEY: "sk-env" }),
    signal,
  });
  assert.deepEqual(result, { auth: { apiKey: "sk-openbao" }, source: "OpenBao" });

  // The original still reads the environment, so a caller can fall back to it.
  const original = await provider.auth.apiKey!.resolve({
    ctx: ctx({ OPENROUTER_API_KEY: "sk-env" }),
    signal,
  });
  assert.deepEqual(original, { auth: { apiKey: "sk-env" }, source: "OPENROUTER_API_KEY" });
});

test("a store opened with OpenBao secrets resolves the model credential without process.env", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-auth-")));
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const store = await Store.open({
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "auth-test",
    provider: "openrouter",
    secrets: { openrouterApiKey: "sk-openbao" },
  });
  try {
    assert.ok(store.deviceInfo().models.length > 0, "the curated catalog resolves without a network call");
    const provider = store.models.getProvider("openrouter")!;
    const resolved = await provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal,
    });
    assert.deepEqual(resolved, { auth: { apiKey: "sk-openbao" }, source: "OpenBao" });
    assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  } finally {
    await store.close();
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
