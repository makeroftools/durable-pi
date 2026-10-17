// The catalog has to converge whether it is brand new, predates versioning, or was written by a newer build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CATALOG_SCHEMA_VERSION, migrateCatalog } from "../src/catalog-schema.js";

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
const versionOf = (db: DatabaseSync) =>
  (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;

test("a fresh catalog migrates to the current version and a second open is a no-op", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrateCatalog(db), CATALOG_SCHEMA_VERSION);
  assert.equal(versionOf(db), String(CATALOG_SCHEMA_VERSION));
  for (const table of ["sessions", "conversation_names", "meta", "requests", "session_spawns", "session_compaction"])
    assert.ok(tables(db).includes(table), `creates ${table}`);
  assert.ok(columns(db, "requests").includes("bodyHash"));
  assert.equal(migrateCatalog(db), CATALOG_SCHEMA_VERSION);
  assert.equal(versionOf(db), String(CATALOG_SCHEMA_VERSION));
  db.close();
});

test("a catalog from before versioning gains bodyHash and a version without losing its uid", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES('device_uid','uid-1');`);
  assert.equal(columns(db, "requests").includes("bodyHash"), false);
  assert.equal(migrateCatalog(db), CATALOG_SCHEMA_VERSION);
  assert.ok(columns(db, "requests").includes("bodyHash"));
  assert.equal(versionOf(db), String(CATALOG_SCHEMA_VERSION));
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as { value: string }).value, "uid-1");
  db.close();
});

test("migrations apply one version at a time", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  assert.equal(migrateCatalog(db, 1), 1);
  assert.equal(versionOf(db), "1");
  assert.equal(columns(db, "requests").includes("bodyHash"), false, "version 1 predates body binding");
  assert.equal(migrateCatalog(db, 2), 2);
  assert.ok(columns(db, "requests").includes("bodyHash"));
  db.close();
});

test("a catalog newer than this build is refused, not mis-read", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','999');");
  assert.throws(() => migrateCatalog(db), /newer than this build/);
  db.close();
});

test("a non-integer schema_version is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','two');");
  assert.throws(() => migrateCatalog(db), /not a non-negative integer/);
  db.close();
});
