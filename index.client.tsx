import { contributeDisplay } from "./client/display";
import { withButtonVisibility } from "./client/button-visibility";
import { openExternalUrl, type PluginClientContext, type PluginButtonRegistration, type PluginScreenProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Dimensions } from "react-native";
import { FollowSettings } from "./client/settings";
import { FollowHome, HOME_SCREEN } from "./client/home";
import { FollowNavigator } from "./client/navigator";
import { createPaseoWorkspaces } from "./client/home-data";
import { contributeChat } from "./client/chat";
import { createLiveStore, headerIcon, sidebarItem } from "./client/live";
import { contributeFollowUpPill } from "./client/pill";
import { FollowLarge, LARGE_SCREEN } from "./client/large";
import { createInboxStore } from "./client/inbox-store";
import { contributeInboxCommands } from "./client/inbox";
import type { BriefDeps } from "./client/brief";
import { inboxSidebarView, sidebarViewHost } from "./client/sidebar-view";
import { contributeBrief } from "./client/brief";

/** Home. The same screen id the Overview had, so the sidebar row, ⌘K and saved links land on Home. */
const OVERVIEW = HOME_SCREEN;
/** The workspace panel, now the navigator. One id for the side pane and the phone tab (1.2.0-beta.1 retired "follow-through-tab"). */
const PANEL = "follow-through";
/** Old settings screen ids, kept only so saved links and restored routes still open the one settings page. */
const LEGACY_SETTINGS_SCREENS = ["follow-through-settings", "project-settings", "display-settings"];

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const location = () => Dimensions.get("window").width < 768 ? "workspace" as const : "explorer" as const;
  const openPanel = (workspaceId: string) => client.openPanel(PANEL, { workspaceId, location: location() });
  const openSettings = () => client.openSettings("projects");
  const openOverview = () => client.openScreen({ screenId: OVERVIEW });
  const openLog = () => client.openScreen({ screenId: OVERVIEW, params: { view: "log" } });
  const openLarge = (workspaceId: string) => client.openScreen({ screenId: LARGE_SCREEN, params: { workspaceId } });
  const store = createLiveStore(client);
  const inbox = createInboxStore(host);
  const HeaderIcon = headerIcon(store);
  const headers = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const register = (workspaceId: string) => {
    if (stopped || headers.has(workspaceId)) return;
    // The header button re-docks the navigator for this workspace (H10 A).
    headers.set(workspaceId, client.addHeaderButton({ id: "follow-through", workspaceId, button: { title: "Follow-up", icon: HeaderIcon, behavior: { kind: "action", onPress() { openPanel(workspaceId); } } } }));
  };
  const paseoWorkspaces = createPaseoWorkspaces(client, { onAdd: register, onRemove: id => { headers.get(id)?.remove(); headers.delete(id); } });
  const sources = { inbox, live: store, paseo: paseoWorkspaces };
  // "Sign off & next" from a pill or ⌘K: the screen relays it to the host's navigation.
  let nextToken = 0;
  const openNext = (from: string | null) => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), ...(from ? { from } : {}) } });

  const removeDisplay = contributeDisplay(client, { id: "follow-through-overview", title: "Follow-up", Component: sidebarItem(store, inbox, OVERVIEW) });
  const briefDeps: BriefDeps = {
    signOff: agentId => void inbox.signOff([agentId]), openNext,
    openAgent: agentId => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), open: agentId } }),
    workspace: id => store.get(id), openPanel,
  };
  const homeDeps = { sources, openSettings, openPanel, openLog, openHome: openOverview, briefDeps };
  const Overview = (props: PluginScreenProps) => <FollowHome {...props} deps={homeDeps} />;
  const navDeps = { sources, openHome: openOverview, openLarge, openSettings, openPanel };
  const Panel = (props: PluginWorkspacePanelProps) => <FollowNavigator {...props} deps={navDeps} />;
  const Large = (props: PluginScreenProps) => <FollowLarge {...props} openSettings={openSettings} openOverview={openOverview} />;
  const removers: (() => unknown)[] = [
    client.addScreen({ id: OVERVIEW, title: "Follow-up", Component: Overview }),
    client.addScreen({ id: LARGE_SCREEN, title: params => store.get(params.workspaceId ?? "")?.title ?? "Follow-up", Component: Large }),
    ...LEGACY_SETTINGS_SCREENS.map(id => client.addScreen({ id, title: "Follow-up settings", Component: FollowSettings })),
    client.addSettingsScreen({ id: "projects", title: "Follow-up", icon: "GitPullRequest", Component: FollowSettings }),
    client.addWorkspacePanel({ id: PANEL, title: "Follow-up", icon: "GitPullRequest", locations: ["workspace", "explorer"], Component: Panel }),
    client.addCommandCenterItem({ id: "open-follow-through", title: "Follow-up: dock the navigator here", icon: "GitPullRequest", keywords: ["PR", "stack", "repairs", "done", "archive"], context: "workspace", onSelect({ openPanel }) { openPanel(PANEL, { location: location() }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-large", title: "Follow-up: open the larger view", icon: "Maximize2", keywords: ["expand", "full screen", "maximize", "PR", "stack"], context: "workspace", onSelect({ workspace, openScreen }) { openScreen({ screenId: LARGE_SCREEN, params: { workspaceId: workspace.id } }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-spec", title: "Follow-up: open the spec", icon: "FileText", keywords: ["spec", "artifact", "plan", "doc", "design"], context: "workspace", onSelect({ workspace, openPanel }) {
      const url = store.get(workspace.id)?.spec?.url;
      // Without a link yet, open the panel, where the spec link can be added.
      if (url) void openExternalUrl(url).catch(() => undefined); else openPanel(PANEL, { location: location() });
    } }),
    client.addCommandCenterItem({ id: "follow-through-overview", title: "Follow-up: Home", icon: "House", keywords: ["home", "workspaces", "needs you", "inbox", "attention", "brief", "overview"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW }); } }),
    client.addCommandCenterItem({ id: "follow-through-log", title: "Follow-up: Done while you were away", icon: "History", keywords: ["log", "overnight", "away", "repairs", "activity"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW, params: { view: "log" } }); } }),
    client.addCommandCenterItem({ id: "follow-through-settings", title: "Follow-up: settings", icon: "Settings", keywords: ["default", "tracking", "project", "display", "sidebar", "pill", "header", "inbox", "questions"], context: "global", onSelect() { openSettings(); } }),
    client.addSlashCommand({ name: "follow-up", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(PANEL, { location: location() }); } }),
    contributeChat(client),
    contributeFollowUpPill(client, { inbox, live: store, openPanel, openNext }),
    contributeInboxCommands(client, inbox, openNext),
    contributeBrief(client, briefDeps),
  ];
  // Phase 2: only on hosts with the sidebar-view API (Paseo main after 2026-11-07).
  const views = sidebarViewHost(host);
  if (views) removers.push(views.addSidebarView({ id: "needs-you", title: "Follow-up: Needs you", description: "Agents that need you until you sign them off, then your workspaces.", Component: inboxSidebarView(sources) }));

  return async () => {
    stopped = true;
    visibility.dispose(); removeDisplay(); store.stop(); inbox.stop();
    for (const r of removers) void r();
    for (const button of headers.values()) button.remove();
    await paseoWorkspaces.stop();
  };
}
