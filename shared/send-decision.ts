import type { Task } from "./model";
import type { ListBatch as Batch, ListWorkspace as Workspace } from "./list";
import { recoveryBatch } from "./follow-up";

/** How long a new batch waits before it goes out on its own, so tasks that land together go in one message. */
export const SETTLE_MS = 60_000;

/** States of a non-recovery batch that hold the queue: one message at a time per workspace. */
export const OPEN_BATCH_STATES: readonly Batch["state"][] = ["sending", "sent", "blocked", "uncertain"];

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

/** The idle wait in one sentence, with the agent's own title, said the same on every surface (Needs you, Home, the inbox). */
export const idleReason = (w: Pick<Workspace, "mainAgentTitle">) => {
  return `${w.mainAgentTitle?.trim() || "the main agent"} is idle, and Follow-up doesn't wake it`;
};
const iso = (ms: number) => new Date(ms).toISOString();
/** The reason the settle gives: why "in a minute" and not now (Tom, 2026-11-12: "sending in a moment? why not now?"). */
export const SETTLE_REASON = "waits a minute so new changes join the same message";

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
  const openBatch = !!b && w.batches.some(x => x.id !== b.id && !recoveryBatch(x) && OPEN_BATCH_STATES.includes(x.state));
  const canSendNow = !!b && b.state === "pending" && !recoveryBatch(b) && !w.archived && w.enable_tracking && !w.hold && !w.goneAgent &&
    !w.runtimeBusy && !w.backgroundBusy && !w.runtimeReason && !openBatch && !prUnread;
  const wait = (waitingOn: SendDecision["waitingOn"], reason: string, eta: string | null = null): SendDecision => ({ send: false, waitingOn, reason, eta, canSendNow });
  if (!b || b.state !== "pending" || recoveryBatch(b)) return wait(null, "nothing queued");
  if (w.archived) return wait("you", "the workspace is archived");
  if (!w.enable_tracking) return wait("you", "Follow-up isn't following this workspace");
  // The Done check never goes out on its own (it would wake an idle agent for bookkeeping).
  if (b.tasks.some(t => t.kind === "completion")) return wait("you", "ready to send");
  if (!w.enable_auto_sends) return wait("you", "ready to send");
  if (w.hold) return wait("you", "paused until you resume");
  if (w.goneAgent) return wait("you", "the main agent's conversation is gone");
  if (w.runtimeBusy) return wait("agent", "sends when its current turn ends, so it isn't interrupted");
  if (w.backgroundBusy) return wait("agent", "sends when its background work ends, so it isn't interrupted");
  if (w.runtimeReason) return wait("follow-up", w.runtimeReason);
  if (openBatch) return wait("follow-up", "waits for the last message to finish");
  if (w.dormant) return wait("you", "waits until the workspace is active again");
  if (w.sendWait === "setup") return wait("follow-up", "sends once setup finishes");
  if (w.sendWait === "unloaded") return wait("you", idleReason(w));
  if (prUnread) return wait("follow-up", `waits until GitHub answers for #${prUnread.number}${prUnread.error ? ` (${prUnread.error})` : ""}, so the message isn't based on stale PRs`);
  // A refused send is retried once per settle window, never every refresh.
  if (b.refusal && now - Date.parse(b.refusal.at) < settleMs) return wait("follow-up", `didn't send: ${b.refusal.reason} · tries again shortly`, iso(Date.parse(b.refusal.at) + settleMs));
  const due = Date.parse(b.createdAt) + settleMs;
  if (now < due) return { send: false, waitingOn: null, reason: SETTLE_REASON, eta: iso(due), canSendNow };
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
