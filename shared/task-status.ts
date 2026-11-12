import type { Obligation, Workspace } from "./model";
import { taskSchedule } from "./task-trigger";

/**
 * A task's status line, shared by the task row and the Task sheet (invariant `a-task-only-says-working-when-its-agent-is`).
 *
 * A task's stored status=working is only what an agent last wrote; it isn't anyone's live state, and it can sit there
 * for days. So "working" is never read off the record: the line names the agent the task records (`workingAgentId`,
 * set by update_obligation) and says what that agent is doing now, from Paseo's agent directory (metadata only, so
 * reading it wakes nothing). Without a recorded agent, or before the live state is known, it says "In progress".
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

export function taskStatus(o: Obligation, w: Workspace, agents: TaskAgents = {}, now = Date.now()): TaskStatus {
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
