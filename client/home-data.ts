import { autoSendHold } from "../shared/sending";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { buildHome, type HomeModel, type PaseoWorkspaceLite } from "../shared/home";
import type { ArchiveFacts } from "../shared/row-menu";
import type { InboxStore } from "./inbox-store";
import type { LiveStore } from "./live";
import type { HomeExtras } from "./home-view";

type Descriptor = { id: string; name?: string | null; title?: string | null; projectDisplayName?: string | null; projectCustomName?: string | null; activityAt?: string | null; archivingAt?: string | null;
  workspaceKind?: ArchiveFacts["kind"]; status?: string | null; diffStat?: { additions: number; deletions: number } | null;
  gitRuntime?: { currentBranch?: string | null; isPaseoOwnedWorktree?: boolean; isDirty?: boolean | null; aheadOfOrigin?: number | null } | null; githubRuntime?: { pullRequest?: { number?: number; title?: string } | null } | null };
const lite = (w: Descriptor): PaseoWorkspaceLite => {
  const pr = w.githubRuntime?.pullRequest;
  return { id: w.id, name: w.title || w.name || "Workspace", project: w.projectCustomName || w.projectDisplayName || null, activityAt: w.activityAt ?? null,
    branch: w.gitRuntime?.currentBranch ?? null, pr: pr?.title ? { number: pr.number ?? null, title: pr.title } : null,
    archive: { kind: w.workspaceKind ?? null, ownedWorktree: w.gitRuntime?.isPaseoOwnedWorktree ?? null, dirty: w.gitRuntime?.isDirty ?? null, diff: w.diffStat ?? null,
      ahead: w.gitRuntime?.aheadOfOrigin ?? null, running: w.status === "running" } };
};

/**
 * Paseo's own workspace list, for the rows Follow-up doesn't track (they land in Quiet). One subscription per
 * client, shared with the header buttons. `onAdd` and `onRemove` let the entry point register header buttons.
 */
export function createPaseoWorkspaces(client: PluginClientContext, hooks: { onAdd?: (id: string) => void; onRemove?: (id: string) => void } = {}) {
  const map = new Map<string, PaseoWorkspaceLite>();
  let version = 0;
  let stopped = false;
  let release: (() => Promise<void>) | null = null;
  const listeners = new Set<() => void>();
  let pending: ReturnType<typeof setTimeout> | null = null;
  // Coalesce bursts (a page load, many updates) into one emit so Home rebuilds once.
  const emit = () => { if (pending) return; pending = setTimeout(() => { pending = null; version++; for (const l of listeners) l(); }, 50); };
  const put = (w: Descriptor) => { if (w.archivingAt) { remove(w.id); return; } map.set(w.id, lite(w)); hooks.onAdd?.(w.id); emit(); };
  const remove = (id: string) => { if (map.delete(id)) emit(); hooks.onRemove?.(id); };
  const unsubscribe = client.paseo.workspaces.subscribe(update => {
    if (update.kind === "remove") remove(update.id);
    else put(update.workspace as Descriptor);
  });
  void (async () => {
    const page = await client.paseo.workspaces.list({ subscribe: {}, page: { limit: 200 } });
    if (stopped) { await page.subscription.release(); return; }
    release = () => page.subscription.release();
    page.entries.forEach(w => put(w as Descriptor));
    let cursor = page.pageInfo.nextCursor;
    while (cursor && !stopped) {
      const next = await client.paseo.workspaces.list({ page: { limit: 200, cursor } });
      next.entries.forEach(w => put(w as Descriptor));
      if (next.pageInfo.nextCursor === cursor) break;
      cursor = next.pageInfo.nextCursor;
    }
  })().catch(() => undefined);
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    all: () => [...map.values()],
    get: (id: string) => map.get(id),
    async stop() { stopped = true; if (pending) clearTimeout(pending); listeners.clear(); unsubscribe(); await release?.(); },
  };
}
export type PaseoWorkspaces = ReturnType<typeof createPaseoWorkspaces>;

export type HomeSources = { inbox: InboxStore; live: LiveStore; paseo: PaseoWorkspaces; extras: HomeExtras };

/** One shared minute clock. Ages subscribe to it themselves, so a tick never re-renders the list rows. */
const clock = { now: Date.now(), listeners: new Set<() => void>(), timer: null as ReturnType<typeof setInterval> | null };
export function subscribeClock(listener: () => void) {
  clock.listeners.add(listener);
  if (!clock.timer) clock.timer = setInterval(() => { clock.now = Date.now(); for (const l of clock.listeners) l(); }, 60_000);
  return () => { clock.listeners.delete(listener); if (!clock.listeners.size && clock.timer) { clearInterval(clock.timer); clock.timer = null; } };
}
export const useMinute = () => useSyncExternalStore(subscribeClock, () => clock.now, () => clock.now);

/** Home's model from the three shared stores. Rebuilt when one of them changes or the minute ticks. */
export function useHomeModel(sources: HomeSources): HomeModel {
  const { inbox, live, paseo, extras } = sources;
  const a = useSyncExternalStore(inbox.subscribe, inbox.version, inbox.version);
  const b = useSyncExternalStore(live.subscribe, live.version, live.version);
  const c = useSyncExternalStore(paseo.subscribe, paseo.version, paseo.version);
  // Only the sort, priorities and the auto-send hold rebuild the model; agent titles and the meters don't touch it.
  const sort = useSyncExternalStore(extras.subscribe, extras.sort, extras.sort);
  const priorities = useSyncExternalStore(extras.subscribe, extras.priorities, extras.priorities);
  const overseer = useSyncExternalStore(extras.subscribe, () => extras.overseer()?.workspaceId ?? null, () => null);
  const now = useMinute();
  // The machine-wide auto-send hold: a string, so a usage poll that changes nothing else doesn't rebuild the model.
  const hold = useSyncExternalStore(extras.subscribe, () => autoSendHold(extras.usage().resources, Date.now()), () => null);
  // "Nobody's on it" rows (raised issues and urgent Compass asks) count in Needs you, the worker's one number (home
  // feed), so Home's header, strip and brief line and the sidebar badge (client/live.tsx) agree (nobody-s-on-it-is-needs-you).
  const raised = useSyncExternalStore(extras.subscribe, () => extras.queue().needs.length, () => 0);
  const compass = useSyncExternalStore(extras.subscribe, extras.compass, extras.compass);
  // Your questions: an unread answer is a Needs-you row; a question asking is its row's line (the home feed's context).
  const questions = useSyncExternalStore(extras.subscribe, extras.context, extras.context);
  return useMemo(() => buildHome({ rows: inbox.rows(), tracked: live.all(), paseo: paseo.all(), now: Date.now(), sort, priorities, hidden: overseer ? [overseer] : [], hold, compass, raised, questions }), [a, b, c, now, sort, priorities, inbox, live, paseo, overseer, hold, raised, compass, questions]);
}

/** Rebuilds a value at most every `ms` while mounted (used for the brief pane's source ages). */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => { const id = setInterval(() => setN(x => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return n;
}
