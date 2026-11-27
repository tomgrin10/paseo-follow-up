import type { DispatchRecord } from "../shared/dispatch";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ImageUpload } from "../shared/images";
import { contextAskRpc, contextListRpc, questionActionRpc, dispatchRecordsRpc, displayFeed, homeFeed, queueNeedsSchema, overseerAskRpc, overseerRestartRpc, overseerStartRpc, overseerStatusRpc, prioritiesRpc, prStatsSettingsRpc, rankNowRpc, rankStatusRpc, usageRpc } from "../shared/contracts";
import { openFeed } from "./feeds";
import { sharedRead, USAGE_SHARED_MS } from "./shared-read";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Priority } from "../shared/priorities";
import { DEFAULT_SORT, isSortMode, type SortMode } from "../shared/sort";
import { displayRpc, homeSortSync, writeDisplay } from "../shared/display";
import { DEFAULT_HOME_VIEW, parseHomeView, type HomeView } from "../shared/home-arrange";
import type { AgentLite } from "../shared/search";
import { NO_USAGE, USAGE_POLL_MS, type Usage } from "../shared/usage";
import type { z } from "zod";

export type QueueNeeds = z.infer<typeof queueNeedsSchema>;
const NO_QUEUE: QueueNeeds = { needs: [], timeZone: "UTC", revision: "" };
import { onVisible, whileVisible } from "./visibility";
import { createWebSearchFocus } from "./search-focus";
import type { ContextRequest } from "../shared/catch-up";

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
/** This device's copy of the Display setting `home_view`, so the list opens arranged before the setting arrives. */
const VIEW_KEY = "follow-up.home.view";
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
  let view: HomeView = (() => { try { const v = storage.get(VIEW_KEY); return v ? parseHomeView(JSON.parse(v)) : DEFAULT_HOME_VIEW; } catch { return DEFAULT_HOME_VIEW; } })();
  const keepView = (next: HomeView) => { view = next; storage.set(VIEW_KEY, JSON.stringify(next)); };
  const sync = homeSortSync(client, () => sort, next => { sort = next; storage.set(SORT_KEY, next); }, { current: () => view, adopt: keepView });
  // The order's read joins the other modules' Display read at mount (sharedRead); a write never goes through it.
  const writeSort = sync.write, readSort = () => sharedRead("settings.display.read", () => client.rpc(displayRpc.read, {})).then(doc => sync.apply(doc as { status: string; values?: unknown }));
  // Ranker runs this client started ("Re-rank now"), resolved when the feed says the run is over.
  const rankWaiters = new Set<() => void>();
  let priorities: Priority[] = [];
  let usage: Usage = NO_USAGE;
  let overseer: RpcOutput<typeof overseerStatusRpc> | null = null;
  let rank: RpcOutput<typeof rankStatusRpc> | null = null;
  /** Catch up's More context asks: pushed on the home feed; read when Catch up opens or moves, never on a timer of their own. */
  let context: ContextRequest[] = [];
  /** New's recent dispatches, pushed on the home feed (Home's row); nothing reads them on a timer. */
  let dispatches: DispatchRecord[] = [];
  /** Whether any repository has PR statistics: Home's PR stats icon. Pushed on the home feed; on 0.15, read once at start. */
  let prStatsOn = false;
  /**
   * The raised Linear issues in Needs you (Q8) and the queue's revision: the worker's one answer, pushed on the home
   * feed (on 0.15, carried by the priorities poll). Home's model, the sidebar badge and the brief pane all read it.
   */
  let queue: QueueNeeds = NO_QUEUE;
  /** Each workspace's first live Compass note as one line (Home rows, Catch up), from the worker with the priorities. */
  let compass: Record<string, string> = {};
  const setCompass = (next: Record<string, string> | undefined) => { if (!next || JSON.stringify(next) === JSON.stringify(compass)) return false; compass = next; return true; };
  const setQueue = (next: QueueNeeds | undefined) => { if (!next || JSON.stringify(next) === JSON.stringify(queue)) return false; queue = next; return true; };
  const setContext = (next: ContextRequest[]) => { if (JSON.stringify(next) === JSON.stringify(context)) return false; context = next; return true; };
  const readContext = async () => setContext((await client.rpc(contextListRpc, {})).requests);
  const agents = new Map<string, AgentLite>();
  let version = 0;
  let stopped = false;
  const listeners = new Set<() => void>();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const emit = () => { version++; for (const l of listeners) l(); };
  // Agent updates arrive in bursts (every status change); only title or workspace changes matter, coalesced.
  const emitSoon = () => { if (pending) return; pending = setTimeout(() => { pending = null; emit(); }, 250); };

  // One pending timer per poll (it used to append one per run and never drop it: about 8 a minute for an open Home).
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Nothing polls while the app is hidden; each poll runs once when it comes back (1.4.0).
  const runs = new Set<() => Promise<void>>();
  /** Polls `work` every `ms` until the returned stop is called. */
  const poll = (ms: number, work: () => Promise<boolean>) => {
    let waiting = false; let off = false; let next: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      waiting = false;
      try { if (await work()) emit(); } catch { /* keep the last answer */ }
      if (stopped || off) return;
      next = whileVisible(ms, () => { if (next) timers.delete(next); next = null; void run(); });
      if (next) timers.add(next); else waiting = true;
    };
    const wake = async () => { if (waiting && !off) await run(); };
    runs.add(wake);
    void run();
    return () => { off = true; runs.delete(wake); if (next) { clearTimeout(next); timers.delete(next); next = null; } };
  };
  const searchFocus = createWebSearchFocus();
  const offSearchFocus = searchFocus.install();
  const offVisible = onVisible(() => { for (const r of runs) void r(); });
  const together = (stops: (() => void)[]) => () => { for (const s of stops) s(); };
  const readRank = async () => {
    const next = await client.rpc(rankStatusRpc, {});
    if (!next.running) { for (const done of rankWaiters) done(); rankWaiters.clear(); }
    if (JSON.stringify(next) === JSON.stringify(rank)) return false;
    rank = next; return true;
  };
  // Paseo 0.15, or while a feed is down. Another device or an agent (set_display) changed the order: picked up within a
  // minute, or on return.
  const pollSort = () => poll(PRIORITY_POLL_MS, readSort);
  const pollHome = () => together([
    poll(PRIORITY_POLL_MS, async () => {
      const answer = await client.rpc(prioritiesRpc, {});
      // Set every store the answer carries: `a() || b()` skips b once a changed (a Compass line hid Nobody's on it).
      const compassMoved = setCompass(answer.compass), queueMoved = setQueue(answer.queue);
      const queued = compassMoved || queueMoved;
      if (JSON.stringify(answer.items) === JSON.stringify(priorities)) return queued;
      priorities = answer.items; return true;
    }),
    // The ranker's last run and source health, with the priorities (the ranker runs at most hourly).
    poll(PRIORITY_POLL_MS, readRank),
    poll(15_000, async () => {
      const next = await client.rpc(overseerStatusRpc, {});
      // Without the feed, an ask still open is read on the Overseer's existing poll: no poll of its own.
      const asked = context.some(r => r.state === "asking") ? await readContext().catch(() => false) : false;
      if (JSON.stringify(next) === JSON.stringify(overseer)) return asked;
      overseer = next; return true;
    }),
    pollUsage(),
  ]);
  const pollUsage = () => poll(USAGE_POLL_MS, async () => {
    const next = await sharedRead("follow.usage", () => client.rpc(usageRpc, {}), USAGE_SHARED_MS);
    if (JSON.stringify(next) === JSON.stringify(usage)) return false;
    usage = next; return true;
  });
  let homePolls: (() => void) | null = null, sortPolls: (() => void) | null = null, usagePolls: (() => void) | null = null;
  // Paseo 0.16: the worker pushes priorities, the ranker, the Overseer, the meters and the Display setting
  // (follow.home-feed, follow.display-feed); nothing polls. Opening reads the order once (it migrates this device's old
  // choice) and the meters once, for the worker's live resources, which the feed leaves out. A feed that goes down (the
  // worker restarted) polls its part until it is back (client/feeds.ts).
  const home = openFeed(client, homeFeed, {}, {
    event: event => {
      if (stopped) return;
      priorities = event.priorities; rank = event.rank; overseer = event.overseer;
      if (event.context) setContext(event.context);
      if (event.dispatches) dispatches = event.dispatches;
      if (event.prStats !== undefined) prStatsOn = event.prStats;
      setQueue(event.queue); setCompass(event.compass);
      if (event.usage) usage = { ...event.usage, resources: usage.resources };
      if (!event.rank.running) { for (const done of rankWaiters) done(); rankWaiters.clear(); }
      // Smart Session's files can't be watched: read the meters once a minute instead.
      if (!event.usageLive && !usagePolls) usagePolls = pollUsage();
      if (event.usageLive && usagePolls) { usagePolls(); usagePolls = null; }
      emit();
    },
    down: () => { if (usagePolls) { usagePolls(); usagePolls = null; } homePolls ??= pollHome(); },
    up: () => { homePolls?.(); homePolls = null; },
  });
  const display = home ? openFeed(client, displayFeed, {}, {
    event: doc => { if (!stopped) void sync.apply(doc).then(changed => { if (changed) emit(); }); },
    down: () => { sortPolls ??= pollSort(); },
    up: () => { sortPolls?.(); sortPolls = null; },
  }) : null;
  const stopFeeds = () => { home?.stop(); display?.stop(); for (const off of [homePolls, sortPolls, usagePolls]) off?.(); homePolls = sortPolls = usagePolls = null; };
  if (home) {
    // The Display feed's first event is the document (ValueFeed sends the current value first), so the order and the
    // old-choice migration apply from it (sync.apply): no read of its own at open (one-read-per-key-at-mount).
    void sharedRead("follow.usage", () => client.rpc(usageRpc, {}), USAGE_SHARED_MS).then(next => { usage = { ...next, accounts: usage.accounts.length ? usage.accounts : next.accounts }; emit(); }).catch(() => undefined);
  } else {
    homePolls = pollHome(); sortPolls = pollSort();
    // 0.15 (no home feed): whether Home shows the PR stats icon, read once when the app starts (Settings' read; no poll).
    void client.rpc(prStatsSettingsRpc, {}).then(v => { const on = v.repos.some(r => r.state !== "off"); if (on !== prStatsOn) { prStatsOn = on; emit(); } }).catch(() => undefined);
  }
  // Without the feed (Paseo 0.15, or while it's down) New's dispatches are read once now and when New closes
  // (refreshDispatches), never on a timer: they only change when someone starts one.
  const readDispatches = () => client.rpc(dispatchRecordsRpc, {}).then(r => {
    if (stopped || JSON.stringify(r.records) === JSON.stringify(dispatches)) return;
    dispatches = r.records; emit();
  }).catch(() => undefined);
  if (!home) void readDispatches();

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
  // Per-agent listeners (the chat's created-agent cards): Paseo's own agent stream, so a card's state costs no RPC.
  const agentWatchers = new Map<string, Set<(agent: unknown) => void>>();
  const unsubscribe = client.paseo.agents.subscribe(update => {
    const u = update as { kind: string; agent?: AgentEntry["agent"]; agentId?: string };
    const watchers = agentWatchers.get(u.agent?.id ?? u.agentId ?? "");
    if (watchers) for (const w of watchers) w(u.kind === "remove" ? null : u.agent);
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
    /** Grouping, Title, Show, the filters and Show background (shared/home-arrange.ts), for Home and the sidebar view. */
    view: () => view,
    /** Shown at once, saved as the Display setting `home_view`. */
    setView(patch: Partial<HomeView>) {
      const next = parseHomeView({ ...view, ...patch });
      if (JSON.stringify(next) === JSON.stringify(view)) return;
      keepView(next); emit(); void writeDisplay(client, { home_view: next }).catch(() => undefined);
    },
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
      if (home?.live) {
        // The feed pushes the run's end with its priorities; no status loop. A run that was over before the push
        // (skipped at once) is caught by one status read.
        const ended = new Promise<void>(resolve => { const t = setTimeout(() => { rankWaiters.delete(done); resolve(); }, 6 * 60_000); const done = () => { clearTimeout(t); resolve(); }; rankWaiters.add(done); });
        const now = await client.rpc(rankStatusRpc, {}).catch(() => null);
        if (now && !now.running) { rank = now; for (const done of rankWaiters) done(); rankWaiters.clear(); emit(); }
        await ended;
        st = rank;
      } else {
        for (let i = 0; i < 120 && !stopped; i++) {
          await new Promise(r => setTimeout(r, 3000));
          st = await client.rpc(rankStatusRpc, {}).catch(() => st);
          if (st && !st.running) break;
        }
        const p = await client.rpc(prioritiesRpc, {}).catch(() => null);
        if (p) priorities = p.items; if (st) rank = st; emit();
      }
      if (st?.running) return { ok: true, skipped: "busy", error: null, top: [] };
      const last = st?.last;
      // A run that was already going when the click came has finished too: report its outcome, not "busy".
      return { ok: !!last?.ok, skipped: last?.skipped ?? null, error: last?.ok ? null : st?.error ?? null, top: last?.top ? [{ title: last.top }] : [] };
    },
    /** The Overseer: off, not started yet, or its agent and workspace. */
    overseer: () => overseer,
    async startOverseer() { overseer = await client.rpc(overseerStartRpc, {}); emit(); return overseer; },
    /** Sends the omnibox's ask to the Overseer, starting it on first use. */
    async askOverseer(text: string, images?: ImageUpload[]) { overseer = await client.rpc(overseerAskRpc, { text, ...(images?.length ? { images } : {}) }); emit(); return overseer; },
    /** Settings → Agents changed: a new Overseer on the configured agent, handed the old one's last steps. */
    async restartOverseer() { overseer = await client.rpc(overseerRestartRpc, {}); emit(); return overseer; },
    /** Catch up's More context asks and their answers. */
    context: () => context,
    /** New's recent dispatches (client/new.tsx's Home row). */
    dispatches: () => dispatches,
    /** New closed: without the feed, read the dispatches it may have started (the feed pushes them itself). */
    refreshDispatches: () => { if (!home || homePolls) void readDispatches(); },
    /** Whether Home shows the PR stats icon (some repository has PR statistics). */
    prStatsOn: () => prStatsOn,
    /** The raised Linear issues in Needs you and the queue's revision (Q8), from the worker. */
    queue: () => queue,
    /** Each workspace's first live Compass note as one line. */
    compass: () => compass,
    /** A dismissal on a 0.15 host (or with the feed down): read the answer once now; the feed pushes it itself. */
    refreshQueue: () => { if (home && !homePolls) return; void client.rpc(prioritiesRpc, {}).then(a => { if (!stopped && setQueue(a.queue)) emit(); }).catch(() => undefined); },
    /** Reads the asks once (Catch up opening or moving on, so a 0.15 host or a dropped feed is never stale for long). */
    async refreshContext() { if (await readContext().catch(() => false)) emit(); },
    /** Asks the Overseer or the card's agent; the ask shows at once, its answer arrives on the feed. */
    async askContext(input: RpcInput<typeof contextAskRpc>) {
      const out = await client.rpc(contextAskRpc, input);
      setContext([...context.filter(r => r.id !== out.request.id), out.request]); emit();
      return out;
    },
    /** Your questions: Done, Reply, Make a task, Withdraw. The question (and a reply's new one) show at once. */
    async questionAction(input: RpcInput<typeof questionActionRpc>) {
      const out = await client.rpc(questionActionRpc, input);
      const next = context.map(r => r.id === out.request.id ? out.request : r);
      setContext(out.reply ? [...next.filter(r => r.id !== out.reply!.id), out.reply] : next); emit();
      return out;
    },
    agents: () => [...agents.values()],
    /**
     * The one owner of "put the caret in Home's search" (every-search-request-lands-in-the-visible-search): the search
     * key, ⌘K "Follow-up: Search" and `/` ask it; the search field on screen takes it (client/search-focus.ts).
     */
    searchFocus,
    /** Calls `listener` when an agent's status, attention or permissions change (see above). */
    onActivity(listener: () => void) { activity.add(listener); return () => { activity.delete(listener); }; },
    /** Each update Paseo sends about one agent (null when it's removed). */
    watchAgent(agentId: string, listener: (agent: unknown) => void) {
      const set = agentWatchers.get(agentId) ?? new Set(); set.add(listener); agentWatchers.set(agentId, set);
      return () => { set.delete(listener); if (!set.size) agentWatchers.delete(agentId); };
    },
    async stop() { stopped = true; stopFeeds(); offVisible(); offSearchFocus(); activity.clear(); for (const t of timers) clearTimeout(t); timers.clear(); if (pending) clearTimeout(pending); listeners.clear(); unsubscribe(); await release?.(); },
  };
}
export type HomeExtras = ReturnType<typeof createHomeExtras>;
