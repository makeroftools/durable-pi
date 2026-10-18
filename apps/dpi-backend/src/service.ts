// The local backend as a systemd **user** service: it starts at login and restarts on failure, without sudo.
// Remote devices and `just net up local` use the system units under `apps/dpi-backend/deploy/` instead; this is
// the workstation unit, managed with `systemctl --user`.
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const BACKEND_UNIT = "dpi-backend.service";
export const UNSEAL_UNIT = "dpi-openbao-unseal.service";
/** The backend user unit; kept for callers that predate the unseal unit. */
export const USER_UNIT = BACKEND_UNIT;

export interface ServiceValues {
  APP: string;
  NODE: string;
  PATH: string;
  HOME: string;
  DPI_HOME: string;
  LOG: string;
}

/** Replace every `__NAME__`; an unknown placeholder is a template bug, so fail rather than ship a broken unit. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/__([A-Z_]+)__/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw Error(`Unknown service template placeholder ${match}`);
    return value;
  });
}

export function serviceValues(
  appDir: string,
  opts: { node?: string; home?: string; dpiHome?: string; log?: string } = {},
): ServiceValues {
  const node = opts.node ?? process.execPath;
  const home = opts.home ?? homedir();
  const dpiHome = opts.dpiHome ?? process.env.DPI_HOME ?? join(home, ".dpi");
  return {
    APP: appDir,
    NODE: node,
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    DPI_HOME: dpiHome,
    LOG: opts.log ?? join(dpiHome, "backend.log"),
  };
}

export interface UserUnitPlan {
  /** Where the unit is written. */
  path: string;
  content: string;
  /** systemctl --user invocations, in order, for each action. */
  reload: string[];
  enable: string[];
  disable: string[];
  start: string[];
  stop: string[];
  restart: string[];
  status: string[];
  logs: string[];
  /** Surviving logout needs lingering; `install` prints this when it is not already on. */
  linger: string;
}

interface PlanOptions {
  node?: string;
  home?: string;
  dpiHome?: string;
  log?: string;
}

/** Build a user-unit plan for one rendered template. Its `systemctl --user` argv is pinned by the tests. */
function buildPlan(unit: string, templateFile: string, values: ServiceValues): UserUnitPlan {
  const template = readFileSync(join(import.meta.dirname, `../deploy/${templateFile}`), "utf8");
  const systemctl = (...args: string[]) => ["systemctl", "--user", ...args];
  const user = userInfo().username;
  return {
    path: join(values.HOME, ".config/systemd/user", unit),
    content: renderTemplate(template, { ...values }),
    reload: systemctl("daemon-reload"),
    enable: systemctl("enable", "--now", unit),
    disable: systemctl("disable", "--now", unit),
    start: systemctl("start", unit),
    stop: systemctl("stop", unit),
    restart: systemctl("restart", unit),
    status: systemctl("status", unit, "--no-pager"),
    logs: ["journalctl", "--user", "-u", unit, "-n", "200", "-f"],
    linger: `loginctl enable-linger ${user}`,
  };
}

export function userUnitPlan(appDir: string, opts: PlanOptions = {}): UserUnitPlan {
  return buildPlan(BACKEND_UNIT, "dpi-backend.user.service", serviceValues(appDir, opts));
}

/**
 * The boot-time unsealer: recovers a sealed vault after a reboot without a human. It writes its own log so an
 * unseal failure is visible next to the backend's. `just openbao service ...` manages it.
 */
export function openbaoUnsealUnitPlan(appDir: string, opts: PlanOptions = {}): UserUnitPlan {
  const home = opts.home ?? homedir();
  const dpiHome = opts.dpiHome ?? process.env.DPI_HOME ?? join(home, ".dpi");
  const values = serviceValues(appDir, { ...opts, log: opts.log ?? join(dpiHome, "openbao-unseal.log") });
  return buildPlan(UNSEAL_UNIT, "dpi-openbao-unseal.user.service", values);
}
