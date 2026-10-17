#!/usr/bin/env tsx
// Backup/restore a device's durable state. The logic is in src/backup.ts; this is the operator surface.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createBackup, readBackup, restoreBackup, verifyBackup } from "../src/backup.js";

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-")) ?? "help";
const positional = argv.filter((arg) => !arg.startsWith("-"));
const home = process.env.DPI_HOME ?? join(homedir(), ".dpi");
const dataDir = resolve(process.env.DPI_DATA_DIR ?? join(home, "backend"));

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);

function usage() {
  console.log(`Usage:
  tsx scripts/backup.ts create <dest>              snapshot ${dataDir}
  tsx scripts/backup.ts verify <backup>            check every checksum
  tsx scripts/backup.ts show <backup>              print the manifest summary
  tsx scripts/backup.ts restore <backup> <target>  restore into an empty directory

  DPI_DATA_DIR overrides the data directory (currently ${dataDir}).`);
}

function summary(manifest: { createdAt: number; dataDir: string; files: { path: string; bytes: number }[] }) {
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  console.log(`${manifest.files.length} files, ${bytes(total)}, from ${manifest.dataDir}`);
  console.log(`  taken ${new Date(manifest.createdAt).toISOString()}`);
  for (const file of manifest.files) console.log(`  ${file.path}  ${bytes(file.bytes)}`);
}

try {
  if (command === "create") {
    const dest = positional[1];
    if (!dest) throw Error("create needs a destination directory");
    const manifest = await createBackup(dataDir, dest);
    console.log(`Backed up ${manifest.files.length} files to ${resolve(dest)}`);
    summary(manifest);
  } else if (command === "verify") {
    const backup = positional[1];
    if (!backup) throw Error("verify needs a backup directory");
    const manifest = await verifyBackup(backup);
    console.log(`OK: ${manifest.files.length} files verified in ${resolve(backup)}`);
  } else if (command === "show") {
    const backup = positional[1];
    if (!backup) throw Error("show needs a backup directory");
    summary(await readBackup(backup));
  } else if (command === "restore") {
    const [backup, target] = [positional[1], positional[2]];
    if (!backup || !target) throw Error("restore needs a backup directory and an empty target directory");
    const result = await restoreBackup(backup, target);
    console.log(`Restored ${result.manifest.files.length} files to ${resolve(target)}`);
    if (result.relocated) console.log(`  session paths rewritten from ${result.manifest.dataDir}`);
  } else {
    usage();
    if (command !== "help") process.exit(1);
  }
} catch (error) {
  console.error(`backup: ${(error as Error).message}`);
  process.exit(1);
}
