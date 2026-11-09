import type { PluginClientContext } from "@getpaseo/plugin/client";
import { overseerAskRpc, overseerRestartRpc, overseerStartRpc, overseerStatusRpc, prioritiesRpc, usageRpc } from "../shared/contracts";
import type { RpcOutput } from "@getpaseo/plugin";
import type { Priority } from "../shared/priorities";
import { DEFAULT_SORT, isSortMode, type SortMode } from "../shared/sort";
import type { AgentLite } from "../shared/search";
import { NO_USAGE, USAGE_POLL_MS, type Usage } from "../shared/usage";

/**
 * What Home adds on top of the inbox, live and Paseo stores (1.3.0-beta.2): the sort choice (per device), external
 * priorities, agent titles for search, provider limits, and a "focus the search" signal for ⌘K and `/`.
 * One instance per client, shared by Home, the sidebar item and the sidebar view.
 */
const SORT_KEY = "follow-up.home.sort";
const PRIORITY_POLL_MS = 60_000;

/** Per-device storage where the host has it (web, desktop). Native or blocked storage: memory only. */
const storage = {
  get(key: string): string | null { try { return (globalThis as { localStorage?: Storage }).localStorage?.getItem(key) ?? null; } catch { return null; } },
  set(key: string, value: string) { try { (globalThis as { localStorage?: Storage }).localStorage?.setItem(key, value); } catch { /* memory only */ } },
};

type AgentEntry = { agent?: { id?: string; title?: string | null; workspaceId?: string | null; archivedAt?: string | null } };

export function createHomeExtras(client: PluginClientContext) {
  const saved = storage.get(SORT_KEY);
  let sort: SortMode = isSortMode(saved) ? saved : DEFAULT_SORT;
  let priorities: Priority[] = [];
  let usage: Usage = NO_USAGE;
  let overseer: RpcOutput<typeof overseerStatusRpc> | null = null;
  const agents = new Map<string, AgentLite>();
  let version = 0;
  let focusToken = 0;
  let stopped = false;
  const listeners = new Set<() => void>();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const emit = () => { version++; for (const l of listeners) l(); };
  // Agent updates arrive in bursts (every status change); only title or workspace changes matter, coalesced.
  const emitSoon = () => { if (pending) return; pending = setTimeout(() => { pending = null; emit(); }, 250); };

  const timers: ReturnType<typeof setTimeout>[] = [];
  const poll = (ms: number, work: () => Promise<boolean>) => {
    const run = async () => { try { if (await work()) emit(); } catch { /* keep the last answer */ } if (!stopped) timers.push(setTimeout(() => void run(), ms)); };
    void run();
  };
  poll(PRIORITY_POLL_MS, async () => {
    const next = (await client.rpc(prioritiesRpc, {})).items;
    if (JSON.stringify(next) === JSON.stringify(priorities)) return false;
    priorities = next; return true;
  });
  poll(10_000, async () => {
    const next = await client.rpc(overseerStatusRpc, {});
    if (JSON.stringify(next) === JSON.stringify(overseer)) return false;
    overseer = next; return true;
  });
  poll(USAGE_POLL_MS, async () => {
    const next = await client.rpc(usageRpc, {});
    if (JSON.stringify(next) === JSON.stringify(usage)) return false;
    usage = next; return true;
  });

  const putAgent = (a: AgentEntry["agent"]) => {
    if (!a?.id) return;
    if (a.archivedAt) { if (agents.delete(a.id)) emitSoon(); return; }
    const prior = agents.get(a.id);
    const next = { id: a.id, title: a.title ?? null, workspaceId: a.workspaceId ?? null };
    if (prior && prior.title === next.title && prior.workspaceId === next.workspaceId) return;
    agents.set(a.id, next); emitSoon();
  };
  const unsubscribe = client.paseo.agents.subscribe(update => {
    const u = update as { kind: string; agent?: AgentEntry["agent"]; agentId?: string };
    if (u.kind === "remove") { if (u.agentId && agents.delete(u.agentId)) emitSoon(); }
    else putAgent(u.agent);
  });
  let release: (() => Promise<void>) | null = null;
  void (async () => {
    const page = await client.paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
    if (stopped) { await page.subscription.release(); return; }
    release = () => page.subscription.release();
    (page.entries as AgentEntry[]).forEach(e => putAgent(e.agent));
    let cursor = page.pageInfo.nextCursor;
    for (let i = 0; cursor && !stopped && i < 20; i++) {
      const next = await client.paseo.agents.list({ page: { limit: 200, cursor } });
      (next.entries as AgentEntry[]).forEach(e => putAgent(e.agent));
      if (next.pageInfo.nextCursor === cursor) break;
      cursor = next.pageInfo.nextCursor;
    }
  })().catch(() => undefined);

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    sort: () => sort,
    setSort(next: SortMode) { if (next === sort) return; sort = next; storage.set(SORT_KEY, next); emit(); },
    priorities: () => priorities,
    usage: () => usage,
    /** The Overseer: off, not started yet, or its agent and workspace. */
    overseer: () => overseer,
    async startOverseer() { overseer = await client.rpc(overseerStartRpc, {}); emit(); return overseer; },
    /** Sends the omnibox's ask to the Overseer, starting it on first use. */
    async askOverseer(text: string) { overseer = await client.rpc(overseerAskRpc, { text }); emit(); return overseer; },
    /** Settings → Agents changed: a new Overseer on the configured agent, handed the old one's last steps. */
    async restartOverseer() { overseer = await client.rpc(overseerRestartRpc, {}); emit(); return overseer; },
    agents: () => [...agents.values()],
    /** Bumped by ⌘K "Follow-up: Search"; the visible search field focuses when it changes. */
    focusToken: () => focusToken,
    focusSearch() { focusToken++; emit(); },
    async stop() { stopped = true; for (const t of timers) clearTimeout(t); if (pending) clearTimeout(pending); listeners.clear(); unsubscribe(); await release?.(); },
  };
}
export type HomeExtras = ReturnType<typeof createHomeExtras>;
