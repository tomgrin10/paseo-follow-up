import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { Text } from "./text";
import type { PluginButtonIconProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { listRpc, workspacesFeed } from "../shared/contracts";
import { openFeed, type Feed } from "./feeds";
import { isArchivedEntry, listEntry, splitReadStamps, withReadStamps, type ArchivedListWorkspace, type ListEntry, type ListWorkspace, type ReadStamps } from "../shared/list";
import type { Workspace } from "../shared/model";
import { activeNeeds, needsYou } from "../shared/attention";
import { useSidebarViewActive } from "./inbox";
import { homeCounts } from "../shared/home";
import { useHomeModel, type HomeSources } from "./home-data";
import { onVisible, whileVisible } from "./visibility";
import { FOLLOW_UP_ICON, NEED_DOT, needDotBox } from "./follow-up-icon";
import { WhatsNewGate } from "./release-notes";
import { SetupGate } from "./setup-gate";
import { ViewSync } from "./view-store";
import { ToastHost } from "./toasts";
import { newer, opened } from "./live-copies";
import { pendingAnswers, pendingKey, settlePendingAnswers, subscribePendingAnswers } from "./pending-answers";
import { settledAnswers, withPendingAnswers } from "../shared/optimistic-answers";
export { acceptWorkspace } from "./live-copies";

/** The backstop poll; agent changes `nudge` it sooner (1.4.0). Nothing while the app is hidden. */
const POLL_MS = 15_000;

/** One shared poll of tracked workspaces for the pills, header-button dots and the sidebar count. */
export function createLiveStore(client: PluginClientContext) {
  /** Each followed workspace in its list form (shared/list.ts); a surface that draws detail reads it with follow.get. */
  let workspaces = new Map<string, ListWorkspace>();
  /** Archived ones, only for search ("Archived" at the bottom of results): name and PRs only. */
  let archived: ArchivedListWorkspace[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nudged: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** The worker's list revision this store holds; each poll asks only for what changed since (1.3.0-beta.4). */
  let revision: number | undefined;
  let all = new Map<string, ListEntry>();
  const emit = () => { version++; for (const l of listeners) l(); };
  /**
   * answering-is-optimistic: what every surface reads is the worker's copy with the developer's answers in flight
   * overlaid (shared/optimistic-answers.ts). Cached per workspace object and per pending set, so selectors stay stable.
   */
  let shown = new Map<string, { from: ListWorkspace; pending: object; w: ListWorkspace }>();
  const view = (w: ListWorkspace): ListWorkspace => {
    const pending = pendingAnswers(); const hit = shown.get(w.id);
    if (hit && hit.from === w && hit.pending === pending) return hit.w;
    const out = withPendingAnswers(w, pending, pendingKey);
    shown.set(w.id, { from: w, pending, w: out });
    return out;
  };
  /** The worker's copy settled these answers (recorded, or answered or withdrawn elsewhere): drop what was kept. */
  const settle = (list: Iterable<ListEntry>) => {
    const pending = pendingAnswers(); if (!Object.keys(pending).length) return;
    const keys = [...list].flatMap(w => isArchivedEntry(w) ? [] : settledAnswers(w, pending, pendingKey));
    if (keys.length) settlePendingAnswers(keys);
  };
  const offPending = subscribePendingAnswers(emit);
  let feed: Feed | null = null;
  const pushed = () => feed?.live === true;
  /** Each workspace's read stamps (read-stamps-never-count): they arrive apart from its entry and are filled back in here. */
  let stamps = new Map<string, ReadStamps>();
  const apply = (result: { full?: boolean; workspaces: ListEntry[]; removed?: string[]; revision?: number; reads?: Record<string, ReadStamps> }) => {
      const diff = result.full === false;
      const reads = result.reads ?? {};
      if (diff && !result.workspaces.length && !result.removed?.length && !Object.keys(reads).length) return;
      const next = diff ? new Map(all) : new Map<string, ListEntry>();
      if (!diff) stamps = new Map();
      for (const [id, s] of Object.entries(reads)) stamps.set(id, s);
      for (const id of result.removed ?? []) { next.delete(id); stamps.delete(id); }
      for (const w of result.workspaces) { const filled = withReadStamps(w, stamps.get(w.id)); next.set(w.id, diff ? newer(all.get(w.id), filled) : filled); }
      // Stamps alone: the held entry with its new stamps (a new object only for those workspaces).
      const sent = new Set(result.workspaces.map(w => w.id));
      for (const id of Object.keys(reads)) { const held = next.get(id); if (held && !sent.has(id)) next.set(id, withReadStamps(held, stamps.get(id))); }
      all = next; revision = result.revision;
      workspaces = new Map([...all.values()].filter((w): w is ListWorkspace => !isArchivedEntry(w)).map(w => [w.id, w]));
      archived = [...all.values()].filter(isArchivedEntry);
      settle(result.workspaces);
      emit();
  };
  // Paseo 0.15: poll the revision diff. 0.16: the worker pushes the same diff (follow.workspaces-feed), and nothing polls.
  const poll = async () => {
    try {
      const result = await client.rpc(listRpc, revision === undefined ? {} : { since: revision });
      if (stopped || pushed()) return;
      apply(result);
    } catch { /* Keep the last answer through restarts and disconnects. */ }
    finally { if (!stopped && !pushed()) { if (timer) clearTimeout(timer); timer = whileVisible(POLL_MS, () => void poll()); } }
  };
  // The feed went down (the worker restarted): read now and poll until it is back.
  feed = openFeed(client, workspacesFeed, {}, { event: event => { if (!stopped) apply(event); }, down: () => { if (timer) clearTimeout(timer); void poll(); }, up: () => { if (timer) clearTimeout(timer); timer = null; } });
  // The store keeps list forms only: a read's full workspace is projected (shared/list.ts listEntry) before it's held.
  const accept = (w: Workspace) => {
    const held = all.get(w.id);
    if (!held || Date.parse(w.updatedAt) < Date.parse(held.updatedAt)) return;
    const entry = listEntry(w);
    // A whole read carries fresh stamps: keep them for the entries the feed sends bare after it.
    const read = splitReadStamps(entry).stamps; if (read) stamps.set(w.id, read);
    all = new Map(all).set(w.id, entry);
    workspaces = new Map([...all.values()].filter((x): x is ListWorkspace => !isArchivedEntry(x)).map(x => [x.id, x]));
    archived = [...all.values()].filter(isArchivedEntry);
    settle([entry]);
    emit();
  };
  opened.add(accept);
  const offVisible = onVisible(() => { if (pushed()) return; if (timer) clearTimeout(timer); void poll(); });
  if (!feed) void poll();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    get: (id: string) => { const w = workspaces.get(id); return w && view(w); },
    all: () => [...workspaces.values()].map(view),
    archived: () => archived,
    /** After an action: the feed pushes the change by itself; polling hosts read at once. */
    refresh: () => { if (pushed()) return; if (timer) clearTimeout(timer); void poll(); },
    /** Paseo reported an agent change: one diff read soon, however many updates arrive together. */
    nudge: () => { if (nudged || stopped || pushed()) return; nudged = setTimeout(() => { nudged = null; if (timer) clearTimeout(timer); void poll(); }, 1_500); },
    /** A fresh read of one workspace this store follows; kept only if newer (acceptWorkspace). */
    accept,
    stop() { stopped = true; offPending(); shown = new Map(); opened.delete(accept); feed?.stop(); offVisible(); if (timer) clearTimeout(timer); if (nudged) clearTimeout(nudged); listeners.clear(); },
  };
}
export type LiveStore = ReturnType<typeof createLiveStore>;

export function useLive<T>(store: LiveStore, select: () => T): T {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  return select();
}

/** The header button's icon: Follow-up's mark. While the workspace needs you, its end dot turns into the warning dot. */
export function headerIcon(store: LiveStore) {
  return function HeaderIcon(props: PluginButtonIconProps) {
    const need = useLive(store, () => { const w = store.get(props.workspaceId); return w ? activeNeeds(w).length : 0; });
    return <View style={{ width: props.size, height: props.size }}>
      <Icon icon={FOLLOW_UP_ICON} size={props.size} color={props.color} />
      {need > 0 && <View testID="follow-up-need-dot" accessibilityLabel={`${need} need you`} style={{ position: "absolute", ...needDotBox(props.size), width: NEED_DOT, height: NEED_DOT, borderRadius: NEED_DOT / 2, backgroundColor: props.theme.colors.statusWarning }} />}
    </View>;
  };
}

/**
 * Follow-up's one sidebar item. Its badge is the Needs-you count (agents flagged and not snoozed); with the
 * inbox off it counts workspaces that need you instead. Hidden at zero. While the Phase 2 sidebar view is
 * mounted, that view already lists the same agents right below, so the badge hides and the item stays as the
 * way into the full screen.
 */
export function sidebarItem(sources: HomeSources, screenId: string, links: { openSettings?: (category?: string) => void } = {}) {
  return function FollowSidebarItem({ currentScreen, openScreen, theme, layout }: PluginSidebarItemProps) {
    // The same counts as Home's status strip and the brief headline.
    const count = homeCounts(useHomeModel(sources)).needs;
    const inSidebarView = useSidebarViewActive();
    const c = theme.colors;
    const shown = count > 0 && !inSidebarView;
    // What's new and setup's popup mount here too (the sidebar is always there), so they show even if you live in agent chats.
    return <><ViewSync /><WhatsNewGate surface="sidebar" theme={theme} compact={layout.compact} /><SetupGate surface="sidebar" theme={theme} compact={layout.compact} deps={{ openSettings: links.openSettings, openHome: () => openScreen({ screenId }) }} /><ToastHost theme={theme} compact={layout.compact} /><SidebarRow icon={FOLLOW_UP_ICON} active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId, params: { section: "needs" } })}
      trailing={shown ? <View accessibilityLabel={`${count} need${count === 1 ? "s" : ""} you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View> : undefined} /></>;
  };
}
