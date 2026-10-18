#!/usr/bin/env tsx
// Persistent OpenBao lifecycle: a file-storage container the operator initializes once and unseals after restarts.
// The policy and AppRole are `scripts/openbao-setup.ts`. See src/openbao.ts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openbao, openbaoConfig } from "../src/openbao.js";
import { openbaoUnsealUnitPlan } from "../src/service.js";

const argv = process.argv.slice(2);
const action = argv.find((arg) => !arg.startsWith("-")) ?? "status";
const operator = argv.includes("--operator");

const opts = {
  container: process.env.DPI_OPENBAO_CONTAINER ?? "dpi-openbao",
  home: process.env.DPI_HOME ?? join(homedir(), ".dpi"),
  addr: process.env.DPI_OPENBAO_ADDR ?? "http://127.0.0.1:8200",
  image: process.env.DPI_OPENBAO_IMAGE ?? "openbao/openbao",
};
const vault = openbao(opts);

try {
  if (action === "up") {
    const { started } = await vault.up();
    console.log(`OpenBao ${opts.container} ${started === "new" ? "created" : "started"} (${opts.addr}).`);
    console.log(`  config ${vault.configPath}`);
    console.log("Next: just openbao init --operator (a fresh vault), or just openbao unseal");
  } else if (action === "init") {
    if (!operator) throw Error("init is operator-gated: pass --operator");
    const result = await vault.init();
    console.log(`Initialized. Unseal material written to ${result.initPath} (0600, ${result.threshold} of 5 keys).`);
    console.log("Keep it: without those keys a restarted vault cannot be unsealed.");
  } else if (action === "unseal") {
    const result = await vault.unseal();
    console.log(result.unsealed ? "OpenBao is unsealed." : "OpenBao is still sealed.");
  } else if (action === "status") {
    const state = await vault.status();
    console.log(
      `${opts.container}: ${state.initialized ? "initialized" : "uninitialized"}, ${state.sealed ? "sealed" : "unsealed"}`,
    );
  } else if (action === "config") {
    process.stdout.write(openbaoConfig());
  } else if (action === "service") {
    const sub = argv.filter((arg) => !arg.startsWith("-"))[1] ?? "status";
    if (process.platform !== "linux")
      throw Error("the unseal service is a systemd user unit and only runs on Linux");
    const plan = openbaoUnsealUnitPlan(resolve(import.meta.dirname, ".."), { dpiHome: opts.home });
    const run = (argv2: string[], check = true) => {
      const result = spawnSync(argv2[0]!, argv2.slice(1), { stdio: "inherit" });
      if (result.error) throw result.error;
      const code = result.status ?? 1;
      if (check && code !== 0) throw Error(`${argv2.join(" ")} exited ${code}`);
    };
    switch (sub) {
      case "install":
        mkdirSync(dirname(plan.path), { recursive: true });
        writeFileSync(plan.path, plan.content, { mode: 0o644 });
        run(plan.reload);
        run(plan.enable);
        console.log(`Installed ${plan.path}`);
        break;
      case "uninstall":
        run(plan.disable, false);
        if (existsSync(plan.path)) rmSync(plan.path);
        run(plan.reload);
        console.log(`Removed ${plan.path}`);
        break;
      case "start":
        run(plan.start);
        break;
      case "stop":
        run(plan.stop);
        break;
      case "restart":
        run(plan.restart);
        break;
      case "status":
        run(plan.status, false);
        break;
      case "logs":
        run(plan.logs, false);
        break;
      case "print":
        process.stdout.write(plan.content);
        break;
      default:
        console.log("Usage: tsx scripts/openbao.ts service <install|uninstall|start|stop|restart|status|logs|print>");
        process.exit(1);
    }
  } else {
    console.log("Usage: tsx scripts/openbao.ts <up|init --operator|unseal|status|config|service>");
    process.exit(1);
  }
} catch (error) {
  console.error(`openbao: ${(error as Error).message}`);
  process.exit(1);
}
