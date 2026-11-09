import * as sdk from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, type ComponentType } from "react";
import { Text, View } from "react-native";
import { UndoBar, useSidebarViewMounted } from "./inbox";
import { HomeList } from "./home-list";
import { useHomeModel, type HomeSources } from "./home-data";

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
    const model = useHomeModel(sources);
    const agents = refs.useAgents({});
    const workspaces = refs.useWorkspaces({});
    const agentRef = useMemo(() => new Map(agents.map(r => [r.id, r])), [agents]);
    const workspaceRef = useMemo(() => new Map(workspaces.map(r => [r.id, r])), [workspaces]);
    const touch = view.layout.compact;
    const c = view.theme.colors;
    const activeAgent = view.active.agent?.id ?? null;
    const activeWorkspace = view.active.workspace?.id ?? null;
    const selectedKey = useMemo(() => {
      const all = [...model.byKey.values()];
      return all.find(s => activeAgent && s.agentId === activeAgent)?.key ?? all.find(s => activeWorkspace && s.workspaceId === activeWorkspace)?.key ?? null;
    }, [model, activeAgent, activeWorkspace]);
    const onSelect = useCallback((key: string) => {
      const s = model.byKey.get(key);
      const agent = s?.agentId ? agentRef.get(s.agentId) : undefined;
      const workspace = s?.workspaceId ? workspaceRef.get(s.workspaceId) : undefined;
      if (agent) view.navigation.openAgent(agent); else if (workspace) view.navigation.openWorkspace(workspace);
    }, [model, agentRef, workspaceRef, view.navigation]);
    if (!sources.inbox.enabled()) return <View style={{ padding: 12 }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>The Needs-you inbox is off. Turn it on in Follow-up's display settings.</Text></View>;
    return <View style={{ flex: 1 }}>
      <HomeList model={model} theme={view.theme} dense touch={touch} selectedKey={selectedKey} onSelect={onSelect} />
      <View style={{ position: "absolute", left: 8, right: 8, bottom: 8 }}><UndoBar store={sources.inbox} theme={view.theme} touch={touch} /></View>
    </View>;
  };
}
