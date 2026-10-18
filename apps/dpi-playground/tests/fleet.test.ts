// The fleet view rests on two pure rules: every session on every device becomes one row, and the totals only
// count usage the device actually reported (a closed session has none). Both are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetRows, fleetTotals } from "../../dpi-sdk/src/fleet.js";
import type { NetworkDevice, SessionSummary } from "../../dpi-sdk/src/api.js";

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  id: "s",
  name: "s",
  cwd: "/w",
  model: "m",
  createdAt: 0,
  dbPath: "/db",
  busy: false,
  agents: [],
  ...over,
});

const device = (id: string, status: NetworkDevice["status"], sessions: SessionSummary[]): NetworkDevice => ({
  id,
  name: id,
  kind: "local",
  url: "http://x",
  source: "config",
  hasToken: true,
  status,
  tree: { uid: "u", name: id, sessions, at: 0 },
});

test("fleetRows lists every session across devices, running first then newest", () => {
  const rows = fleetRows([
    device("a", "online", [session({ id: "a1", createdAt: 10 })]),
    device("b", "online", [
      session({ id: "b1", createdAt: 30, busy: true }),
      session({ id: "b2", createdAt: 20 }),
    ]),
  ]);
  assert.deepEqual(
    rows.map((r) => r.session.id),
    ["b1", "b2", "a1"],
  );
  assert.equal(rows[0]!.deviceId, "b");
  assert.equal(rows[0]!.agents, 0);
});

test("fleetTotals counts devices, sessions, running and only the open usage", () => {
  const usage = {
    models: { x: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } },
    tools: {},
  };
  const rows = fleetRows([
    device("a", "online", [
      session({ id: "a1", busy: true, usage }),
      session({ id: "a2" }), // closed: no usage reported
    ]),
    device("b", "offline", [session({ id: "b1", usage })]),
  ]);
  assert.deepEqual(fleetTotals(rows), {
    devices: 2,
    sessions: 3,
    busy: 1,
    open: 2,
    tokens: 240,
    cost: 1,
  });
});

test("an empty network totals to zero", () => {
  assert.deepEqual(fleetTotals(fleetRows([])), {
    devices: 0,
    sessions: 0,
    busy: 0,
    open: 0,
    tokens: 0,
    cost: 0,
  });
});
