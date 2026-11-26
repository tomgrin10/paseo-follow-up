import { hookSource } from "./hook-source";
import { pickNudges, type DueEntry, type NudgeReceipt } from "../shared/task-due";
import { providerCaps } from "../shared/provider-support";
import { messageSender } from "../shared/message-sender";
import { startsTurn } from "./turn-timeline";
import { compactionOnly } from "./inbox-classifier";

/**
 * Turn-end checks for a provider without Follow-up's hook (an-agent-on-any-provider-gets-follow-up). Claude Code and
 * Codex get them from the Stop hook (server/agent-hook.mjs); every other provider gets the same checks from Paseo's
 * turn-end event, with the hook's own words: the sync reminder after a turn that changed something and didn't sync,
 * the needs_you nudge, and the due tasks.
 *
 * The Stop hook blocks the stop; an event can't, so the checks go as one queued message (invariant 36) after the turn,
 * and only when something is due: a quiet turn sends nothing. It never loops: the turn that message starts is never
 * checked (one reply, like the hook's stop_hook_active), told from the turn's own prompt, so a worker restart between
 * the message and its reply can't start a loop. The needs_you nudge, which a hook gives in-turn for free but costs a
 * whole turn here, follows only a turn the developer started (their message, or their answer from a card); never a
 * repair, a recovery, another agent's message, or a turn whose prompt the read didn't reach. It never wakes a dormant agent: it runs only on a turn that
 * just ended, and the queue sends only to that loaded agent. Due tasks share the hook's receipt (at most 3 a turn end,
 * each at most twice and once a day).
 */

const literal = (name: string): string => {
  const m = hookSource.match(new RegExp(`export const ${name} = (.+?);\\n`));
  if (!m) throw new Error(`turn-end: the hook no longer exports ${name}`);
  return JSON.parse(m[1]!) as string;
};
export const STOP_REASON = literal("stopReason");
export const NUDGE_REASON = literal("nudgeReason");
export const DUE_HEADER = literal("dueHeader");
const TOOL_NAMES = (() => { const m = hookSource.match(/export const TOOL_NAMES = (\[.+?\]);\n/); return m ? JSON.parse(m[1]!) as string[] : []; })();
const toolPattern = new RegExp(`(?<![\\w])(${TOOL_NAMES.join("|")})(?![\\w])`, "g");
/** Follow-up's tools under the names a native session has them (the hook's `named`). */
const named = (text: string) => text.replace(toolPattern, "follow_$1");
/** The first line of every turn-end message: how the agent, the inbox and the tests tell it apart. */
export const TURN_END_PREFIX = literal("turnEndPrefix");

export type TurnEndEntry = { role: "main" | "contributor" | "recovery"; workspaceId: string; due?: DueEntry[] };
export type TurnEndInput = {
  provider: string;
  /** scopes.json's entry for this agent, null when it isn't tracked. */
  entry: TurnEndEntry | null;
  /** The ended turn's timeline items (the read the worker already made), null when there was none. */
  items: readonly unknown[] | null;
  /** When this turn started, as the worker saw it; null when it didn't (a worker that started mid-turn). */
  startedAt: number | null;
  /** The workspace's last confirmed sync for this agent (sync_workspace), if any. */
  syncedAt: number | null;
  /** The agent's last needs_you, if any. */
  needsYouAt: number | null;
  /** The inbox and its nudge are on, and this agent has no permission prompt showing. */
  nudge: boolean;
  receipt: NudgeReceipt;
  now: number;
};

/** A tool call that isn't Follow-up's own (a shell, an edit, a write…): the turn changed something worth syncing. */
function changedSomething(items: readonly unknown[] | null): boolean {
  return (items ?? []).some(i => {
    const item = i as { type?: string; name?: unknown };
    if (item?.type !== "tool_call" || typeof item.name !== "string") return false;
    return !/(^|[._/])follow_[a-z_]+$|^wait_|^(?:mcp__)?follow-up(?:__|[.:/])/.test(item.name);
  });
}

/** Who started the turn, from its prompt (the first item that starts a turn in the read); null when it isn't there. */
export function turnPrompt(items: readonly unknown[] | null): "developer" | "turn-end" | "other" | null {
  const first = (items ?? []).find(startsTurn) as { type?: string; text?: unknown } | undefined;
  if (!first) return null;
  if (first.type !== "user_message" || typeof first.text !== "string") return "other";
  if (first.text.startsWith(TURN_END_PREFIX)) return "turn-end";
  const sender = messageSender(first.text);
  return sender.kind === "developer" || sender.kind === "follow-up" && sender.what === "answer" ? "developer" : "other";
}

/** What the turn end says, or null for nothing (the common case), and the due-task receipt to keep. Pure. */
export function turnEndCheck(i: TurnEndInput): { text: string | null; receipt: NudgeReceipt | null } {
  if (providerCaps(i.provider).turnEnd !== "event" || !i.entry || i.entry.role === "recovery") return { text: null, receipt: null };
  const prompt = turnPrompt(i.items);
  // The reply to our own message is never checked (the loop guard that survives a restart).
  if (prompt === "turn-end") return { text: null, receipt: null };
  const since = i.startedAt ?? i.now;
  const sync = changedSomething(i.items) && !(i.syncedAt !== null && i.syncedAt >= since);
  const nudge = i.entry.role === "main" && i.nudge && prompt === "developer" && !(i.needsYouAt !== null && i.needsYouAt >= since);
  const picked = i.entry.due?.length ? pickNudges(i.entry.due, i.receipt, i.now) : { lines: [], receipt: i.receipt };
  if (!sync && !nudge && !picked.lines.length) return { text: null, receipt: null };
  const parts = [
    picked.lines.length ? named(DUE_HEADER) + "\n" + picked.lines.map(l => `- ${l}`).join("\n") : null,
    sync ? `${STOP_REASON} This is metadata bookkeeping only; do not start queued repairs or recovery. Call ${named("sync_workspace")} with a short summary; pass milestone when the milestone you're on changed.` : null,
    nudge ? named(NUDGE_REASON) : null,
  ].filter(Boolean);
  return { text: `${TURN_END_PREFIX} your turn ended with this still open. Handle it, then stop without repeating your reply.\n\n${parts.join("\n\n")}`, receipt: picked.lines.length ? picked.receipt : null };
}

export type TurnEndDeps = {
  input(agentId: string, provider: string, items: readonly unknown[] | null, startedAt: number | null): Promise<Omit<TurnEndInput, "provider" | "items" | "startedAt" | "now"> | null>;
  saveReceipt(workspaceId: string, receipt: NudgeReceipt): Promise<void>;
  /** Queues the message for this agent (message-queue.ts); returns once it is saved. */
  send(agentId: string, workspaceId: string, text: string, turnId: string | null): Promise<void>;
  now?: () => number;
};

/** The worker's side: when turns start, which turn a check's own message started, and the send. */
export class TurnEnd {
  private started = new Map<string, number>();
  /** Agents whose next turn was started by a turn-end message: that turn is never checked. */
  private answering = new Set<string>();
  constructor(private d: TurnEndDeps) {}

  turnStarted(agentId: string): void { this.started.set(agentId, (this.d.now ?? Date.now)()); }

  async turnEnded(agent: { id: string; provider: string; parentAgentId: string | null }, outcome: { kind: string }, turnId: string | null, items: readonly unknown[] | null): Promise<string | null> {
    const startedAt = this.started.get(agent.id) ?? null;
    this.started.delete(agent.id);
    if (providerCaps(agent.provider).turnEnd !== "event" || agent.parentAgentId) return null;
    // The reply to our own message: never checked, so a check can't start a loop.
    if (this.answering.delete(agent.id)) return null;
    if (outcome.kind !== "completed") return null;
    // A turn that only compacted isn't the agent finishing: nothing to check (a-compaction-is-not-a-finish).
    if (items && compactionOnly(items)) return null;
    const base = await this.d.input(agent.id, agent.provider, items, startedAt);
    if (!base?.entry) return null;
    const now = (this.d.now ?? Date.now)();
    const { text, receipt } = turnEndCheck({ ...base, provider: agent.provider, items, startedAt, now });
    if (!text) return null;
    if (receipt) await this.d.saveReceipt(base.entry.workspaceId, receipt).catch(() => undefined);
    this.answering.add(agent.id);
    try { await this.d.send(agent.id, base.entry.workspaceId, text, turnId); }
    catch { this.answering.delete(agent.id); return null; }
    return text;
  }
}
