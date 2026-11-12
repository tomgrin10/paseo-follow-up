import type { PluginClientContext } from "@getpaseo/plugin/client";
import { overseerAskRpc, overseerRestartRpc, overseerStartRpc, overseerStatusRpc, prioritiesRpc, rankNowRpc, rankStatusRpc, usageRpc } from "../shared/contracts";
import type { RpcOutput } from "@getpaseo/plugin";
import type { Priority } from "../shared/priorities";
import { DEFAULT_SORT, isSortMode, type SortMode } from "../shared/sort";
import { homeSortSync } from "../shared/display";
import type { AgentLite } from "../shared/search";
import { NO_USAGE, USAGE_POLL_MS, type Usage } from "../shared/usage";
import { onVisible, whileVisible } from "./visibility";

/**
 * What Home adds on top of the inbox, live and Paseo stores (1.3.0-beta.2): the sort choice, external
 * priorities, agent titles for search, provider limits, and a "focus the search" signal for ⌘K and `/`.
 * One instance per client, shared by Home, the sidebar item and the sidebar view.
 */
/**
 * Before 2.1 the sort was kept per device under this key. It's now the Display setting `home_sort` (one order for Home
 * and the sidebar view, on every device, and agents set it with set_display). The key stays as this device's cache, so
 * the list opens in the right order before the setting arrives, and as the value the first device migrates.
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
  const sync = homeSortSync(client, () => sort, next => { sort = next; storage.set(SORT_KEY, next); });
  const writeSort = sync.write, readSort = sync.read;
  let priorities: Priority[] = [];
  let usage: Usage = NO_USAGE;
  let overseer: RpcOutput<typeof overseerStatusRpc> | null = null;
  let rank: RpcOutput<typeof rankStatusRpc> | null = null;
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
  // Nothing polls while the app is hidden; each poll runs once when it comes back (1.4.0).
  const runs: (() => Promise<void>)[] = [];
  const poll = (ms: number, work: () => Promise<boolean>) => {
    let waiting = false;
    const run = async () => {
      waiting = false;
      try { if (await work()) emit(); } catch { /* keep the last answer */ }
      if (stopped) return;
      const next = whileVisible(ms, () => void run());
      if (next) timers.push(next); else waiting = true;
    };
    runs.push(async () => { if (waiting) await run(); });
    void run();
  };
  const offVisible = onVisible(() => { for (const r of runs) void r(); });
  // Another device or an agent (set_display) changed the order: picked up within a minute, or on return.
  poll(PRIORITY_POLL_MS, readSort);
  poll(PRIORITY_POLL_MS, async () => {
    const next = (await client.rpc(prioritiesRpc, {})).items;
    if (JSON.stringify(next) === JSON.stringify(priorities)) return false;
    priorities = next; return true;
  });
  // The ranker's last run and source health, with the priorities (the ranker runs at most hourly).
  poll(PRIORITY_POLL_MS, async () => {
    const next = await client.rpc(rankStatusRpc, {});
    if (JSON.stringify(next) === JSON.stringify(rank)) return false;
    rank = next; return true;
  });
  poll(15_000, async () => {
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
  // Push for the inbox and live stores (1.4.0): an agent's status, attention or permissions changing is when Needs you
  // and the pills can change, so those stores re-read then instead of polling every few seconds.
  const activity = new Set<() => void>();
  const signatures = new Map<string, string>();
  const noteActivity = (a: unknown) => {
    const x = a as { id?: string; status?: string; requiresAttention?: boolean; attentionReason?: string | null; pendingPermissions?: unknown[]; archivedAt?: string | null } | undefined;
    if (!x?.id) return;
    const signature = [x.status, x.requiresAttention, x.attentionReason, x.pendingPermissions?.length ?? 0, x.archivedAt].join("|");
    const prior = signatures.get(x.id); signatures.set(x.id, signature);
    if (prior !== undefined && prior !== signature) for (const l of activity) l();
  };
  const unsubscribe = client.paseo.agents.subscribe(update => {
    const u = update as { kind: string; agent?: AgentEntry["agent"]; agentId?: string };
    if (u.kind === "remove") { if (u.agentId && agents.delete(u.agentId)) emitSoon(); if (u.agentId) signatures.delete(u.agentId); for (const l of activity) l(); }
    else { putAgent(u.agent); noteActivity(u.agent); }
  });
  let release: (() => Promise<void>) | null = null;
  void (async () => {
    const page = await client.paseo.agents.list({ subscribe: {}, page: { limit: 200 } });
    if (stopped) { await page.subscription.release(); return; }
    release = () => page.subscription.release();
    (page.entries as AgentEntry[]).forEach(e => { putAgent(e.agent); noteActivity(e.agent); });
    let cursor = page.pageInfo.nextCursor;
    for (let i = 0; cursor && !stopped && i < 20; i++) {
      const next = await client.paseo.agents.list({ page: { limit: 200, cursor } });
      (next.entries as AgentEntry[]).forEach(e => { putAgent(e.agent); noteActivity(e.agent); });
      if (next.pageInfo.nextCursor === cursor) break;
      cursor = next.pageInfo.nextCursor;
    }
  })().catch(() => undefined);

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    sort: () => sort,
    /** Home's and the sidebar view's order: shown at once, saved as the Display setting `home_sort`. */
    setSort(next: SortMode) { if (next === sort) return; sort = next; storage.set(SORT_KEY, next); emit(); void writeSort(next).catch(() => undefined); },
    priorities: () => priorities,
    usage: () => usage,
    /** The ranker: on or off, its last run and which sources it could read. */
    rank: () => rank,
    /**
     * "Re-rank now": starts the ranker (the RPC returns at once), then polls its status every 3 s until it's done,
     * refreshes priorities and answers with the run's outcome. Gives up waiting after 6 minutes; the run goes on.
     */
    async rankNow(): Promise<{ ok: boolean; skipped: string | null; error: string | null; top: { title: string }[] }> {
      await client.rpc(rankNowRpc, { force: true });
      rank = rank ? { ...rank, running: true } : rank; emit();
      let st = rank;
      for (let i = 0; i < 120 && !stopped; i++) {
        await new Promise(r => setTimeout(r, 3000));
        st = await client.rpc(rankStatusRpc, {}).catch(() => st);
        if (st && !st.running) break;
      }
      const p = await client.rpc(prioritiesRpc, {}).catch(() => null);
      if (p) priorities = p.items; if (st) rank = st; emit();
      if (st?.running) return { ok: true, skipped: "busy", error: null, top: [] };
      const last = st?.last;
      // A run that was already going when the click came has finished too: report its outcome, not "busy".
      return { ok: !!last?.ok, skipped: last?.skipped ?? null, error: last?.ok ? null : st?.error ?? null, top: last?.top ? [{ title: last.top }] : [] };
    },
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
    /** Calls `listener` when an agent's status, attention or permissions change (see above). */
    onActivity(listener: () => void) { activity.add(listener); return () => { activity.delete(listener); }; },
    async stop() { stopped = true; offVisible(); activity.clear(); for (const t of timers) clearTimeout(t); if (pending) clearTimeout(pending); listeners.clear(); unsubscribe(); await release?.(); },
  };
}
export type HomeExtras = ReturnType<typeof createHomeExtras>;
