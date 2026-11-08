import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Who sent the message that started a turn (design §2.4). Paseo's hooks carry no origin yet, so
 * this checks known senders in order and falls back to the developer. Every reader is read-only and
 * fails open: an unknown or unreadable format means "the developer wrote it", which clears a flag
 * rather than leaving noise.
 */
export type Sender = "agent" | "follow-up" | "defer" | "session" | "schedule" | "tom";
export type Message = { text: string; messageId?: string | null; clientMessageId?: string | null };
export type Ledger = { agentId: string; messageId: string | null; at: string; by?: "follow-up" | "developer" }[];
export type Sources = {
  /** Follow-up's own delivery ledger, written before each send. */
  ledger: () => Promise<Ledger>;
  defer: (agentId: string, at: number) => Promise<boolean>;
  session: (agentId: string, at: number) => Promise<boolean>;
  schedule: (agentId: string, at: number) => Promise<boolean>;
};
export const WINDOW_MS = 10_000;

const ENVELOPE = /^\s*<paseo-system\b[^>]*\bkind="(agent-message|agent-notification)"/;

export async function classify(message: Message | null, agentId: string, at: number, sources: Sources): Promise<Sender> {
  if (message && ENVELOPE.test(message.text)) return "agent";
  const safe = async (check: () => Promise<boolean>) => { try { return await check(); } catch { return false; } };
  // Follow-up's own sends are automation, except a brief option or move the developer clicked: that is their message.
  const own = await (async () => {
    try {
      const ledger = (await sources.ledger()).filter(l => l.agentId === agentId);
      const ids = [message?.messageId, message?.clientMessageId].filter((id): id is string => !!id);
      const exact = ledger.find(l => l.messageId && ids.includes(l.messageId));
      if (exact) return exact.by === "developer" ? "tom" as const : "follow-up" as const;
      const near = ledger.filter(l => Math.abs(Date.parse(l.at) - at) <= WINDOW_MS);
      if (!near.length) return null;
      return near.every(l => l.by === "developer") ? "tom" as const : "follow-up" as const;
    } catch { return null; }
  })();
  if (own) return own;
  if (await safe(() => sources.defer(agentId, at))) return "defer";
  if (await safe(() => sources.session(agentId, at))) return "session";
  if (await safe(() => sources.schedule(agentId, at))) return "schedule";
  return "tom";
}

const near = (iso: unknown, at: number) => typeof iso === "string" && Number.isFinite(Date.parse(iso)) && Math.abs(Date.parse(iso) - at) <= WINDOW_MS;
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }

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

/** The newest user message in a timeline tail, or null when the turn started without one. */
export function newestUserMessage(items: unknown[]): Message | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: string; text?: unknown; messageId?: string; clientMessageId?: string } | null;
    if (item?.type === "user_message" && typeof item.text === "string") return { text: item.text, messageId: item.messageId ?? null, clientMessageId: item.clientMessageId ?? null };
  }
  return null;
}
