// A backup must be a faithful, verifiable snapshot, and a restore must never overwrite live data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup.js";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

/** Flip one byte in place, so the size still matches and only the checksum can catch it. */
async function tamper(path: string) {
  const bytes = await readFile(path);
  bytes[0] ^= 0xff;
  await writeFile(path, bytes);
}

test("backup captures the catalog, App State and sessions, and verifies checksums", async () => {
  const t = await tempStore();
  const store = await t.open();
  const session = await store.createSeeded({ name: "Alpha", cwd: t.work, model: faux });
  await store.close();
  const dest = join(t.root, "snapshot");
  try {
    const manifest = await createBackup(join(t.root, "data"), dest);
    const paths = manifest.files.map((file) => file.path);
    assert.ok(paths.includes("catalog.sqlite"), "catalog is captured");
    assert.ok(paths.includes("app-state.sqlite"), "App State is captured");
    assert.ok(paths.includes(join("sessions", session.id, "agent.sqlite")), "session database is captured");
    assert.ok(
      !paths.some((p) => p.endsWith(".lock") || p.endsWith("-wal") || p.endsWith("-shm")),
      "locks and sidecars are not stored",
    );
    await verifyBackup(dest);
    // A single flipped byte is caught before anything is trusted.
    await tamper(join(dest, "catalog.sqlite"));
    await assert.rejects(() => verifyBackup(dest), /checksum/);
  } finally {
    await t.cleanup();
  }
});

test("restore round-trips the device and rewrites session paths when the directory moves", async () => {
  const t = await tempStore();
  const store = await t.open();
  const session = await store.createSeeded({ name: "Round trip", cwd: t.work, model: faux });
  await store.close();
  const dest = join(t.root, "snapshot");
  const restored = join(t.root, "restored");
  try {
    await createBackup(join(t.root, "data"), dest);
    const result = await restoreBackup(dest, restored);
    assert.equal(result.relocated, true);
    const reopened = await Store.open({ dataDir: restored, startDirs: [t.work], name: "test", provider: "faux" });
    try {
      assert.deepEqual(
        reopened.list().map((row) => row.id),
        [session.id],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await t.cleanup();
  }
});

test("restore refuses a target that is not empty and never overwrites live data", async () => {
  const t = await tempStore();
  const store = await t.open();
  await store.createSeeded({ name: "Live", cwd: t.work, model: faux });
  await store.close();
  const dest = join(t.root, "snapshot");
  try {
    await createBackup(join(t.root, "data"), dest);
    await assert.rejects(() => restoreBackup(dest, join(t.root, "data")), /not empty/);
  } finally {
    await t.cleanup();
  }
});

test("restore verifies the snapshot before it writes anything", async () => {
  const t = await tempStore();
  const store = await t.open();
  await store.createSeeded({ name: "Tamper", cwd: t.work, model: faux });
  await store.close();
  const dest = join(t.root, "snapshot");
  const restored = join(t.root, "restored");
  try {
    await createBackup(join(t.root, "data"), dest);
    await tamper(join(dest, "catalog.sqlite"));
    await assert.rejects(() => restoreBackup(dest, restored), /checksum/);
    assert.equal(existsSync(restored), false, "nothing is written when the snapshot fails verification");
  } finally {
    await t.cleanup();
  }
});

test("backup refuses a destination inside the data directory", async () => {
  const t = await tempStore();
  const store = await t.open();
  await store.close();
  try {
    await assert.rejects(
      () => createBackup(join(t.root, "data"), join(t.root, "data", "snapshot")),
      /outside the data directory/,
    );
  } finally {
    await t.cleanup();
  }
});

test("a restore that cannot complete leaves the target absent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-backup-atomic-")));
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(data, "catalog.sqlite"));
  db.exec("CREATE TABLE not_sessions(a)");
  db.close();
  const snapshot = join(root, "snapshot");
  const target = join(root, "target");
  try {
    await createBackup(data, snapshot);
    // A catalog with no sessions table fails relocation; the staging copy is discarded and the target untouched.
    await assert.rejects(() => restoreBackup(snapshot, target), /no such table: sessions/);
    assert.equal(existsSync(target), false, "no target is left behind");
    assert.equal(existsSync(`${target}.restore-${process.pid}`), false, "no staging directory is left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
