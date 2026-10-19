// Parallel, durable subagents for the coding agent.
//
// A subagent is its own conversation. It is owned by a background *anchor* task, not by the tool call that spawned
// it, so the parent's Esc, idle wait or abort never reaches it. Each message is delivered by a background *reporter*
// task that posts the answer back to the parent exactly once. Request IDs make a restart idempotent: the child gets a
// message once and the parent gets a report once. A conversation document, `dpi.subagents`, maps names to child
// conversations, messages, reported entry IDs and the bounded spawn queue.
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineTask,
  defineTool,
  type ConversationId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import type { WireMessage } from "../../dpi-sdk/src/api.js";

export const SUBAGENTS_DOC_KIND = "dpi.subagents";
/** Spawns that run at once unless a call asks for a lower limit. */
export const DEFAULT_SUBAGENTS_IN_FLIGHT = 4;
/** No call can raise the limit above this. */
export const MAX_SUBAGENTS_IN_FLIGHT = 8;
const MAX_MESSAGES_PER_AGENT = 50;
const MAX_REQUESTS = 400;
const MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_WAIT_MS = 5 * 60_000;

export type SubagentStatus = "queued" | "running" | "idle" | "done" | "failed";
export type SubagentMessageState = "queued" | "running" | "done" | "failed" | "stopped";

export type SubagentMessage = {
  id: string;
  text: string;
  followUp: boolean;
  state: SubagentMessageState;
  startedAt: number;
  endedAt?: number;
  reporterId?: number;
  answerEntryId?: number;
  answer?: string;
  error?: string;
};

export type SubagentRecord = {
  name: string;
  conversationId: number;
  anchorTaskId: number;
  order: number;
  status: SubagentStatus;
  task: string;
  messages: SubagentMessage[];
  /** Assistant entry IDs already reported to the parent. One answer is reported once, even after a restart. */
  reported: number[];
  latestAnswer?: string;
  latestEntryId?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type ReporterRecord = {
  taskId: number;
  name: string;
  messageId: string;
  state: "running" | "done" | "failed" | "stopped";
};

export type SubagentsDoc = {
  agents: Record<string, SubagentRecord>;
  /** Spawn order. `status` and `wait` return children in this order. */
  order: string[];
  reporters: Record<string, ReporterRecord>;
  /** Tool-call request keys, so a replayed spawn/send/stop is not applied twice. */
  requests: Record<string, { name: string; messageId?: string; reporterId?: number; action: string }>;
  /** The in-flight cap, default 4, never above 8. */
  limit: number;
};

const initialSubagents = (): SubagentsDoc => ({
  agents: {},
  order: [],
  reporters: {},
  requests: {},
  limit: DEFAULT_SUBAGENTS_IN_FLIGHT,
});

export const Subagents = defineDoc<SubagentsDoc>({
  kind: SUBAGENTS_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork starts with no children; its parent keeps working with its own.
  fork: "initial",
  initial: initialSubagents,
});

export const emptySubagents = initialSubagents;

// ------------------------------------------------------------------ pure registry, queue and dedupe helpers

export function clampConcurrency(value: number | undefined, fallback = DEFAULT_SUBAGENTS_IN_FLIGHT): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(MAX_SUBAGENTS_IN_FLIGHT, n));
}

export const queuedNames = (state: SubagentsDoc): string[] =>
  state.order.filter((name) => state.agents[name]?.status === "queued");

export const runningNames = (state: SubagentsDoc): string[] =>
  state.order.filter((name) => state.agents[name]?.status === "running");

export function activeCount(state: SubagentsDoc): number {
  return runningNames(state).length;
}

export function recomputeStatus(agent: SubagentRecord): SubagentStatus {
  if (agent.messages.some((m) => m.state === "running")) return "running";
  if (agent.messages.some((m) => m.state === "queued")) return "queued";
  const last = agent.messages.at(-1);
  if (last?.state === "done") return "done";
  if (last?.state === "failed") return "failed";
  return "idle";
}

function rememberRequest(state: SubagentsDoc, key: string, value: SubagentsDoc["requests"][string]) {
  state.requests[key] = value;
  const keys = Object.keys(state.requests);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REQUESTS))) delete state.requests[old];
}

export function findRequest(state: SubagentsDoc, key: string) {
  return Object.hasOwn(state.requests, key) ? state.requests[key] : undefined;
}

/** Append a spawn to a registry. False when the name already exists or the request was already applied. */
export function addSpawn(
  state: SubagentsDoc,
  input: {
    name: string;
    conversationId: number;
    anchorTaskId: number;
    task: string;
    messageId: string;
    now: number;
  },
): boolean {
  if (Object.hasOwn(state.agents, input.name) || findRequest(state, input.messageId)) return false;
  state.agents[input.name] = {
    name: input.name,
    conversationId: input.conversationId,
    anchorTaskId: input.anchorTaskId,
    order: state.order.length,
    status: "queued",
    task: input.task,
    messages: [
      {
        id: input.messageId,
        text: input.task,
        followUp: false,
        state: "queued",
        startedAt: input.now,
      },
    ],
    reported: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  state.order.push(input.name);
  rememberRequest(state, input.messageId, { name: input.name, messageId: input.messageId, action: "spawn" });
  return true;
}

/** Queue another message for an existing child. False for an unknown name or an already-applied request. */
export function addMessage(
  state: SubagentsDoc,
  name: string,
  input: { messageId: string; text: string; followUp: boolean; now: number },
): boolean {
  const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
  if (!agent || findRequest(state, input.messageId)) return false;
  agent.messages.push({
    id: input.messageId,
    text: input.text,
    followUp: input.followUp,
    state: "queued",
    startedAt: input.now,
  });
  if (agent.messages.length > MAX_MESSAGES_PER_AGENT) agent.messages = agent.messages.slice(-MAX_MESSAGES_PER_AGENT);
  agent.status = recomputeStatus(agent);
  agent.updatedAt = input.now;
  rememberRequest(state, input.messageId, { name, messageId: input.messageId, action: "send" });
  return true;
}

/**
 * The queued messages that may start now: every queued message of an already-running child, plus one slot for each
 * idle child until the limit is reached. Returned in spawn order, then message order.
 */
export function takeStartable(state: SubagentsDoc): { name: string; messageId: string }[] {
  const active = new Set(runningNames(state));
  let slots = Math.max(0, state.limit - active.size);
  const starts: { name: string; messageId: string }[] = [];
  for (const name of state.order) {
    const agent = state.agents[name];
    if (!agent) continue;
    const queued = agent.messages.filter((m) => m.state === "queued");
    if (queued.length === 0) continue;
    if (!active.has(name)) {
      if (slots <= 0) continue;
      slots -= 1;
      active.add(name);
    }
    for (const message of queued) starts.push({ name, messageId: message.id });
  }
  return starts;
}

/** Record a successful answer. Returns whether this answer still needs to be reported to the parent. */
export function finishMessage(
  state: SubagentsDoc,
  name: string,
  messageId: string,
  answer: { text: string; entryId: number },
  now: number,
): { report: boolean; duplicate: boolean } {
  const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
  const message = agent?.messages.find((m) => m.id === messageId);
  if (!agent || !message) return { report: false, duplicate: true };
  if (message.state === "stopped") return { report: false, duplicate: false };
  const duplicate = agent.reported.includes(answer.entryId);
  message.state = "done";
  message.answer = answer.text;
  message.answerEntryId = answer.entryId;
  message.endedAt = now;
  delete message.error;
  agent.latestAnswer = answer.text;
  agent.latestEntryId = answer.entryId;
  delete agent.lastError;
  if (!duplicate) agent.reported.push(answer.entryId);
  agent.status = recomputeStatus(agent);
  agent.updatedAt = now;
  const reporter = message.reporterId === undefined ? undefined : state.reporters[String(message.reporterId)];
  if (reporter) reporter.state = "done";
  return { report: !duplicate, duplicate };
}

/** Record a failed message. The child stays usable for another send. */
export function failMessage(
  state: SubagentsDoc,
  name: string,
  messageId: string,
  error: string,
  now: number,
): boolean {
  const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
  const message = agent?.messages.find((m) => m.id === messageId);
  if (!agent || !message) return false;
  if (message.state === "stopped") return false;
  message.state = "failed";
  message.error = error;
  message.endedAt = now;
  agent.lastError = error;
  agent.status = recomputeStatus(agent);
  agent.updatedAt = now;
  const reporter = message.reporterId === undefined ? undefined : state.reporters[String(message.reporterId)];
  if (reporter) reporter.state = "failed";
  return true;
}

/** Stop marks every live message of one child; its later sends use new messages. */
export function stopAgent(state: SubagentsDoc, name: string, now: number): boolean {
  const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
  if (!agent) return false;
  for (const message of agent.messages)
    if (message.state === "queued" || message.state === "running") {
      message.state = "stopped";
      message.error = "Stopped";
      message.endedAt = now;
      const reporter = message.reporterId === undefined ? undefined : state.reporters[String(message.reporterId)];
      if (reporter) reporter.state = "stopped";
    }
  agent.status = "idle";
  agent.lastError = "Stopped";
  agent.updatedAt = now;
  return true;
}

// ------------------------------------------------------------------ durable tasks

/**
 * A background boundary that owns one child conversation. It finishes at once; it exists so the parent's Esc and
 * idle waits stop at the anchor instead of reaching the child.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "dpi.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
  },
  abort: (_anchor, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type ReporterInput = {
  name: string;
  conversationId: number;
  message: string;
  followUp: boolean;
  messageId: string;
};

type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

const reporterText = (entry: EntryRecord | undefined): string => {
  const text = ((entry?.model ?? []) as unknown as WireMessage[]).map(messageText).join("\n").trim();
  if (text) return text;
  const assistant = (entry?.model ?? [])[0] as { errorMessage?: string; stopReason?: string } | undefined;
  return assistant?.errorMessage ?? (assistant?.stopReason === "error" ? "Provider request failed." : "");
};

/**
 * Delivers one message to one child and reports its answer to the parent. Both submissions use deterministic request
 * IDs, so a restart cannot send the message twice or report the answer twice.
 */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "dpi.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, ctx) => {
      const { name, conversationId, message, followUp, messageId } = reporter.input;
      let report: string | undefined;
      try {
        const child = await runtime.conversation(conversationId as ConversationId, ctx);
        if (!child) throw Error(`Subagent ${name} conversation is missing`);
        // While the child is busy, a steer reaches it at its next step; a follow-up waits for its current answer.
        const submission = await child.submit(
          {
            type: "input",
            content: message,
            whenBusy: followUp ? "followUp" : "steer",
            requestId: `subagents:msg:${reporter.id}`,
          },
          ctx,
        );
        const settled = await submission.wait(ctx);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Subagents, runtime.conversationId);
          const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
          const current = agent?.messages.find((m) => m.id === messageId);
          const next = (value?: string) =>
            ({ status: "running" as const, checkpoint: { phase: "report" as const, report: value } });
          if (!agent || !current) return next();
          // stop already settled it: no report, and no new turn in the parent.
          if (current.state === "stopped") return next();
          if (settled.status === "unanswered") {
            if (settled.reason === "aborted" || settled.reason === "withdrawn") {
              stopAgent(state, name, runtime.now());
              return next();
            }
            const error = `Subagent ${name} failed: ${settled.reason}`;
            failMessage(state, name, messageId, error, runtime.now());
            return next(`[subagent ${name} failed] ${error}`);
          }
          if (settled.type !== "input") {
            const error = `Subagent ${name} ended without an answer`;
            failMessage(state, name, messageId, error, runtime.now());
            return next(`[subagent ${name} failed] ${error}`);
          }
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const text = reporterText(entry);
          const decided = finishMessage(
            state,
            name,
            messageId,
            { text, entryId: settled.answer as number },
            runtime.now(),
          );
          if (decided.report) report = `[subagent ${name} finished] ${text || "(no text answer)"}`;
          return next(report);
        }, ctx);
      } catch (e) {
        const error = `Subagent ${name} failed: ${String((e as Error)?.message ?? e)}`;
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Subagents, runtime.conversationId);
          failMessage(state, name, messageId, error, runtime.now());
          return { status: "running", checkpoint: { phase: "report", report: `[subagent ${name} failed] ${error}` } };
        }, ctx);
      }
    },
    report: async (reporter, runtime, ctx) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        try {
          const parent = await runtime.conversation(runtime.conversationId, ctx);
          // A follow-up starts a turn when the parent is idle, or joins its current turn; the request ID is stable.
          await parent?.submit(
            {
              type: "input",
              content: report,
              whenBusy: "followUp",
              requestId: `subagents:report:${reporter.id}`,
            },
            ctx,
          );
        } catch (e) {
          // A closed parent is not a reason to leave queued children unscheduled; report and finish the reporter.
          runtime.report(e);
        }
      }
      await runtime.commit(async (tx) => {
        const state = await tx.doc(Subagents, runtime.conversationId);
        const record = Object.hasOwn(state.reporters, String(reporter.id))
          ? state.reporters[String(reporter.id)]
          : undefined;
        if (record?.state === "running") record.state = "done";
        // The slot this reporter held is free now: start queued spawns without waiting for the parent to call wait.
        await startQueued(tx, state, runtime.conversationId, runtime.now());
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  abort: async (reporter, runtime, ctx) => {
    await runtime.commit(async (tx) => {
      const state = await tx.doc(Subagents, runtime.conversationId);
      const record = Object.hasOwn(state.reporters, String(reporter.id))
        ? state.reporters[String(reporter.id)]
        : undefined;
      if (record?.state === "running") record.state = "stopped";
      stopAgent(state, reporter.input.name, runtime.now());
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx);
  },
});

/** Create reporter tasks for queued messages that fit the cap. Returns the child names started. */
export async function startQueued(
  tx: Tx,
  state: SubagentsDoc,
  conversationId: ConversationId,
  now: number,
): Promise<string[]> {
  const started: string[] = [];
  for (const { name, messageId } of takeStartable(state)) {
    const agent = state.agents[name];
    const message = agent?.messages.find((m) => m.id === messageId);
    if (!agent || !message) continue;
    const taskId = await tx.createTask(
      Reporter,
      {
        name,
        conversationId: agent.conversationId,
        message: message.text,
        followUp: message.followUp,
        messageId,
      },
      { ownership: { kind: "conversation" }, conversationId, background: true },
    );
    message.state = "running";
    message.reporterId = taskId as number;
    message.startedAt = now;
    agent.status = "running";
    agent.updatedAt = now;
    state.reporters[String(taskId)] = {
      taskId: taskId as number,
      name,
      messageId,
      state: "running",
    };
    started.push(name);
  }
  return started;
}

// ------------------------------------------------------------------ reports and the tool

const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text);

const answerOf = (agent: SubagentRecord) => ({
  ...(agent.latestEntryId === undefined ? {} : { entryId: agent.latestEntryId }),
  ...(agent.latestAnswer === undefined ? {} : { answer: clip(agent.latestAnswer, 4000) }),
});

const messageReport = (message: SubagentMessage) => ({
  id: message.id,
  state: message.state,
  ...(message.reporterId === undefined ? {} : { reporterTaskId: message.reporterId }),
  ...(message.answerEntryId === undefined ? {} : { answerEntryId: message.answerEntryId }),
  ...(message.answer === undefined ? {} : { answer: clip(message.answer, 1000) }),
  ...(message.error === undefined ? {} : { error: message.error }),
});

const agentReport = (agent: SubagentRecord) => ({
  name: agent.name,
  order: agent.order,
  status: agent.status,
  conversationId: agent.conversationId,
  anchorTaskId: agent.anchorTaskId,
  task: agent.task,
  ...answerOf(agent),
  ...(agent.lastError === undefined ? {} : { error: agent.lastError }),
  messages: agent.messages.map(messageReport),
});

function targets(state: SubagentsDoc, names: string[] | undefined): string[] {
  const known = state.order.filter((name) => Object.hasOwn(state.agents, name));
  if (!names || names.length === 0) return known;
  const missing = names.filter((name) => !Object.hasOwn(state.agents, name));
  if (missing.length) throw Error(`No subagent named ${missing.join(", ")}. Known: ${known.join(", ") || "none"}`);
  return known.filter((name) => names.includes(name));
}

export function statusReport(state: SubagentsDoc, names?: string[]) {
  return {
    limit: state.limit,
    inFlight: activeCount(state),
    queue: queuedNames(state),
    agents: targets(state, names).map((name) => agentReport(state.agents[name]!)),
  };
}

const paused = (agent: SubagentRecord) =>
  agent.status === "queued" || agent.messages.some((m) => m.state === "queued" || m.state === "running");

export function resultsReport(state: SubagentsDoc, names?: string[]) {
  return {
    limit: state.limit,
    inFlight: activeCount(state),
    queue: queuedNames(state),
    results: targets(state, names).map((name) => {
      const agent = state.agents[name]!;
      return {
        name,
        status: agent.status,
        conversationId: agent.conversationId,
        ...answerOf(agent),
        ...(agent.lastError === undefined ? {} : { error: agent.lastError }),
      };
    }),
  };
}

export type SubagentTools = { tool: ReturnType<typeof defineTool>; tasks: [typeof Anchor, typeof Reporter] };

/**
 * Build the `subagents` tool. `hiddenTools` are removed from a child's selection as well, so a child cannot recurse
 * through either this tool or the legacy foreground `subagent`.
 */
export function createSubagents(options: { hiddenTools?: unknown[] } = {}) {
  const subagentsTool = defineTool({
    name: "subagents",
    description:
      "Run persistent subagents in parallel. Each child has its own conversation, keeps working when you are interrupted or the backend restarts, and reports its answer back once. Actions: spawn {name, task}; fanout {tasks:[{name,task}], concurrency?}; send {name, message, followUp?} (steer now, or queue after the current answer); status {name?} (queued, running, idle, done, failed plus the queue); wait {names?} (join in spawn order and drain the queue); stop {name} (abort current work, child stays usable); results {names?} (latest answers without waiting). At most 4 children run at once by default, and never more than 8; extra spawns wait in a durable queue.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("fanout"),
        Type.Literal("send"),
        Type.Literal("status"),
        Type.Literal("wait"),
        Type.Literal("stop"),
        Type.Literal("results"),
      ]),
      name: Type.Optional(Type.String({ description: "Child name for spawn, send, stop or status." })),
      task: Type.Optional(Type.String({ description: "The first task for spawn." })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({ name: Type.String(), task: Type.String() }),
          { description: "Children for fanout, in spawn order." },
        ),
      ),
      message: Type.Optional(Type.String({ description: "Message for send." })),
      followUp: Type.Optional(
        Type.Boolean({ description: "For send: queue after the child's current answer instead of steering it now." }),
      ),
      names: Type.Optional(
        Type.Array(Type.String(), { description: "Children for wait or results. Omit for all, in spawn order." }),
      ),
      concurrency: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `In-flight cap for spawn/fanout. Default ${DEFAULT_SUBAGENTS_IN_FLIGHT}; values above the hard cap ${MAX_SUBAGENTS_IN_FLIGHT} are capped.`,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          maximum: MAX_WAIT_MS,
          description: "For wait: return a partial report after this long. Default 300000.",
        }),
      ),
    }),
    // Every action is idempotent by request key or by name; stop records its key too. A crash before the commit
    // leaves nothing to duplicate, and a crash after it is found in the registry on replay.
    replay: "safe",
    execute: async (args, api, ctx) => {
      const parent = api.conversationId;
      const now = Date.now();
      const requestKey = (suffix = "") => `${api.callId}:${suffix}`;

      if (args.action === "status") {
        const state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
        const names = args.name === undefined ? undefined : [args.name];
        const report = statusReport(state, names);
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
          ...(names?.length === 1 && state.agents[names[0]!]
            ? { details: { name: names[0]!, conversationId: state.agents[names[0]!]!.conversationId } }
            : {}),
        };
      }

      if (args.action === "results") {
        const state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
        return { content: [{ type: "text", text: JSON.stringify(resultsReport(state, args.names)) }] };
      }

      if (args.action === "wait") {
        const startedAt = Date.now();
        const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1000, args.timeoutMs ?? DEFAULT_WAIT_MS));
        let state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
        // Resolve names once, so a typo fails before the wait rather than after a timeout.
        const names = targets(state, args.names);
        for (;;) {
          state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
          // Drain only when something is queued; an idle wait must not commit every poll.
          if (queuedNames(state).length > 0) {
            await api.commit(async (tx) => {
              const current = await tx.doc(Subagents, parent);
              await startQueued(tx, current, parent, Date.now());
              return undefined;
            }, ctx);
            state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
          }
          const waiting = names.filter((name) => {
            const agent = state.agents[name];
            return agent !== undefined && paused(agent);
          });
          if (waiting.length === 0) {
            const report = resultsReport(state, names);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: report.results.every((r) => r.status === "done") ? "done" : "settled",
                    ...report,
                  }),
                },
              ],
            };
          }
          if (Date.now() - startedAt >= timeoutMs) {
            const report = resultsReport(state, names);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "waiting",
                    timedOut: true,
                    stillRunning: waiting,
                    ...report,
                  }),
                },
              ],
              isError: true,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      if (args.action === "stop") {
        if (!args.name) throw Error("stop needs a name");
        const state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
        const agent = state.agents[args.name];
        if (!agent) throw Error(`No subagent named ${args.name}.`);
        const key = requestKey(`stop:${args.name}`);
        if (findRequest(state, key)) {
          return {
            content: [{ type: "text", text: `Already stopped ${args.name}.` }],
            details: { name: args.name, conversationId: agent.conversationId },
          };
        }
        const child = await api.conversation(agent.conversationId as ConversationId, ctx);
        if (child) await child.abort(ctx);
        await api.commit(async (tx) => {
          const current = await tx.doc(Subagents, parent);
          const live = current.agents[args.name!];
          if (!live) return;
          stopAgent(current, args.name!, Date.now());
          rememberRequest(current, key, { name: args.name!, action: "stop" });
          await startQueued(tx, current, parent, Date.now());
        }, ctx);
        return {
          content: [{ type: "text", text: `Stopped ${args.name}. It stays usable; send it another message.` }],
          details: { name: args.name, conversationId: agent.conversationId },
        };
      }

      // spawn, fanout and send all commit registry state and, where the cap allows, reporter tasks together.
      const spawns =
        args.action === "fanout"
          ? (args.tasks ?? []).map((item) => ({ name: item.name.trim(), task: item.task.trim() }))
          : args.action === "spawn"
            ? [{ name: args.name?.trim() ?? "", task: args.task?.trim() ?? "" }]
            : [];
      if (args.action === "spawn" || args.action === "fanout") {
        if (spawns.length === 0) throw Error(`${args.action} needs ${args.action === "spawn" ? "a name and a task" : "tasks"}.`);
        for (const item of spawns) {
          if (!item.name || !item.task) throw Error(`${args.action} needs a name and a task for every child.`);
        }
        if (new Set(spawns.map((s) => s.name)).size !== spawns.length) throw Error("fanout names must be unique");
      }

      if (args.action === "send") {
        if (!args.name || !args.message?.trim()) throw Error("send needs a name and a message");
      }

      let started: string[] = [];
      const spawnedNow: string[] = [];
      const skipped: string[] = [];
      let duplicate = false;
      let childId: number | undefined;
      const lines: string[] = [];
      await api.commit(async (tx) => {
        const state = await tx.doc(Subagents, parent);
        if (args.concurrency !== undefined)
          state.limit = clampConcurrency(args.concurrency, state.limit || DEFAULT_SUBAGENTS_IN_FLIGHT);

        if (args.action === "send") {
          const name = args.name!;
          const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
          if (!agent) throw Error(`No subagent named ${name}. Use status to list them.`);
          const messageId = requestKey(name);
          duplicate = !addMessage(state, name, {
            messageId,
            text: args.message!.trim(),
            followUp: args.followUp === true,
            now,
          });
          childId = agent.conversationId;
        } else {
          for (const item of spawns) {
            const messageId = requestKey(item.name);
            if (findRequest(state, messageId)) {
              duplicate = true;
              childId ??= state.agents[item.name]?.conversationId;
              continue;
            }
            if (Object.hasOwn(state.agents, item.name)) {
              skipped.push(item.name);
              childId ??= state.agents[item.name]!.conversationId;
              continue;
            }
            const anchor = await tx.createTask(Anchor, null, {
              ownership: { kind: "conversation" },
              conversationId: parent,
              background: true,
            });
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
            await configure(tx, child.id, {
              tools: { remove: [subagentsTool, ...(options.hiddenTools ?? [])] as never },
              instructions: `You are the subagent "${item.name}". Answer the main agent's requests directly and concisely.`,
            });
            if (
              addSpawn(state, {
                name: item.name,
                conversationId: child.id as number,
                anchorTaskId: anchor as number,
                task: item.task,
                messageId,
                now,
              })
            )
              spawnedNow.push(item.name);
            childId ??= child.id as number;
          }
        }
        started = await startQueued(tx, state, parent, now);
      }, ctx);

      const state = (await api.snapshot(Subagents, parent, ctx)) ?? emptySubagents();
      if (args.action === "send") {
        const agent = state.agents[args.name!]!;
        lines.push(
          duplicate
            ? `Already sent that request to ${args.name}.`
            : `Sent to ${args.name} (${agent.status}). Its answer will come back once.`,
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ sent: !duplicate, ...agentReport(agent) }) }],
          details: { name: args.name!, conversationId: agent.conversationId },
        };
      }

      lines.push(
        `Spawned ${spawnedNow.join(", ") || "nothing"}. ` +
          `${started.length ? `Running now: ${[...new Set(started)].join(", ")}. ` : ""}` +
          `${queuedNames(state).length ? `Queued: ${queuedNames(state).join(", ")}. ` : ""}` +
          `Limit ${state.limit}. Use wait to join them.`,
      );
      if (skipped.length) lines.push(`Already existed (use send): ${skipped.join(", ")}.`);
      const details: Record<string, JsonValue> = {
        spawned: spawnedNow,
        running: [...new Set(started)],
        queued: queuedNames(state),
      };
      if (childId !== undefined) details.conversationId = childId;
      return {
        content: [{ type: "text", text: lines.join(" ") }],
        details,
      };
    },
  });

  return { tool: subagentsTool, tasks: [Anchor, Reporter] as [typeof Anchor, typeof Reporter] };
}

export type Subagents = ReturnType<typeof createSubagents>;
