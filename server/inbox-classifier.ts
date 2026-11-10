import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { messageSender, workItems, type MessageSender } from "../shared/message-sender";

/**
 * Who sent the message that started a turn (design §2.4). Paseo's hooks carry no origin yet, so
 * this checks known senders in order and falls back to the developer. Every reader is read-only and
 * fails open: an unknown or unreadable format means "the developer wrote it", which clears a flag
 * rather than leaving noise.
 */
export type Sender = "agent" | "follow-up" | "defer" | "session" | "schedule" | "system" | "tom" | "unknown";
export type Message = { text: string; messageId?: string | null; clientMessageId?: string | null };
export type Ledger = { agentId: string; messageId: string | null; at: string; by?: string; action?: string }[];
export type Sources = {
  /** Follow-up's own delivery ledger, written before each send. */
  ledger: () => Promise<Ledger>;
  defer: (agentId: string, at: number) => Promise<boolean>;
  session: (agentId: string, at: number) => Promise<boolean>;
  schedule: (agentId: string, at: number) => Promise<boolean>;
};
export const WINDOW_MS = 10_000;


/**
 * Only "tom" may answer a brief. A turn whose prompt wasn't seen is "unknown", never the developer: before 1.4.0-beta.25
 * an unseen prompt fell back to the developer, so another agent's message (which Paseo 0.15 stores as an agent_message
 * tool call, not a user message) answered the open brief with the developer's previous message.
 */
export async function classify(message: Message | null, agentId: string, at: number, sources: Sources): Promise<Sender> {
  // The text names its sender first (shared/message-sender.ts): another agent's envelope or a Paseo system prompt is
  // never the developer, whatever the ledger says.
  const text = message ? messageSender(message.text) : null;
  if (text?.kind === "agent") return "agent";
  if (text?.kind === "system" && text.source === "paseo") return "system";
  const safe = async (check: () => Promise<boolean>) => { try { return await check(); } catch { return false; } };
  const own = await ledgerSender(message, agentId, at, sources);
  if (own) return own;
  // Follow-up's batch, recovery or an Overseer forward with no ledger entry is still automation. An answer isn't
  // decided here: answers go out only on the developer's Send, so an unrecorded one fails open below.
  if (text?.kind === "overseer-forward" || text?.kind === "follow-up" && text.what !== "answer") return "follow-up";
  if (await safe(() => sources.defer(agentId, at))) return "defer";
  if (await safe(() => sources.session(agentId, at))) return "session";
  if (await safe(() => sources.schedule(agentId, at))) return "schedule";
  return message ? "tom" : "unknown";
}

/**
 * What Follow-up's delivery ledger says about a message: "tom" for a brief option or move the developer clicked,
 * "follow-up" for Follow-up's own sends, null when the ledger has no entry for it (or can't be read).
 */
export async function ledgerSender(message: Message | null, agentId: string, at: number, sources: Pick<Sources, "ledger">): Promise<"tom" | "follow-up" | null> {
  try {
    const ledger = (await sources.ledger()).filter(l => l.agentId === agentId && !l.action);
    const ids = [message?.messageId, message?.clientMessageId].filter((id): id is string => !!id);
    const exact = ledger.find(l => l.messageId && ids.includes(l.messageId));
    if (exact) return exact.by === "developer" ? "tom" : "follow-up";
    const near = ledger.filter(l => Math.abs(Date.parse(l.at) - at) <= WINDOW_MS);
    if (!near.length) return null;
    return near.every(l => l.by === "developer") ? "tom" : "follow-up";
  } catch { return null; }
}

const near = (iso: unknown, at: number) => typeof iso === "string" && Number.isFinite(Date.parse(iso)) && Math.abs(Date.parse(iso) - at) <= WINDOW_MS;
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }

/**
 * The agent's reply that a finished turn reports (the Finished reason's detail). Follow-up's Stop hook can continue a
 * turn for bookkeeping; the reply after that ("The sidebar sync is done") answers Follow-up, not the developer, so it
 * never counts. Codex shows the hook prompt in the timeline (workItems drops it and what follows); Claude Code's is
 * hidden from Paseo's timeline, so the hook saves the reply it interrupted (`hook-state/bookkeeping-<agent>.json`),
 * which wins when it was written during this turn.
 */
export function finishedReply(items: readonly unknown[], saved: { at?: unknown; reply?: unknown } | null, turnStartedAt: number | null): string | null {
  if (saved && typeof saved.reply === "string" && saved.reply.trim() && typeof saved.at === "number" && (turnStartedAt === null || saved.at >= turnStartedAt)) return saved.reply;
  const reply = [...workItems(items)].reverse().find(i => (i as { type?: string })?.type === "assistant_message") as { text?: unknown } | undefined;
  return typeof reply?.text === "string" ? reply.text : null;
}

/** Readers over the other plugins' plugin-data. Unknown versions or shapes read as "not theirs". */
export function fileSources(paseoHome: string, ledger: () => Promise<Ledger>): Sources {
  const data = (...p: string[]) => join(paseoHome, "plugin-data", ...p);
  return {
    ledger,
    async defer(agentId, at) {
      const queue = await json(data("defer", "queue.json"));
      if (queue?.version !== 1 || !Array.isArray(queue.items)) return false;
      return queue.items.some((i: any) => i?.agentId === agentId && (near(i.settledAt, at) || i.state === "sending" && near(i.dueAt, at)));
    },
    async session(agentId, at) {
      const [compactions, guard] = await Promise.all([
        json(data("smart-session", "compactions.json")).catch(() => null),
        json(data("session-guard", "state.json")).catch(() => null),
      ]);
      const smart = compactions?.version === 1 && Array.isArray(compactions.items) && compactions.items.some((i: any) => i?.agentId === agentId && (near(i.settledAt, at) || near(i.resumedAt, at)));
      const resumed = guard?.version === 1 && Array.isArray(guard.pauses) && guard.pauses.some((p: any) => p?.agentId === agentId && ["resuming", "resumed"].includes(p.phase) && (near(p.settledAt, at) || p.phase === "resuming" && near(p.anchorResetsAt, at)));
      return !!(smart || resumed);
    },
    async schedule(agentId, at) {
      const directory = join(paseoHome, "schedules");
      const files = (await readdir(directory)).filter(f => f.endsWith(".json")).slice(0, 500);
      for (const file of files) {
        const s = await json(join(directory, file)).catch(() => null);
        if (!s || !Array.isArray(s.runs)) continue;
        const targeted = s.target?.type === "agent" && s.target.agentId === agentId;
        if (s.runs.some((r: any) => (r?.agentId === agentId || targeted) && near(r?.startedAt, at))) return true;
      }
      return false;
    },
  };
}

/**
 * The newest prompt in a timeline tail that isn't the harness's own text, with its sender read from the text. A
 * projected agent message (Paseo 0.15+ `agent_message` tool call) or schedule fire (`heartbeat`) counts as a prompt
 * from someone else, so nothing older behind it is taken for the developer's latest word.
 */
export function latestPrompt(items: unknown[]): { message: Message; sender: MessageSender } | { message: null; sender: "agent" | "schedule" } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: string; name?: string; callId?: string; text?: unknown; agentMessage?: unknown; messageId?: string; clientMessageId?: string } | null;
    if (!item || typeof item !== "object") continue;
    if (item.type === "user_message" && typeof item.text === "string") {
      const sender = messageSender(item.text);
      if (sender.kind === "system" && sender.source === "harness") continue;
      return { message: { text: item.text, messageId: item.messageId ?? null, clientMessageId: item.clientMessageId ?? null }, sender };
    }
    if (item.type === "tool_call" && (item.name === "agent_message" || item.agentMessage || item.callId?.startsWith("paseo-agent-message:"))) return { message: null, sender: "agent" };
    if (item.type === "tool_call" && item.name === "heartbeat" && item.callId?.startsWith("paseo-system:")) return { message: null, sender: "schedule" };
  }
  return null;
}

/**
 * What started the current turn, from the timeline tail (newest last). Paseo 0.15 projects an agent's message into a
 * completed `agent_message` tool call carrying its sender, and a schedule or heartbeat prompt into a `heartbeat` tool
 * call; only a developer's own words stay a user message. If the previous turn's output comes before any prompt, the
 * new prompt isn't in the tail yet: unknown, so nothing is answered on a guess.
 */
export function turnPrompt(items: unknown[]): { message: Message | null; from: "agent" | "schedule" | null } {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: string; name?: string; callId?: string; text?: unknown; agentMessage?: { text?: unknown }; messageId?: string; clientMessageId?: string } | null;
    if (!item || typeof item !== "object") continue;
    if (item.type === "user_message" && typeof item.text === "string") return { message: { text: item.text, messageId: item.messageId ?? null, clientMessageId: item.clientMessageId ?? null }, from: null };
    if (item.type === "tool_call" && (item.name === "agent_message" || item.agentMessage || item.callId?.startsWith("paseo-agent-message:"))) return { message: null, from: "agent" };
    if (item.type === "tool_call" && item.name === "heartbeat" && item.callId?.startsWith("paseo-system:")) return { message: null, from: "schedule" };
    if (item.type === "assistant_message" || item.type === "tool_call") return { message: null, from: null };
  }
  return { message: null, from: null };
}
