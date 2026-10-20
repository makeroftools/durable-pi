// The local hub as a systemd **user** service: it starts at login and restarts on failure, without sudo.
// The hub holds every device token, so the unit carries no secret: only DPI_HOME and DPI_HUB_PORT.
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const HUB_UNIT = "dpi-hub.service";
export const DEFAULT_HUB_PORT = "4781";

export interface ServiceValues {
  APP: string;
  NODE: string;
  PATH: string;
  HOME: string;
  DPI_HOME: string;
  PORT: string;
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

/** The hub port from DPI_HUB_PORT, validated before it becomes a unit file value. */
export function hubPort(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.DPI_HUB_PORT ?? DEFAULT_HUB_PORT;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw Error(`DPI_HUB_PORT must be a TCP port (got ${JSON.stringify(port)})`);
  return port;
}

export function serviceValues(
  appDir: string,
  opts: { node?: string; home?: string; dpiHome?: string; port?: string; log?: string } = {},
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
    PORT: opts.port ?? hubPort(),
    LOG: opts.log ?? join(dpiHome, "hub.log"),
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
  port?: string;
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

export function hubUnitPlan(appDir: string, opts: PlanOptions = {}): UserUnitPlan {
  return buildPlan(HUB_UNIT, "dpi-hub.user.service", serviceValues(appDir, opts));
}
