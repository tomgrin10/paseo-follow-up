import type { PluginClientContext, PluginSidebarItemContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { inboxListRpc, trustBypassRpc } from "../shared/contracts";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { displayPreferences, displayRpc, trustCountText } from "../shared/display";
import { sidebarVisibility } from "./sidebar-visibility";
import { appVisible, onVisible } from "./visibility";

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

function TrustCount({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const read = useRpc(trustBypassRpc);
  const stats = useQuery({ queryKey: ["follow-through", "trust-bypass"], queryFn: () => read({}), refetchInterval: 60_000 });
  const text = trustCountText(stats.data);
  return text ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }}>{text}</Text> : null;
}

/**
 * The Overseer and AI priority switches, at the top of their cards in Settings → Agents. Same Display preferences as
 * before (enable_overseer, enable_ranker); only where they show moved.
 */
export function PreferenceSwitch({ field, theme }: { field: "enable_overseer" | "enable_ranker"; theme: PluginSurfaceProps["theme"] }) {
  const settings = useSettings(displayPreferences);
  if (settings.status !== "ready") return null;
  const copy = field === "enable_overseer"
    ? { label: "Run the Overseer", hint: "Off hides its row on Home and stops its digest. An Overseer you already started stays in its workspace; Follow-up never archives it." }
    : { label: "Rank with AI", hint: "Ranks Home's Priority sort from Linear, Slack, GitHub and the weekly plan. Read-only; runs hourly on workdays when something changed." };
  return <>
    <SettingsSwitch label={copy.label} hint={copy.hint} value={settings.values[field]} disabled={settings.saving}
      onValueChange={value => void settings.save({ ...settings.values, [field]: value }, settings.revision)} />
    {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, paddingHorizontal: 16, paddingBottom: 8 }}>{settings.saveError}</Text>}
  </>;
}

/**
 * Permissions, in Settings → Following after Defaults: Trust bypass agents and how many prompts it approved.
 * Same Display preference as before (enable_trust_bypass); only where it shows moved.
 */
export function PermissionsSection({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(displayPreferences);
  if (settings.status !== "ready") return null;
  return <SettingsSection title="Permissions" info="Claude Code in Bypass and Codex in Full access still stop on some tool calls and wait for a yes.">
    <SettingsCard>
      <SettingsSwitch label="Trust bypass agents" hint="Approves those tool prompts for you, judged by the agent's mode at the time. Questions and plan approval still come to you, and agents in other modes still ask." value={settings.values.enable_trust_bypass} disabled={settings.saving}
        onValueChange={enable_trust_bypass => void settings.save({ ...settings.values, enable_trust_bypass }, settings.revision)} />
    </SettingsCard>
    {settings.values.enable_trust_bypass && <TrustCount theme={theme} />}
    {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
  </SettingsSection>;
}

/** A neutral "Beta" chip for section titles. */
export function BetaChip({ theme }: Pick<PluginSurfaceProps, "theme">) {
  return <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: theme.colors.surface2 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>Beta</Text>
  </View>;
}

/** "Sidebar & pills" and "Needs-you inbox", the Inbox & display tab of Follow-up's settings. */
export function DisplaySections({ theme }: Pick<PluginSurfaceProps, "theme">) {
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
    <>
    <SettingsSection title="Sidebar & pills" info="Where Follow-up shows itself. Command-K (Ctrl-K on Windows and Linux) works whatever you hide here.">
      <SettingsCard>
        <SettingsSwitch label="Sidebar item" hint="Opens Follow-up with Needs you first. Its badge counts the agents that need you." value={settings.values.showSidebar} disabled={settings.saving} onValueChange={(showSidebar) => save({ showSidebar })} />
        <SettingsSwitch label="Workspace header button" hint="An icon in each workspace header. A dot appears when that workspace needs you." value={settings.values.enable_header_button} disabled={settings.saving} onValueChange={(enable_header_button) => save({ enable_header_button })} />
        <SettingsSwitch label="Composer pill" hint="One pill above the message box, only while that agent or its workspace needs you." value={settings.values.enable_composer_pill} disabled={settings.saving} onValueChange={(enable_composer_pill) => save({ enable_composer_pill })} />
      </SettingsCard>
      {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </SettingsSection>
    <SettingsSection title="Needs-you inbox" trailing={<BetaChip theme={theme} />} info="Agents stay in Needs you until you sign them off or write to them. Opening an agent doesn't clear it.">
      <SettingsCard>
        <SettingsSwitch label="Needs-you inbox" hint="Off: no agent is flagged. The pill still shows workspace items, and the sidebar badge counts workspaces instead." value={settings.values.enable_inbox} disabled={settings.saving} onValueChange={(enable_inbox) => save({ enable_inbox })} />
        <SettingsSwitch label="Flag merged and closed PRs" hint="At the lowest priority, as the cue to archive." value={settings.values.enable_inbox_pr_closed} disabled={settings.saving || !settings.values.enable_inbox} onValueChange={(enable_inbox_pr_closed) => save({ enable_inbox_pr_closed })} />
        <SettingsSwitch label="Ask agents to state what they need" hint="A Claude Code agent that ends a turn without saying what you need is asked once to state it, for the card at the end of its chat. Other providers only get the instruction." value={settings.values.enable_brief_nudge} disabled={settings.saving || !settings.values.enable_inbox} onValueChange={(enable_brief_nudge) => save({ enable_brief_nudge })} />
      </SettingsCard>
      {settings.values.enable_inbox && !!share.data?.briefStats && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }}>{briefShareText(share.data.briefStats)}</Text>}
    </SettingsSection>
    </>
  );
}

/** Settings notifications reach mounted screens; poll for changes made on other clients. */
export function contributeDisplay(client: PluginClientContext, item: PluginSidebarItemContribution) {
  const sidebar = sidebarVisibility(() => client.addSidebarHeaderItem(item));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its surface during that first render.
  sidebar.set(true);
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
  // Changes made on this client notify at once; other clients' changes are picked up within a minute, and not at all
  // while the app is hidden (it reads once on return).
  void refresh();
  const timer = setInterval(() => { if (appVisible()) void refresh(); }, 60_000);
  const offVisible = onVisible(() => void refresh());
  return () => {
    disposed = true;
    clearInterval(timer); offVisible();
    listeners.delete(update);
    sidebar.dispose();
  };
}
