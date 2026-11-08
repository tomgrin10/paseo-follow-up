import * as sdk from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { InboxSections, UndoBar, useInbox, useSidebarViewMounted } from "./inbox";
import { sectionRows } from "../shared/inbox";
import type { InboxStore } from "./inbox-store";

/**
 * Phase 2: the inbox as Paseo's sidebar. `addSidebarView` and the ref queries exist on Paseo main
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

function WorkspaceRow({ reference, view }: { reference: Ref; view: SidebarViewProps }) {
  const refs = sdk as unknown as RefSdk;
  const w = refs.useWorkspace(reference);
  const c = view.theme.colors;
  if (!w) return null;
  const active = view.active.workspace?.key === reference.key;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${w.title ?? w.name}`} onPress={() => view.navigation.openWorkspace(reference)}
    style={state => ({ minHeight: view.layout.compact ? 44 : 28, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: active ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    {w.pinnedAt ? <Icon name="Pin" size={12} color={c.foregroundMuted} /> : <View style={{ width: 12 }} />}
    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12, lineHeight: 16 }}>{w.title ?? w.name}</Text>
    {!!w.indicatorLabel && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{w.indicatorLabel}</Text>}
  </Pressable>;
}

function ProjectGroup({ reference, view }: { reference: Ref; view: SidebarViewProps }) {
  const refs = sdk as unknown as RefSdk;
  const project = refs.useProject(reference);
  const workspaces = refs.useWorkspaces({ where: w => w.project?.key === reference.key && !w.pinnedAt, orderBy: "name" });
  const c = view.theme.colors;
  if (!project) return null;
  return <View>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 28, paddingLeft: 12, paddingRight: 4 }}>
      <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{project.displayName}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`New workspace in ${project.displayName}`} onPress={() => view.navigation.openProject(reference)} hitSlop={6}
        style={{ width: view.layout.compact ? 44 : 24, height: view.layout.compact ? 44 : 24, alignItems: "center", justifyContent: "center" }}>
        <Icon name="Plus" size={13} color={c.foregroundMuted} />
      </Pressable>
    </View>
    {workspaces.map(w => <WorkspaceRow key={w.key} reference={w} view={view} />)}
  </View>;
}

/** The default list, folded at the bottom, so nothing the stock sidebar shows goes away. */
function AllWorkspaces({ view }: { view: SidebarViewProps }) {
  const refs = sdk as unknown as RefSdk;
  const [open, setOpen] = useState(false);
  const all = refs.useWorkspaces({});
  const pinned = refs.useWorkspaces({ where: w => !!w.pinnedAt, orderBy: "name" });
  const projects = refs.useProjects({ orderBy: "displayName" });
  const c = view.theme.colors;
  return <View style={{ marginTop: 8 }}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`All workspaces, ${all.length}. ${open ? "Collapse" : "Expand"}`} onPress={() => setOpen(!open)}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingLeft: 4 }}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>All workspaces</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{all.length}</Text>
    </Pressable>
    {open && <>
      {pinned.map(w => <WorkspaceRow key={w.key} reference={w} view={view} />)}
      {projects.map(p => <ProjectGroup key={p.key} reference={p} view={view} />)}
    </>}
  </View>;
}

export function inboxSidebarView(store: InboxStore) {
  return function NeedsYouSidebar(view: SidebarViewProps) {
    const refs = sdk as unknown as RefSdk;
    useSidebarViewMounted();
    const ids = useInbox(store, () => [...store.rows().map(r => r.agentId), ...(store.data()?.unsorted ?? []).map(r => r.agentId)].join(","));
    const wanted = useMemo(() => new Set(ids.split(",").filter(Boolean)), [ids]);
    const agents = refs.useAgents({ where: a => wanted.has(a.id) });
    const byId = useMemo(() => new Map(agents.map(r => [r.id, r])), [agents]);
    const count = useInbox(store, () => sectionRows(store.rows(), "needs", Date.now()).length);
    const touch = view.layout.compact;
    const c = view.theme.colors;
    if (!store.enabled()) return <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>The Needs-you inbox is off. Turn it on in Follow-up's display settings.</Text>
      <AllWorkspaces view={view} />
    </ScrollView>;
    return <View style={{ flex: 1 }}>
      <ScrollView accessibilityLabel={`Needs you, ${count}`} contentContainerStyle={{ paddingHorizontal: 6, paddingTop: 4, paddingBottom: 72 }}>
        <InboxSections store={store} theme={view.theme} touch={touch} dense runningCap={6}
          nav={{ activeAgentId: view.active.agent?.id ?? null, openAgent: row => { const ref = byId.get(row.agentId); if (ref) view.navigation.openAgent(ref); } }} />
        <AllWorkspaces view={view} />
      </ScrollView>
      <View style={{ position: "absolute", left: 8, right: 8, bottom: 8 }}><UndoBar store={store} theme={view.theme} touch={touch} /></View>
    </View>;
  };
}
