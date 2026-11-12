import type { Batch, Workspace } from "./model";
import { completionCheck, CANCEL_CAUSES } from "./model";
import { recoveryBatch } from "./follow-up";
import { SETTLE_MS, sendDecision } from "./send-decision";

/**
 * The one status model for Follow-up's own work on a workspace. Home's bucket, the panel's agent card, the header's
 * live line and Needs you all read this, so no surface can say the agent is on it while another says it is idle.
 * A queued batch's line is the worker's own send decision (shared/send-decision.ts), and the invariants in
 * shared/status-invariants.ts catch a surface that drifts.
 */
export { SETTLE_MS };

/** Follow-up's own hold after the main agent's turn failed or the developer stopped it (holdOnTurnEnd). */
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
 * Why a main-agent turn ended canceled. Paseo's reason text can't tell them apart on its own: the developer's Stop, a
 * turn replaced by a newer message (the developer's or another agent's) and a refreshed session all arrive as
 * "Interrupted"/"interrupted" (Paseo 0.16 agent-manager.js, providers/claude/agent.js); only closing or reloading
 * the agent names itself ("agent closed", "agent reloaded"). So the cause comes from what happened around the
 * cancel: a newer turn already started (replaced), the turn was a /compact (Smart Session's or the developer's
 * compaction is never Follow-up's work), or neither (stop). Status invariant only-a-stop-holds.
 */
export { CANCEL_CAUSES };
export type CancelCause = typeof CANCEL_CAUSES[number];
export function cancelCause(c: { reason: string | null | undefined; prompt?: string | null; newerTurn?: boolean; compaction?: boolean }): CancelCause {
  const reason = (c.reason ?? "").trim().toLowerCase();
  if (/\breload/.test(reason) || /\brestart/.test(reason)) return "reload";
  if (/\bclos/.test(reason)) return "closed";
  if (c.compaction || /^\/compact\b/.test((c.prompt ?? "").trimStart())) return "compaction";
  if (c.newerTurn) return "replaced";
  return "stop";
}
/** How long after Smart Session delivers a /compact a canceled turn is still that compaction's. */
export const COMPACTION_CANCEL_MS = 600_000;
/**
 * Smart Session's queue (plugin-data/smart-session/compactions.json) says it just delivered a /compact to this agent:
 * one being sent, or sent within COMPACTION_CANCEL_MS before `endedAt` and not yet confirmed done. It sends only to an
 * idle agent, so a turn canceled then is the compaction (Claude Code's "Compaction canceled."), whatever the
 * timeline tail shows when the end is handled. 2026-11-12 08:06: a second /compact replaced the first 22 ms later.
 */
export function compactionDelivered(items: readonly unknown[], agentId: string, endedAt: number): boolean {
  return items.some(raw => {
    const item = raw as { agentId?: unknown; state?: unknown; settledAt?: unknown; confirmedAt?: unknown } | null;
    if (!item || item.agentId !== agentId) return false;
    if (item.state === "sending") return true;
    if (item.state !== "sent" || typeof item.settledAt !== "string") return false;
    const sent = Date.parse(item.settledAt), done = typeof item.confirmedAt === "string" ? Date.parse(item.confirmedAt) : NaN;
    // Delivery is stamped after the send returns, so the cancel can precede it by a moment.
    return sent - 5_000 <= endedAt && endedAt - sent <= COMPACTION_CANCEL_MS && !(done <= endedAt);
  });
}
/** Only the developer's own Stop pauses Follow-up. When unsure it doesn't: a missed pause is cheap, a stuck one silently stops repairs. */
export const cancelHolds = (cause: CancelCause) => cause === "stop";
export type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
/**
 * The hold a main-agent turn end leaves (index.server.ts `agent.turn_ended`): a failed turn, or a canceled one whose
 * cause is the developer's Stop. Another agent's turn, and every other cancel cause, leave the workspace as it was.
 * `newerTurn`: the agent already started another turn when this one's end is handled.
 */
export function holdOnTurnEnd(w: Workspace, e: { agentId: string; turnId: string | null; at: string; outcome: TurnOutcome; prompt: string | null; newerTurn: boolean; compaction?: boolean }): boolean {
  if (w.mainAgentId !== e.agentId || e.outcome.kind === "completed") return false;
  if (e.outcome.kind === "canceled" && !cancelHolds(cancelCause({ reason: e.outcome.reason, prompt: e.prompt, newerTurn: e.newerTurn, compaction: e.compaction }))) return false;
  const kind = e.outcome.kind;
  w.hold = interruptionHold(kind); w.interruption = { turnId: e.turnId, at: e.at, kind, agentId: e.agentId, ...(kind === "canceled" ? { cause: "stop" as const } : {}) }; w.completion = null; w.declaration = null;
  return true;
}
/**
 * Follow-up's automatic hold is the stopped turn's run state, so a newer main-agent turn (from anyone: the developer,
 * another agent, the host resuming it) supersedes it, like the inbox's error flag (shared/inbox.ts RUN_STATE_REASONS).
 * That holds for a Stop too: the agent running again means someone resumed it. Newer means another turn id: right
 * after the stop Paseo can still read "running" with no active turn. A hold from before Follow-up recorded the
 * interruption (no turn id) lifts on any main-agent turn. A hold the developer set never lifts on its own. Status
 * invariant automatic-hold-is-not-stale.
 */
export function holdSuperseded(w: Pick<Workspace, "hold" | "interruption" | "mainAgentId">, turn: { agentId: string; turnId: string | null }): boolean {
  if (turn.agentId !== w.mainAgentId || !turn.turnId) return false;
  const stop = w.interruption;
  if (!stop) return w.hold === interruptionHold("canceled");
  if (!automaticHold(w)) return false;
  return (stop.agentId ?? w.mainAgentId) === turn.agentId && turn.turnId !== stop.turnId;
}
export function liftHold(w: Workspace): void { w.hold = null; delete w.interruption; }
/** The Done check's words, the same on every surface: Home, the pill, the header, Needs you and the agent card. */
export const FINISH_WORD = "Ready to finish";
export const FINISH_ASK = "ask the main agent to check and declare Done";
export const FINISH_LINE = `${FINISH_WORD} · ${FINISH_ASK}`;
/** A blocked or unconfirmed batch, in its own words: the Done check is never called a repair. */
export function stuckLine(b: Batch): string {
  if (completionCheck(b)) return b.state === "uncertain" ? "Check whether the Done request arrived" : "The Done check didn't go through";
  return b.state === "uncertain" ? "Check whether the message arrived" : "The tasks didn't finish";
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

/** Why a queued repair batch hasn't gone out: the worker's own decision (shared/send-decision.ts), never a copy of it. */
function queuedReason(w: Workspace, b: Batch, now: number): { waitingOn: BatchView["waitingOn"]; text: string; fixing: boolean } {
  const d = sendDecision(w, now, { batch: b });
  // Fixing: it goes out on its own once the agent's turn ends or the settle passes.
  return { waitingOn: d.waitingOn, text: d.reason, fixing: d.waitingOn === null || d.waitingOn === "agent" };
}

/** The batch that describes Follow-up's work right now: in flight, then stuck, then queued repairs, then the Done check. */
/**
 * Answers a pure (workspace, clock) function once per frozen workspace and clock reading. The store hands out deep-frozen
 * snapshots, and one refresh asks the same questions of a workspace many times (each status invariant calls needsYou and
 * batchView again): with queued messages that each run the send decision, that was the worker's top allocator on the
 * realistic test:scale (2026-11-12). An unfrozen workspace (a test's mutable fixture) is always computed afresh.
 */
export function perSnapshot<T>(fn: (w: Workspace, now: number) => T): (w: Workspace, now?: number) => T {
  const cache = new WeakMap<Workspace, { now: number; value: T }>();
  return (w, now = Date.now()) => {
    if (!Object.isFrozen(w)) return fn(w, now);
    const hit = cache.get(w);
    if (hit && hit.now === now) return hit.value;
    const value = fn(w, now); cache.set(w, { now, value }); return value;
  };
}
export const batchView = perSnapshot(computeBatchView);
function computeBatchView(w: Workspace, now: number): BatchView | null {
  const recipientOf = (b: Batch): "main" | "recovery" => b.recipientAgentId && b.recipientAgentId !== w.mainAgentId ? "recovery" : "main";
  const who = (b: Batch) => recipientOf(b) === "recovery" ? "Recovery agent" : "Main agent";
  // Once Done, a Done check is moot (the worker settles it on the next refresh): it never shows as work.
  const work = w.batches.filter(b => !recoveryBatch(b) && !(w.completion && completionCheck(b)));
  const sent = work.find(b => ["sending", "sent"].includes(b.state));
  if (sent) {
    const finish = completionCheck(sent);
    return { batch: sent, kind: finish ? "finish" : "repairs", phase: "sent", recipient: recipientOf(sent), waitingOn: "agent", fixing: true,
      line: finish ? `${who(sent)} is checking the work is finished` : `${who(sent)} is working on ${plural(sent.tasks.length, "task")}` };
  }
  const recovering = w.batches.find(b => recoveryBatch(b) && ["sending", "sent"].includes(b.state));
  if (recovering) return { batch: recovering, kind: "recovery", phase: "sent", recipient: "recovery", waitingOn: "agent", fixing: true, line: "Recovery agent is rebuilding the PR list" };
  const stuck = work.find(b => ["blocked", "uncertain"].includes(b.state));
  if (stuck) return { batch: stuck, kind: completionCheck(stuck) ? "finish" : "repairs", phase: "stuck", recipient: recipientOf(stuck), waitingOn: "you", fixing: false,
    line: stuckLine(stuck) };
  const repairs = work.find(b => b.state === "pending" && !completionCheck(b));
  if (repairs) {
    const why = queuedReason(w, repairs, now);
    return { batch: repairs, kind: "repairs", phase: "queued", recipient: "main", waitingOn: why.waitingOn, fixing: why.fixing, line: `${plural(repairs.tasks.length, "task")} queued · ${why.text}` };
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
