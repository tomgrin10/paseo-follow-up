import type { PluginClientContext, PluginSidebarItemContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { inboxListRpc } from "../shared/contracts";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { displayPreferences, displayRpc } from "../shared/display";
import { sidebarVisibility } from "./sidebar-visibility";

type Display = import("zod").infer<typeof displayPreferences.schema>;
const listeners = new Set<(values: Display) => void>();
export function subscribeDisplay(listener: (values: Display) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** R2's measurement, where it's cheap to look: how often agents stated what they need on a flagged turn. */
export function briefShareText(stats: { days: number; total: number; tool: number; structured: number; fallback: number } | undefined): string {
  if (!stats) return "";
  if (!stats.total) return `No flagged turns in the last ${stats.days} days yet.`;
  const pct = Math.round((stats.tool / stats.total) * 100);
  const rest = [stats.structured ? `${stats.structured} from a permission, pause, error or PR` : "", stats.fallback ? `${stats.fallback} with nothing stated` : ""].filter(Boolean).join(", ");
  return `Last ${stats.days} days: agents stated what they need on ${stats.tool} of ${stats.total} flagged turns (${pct}%).${rest ? ` ${rest[0].toUpperCase()}${rest.slice(1)}.` : ""}`;
}

function DisplaySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displayPreferences);
  const list = useRpc(inboxListRpc);
  const share = useQuery({ queryKey: ["follow-through", "brief-share"], queryFn: () => list({}), refetchInterval: 60_000 });
  const values = settings.status === "ready" ? settings.values : undefined;
  useEffect(() => {
    if (values !== undefined) for (const listener of listeners) listener(values);
  }, [values]);

  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading display settings" color={theme.colors.foregroundMuted} />;
  if (settings.status !== "ready") return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
      <SettingsCard>
        <SettingsAction label="Try loading the saved settings again" actionLabel="Retry" onPress={() => void settings.reload()} />
        {settings.status === "invalid" && <SettingsAction label="Replace invalid display settings with defaults" actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset()} />}

      </SettingsCard>
      {settings.saveError && <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </View>
  );

  const save = (patch: Partial<Display>) => void settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
    <SettingsSection title="Where Follow-up appears" info="Every entry point opens the same panel. Command-K (Ctrl-K on Windows and Linux) works whatever you hide here.">
      <SettingsCard>
        <SettingsSwitch label="Sidebar row" hint="Opens all tracked workspaces, with a count when some need you." value={settings.values.showSidebar} disabled={settings.saving} onValueChange={(showSidebar) => save({ showSidebar })} />
        <SettingsSwitch label="Workspace header button" hint="An icon in each workspace header. A dot appears when that workspace needs you." value={settings.values.enable_header_button} disabled={settings.saving} onValueChange={(enable_header_button) => save({ enable_header_button })} />
        <SettingsSwitch label="Composer pill" hint="Shows above the message box only while the workspace needs you." value={settings.values.enable_composer_pill} disabled={settings.saving} onValueChange={(enable_composer_pill) => save({ enable_composer_pill })} />
      </SettingsCard>
      {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </SettingsSection>
    <SettingsSection title="Needs-you inbox (beta)" info="Agents stay in Needs you until you sign them off or write to them. Opening an agent doesn't clear it.">
      <SettingsCard>
        <SettingsSwitch label="Needs-you inbox" hint="Off: nothing is flagged, and the pill and sidebar item are hidden." value={settings.values.enable_inbox} disabled={settings.saving} onValueChange={(enable_inbox) => save({ enable_inbox })} />
        <SettingsSwitch label="Show the sidebar item at zero" hint="By default the Needs you item appears only while something needs you." value={settings.values.enable_inbox_header_when_empty} disabled={settings.saving || !settings.values.enable_inbox} onValueChange={(enable_inbox_header_when_empty) => save({ enable_inbox_header_when_empty })} />
        <SettingsSwitch label="Flag merged and closed PRs" hint="At the lowest priority, as the cue to archive." value={settings.values.enable_inbox_pr_closed} disabled={settings.saving || !settings.values.enable_inbox} onValueChange={(enable_inbox_pr_closed) => save({ enable_inbox_pr_closed })} />
        <SettingsSwitch label="Ask agents to state what they need" hint="A Claude Code agent that ends a turn without saying what you need is asked once to state it, for the card at the end of its chat. Other providers only get the instruction." value={settings.values.enable_brief_nudge} disabled={settings.saving || !settings.values.enable_inbox} onValueChange={(enable_brief_nudge) => save({ enable_brief_nudge })} />
      </SettingsCard>
      {settings.values.enable_inbox && !!share.data?.briefStats && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }}>{briefShareText(share.data.briefStats)}</Text>}
    </SettingsSection>
    </ScrollView>
  );
}

/** Settings notifications reach mounted screens; poll for changes made on other clients. */
export function contributeDisplay(client: PluginClientContext, item: PluginSidebarItemContribution) {
  const sidebar = sidebarVisibility(() => client.addSidebarHeaderItem(item));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its surface during that first render.
  sidebar.set(true);
  const Settings = DisplaySettings;
  const removeSurface = client.addScreen({ id: "display-settings", title: "Follow-up display", Component: Settings });
  const removeSettings = client.addSettingsScreen({ id: "display", title: "Display", icon: "PanelLeft", Component: Settings });
  const removeCommand = client.addCommandCenterItem({
    id: "display-settings",
    title: "Follow-up: display settings",
    icon: "PanelLeft",
    keywords: ["Follow-up", "sidebar", "pill", "header", "show", "hide", "display", "settings"],
    context: "global",
    onSelect({ openScreen }) { openScreen({ screenId: "display-settings" }); },
  });
  let disposed = false;
  let pending = false;
  let generation = 0;
  const update = (values: Display) => { generation += 1; sidebar.set(values.showSidebar); };
  listeners.add(update);
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    const currentGeneration = generation;
    try {
      const result = await client.rpc(displayRpc.read, {});
      if (!disposed && generation === currentGeneration && result.status === "ready") {
        const parsed = displayPreferences.schema.safeParse(result.values);
        if (parsed.success) { sidebar.set(parsed.data.showSidebar); for (const listener of listeners) listener(parsed.data); }
      }
    } catch {
      // Retain the last valid preference through temporary disconnects.
    } finally { pending = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  return () => {
    disposed = true;
    clearInterval(timer);
    listeners.delete(update);
    sidebar.dispose();
    removeSurface();
    removeSettings();
    removeCommand();
  };
}
