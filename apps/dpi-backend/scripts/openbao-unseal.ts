#!/usr/bin/env tsx
// Boot-time unseal for the persistent OpenBao vault. Install it as a systemd **user** service so a reboot
// (host or container) recovers the device without a human: `just openbao service install`.
//
// It is idempotent and fail-closed: an already-unsealed vault exits 0; an uninitialized vault is reported and
// exits 0 (there is nothing to unseal until `just openbao init --operator`); a vault that stays sealed past the
// timeout exits non-zero so Restart=on-failure retries. It reads the same unseal material as `just openbao unseal`.
import { homedir } from "node:os";
import { join } from "node:path";
import { openbao, unsealWithRetry } from "../src/openbao.js";

const opts = {
  container: process.env.DPI_OPENBAO_CONTAINER ?? "dpi-openbao",
  home: process.env.DPI_HOME ?? join(homedir(), ".dpi"),
  addr: process.env.DPI_OPENBAO_ADDR ?? "http://127.0.0.1:8200",
  image: process.env.DPI_OPENBAO_IMAGE ?? "openbao/openbao",
};
const timeoutMs = Number(process.env.DPI_OPENBAO_UNSEAL_TIMEOUT_MS ?? "180000");

const result = await unsealWithRetry(openbao(opts), { timeoutMs });
if (result.unsealed) {
  console.log("OpenBao is unsealed.");
} else if (result.reason === "uninitialized") {
  console.log("OpenBao is not initialized; run `just openbao init --operator`. Nothing to unseal.");
} else {
  console.error(`OpenBao did not unseal in time${result.lastError ? `: ${result.lastError}` : ""}.`);
  process.exit(1);
}
