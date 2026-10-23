import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc, openExternalUrl, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getRpc, controlRpc, refreshRpc, activateRpc, sendRpc, browserStatusRpc, checkPrActionRpc, recoverRpc } from "../shared/contracts";
import { orderedStacks, settledForDisplay } from "../shared/presentation";
import { summary, type Workspace } from "../shared/model";
import { followUpObligations, recoveryBatch } from "../shared/follow-up";
import { FollowTask } from "./tasks";
import { Button, Section, StackGroup, StatusLabel, colorFor } from "./components";

export const workspaceKey = (id: string) => ["follow-through", "workspace", id];
export const overviewKey = ["follow-through", "overview"];
export function FollowPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(getRpc);
  const query = useQuery({ queryKey: workspaceKey(props.workspaceId), queryFn: () => read({ workspaceId: props.workspaceId }), refetchInterval: 5000 });
  const base = { flex: 1, backgroundColor: props.theme.colors.surface0 };
  if (query.isPending) return <View style={[base, { padding: 16, gap: 10 }]}><ActivityIndicator color={props.theme.colors.accent} /><Text style={{ color: props.theme.colors.foregroundMuted }}>Loading…</Text></View>;
  if (query.error && !query.data?.workspace) return <View style={[base, { padding: 16, gap: 12 }]}><Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>Could not read workspace state. Refresh to retry.</Text><Button title="Retry" onPress={() => void query.refetch()} theme={props.theme} /></View>;
  if (!query.data?.workspace) return <StartTracking {...props} loadError={query.data?.error} />;
  return <WorkspaceView {...props} workspace={query.data.workspace} loadError={query.error ? "Refresh failed. Showing saved data." : query.data.error} />;
}

function StartTracking({ theme, workspaceId, layout, loadError }: PluginWorkspacePanelProps & { loadError?: string | null }) {
  const activate = useRpc(activateRpc); const cache = useQueryClient();
  const start = useMutation({ mutationFn: () => activate({ workspaceId }), onSuccess: () => { void cache.invalidateQueries({ queryKey: workspaceKey(workspaceId) }); void cache.invalidateQueries({ queryKey: overviewKey }); } });
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0, padding: 16, gap: 12 }}><Icon name="GitPullRequest" size={24} color={theme.colors.accent} /><Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>Follow this workspace</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>Track PRs and follow-through. Auto starts off.</Text>{(loadError || start.error) && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{loadError ?? start.error?.message}</Text>}<Button title={start.isPending ? "Starting…" : "Track this workspace"} primary theme={theme} compact={layout.compact} disabled={start.isPending} onPress={() => start.mutate()} /></View>;
}

export function WorkspaceView({ theme, layout, workspace, navigation, loadError }: PluginWorkspacePanelProps & { workspace: Workspace; loadError?: string | null }) {
  const control = useRpc(controlRpc); const refresh = useRpc(refreshRpc); const send = useRpc(sendRpc); const cache = useQueryClient();
  const runRecovery = useRpc(recoverRpc);
  const browserRead = useRpc(browserStatusRpc); const checkAction = useRpc(checkPrActionRpc);
  const browser = useQuery({ queryKey: ["follow-through", "browser"], queryFn: () => browserRead({}), refetchInterval: 5000 });
  const invalidated = () => { void cache.invalidateQueries({ queryKey: workspaceKey(workspace.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const change = useMutation({ mutationFn: (input: Parameters<typeof control>[0]) => control(input), onSuccess: invalidated });
  const update = useMutation({ mutationFn: () => refresh({ workspaceId: workspace.id }), onSuccess: invalidated });
  const deliver = useMutation({ mutationFn: (batchId: string) => send({ workspaceId: workspace.id, batchId }), onSuccess: invalidated });
  const recovery = useMutation({ mutationFn: () => runRecovery({ workspaceId: workspace.id }), onSuccess: invalidated });
  const inspectAction = useMutation({ mutationFn: (actionId: string) => checkAction({ workspaceId: workspace.id, actionId }), onSuccess: invalidated });
  const state = summary(workspace);
  const outstanding = followUpObligations(workspace).filter(o => !["done", "waived"].includes(o.status));
  const completed = followUpObligations(workspace).filter(o => ["done", "waived"].includes(o.status));
  const batches = workspace.batches.filter(b => !recoveryBatch(b) && !["completed", "cancelled"].includes(b.state));
  const lastRecovery = workspace.batches.filter(b => recoveryBatch(b) && b.state !== "cancelled").at(-1);
  const latest = workspace.prs.map(p => p.snapshot?.observedAt).filter(Boolean).sort().at(-1);
  const error = loadError ?? change.error?.message ?? update.error?.message ?? deliver.error?.message ?? null;
  const compact = layout.compact;
  const stacks = orderedStacks(workspace.prs);
  const activeStacks = stacks.filter(stack => !stack.prs.every(settledForDisplay));
  const settledStacks = stacks.filter(stack => stack.prs.every(settledForDisplay));
  const labelStyle = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const open = (link: string) => { void openExternalUrl(link).catch(() => undefined); };
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 12, paddingBottom: 28 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600", flex: 1 }}>Follow-up</Text><Pressable accessibilityRole="switch" aria-checked={workspace.enable_auto_sends} accessibilityLabel="Auto" accessibilityHint="Allow automatic sends in this workspace" accessibilityState={{ checked: workspace.enable_auto_sends, disabled: change.isPending }} disabled={change.isPending} onPress={() => change.mutate({ workspaceId: workspace.id, enable_auto_sends: !workspace.enable_auto_sends })} style={{ minHeight: compact ? 44 : 36, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: workspace.enable_auto_sends ? theme.colors.accent : theme.colors.border, backgroundColor: workspace.enable_auto_sends ? theme.colors.accent : theme.colors.surface0, flexDirection: "row", alignItems: "center", gap: 5, opacity: change.isPending ? 0.5 : 1 }}><Icon name={workspace.enable_auto_sends ? "Check" : "Circle"} size={13} color={workspace.enable_auto_sends ? theme.colors.accentForeground : theme.colors.foregroundMuted} /><Text style={{ fontSize: 13, color: workspace.enable_auto_sends ? theme.colors.accentForeground : theme.colors.foreground }}>Auto</Text></Pressable><Button title={update.isPending ? "Refreshing…" : "Refresh"} icon="RefreshCw" theme={theme} compact={compact} disabled={update.isPending} onPress={() => update.mutate()} /></View>
    <View style={{ marginTop: 8, gap: 6 }}><StatusLabel workspace={workspace} theme={theme} />{(state.status === "needs-you" || state.status === "done") && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{state.reason}</Text>}{workspace.hold && <Button title="Resume follow-up" theme={theme} compact={compact} onPress={() => change.mutate({ workspaceId: workspace.id, clearHold: true })} disabled={change.isPending} />}</View>
    {error && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 8 }}>{error}</Text>}
    <Section title="Pull requests" count={workspace.prs.length} theme={theme} compact={compact}>{workspace.prs.length === 0 && <Text style={labelStyle}>No PRs recorded.</Text>}{workspace.prActions.filter(a => ["sending", "uncertain"].includes(a.state)).map(a => <View key={a.id} style={{ gap: 7 }}><Text style={{ ...labelStyle, color: theme.colors.statusWarning, lineHeight: 18 }}>{a.result}</Text>{a.state === "uncertain" && <Button title={inspectAction.isPending ? "Checking…" : "Check state"} theme={theme} compact={compact} disabled={inspectAction.isPending} onPress={() => inspectAction.mutate(a.id)} />}</View>)}{inspectAction.error && <Text accessibilityRole="alert" style={{ ...labelStyle, color: theme.colors.statusDanger }}>{inspectAction.error.message}</Text>}{activeStacks.map(stack => <StackGroup browserReady={browser.data?.ready ?? false} key={stack.name} name={stack.name} prs={stack.prs} workspace={workspace} theme={theme} onOpen={open} compact={compact} />)}{settledStacks.length > 0 && <Section title="Settled" count={settledStacks.reduce((count, stack) => count + stack.prs.length, 0)} theme={theme} compact={compact} initiallyExpanded={false}>{settledStacks.map(stack => <StackGroup browserReady={browser.data?.ready ?? false} key={stack.name} name={stack.name} prs={stack.prs} workspace={workspace} theme={theme} onOpen={open} compact={compact} />)}</Section>}{activeStacks.length > 0 && browser.data && !browser.data.ready && <Section title="Optional merge when ready" theme={theme} compact={compact} initiallyExpanded={false}><Text style={[labelStyle, { lineHeight: 18 }]}>Connect Chrome for Graphite’s When ready toggle.</Text><Text style={[labelStyle, { lineHeight: 18 }]}>Requires the paired Send to Paseo extension and an open Graphite tab.</Text><Button title="Connect Graphite" theme={theme} compact={compact} onPress={() => open("https://app.graphite.com")} /></Section>}</Section>
    <Section title="Tasks" count={outstanding.length} theme={theme} compact={compact}>
      {!outstanding.length && <Text style={labelStyle}>No follow-through tasks.</Text>}
      {outstanding.map(o => <FollowTask key={o.id} obligation={o} workspace={workspace} theme={theme} compact={compact} />)}
      {completed.length > 0 && <Section title="Completed" count={completed.length} theme={theme} compact={compact} initiallyExpanded={false}>{completed.map(o => <FollowTask key={o.id} obligation={o} workspace={workspace} theme={theme} compact={compact} />)}</Section>}
    </Section>
    <Section title="Activity" count={batches.length} theme={theme} compact={compact} initiallyExpanded={batches.length > 0}>{batches.map(b => <View key={b.id} style={{ gap: 6, paddingVertical: 9, borderTopWidth: 1, borderColor: theme.colors.border }}><View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Icon name={b.state === "sent" ? "Activity" : b.state === "pending" ? "Clock" : "CircleAlert"} size={14} color={b.state === "sent" ? theme.colors.accent : theme.colors.statusWarning} /><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{b.state === "sent" ? b.recipientAgentId && b.recipientAgentId !== workspace.mainAgentId ? "Recovering" : "Agent working" : b.state === "pending" ? workspace.enable_auto_sends ? `Auto queued · ${b.tasks.length}` : `Ready · ${b.tasks.length}` : b.state === "uncertain" ? "Check delivery" : "Blocked"}</Text></View><Section title="Batch details" count={b.tasks.length} theme={theme} compact={compact} initiallyExpanded={false}>{b.tasks.map(t => <Text key={t.key} style={[labelStyle, { lineHeight: 18 }]}>{t.title}</Text>)}{b.result && <Text style={labelStyle}>{b.result}</Text>}</Section>{b.result && <Text numberOfLines={2} style={{ color: theme.colors.statusWarning, fontSize: 12, lineHeight: 18 }}>{b.result}</Text>}{b.state === "pending" && <><Button title={deliver.isPending ? "Sending…" : b.tasks.every(t => t.kind === "inventory") ? "Run recovery" : "Send batch"} theme={theme} compact={compact} disabled={deliver.isPending || workspace.runtimeBusy || !!workspace.runtimeReason || !!workspace.hold || batches.some(other => other.id !== b.id && ["sending", "sent", "blocked", "uncertain"].includes(other.state))} onPress={() => deliver.mutate(b.id)} />{workspace.runtimeBusy && <Text style={labelStyle}>Wait for active agent work to finish.</Text>}</>}{["blocked", "uncertain"].includes(b.state) && <Button title="Retry" theme={theme} compact={compact} disabled={change.isPending} onPress={() => change.mutate({ workspaceId: workspace.id, retryBatchId: b.id })} />}</View>)}{!batches.length && <Text style={labelStyle}>No pending follow-up.</Text>}</Section>
    <Section title="Workspace" theme={theme} compact={compact} initiallyExpanded={false}>
    <Text style={[labelStyle, { lineHeight: 18 }]}>{workspace.goal}</Text>
    {navigation && <View><Button title="Open main agent" theme={theme} compact={compact} onPress={() => navigation.openAgent({ agentId: workspace.mainAgentId })} /></View>}
    <Text style={[labelStyle, { marginTop: 18 }]}>{latest ? `PR status checked ${new Date(latest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Status refresh runs even when the app is closed"}</Text>
    <Section title="Recovery" theme={theme} compact={compact} initiallyExpanded={false}>
      {recovery.error && <Text accessibilityRole="alert" style={{ ...labelStyle, color: theme.colors.statusWarning }}>{recovery.error.message}</Text>}
      <Button title={recovery.isPending || lastRecovery?.state === "sending" ? "Starting recovery…" : "Run recovery"} theme={theme} compact={compact} disabled={recovery.isPending || workspace.archived || !!lastRecovery && (["pending", "sending", "sent", "uncertain"].includes(lastRecovery.state) || lastRecovery.state === "blocked" && !lastRecovery.settledAt)} onPress={() => recovery.mutate()} />
      {lastRecovery && <View style={{ gap: 6 }}><Text style={labelStyle}>{lastRecovery.state === "sent" ? "Recovery running" : lastRecovery.state === "completed" ? "Recovery complete" : lastRecovery.state === "pending" ? "Recovery ready" : lastRecovery.state === "sending" ? "Starting recovery" : "Check recovery"}</Text>
      {lastRecovery.result && <Section title="Result" theme={theme} compact={compact} initiallyExpanded={false}><Text style={labelStyle}>{lastRecovery.result}</Text></Section>}
      {lastRecovery.recipientAgentId && navigation && <Button title="Open recovery agent" theme={theme} compact={compact} onPress={() => navigation.openAgent({ agentId: lastRecovery.recipientAgentId! })} />}
      {lastRecovery.state === "pending" && <Button title="Run queued recovery" theme={theme} compact={compact} disabled={deliver.isPending} onPress={() => deliver.mutate(lastRecovery.id)} />}
      {["blocked", "uncertain"].includes(lastRecovery.state) && <Button title="Retry recovery" theme={theme} compact={compact} disabled={change.isPending} onPress={() => change.mutate({ workspaceId: workspace.id, retryBatchId: lastRecovery.id })} />}
      </View>}
    </Section>
    {workspace.completion && <Text style={{ fontSize: 12, color: colorFor(theme, state.status), marginTop: 8 }}>Ready to archive.</Text>}
    </Section>
  </ScrollView>;
}
