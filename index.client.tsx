import { contributeDisplay } from "./client/display";
import { withButtonVisibility } from "./client/button-visibility";
import { openExternalUrl, type PluginClientContext, type PluginButtonRegistration, type PluginScreenProps, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Dimensions } from "react-native";
import { FollowSettings } from "./client/settings";
import { FollowHome, HOME_SCREEN } from "./client/home";
import { FollowPanel } from "./client/panel";
import { createPaseoWorkspaces } from "./client/home-data";
import { createHomeExtras } from "./client/home-view";
import { contributeChat } from "./client/chat";
import { createLiveStore, headerIcon, sidebarItem } from "./client/live";
import { contributeFollowUpPill } from "./client/pill";
import { FollowLarge, LARGE_SCREEN } from "./client/large";
import { createInboxStore } from "./client/inbox-store";
import { contributeInboxCommands } from "./client/inbox";
import type { BriefDeps } from "./client/brief";
import { inboxSidebarView, sidebarViewHost } from "./client/sidebar-view";
import { contributeBrief } from "./client/brief";
import { clientTimeZoneRpc, setOnboardingRpc } from "./shared/contracts";
import { isCategory, writeCategory } from "./shared/settings-nav";

/** Home. The same screen id the Overview had, so the sidebar row, ⌘K and saved links land on Home. */
const OVERVIEW = HOME_SCREEN;
/** The workspace panel: this workspace only, with a Home button. One id for the side pane and the phone tab (1.2.0-beta.1 retired "follow-through-tab"). */
const PANEL = "follow-through";
/** Old settings screen ids, kept only so saved links and restored routes still open the one settings page. */
const LEGACY_SETTINGS_SCREENS = ["follow-through-settings", "project-settings", "display-settings"];

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const location = () => Dimensions.get("window").width < 768 ? "workspace" as const : "explorer" as const;
  const openPanel = (workspaceId: string) => client.openPanel(PANEL, { workspaceId, location: location() });
  // A category (agents, reviewers, following) is saved first, so settings opens on it (drilled in on a phone).
  // An agent's "tonight"/"tomorrow" snooze resolves on the daemon: tell it this device's timezone (docs/needs-you.md).
  // Retried a few times, since the host may not be reachable yet while the app starts.
  const reportTimeZone = (attempt = 0) => {
    let timeZone: string | undefined; try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return; }
    if (!timeZone) return;
    client.rpc(clientTimeZoneRpc, { timeZone }).then(r => { if (!r.ok) throw new Error("rejected"); })
      .catch(() => { if (attempt < 4) setTimeout(() => reportTimeZone(attempt + 1), [5_000, 30_000, 120_000, 600_000][attempt]); });
  };
  reportTimeZone();
  const openSettings = (category?: string) => { if (isCategory(category)) writeCategory(category); client.openSettings("projects"); };
  const openOverview = () => client.openScreen({ screenId: OVERVIEW });
  const openLog = () => client.openScreen({ screenId: OVERVIEW, params: { view: "log" } });
  const openLarge = (workspaceId: string) => client.openScreen({ screenId: LARGE_SCREEN, params: { workspaceId } });
  // "Set up Follow-up again" (Settings and ⌘K): restart the flow on the server, then open Home, which shows it.
  // `resume`: setup is already in progress, so open it where it was left instead of from the top.
  const openSetup = (resume = false) => { void (resume ? Promise.resolve() : client.rpc(setOnboardingRpc, { action: "restart" }).catch(() => undefined)).then(() => client.openScreen({ screenId: OVERVIEW, params: { setup: String(Date.now()) } })); };
  const Settings = (props: PluginSurfaceProps) => <FollowSettings {...props} openSetup={openSetup} />;
  const store = createLiveStore(client);
  const inbox = createInboxStore(host);
  const HeaderIcon = headerIcon(store);
  const headers = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const register = (workspaceId: string) => {
    if (stopped || headers.has(workspaceId)) return;
    // The header button opens (docks) this workspace's panel.
    headers.set(workspaceId, client.addHeaderButton({ id: "follow-through", workspaceId, button: { title: "Follow-up", icon: HeaderIcon, behavior: { kind: "action", onPress() { openPanel(workspaceId); } } } }));
  };
  const paseoWorkspaces = createPaseoWorkspaces(client, { onAdd: register, onRemove: id => { headers.get(id)?.remove(); headers.delete(id); } });
  const extras = createHomeExtras(client);
  const sources = { inbox, live: store, paseo: paseoWorkspaces, extras };
  const offActivity = extras.onActivity(() => { inbox.nudge(); store.nudge(); });
  // "Sign off & next" from a pill or ⌘K: the screen relays it to the host's navigation.
  let nextToken = 0;
  const openNext = (from: string | null) => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), ...(from ? { from } : {}) } });

  const removeDisplay = contributeDisplay(client, { id: "follow-through-overview", title: "Follow-up", Component: sidebarItem(sources, OVERVIEW) });
  const briefDeps: BriefDeps = {
    signOff: agentId => void inbox.signOff([agentId]), openNext,
    openAgent: agentId => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), open: agentId } }),
    workspace: id => store.get(id), openPanel,
    noteDone: (agentId, cancel) => inbox.noteDone(agentId, cancel), endDone: agentId => inbox.endDone(agentId),
  };
  const openItem = (key: string, extra: { question?: string } = {}) => client.openScreen({ screenId: OVERVIEW, params: { item: key, ...(extra.question ? { question: extra.question } : {}) } });
  const homeDeps = { sources, openSettings, openPanel, openLog, openHome: openOverview, openItem, briefDeps };
  const Overview = (props: PluginScreenProps) => <FollowHome {...props} deps={homeDeps} />;
  const Panel = (props: PluginWorkspacePanelProps) => <FollowPanel {...props} openSettings={openSettings} openOverview={openOverview} openLarge={openLarge} inbox={inbox} live={store} briefDeps={briefDeps} />;
  const Large = (props: PluginScreenProps) => <FollowLarge {...props} openSettings={openSettings} openOverview={openOverview} live={store} />;
  const removers: (() => unknown)[] = [
    client.addScreen({ id: OVERVIEW, title: "Follow-up", Component: Overview }),
    client.addScreen({ id: LARGE_SCREEN, title: params => store.get(params.workspaceId ?? "")?.title ?? "Follow-up", Component: Large }),
    ...LEGACY_SETTINGS_SCREENS.map(id => client.addScreen({ id, title: "Follow-up settings", Component: Settings })),
    client.addSettingsScreen({ id: "projects", title: "Follow-up", icon: "GitPullRequest", Component: Settings }),
    client.addWorkspacePanel({ id: PANEL, title: "Follow-up", icon: "GitPullRequest", locations: ["workspace", "explorer"], Component: Panel }),
    client.addCommandCenterItem({ id: "open-follow-through", title: "Follow-up: open for this workspace", icon: "GitPullRequest", keywords: ["PR", "stack", "repairs", "done", "archive"], context: "workspace", onSelect({ openPanel }) { openPanel(PANEL, { location: location() }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-large", title: "Follow-up: open the larger view", icon: "Maximize2", keywords: ["expand", "full screen", "maximize", "PR", "stack"], context: "workspace", onSelect({ workspace, openScreen }) { openScreen({ screenId: LARGE_SCREEN, params: { workspaceId: workspace.id } }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-spec", title: "Follow-up: open the spec", icon: "FileText", keywords: ["spec", "artifact", "plan", "doc", "design"], context: "workspace", onSelect({ workspace, openPanel }) {
      const url = store.get(workspace.id)?.spec?.url;
      // Without a link yet, open the panel, where the spec link can be added.
      if (url) void openExternalUrl(url).catch(() => undefined); else openPanel(PANEL, { location: location() });
    } }),
    client.addCommandCenterItem({ id: "follow-through-overview", title: "Follow-up: Home", icon: "House", keywords: ["home", "workspaces", "needs you", "inbox", "attention", "brief", "overview"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW }); } }),
    // Opens Home and focuses its search field (also `/` while Home is on screen).
    client.addCommandCenterItem({ id: "follow-through-search", title: "Follow-up: Search", icon: "Search", keywords: ["search", "find", "workspace", "branch", "PR", "omnibox"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW }); setTimeout(() => extras.focusSearch(), 150); } }),
    client.addCommandCenterItem({ id: "follow-through-log", title: "Follow-up: Done while you were away", icon: "History", keywords: ["log", "overnight", "away", "repairs", "activity"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW, params: { view: "log" } }); } }),
    client.addCommandCenterItem({ id: "follow-through-settings", title: "Follow-up: settings", icon: "Settings", keywords: ["default", "following", "project", "display", "sidebar", "pill", "header", "inbox", "questions"], context: "global", onSelect() { openSettings(); } }),
    // "Set up Follow-up again": the setup flow from the top, on Home.
    client.addCommandCenterItem({ id: "follow-through-setup", title: "Follow-up: Set up again", icon: "ListChecks", keywords: ["setup", "set up again", "restart setup", "onboarding", "getting started", "checks", "gh", "tour", "welcome"], context: "global", onSelect() { openSetup(); } }),
    client.addSlashCommand({ name: "follow-up", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(PANEL, { location: location() }); } }),
    contributeChat(client),
    contributeFollowUpPill(client, { inbox, live: store, openPanel, openNext }),
    contributeInboxCommands(client, inbox, openNext),
    contributeBrief(client, briefDeps),
  ];
  // ⌘K "Follow-up: Ask the Overseer": opens Home on the Overseer with its reply box focused (1.4.0-beta.0). Listed
  // only while the Overseer is on, so it never leads to a dead end.
  let removeAsk: (() => unknown) | null = null;
  const syncAsk = () => {
    const on = !!extras.overseer()?.enabled;
    if (on && !removeAsk) removeAsk = client.addCommandCenterItem({ id: "follow-through-ask-overseer", title: "Follow-up: Ask the Overseer", icon: "MessagesSquare", keywords: ["overseer", "ask", "route", "tell", "delegate", "assign", "which agent"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW, params: { ask: String(Date.now()) } }); } });
    else if (!on && removeAsk) { void removeAsk(); removeAsk = null; }
  };
  removers.push(extras.subscribe(syncAsk), () => removeAsk?.());
  // Phase 2: only on hosts with the sidebar-view API (Paseo main after 2026-11-07).
  const views = sidebarViewHost(host);
  if (views) removers.push(views.addSidebarView({ id: "needs-you", title: "Follow-up: Needs you", description: "Agents that need you until you sign them off, then your workspaces.", Component: inboxSidebarView(sources) }));

  return async () => {
    stopped = true;
    offActivity(); visibility.dispose(); removeDisplay(); store.stop(); inbox.stop();
    for (const r of removers) void r();
    for (const button of headers.values()) button.remove();
    await paseoWorkspaces.stop();
    await extras.stop();
  };
}
