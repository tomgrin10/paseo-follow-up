import * as sdk from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useSyncExternalStore, type ComponentType } from "react";
import { View } from "react-native";
import { Text } from "./text";
import { UndoBar, useSidebarViewMounted } from "./inbox";
import { HomeList } from "./home-list";
import { FilterField, SortMenu, useListFilter } from "./home-chrome";
import { useHomeModel, type HomeSources } from "./home-data";
import { useRowMenu } from "./row-actions";
import { RenameHost } from "./rename";
import type { Workstream } from "../shared/home";

/**
 * Phase 2: Home's list as Paseo's sidebar (the same HomeList component Home uses). `addSidebarView` and the ref queries exist on Paseo main
 * (merged 2026-11-07) but not in 0.15.2 or the published SDK, so they are typed here and used only
 * when the host provides them. On older hosts nothing is registered and nothing else changes.
 */
type Ref = { readonly kind: string; readonly hostId: string; readonly id: string; readonly key: string };
export type SidebarViewProps = Pick<PluginHostProps, "theme" | "layout"> & {
  active: { workspace: Ref | null; agent: Ref | null };
  navigation: { openWorkspace(ref: Ref): void; openAgent(ref: Ref): void; openTerminal(ref: Ref): void; openProject(ref: Ref): void };
  dismiss(): void;
};
type Query<T> = { hosts?: string[]; where?: (item: T) => boolean; orderBy?: unknown };
type RefSdk = {
  useAgents(query?: Query<{ id: string }>): readonly Ref[];
  useWorkspaces(query?: Query<{ pinnedAt: string | null; project: Ref | null }>): readonly Ref[];
  useProjects(query?: { orderBy?: unknown }): readonly Ref[];
  useWorkspace(ref: Ref): { title: string | null; name: string; indicatorLabel?: string; pinnedAt?: string | null } | null;
  useProject(ref: Ref): { displayName: string } | null;
};
type SidebarViewHost = { addSidebarView(contribution: { id: string; title: string; description?: string; Component: ComponentType<SidebarViewProps> }): () => void };

export function sidebarViewHost(client: PluginClientContext): SidebarViewHost | null {
  const candidate = client as unknown as Partial<SidebarViewHost>;
  const hooks = sdk as unknown as Partial<RefSdk>;
  return typeof candidate.addSidebarView === "function" && typeof hooks.useAgents === "function" && typeof hooks.useWorkspaces === "function" ? candidate as SidebarViewHost : null;
}

export function inboxSidebarView(sources: HomeSources) {
  return function NeedsYouSidebar(view: SidebarViewProps) {
    const refs = sdk as unknown as RefSdk;
    useSidebarViewMounted();
    const full = useHomeModel(sources);
    // "Filter workspaces" narrows this list in place with Home search's matcher; the sort is Home's own setting.
    const filter = useListFilter(full, sources);
    const model = filter.model;
    const rank = useSyncExternalStore(sources.extras.subscribe, sources.extras.rank, sources.extras.rank);
    const agents = refs.useAgents({});
    const workspaces = refs.useWorkspaces({});
    const agentRef = useMemo(() => new Map(agents.map(r => [r.id, r])), [agents]);
    const workspaceRef = useMemo(() => new Map(workspaces.map(r => [r.id, r])), [workspaces]);
    const touch = view.layout.compact;
    const c = view.theme.colors;
    const activeAgent = view.active.agent?.id ?? null;
    const activeWorkspace = view.active.workspace?.id ?? null;
    const selectedKey = useMemo(() => {
      const all = [...full.byKey.values()];
      return all.find(s => activeAgent && s.agentId === activeAgent)?.key ?? all.find(s => activeWorkspace && s.workspaceId === activeWorkspace)?.key ?? null;
    }, [full, activeAgent, activeWorkspace]);
    const onSelect = useCallback((key: string) => {
      const s = full.byKey.get(key);
      const agent = s?.agentId ? agentRef.get(s.agentId) : undefined;
      const workspace = s?.workspaceId ? workspaceRef.get(s.workspaceId) : undefined;
      if (agent) view.navigation.openAgent(agent); else if (workspace) view.navigation.openWorkspace(workspace);
    }, [full, agentRef, workspaceRef, view.navigation]);
    // The row menu, as on Home (rename among it). No omnibox here, so no Ask; Open and Answer go to the chat.
    const openKey = (s: Workstream) => onSelect(s.key);
    const menu = useRowMenu({ sources, openFull: openKey, openQuestion: openKey, overseerOn: false });
    if (!sources.inbox.enabled()) return <View style={{ padding: 12 }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>The Needs-you inbox is off. Turn it on in Follow-up's display settings.</Text></View>;
    return <View style={{ flex: 1 }}>
      <HomeList model={model} hits={filter.hits} theme={view.theme} dense touch={touch} selectedKey={selectedKey} onSelect={onSelect} menu={menu}
        // One row, nothing else (invariant 8): the filter takes the width, the sort is an icon. zIndex keeps the
        // sort menu above the list on web, where every View is its own stacking context.
        top={<View style={{ zIndex: 10, flexDirection: "row", alignItems: "center", gap: touch ? 8 : 4, paddingHorizontal: touch ? 12 : 8, paddingVertical: touch ? 8 : 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <FilterField theme={view.theme} filter={filter} dense={touch} />
          <SortMenu theme={view.theme} mode={full.sort} onChange={sources.extras.setSort} rankedAt={full.rankedAt} touch={touch} compact shared rank={rank} onRerank={sources.extras.rankNow} />
        </View>}
        footer={filter.hits && !touch ? <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 32 }}>Filtering this list · Esc clears</Text> : undefined} />
      <View style={{ position: "absolute", left: 8, right: 8, bottom: 8 }}><UndoBar store={sources.inbox} theme={view.theme} touch={touch} /></View>
      <RenameHost theme={view.theme} compact={touch} />
    </View>;
  };
}
