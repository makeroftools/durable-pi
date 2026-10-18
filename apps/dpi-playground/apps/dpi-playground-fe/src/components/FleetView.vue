<script setup lang="ts">
// The fleet: every session on every device in one table, with live tokens/cost where the device has the
// session open. Click a row to select it and steer it. Pure rows/totals live in client/fleet.ts.
import { computed } from "vue";
import { X } from "lucide-vue-next";
import { fleetRows, fleetTotals, type FleetRow } from "@sdk/fleet";
import { ago, network, number, select, shortPath } from "../client/store";

const emit = defineEmits<{ close: [] }>();
const rows = computed(() => fleetRows(network.devices.value));
const totals = computed(() => fleetTotals(rows.value));

const money = (n: number) => `$${(n < 1 ? n.toFixed(4) : n.toFixed(2))}`;

function open(row: FleetRow) {
  const agent = row.session.agents.find((a) => a.kind === "root") ?? row.session.agents[0];
  if (!agent) return;
  select({ deviceId: row.deviceId, sessionId: row.session.id, agentId: agent.id });
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal fleet-modal">
      <header>
        <div>
          <span class="eyebrow">THE WHOLE NETWORK</span>
          <h2>Fleet</h2>
        </div>
        <button class="icon-button" aria-label="Close fleet view" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <div class="fleet-summary">
        <span><strong>{{ totals.devices }}</strong> devices</span>
        <span><strong>{{ totals.sessions }}</strong> sessions</span>
        <span :class="{ running: totals.busy }"><strong>{{ totals.busy }}</strong> running</span>
        <span><strong>{{ number(totals.tokens) }}</strong> tokens</span>
        <span
          ><strong>{{ money(totals.cost) }}</strong> cost
          <small v-if="totals.open < totals.sessions"
            >({{ totals.open }}/{{ totals.sessions }} open)</small
          ></span
        >
      </div>

      <div class="fleet-table">
        <div class="fleet-head" role="row">
          <span>Device</span><span>Session</span><span>Workspace</span><span>Model</span>
          <span>Agents</span><span>Tokens</span><span>Cost</span><span>Started</span>
        </div>
        <button
          v-for="row in rows"
          :key="`${row.deviceId}/${row.session.id}`"
          class="fleet-row"
          role="row"
          :title="row.session.cwd"
          @click="open(row)"
        >
          <span class="cell-device"><i :class="row.status" />{{ row.deviceId }}</span>
          <span class="cell-session"
            >{{ row.session.name }} <em v-if="row.busy">running</em></span
          >
          <span class="cell-path">{{ shortPath(row.session.cwd, 30) }}</span>
          <span class="cell-model">{{ row.session.model }}</span>
          <span>{{ row.agents }}</span>
          <span>{{ row.usage ? number(row.usage.tokens) : "—" }}</span>
          <span>{{ row.usage ? money(row.usage.cost) : "—" }}</span>
          <span>{{ ago(row.session.createdAt) }}</span>
        </button>
        <p v-if="!rows.length" class="empty">No sessions on any device yet.</p>
      </div>

      <p class="hint">
        Tokens and cost are shown for sessions the device has open; a closed session shows —. Click a
        row to open and steer it.
      </p>
    </section>
  </div>
</template>

<style scoped>
.fleet-modal {
  width: min(1040px, 94vw);
  max-height: 86vh;
}
.fleet-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  padding: 0.5rem 0 1rem;
  border-bottom: 1px solid var(--line, #2a2a2a);
  color: var(--muted, #9aa0a6);
  font-size: 0.85rem;
}
.fleet-summary strong {
  color: var(--text, #e8eaed);
  font-variant-numeric: tabular-nums;
}
.fleet-summary .running strong {
  color: var(--accent, #6ee7b7);
}
.fleet-table {
  overflow: auto;
  max-height: 58vh;
  margin-top: 0.5rem;
}
.fleet-head,
.fleet-row {
  display: grid;
  grid-template-columns: 10rem minmax(10rem, 1.3fr) minmax(9rem, 1.2fr) minmax(8rem, 1fr) 4rem 5rem 5rem 5.5rem;
  gap: 0.6rem;
  align-items: center;
  padding: 0.45rem 0.6rem;
  text-align: left;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}
.fleet-head {
  position: sticky;
  top: 0;
  color: var(--muted, #9aa0a6);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--surface, #17181b);
  border-bottom: 1px solid var(--line, #2a2a2a);
}
.fleet-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--line, #202124);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.fleet-row:hover {
  background: var(--hover, rgba(255, 255, 255, 0.05));
}
.cell-device {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-device i {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #6b7280;
  flex: none;
}
.cell-device i.online {
  background: var(--accent, #6ee7b7);
}
.cell-session {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-session em {
  margin-left: 0.35rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-style: normal;
  color: var(--accent, #6ee7b7);
  background: color-mix(in srgb, var(--accent, #6ee7b7) 16%, transparent);
}
.cell-path,
.cell-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted, #9aa0a6);
}
.fleet-table .empty {
  padding: 1.5rem 0.6rem;
  color: var(--muted, #9aa0a6);
}
</style>
