import { join } from "node:path";
import { pages, withDaemon, type Agent } from "./daemon";
import type { AgentInfo, Directory } from "./inbox";

type Snapshot = Agent & { updatedAt?: string; parentAgentId?: string | null; requiresAttention?: boolean; attentionReason?: string | null };
const info = (a: Snapshot): AgentInfo => ({
  id: a.id, workspaceId: a.workspaceId ?? null, parentAgentId: a.parentAgentId ?? a.labels?.["paseo.parent-agent-id"] ?? null,
  title: a.title ?? null, status: a.status, archivedAt: a.archivedAt ?? null, updatedAt: a.updatedAt ?? null,
  lastUserMessageAt: a.lastUserMessageAt ?? null, requiresAttention: !!a.requiresAttention, attentionReason: a.attentionReason ?? null,
});

/** The daemon as the inbox sees it. One connection reads agents and workspaces together, cached briefly. */
export function daemonDirectory(connect: typeof withDaemon = withDaemon): Directory {
  let cached: { at: number; value: Promise<{ agents: AgentInfo[]; workspaces: { id: string; name: string }[] }> } | null = null;
  const all = () => {
    if (cached && Date.now() - cached.at < 2_000) return cached.value;
    const value = connect(async client => {
      const [agents, workspaces] = await Promise.all([
        pages(cursor => client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } })),
        pages(cursor => client.fetchWorkspaces({ page: { limit: 100, ...(cursor ? { cursor } : {}) } })),
      ]);
      return { agents: agents.map(row => info(row.agent as Snapshot)), workspaces: workspaces.filter(w => !w.archivingAt).map(w => ({ id: w.id, name: w.name })) };
    });
    cached = { at: Date.now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
    return value;
  };
  return {
    agents: async () => (await all()).agents,
    workspaces: async () => (await all()).workspaces,
    async agent(id) {
      const known = cached ? (await cached.value.catch(() => null))?.agents.find(a => a.id === id) : undefined;
      if (known) return known;
      return connect(async client => { const row = await client.fetchAgent(id); return row ? info(row.agent as Snapshot) : null; });
    },
    async tail(id, limit) {
      return connect(async client => {
        const page = await client.fetchAgentTimeline(id, { direction: "tail", limit, projection: "canonical", timeout: 10_000 });
        return [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
      });
    },
    async clearAttention(ids) { await connect(async client => { await client.clearAgentAttention?.(ids); }); },
  };
}

export const guardPath = (paseoHome: string) => join(paseoHome, "plugin-data", "session-guard", "state.json");
