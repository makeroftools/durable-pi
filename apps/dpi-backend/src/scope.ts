// scope.report/v1 — the effective confinement a process is running under.
//
// Written at process start, at every session creation, and at every sandbox refusal. One JSON object per line,
// under the device's data directory, so an outside verifier, the operator UI and an auditor can read the same
// record without trusting the actor. It carries paths and identifiers only; never a credential.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SCOPE_REPORT_SCHEMA = "scope.report/v1";

export type ScopeReport = {
  schema: typeof SCOPE_REPORT_SCHEMA;
  source: "process-start" | "session-create" | "refusal";
  mechanism: string;
  version: string;
  effective_from: string;
  read_roots: string[];
  write_roots: string[];
  refusal_count: number;
  session_id?: string;
  code?: string;
  message?: string;
  declared?: "scope" | "cwd-default";
};

export class ScopeReporter {
  private refusals = 0;
  private readonly effectiveFrom: string;
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly base: { mechanism: string; version: string; read_roots?: string[]; write_roots?: string[] },
    effectiveFrom = new Date().toISOString(),
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "scope.report.jsonl");
    this.effectiveFrom = effectiveFrom;
  }

  report(
    extra: Partial<Omit<ScopeReport, "schema" | "effective_from" | "refusal_count">> = {},
  ): ScopeReport {
    const record: ScopeReport = {
      schema: SCOPE_REPORT_SCHEMA,
      source: "process-start",
      mechanism: this.base.mechanism,
      version: this.base.version,
      effective_from: this.effectiveFrom,
      read_roots: this.base.read_roots ?? [],
      write_roots: this.base.write_roots ?? [],
      refusal_count: this.refusals,
      ...extra,
    };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.path, line, { encoding: "utf8" });
    console.log(`[scope] ${line.trim()}`);
    return record;
  }

  refuse(
    code: string,
    message: string,
    extra: Partial<Omit<ScopeReport, "schema" | "effective_from" | "refusal_count" | "source" | "code" | "message">> = {},
  ): ScopeReport {
    this.refusals += 1;
    return this.report({ ...extra, source: "refusal", code, message });
  }

  get file(): string {
    return this.path;
  }
}
