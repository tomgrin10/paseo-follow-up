import { join } from "node:path";
import { withDaemon, type Agent } from "./daemon";
import { DaemonDirectory } from "./directory";
import type { AgentInfo, Directory } from "./inbox";
import { isLoaded } from "./agent-load";

type Snapshot = Agent & { updatedAt?: string; parentAgentId?: string | null; requiresAttention?: boolean; attentionReason?: string | null; attentionTimestamp?: string | null };
const info = (a: Snapshot): AgentInfo => ({
  id: a.id, workspaceId: a.workspaceId ?? null, parentAgentId: a.parentAgentId ?? a.labels?.["paseo.parent-agent-id"] ?? null,
  title: a.title ?? null, status: a.status, archivedAt: a.archivedAt ?? null, updatedAt: a.updatedAt ?? null,
  lastUserMessageAt: a.lastUserMessageAt ?? null, requiresAttention: !!a.requiresAttention, attentionReason: a.attentionReason ?? null,
  attentionTimestamp: a.attentionTimestamp ?? null, createdAt: a.createdAt ?? null,
  pendingPermissionIds: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.flatMap(p => typeof (p as { id?: unknown })?.id === "string" ? [(p as { id: string }).id] : []) : null,
});

/**
 * The daemon as the inbox sees it: the shared directory (see DaemonDirectory), so Home, the panel and the inbox
 * loop never list agents or workspaces on their own.
 */
export function daemonDirectory(shared: DaemonDirectory = new DaemonDirectory(), connect: typeof withDaemon = withDaemon): Directory {
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
    async tail(id, limit) {
      return connect(async client => {
        // Called from turn hooks, so the agent is normally live. Never wake one that isn't.
        const row = await client.fetchAgent(id);
        if (!isLoaded(row?.agent)) return [];
        const page = await client.fetchAgentTimeline(id, { direction: "tail", limit, projection: "canonical", timeout: 10_000 });
        return [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
      });
    },
    async clearAttention(ids) { await connect(async client => { await client.clearAgentAttention?.(ids); }); },
  };
}

export const guardPath = (paseoHome: string) => join(paseoHome, "plugin-data", "session-guard", "state.json");
