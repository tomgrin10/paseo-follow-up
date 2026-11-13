import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { Text } from "./text";
import type { PluginButtonIconProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { listRpc, workspacesFeed } from "../shared/contracts";
import { openFeed, type Feed } from "./feeds";
import { isArchivedEntry, listEntry, type ArchivedListWorkspace, type ListEntry, type ListWorkspace } from "../shared/list";
import type { Workspace } from "../shared/model";
import { activeNeeds, needsYou } from "../shared/attention";
import { useSidebarViewActive } from "./inbox";
import { homeCounts } from "../shared/home";
import { useHomeModel, type HomeSources } from "./home-data";
import { onVisible, whileVisible } from "./visibility";
import { WhatsNewGate } from "./release-notes";
import { ViewSync } from "./view-store";
import { ToastHost } from "./toasts";
import { newer, opened } from "./live-copies";
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
  let feed: Feed | null = null;
  const pushed = () => feed?.live === true;
  const apply = (result: { full?: boolean; workspaces: ListEntry[]; removed?: string[]; revision?: number }) => {
      const diff = result.full === false;
      if (diff && !result.workspaces.length && !result.removed?.length) return;
      const next = diff ? new Map(all) : new Map<string, ListEntry>();
      for (const id of result.removed ?? []) next.delete(id);
      for (const w of result.workspaces) next.set(w.id, diff ? newer(all.get(w.id), w) : w);
      all = next; revision = result.revision;
      workspaces = new Map([...all.values()].filter((w): w is ListWorkspace => !isArchivedEntry(w)).map(w => [w.id, w]));
      archived = [...all.values()].filter(isArchivedEntry);
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
    all = new Map(all).set(w.id, entry);
    workspaces = new Map([...all.values()].filter((x): x is ListWorkspace => !isArchivedEntry(x)).map(x => [x.id, x]));
    archived = [...all.values()].filter(isArchivedEntry);
    emit();
  };
  opened.add(accept);
  const offVisible = onVisible(() => { if (pushed()) return; if (timer) clearTimeout(timer); void poll(); });
  if (!feed) void poll();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    get: (id: string) => workspaces.get(id),
    all: () => [...workspaces.values()],
    archived: () => archived,
    /** After an action: the feed pushes the change by itself; polling hosts read at once. */
    refresh: () => { if (pushed()) return; if (timer) clearTimeout(timer); void poll(); },
    /** Paseo reported an agent change: one diff read soon, however many updates arrive together. */
    nudge: () => { if (nudged || stopped || pushed()) return; nudged = setTimeout(() => { nudged = null; if (timer) clearTimeout(timer); void poll(); }, 1_500); },
    /** A fresh read of one workspace this store follows; kept only if newer (acceptWorkspace). */
    accept,
    stop() { stopped = true; opened.delete(accept); feed?.stop(); offVisible(); if (timer) clearTimeout(timer); if (nudged) clearTimeout(nudged); listeners.clear(); },
  };
}
export type LiveStore = ReturnType<typeof createLiveStore>;

export function useLive<T>(store: LiveStore, select: () => T): T {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  return select();
}

/** The header button's icon: a pull-request glyph with a warning dot while the workspace needs you. */
export function headerIcon(store: LiveStore) {
  return function HeaderIcon(props: PluginButtonIconProps) {
    const need = useLive(store, () => { const w = store.get(props.workspaceId); return w ? activeNeeds(w).length : 0; });
    return <View style={{ width: props.size, height: props.size }}>
      <Icon name="GitPullRequest" size={props.size} color={props.color} />
      {need > 0 && <View accessibilityLabel={`${need} need you`} style={{ position: "absolute", top: -2, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: props.theme.colors.statusWarning, borderWidth: 1.5, borderColor: props.theme.colors.surface0 }} />}
    </View>;
  };
}

/**
 * Follow-up's one sidebar item. Its badge is the Needs-you count (agents flagged and not snoozed); with the
 * inbox off it counts workspaces that need you instead. Hidden at zero. While the Phase 2 sidebar view is
 * mounted, that view already lists the same agents right below, so the badge hides and the item stays as the
 * way into the full screen.
 */
export function sidebarItem(sources: HomeSources, screenId: string) {
  return function FollowSidebarItem({ currentScreen, openScreen, theme, layout }: PluginSidebarItemProps) {
    // The same counts as Home's status strip and the brief headline.
    const count = homeCounts(useHomeModel(sources)).needs;
    const inSidebarView = useSidebarViewActive();
    const c = theme.colors;
    const shown = count > 0 && !inSidebarView;
    // What's new mounts here too (the sidebar is always there), so it shows even if you live in agent chats.
    return <><ViewSync /><WhatsNewGate surface="sidebar" theme={theme} compact={layout.compact} /><ToastHost theme={theme} compact={layout.compact} /><SidebarRow icon="GitPullRequest" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId, params: { section: "needs" } })}
      trailing={shown ? <View accessibilityLabel={`${count} need${count === 1 ? "s" : ""} you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View> : undefined} /></>;
  };
}
