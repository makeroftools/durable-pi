// The pure core of `just doctor`: turn a list of named checks into a fail-closed verdict, and read the model
// count from a device payload. Kept separate from the I/O so the decisions can be tested without a live device.
export interface Check {
  name: string;
  ok: boolean;
  /** A failed critical check is a hard failure; a non-critical one is only reported. */
  critical: boolean;
  detail: string;
}

export function verdict(checks: Check[]): { ok: boolean; failures: string[] } {
  const failures = checks.filter((check) => check.critical && !check.ok).map((check) => check.name);
  return { ok: failures.length === 0, failures };
}

/** The number of models in a `/v1/device` payload, or `undefined` when it has none — the proof that the provider
 * received a credential (an empty list means the backend started without one). */
export function modelCount(payload: unknown): number | undefined {
  const models = (payload as { models?: unknown } | null | undefined)?.models;
  return Array.isArray(models) ? models.length : undefined;
}
