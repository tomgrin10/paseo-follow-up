import type { Obligation, Workspace } from "./model";
import { taskSchedule } from "./task-trigger";
import { isLive } from "./agent-load";

/**
 * A task's status line, shared by the task row and the Task sheet (invariant `a-task-only-says-working-when-its-agent-is`).
 *
 * A task's stored status=working is only what an agent last wrote; it isn't anyone's live state, and it can sit there
 * for days. So "working" is never read off the record: the line names the agent the task records (`workingAgentId`,
 * set by update_obligation) and says what that agent is doing now, from Paseo's agent directory (metadata only, so
 * reading it wakes nothing). Without a recorded agent, or before the live state is known, it says "In progress".
 * The engine stores those live states on the workspace (`taskAgents`) with runtimeBusy, so the task row, the Task
 * sheet, the panel's live line, the summary ("Agent handling") and Home all read one source.
 */
export type TaskAgentState = "working" | "idle" | "closed";
export type TaskAgentLive = { title: string | null; state: TaskAgentState };
/** Live state of the agents tasks name, by agent id. Missing: unknown (not read yet, or Paseo doesn't list it). */
export type TaskAgents = Readonly<Record<string, TaskAgentLive>>;

export type TaskStatus = {
  text: string;
  /** Which glyph: a spinner only for a live working agent. */
  tone: "done" | "waived" | "question" | "blocked" | "working" | "idle" | "closed" | "progress" | "scheduled" | "ready";
  /** The agent the line names and can open: only one that's still open (working or idle). Never a closed one. */
  agentId: string | null;
};

export const finishedTask = (o: Obligation) => o.status === "done" || o.status === "waived";

/** The question a blocked task became, if the server has mirrored it. */
export const linkedQuestion = (o: Obligation, w: Workspace) => o.status === "blocked" ? [...(w.questions ?? [])].reverse().find(q => q.taskId === o.id && q.taskRevision !== null) ?? null : null;

const name = (live: TaskAgentLive) => live.title?.trim() || "Agent";

/** The live part alone, for a task whose stored status is working. */
export function workingLine(o: Obligation, agents: TaskAgents): TaskStatus {
  const id = o.workingAgentId;
  const live = id ? agents[id] : undefined;
  if (!id || !live) return { text: "In progress", tone: "progress", agentId: null };
  if (live.state === "working") return { text: `${name(live)} working`, tone: "working", agentId: id };
  if (live.state === "idle") return { text: `${name(live)} idle`, tone: "idle", agentId: id };
  // Named like the open ones; words only, never a link (opening a closed agent would load it).
  return { text: live.title?.trim() ? `${live.title.trim()} closed` : "Agent closed", tone: "closed", agentId: null };
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
 * Mid-turn, starting or with live background work is working; archived, closed or no longer listed is closed;
 * anything else is idle. A directory that couldn't be read (null) says nothing, so every line reads "In progress".
 */
export function taskAgentStates(ids: readonly string[], agents: readonly { id: string; status: string; title?: string | null; archivedAt?: string | null; backgroundWork?: { count?: unknown } | null }[] | null): Record<string, TaskAgentLive> {
  if (!agents) return {};
  const byId = new Map(agents.map(a => [a.id, a]));
  return Object.fromEntries(ids.map(id => {
    const a = byId.get(id);
    const state: TaskAgentLive["state"] = !a || a.archivedAt || a.status === "closed" ? "closed" : isLive(a) ? "working" : "idle";
    return [id, { title: a?.title ?? null, state }];
  }));
}
