// Snapshot and restore a device's durable state.
//
// Every SQLite database is copied with `VACUUM INTO`, which reads a consistent snapshot (committed WAL included)
// without modifying the source, so a running device can be backed up. Each snapshot's SHA-256 is recorded in a
// manifest; restore checks every checksum and runs `PRAGMA integrity_check` before trusting the copy, and refuses
// a target that is not empty, so it can never overwrite live data.
//
// A backup covers `DPI_DATA_DIR` only: the catalog, the shared App State, every session database and the archive.
// Session working directories are the operator's projects and are not device state. Tokens live in `backend.env`,
// outside the data dir, and are never part of a backup.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, resolve, sep } from "node:path";

export const BACKUP_FORMAT = 1;
export const MANIFEST_NAME = "manifest.json";
/** Lock files and SQLite sidecars are derived, never stored: `VACUUM INTO` folds committed WAL into the snapshot. */
const DERIVED = /(\.lock|-wal|-shm)$/;

export interface BackupFile {
  /** Path relative to the data directory. */
  path: string;
  sha256: string;
  bytes: number;
}
export interface BackupManifest {
  format: number;
  createdAt: number;
  /** Absolute data directory the snapshot was taken from; restore refuses a different target unless relocating. */
  dataDir: string;
  files: BackupFile[];
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Relative paths of every file worth keeping under `root`, sorted; locks, sidecars and `exclude` are skipped. */
async function walk(root: string, exclude?: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (exclude && (full === exclude || full.startsWith(exclude + sep))) continue;
      if (DERIVED.test(entry.name)) continue;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  }
  await visit(root);
  return out;
}

/** A consistent snapshot of one database, committed WAL included, without touching the source. */
function snapshotSqlite(source: string, dest: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
}

/** Throw unless SQLite reports the database structurally sound. */
function assertIntegrity(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    if (value !== "ok") throw Error(`integrity_check on ${path}: ${JSON.stringify(row)}`);
  } finally {
    db.close();
  }
}

/** Write a checksummed snapshot of `dataDir` into a new, empty `destDir`. */
export async function createBackup(dataDir: string, destDir: string): Promise<BackupManifest> {
  const source = resolve(dataDir);
  const dest = resolve(destDir);
  if (!existsSync(source)) throw Error(`No device data at ${source}`);
  if (dest === source || dest.startsWith(source + sep))
    throw Error(`Backup destination must be outside the data directory: ${dest}`);
  if (existsSync(dest) && (await readdir(dest)).length)
    throw Error(`Backup destination already exists and is not empty: ${dest}`);
  await mkdir(dest, { recursive: true });
  const files: BackupFile[] = [];
  for (const rel of await walk(source, dest)) {
    const from = join(source, rel);
    const to = join(dest, rel);
    await mkdir(dirname(to), { recursive: true });
    if (rel.endsWith(".sqlite")) snapshotSqlite(from, to);
    else await copyFile(from, to);
    files.push({ path: rel, sha256: await sha256(to), bytes: (await stat(to)).size });
  }
  const manifest: BackupManifest = { format: BACKUP_FORMAT, createdAt: Date.now(), dataDir: source, files };
  await writeFile(join(dest, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read and validate a manifest without touching the data files. */
export async function readBackup(backupDir: string): Promise<BackupManifest> {
  const dir = resolve(backupDir);
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), "utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT)
    throw Error(`Unsupported backup format ${manifest.format}; this build reads ${BACKUP_FORMAT}`);
  if (typeof manifest.dataDir !== "string" || !Array.isArray(manifest.files))
    throw Error(`Malformed backup manifest in ${dir}`);
  return manifest;
}

/** Verify every file against the manifest's checksum and size. Throws on the first mismatch. */
export async function verifyBackup(backupDir: string): Promise<BackupManifest> {
  const dir = resolve(backupDir);
  const manifest = await readBackup(dir);
  for (const file of manifest.files) {
    const full = join(dir, file.path);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) throw Error(`Backup is missing ${file.path}`);
    if (info.size !== file.bytes)
      throw Error(`Backup file ${file.path} is ${info.size} bytes; the manifest says ${file.bytes}`);
    if ((await sha256(full)) !== file.sha256)
      throw Error(`Backup file ${file.path} does not match its checksum`);
  }
  return manifest;
}

/** Point a restored catalog's session paths at `dataDir`, so a restore to another location is self-consistent. */
function relocateSessions(catalogDir: string, dataDir: string): void {
  const catalog = join(catalogDir, "catalog.sqlite");
  if (!existsSync(catalog)) return;
  const db = new DatabaseSync(catalog);
  try {
    const rows = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    const update = db.prepare("UPDATE sessions SET dbPath=? WHERE id=?");
    for (const row of rows) update.run(join(dataDir, "sessions", row.id, "agent.sqlite"), row.id);
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** True when the data directory moved and session paths were rewritten. */
  relocated: boolean;
}

/**
 * Restore `backupDir` into `targetDir`. The target must be empty or absent: restore never overwrites live state.
 * Every database is integrity-checked and the copy is built beside the target, so a failure leaves the target
 * exactly as it was. When the directory moved, session paths are rewritten to the new location.
 */
export async function restoreBackup(backupDir: string, targetDir: string): Promise<RestoreResult> {
  const snapshot = resolve(backupDir);
  const target = resolve(targetDir);
  const manifest = await verifyBackup(snapshot);
  if (existsSync(target) && (await readdir(target)).length)
    throw Error(`Restore target is not empty: ${target}. Move the current data directory aside first.`);
  // Build in a sibling, then swap it in: a failure leaves the target exactly as it was.
  const staging = `${target}.restore-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const file of manifest.files) {
      const to = join(staging, file.path);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(snapshot, file.path), to);
      if (file.path.endsWith(".sqlite")) assertIntegrity(to);
    }
    const relocated = manifest.dataDir !== target;
    if (relocated) {
      relocateSessions(staging, target);
      const catalog = join(staging, "catalog.sqlite");
      if (existsSync(catalog)) assertIntegrity(catalog);
    }
    if (existsSync(target)) await rm(target, { recursive: true });
    await rename(staging, target);
    return { manifest, relocated };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
