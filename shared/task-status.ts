import type { Obligation, Workspace } from "./model";
import { taskSchedule } from "./task-trigger";
import { isLive } from "./agent-load";

/**
 * A task's status line, shared by the task row and the Task sheet (invariant `a-task-only-says-working-when-its-agent-is`).
 *
 * A task's stored status=working is only what an agent last wrote; it isn't anyone's live state, and it can sit there
 * for days. So "working" is never read off the record: the line names the agent the task records (`workingAgentId`,
 * set by update_obligation) and says what that agent is doing now, from Paseo's agent directory (metadata only, so
 * reading it wakes nothing). Without a recorded agent it says "In progress"; with one whose live state isn't known,
 * "Agent unavailable" (words only, no live state).
 * The engine stores those live states on the workspace (`taskAgents`) with runtimeBusy, so the task row, the Task
 * sheet, the panel's live line, the summary ("Agent handling") and Home all read one source.
 */
export type TaskAgentState = "working" | "idle" | "closed" | "archived";
export type TaskAgentLive = { title: string | null; state: TaskAgentState };
/** Live state of the agents tasks name, by agent id. Missing: unknown (not read yet, or Paseo doesn't list it). */
export type TaskAgents = Readonly<Record<string, TaskAgentLive>>;

export type TaskStatus = {
  text: string;
  /** Which glyph: a spinner only for a live working agent. */
  tone: "done" | "waived" | "question" | "blocked" | "working" | "idle" | "closed" | "archived" | "unknown" | "progress" | "scheduled" | "ready";
  /** The agent the line names and can open: working, idle or closed (the developer's tap opens it); never an archived one. */
  agentId: string | null;
  /** What the link to that agent says ("Open agent", or "Open chat" for a closed one), from PRESENCE. */
  link?: string | null;
};

export const finishedTask = (o: Obligation) => o.status === "done" || o.status === "waived";

/** The question a blocked task became, if the server has mirrored it. */
export const linkedQuestion = (o: Obligation, w: Workspace) => o.status === "blocked" ? [...(w.questions ?? [])].reverse().find(q => q.taskId === o.id && q.taskRevision !== null) ?? null : null;

const name = (live: TaskAgentLive) => live.title?.trim() || "Agent";

/**
 * The one word and link rule for an agent's live state, shared by task lines and the chat's created-agent card
 * (shared/created.ts), so "working / idle / closed / archived" can't drift between them.
 *
 * Paseo reads an agent "closed" whenever its session ends: the idle unload (about an hour) and every plugin reload. It
 * is still the developer's agent, so it keeps its link ("Open chat"): opening it is the developer's own click, like
 * Paseo's sidebar. Invariant 1 is about Follow-up loading agents by itself, so nothing here reads, prefetches or
 * previews a closed agent; the only load is that tap. An archived agent is words only.
 */
export const PRESENCE: Readonly<Record<TaskAgentState, { word: string; opens: boolean; link: string | null }>> = {
  working: { word: "working", opens: true, link: "Open agent" },
  idle: { word: "idle", opens: true, link: "Open agent" },
  closed: { word: "closed", opens: true, link: "Open chat" },
  archived: { word: "archived", opens: false, link: null },
};

/** What a task line says when its recorded agent's live state isn't known. */
export const UNKNOWN_AGENT = "Agent unavailable";

/** The live part alone, for a task whose stored status is working. */
export function workingLine(o: Obligation, agents: TaskAgents): TaskStatus {
  const id = o.workingAgentId;
  const live = id ? agents[id] : undefined;
  if (!id) return { text: "In progress", tone: "progress", agentId: null };
  // A recorded agent the directory doesn't know (not read yet, or Paseo doesn't list it): words only, no live state and
  // no link. Never "In progress", which reads as if someone were on it.
  if (!live) return { text: UNKNOWN_AGENT, tone: "unknown", agentId: null, link: null };
  // Named the same way in every state; only an archived agent is words only (PRESENCE[state].opens).
  const p = PRESENCE[live.state];
  return { text: `${name(live)} ${p.word}`, tone: live.state, agentId: p.opens ? id : null, link: p.link };
}

/** `agents` defaults to the live states the engine stores on the workspace (`w.taskAgents`), the same ones the live line,
 * the summary and Home read. */
export function taskStatus(o: Obligation, w: Workspace, agents: TaskAgents = w.taskAgents ?? {}, now = Date.now()): TaskStatus {
  if (finishedTask(o)) return { text: o.status === "done" ? "Done" : "Waived", tone: o.status === "done" ? "done" : "waived", agentId: null };
  const q = linkedQuestion(o, w);
  if (q) return { text: q.answer ? `${q.id} · answered, waiting on the agent` : `${q.id} · waiting on your answer`, tone: "question", agentId: null };
  if (o.status === "blocked") return { text: "Needs a decision", tone: "blocked", agentId: null };
  if (o.status === "working") return workingLine(o, agents);
  const schedule = taskSchedule(o, w, now);
  return schedule.ready ? { text: "Ready to send", tone: "ready", agentId: null } : { text: schedule.label, tone: "scheduled", agentId: null };
}

/** True when a line claims an agent is working: the words the invariant guards. */
export const claimsWorking = (text: string) => /\bworking\b/i.test(text);

/**
 * The live state of the agents tasks name, from Paseo's agent list (metadata only: reading it never loads an agent).
 * Mid-turn, starting or with live background work is working; archived is archived; a session Paseo closed is closed;
 * anything else is idle. An agent the directory doesn't list is left out (unknown: words only), and a directory that
 * couldn't be read (null) says nothing, so every line with a recorded agent reads "Agent unavailable".
 */
export function taskAgentStates(ids: readonly string[], agents: readonly { id: string; status: string; title?: string | null; archivedAt?: string | null; backgroundWork?: { count?: unknown } | null }[] | null): Record<string, TaskAgentLive> {
  if (!agents) return {};
  const byId = new Map(agents.map(a => [a.id, a]));
  return Object.fromEntries(ids.flatMap(id => {
    const a = byId.get(id);
    if (!a) return [];
    const state: TaskAgentLive["state"] = a.archivedAt ? "archived" : a.status === "closed" ? "closed" : isLive(a) ? "working" : "idle";
    return [[id, { title: a.title ?? null, state }]];
  }));
}
