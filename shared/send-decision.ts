import type { Task, Batch as StoredBatch } from "./model";
import type { ListBatch as Batch, ListWorkspace as Workspace } from "./list";
import { recoveryBatch } from "./follow-up";

/** How long a new batch waits before it goes out on its own, so tasks that land together go in one message. */
export const SETTLE_MS = 60_000;

/** States of a non-recovery batch that hold the queue: one message at a time per workspace. */
export const OPEN_BATCH_STATES: readonly Batch["state"][] = ["sending", "sent", "blocked", "uncertain"];
/**
 * The batch holds the workspace's queue (one message at a time): it is going out, out, or stuck, and nothing it was
 * about has moved on since (Batch.movedOn). A batch whose review changed, went away, or was sent again never holds the
 * next message (invariant a-changed-review-updates-never-cancels).
 */
export const holdsQueue = (b: Pick<Batch, "state" | "movedOn">) => OPEN_BATCH_STATES.includes(b.state) && !b.movedOn;

/** The batch has tasks that only make sense against a clean read of the workspace's PRs. */
export function needsPrObservations(w: Pick<Workspace, "obligations">, batch: Pick<Batch, "tasks">): boolean {
  return batch.tasks.some(t => {
    if (["inventory", "completion"].includes(t.kind)) return false;
    const o = t.kind === "obligation" && w.obligations.find(o => o.id === t.target);
    return !o || !o.communication || o.afterPrs.length > 0;
  });
}

export type SendDecision = {
  /** The engine sends the queued batch on this refresh exactly when this is true. */
  send: boolean;
  /** Who has to move next: you (send, resume, talk to the agent), the agent's own turn, or Follow-up. Null: nobody, it goes out on its own. */
  waitingOn: "you" | "agent" | "follow-up" | null;
  /** Why, in the words every surface shows: what it waits for and, where it isn't obvious, why. */
  reason: string;
  /** When it goes out on its own, if Follow-up knows (ISO). Null: it waits on something with no clock. */
  eta: string | null;
  /** The developer's Send now would go through (follow.send): nothing the server refuses stands in the way. */
  canSendNow: boolean;
};

/**
 * Past the active window (Settings → Following → Advanced, `activeWindowDays`): the developer hasn't messaged the main agent in that
 * long, so a repair waits for their Send (Q177). Loaded or not never decides this: that is Paseo's detail.
 */
export const STALE_REASON = "you haven't messaged this agent lately, so it waits for you";
/** Invariant 133: as many Follow-up-started turns as the limit already run; it goes, oldest first, as one ends. */
export const LIMIT_REASON = "waits until another workspace's repair finishes";
/** The most Follow-up-started turns running at once, machine-wide (Settings → Following → Advanced, `maxAutoSends`). */
export const DEFAULT_MAX_AUTO_SENDS = 2;
export const MAX_AUTO_SENDS_RANGE = { min: 1, max: 10 } as const;
/** After a send, how long the turn counts before Paseo has reported it running (the next refresh reads mainBusy). */
export const TURN_START_MS = 30_000;
/**
 * Invariant 133: an Auto-send's turn is running. It took a turn when it was dispatched (`Batch.automatic`) and holds it
 * only while Follow-up itself is moving it or the main agent works on it:
 * - not out yet (pending, sending, uncertain): only while Follow-up's queue still has it in flight (`inFlight`: queued,
 *   sending, or uncertain while it reconciles the chat). A batch that waits on the developer (a failed send's "check the
 *   agent's chat, then retry", a refusal, a hold) is the developer's, never a turn: two of them would otherwise stop
 *   Auto-send everywhere at the default limit;
 * - out (sent): until the batch is acknowledged (it leaves `sent`) or the main agent's turn ends (no main-agent wait,
 *   past TURN_START_MS since the send's last activity).
 * The developer's Send, a ride-along and the messages an agent asked for (time triggers, wait_for_checks) never set
 * `automatic`, so they never count.
 */
export type InFlight = (w: Pick<Workspace, "id">, b: Pick<Batch, "id" | "state">) => boolean;
export function autoTurnRunning(w: Pick<Workspace, "id" | "mainBusy" | "runtimeBusy" | "backgroundBusy" | "enable_tracking" | "archived" | "dormant">, b: Pick<Batch, "id" | "automatic" | "state" | "sentAt" | "activityAt">, now: number, inFlight: InFlight): boolean {
  if (!b.automatic || !w.enable_tracking || w.archived || w.dormant) return false;
  if (["pending", "sending", "uncertain"].includes(b.state)) return inFlight(w, b);
  if (b.state !== "sent") return false;
  if (mainWait(w)) return true;
  const at = Date.parse(b.activityAt ?? b.sentAt ?? "");
  return Number.isFinite(at) && now - at < TURN_START_MS;
}
/** Invariant 133: Auto-send turns running now, across every workspace. */
export const runningAutoTurns = (ws: readonly Workspace[], now: number, inFlight: InFlight) =>
  ws.reduce((n, w) => n + w.batches.filter(b => !recoveryBatch(b) && autoTurnRunning(w, b, now, inFlight)).length, 0);
const iso = (ms: number) => new Date(ms).toISOString();
/** The reason the settle gives: why "in a minute" and not now (Tom, 2026-11-12: "sending in a moment? why not now?"). */
export const SETTLE_REASON = "waits a minute so new changes join the same message";

/**
 * Why a repair waits on the main agent itself, said the same on every surface and in the queue (Q96 = A). Only the
 * main agent's own work holds a repair: never another agent in the workspace, never a subagent.
 */
export const MAIN_WAIT = {
  turn: "sends when the main agent's turn ends, so it isn't interrupted",
  jobs: "sends when the main agent's background job ends (Wait for background jobs is on)",
  permission: "sends once the main agent's permission prompt is answered",
  guard: "sends when Session Guard resumes the main agent",
  compacting: "sends when Smart Session finishes compacting the main agent",
} as const;
export type MainWait = keyof typeof MAIN_WAIT;
/** Auto-send is off for the workspace: the repair waits for the developer's Send. */
export const AUTO_OFF_REASON = "Auto-send is off here, so it waits for your Send";
/**
 * The main agent's own wait. A record no refresh has read yet (`mainBusy` absent) counts the workspace's busy as the
 * main agent's: unknown is not off.
 */
export const mainWait = (w: Pick<Workspace, "mainBusy" | "runtimeBusy" | "backgroundBusy">): MainWait | null =>
  repairWait({ busy: w.runtimeBusy, backgroundBusy: w.backgroundBusy, mainBusy: w.mainBusy });

/**
 * What holds a repair: the main agent's own wait (Runtime.mainBusy, Q96 = A). A gateway that doesn't say (undefined)
 * counts the workspace's busy as the main agent's: unknown is not off.
 */
export function repairWait(runtime: { busy: boolean; backgroundBusy?: boolean; mainBusy?: MainWait | null }): MainWait | null {
  if (runtime.mainBusy !== undefined) return runtime.mainBusy;
  return runtime.busy ? "turn" : runtime.backgroundBusy ? "jobs" : null;
}
/** The Done check reads whether all work is finished, so it alone still waits for every agent in the workspace. */
export const QUIET_WAIT = "waits until every agent in the workspace is done, so the check sees finished work";

/**
 * The one auto-send rule (status invariant the-send-line-matches-the-send-decision). The worker's refresh sends the
 * queued batch when, and only when, `send` is true; the batch line on every surface (shared/status.ts) and the Tasks
 * strip (shared/task-rows.ts) show `reason`. It reads only what the refresh persisted (runtime state, sendWait, PR
 * reads, the last refusal), so the line and the send can't disagree. `batch`: the queued non-recovery batch; defaults
 * to the workspace's.
 */
export function sendDecision(w: Workspace, now: number, o: { settleMs?: number; batch?: Batch } = {}): SendDecision {
  const settleMs = o.settleMs ?? SETTLE_MS;
  const b = o.batch ?? w.batches.find(b => b.state === "pending" && !recoveryBatch(b));
  // What the developer's own Send (Engine.sendPending/dispatch) refuses, checked in the same order.
  const prUnread = b && needsPrObservations(w, b) ? w.prs.find(p => p.error || !p.snapshot?.complete) : undefined;
  const openBatch = !!b && w.batches.some(x => x.id !== b.id && !recoveryBatch(x) && holdsQueue(x));
  // The developer's Send is taken while the main agent is busy: it goes the moment the main agent is free (Q96).
  const canSendNow = !!b && b.state === "pending" && !recoveryBatch(b) && !w.archived && w.enable_tracking && !w.hold && !w.goneAgent &&
    (!w.runtimeReason || !!mainWait(w)) && !openBatch && !prUnread;
  const wait = (waitingOn: SendDecision["waitingOn"], reason: string, eta: string | null = null): SendDecision => ({ send: false, waitingOn, reason, eta, canSendNow });
  if (!b || b.state !== "pending" || recoveryBatch(b)) return wait(null, "nothing queued");
  if (w.archived) return wait("you", "the workspace is archived");
  if (!w.enable_tracking) return wait("you", "Follow-up isn't following this workspace");
  // The Done check never goes out on its own (it would wake an idle agent for bookkeeping).
  if (b.tasks.some(t => t.kind === "completion")) return wait("you", "ready to send");
  if (!w.enable_auto_sends) return wait("you", AUTO_OFF_REASON);
  if (w.hold) return wait("you", "paused until you resume");
  if (w.goneAgent) return wait("you", "the main agent's conversation is gone");
  // Only the main agent's own work holds a repair (Q96 = A): a subagent or another agent at work never does.
  const main = mainWait(w);
  if (main) return wait("agent", MAIN_WAIT[main]);
  if (w.runtimeReason) return wait("follow-up", w.runtimeReason);
  if (openBatch) return wait("follow-up", "waits for the last message to finish");
  if (w.dormant) return wait("you", "waits until the workspace is active again");
  if (w.sendWait === "setup") return wait("follow-up", "sends once setup finishes");
  // "unloaded" is what releases before Q177 stored for the same wait; a refresh rewrites it.
  if (w.sendWait === "stale" || w.sendWait === "unloaded") return wait("you", STALE_REASON);
  if (prUnread) return wait("follow-up", `waits until GitHub answers for #${prUnread.number}${prUnread.error ? ` (${prUnread.error})` : ""}, so the message isn't based on stale PRs`);
  // A refused send is retried once per settle window, never every refresh.
  if (b.refusal && now - Date.parse(b.refusal.at) < settleMs) return wait("follow-up", `didn't send: ${b.refusal.reason} · tries again shortly`, iso(Date.parse(b.refusal.at) + settleMs));
  const due = Date.parse(b.createdAt) + settleMs;
  if (now < due) return { send: false, waitingOn: null, reason: SETTLE_REASON, eta: iso(due), canSendNow };
  if (w.sendWait === "limit" && !b.automatic) return wait("follow-up", LIMIT_REASON);
  return { send: true, waitingOn: null, reason: "going out now", eta: iso(now), canSendNow };
}

/** How long a sent batch's agent may sit idle without acknowledge_batch before Follow-up settles it from GitHub. */
export const UNACKNOWLEDGED_MS = 120_000;
/** Sends of one condition (same task key and fingerprint) with no progress before it stops going out on its own. */
export const NO_PROGRESS_CAP = 2;
/** A condition's identity: the same task key and fingerprint is the same unchanged problem. */
export const conditionId = (t: Pick<Task, "key" | "fingerprint">) => `${t.key}:${t.fingerprint}`;
/**
 * Settled sends of this condition since the developer last pressed Retry on it, acknowledged or not. The condition is
 * still open with the same fingerprint wherever this is asked, so each of them left it as it was on GitHub.
 */
export function noProgressSends(w: Pick<Workspace, "batches" | "taskRetries">, t: Pick<Task, "key" | "fingerprint">, also?: Batch): number {
  const id = conditionId(t);
  const sends = w.batches.filter(x => (x === also || x.state === "completed" && !!x.sentAt) && x.tasks.some(y => conditionId(y) === id)).length;
  return sends - (w.taskRetries?.[id] ?? 0);
}
/** GitHub was read for the task's PR after `at` (an acknowledgment), so what it shows reflects the agent's work. */
export const readSince = (w: Pick<Workspace, "prs">, t: Pick<Task, "target">, at: string | null | undefined) => {
  const seen = w.prs.find(p => p.key === t.target)?.snapshot?.observedAt;
  return !!at && !!seen && Date.parse(seen) > Date.parse(at);
};
/** The condition went out NO_PROGRESS_CAP times unchanged: it stops going out on its own, and only it (Q49). */
export const isCapped = (w: Pick<Workspace, "batches" | "taskRetries">, t: Pick<Task, "key" | "fingerprint">) => noProgressSends(w, t) >= NO_PROGRESS_CAP;
/**
 * A sent batch whose turn ended without an acknowledgment (Q50: no routine retry). `open` is what GitHub and the
 * tasks show now (server/tasks.ts tasksFor). The batch always settles completed + unacknowledged, so it never holds
 * the queue (invariant a-capped-task-never-holds-the-queue). Tasks no longer open are done; still-open ones go back in
 * the queue (reconcile skips an unacknowledged completed batch), except a condition that has now gone out
 * NO_PROGRESS_CAP times unchanged: reconcile holds that one task as capped, and Retry on it is the developer's.
 */
export function settleUnacknowledged(w: Workspace, b: Batch, open: readonly Task[], now: number): void {
  const openIds = new Set(open.map(conditionId));
  const still = b.tasks.filter(t => openIds.has(conditionId(t)));
  const capped = still.filter(t => noProgressSends(w, t, b) >= NO_PROGRESS_CAP);
  b.unacknowledged = true; b.settledAt = new Date(now).toISOString(); b.state = "completed";
  const done = b.tasks.length - still.length, again = still.length - capped.length;
  b.result = !still.length ? "The turn ended without an acknowledgment; GitHub no longer shows these, so they're done."
    : `The turn ended without an acknowledgment.${done ? ` ${done} done on GitHub.` : ""}${again ? ` ${again} still open ${again === 1 ? "goes" : "go"} in the next message.` : ""}${capped.length ? ` ${capped.length} sent ${NO_PROGRESS_CAP} times with no change ${capped.length === 1 ? "waits" : "wait"} for you.` : ""}`;
}

/**
 * The agent said only a person can move this condition (Batch.humanOnly) and it is still the same condition: it waits
 * as the developer's held "person" task, never an agent failure and never sent again on its own. A changed condition
 * (a new review, a new head) has a new fingerprint and goes out as usual. Invariant a-human-only-outcome-is-a-human-item.
 */
export const personHeld = (w: Pick<Workspace, "batches">, t: Pick<Task, "key" | "fingerprint">) => {
  const id = conditionId(t);
  return w.batches.some(b => b.state === "completed" && !!b.humanOnly && b.tasks.some(x => conditionId(x) === id));
};

/**
 * a-person-part-is-a-person-item: what the agent's latest answer for this task said only a person can move
 * (Batch.waitingOn), else null. Keyed by the task, not its fingerprint, so a review that keeps changing keeps it; a
 * later answer without one drops it.
 */
export function personPart(w: Pick<Workspace, "batches">, taskKey: string): { batchId: string; text: string } | null {
  for (let i = w.batches.length - 1; i >= 0; i--) {
    const b = w.batches[i]!;
    if (!b.sentAt || !b.settledAt || !["completed", "blocked"].includes(b.state) || b.unacknowledged || !b.tasks.some(t => t.key === taskKey)) continue;
    return b.waitingOn ? { batchId: b.id, text: b.waitingOn } : null;
  }
  return null;
}

/** Blocked or unconfirmed: a repair batch whose outcome the developer is shown (Needs you's "The repairs didn't finish"). */
export const stuckRepair = (b: Pick<Batch, "state" | "tasks" | "movedOn">) =>
  ["blocked", "uncertain"].includes(b.state) && !b.movedOn && !recoveryBatch(b) && !(b.tasks.length > 0 && b.tasks.every(t => t.kind === "completion"));
/** Blocked or unconfirmed and still standing (nothing moved on since): what Needs you, Retry and the Home line call stuck. */
export const stuckBatch = (b: Pick<Batch, "state" | "movedOn">) => ["blocked", "uncertain"].includes(b.state) && !b.movedOn;

/**
 * Whether GitHub's answer for the task's PR is known (a complete snapshot and no read error), or the task isn't about a
 * tracked PR (a task's own state is local). Unknown is not off: a PR GitHub didn't answer for still applies.
 */
function conditionKnown(w: Pick<Workspace, "prs">, t: Pick<Task, "kind" | "target">): boolean {
  if (t.kind === "obligation") return true;
  const pr = w.prs.find(p => p.key === t.target);
  return !pr || !!pr.snapshot?.complete && !pr.error;
}

/**
 * Whether a stuck repair batch still asks for anything: some task's condition (key and fingerprint) is still open in
 * `open` (server/tasks.ts tasksFor, the PRs as they are now), or its PR's state is unknown. Once nothing applies (every
 * PR merged or closed, the review dismissed or replaced, the checks passing, the conflict gone) the batch settles on its
 * own, the same rule reconcile applies to a queued one. Invariant a-batch-item-leaves-once-nothing-applies.
 */
export function stillApplies(w: Pick<Workspace, "prs">, b: Pick<Batch, "tasks">, open: readonly Pick<Task, "key" | "fingerprint">[]): boolean {
  const ids = new Set(open.map(conditionId));
  return b.tasks.some(t => ids.has(conditionId(t)) || !conditionKnown(w, t));
}

/** Why a stuck batch that stopped mattering settled, in the developer's words ("No longer needed: #1 merged."). */
export function mootReason(w: Pick<Workspace, "prs">, b: Pick<Batch, "tasks">): string {
  const prs = [...new Set(b.tasks.map(t => t.target))].map(key => w.prs.find(p => p.key === key)).filter(p => !!p);
  const ended = prs.filter(p => p.snapshot?.state === "MERGED" || p.snapshot?.state === "CLOSED");
  if (prs.length && ended.length === prs.length && ended.length === new Set(b.tasks.map(t => t.target)).size)
    return `No longer needed: ${ended.map(p => `#${p.number} ${p.snapshot!.state === "MERGED" ? "merged" : "closed"}`).join(", ")}.`;
  return "No longer needed: GitHub no longer shows what it asked for.";
}

/**
 * The agent answered it: acknowledge_batch recorded its outcome (blocked, with its words). Older records carry no flag:
 * a blocked repair that went out with no refused acknowledgment is the agent's own answer.
 */
export const agentAnswered = (b: Pick<StoredBatch, "state" | "sentAt" | "acknowledgmentError" | "unacknowledged" | "tasks">) =>
  b.state === "blocked" && !!b.sentAt && !b.acknowledgmentError && !b.unacknowledged && !recoveryBatch(b);

/**
 * A stuck batch whose exact conditions are gone but whose task is still open with new content (the same review, new
 * threads or replies): it changed, it isn't over. The next message carries what's new (taskUpdate). Invariant
 * a-changed-review-updates-never-cancels.
 */
export function changedNotGone(b: Pick<Batch, "tasks">, open: readonly Pick<Task, "key" | "fingerprint">[]): boolean {
  const keys = new Set(open.map(t => t.key));
  return b.tasks.some(t => keys.has(t.key));
}
/** The developer's words for a batch whose conditions moved on, by why. "No longer needed" only when nothing is left. */
export function movedOnReason(w: Pick<Workspace, "prs">, b: Pick<Batch, "tasks">, why: "changed" | "gone" | "retried" | "duplicate"): string {
  switch (why) {
    case "changed": return "Updated on GitHub since it went out; the next message carries what's new.";
    case "gone": return mootReason(w, b);
    case "retried": return "Sent again on Retry.";
    case "duplicate": return "The same items went out again in a later message.";
  }
}

/** How long an agent's in-progress answer holds its unchanged conditions at most, so a busy signal that never clears can't hold them forever. */
export const IN_PROGRESS_MAX_MS = 2 * 60 * 60_000;
/**
 * The agent said it is already on this condition (Batch.inProgress) and its work hasn't settled: some agent in the
 * workspace is still at work (runtimeBusy, backgroundBusy) and the answer is under IN_PROGRESS_MAX_MS old. The same
 * condition isn't sent again meanwhile; a changed one (a new fingerprint) is a new condition and goes out as usual.
 */
export function inProgressHolds(w: Pick<Workspace, "runtimeBusy" | "backgroundBusy">, b: Pick<Batch, "state" | "inProgress" | "settledAt">, now: number): boolean {
  if (b.state !== "completed" || !b.inProgress || !b.settledAt) return false;
  return (w.runtimeBusy || w.backgroundBusy) && now - Date.parse(b.settledAt) < IN_PROGRESS_MAX_MS;
}

/**
 * What moved in a task since the last message about it, in counts: "2 new threads, 1 with new replies". Null when no
 * earlier sent message had this task with other content, or either side has no parts. `before`: the batches before it.
 */
export function taskUpdate(before: readonly Pick<Batch, "tasks" | "sentAt">[], t: Pick<Task, "key" | "fingerprint" | "parts">): string | null {
  if (!t.parts) return null;
  const last = [...before].reverse().find(b => !!b.sentAt && b.tasks.some(x => x.key === t.key));
  const prior = last?.tasks.find(x => x.key === t.key);
  if (!prior?.parts || prior.fingerprint === t.fingerprint) return null;
  const was = new Map(prior.parts.map(p => { const at = p.lastIndexOf("@"); return [at < 0 ? p : p.slice(0, at), p] as const; }));
  let added = 0, replied = 0;
  for (const p of t.parts) { const at = p.lastIndexOf("@"); const id = at < 0 ? p : p.slice(0, at); if (!was.has(id)) added++; else if (was.get(id) !== p) replied++; }
  const now = new Set(t.parts.map(p => { const at = p.lastIndexOf("@"); return at < 0 ? p : p.slice(0, at); }));
  const resolved = [...was.keys()].filter(id => !now.has(id)).length;
  const bits = [added && `${added} new thread${added === 1 ? "" : "s"}`, replied && `${replied} with new replies`, resolved && `${resolved} resolved`].filter(Boolean);
  return bits.length ? `since the last message: ${bits.join(", ")}` : "since the last message: the review changed";
}
