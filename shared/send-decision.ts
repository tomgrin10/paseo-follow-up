import type { Batch, Workspace } from "./model";
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
  /** Why, in the words every surface shows. */
  reason: string;
  /** When it goes out on its own, if Follow-up knows (ISO). Null: it waits on something with no clock. */
  eta: string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The one auto-send rule (status invariant the-send-line-matches-the-send-decision). The worker's refresh sends the
 * queued batch when, and only when, `send` is true; the batch line on every surface (shared/status.ts) shows `reason`.
 * It reads only what the refresh persisted (runtime state, sendWait, PR reads, the last refusal), so the line and the
 * send can't disagree. `batch`: the queued non-recovery batch; defaults to the workspace's.
 */
export function sendDecision(w: Workspace, now: number, o: { settleMs?: number; batch?: Batch } = {}): SendDecision {
  const settleMs = o.settleMs ?? SETTLE_MS;
  const b = o.batch ?? w.batches.find(b => b.state === "pending" && !recoveryBatch(b));
  const wait = (waitingOn: SendDecision["waitingOn"], reason: string, eta: string | null = null): SendDecision => ({ send: false, waitingOn, reason, eta });
  if (!b || b.state !== "pending" || recoveryBatch(b)) return wait(null, "nothing queued");
  if (w.archived) return wait("you", "the workspace is archived");
  if (!w.enable_tracking) return wait("you", "Follow-up isn't following this workspace");
  // The Done check never goes out on its own (it would wake an idle agent for bookkeeping).
  if (b.tasks.some(t => t.kind === "completion")) return wait("you", "ready to send");
  if (!w.enable_auto_sends) return wait("you", "ready to send");
  if (w.hold) return wait("you", "paused until you resume");
  if (w.goneAgent) return wait("you", "the main agent's conversation is gone");
  if (w.runtimeBusy) return wait("agent", "sends after the agent's current turn");
  if (w.backgroundBusy) return wait("agent", "sends after the agent's background work");
  if (w.runtimeReason) return wait("follow-up", w.runtimeReason);
  if (w.batches.some(x => x.id !== b.id && !recoveryBatch(x) && OPEN_BATCH_STATES.includes(x.state))) return wait("follow-up", "waits for the open batch to finish");
  if (w.dormant) return wait("you", "waits until the workspace is active again");
  if (w.sendWait === "setup") return wait("follow-up", "sends once setup finishes");
  if (w.sendWait === "unloaded") return wait("you", "the agent is idle and Follow-up doesn't wake it · send it now");
  if (needsPrObservations(w, b)) {
    const unread = w.prs.find(p => p.error || !p.snapshot?.complete);
    if (unread) return wait("follow-up", `waits for a clean read of #${unread.number}${unread.error ? ` (${unread.error})` : ""}`);
  }
  // A refused send is retried once per settle window, never every refresh.
  if (b.refusal && now - Date.parse(b.refusal.at) < settleMs) return wait("follow-up", `didn't send: ${b.refusal.reason} · tries again shortly`, iso(Date.parse(b.refusal.at) + settleMs));
  const due = Date.parse(b.createdAt) + settleMs;
  if (now < due) return { send: false, waitingOn: null, reason: "sending in a moment", eta: iso(due) };
  return { send: true, waitingOn: null, reason: "sending now", eta: iso(now) };
}
