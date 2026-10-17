// Jev resolves its credential from OpenBao's in-memory value, not `process.env`; the environment is only the
// fallback for operators who have not moved over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { askJev, type JevQuestion } from "../src/jev.js";

const questions: Record<string, JevQuestion> = {
  effect: { type: "noul", instructions: "Is it destructive?" },
};

async function withFetch(
  answer: { status: number; body?: unknown },
  run: (calls: { url: string; auth: string }[]) => Promise<void>,
) {
  const calls: { url: string; auth: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
    });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("askJev uses an injected credential over the environment", async () => {
  process.env.TYPESAFE_API_KEY = "env-typesafe";
  try {
    await withFetch({ status: 200, body: { answers: { effect: { type: "noul", noul: 1 } } } }, async (calls) => {
      await askJev({ command: "ls" }, questions, { credentials: { typesafeApiKey: "openbao-typesafe" } });
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /api\.typesafe\.ai/);
      assert.equal(calls[0]!.auth, "Bearer openbao-typesafe");
    });
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("askJev falls back to the environment when no credential is passed", async () => {
  process.env.OPENROUTER_API_KEY = "env-openrouter";
  try {
    await withFetch({ status: 200, body: { answers: { effect: { type: "noul", noul: 0 } } } }, async (calls) => {
      await askJev({ command: "ls" }, questions);
      assert.match(calls[0]!.url, /openrouter\.ai/);
      assert.equal(calls[0]!.auth, "Bearer env-openrouter");
    });
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("askJev with no credential at all is an explicit failure", async () => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => askJev({}, questions), /needs a TypeSafe or OpenRouter credential/);
});
