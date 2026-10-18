// Fleet aggregation for any client: flatten every device's sessions into one ranked list and total what is
// known. Client-agnostic (no Vue), so it is one source of truth for the web hub, the TUI, and tests.
import type { DeviceStatus, NetworkDevice, SessionSummary } from "./api.js";
import { sumUsage, type UsageSummary } from "./transcript.js";

export interface FleetRow {
  deviceId: string;
  deviceName: string;
  status: DeviceStatus;
  session: SessionSummary;
  agents: number;
  busy: boolean;
  /** The session's token/cost totals, present only when the device has the session open. */
  usage?: UsageSummary;
}

/** One row per session across every device. Running sessions first, then most recently started. */
export function fleetRows(devices: readonly NetworkDevice[]): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const device of devices) {
    for (const session of device.tree?.sessions ?? []) {
      rows.push({
        deviceId: device.id,
        deviceName: device.name,
        status: device.status,
        session,
        agents: session.agents.length,
        busy: session.busy,
        ...(session.usage ? { usage: sumUsage(session.usage) } : {}),
      });
    }
  }
  return rows.sort((a, b) => Number(b.busy) - Number(a.busy) || b.session.createdAt - a.session.createdAt);
}

export interface FleetTotals {
  devices: number;
  sessions: number;
  busy: number;
  /** Sessions whose usage is known (the device has them open). */
  open: number;
  tokens: number;
  cost: number;
}

export function fleetTotals(rows: readonly FleetRow[]): FleetTotals {
  return {
    devices: new Set(rows.map((row) => row.deviceId)).size,
    sessions: rows.length,
    busy: rows.filter((row) => row.busy).length,
    open: rows.filter((row) => row.usage).length,
    tokens: rows.reduce((total, row) => total + (row.usage?.tokens ?? 0), 0),
    cost: rows.reduce((total, row) => total + (row.usage?.cost ?? 0), 0),
  };
}
