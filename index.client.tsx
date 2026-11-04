import { contributeDisplay } from "./client/display";
import { withButtonVisibility } from "./client/button-visibility";
import { openExternalUrl, type PluginClientContext, type PluginButtonRegistration, type PluginScreenProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Dimensions } from "react-native";
import { FollowSettings } from "./client/settings";
import { FollowPanel } from "./client/panel";
import { FollowOverview } from "./client/overview";
import { contributeChat } from "./client/chat";
import { contributePills, createLiveStore, headerIcon, sidebarItem } from "./client/live";
import { FollowLarge, LARGE_SCREEN } from "./client/large";

const OVERVIEW = "follow-through";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const location = () => Dimensions.get("window").width < 768 ? "workspace" as const : "explorer" as const;
  const panel = () => location() === "workspace" ? "follow-through-tab" : "follow-through";
  const openPanel = (workspaceId: string) => client.openPanel(panel(), { workspaceId, location: location() });
  const openSettings = () => client.openSettings("projects");
  const openOverview = () => client.openScreen({ screenId: OVERVIEW });
  const openLarge = (workspaceId: string) => client.openScreen({ screenId: LARGE_SCREEN, params: { workspaceId } });
  const store = createLiveStore(client);

  const removeDisplay = contributeDisplay(client, { id: "follow-through-overview", title: "Follow-up", Component: sidebarItem(store, OVERVIEW) });
  const Overview = (props: PluginScreenProps) => <FollowOverview {...props} openSettings={openSettings} />;
  const Panel = (props: PluginWorkspacePanelProps) => <FollowPanel {...props} openSettings={openSettings} openOverview={openOverview} openLarge={openLarge} />;
  const Large = (props: PluginScreenProps) => <FollowLarge {...props} openSettings={openSettings} openOverview={openOverview} />;
  const removers: (() => unknown)[] = [
    client.addScreen({ id: OVERVIEW, title: "Follow-up", Component: Overview }),
    client.addScreen({ id: LARGE_SCREEN, title: params => store.get(params.workspaceId ?? "")?.title ?? "Follow-up", Component: Large }),
    client.addScreen({ id: "follow-through-settings", title: "Follow-up settings", Component: FollowSettings }),
    client.addScreen({ id: "project-settings", title: "Follow-up settings", Component: FollowSettings }),
    client.addSettingsScreen({ id: "projects", title: "Follow-up", icon: "GitPullRequest", Component: FollowSettings }),
    client.addWorkspacePanel({ id: "follow-through", title: "Follow-up", icon: "GitPullRequest", locations: ["workspace", "explorer"], Component: Panel }),
    client.addWorkspacePanel({ id: "follow-through-tab", title: "Follow-up", icon: "GitPullRequest", locations: ["workspace"], Component: Panel }),
    client.addCommandCenterItem({ id: "open-follow-through", title: "Follow-up: open for this workspace", icon: "GitPullRequest", keywords: ["PR", "stack", "repairs", "done", "archive", "follow-through"], context: "workspace", onSelect({ openPanel }) { openPanel(panel(), { location: location() }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-large", title: "Follow-up: open the larger view", icon: "Maximize2", keywords: ["expand", "full screen", "maximize", "PR", "stack"], context: "workspace", onSelect({ workspace, openScreen }) { openScreen({ screenId: LARGE_SCREEN, params: { workspaceId: workspace.id } }); } }),
    client.addCommandCenterItem({ id: "open-follow-through-spec", title: "Follow-up: open the spec", icon: "FileText", keywords: ["spec", "artifact", "plan", "doc", "design"], context: "workspace", onSelect({ workspace, openPanel }) {
      const url = store.get(workspace.id)?.spec?.url;
      // Without a link yet, open the panel, where the spec link can be added.
      if (url) void openExternalUrl(url).catch(() => undefined); else openPanel(panel(), { location: location() });
    } }),
    client.addCommandCenterItem({ id: "follow-through-overview", title: "Follow-up: all tracked workspaces", icon: "LayoutList", keywords: ["workspaces", "needs you", "attention", "done", "overview"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW }); } }),
    client.addCommandCenterItem({ id: "follow-through-settings", title: "Follow-up: project settings", icon: "Settings", keywords: ["default", "tracking", "project"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: "follow-through-settings" }); } }),
    client.addSlashCommand({ name: "follow-up", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(panel(), { location: location() }); } }),
    client.addSlashCommand({ name: "follow-through", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(panel(), { location: location() }); } }),
    contributeChat(client),
    contributePills(client, store, openPanel),
  ];

  const HeaderIcon = headerIcon(store);
  const headers = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let releaseObservation: (() => Promise<void>) | null = null;
  const register = (workspaceId: string) => {
    if (stopped || headers.has(workspaceId)) return;
    headers.set(workspaceId, client.addHeaderButton({ id: "follow-through", workspaceId, button: { title: "Follow-up", icon: HeaderIcon, behavior: { kind: "action", onPress() { openPanel(workspaceId); } } } }));
  };
  const remove = client.paseo.workspaces.subscribe(update => {
    if (update.kind === "remove") { headers.get(update.id)?.remove(); headers.delete(update.id); }
    else register(update.workspace.id);
  });
  void (async () => {
    const page = await client.paseo.workspaces.list({ subscribe: {}, page: { limit: 200 } });
    if (stopped) { await page.subscription.release(); return; }
    releaseObservation = () => page.subscription.release();
    page.entries.forEach(w => register(w.id));
    let cursor = page.pageInfo.nextCursor;
    while (cursor && !stopped) {
      const next = await client.paseo.workspaces.list({ page: { limit: 200, cursor } });
      next.entries.forEach(w => register(w.id));
      if (next.pageInfo.nextCursor === cursor) break;
      cursor = next.pageInfo.nextCursor;
    }
  })().catch(() => undefined);
  return async () => {
    stopped = true;
    visibility.dispose(); removeDisplay(); remove(); store.stop();
    for (const r of removers) void r();
    for (const button of headers.values()) button.remove();
    await releaseObservation?.();
  };
}
