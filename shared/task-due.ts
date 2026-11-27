import { finishedTask } from "./finished";
import type { Obligation, Workspace } from "./model";
import type { ListObligation, ListWorkspace } from "./list";
import { deployState } from "./follow-up";
import { blockedOnDeveloper, waitsOnDeveloper } from "./questions";
import { pendingAt } from "./task-trigger";

// ---------- due by fact (invariant due-by-fact) ----------
//
// 2026-11-22, live: 104 open tasks; half unchanged for over 5 days. 35 had every PR merged (22 deployed): post-deploy
// checks that came due and never ran. The tool text said tasks are manual unless the developer asked for timing, so
// almost none had a trigger, and listing a task in workspace_status didn't get it handled. Now every open task knows
// what moves it: its PRs reaching their stage, or a re-check date. A due task is a nudge to its owner at its turn's
// end (the agent hook), never an auto-send and never an automatic done.

const DAY = 86_400_000;
/** A task with no PRs comes due this long after the agent last updated it, unless the agent set its own re-check. */
export const RECHECK_DAYS = 3;
/** Finished tasks leave storage this long after they finished. */
export const PRUNE_FINISHED_DAYS = 30;
/** The agent hears about one due fact at most this many times; then the task is stale. */
export const NUDGE_CAP = 2;
/** At most this many due tasks per turn end, oldest first. */
export const NUDGES_PER_TURN = 3;
/** And at most once a day per task. */
export const NUDGE_GAP_MS = DAY;

export type TaskDue = {
  /** What makes it due, stable while that fact holds: a new key starts the nudge count again. */
  key: string;
  /** The fact in a few words: "#231 merged", "#232 closed unmerged", "re-check 2026-11-25". */
  fact: string;
  /** When it is (or was) due; null while it waits on a PR. */
  dueAt: string | null;
  due: boolean;
  /** The developer's one line: what moves it. */
  label: string;
};

const ref = (w: Pick<ListWorkspace, "prs">, key: string) => { const p = w.prs.find(p => p.key === key); return p ? `#${p.number}` : key; };
const refs = (w: Pick<ListWorkspace, "prs">, keys: readonly string[]) => keys.map(k => ref(w, k)).join(", ");
const time = (v?: string | null) => v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
/** "2026-11-25": the day, as the agent writes recheck. */
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "Nov 25": the day, as the developer reads it. */
// Built by hand, not toLocaleDateString: the worker formats every open task's label on each scopes.json write.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (ms: number, now: number) => { const d = new Date(ms), y = d.getUTCFullYear(); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${y !== new Date(now).getUTCFullYear() ? `, ${y}` : ""}`; };

type Questions = Pick<ListWorkspace, "questions">["questions"];

/**
 * Whether due-by-fact applies: open, not still the developer's move (Needs you has it), not on a developer-timed
 * auto-send. A task blocked on a question the developer already answered or closed is the agent's again
 * (waitsOnDeveloper, one-decision-one-card), so it applies.
 */
export function dueApplies(o: Pick<Obligation, "status" | "ask" | "coveredBy" | "enable_follow_up" | "trigger">, questions: Questions): boolean {
  if (finishedTask(o)) return false;
  if (waitsOnDeveloper(o, questions)) return false;
  // An at trigger that went out (or couldn't) hands the task back to due by fact: the agent heard, and its re-check stands.
  return !(o.enable_follow_up && o.trigger) || o.trigger.event === "at" && !pendingAt(o.trigger);
}

/**
 * What moves an open task, and whether it is due now. Null when due-by-fact doesn't apply (finished, blocked on the
 * developer, a developer-timed trigger) or the task has no PRs and no re-check date yet (maintenance stamps one).
 * - With afterPrs: due when every PR reached `dependencyStage` (merged, or deployed; a repository with no deploy
 *   target counts its merge), or when one closed unmerged. A later `recheckAt` holds it until then.
 * - Without: due on `recheckAt`.
 */
export function taskDue(o: ListObligation, w: Pick<ListWorkspace, "prs" | "questions">, now: number): TaskDue | null {
  const questions = w.questions ?? [];
  if (!dueApplies(o, questions)) return null;
  const recheck = time(o.recheckAt);
  const at = (factAt: number | null, key: string, fact: string): TaskDue => {
    const dueMs = Math.max(factAt ?? 0, recheck ?? 0);
    const due = dueMs <= now;
    const held = recheck !== null && recheck > (factAt ?? 0);
    return { key: `${key}${held ? `:${o.recheckAt}` : ""}`, fact, dueAt: new Date(dueMs).toISOString(), due, label: due ? `Due · ${fact}` : `${fact[0].toUpperCase()}${fact.slice(1)} · re-check ${shortDay(dueMs, now)}` };
  };
  // Blocked on a question the developer answered or closed: that is the fact, whatever the PRs say. The agent acts on
  // the answer and moves the task (a task waiting on the developer gets no default re-check: server/obligations.ts).
  if (blockedOnDeveloper(o)) {
    const q = questions.find(q => q.id === o.coveredBy)!;
    return at(time(q.answer?.at ?? q.closed?.at), `question:${q.id}`, `${q.id} ${q.answer ? "answered" : "closed"}`);
  }
  if (!o.afterPrs.length) {
    if (recheck === null) return null;
    const due = recheck <= now;
    return { key: `recheck:${o.recheckAt}`, fact: `re-check ${isoDay(recheck)}`, dueAt: new Date(recheck).toISOString(), due, label: due ? `Due since ${shortDay(recheck, now)}` : `Re-check ${shortDay(recheck, now)}` };
  }
  const prs = o.afterPrs.map(key => w.prs.find(p => p.key === key));
  const stage = o.dependencyStage ?? "deployed";
  const waiting = { key: "", fact: "", dueAt: null, due: false, label: `After ${refs(w, o.afterPrs)} ${stage === "merged" ? "merge" : "deploy"}${o.afterPrs.length === 1 ? "s" : ""}` };
  if (prs.some(p => !p?.snapshot?.complete)) return waiting;
  const closed = prs.find(p => p!.snapshot!.state === "CLOSED");
  if (closed) return at(null, `closed:${o.afterPrs.join(",")}`, `#${closed.number} closed unmerged`);
  if (prs.some(p => p!.snapshot!.state !== "MERGED")) return waiting;
  const merged = Math.max(...prs.map(p => time(p!.snapshot!.mergedAt) ?? 0));
  if (stage === "merged") return at(merged || null, `merged:${o.afterPrs.join(",")}`, `${refs(w, o.afterPrs)} merged`);
  const states = prs.map(p => deployState(p!, now));
  if (states.some(s => s === "not-deployed" || s === "unconfirmed")) return waiting;
  // No deploy target for a repository: its merge is the last fact Follow-up can see.
  if (states.every(s => s === "none")) return at(merged || null, `merged:${o.afterPrs.join(",")}`, `${refs(w, o.afterPrs)} merged (no deploy check)`);
  const deployedAt = Math.max(...prs.map(p => time(p!.deploymentAnchor?.at) ?? time(p!.snapshot!.mergedAt) ?? 0));
  return at(deployedAt || null, `deployed:${o.afterPrs.join(",")}`, `${refs(w, o.afterPrs)} deployed`);
}

/** Due, and the agent was told twice about this very fact with no change to the task since. */
export function isStale(o: Pick<Obligation, "nudged" | "revision">, d: TaskDue | null): boolean {
  return !!d?.due && !!o.nudged && o.nudged.key === d.key && o.nudged.revision === o.revision && o.nudged.count >= NUDGE_CAP;
}

/**
 * The task row's one line for the developer: "Due · #231 merged", "Due since Nov 22", "After #232 merges", "Re-check
 * Nov 25", "Stale · …". "Re-check" is only ever a date ahead; a passed one says Due since, with the year when it isn't
 * this one.
 */
export function dueLabel(o: ListObligation, w: Pick<ListWorkspace, "prs" | "questions">, now: number): string | null {
  const d = taskDue(o, w, now);
  if (!d) return null;
  return isStale(o, d) ? staleLabel(d) : d.label;
}

/**
 * A stale task's line, in the developer's words: what came due, as the Due line says it ("Stale · #231 merged · …",
 * "Stale · due since Jan 1 · …"), never the agent's "re-check 2026-01-01".
 */
export const staleLabel = (d: TaskDue) => `Stale · ${d.label.replace(/^Due · /, "").replace(/^Due since /, "due since ")} · nudged twice, no answer`;

/** A title of at most 60 characters, cut at a word. */
const short = (title: string) => title.length <= 60 ? title : `${title.slice(0, 59).replace(/\s+\S*$/, "")}…`;

/** One nudge line for the agent (about 20 tokens plus the id). */
export function nudgeLine(o: Pick<Obligation, "id" | "title" | "afterPrs">, d: TaskDue): string {
  const act = d.key.startsWith("question:") ? "Act on it and close the task with evidence" : o.afterPrs.length ? "Do it and close it with evidence" : "Close it with evidence if it's done";
  return `Task ${o.id} "${short(o.title)}": ${d.fact}. ${act}, or keep it with recheck="YYYY-MM-DD" and why.`;
}

export type DueEntry = { id: string; key: string; revision: number; dueAt: string; line: string };
/** Due entries per agent for scopes.json: each task goes to the agent working on it (a contributor) and the main agent. */
export function dueByAgent(w: Workspace, now: number, limit = 5): Record<string, DueEntry[]> {
  const out: Record<string, DueEntry[]> = {};
  for (const o of w.obligations) {
    const d = taskDue(o, w, now);
    if (!d?.dueAt || isStale(o, d)) continue;
    const entry = { id: o.id, key: d.key, revision: o.revision, dueAt: d.dueAt, line: nudgeLine(o, d) };
    const owners = new Set([w.mainAgentId, ...(o.workingAgentId && w.contributorAgentIds?.includes(o.workingAgentId) ? [o.workingAgentId] : [])]);
    for (const a of owners) (out[a] ??= []).push(entry);
  }
  for (const a of Object.keys(out)) out[a] = out[a].sort((x, y) => x.dueAt.localeCompare(y.dueAt)).slice(0, limit);
  return out;
}

export type NudgeReceipt = Record<string, { key: string; revision: number; count: number; at: string }>;

/**
 * The pick at a turn end: due entries (dueAt passed) not nudged NUDGE_CAP times for this fact and revision, and not
 * within a day, oldest first, at most NUDGES_PER_TURN. One implementation for the Stop hook and the turn-end event
 * (shared/turn-checks.mjs, which the build inlines into the hook); tests/due-by-fact.test.ts holds it to these bounds.
 */
export { pickNudges } from "./turn-checks.mjs";

/**
 * The worker's periodic pass over one workspace, a check first (`apply` false) and then the change:
 * - an open task with no PRs and no re-check date gets one RECHECK_DAYS out (tasks from before due-by-fact), unless
 *   it is blocked on the developer: the answer moves that one;
 * - a finished task without `finishedAt` gets now;
 * - the hook's receipt becomes each task's `nudged`;
 * - finished tasks over PRUNE_FINISHED_DAYS old leave storage, unless something still reads them (pruneBlocked).
 * Returns whether anything changed (or would).
 */
export function maintainTasks(w: Workspace, now: number, receipt: NudgeReceipt | null, apply: boolean): boolean {
  let changed = false;
  const stamp = new Date(now).toISOString();
  for (const o of w.obligations) {
    const finished = finishedTask(o);
    if (!finished && !o.afterPrs.length && !o.recheckAt && !blockedOnDeveloper(o)) { changed = true; if (apply) o.recheckAt = new Date(now + RECHECK_DAYS * DAY).toISOString(); }
    if (finished && !o.finishedAt) { changed = true; if (apply) o.finishedAt = stamp; }
    const r = receipt?.[o.id];
    if (r && (o.nudged?.key !== r.key || o.nudged.count !== r.count || o.nudged.at !== r.at || o.nudged.revision !== r.revision)) { changed = true; if (apply) o.nudged = { ...r }; }
  }
  const prune = w.obligations.filter(o => finishedTask(o) && o.finishedAt && now - Date.parse(o.finishedAt) > PRUNE_FINISHED_DAYS * DAY && !pruneBlocked(w, o.id));
  if (prune.length) { changed = true; if (apply) { const gone = new Set(prune.map(o => o.id)); w.obligations = w.obligations.filter(o => !gone.has(o.id)); } }
  return changed;
}

/**
 * A finished task still read by something, so it stays (checked in the 30-day prune's PR):
 * - every task is finished and the workspace isn't declared done: the completion batch's fingerprint lists every task
 *   (server/tasks.ts), so removing one would make a new completion message;
 * - an unsettled batch carries it (the engine checks its target on acknowledge);
 * - an open question names it.
 * Batches and Activity keep their own copy of a task's title, so history reads without it.
 */
export function pruneBlocked(w: Workspace, id: string): boolean {
  if (!w.completion && !w.declaration && w.obligations.every(o => finishedTask(o))) return true;
  if (w.batches.some(b => !b.settledAt && b.tasks.some(t => t.target === id))) return true;
  return (w.questions ?? []).some(q => q.taskId === id && !q.answer && !q.closed);
}
