// The local backend as a systemd **user** service: it starts at login and restarts on failure, without sudo.
// Remote devices and `just net up local` use the system units under `apps/dpi-backend/deploy/` instead; this is
// the workstation unit, managed with `systemctl --user`.
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const USER_UNIT = "dpi-backend.service";

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

export function userUnitPlan(
  appDir: string,
  opts: { node?: string; home?: string; dpiHome?: string; log?: string } = {},
): UserUnitPlan {
  const values = serviceValues(appDir, opts);
  const template = readFileSync(join(import.meta.dirname, "../deploy/dpi-backend.user.service"), "utf8");
  const systemctl = (...args: string[]) => ["systemctl", "--user", ...args];
  const user = userInfo().username;
  return {
    path: join(values.HOME, ".config/systemd/user", USER_UNIT),
    content: renderTemplate(template, { ...values }),
    reload: systemctl("daemon-reload"),
    enable: systemctl("enable", "--now", USER_UNIT),
    disable: systemctl("disable", "--now", USER_UNIT),
    start: systemctl("start", USER_UNIT),
    stop: systemctl("stop", USER_UNIT),
    restart: systemctl("restart", USER_UNIT),
    status: systemctl("status", USER_UNIT, "--no-pager"),
    logs: ["journalctl", "--user", "-u", USER_UNIT, "-n", "200", "-f"],
    linger: `loginctl enable-linger ${user}`,
  };
}
