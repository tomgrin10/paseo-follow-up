import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc, useTabState, openExternalUrl, type PluginHostProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getRpc, controlRpc, refreshRpc, activateRpc, browserStatusRpc, recoverRpc, sendRpc } from "../shared/contracts";
import { summary, type Workspace } from "../shared/model";
import { followUpObligations, recoveryBatch } from "../shared/follow-up";
import { settledForDisplay } from "../shared/presentation";
import { ago, sendBlocker, shortRefs } from "../shared/attention";
import { Button, Card, CardRow, FoldRow, IconButton, errorText, text, useNow, type Theme } from "./kit";
import { Reveal, Skeleton, Spinner } from "./motion";
import { WorkspaceHeader } from "./header";
import { NeedsYouCard, overviewKey, workspaceKey } from "./needs-you";
import { StacksCard } from "./stacks";
import { TasksCard } from "./tasks";
import { PrSheet } from "./pr-sheet";
import { ActivityCard, QuestionSheet } from "./questions";
import { SpecRow, SpecSheet } from "./spec";
import { mergedColor, tint } from "./theme";

export { overviewKey, workspaceKey };

export type PanelLinks = { openSettings: () => void; openOverview: () => void; openLarge?: (workspaceId: string) => void };
type PanelProps = PluginWorkspacePanelProps & PanelLinks;

export function FollowPanel(props: PanelProps) {
  const read = useRpc(getRpc);
  const query = useQuery({ queryKey: workspaceKey(props.workspaceId), queryFn: () => read({ workspaceId: props.workspaceId }), refetchInterval: 5000 });
  const c = props.theme.colors;
  const base = { flex: 1, backgroundColor: c.surface0 };
  if (query.isPending) return <PanelSkeleton theme={props.theme} compact={props.layout.compact} />;
  if (query.error && !query.data?.workspace) return <View style={[base, { padding: props.layout.compact ? 16 : 12 }]}>
    <Card theme={props.theme} compact={props.layout.compact} icon="CloudOff" title="Can't reach Follow-up" style={{ marginHorizontal: 0, marginTop: 0 }}>
      <CardRow theme={props.theme}>
        <Text accessibilityRole="alert" style={[text(c).meta, { marginBottom: 10 }]}>The plugin didn't answer: {errorText(query.error)}. It may still be starting; your tracked work is saved on the host.</Text>
        <Button title="Try again" icon="RefreshCw" theme={props.theme} compact={props.layout.compact} loading={query.isRefetching} onPress={() => void query.refetch()} />
      </CardRow>
    </Card>
  </View>;
  if (!query.data?.workspace) return <StartTracking {...props} loadError={query.data?.error} />;
  return <PanelWorkspace {...props} workspace={query.data.workspace} loadError={query.error ? "Refresh failed. Showing the last saved state." : query.data.error} />;
}

function PanelSkeleton({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const pad = compact ? 16 : 12;
  return <View accessibilityLabel="Loading Follow-up" style={{ flex: 1, backgroundColor: c.surface0 }}>
    <View style={{ padding: pad, gap: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Skeleton width="55%" height={14} color={c.surface2} />
      <Skeleton width="85%" height={9} color={c.surface2} />
      <Skeleton width="70%" height={9} color={c.surface2} />
      <Skeleton width="100%" height={6} color={c.surface2} radius={3} />
    </View>
    {[0, 1].map(i => <View key={i} style={{ margin: pad, marginBottom: 0, padding: 12, gap: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
      <Skeleton width="35%" height={10} color={c.surface2} />
      <Skeleton width="90%" height={9} color={c.surface2} />
      <Skeleton width="75%" height={9} color={c.surface2} />
    </View>)}
  </View>;
}

function StartTracking({ theme, workspaceId, layout, loadError, openSettings }: PanelProps & { loadError?: string | null }) {
  const c = theme.colors; const t = text(c);
  const activate = useRpc(activateRpc); const cache = useQueryClient(); const toast = useToast();
  const start = useMutation({ mutationFn: () => activate({ workspaceId }), onSuccess: () => { toast.show("Tracking this workspace", { variant: "success" }); void cache.invalidateQueries({ queryKey: workspaceKey(workspaceId) }); void cache.invalidateQueries({ queryKey: overviewKey }); } });
  const compact = layout.compact;
  // The empty state teaches with the panel's own rail: the three things Follow-up does, as three stack nodes.
  const points: { icon: string; color: string; line: string }[] = [
    { icon: "GitMerge", color: mergedColor(c), line: "Follows every PR this workspace opens, stack by stack, with review and CI state." },
    { icon: "Wrench", color: c.statusDanger, line: "Gathers conflicts, failing checks and review threads into one repair batch for the main agent." },
    { icon: "Check", color: c.statusSuccess, line: "Tells you when the agent declares the work done and it's safe to archive." },
  ];
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 12, paddingTop: compact ? 20 : 16, gap: 14 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>Track this workspace</Text>
      <View style={{ marginVertical: compact ? -12 : -4, marginRight: compact ? -10 : -4 }}><IconButton icon="Settings" label="Follow-up settings" onPress={openSettings} theme={theme} compact={compact} /></View>
    </View>
    <View>
      {points.map((p, i) => <View key={p.icon} style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ width: 18, alignItems: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: tint(p.color, c) }}><Icon name={p.icon} size={11} color={p.color} /></View>
          {i < points.length - 1 && <View style={{ width: 2, flex: 1, minHeight: 10, backgroundColor: c.border }} />}
        </View>
        <Text style={[t.meta, { flex: 1, color: c.foreground, paddingTop: 1, paddingBottom: i < points.length - 1 ? 14 : 0 }]}>{p.line}</Text>
      </View>)}
    </View>
    <Text style={t.meta}>Nothing is sent, merged or archived without your click. Auto-send stays off until you turn it on for this workspace.</Text>
    {(loadError || start.error) && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{start.error ? errorText(start.error) : loadError}</Text>}
    <Button title="Track this workspace" kind="primary" icon="Plus" theme={theme} compact={compact} loading={start.isPending} onPress={() => start.mutate()} />
    <Text style={t.small}>To track every workspace in a project, turn it on in Settings. Tracking data stays on this host.</Text>
  </ScrollView>;
}

/** The main agent's current repairs: what was sent and when. Pending batches live in Needs you. */
function AgentCard({ workspace: w, theme, compact, now, openAgent }: { workspace: Workspace; theme: Theme; compact: boolean; now: number; openAgent?: (id: string) => void }) {
  const c = theme.colors; const t = text(c);
  const sent = w.batches.find(b => !recoveryBatch(b) && ["sending", "sent"].includes(b.state));
  const queued = w.enable_auto_sends ? w.batches.find(b => !recoveryBatch(b) && b.state === "pending") : undefined;
  const batch = sent ?? queued;
  if (!batch) return null;
  const recipient = batch.recipientAgentId && batch.recipientAgentId !== w.mainAgentId ? batch.recipientAgentId : w.mainAgentId;
  const blocker = queued && !sent ? sendBlocker(w, queued) : null;
  return <Card theme={theme} compact={compact} icon="Bot" title={recipient === w.mainAgentId ? "Main agent is on it" : "Recovery agent is on it"}
    right={openAgent && <Button theme={theme} compact={compact} kind="ghost" icon="ArrowUpRight" title="Open" accessibilityLabel="Open the agent's chat" onPress={() => openAgent(recipient)} />}>
    <CardRow theme={theme}>
      <Text style={[t.meta, { marginBottom: 6 }]}>{sent ? `Sent ${batch.tasks.length} repair${batch.tasks.length === 1 ? "" : "s"} ${ago(batch.sentAt, now)}. Follow-up waits for the agent to report back.` : `${batch.tasks.length} repair${batch.tasks.length === 1 ? "" : "s"} queued · ${blocker ?? "sends when the agent is idle"}`}</Text>
      {batch.tasks.map((task, i) => <View key={task.key} style={{ flexDirection: "row", gap: 6 }}>
        <Text style={[t.meta, { width: 16, fontVariant: ["tabular-nums"] }]}>{i + 1}.</Text>
        <Text style={[t.meta, { flex: 1 }]}>{shortRefs(task.title, w)}</Text>
      </View>)}
      {!!batch.result && <Text style={[t.meta, { marginTop: 6, color: c.statusWarning }]}>{batch.result}</Text>}
    </CardRow>
  </Card>;
}

/** The moment the loop closes: the agent declared Done and every requirement settled. */
function ShippedCard({ workspace: w, theme, compact, now }: { workspace: Workspace; theme: Theme; compact: boolean; now: number }) {
  const c = theme.colors; const t = text(c);
  if (summary(w, now).status !== "done" || !w.completion) return null;
  const merged = w.prs.filter(p => p.snapshot?.state === "MERGED").length;
  return <Reveal>
    <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 10, padding: 14, gap: 10, backgroundColor: tint(c.statusSuccess, c), borderWidth: 1, borderColor: tint(c.statusSuccess, c) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: c.statusSuccess }}><Icon name="Check" size={17} color={c.surface0} /></View>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={[t.label, { fontSize: 14, color: c.foreground }]}>Shipped</Text>
          <Text style={t.meta}>{merged ? `${merged} PR${merged === 1 ? "" : "s"} merged · ` : ""}declared {ago(w.completion.declaredAt, now)}</Text>
        </View>
      </View>
      <Text selectable style={[t.body, { color: c.foreground }]}>{w.completion.summary}</Text>
      <Text style={t.meta}>Archive the workspace from its menu when you're finished with it.</Text>
    </View>
  </Reveal>;
}

/** Quiet extras: the main agent, optional recovery and the Graphite merge-when-ready connection. */
function WorkspaceCard({ workspace: w, theme, compact, open, toggle, openAgent, browserReady, openOverview, editSpec }: { workspace: Workspace; theme: Theme; compact: boolean; open: (key: string) => boolean; toggle: (key: string) => void; openAgent?: (id: string) => void; browserReady: boolean | null; openOverview: () => void; editSpec: () => void }) {
  const c = theme.colors; const t = text(c);
  const control = useRpc(controlRpc); const send = useRpc(sendRpc); const runRecovery = useRpc(recoverRpc); const cache = useQueryClient(); const toast = useToast();
  const invalidate = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const fail = (e: Error) => toast.error(errorText(e));
  const recovery = useMutation({ mutationFn: () => runRecovery({ workspaceId: w.id }), onSuccess: invalidate, onError: fail });
  const runQueued = useMutation({ mutationFn: (batchId: string) => send({ workspaceId: w.id, batchId }), onSuccess: invalidate, onError: fail });
  const retry = useMutation({ mutationFn: (batchId: string) => control({ workspaceId: w.id, retryBatchId: batchId }), onSuccess: invalidate, onError: fail });
  const last = w.batches.filter(b => recoveryBatch(b) && b.state !== "cancelled").at(-1);
  const recoveryState = last ? last.state === "sent" ? "Recovery is running" : last.state === "completed" ? "Last recovery finished" : last.state === "pending" ? "Recovery is ready to run" : last.state === "sending" ? "Starting recovery" : "Recovery needs a check" : null;
  const active = w.prs.some(p => !settledForDisplay(p));
  const shown = open("workspace");
  const openUrl = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
  return <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
    <View style={{ marginTop: -1 }}><FoldRow theme={theme} open={shown} onPress={() => toggle("workspace")} icon="SlidersHorizontal" iconColor={c.foregroundMuted} label="Spec, agent and recovery" /></View>
    {shown && <>
      <SpecRow workspace={w} theme={theme} compact={compact} onEdit={editSpec} />
      <CardRow theme={theme}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
            <Text style={t.label}>Main agent</Text>
            <Text style={t.meta}>Owns the PRs, tasks and the Done call. Repairs go here.</Text>
          </View>
          {openAgent && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open" accessibilityLabel="Open main agent" onPress={() => openAgent(w.mainAgentId)} />}
        </View>
      </CardRow>
      <CardRow theme={theme}>
        <View style={{ gap: 8 }}>
          <View style={{ gap: 2 }}>
            <Text style={t.label}>Recovery</Text>
            <Text style={t.meta}>A separate agent reads this workspace's history to find PRs and tasks Follow-up missed. It never edits code or messages the main agent.</Text>
          </View>
          {recoveryState && <Text style={[t.meta, { color: c.foreground }]}>{recoveryState}{last?.settledAt ? ` · ${ago(last.settledAt)}` : ""}</Text>}
          {!!last?.result && <Text numberOfLines={4} selectable style={t.meta}>{last.result}</Text>}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {last?.state === "pending" ? <Button title="Run queued recovery" theme={theme} compact={compact} loading={runQueued.isPending} onPress={() => runQueued.mutate(last.id)} />
              : <Button title={recovery.isPending || last?.state === "sending" ? "Starting recovery…" : "Run recovery"} icon="History" theme={theme} compact={compact} loading={recovery.isPending}
                disabled={recovery.isPending || w.archived || !!last && (["pending", "sending", "sent", "uncertain"].includes(last.state) || last.state === "blocked" && !last.settledAt)} onPress={() => recovery.mutate()} />}
            {last?.recipientAgentId && openAgent && <Button title="Open recovery agent" kind="ghost" theme={theme} compact={compact} onPress={() => openAgent(last.recipientAgentId!)} />}
            {last && ["blocked", "uncertain"].includes(last.state) && <Button title="Retry recovery" theme={theme} compact={compact} loading={retry.isPending} onPress={() => retry.mutate(last.id)} />}
          </View>
        </View>
      </CardRow>
      {active && browserReady === false && <CardRow theme={theme}>
        <View style={{ gap: 8 }}>
          <View style={{ gap: 2 }}>
            <Text style={t.label}>Merge when ready</Text>
            <Text style={t.meta}>Optional. With Send to Paseo paired and Graphite open in Chrome, each open PR gets a When ready switch. Chrome asks before each change unless you allowed it for the repository.</Text>
          </View>
          <Button title="Open Graphite" icon="ExternalLink" theme={theme} compact={compact} accessibilityLabel="Connect Graphite" onPress={() => openUrl("https://app.graphite.com")} />
        </View>
      </CardRow>}
      <CardRow theme={theme}>
        <Button title="All tracked workspaces" kind="ghost" icon="LayoutList" theme={theme} compact={compact} onPress={openOverview} />
      </CardRow>
    </>}
  </View>;
}

const folds = z.object({ open: z.array(z.string()) });
function historyLabel(w: Workspace): string {
  const stacks = new Set(w.prs.map(p => p.stack)).size;
  const tasks = followUpObligations(w).filter(o => ["done", "waived"].includes(o.status)).length;
  return [`${w.prs.length} PR${w.prs.length === 1 ? "" : "s"} in ${stacks} stack${stacks === 1 ? "" : "s"}`, tasks ? `${tasks} task${tasks === 1 ? "" : "s"} done` : null].filter(Boolean).join(" · ");
}

export type Folds = { isOpen: (key: string) => boolean; toggle: (key: string) => void };
/** Fold choices shared by a workspace's panel and its larger view during the app session. */
const sessionFolds = new Map<string, string[]>();
export function useSessionFolds(workspaceId: string): Folds {
  const [open, setOpen] = useState<string[]>(() => sessionFolds.get(workspaceId) ?? []);
  return { isOpen: key => open.includes(key), toggle: key => { const next = open.includes(key) ? open.filter(k => k !== key) : [...open, key]; sessionFolds.set(workspaceId, next); setOpen(next); } };
}

/** The panel keeps its folds in the tab's persisted state and mirrors them for the larger view. */
function PanelWorkspace(props: PanelProps & { workspace: Workspace; loadError?: string | null }) {
  const [state, setState] = useTabState(props.tab, folds, { open: sessionFolds.get(props.workspaceId) ?? [] });
  const isOpen = (key: string) => state.open.includes(key);
  const toggle = (key: string) => { const next = isOpen(key) ? state.open.filter(k => k !== key) : [...state.open, key]; sessionFolds.set(props.workspaceId, next); setState({ open: next }); };
  const { openLarge } = props;
  return <WorkspaceView {...props} folds={{ isOpen, toggle }} resize={openLarge ? { icon: "Maximize2", label: "Open the larger view", onPress: () => openLarge(props.workspaceId) } : null} />;
}

/** Two columns from this content width: actions on the left, the stacks on the right. */
export const WIDE_MIN = 820;

export function WorkspaceView({ theme, layout, workspace: w, navigation, loadError, openSettings, openOverview, folds: { isOpen, toggle }, resize, large = false }: PluginHostProps & {
  navigation?: PluginWorkspacePanelProps["navigation"]; workspace: Workspace; loadError?: string | null; openSettings: () => void; openOverview: () => void;
  folds: Folds; resize: { icon: "Maximize2" | "Minimize2"; label: string; onPress: () => void } | null; large?: boolean;
}) {
  const control = useRpc(controlRpc); const refresh = useRpc(refreshRpc); const browserRead = useRpc(browserStatusRpc);
  const cache = useQueryClient(); const toast = useToast();
  const now = useNow(30_000);
  const compact = layout.compact;
  const [width, setWidth] = useState(0);
  const wide = !compact && width >= WIDE_MIN;
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" | null } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const browser = useQuery({ queryKey: ["follow-through", "browser"], queryFn: () => browserRead({}), refetchInterval: 5000 });
  const invalidated = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const auto = useMutation({ mutationFn: (next: boolean) => control({ workspaceId: w.id, enable_auto_sends: next }), onSuccess: (_, next) => { toast.show(next ? "Auto-send on for this workspace" : "Auto-send off · repairs wait for your click"); invalidated(); }, onError: e => toast.error(errorText(e)) });
  const update = useMutation({ mutationFn: () => refresh({ workspaceId: w.id }), onSuccess: () => setTimeout(invalidated, 1200), onError: e => toast.error(errorText(e)) });
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const done = summary(w, now).status === "done";
  const openPr = (key: string) => setSheet({ key, intent: null });
  // The expand button only appears while the panel is narrow; a wide panel or the larger view keeps its collapse button.
  const resizeShown = compact ? null : resize?.icon === "Maximize2" && wide ? null : resize;
  const header = <WorkspaceHeader workspace={w} theme={theme} compact={compact} now={now} onSettings={openSettings} onRefresh={() => update.mutate()} refreshing={update.isPending} onAuto={next => auto.mutate(next)} autoPending={auto.isPending} notice={loadError ?? null} onOpenPr={openPr} resize={resizeShown} hideTitle={large} />;
  const shipped = <ShippedCard workspace={w} theme={theme} compact={compact} now={now} />;
  const needs = <NeedsYouCard workspace={w} theme={theme} compact={compact} now={now} actions={{ openAgent, openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion }} />;
  const agent = <AgentCard workspace={w} theme={theme} compact={compact} now={now} openAgent={openAgent} />;
  // Once shipped, the stack and tasks are history: one quiet fold instead of two near-empty cards.
  const history = done && <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
    <View style={{ marginTop: -1 }}><FoldRow theme={theme} open={isOpen("history")} onPress={() => toggle("history")} icon="History" iconColor={theme.colors.foregroundMuted} label={historyLabel(w)} /></View>
  </View>;
  const showWork = !done || isOpen("history");
  const stacks = showWork && <StacksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpen={openPr} wide={wide} />;
  const tasks = showWork && <TasksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpenQuestion={setQuestion} />;
  const log = <ActivityCard workspace={w} theme={theme} compact={compact} now={now} open={isOpen} toggle={toggle} onOpenQuestion={setQuestion} />;
  const extras = <WorkspaceCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} openAgent={openAgent} browserReady={browser.data ? browser.data.ready : null} openOverview={openOverview} editSpec={() => setSpecOpen(true)} />;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20, ...(large ? { maxWidth: 1240, width: "100%", alignSelf: "center", paddingHorizontal: 12 } : null) }}>
      {header}
      {wide ? <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 5, minWidth: 0 }}>{shipped}{needs}{agent}{history}{tasks}</View>
        <View style={{ flex: 6, minWidth: 0 }}>{stacks}{log}{extras}</View>
      </View> : <>{shipped}{needs}{agent}{history}{stacks}{tasks}{log}{extras}</>}
    </ScrollView>
    <PrSheet workspace={w} prKey={sheet?.key ?? null} intent={sheet?.intent ?? null} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />
    <QuestionSheet workspace={w} questionId={question} theme={theme} compact={compact} openAgent={openAgent} onClose={() => setQuestion(null)} />
    <SpecSheet workspace={w} open={specOpen} theme={theme} compact={compact} onClose={() => setSpecOpen(false)} />
  </View>;
}
