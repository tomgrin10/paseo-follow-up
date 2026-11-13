import { join } from "node:path";
import { withDaemon, type Agent } from "./daemon";
import { DaemonDirectory } from "./directory";
import type { AgentInfo, Directory } from "./inbox";
import { backgroundCount, isLoaded, liveStatus } from "./agent-load";

type Snapshot = Agent & { updatedAt?: string; parentAgentId?: string | null; requiresAttention?: boolean; attentionReason?: string | null; attentionTimestamp?: string | null };
const info = (a: Snapshot): AgentInfo => ({
  id: a.id, workspaceId: a.workspaceId ?? null, parentAgentId: a.parentAgentId ?? a.labels?.["paseo.parent-agent-id"] ?? null,
  title: a.title ?? null, status: liveStatus(a), archivedAt: a.archivedAt ?? null, updatedAt: a.updatedAt ?? null,
  lastUserMessageAt: a.lastUserMessageAt ?? null, requiresAttention: !!a.requiresAttention, attentionReason: a.attentionReason ?? null,
  attentionTimestamp: a.attentionTimestamp ?? null, createdAt: a.createdAt ?? null, ...(a.background === true ? { background: true } : {}),
  ...(backgroundCount(a) ? { backgroundWork: backgroundCount(a) } : {}),
  pendingPermissionIds: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.flatMap(p => typeof (p as { id?: unknown })?.id === "string" ? [(p as { id: string }).id] : []) : null,
});

/**
 * The daemon as the inbox sees it: the shared directory (see DaemonDirectory), so Home, the panel and the inbox
 * loop never list agents or workspaces on their own.
 */
/**
 * A turn end's timeline read (a-turn-end-reads-the-turn-once). 2026-11-13: every turn end read the newest 100 entries
 * for the engine and another 20 for the inbox, then discovery re-read them; with live-sized items (8 KB tool output)
 * that was ~1 MB parsed per turn, most of it older turns. Both readers now share one read of the turn itself.
 */
export const TURN_PAGE = 25;
/** The engine's old fixed tail: a turn longer than this is read only this far back, as before. */
export const TURN_READ_CAP = 100;
/** How long the engine's and the inbox's handlers of one turn end share the read (they run on the same event). */
const TURN_READ_SHARE_MS = 10_000;
const startsTurn = (item: unknown): boolean => {
  const i = item as { type?: string; name?: string; callId?: string; agentMessage?: unknown } | null;
  return !!i && (i.type === "user_message" || i.type === "tool_call" && (i.name === "agent_message" || !!i.agentMessage || !!i.callId?.startsWith("paseo-agent-message:") || i.name === "heartbeat" && !!i.callId?.startsWith("paseo-system:")));
};

export function daemonDirectory(shared: DaemonDirectory = new DaemonDirectory(), connect: typeof withDaemon = withDaemon): Directory {
  const turnReads = new Map<string, Promise<unknown[]>>();
  const all = async () => {
    const rows = await shared.read();
    return { agents: rows.agents.map(row => info(row.agent as Snapshot)), workspaces: rows.workspaces.filter(w => !w.archivingAt).map(w => ({ id: w.id, name: w.name })) };
  };
  return {
    agents: async () => (await all()).agents,
    workspaces: async () => (await all()).workspaces,
    async agent(id) {
      await shared.read().catch(() => null);
      const known = shared.cached(id);
      if (known) return info(known as Snapshot);
      return connect(async client => { const agent = await shared.live(client, id); return agent ? info(agent as Snapshot) : null; });
    },
    turnItems(id, turnId) {
      const key = `${id}:${turnId ?? ""}`;
      const known = turnReads.get(key);
      if (known) return known;
      const read = connect(async client => {
        const agent = shared.cached(id) ?? (await client.fetchAgent(id))?.agent;
        if (!isLoaded(agent)) return [];
        // Newest first, a small page at a time, back to the item that started the turn (the developer's or an agent's
        // message, a schedule), never past TURN_READ_CAP: what the turn-end readers use, not a fixed page of 100.
        const entries: { item: unknown; seqStart: number }[] = []; let cursor: { epoch: string; seq: number } | null = null;
        while (entries.length < TURN_READ_CAP) {
          const page = await client.fetchAgentTimeline(id, { direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: Math.min(TURN_PAGE, TURN_READ_CAP - entries.length), projection: "canonical", timeout: 10_000 });
          if (page.error) throw new Error(page.error);
          entries.push(...page.entries);
          if (page.entries.some(e => startsTurn(e.item)) || !page.hasOlder || !page.startCursor) break;
          cursor = page.startCursor;
        }
        return entries.sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
      });
      turnReads.set(key, read);
      const forget = () => setTimeout(() => turnReads.delete(key), TURN_READ_SHARE_MS).unref?.();
      read.then(forget, forget);
      return read;
    },
    async tail(id, limit) {
      return connect(async client => {
        // Called from turn hooks, so the agent is normally live. Never wake one that isn't. The directory row, patched
        // by the turn event that called this, answers without a fetch_agent per turn (a-send-lists-agents-at-most-once-per-tick).
        const agent = shared.cached(id) ?? (await client.fetchAgent(id))?.agent;
        if (!isLoaded(agent)) return [];
        const page = await client.fetchAgentTimeline(id, { direction: "tail", limit, projection: "canonical", timeout: 10_000 });
        return [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
      });
    },
    async clearAttention(ids) { await connect(async client => { await client.clearAgentAttention?.(ids); }); },
  };
}

export const guardPath = (paseoHome: string) => join(paseoHome, "plugin-data", "session-guard", "state.json");
