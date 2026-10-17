#!/usr/bin/env tsx
// Manage the local backend as a systemd user service. The unit and commands live in src/service.ts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userUnitPlan } from "../src/service.js";

const appDir = resolve(import.meta.dirname, "..");
const action = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "status";

if (process.platform !== "linux") {
  console.error(
    `service: this manages a systemd user unit and only runs on Linux. On ${process.platform}, use 'just net up local' for a login service.`,
  );
  process.exit(1);
}

const plan = userUnitPlan(appDir);

function run(argv: string[], check = true): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  if (check && code !== 0) throw Error(`${argv.join(" ")} exited ${code}`);
}

function lingerHint() {
  const show = spawnSync("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"], {
    encoding: "utf8",
  });
  if ((show.stdout ?? "").trim() !== "yes")
    console.log(`\nTo keep the backend running after you log out: ${plan.linger}`);
}

try {
  switch (action) {
    case "install": {
      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.path, plan.content, { mode: 0o644 });
      run(plan.reload);
      run(plan.enable);
      console.log(`Installed ${plan.path}`);
      lingerHint();
      break;
    }
    case "uninstall": {
      run(plan.disable, false);
      if (existsSync(plan.path)) rmSync(plan.path);
      run(plan.reload);
      console.log(`Removed ${plan.path}`);
      break;
    }
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
      console.log("Usage: npm run service -- <install|uninstall|start|stop|restart|status|logs|print>");
      process.exit(1);
  }
} catch (error) {
  console.error(`service: ${(error as Error).message}`);
  process.exit(1);
}
