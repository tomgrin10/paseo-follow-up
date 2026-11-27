import * as sdk from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useSyncExternalStore, type ComponentType } from "react";
import { Platform, View } from "react-native";
import { displayValues } from "./display";
import { rowOpens } from "../shared/display";
import { Text } from "./text";
import { UndoBar, useInbox, useSidebarViewMounted } from "./inbox";
import { HomeList, OVERSEER_KEY, type OverseerRowState } from "./home-list";
import { sidebarSelected } from "./theme";
import { DisplayMenu, FilterField, FilterLine, LayoutNotice, useListFilter } from "./home-chrome";
import { useArranged, useHomeModel, type HomeSources } from "./home-data";
import { useRowMenu } from "./row-actions";
import { RenameHost } from "./rename";
import type { Workstream } from "../shared/home";
import { listOverseerRow, overseerRowTarget } from "../shared/overseer";

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

/**
 * Cmd/Ctrl on the click that picked a row (web): the list hands its pick over as a key only, so the modifiers of the
 * last pointer press are read here, within a moment of it.
 */
let lastPress = { at: 0, modified: false };
if (Platform.OS === "web") (globalThis as { document?: { addEventListener(t: string, f: (e: { metaKey?: boolean; ctrlKey?: boolean }) => void, capture?: boolean): void } }).document
  ?.addEventListener("pointerdown", e => { lastPress = { at: Date.now(), modified: !!(e.metaKey || e.ctrlKey) }; }, true);
const modifiedPick = () => lastPress.modified && Date.now() - lastPress.at < 1_000;

/** `openOverseerHome`: Follow-up Home with the Overseer selected, where Start and Restart live. `openView`: a workspace's view tab. */
export function inboxSidebarView(sources: HomeSources, openOverseerHome: () => void, openView: (workspaceId: string) => void) {
  return function NeedsYouSidebar(view: SidebarViewProps) {
    const refs = sdk as unknown as RefSdk;
    useSidebarViewMounted();
    const full = useHomeModel(sources);
    // "Filter workspaces" narrows this list in place with Home search's matcher; the sort is Home's own setting.
    const filter = useListFilter(full, sources);
    const model = filter.model;
    // Display's Pinned (Paseo's own pins), grouping and filters, the same arrangement as Home (shared/home-arrange.ts).
    const { arranged, view: display, facts } = useArranged(sources, model);
    const rank = useSyncExternalStore(sources.extras.subscribe, sources.extras.rank, sources.extras.rank);
    const agents = refs.useAgents({});
    const workspaces = refs.useWorkspaces({});
    const agentRef = useMemo(() => new Map(agents.map(r => [r.id, r])), [agents]);
    const workspaceRef = useMemo(() => new Map(workspaces.map(r => [r.id, r])), [workspaces]);
    // Home's pinned Overseer row, the same state (one-row-everywhere); a filter keeps it only when it's about it.
    const overseerStatus = useSyncExternalStore(sources.extras.subscribe, sources.extras.overseer, sources.extras.overseer);
    const overseerInbox = useInbox(sources.inbox, () => sources.inbox.overseer());
    const overseer: OverseerRowState | null = listOverseerRow(overseerStatus, overseerInbox, filter.query);
    const overseerAgent = overseerStatus?.agentId ?? null;
    const touch = view.layout.compact;
    const c = view.theme.colors;
    const activeAgent = view.active.agent?.id ?? null;
    const activeWorkspace = view.active.workspace?.id ?? null;
    const selectedKey = useMemo(() => {
      if (overseer && activeAgent && activeAgent === overseerAgent) return OVERSEER_KEY;
      const all = [...full.byKey.values()];
      return all.find(s => activeAgent && s.agentId === activeAgent)?.key ?? all.find(s => activeWorkspace && s.workspaceId === activeWorkspace)?.key ?? null;
    }, [full, activeAgent, activeWorkspace, overseer, overseerAgent]);
    const onSelect = useCallback((key: string) => {
      if (key === OVERSEER_KEY) {
        // A live Overseer opens its chat like any row; Start and a failed restart need Home's Overseer pane.
        const ref = overseerAgent ? agentRef.get(overseerAgent) : undefined;
        if (overseer && overseerRowTarget(overseer.state) === "chat" && ref) view.navigation.openAgent(ref); else openOverseerHome();
        return;
      }
      const s = full.byKey.get(key);
      const agent = s?.agentId ? agentRef.get(s.agentId) : undefined;
      const workspace = s?.workspaceId ? workspaceRef.get(s.workspaceId) : undefined;
      const opens = s ? rowOpens(s, displayValues()?.open_workspace_on, modifiedPick()) : null;
      if (opens === "view" && s?.workspaceId) { if (workspace) view.navigation.openWorkspace(workspace); openView(s.workspaceId); }
      else if (agent) view.navigation.openAgent(agent); else if (workspace) view.navigation.openWorkspace(workspace);
    }, [full, agentRef, workspaceRef, view.navigation, overseer, overseerAgent]);
    // The row menu, as on Home (rename among it). No omnibox here, so no Ask; Open and Answer go to the chat.
    const openKey = (s: Workstream) => onSelect(s.key);
    const menu = useRowMenu({ sources, openFull: openKey, openQuestion: openKey, overseerOn: false });
    if (!sources.inbox.enabled()) return <View style={{ padding: 12 }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>The Needs-you inbox is off. Turn it on in Follow-up's display settings.</Text></View>;
    return <View style={{ flex: 1 }}>
      <HomeList model={model} hits={filter.hits} theme={view.theme} dense touch={touch} selectedKey={selectedKey} onSelect={onSelect} menu={menu} overseer={overseer} stackOverseer
        arranged={arranged} view={display} facts={facts}
        // Each open loads a chat and moves the main pane, so the keys move the focus and Enter opens.
        keys={{ mode: "focus", onOpen: onSelect }}
        // The open chat's row wears Paseo's own selected-item fill, so it reads like a selected native item.
        selectedBg={sidebarSelected(c)}
        // One control row: the filter takes the width, the sort is an icon. A layout hint may sit below. zIndex keeps the
        // sort menu above the list on web, where every View is its own stacking context.
        top={<View style={{ zIndex: 10, paddingHorizontal: touch ? 12 : 8, paddingVertical: touch ? 8 : 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: touch ? 8 : 4 }}><FilterField theme={view.theme} filter={filter} dense={touch} />
          <DisplayMenu theme={view.theme} mode={full.sort} onSort={sources.extras.setSort} view={display} onView={sources.extras.setView} projects={arranged.projects} labels={arranged.labels} rankedAt={full.rankedAt} touch={touch} rank={rank} onRerank={sources.extras.rankNow} /></View>
          <FilterLine theme={view.theme} view={display} onView={sources.extras.setView} touch={touch} />
          <LayoutNotice theme={view.theme} query={filter.layoutHint} dense={touch} />
        </View>}
        footer={filter.hits && !touch ? <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 32 }}>Filtering this list · Esc clears</Text> : undefined} />
      <View style={{ position: "absolute", left: 8, right: 8, bottom: 8 }}><UndoBar store={sources.inbox} theme={view.theme} touch={touch} /></View>
      <RenameHost theme={view.theme} compact={touch} />
    </View>;
  };
}
