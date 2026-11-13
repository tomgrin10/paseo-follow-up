import { join } from "node:path";
import { withDaemon, type Agent } from "./daemon";
import { DaemonDirectory } from "./directory";
import type { AgentInfo, Directory } from "./inbox";
import { backgroundCount, isLoaded, liveStatus } from "./agent-load";
import { TurnTimeline } from "./turn-timeline";

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
export { TURN_PAGE, TURN_READ_CAP } from "./turn-timeline";
/** How long the engine's and the inbox's handlers of one turn end share the read (they run on the same event). */
const TURN_READ_SHARE_MS = 10_000;

export function daemonDirectory(shared: DaemonDirectory = new DaemonDirectory(), connect: typeof withDaemon = withDaemon, timeline = new TurnTimeline()): Directory {
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
        // The turn since its start's read, from the agent's cursor (a-turn-s-timeline-is-read-once, turn-timeline.ts).
        return timeline.ended(client, id);
      });
      turnReads.set(key, read);
      const forget = () => setTimeout(() => turnReads.delete(key), TURN_READ_SHARE_MS).unref?.();
      read.then(forget, forget);
      return read;
    },
    async turnStart(id) {
      return connect(async client => {
        // Called from the turn start hook: the directory row answers whether the agent is loaded (never wake one).
        const agent = shared.cached(id) ?? (await client.fetchAgent(id))?.agent;
        if (!isLoaded(agent)) return [];
        return timeline.started(client, id);
      });
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
