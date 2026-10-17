// Minimal Jev client (TypeSafe System One), from harness/extensions/jev-bash/core/client.ts: one call answers a few
// bounded questions about a JSON state in a few hundred milliseconds.
import type { ModelCredentials } from "./secrets.js";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { credentials?: ModelCredentials; signal?: AbortSignal } = {},
): Promise<Record<string, JevAnswer>> {
  // OpenBao credentials win; the environment remains for operators who have not moved over.
  const typesafe = options.credentials?.typesafeApiKey ?? process.env.TYPESAFE_API_KEY;
  const openrouter = options.credentials?.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  const [endpoint, key, model] = typesafe
    ? ["https://api.typesafe.ai/v1/systemone", typesafe, "jev-latest"]
    : openrouter
      ? ["https://openrouter.ai/api/alpha/decisions", openrouter, "~typesafe/jev-latest"]
      : [];
  if (!endpoint) throw Error("Jev needs a TypeSafe or OpenRouter credential");
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    for (const [id, q] of Object.entries(questions))
      if (data.answers?.[id]?.type !== q.type) throw Error(`Jev answer missing: ${id}`);
    return data.answers!;
  }
}
