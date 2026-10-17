// Pure helpers behind the batch-launch dialog. Keeping them free of Vue (and of runtime SDK imports) lets the
// convergence-critical parts — normalising directory lines and freezing one session name per directory — be
// reasoned about and unit-tested on their own.
import type { CreateSessionBody } from "@sdk/api";

/** Normalise one directory line: trim, drop trailing slashes, but keep the root as `/`. */
export function normalizeDir(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

export interface ParsedDir {
  path: string;
  /** True when an earlier line named the same directory; duplicates are shown but never launched. */
  duplicate: boolean;
}

/** Split a textarea into its directories, in order, flagging repeated ones instead of silently deduping. */
export function parseDirs(text: string): ParsedDir[] {
  const seen = new Set<string>();
  const out: ParsedDir[] = [];
  for (const raw of text.split("\n")) {
    const path = normalizeDir(raw);
    if (!path) continue;
    const duplicate = seen.has(path);
    seen.add(path);
    out.push({ path, duplicate });
  }
  return out;
}

/** The last path segment, or the whole path when there is none (e.g. `/`). */
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Names for `dirs`, in list order, de-duplicated with ` (2)`, ` (3)`… A name already in `frozen` is reused,
 * so a retry of the remaining directories keeps byte-identical specs — and therefore identical idempotency
 * keys — even if the list was narrowed or reordered. Names are part of the key the SDK derives.
 */
export function assignNames(dirs: readonly string[], frozen: Map<string, string>): Map<string, string> {
  const used = new Set(frozen.values());
  for (const dir of dirs) {
    const known = frozen.get(dir);
    if (known !== undefined) {
      used.add(known);
      continue;
    }
    const base = basename(dir) || "session";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    frozen.set(dir, name);
    used.add(name);
  }
  return frozen;
}

/** The spec a directory launches with, given the dialog's frozen inputs. */
export function batchSpec(
  name: string,
  cwd: string,
  model: CreateSessionBody["model"],
  brief: string,
  thinking: CreateSessionBody["thinkingLevel"],
): CreateSessionBody {
  return {
    name,
    cwd,
    model,
    ...(brief ? { prompt: brief } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
}
