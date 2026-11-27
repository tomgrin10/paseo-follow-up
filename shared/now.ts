import { z } from "zod";
import { prRowStatus, prReference } from "./pr-status";
import type { ListPr } from "./list";
import type { Batch, Obligation, Task } from "./model";
import type { Question } from "./questions";
import type { InboxRow } from "./inbox";

/**
 * What each agent is working on now, in one line Tom reads at a glance (phase 2, step 1): the work it is on toward the
 * workspace's goal ("Capping the retry gap · 2 of 4") and its state ("Working 6m", "Wants to run git push", "Idle 20m").
 * One pure function, `nowOf`, builds it for every surface (the panel, Home rows) and for agents (`workspace_now`), so
 * they never disagree. No tool, file, command or todo step is ever on the line, and nothing here is a model call or a
 * stream: it reads the workspace record and the agent facts the worker and the client already hold.
 *
 * The line has no name on screen (no label, no placeholder): nothing known means the state is the whole line. The
 * agent-facing field is `milestone` on sync_workspace; that word never reaches the UI.
 *
 * Where the work comes from, first that exists wins (invariant `the-line-takes-its-first-source`, NOW_SOURCES):
 * 1. `follow-up`: work Follow-up handed the agent this turn (a repair or a task batch it is still on).
 * 2. `stated`: what the agent stated with sync_workspace `milestone` (the only source with a place: "2 of 4").
 * 3. `task`: the task it is working on (status working, workingAgentId = it, its live state working).
 * 4. `pr`: its one open PR's status ("#77 · In review"), only when it owns exactly one.
 * 5. `title`: a contributor's Paseo title (the main agent's title is the workspace's, so never for it).
 * Nothing: no work line, never a guess.
 */

export const MILESTONE_TEXT_MAX = 80;
export const MILESTONE_LIST_MAX = 8;
const milestoneText = z.string().trim().min(1).max(MILESTONE_TEXT_MAX);
/** sync_workspace's optional field. Omitted keeps the last one; null clears it. */
export const milestoneInputSchema = z.strictObject({
  now: milestoneText,
  done: z.array(milestoneText).max(MILESTONE_LIST_MAX).optional(),
  next: z.array(milestoneText).max(MILESTONE_LIST_MAX).optional(),
}).nullable();
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;
/** Stored per agent on the workspace record (`milestones`), cleared at Done and when the agent leaves. */
export const storedMilestoneSchema = z.object({ now: milestoneText, done: z.array(milestoneText).max(MILESTONE_LIST_MAX), next: z.array(milestoneText).max(MILESTONE_LIST_MAX), at: z.string() });
export type StoredMilestone = z.infer<typeof storedMilestoneSchema>;

/** The order the work line's sources are tried in. Changing it changes what every surface says; it is an invariant. */
export const NOW_SOURCES = ["follow-up", "stated", "task", "pr", "title"] as const;
export type NowSource = typeof NOW_SOURCES[number];

export type NowRole = "main" | "contributor";
/**
 * What the worker (directory + inbox) or the client (inbox row) already knows about the agent. Every field is
 * optional past the id: unknown means "not known", never "off" (invariant 7).
 */
export type AgentFacts = {
  agentId: string;
  role: NowRole;
  /** Paseo's agent title (contributors' work line falls back to it). */
  title?: string | null;
  /** running covers initializing; closed means archived or gone. */
  status: "running" | "idle" | "closed" | "unknown";
  /** When the current turn started, while running. */
  turnStartedAt?: string | null;
  /** When it last did anything, for "Idle 20m". */
  lastActivityAt?: string | null;
  /** A pending permission's words ("git push --force"), when it waits on one. */
  permission?: string | null;
  /** Live background jobs (Paseo 0.16+). */
  backgroundWork?: number;
  /** It is compacting its context. */
  compacting?: boolean;
};

/** The parts of a workspace the line reads: the stored workspace and its list form both fit. */
export type NowWorkspace = {
  mainAgentId: string;
  /** The workspace project repository, from discovery; unknown keeps PR references qualified. */
  repo?: string | null;
  contributorAgentIds?: readonly string[];
  milestones?: Readonly<Record<string, StoredMilestone>>;
  batches: readonly (Pick<Batch, "state" | "recipientAgentId" | "sentAt" | "settledAt"> & { tasks: readonly Pick<Task, "kind" | "target" | "title">[] })[];
  obligations: readonly Pick<Obligation, "title" | "status" | "workingAgentId">[];
  taskAgents?: Readonly<Record<string, { title: string | null; state: "working" | "idle" | "closed" | "archived" }>>;
  prs: readonly ListPr[];
  questions?: readonly Pick<Question, "id" | "title" | "askedBy" | "mode" | "answer" | "closed">[];
  completion?: unknown;
};

export type NowWork = { text: string; source: NowSource; done: string[]; next: string[]; position: { at: number; of: number } | null };
export type NowStateKind = "working" | "permission" | "asking" | "compacting" | "background" | "waiting-ci" | "idle" | "closed" | "unknown";
export type NowState = { kind: NowStateKind; text: string; since: string | null };
/** One agent's line. `workspace_now` returns exactly this per agent. */
export type Now = {
  agentId: string; role: NowRole;
  work: NowWork | null;
  state: NowState;
  /** What it waits on that isn't the developer (CI on #412). */
  waitingOn: string | null;
  /** What it needs from the developer (a permission, an answer). */
  needs: string | null;
};

const prRef = (key: string, prs: NowWorkspace["prs"]) => { const pr = prs.find(p => p.key === key); return pr ? `#${pr.number}` : key.includes("#") ? `#${key.split("#").pop()}` : key; };
const VERB: Partial<Record<Task["kind"], string>> = { checks: "Fixing CI on", review: "Answering review on", conflict: "Resolving conflicts on", restack: "Restacking" };

/** Work Follow-up handed this agent and it hasn't settled: a sent batch addressed to it (the main agent's when unaddressed). */
function handedWork(w: NowWorkspace, agent: AgentFacts): string | null {
  if (agent.status !== "running") return null;
  const batch = [...w.batches].reverse().find(b => b.state === "sent" && !b.settledAt && (b.recipientAgentId ?? w.mainAgentId) === agent.agentId);
  if (!batch) return null;
  const tasks = batch.tasks.filter(t => t.kind !== "inventory");
  if (!tasks.length) return null;
  if (tasks.some(t => t.kind === "completion")) return "Checking the work is finished";
  if (tasks.length === 1 && tasks[0]!.kind === "obligation") return tasks[0]!.title;
  const prs = [...new Set(tasks.filter(t => t.kind !== "obligation").map(t => prRef(t.target, w.prs)))];
  const kinds = new Set(tasks.map(t => t.kind));
  if (prs.length === 1 && kinds.size === 1 && VERB[tasks[0]!.kind]) return `${VERB[tasks[0]!.kind]} ${prs[0]}`;
  if (prs.length === 1) return `Repairing ${prs[0]}`;
  if (prs.length > 1) return `Repairing ${prs.slice(0, -1).join(", ")} and ${prs.at(-1)}`;
  return `Working through ${tasks.length} tasks`;
}

const isOpenPr = (p: NowWorkspace["prs"][number]) => p.snapshot?.state === "OPEN";
/** The PRs this agent owns: the ones it registered, and, for the main agent, the ones nobody registered. */
function ownedPrs(w: NowWorkspace, agent: AgentFacts) {
  return w.prs.filter(p => p.registeredAgentId ? p.registeredAgentId === agent.agentId : agent.role === "main");
}

/** The work line: the first source that has one (NOW_SOURCES). Null when nothing is known; never invented. */
export function workOf(w: NowWorkspace, agent: AgentFacts): NowWork | null {
  const handed = handedWork(w, agent);
  if (handed) return { text: handed, source: "follow-up", done: [], next: [], position: null };
  const stated = w.milestones?.[agent.agentId];
  if (stated) {
    const listed = stated.done.length + stated.next.length > 0;
    return { text: stated.now, source: "stated", done: [...stated.done], next: [...stated.next], position: listed ? { at: stated.done.length + 1, of: stated.done.length + 1 + stated.next.length } : null };
  }
  const live = w.taskAgents?.[agent.agentId]?.state === "working" || (agent.status === "running" && !w.taskAgents?.[agent.agentId]);
  const task = live ? w.obligations.find(o => o.status === "working" && o.workingAgentId === agent.agentId) : undefined;
  if (task) return { text: task.title, source: "task", done: [], next: [], position: null };
  const open = ownedPrs(w, agent).filter(isOpenPr);
  if (open.length === 1) {
    const pr = open[0]!;
    const ref = prReference(pr, w.repo);
    const status = prRowStatus(pr);
    return { text: pr.snapshot?.complete ? `${ref} · ${status.label}` : `Shipping ${ref}`, source: "pr", done: [], next: [], position: null };
  }
  const title = agent.role === "contributor" ? (agent.title ?? w.taskAgents?.[agent.agentId]?.title ?? "").trim() : "";
  if (title) return { text: title, source: "title", done: [], next: [], position: null };
  return null;
}

/** "<1m", "6m", "1h 05m", "3d": how long since `at`. Its own copy, so the schema module imports nothing that imports model.ts. */
export function since(at: string | null | undefined, now: number): string | null {
  const ms = now - Date.parse(at ?? "");
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The state line: what is true about the agent now, the part the developer acts on. */
export function stateOf(w: NowWorkspace, agent: AgentFacts, now: number): { state: NowState; waitingOn: string | null; needs: string | null } {
  if (agent.permission) return { state: { kind: "permission", text: `Wants your OK · ${agent.permission}`, since: null }, waitingOn: null, needs: `Allow or deny: ${agent.permission}` };
  const asking = (w.questions ?? []).find(q => q.askedBy === agent.agentId && !q.answer && !q.closed && q.mode === "stop");
  if (asking) return { state: { kind: "asking", text: `Asking you: "${asking.title}"`, since: null }, waitingOn: null, needs: `Answer ${asking.id}` };
  if (agent.compacting) return { state: { kind: "compacting", text: "Compacting its context", since: null }, waitingOn: null, needs: null };
  if (agent.status === "running") {
    const took = since(agent.turnStartedAt, now);
    return { state: { kind: "working", text: took ? `Working ${took}` : "Working", since: agent.turnStartedAt ?? null }, waitingOn: null, needs: null };
  }
  if (agent.status === "closed") return { state: { kind: "closed", text: "Closed", since: null }, waitingOn: null, needs: null };
  if ((agent.backgroundWork ?? 0) > 0) return { state: { kind: "background", text: agent.backgroundWork === 1 ? "Its background job is running" : `${agent.backgroundWork} background jobs are running`, since: null }, waitingOn: null, needs: null };
  const ci = ownedPrs(w, agent).filter(p => isOpenPr(p) && p.snapshot?.checksPending);
  if (ci.length) {
    const on = ci.length === 1 ? `#${ci[0]!.number}` : `${ci.length} PRs`;
    return { state: { kind: "waiting-ci", text: `Waiting on CI for ${on}`, since: null }, waitingOn: `CI on ${on}`, needs: null };
  }
  if (agent.status === "unknown") return { state: { kind: "unknown", text: "", since: null }, waitingOn: null, needs: null };
  const idle = since(agent.lastActivityAt, now);
  return { state: { kind: "idle", text: idle ? `Idle ${idle}` : "Idle", since: agent.lastActivityAt ?? null }, waitingOn: null, needs: null };
}

/** One agent's line, for every surface and for workspace_now. Pure: same inputs, same line. */
export function nowOf(w: NowWorkspace, agent: AgentFacts, now: number): Now {
  const s = stateOf(w, agent, now);
  return { agentId: agent.agentId, role: agent.role, work: workOf(w, agent), state: s.state, waitingOn: s.waitingOn, needs: s.needs };
}

/** "2 of 4", the same words on every surface. Null without the agent's own list. */
export function positionText(work: NowWork | null): string | null {
  return work?.position ? `${work.position.at} of ${work.position.of}` : null;
}

/**
 * The line as plain text, for places that draw one string (an accessibility label, a Home row): the work, its place,
 * then the state. Nothing known: the state alone. Never a label or placeholder for the work.
 */
export function nowText(n: Now, short = false): string {
  const pos = positionText(n.work);
  const head = n.work ? [n.work.text, pos].filter(Boolean).join(" ") : null;
  const state = n.state.text ? short ? n.state.text.charAt(0).toLowerCase() + n.state.text.slice(1) : n.state.text : null;
  return [head, state].filter(Boolean).join(" · ");
}

/** The workspace's agents in the order surfaces list them: the main agent, then its contributors. */
export function workspaceAgents(w: Pick<NowWorkspace, "mainAgentId" | "contributorAgentIds">): { agentId: string; role: NowRole }[] {
  return [{ agentId: w.mainAgentId, role: "main" as const }, ...(w.contributorAgentIds ?? []).filter(id => id !== w.mainAgentId).map(agentId => ({ agentId, role: "contributor" as const }))];
}

/** The inbox row's fields the line reads: the worker's rows and the client's copy of them are the same. */
export type NowRow = Pick<InboxRow, "agentId" | "title" | "status" | "turnStartedAt" | "lastActivityAt" | "needs" | "backgroundWork">;
const RUNNING = new Set(["running", "initializing"]);
const CLOSED = new Set(["closed", "archived"]);

/**
 * An agent's facts from its inbox row (status, turn start, a pending permission, background jobs) and the workspace
 * record (compacting, a task agent's live state). The worker and every client call this with the same row, so the
 * agent tool and the screen read one line. No row: the task agents' state, else unknown.
 */
export function agentFacts(w: Pick<NowWorkspace, "taskAgents"> & { mainBusy?: string | null }, agentId: string, role: NowRole, row: NowRow | undefined): AgentFacts {
  const task = w.taskAgents?.[agentId];
  const status: AgentFacts["status"] = row ? RUNNING.has(row.status) ? "running" : CLOSED.has(row.status) ? "closed" : "idle"
    : task ? task.state === "working" ? "running" : task.state === "idle" ? "idle" : "closed" : "unknown";
  const permission = row?.needs?.reasons.find(r => r.reason === "permission")?.detail ?? null;
  return {
    agentId, role, status, title: row?.title ?? task?.title ?? null,
    turnStartedAt: status === "running" ? row?.turnStartedAt ?? null : null,
    lastActivityAt: row?.lastActivityAt ?? null,
    permission, backgroundWork: row?.backgroundWork ?? 0,
    compacting: role === "main" && w.mainBusy === "compacting",
  };
}

/** Every agent's line in a workspace, main agent first: what the panel draws and what workspace_now returns. */
export function workspaceNow(w: NowWorkspace & { mainBusy?: string | null }, rows: readonly NowRow[], now: number): Now[] {
  const byId = new Map(rows.map(r => [r.agentId, r]));
  return workspaceAgents(w).map(({ agentId, role }) => nowOf(w, agentFacts(w, agentId, role, byId.get(agentId)), now));
}
