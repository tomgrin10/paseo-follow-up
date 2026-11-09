import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginButtonIconProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { listRpc } from "../shared/contracts";
import type { Workspace } from "../shared/model";
import { needsYou } from "../shared/attention";
import { useSidebarViewActive } from "./inbox";
import { homeCounts } from "../shared/home";
import { useHomeModel, type HomeSources } from "./home-data";

const POLL_MS = 8_000;

/** One shared poll of tracked workspaces for the pills, header-button dots and the sidebar count. */
export function createLiveStore(client: PluginClientContext) {
  let workspaces = new Map<string, Workspace>();
  /** Archived ones, only for search ("Archived" at the bottom of results). */
  let archived: Workspace[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const emit = () => { version++; for (const l of listeners) l(); };
  const poll = async () => {
    try {
      const result = await client.rpc(listRpc, {});
      if (stopped) return;
      workspaces = new Map(result.workspaces.filter(w => !w.archived).map(w => [w.id, w]));
      archived = result.workspaces.filter(w => w.archived);
      emit();
    } catch { /* Keep the last answer through restarts and disconnects. */ }
    finally { if (!stopped) timer = setTimeout(() => void poll(), POLL_MS); }
  };
  void poll();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    get: (id: string) => workspaces.get(id),
    all: () => [...workspaces.values()],
    archived: () => archived,
    refresh: () => { if (timer) clearTimeout(timer); void poll(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); listeners.clear(); },
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
    const need = useLive(store, () => { const w = store.get(props.workspaceId); return w ? needsYou(w).length : 0; });
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
  return function FollowSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
    // The same counts as Home's status strip and the brief headline.
    const count = homeCounts(useHomeModel(sources)).needs;
    const inSidebarView = useSidebarViewActive();
    const c = theme.colors;
    const shown = count > 0 && !inSidebarView;
    return <SidebarRow icon="GitPullRequest" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId, params: { section: "needs" } })}
      trailing={shown ? <View accessibilityLabel={`${count} need${count === 1 ? "s" : ""} you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View> : undefined} />;
  };
}
