import { contributeDisplay } from "./client/display";
import { withNavigation } from "./client/navigation";
import { withButtonVisibility } from "./client/button-visibility";
import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { Dimensions } from "react-native";
import { FollowSettings } from "./client/settings";
import { FollowPanel } from "./client/panel";
import { FollowOverview } from "./client/overview";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const location = () => Dimensions.get("window").width < 768 ? "workspace" as const : "explorer" as const;
  const panel = () => location() === "workspace" ? "follow-through-tab" : "follow-through";
  const removeDisplay = contributeDisplay(client, { id: "follow-through-overview", title: "Follow-up", icon: "GitPullRequest", surface: "follow-through" });
  client.addSettingsScreen({ id: "projects", title: "Follow-up", icon: "GitPullRequest", Component: withNavigation(FollowSettings, client, "follow-through", "projects") });
  client.addScreen({ id: "follow-through-settings", title: "Follow-up settings", Component: withNavigation(FollowSettings, client, "follow-through", "projects") });
  client.addCommandCenterItem({ id: "follow-through-settings", title: "Follow-up: project settings", icon: "Settings", keywords: ["default", "tracking", "project"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: "follow-through-settings" }); } });
  client.addSurface("follow-through", withNavigation(FollowOverview, client, "follow-through"));
  client.addSurface("project-settings", withNavigation(FollowSettings, client, "follow-through", "projects"));

  client.addWorkspacePanel({ id: "follow-through", title: "Follow-up", icon: "GitPullRequest", context: "workspace", locations: ["workspace", "explorer"], Component: withNavigation(FollowPanel, client, "follow-through") });
  client.addWorkspacePanel({ id: "follow-through-tab", title: "Follow-up", icon: "GitPullRequest", context: "workspace", locations: ["workspace"], Component: withNavigation(FollowPanel, client, "follow-through") });
  client.addCommandCenterItem({ id: "open-follow-through", title: "Open workspace follow-up", icon: "GitPullRequest", keywords: ["PR", "stack", "done", "archive"], context: "workspace", onSelect({ openPanel }) { openPanel(panel(), { location: location() }); } });
  client.addCommandCenterItem({ id: "follow-through-overview", title: "Open follow-up overview", icon: "GitPullRequest", keywords: ["workspaces", "attention", "done"], context: "global", onSelect({ openScreen }) { openScreen({ screenId: "follow-through" }); } });
  client.addSlashCommand({ name: "follow-through", description: "Open this workspace's PRs and remaining work", argumentHint: "", context: "agent", onSubmit({ openPanel }) { openPanel(panel(), { location: location() }); } });
  const headers = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let releaseObservation: (() => Promise<void>) | null = null;
  const register = (workspaceId: string) => {
    if (stopped || headers.has(workspaceId)) return;
    headers.set(workspaceId, client.addHeaderButton({ id: "follow-through", workspaceId, button: { title: "Open workspace follow-up", label: "Follow-up", icon: "GitPullRequest", behavior: { kind: "action", onPress() { client.openPanel(panel(), { workspaceId, location: location() }); } } } }));
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
  return async () => { visibility.dispose(); removeDisplay(); stopped = true; remove(); for (const button of headers.values()) button.remove(); await releaseObservation?.(); };
}
