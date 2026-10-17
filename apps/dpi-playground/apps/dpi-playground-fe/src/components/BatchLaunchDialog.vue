<script setup lang="ts">
// One brief, N worktrees: launch a session per directory in a single act. The batch key is minted once per
// dialog and reused for every retry, so the device replays what it already made instead of starting a second
// session for the same directory. Session names are frozen per directory for the same reason: they are part of
// the spec the idempotency key is derived from.
import { computed, reactive, ref, watch } from "vue";
import { FolderPlus, Plus, X } from "lucide-vue-next";
import {
  THINKING_LEVELS,
  type CreateSessionBody,
  type ErrorCode,
  type LaunchResult,
  type ThinkingLevel,
} from "@sdk/api";
import DirBrowser from "./DirBrowser.vue";
import { assignNames, batchSpec, parseDirs } from "../client/batch";
import { newId } from "../client/ids";
import { deviceClient, message } from "../client/hub";
import { network, notify, select } from "../client/store";

const props = defineProps<{ deviceId?: string }>();
const emit = defineEmits<{ close: [] }>();

const devices = computed(() => network.devices.value.filter((d) => d.status === "online"));
const deviceId = ref(
  devices.value.find((d) => d.id === props.deviceId)?.id ?? devices.value[0]?.id ?? "",
);
const device = computed(() => devices.value.find((d) => d.id === deviceId.value));
const models = computed(() => device.value?.info?.models ?? []);
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

const draft = ref({ dirs: "", model: "", prompt: "", thinking: "" });
/** The folder the browser is looking at; "Add this folder" appends it to the list. */
const picker = ref("");

/** One act of launching: a retry reuses this key, so the device replays the sessions it already made. */
const batchKey = newId();
/** Directory → session name. Minted once and reused, so a retry is byte-identical. */
const names = new Map<string, string>();
/** Directory → outcome. A directory with a result is not sent again. */
const outcomes = reactive(
  new Map<string, { result?: LaunchResult; error?: { code: ErrorCode; message: string } }>(),
);
const attempted = ref(false);
const busy = ref(false);
const error = ref("");

const parsed = computed(() => parseDirs(draft.value.dirs));
const pending = computed(() =>
  parsed.value
    .filter((d) => !d.duplicate && !outcomes.get(d.path)?.result)
    .map((d) => d.path),
);
const rows = computed(() =>
  parsed.value.map((d) => {
    const outcome = outcomes.get(d.path);
    const seed = outcome?.result?.seedError;
    return {
      path: d.path,
      kind: d.duplicate
        ? "error"
        : seed
          ? "warn"
          : outcome?.error
            ? "error"
            : outcome?.result
              ? "ok"
              : "pending",
      text: d.duplicate
        ? "duplicate — not launched"
        : seed
          ? `Session exists; brief failed: ${seed}`
          : outcome?.error
            ? outcome.error.message
            : outcome?.result
              ? `Launched as “${outcome.result.name}”`
              : "Pending",
    };
  }),
);
const label = computed(() => {
  if (busy.value) return "Launching…";
  const n = pending.value.length;
  return attempted.value ? `Retry remaining (${n})` : `Launch ${n} session${n === 1 ? "" : "s"}`;
});

watch(
  device,
  (d) => {
    const fallback =
      d?.info?.models.find((m) => m.id === d.info?.defaultModel) ?? d?.info?.models[0];
    draft.value.model = fallback ? key(fallback) : "";
  },
  { immediate: true },
);
watch(deviceId, () => {
  // Idempotency keys live in a device's own catalog; a replay still converges, so start this device clean.
  outcomes.clear();
  names.clear();
  attempted.value = false;
  error.value = "";
});

function addFolder() {
  const path = picker.value.trim();
  if (!path) return;
  const lines = draft.value.dirs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  draft.value.dirs = [...lines, path].join("\n");
}

/** Launch every directory that has no result yet, under the dialog's one batch key. */
async function launch() {
  if (busy.value || !device.value) return;
  error.value = "";
  const model = models.value.find((m) => key(m) === draft.value.model);
  if (!model) return void (error.value = "Choose a model.");
  const list = pending.value;
  if (!list.length) return void (error.value = "Add at least one directory to launch.");

  // Mint any missing names now, in list order; from here the specs are frozen for the life of the dialog.
  assignNames(
    parsed.value.filter((d) => !d.duplicate).map((d) => d.path),
    names,
  );
  const brief = draft.value.prompt.trim();
  const specs: CreateSessionBody[] = list.map((cwd) =>
    batchSpec(
      names.get(cwd)!,
      cwd,
      { provider: model.provider, modelId: model.id },
      brief,
      (draft.value.thinking || undefined) as ThinkingLevel | undefined,
    ),
  );

  busy.value = true;
  attempted.value = true;
  for (const cwd of list) outcomes.delete(cwd);
  try {
    const result = await deviceClient(device.value.id).createSessions(specs, batchKey, {
      timeoutMs: 60_000,
    });
    result.items.forEach((item, i) => {
      outcomes.set(list[i], item.error ? { error: item.error } : { result: item.result! });
    });
    if (result.aborted) {
      error.value = "Launch was interrupted. Retry the remaining directories.";
      return;
    }
    const failed = result.items.find((i) => i.error);
    if (failed) {
      error.value = `Stopped at ${failed.spec.cwd}: ${failed.error!.message}`;
      return;
    }
    if (result.items.some((i) => i.result?.seedError)) return; // stay open; the rows name the sessions
    finish(specs.length);
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

/** Full success: open the first session that launched and close. */
function finish(launched: number) {
  const first = parsed.value.find((d) => !d.duplicate && outcomes.get(d.path)?.result);
  const session = first ? outcomes.get(first.path)!.result : undefined;
  if (session) {
    const root = session.agents.find((a) => a.kind === "root") ?? session.agents[0];
    select({ deviceId: device.value!.id, sessionId: session.id, agentId: root?.id ?? 1 });
  }
  notify(`${launched} session${launched === 1 ? "" : "s"} launched on ${device.value!.id}.`);
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal batch-modal" @submit.prevent="launch">
      <header>
        <div>
          <span class="eyebrow">ONE BRIEF, N WORKTREES</span>
          <h2>Batch launch</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close batch launch"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <p v-if="!devices.length" class="message-error">
        No device is online. Start one with just backend run or just net up &lt;id&gt;, then try again.
      </p>
      <template v-else>
        <div class="batch-grid">
          <div class="batch-inputs">
            <label
              >Device<select v-model="deviceId" aria-label="Device">
                <option v-for="d in devices" :key="d.id" :value="d.id">
                  {{ d.id }} · {{ d.info?.hostname ?? d.url }}
                </option>
              </select></label
            >
            <label
              >Model<select v-model="draft.model" aria-label="Batch model">
                <option v-for="m in models" :key="key(m)" :value="key(m)">
                  {{ m.tier }} / {{ m.name }}
                </option>
              </select></label
            >
            <label
              >Thinking<select v-model="draft.thinking" aria-label="Batch thinking level">
                <option value="">Default</option>
                <option v-for="level in THINKING_LEVELS" :key="level" :value="level">
                  {{ level }}
                </option>
              </select></label
            >
            <label
              >Opening brief (optional)<textarea
                v-model="draft.prompt"
                rows="4"
                placeholder="Paste a brief, or a path to one. Sent to every session."
            /></label>
          </div>
          <div class="batch-picker">
            <label
              >Directories, one per line<textarea
                v-model="draft.dirs"
                aria-label="Directories, one per line"
                rows="8"
                autofocus
                spellcheck="false"
                placeholder="/path/to/one&#10;/path/to/two"
            /></label>
            <div class="field">
              <span>Pick a folder on {{ deviceId }}</span>
              <DirBrowser v-model="picker" :device-id="deviceId" />
              <button
                type="button"
                class="secondary small add-folder"
                :disabled="!picker"
                @click="addFolder"
              >
                <FolderPlus :size="16" />Add this folder
              </button>
            </div>
          </div>
        </div>
        <ul v-if="rows.length" class="batch-list" aria-label="Directories in this batch">
          <li v-for="(r, i) in rows" :key="i" :class="['batch-item', r.kind]">
            <code>{{ r.path }}</code><span>{{ r.text }}</span>
          </li>
        </ul>
      </template>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">Cancel</button
        ><button
          class="primary"
          :disabled="busy || !draft.model || !pending.length || !device"
        >
          <Plus :size="18" />{{ label }}
        </button>
      </footer>
    </form>
  </div>
</template>
