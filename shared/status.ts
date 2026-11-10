import type { Batch, Workspace } from "./model";
import { completionCheck } from "./model";
import { recoveryBatch } from "./follow-up";

/**
 * The one status model for Follow-up's own work on a workspace. Home's bucket, the panel's agent card, the header's
 * live line and Needs you all read this, so no surface can say the agent is on it while another says it is idle.
 * Mirrors the worker's auto-send rules (server/engine.ts): change both together, and the invariants in
 * shared/status-invariants.ts catch a surface that drifts.
 */
export const SETTLE_MS = 60_000;

/** Follow-up's own hold after the main agent's turn failed or the developer stopped it (server sets it at turn end). */
export const interruptionHold = (kind: "canceled" | "failed") => kind === "canceled" ? "You stopped the main agent. Resume follow-up when ready." : "The main agent's turn failed. Check it before resuming follow-up.";
/** The hold is Follow-up's automatic one, not one the developer set (a hold they set never lifts on its own). */
export const automaticHold = (w: Pick<Workspace, "hold" | "interruption">) => !!w.interruption && w.hold === interruptionHold(w.interruption.kind);
/** The id of a turn, from either shape: the directory's patch `{ id }` or Paseo 0.16's `{ turnId }`. */
export const turnIdOf = (activeTurn: unknown): string | null => {
  const t = activeTurn as { id?: unknown; turnId?: unknown } | null | undefined;
  const id = t?.turnId ?? t?.id;
  return typeof id === "string" && id ? id : null;
};
/**
 * A failed turn's hold is run state, so a newer main-agent turn (from anyone: the developer, another agent, the host
 * resuming it) supersedes it, like the inbox's error flag (shared/inbox.ts RUN_STATE_REASONS). Newer means another
 * turn id: right after the failure Paseo can still read "running" with no active turn. "You stopped the main agent"
 * is the developer's own Stop, so it stays until they resume. Status invariant automatic-hold-is-not-stale.
 */
export function holdSuperseded(w: Pick<Workspace, "hold" | "interruption" | "mainAgentId">, turn: { agentId: string; turnId: string | null }): boolean {
  const stop = w.interruption;
  if (!stop || stop.kind !== "failed" || !automaticHold(w)) return false;
  return (stop.agentId ?? w.mainAgentId) === turn.agentId && turn.agentId === w.mainAgentId && !!turn.turnId && turn.turnId !== stop.turnId;
}
export function liftHold(w: Workspace): void { w.hold = null; delete w.interruption; }
/** The Done check's words, the same on every surface: Home, the pill, the header, Needs you and the agent card. */
export const FINISH_WORD = "Ready to finish";
export const FINISH_ASK = "ask the main agent to check and declare Done";
export const FINISH_LINE = `${FINISH_WORD} · ${FINISH_ASK}`;
/** A blocked or unconfirmed batch, in its own words: the Done check is never called a repair. */
export function stuckLine(b: Batch): string {
  if (completionCheck(b)) return b.state === "uncertain" ? "Check whether the Done request arrived" : "The Done check didn't go through";
  return b.state === "uncertain" ? "Check whether the repairs arrived" : "The repairs didn't finish";
}
/** "#1" or "#1, #3": the merged PRs whose deploy Follow-up never confirmed. */
export const unconfirmedRefs = (keys: readonly string[]) => keys.map(k => `#${k.split("#")[1] ?? k}`).join(", ");
/** The note a Done with an unconfirmed deploy carries, on the chat card and the Shipped card alike. */
export const unconfirmedNote = (keys: readonly string[]) => `Deploy not confirmed by Follow-up for ${unconfirmedRefs(keys)}. The summary above is the agent's evidence.`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type BatchView = {
  batch: Batch;
  /** repairs: fixes for the agent. finish: the Done check, never auto-sent. recovery: the inventory agent's brief. */
  kind: "repairs" | "finish" | "recovery";
  phase: "queued" | "sent" | "stuck";
  recipient: "main" | "recovery";
  /** Who has to move next for a queued batch: you (send, resume, talk to the agent), the agent's own turn, or Follow-up. */
  waitingOn: "you" | "agent" | "follow-up" | null;
  /** The one line every surface shows for this batch. */
  line: string;
  /** Follow-up is getting it done right now: sent, or about to go out on its own. Home's "Follow-up is fixing". */
  fixing: boolean;
};

/** Why a queued repair batch hasn't gone out, in the worker's own order. Null: it goes out on the next refresh. */
function queuedReason(w: Workspace, b: Batch, now: number): { waitingOn: BatchView["waitingOn"]; text: string; fixing: boolean } {
  if (!w.enable_auto_sends) return { waitingOn: "you", text: "ready to send", fixing: false };
  if (w.hold) return { waitingOn: "you", text: "paused until you resume", fixing: false };
  if (w.goneAgent) return { waitingOn: "you", text: "the main agent's conversation is gone", fixing: false };
  if (w.runtimeBusy) return { waitingOn: "agent", text: "sends after the agent's current turn", fixing: true };
  if (w.backgroundBusy) return { waitingOn: "agent", text: "sends after the agent's background work", fixing: true };
  if (w.runtimeReason) return { waitingOn: "follow-up", text: w.runtimeReason, fixing: false };
  if (w.batches.some(o => o.id !== b.id && !recoveryBatch(o) && ["sending", "sent", "blocked", "uncertain"].includes(o.state))) return { waitingOn: "follow-up", text: "waits for the open batch to finish", fixing: false };
  if (w.dormant) return { waitingOn: "you", text: "waits until the workspace is active again", fixing: false };
  if (w.sendWait === "setup") return { waitingOn: "follow-up", text: "sends once setup finishes", fixing: false };
  if (w.sendWait === "unloaded") return { waitingOn: "you", text: "the agent is idle and Follow-up doesn't wake it · send it now", fixing: false };
  return { waitingOn: null, text: now - Date.parse(b.createdAt) < SETTLE_MS ? "sending in a moment" : "sending now", fixing: true };
}

/** The batch that describes Follow-up's work right now: in flight, then stuck, then queued repairs, then the Done check. */
export function batchView(w: Workspace, now = Date.now()): BatchView | null {
  const recipientOf = (b: Batch): "main" | "recovery" => b.recipientAgentId && b.recipientAgentId !== w.mainAgentId ? "recovery" : "main";
  const who = (b: Batch) => recipientOf(b) === "recovery" ? "Recovery agent" : "Main agent";
  // Once Done, a Done check is moot (the worker settles it on the next refresh): it never shows as work.
  const work = w.batches.filter(b => !recoveryBatch(b) && !(w.completion && completionCheck(b)));
  const sent = work.find(b => ["sending", "sent"].includes(b.state));
  if (sent) {
    const finish = completionCheck(sent);
    return { batch: sent, kind: finish ? "finish" : "repairs", phase: "sent", recipient: recipientOf(sent), waitingOn: "agent", fixing: true,
      line: finish ? `${who(sent)} is checking the work is finished` : `${who(sent)} is working on ${plural(sent.tasks.length, "repair")}` };
  }
  const recovering = w.batches.find(b => recoveryBatch(b) && ["sending", "sent"].includes(b.state));
  if (recovering) return { batch: recovering, kind: "recovery", phase: "sent", recipient: "recovery", waitingOn: "agent", fixing: true, line: "Recovery agent is rebuilding the PR list" };
  const stuck = work.find(b => ["blocked", "uncertain"].includes(b.state));
  if (stuck) return { batch: stuck, kind: completionCheck(stuck) ? "finish" : "repairs", phase: "stuck", recipient: recipientOf(stuck), waitingOn: "you", fixing: false,
    line: stuckLine(stuck) };
  const repairs = work.find(b => b.state === "pending" && !completionCheck(b));
  if (repairs) {
    const why = queuedReason(w, repairs, now);
    return { batch: repairs, kind: "repairs", phase: "queued", recipient: "main", waitingOn: why.waitingOn, fixing: why.fixing, line: `${plural(repairs.tasks.length, "repair")} queued · ${why.text}` };
  }
  // The Done check never goes out on its own (it would wake an idle agent for bookkeeping): it waits on you.
  const finish = work.find(b => b.state === "pending" && completionCheck(b));
  if (finish) return { batch: finish, kind: "finish", phase: "queued", recipient: "main", waitingOn: "you", fixing: false, line: FINISH_LINE };
  return null;
}

/** The panel's agent card: only while an agent really has Follow-up's work, or repairs are lined up for it. */
export function agentCard(w: Workspace, now = Date.now()): { title: string; line: string; view: BatchView } | null {
  const view = batchView(w, now);
  if (!view || view.kind === "recovery" || view.phase === "stuck" || view.kind === "finish" && view.phase === "queued") return null;
  // Repairs that wait on you are a Needs-you item with a Send button, not an agent card.
  if (view.phase === "queued" && view.waitingOn === "you") return null;
  if (view.phase === "queued" && !w.enable_auto_sends) return null;
  const agent = view.recipient === "recovery" ? "Recovery agent" : "Main agent";
  return { title: view.phase === "sent" ? `${agent} is on it` : `Queued for the ${view.recipient === "recovery" ? "recovery" : "main"} agent`, line: view.line, view };
}
