// Deterministic catalog migrations.
//
// Every schema change is one numbered, idempotent step. Opening a catalog runs each step above the version recorded
// in `meta`, stamping the new version in the same transaction — so a crash mid-migration re-runs cleanly, a fresh
// catalog and a pre-versioning catalog converge on the same schema, and a catalog written by a newer build is
// refused rather than silently mis-read.
import type { DatabaseSync } from "node:sqlite";

type Migration = (db: DatabaseSync) => void;

const migrations: Migration[] = [
  // 1 — the base catalog.
  (db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL,bodyHash TEXT);
      CREATE TABLE IF NOT EXISTS session_spawns(key TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compaction(sessionId TEXT PRIMARY KEY,settings TEXT NOT NULL);`),
  // 2 — bind Idempotency-Keys to the request body they were first used with. Existing rows keep a NULL hash: they
  // are never replayed (see `replay`), because an unverifiable key is not a match.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "bodyHash"))
      db.exec("ALTER TABLE requests ADD COLUMN bodyHash TEXT");
  },
  // 3 — the per-session declared scope (`claims.read`/`claims.write` plus additive roots), stored as canonical
  // JSON. Existing rows keep NULL: they fall back to the session cwd, exactly as before, and the fallback is
  // recorded in `scope.report/v1` as `cwd-default`.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "scope"))
      db.exec("ALTER TABLE sessions ADD COLUMN scope TEXT");
  },
];

/** The schema this build writes. Derived from the step list, so it cannot drift from the migrations. */
export const CATALOG_SCHEMA_VERSION = migrations.length;

/**
 * Bring `db` up to `target` (default: this build's version) and return the version it now carries. Safe to call on
 * every open: when the recorded version already matches, it does no writes.
 */
export function migrateCatalog(db: DatabaseSync, target = CATALOG_SCHEMA_VERSION): number {
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const recorded = row?.value ?? "0";
  const version = Number(recorded);
  if (!Number.isInteger(version) || version < 0)
    throw Error(`Catalog schema_version is not a non-negative integer: ${JSON.stringify(recorded)}`);
  if (version > target)
    throw Error(`Catalog schema_version ${version} is newer than this build (${target}); refusing to open it`);
  for (let next = version + 1; next <= target; next++) {
    const migrate = migrations[next - 1];
    if (!migrate) throw Error(`No catalog migration for schema version ${next}`);
    db.exec("BEGIN");
    try {
      migrate(db);
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
        String(next),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return target;
}
