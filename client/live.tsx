import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { Text } from "./text";
import type { PluginButtonIconProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { listRpc, workspacesFeed } from "../shared/contracts";
import { subscribeFeed } from "./feeds";
import type { Workspace } from "../shared/model";
import { activeNeeds, needsYou } from "../shared/attention";
import { useSidebarViewActive } from "./inbox";
import { homeCounts } from "../shared/home";
import { useHomeModel, type HomeSources } from "./home-data";
import { onVisible, whileVisible } from "./visibility";
import { WhatsNewGate } from "./release-notes";
import { ToastHost } from "./toasts";

/** The backstop poll; agent changes `nudge` it sooner (1.4.0). Nothing while the app is hidden. */
const POLL_MS = 15_000;

/** One shared poll of tracked workspaces for the pills, header-button dots and the sidebar count. */
export function createLiveStore(client: PluginClientContext) {
  let workspaces = new Map<string, Workspace>();
  /** Archived ones, only for search ("Archived" at the bottom of results). */
  let archived: Workspace[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nudged: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** The worker's list revision this store holds; each poll asks only for what changed since (1.3.0-beta.4). */
  let revision: number | undefined;
  let all = new Map<string, Workspace>();
  const emit = () => { version++; for (const l of listeners) l(); };
  let feed: (() => void) | null = null;
  const apply = (result: { full?: boolean; workspaces: Workspace[]; removed?: string[]; revision?: number }) => {
      const diff = result.full === false;
      if (diff && !result.workspaces.length && !result.removed?.length) return;
      const next = diff ? new Map(all) : new Map<string, Workspace>();
      for (const id of result.removed ?? []) next.delete(id);
      for (const w of result.workspaces) next.set(w.id, w);
      all = next; revision = result.revision;
      workspaces = new Map([...all.values()].filter(w => !w.archived).map(w => [w.id, w]));
      archived = [...all.values()].filter(w => w.archived);
      emit();
  };
  // Paseo 0.15: poll the revision diff. 0.16: the worker pushes the same diff (follow.workspaces-feed), and nothing polls.
  const poll = async () => {
    try {
      const result = await client.rpc(listRpc, revision === undefined ? {} : { since: revision });
      if (stopped || feed) return;
      apply(result);
    } catch { /* Keep the last answer through restarts and disconnects. */ }
    finally { if (!stopped && !feed) timer = whileVisible(POLL_MS, () => void poll()); }
  };
  feed = subscribeFeed(client, workspacesFeed, {}, event => { if (!stopped) apply(event); }, () => { feed = null; void poll(); });
  const offVisible = onVisible(() => { if (feed) return; if (timer) clearTimeout(timer); void poll(); });
  if (!feed) void poll();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    get: (id: string) => workspaces.get(id),
    all: () => [...workspaces.values()],
    archived: () => archived,
    /** After an action: the feed pushes the change by itself; polling hosts read at once. */
    refresh: () => { if (feed) return; if (timer) clearTimeout(timer); void poll(); },
    /** Paseo reported an agent change: one diff read soon, however many updates arrive together. */
    nudge: () => { if (nudged || stopped || feed) return; nudged = setTimeout(() => { nudged = null; if (timer) clearTimeout(timer); void poll(); }, 1_500); },
    stop() { stopped = true; feed?.(); offVisible(); if (timer) clearTimeout(timer); if (nudged) clearTimeout(nudged); listeners.clear(); },
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
    return <><WhatsNewGate surface="sidebar" theme={theme} compact={layout.compact} /><ToastHost theme={theme} compact={layout.compact} /><SidebarRow icon="GitPullRequest" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId, params: { section: "needs" } })}
      trailing={shown ? <View accessibilityLabel={`${count} need${count === 1 ? "s" : ""} you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View> : undefined} /></>;
  };
}
