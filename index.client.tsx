import { LEGACY_SETTINGS_SCREEN } from "./shared/legacy";
import { contributeDisplay } from "./client/display";
import { createNewKey, createSearchKey, installSearchShortcut } from "./client/search-key";
import { requestSearch } from "./client/search-focus";
import { contributeNewRow } from "./client/new-entry";
import { NEW_NAME, OLD_NAMES } from "./shared/new-name";
import { closeNew, newShowing, openNew, setNewFallback, type NewRequest } from "./client/new";
import { withButtonVisibility } from "./client/button-visibility";
import { openExternalUrl, type PluginClientContext, type PluginButtonRegistration, type PluginScreenProps, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FollowSettings } from "./client/settings";
import { FollowHome, HOME_SCREEN } from "./client/home";
import { setOpenStats } from "./client/pr-stats-settings";
import type { StatsParams } from "./client/pr-stats";
import { MODE } from "./shared/catch-up";
import { FollowPanel } from "./client/panel";
import { createPaseoWorkspaces } from "./client/home-data";
import { createHomeExtras } from "./client/home-view";
import { setContextSource } from "./client/more-context";
import { contributeChat } from "./client/chat";
import { contributeCreated } from "./client/created";
import { hasFeeds } from "./client/feeds";
import { createLiveStore, headerIcon, sidebarItem } from "./client/live";
import { FOLLOW_UP_ICON } from "./client/follow-up-icon";
import { contributeFollowUpPill } from "./client/pill";
import { contributeRowBadges } from "./client/row-badges";
import { LargeRedirect, LARGE_SCREEN } from "./client/large";
import { bindDismissInbox } from "./client/dismiss";
import { createInboxStore } from "./client/inbox-store";
import { contributeInboxCommands } from "./client/inbox";
import type { BriefDeps } from "./client/brief";
import { inboxSidebarView, sidebarViewHost } from "./client/sidebar-view";
import { OVERSEER_KEY } from "./client/home-list";
import { contributeBrief } from "./client/brief";
import { clientTimeZoneRpc, setOnboardingRpc } from "./shared/contracts";
import { createSettings } from "./client/settings-screens";
import type { SettingsCategory } from "./shared/settings-nav";
import { openReportSheet, ReportSheetHost, setReportFallback } from "./client/report-issue";
import { openRename, RenameHost } from "./client/rename";
import { setReportError } from "./client/toast-store";
import { contextAskRpc, reportSendRpc } from "./shared/contracts";
import { runAction } from "./client/toast-store";
import { KeyboardRoom } from "./client/keyboard";

/** Home. The same screen id the Overview had, so the sidebar row, ⌘K and saved links land on Home. */
const OVERVIEW = HOME_SCREEN;
/**
 * The workspace view (invariant 135): one view, two registrations. `follow-up` is the side panel (the explorer column;
 * still allowed as a tab for one more release, so saved layouts keep working). `follow-up-view` is the main area's
 * tab: every new open (the header button, ⌘K, /follow-up, a phone, the side panel's Open in a tab) opens it.
 */
const PANEL = "follow-up";
const VIEW = "follow-up-view";
/** Old settings screen ids, kept only so saved links and restored routes still open the one settings page. */
const LEGACY_SETTINGS_SCREENS = [LEGACY_SETTINGS_SCREEN, "project-settings", "display-settings"];

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const openPanel = (workspaceId: string) => client.openPanel(VIEW, { workspaceId, location: "workspace" });
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
  const openOverview = () => client.openScreen({ screenId: OVERVIEW });
  const openLog = () => client.openScreen({ screenId: OVERVIEW, params: { view: "log" } });
  const openQueue = () => client.openScreen({ screenId: OVERVIEW, params: { view: "queue" } });
  const openCatchUp = () => client.openScreen({ screenId: OVERVIEW, params: { view: "catchup", at: "0", n: String(Date.now()) } });
  // PR stats (docs/pr-stats.md#the-page): Home's view `stats`; a phone's person drill-down is its own screen.
  const openStats = (params: StatsParams = {}) => client.openScreen({ screenId: OVERVIEW, params: { view: "stats", ...Object.fromEntries(Object.entries(params).filter(([, v]) => !!v)) as Record<string, string>, n: String(Date.now()) } });
  setOpenStats(() => openStats());
  // "Set up Follow-up again" (Settings and ⌘K): restart the flow on the server, then open Home, which shows it.
  // `resume`: setup is already in progress, so open it where it was left instead of from the top.
  const openSetup = (resume = false) => { void (resume ? Promise.resolve() : client.rpc(setOnboardingRpc, { action: "restart" }).catch(() => undefined)).then(() => client.openScreen({ screenId: OVERVIEW, params: { setup: String(Date.now()) } })); };
  // Report a bug (docs/report-issue.md): the sheet lives on Home, the panel and Settings; with none on screen, Home opens
  // and its host shows the request already waiting.
  setReportFallback(() => client.openScreen({ screenId: OVERVIEW }));
  setReportError((message, at) => openReportSheet({ kind: "bug", error: message, at }));
  const reportHost = (props: PluginSurfaceProps | PluginWorkspacePanelProps) => <><ReportSheetHost theme={props.theme} layout={props.layout} openAgent={props.navigation ? agentId => props.navigation!.openAgent({ agentId }) : undefined} /><RenameHost theme={props.theme} compact={props.layout.compact} /></>;
  const Settings = (props: PluginSurfaceProps & { category?: SettingsCategory }) => <KeyboardRoom compact={props.layout.compact}><FollowSettings {...props} openSetup={openSetup} openReport={() => openReportSheet()} openSettings={category => openSettings(category)} />{reportHost(props)}</KeyboardRoom>;
  // Paseo 0.16: one settings screen per category (its own tabs); 0.15: one screen with Follow-up's tabs (client/settings-screens.ts).
  const settings = createSettings(client, Settings);
  const openSettings = settings.open;
  const store = createLiveStore(client);
  const inbox = createInboxStore(host);
  // A brief's x (client/dismiss.tsx) updates the inbox rows at once, like Sign off.
  bindDismissInbox(inbox);
  // answering-is-optimistic: rows read against the workspaces with the developer's answers overlaid.
  const offSettle = inbox.settleWith(id => store.get(id), listener => store.subscribe(listener));
  const HeaderIcon = headerIcon(store);
  const headers = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const register = (workspaceId: string) => {
    if (stopped || headers.has(workspaceId)) return;
    // The header button opens (docks) this workspace's panel.
    headers.set(workspaceId, client.addHeaderButton({ id: "follow-up", workspaceId, button: { title: "Follow-up", icon: HeaderIcon, behavior: { kind: "action", onPress() { openPanel(workspaceId); } } } }));
  };
  const paseoWorkspaces = createPaseoWorkspaces(client, { onAdd: register, onRemove: id => { headers.get(id)?.remove(); headers.delete(id); } });
  const extras = createHomeExtras(client);
  // One store of More context asks for every question surface (client/more-context.tsx).
  setContextSource(extras);
  const searchKey = createSearchKey();
  // New (client/new.tsx): every entry point goes through openNew. The Home on screen shows it in place; with none on
  // screen (a chat in front, or only a Home Paseo keeps mounted behind), the request waits and Home opens with `new`
  // set, whose host shows it (new-opens-where-you-are). The key toggles it.
  const newKey = createNewKey();
  let newToken = 0;
  const homeWithNew = (r: NewRequest) => ({ screenId: OVERVIEW, params: { new: String(++newToken), ...(r.source ? { source: r.source } : {}) } });
  setNewFallback(r => client.openScreen(homeWithNew(r)));
  const enterNew = (openScreen: (t: { screenId: string; params?: Record<string, string> }) => void) => openNew({}, { navigate: r => openScreen(homeWithNew(r)) });
  const openNewAnywhere = () => { if (newShowing()) { closeNew(); return; } enterNew(t => client.openScreen(t)); };
  const sources = { inbox, live: store, paseo: paseoWorkspaces, extras };
  const offActivity = extras.onActivity(() => { inbox.nudge(); store.nudge(); });
  // "Sign off & next" from a pill or ⌘K: the screen relays it to the host's navigation.
  let nextToken = 0;
  const openNext = (from: string | null) => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), ...(from ? { from } : {}) } });

  const removeDisplay = contributeDisplay(client, { id: "follow-up-overview", title: "Follow-up", Component: sidebarItem(sources, OVERVIEW, { openSettings: category => openSettings(category as SettingsCategory) }) });
  const briefDeps: BriefDeps = {
    signOff: agentId => void inbox.signOff([agentId]), openNext,
    openAgent: agentId => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), open: agentId } }),
    workspace: id => store.get(id), openPanel, row: agentId => inbox.rows().find(r => r.agentId === agentId) ?? null,
    noteDone: (agentId, cancel) => inbox.noteDone(agentId, cancel), endDone: agentId => inbox.endDone(agentId),
    holdAnswered: agentId => inbox.holdAnswered(agentId),
  };
  const openItem = (key: string, extra: { question?: string } = {}) => client.openScreen({ screenId: OVERVIEW, params: { item: key, ...(extra.question ? { question: extra.question } : {}) } });
  const homeDeps = { sources, openSettings, openPanel, openLog, openQueue, openCatchUp, openStats, openHome: openOverview, openItem, briefDeps, searchKey, newKey };
  const Overview = (props: PluginScreenProps) => <KeyboardRoom compact={props.layout.compact}><FollowHome {...props} deps={homeDeps} />{reportHost(props)}</KeyboardRoom>;
  const Panel = (props: PluginWorkspacePanelProps) => <KeyboardRoom compact={props.layout.compact}><FollowPanel {...props} place="panel" openSettings={openSettings} openOverview={openOverview} openView={openPanel} inbox={inbox} live={store} briefDeps={briefDeps} sources={sources} />{reportHost(props)}</KeyboardRoom>;
  const ViewTab = (props: PluginWorkspacePanelProps) => <KeyboardRoom compact={props.layout.compact}><FollowPanel {...props} place="tab" openSettings={openSettings} openOverview={openOverview} inbox={inbox} live={store} briefDeps={briefDeps} sources={sources} />{reportHost(props)}</KeyboardRoom>;
  const Large = (props: PluginScreenProps) => <LargeRedirect {...props} openView={openPanel} />;
  const removers: (() => unknown)[] = [
    client.addScreen({ id: OVERVIEW, title: "Follow-up", Component: Overview }),
    client.addScreen({ id: LARGE_SCREEN, title: params => store.get(params.workspaceId ?? "")?.title ?? "Follow-up", Component: Large }),
    ...LEGACY_SETTINGS_SCREENS.map(id => client.addScreen({ id, title: "Follow-up settings", Component: Settings })),
    settings.remove,
    client.addWorkspacePanel({ id: PANEL, title: "Follow-up", icon: FOLLOW_UP_ICON, locations: ["explorer", "workspace"], Component: Panel }),
    client.addWorkspacePanel({ id: VIEW, title: "Follow-up", icon: FOLLOW_UP_ICON, locations: ["workspace"], Component: ViewTab }),
    client.addCommandCenterItem({ id: "open-follow-up", title: "Follow-up: open for this workspace", icon: FOLLOW_UP_ICON, keywords: ["PR", "stack", "repairs", "done", "archive", "expand", "full screen", "larger view"], context: "workspace", onSelect({ openPanel }) { openPanel(VIEW, { location: "workspace" }); } }),
    client.addCommandCenterItem({ id: "open-follow-up-side", title: "Follow-up: open in the side panel", icon: "PanelRight", keywords: ["sidebar", "explorer", "dock", "PR", "stack"], context: "workspace", onSelect({ openPanel }) { openPanel(PANEL, { location: "explorer" }); } }),
    client.addCommandCenterItem({ id: "open-follow-up-spec", title: "Follow-up: open the spec", icon: "FileText", keywords: ["spec", "artifact", "plan", "doc", "design"], context: "workspace", onSelect({ workspace, openPanel }) {
      const url = store.get(workspace.id)?.spec?.url;
      // Without a link yet, open the panel, where the spec link can be added.
      if (url) void openExternalUrl(url).catch(() => undefined); else openPanel(VIEW, { location: "workspace" });
    } }),
    client.addCommandCenterItem({ id: "follow-up-rename", title: "Follow-up: Rename title with AI", icon: "Sparkles", keywords: ["rename", "name", "title", "AI", "suggest"], context: "workspace", onSelect({ workspace, openPanel }) {
      // The dialog lives in Follow-up's surfaces: open the panel, which mounts a host, then ask.
      openPanel(VIEW, { location: "workspace" }); setTimeout(() => openRename({ workspaceId: workspace.id }), 0); } }),
    client.addCommandCenterItem({ id: "follow-up-overview", title: "Follow-up: Home", icon: "House", keywords: ["home", "workspaces", "needs you", "inbox", "attention", "brief", "overview"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW }); } }),
    client.addCommandCenterItem({ id: "follow-up-catch-up", title: MODE.command, icon: "Layers", keywords: ["catch up", "inbox", "needs you", "triage", "answer", "questions", "one by one"], context: "global", onSelect() { openCatchUp(); } }),
    client.addCommandCenterItem({ id: "follow-up-pr-stats", title: "Follow-up: PR stats", icon: "ChartNoAxesColumn", keywords: ["statistics", "stats", "review time", "team", "leaderboard", "who", "PRs opened", "wait"], context: "global", onSelect() { openStats(); } }),
    client.addCommandCenterItem({ id: "follow-up-log", title: "Follow-up: Done while you were away", icon: "History", keywords: ["log", "overnight", "away", "repairs", "activity"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW, params: { view: "log" } }); } }),
    client.addCommandCenterItem({ id: "follow-up-settings", title: "Follow-up: settings", icon: "Settings", keywords: ["default", "following", "project", "display", "sidebar", "pill", "header", "inbox", "questions"], context: "global", onSelect() { openSettings(); } }),
    // "Set up Follow-up again": the setup flow from the top, on Home.
    client.addCommandCenterItem({ id: "follow-up-setup", title: "Follow-up: Set up again", icon: "ListChecks", keywords: ["setup", "set up again", "restart setup", "onboarding", "getting started", "checks", "gh", "tour", "welcome"], context: "global", onSelect() { openSetup(); } }),
    client.addCommandCenterItem({ id: "follow-up-report-issue", title: "Follow-up: Report a bug, idea or feedback", icon: "Bug", keywords: ["bug", "report", "issue", "problem", "broken", "feature request", "idea", "feedback", "github", "help"], context: "global", onSelect() { openReportSheet(); } }),
    // /report-issue: words go straight to this agent; with none, the sheet opens with this agent picked.
    client.addSlashCommand({ name: "report-issue", description: "Report a Follow-up bug, idea or feedback; this agent files it on GitHub after you OK it", argumentHint: "what happened", context: "agent", async onSubmit({ args, agent, workspace, rpc }) {
      if (args.trim()) await rpc(reportSendRpc, { kind: "bug", text: args.trim(), agentId: agent.id }).catch(() => openReportSheet({ agentId: agent.id, workspaceId: workspace.id }));
      else openReportSheet({ agentId: agent.id, workspaceId: workspace.id });
    } }),
    // /ask <question> (docs/needs-you.md#your-questions): asks *this* agent; the answer lands in Your questions. A
    // refusal (an untracked workspace, no words) shows its error.
    client.addSlashCommand({ name: "ask", description: "Ask this agent; Follow-up keeps the answer", argumentHint: "your question", context: "agent", async onSubmit({ args, agent, workspace, rpc }) {
      const ask = args.trim();
      await runAction({ label: "Ask", failure: "Couldn't ask", success: "Asked · the answer lands in Follow-up's Your questions",
        run: async () => { if (!ask) throw new Error("Write the question after /ask."); return rpc(contextAskRpc, { workspaceId: workspace.id, agentId: agent.id, ask, via: "slash" }); } });
    } }),
    client.addSlashCommand({ name: "follow-up", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(VIEW, { location: "workspace" }); } }),
    contributeChat(client),
    // Agents and workspaces an agent creates: a card that opens them, relayed through Home (timeline items get no navigation).
    contributeCreated(client, { watchAgent: hasFeeds(client) ? extras.watchAgent : null, openAgent: briefDeps.openAgent, openWorkspace: workspaceId => client.openScreen({ screenId: OVERVIEW, params: { next: String(++nextToken), openWorkspace: workspaceId } }) }),
    contributeFollowUpPill(client, { inbox, live: store, openPanel, openNext }),
    // Paseo 0.17.1+: Done on sidebar workspace rows, in place of the worker's Done label (client/row-badges.tsx).
    contributeRowBadges(host, store),
    contributeInboxCommands(client, inbox, openNext),
    contributeBrief(client, briefDeps),
  ];
  // ⌘K "Follow-up: Ask the Overseer": opens Home on the Overseer with its reply box focused (1.4.0-beta.0). Listed
  // only while the Overseer is on, so it never leads to a dead end.
  let removeAsk: (() => unknown) | null = null;
  const syncAsk = () => {
    const on = !!extras.overseer()?.enabled;
    if (on && !removeAsk) removeAsk = client.addCommandCenterItem({ id: "follow-up-ask-overseer", title: "Follow-up: Ask the Overseer", icon: "MessagesSquare", keywords: ["overseer", "ask", "route", "tell", "delegate", "assign", "which agent"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW, params: { ask: String(Date.now()) } }); } });
    else if (!on && removeAsk) { void removeAsk(); removeAsk = null; }
  };
  removers.push(extras.subscribe(syncAsk), () => removeAsk?.());
  // ⌘K "Follow-up: Search" opens Home and focuses its search; its title names the search-from-anywhere key
  // (Settings → Display), re-listed when that key changes. The key itself is one global listener.
  let removeSearch: (() => unknown) | null = null;
  const syncSearch = () => {
    void removeSearch?.();
    const label = searchKey.label();
    removeSearch = client.addCommandCenterItem({ id: "follow-up-search", title: label ? `Follow-up: Search (${label})` : "Follow-up: Search", icon: "Search", keywords: ["search", "find", "workspace", "branch", "PR", "omnibox", "shortcut"], context: "global",
      onSelect({ openScreen }) { requestSearch(extras.searchFocus, () => openScreen({ screenId: OVERVIEW })); } });
  };
  syncSearch();
  // ⌘K "Follow-up: New…" names New's key the same way, re-listed when it changes.
  let removeNew: (() => unknown) | null = null;
  const syncNew = () => {
    void removeNew?.();
    const label = newKey.label();
    removeNew = client.addCommandCenterItem({ id: "follow-up-new", title: label ? `Follow-up: ${NEW_NAME}… (${label})` : `Follow-up: ${NEW_NAME}…`, icon: "Plus", keywords: [...OLD_NAMES, "dispatch", "start", "workspace", "issue", "linear", "task", "create"], context: "global",
      onSelect({ openScreen }) { enterNew(openScreen); } });
  };
  syncNew();
  removers.push(newKey.subscribe(syncNew), () => removeNew?.());
  // The sidebar's New row, optional (its Display switch, new-row-is-optional). Paseo also lists it under its title in Settings →
  // Sidebar → Header, beside its own "New workspace".
  removers.push(contributeNewRow(client, newKey, enterNew));
  removers.push(searchKey.subscribe(syncSearch), () => removeSearch?.(), installSearchShortcut(client, searchKey, { screenId: OVERVIEW, focus: extras.searchFocus }, { key: newKey, open: openNewAnywhere }));
  // Phase 2: only on hosts with the sidebar-view API (Paseo main after 2026-11-07).
  const views = sidebarViewHost(host);
  if (views) removers.push(views.addSidebarView({ id: "needs-you", title: "Follow-up: Needs you", description: "Agents that need you until you sign them off, then your workspaces.", Component: inboxSidebarView(sources, () => client.openScreen({ screenId: OVERVIEW, params: { item: OVERSEER_KEY, at: String(Date.now()) } }), openPanel) }));

  return async () => {
    setReportFallback(null); setReportError(null); setNewFallback(null);
    stopped = true;
    offActivity(); visibility.dispose(); removeDisplay(); offSettle(); store.stop(); inbox.stop();
    for (const r of removers) void r();
    for (const button of headers.values()) button.remove();
    await paseoWorkspaces.stop();
    setContextSource(null);
    await extras.stop();
  };
}
