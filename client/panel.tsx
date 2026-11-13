import { useEffect, useState, type ReactNode } from "react";
import { recoveryActions } from "./recovery-actions";
import { ScrollView, View } from "react-native";
import { Text } from "./text";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useAgent, useRpc, useTabState, openExternalUrl, type PluginHostProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import type { InboxStore } from "./inbox-store";
import { useInbox } from "./inbox";
import { BriefCard, type BriefDeps } from "./brief";
import { briefAsks, liveBrief, type Brief } from "../shared/brief";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { controlRpc, refreshRpc, browserStatusRpc, recoverRpc, sendRpc, inboxBriefRpc } from "../shared/contracts";
import { summary, type Workspace } from "../shared/model";
import { recentMainChange } from "../shared/home";
import { followUpObligations, recoveryBatch } from "../shared/follow-up";
import { settledForDisplay } from "../shared/presentation";
import { ago } from "../shared/attention";
import { unconfirmedNote } from "../shared/status";
import { Button, Card, CardRow, FoldRow, IconButton, errorText, text, useNow, type Theme } from "./kit";
import { VersionMark } from "./updates";
import { Reveal, Skeleton } from "./motion";
import { WorkspaceHeader } from "./header";
import { PanelMore } from "./panel-menu";
import type { HomeSources } from "./home-data";
import { NeedsYouBlock, overviewKey, workspaceKey } from "./needs-you";
import { browserKey } from "./keys";
import { useWorkspace } from "./workspace-data";
import type { LiveStore } from "./live";
import { StacksCard } from "./stacks";
import { TasksCard } from "./tasks";
import { PrSheet } from "./pr-sheet";
import { ActivityCard, QuestionSheet } from "./questions";
import { SpecRow, SpecSheet } from "./spec";
import { LinkedItemsRow } from "./linked";
import { mergedColor, tint } from "./theme";
import { SummaryRow } from "./about";
import { WhatsNewGate } from "./release-notes";
import { ViewSync } from "./view-store";
import { RichText } from "./rich-text";
import { ToastHost, useQuestionOpener } from "./toasts";

export { overviewKey, workspaceKey };

export type PanelLinks = { openSettings: () => void; openOverview: () => void; openLarge?: (workspaceId: string) => void };
type PanelProps = PluginWorkspacePanelProps & PanelLinks & { inbox?: InboxStore; live?: LiveStore; briefDeps?: BriefDeps; sources?: HomeSources };

/**
 * The workspace panel (explorer column, or a tab on the phone): this workspace only. A Home button on top, then
 * the main agent's open ask with its moves (sign off, decisions), and the workspace's own cards: repairs, PR stack,
 * tasks, questions, spec, activity and Details. What needs you elsewhere lives on Home.
 */
export function FollowPanel(props: PanelProps) {
  return <><ViewSync /><PanelBody {...props} /><WhatsNewGate surface="panel" theme={props.theme} compact={props.layout.compact} /><ToastHost theme={props.theme} compact={props.layout.compact} /></>;
}

function PanelBody(props: PanelProps) {
  // Paints from the client's live store; one small read of this workspace on open, no poll (1.4.0).
  const query = useWorkspace(props.live, props.workspaceId);
  const c = props.theme.colors;
  const base = { flex: 1, backgroundColor: c.surface0 };
  if (query.pending) return <PanelSkeleton theme={props.theme} compact={props.layout.compact} />;
  if (query.error && !query.workspace) return <View style={[base, { padding: props.layout.compact ? 16 : 12 }]}>
    <Card theme={props.theme} compact={props.layout.compact} icon="CloudOff" title="Can't reach Follow-up" style={{ marginHorizontal: 0, marginTop: 0 }}>
      <CardRow theme={props.theme} compact={props.layout.compact}>
        <Text accessibilityRole="alert" style={[text(c).meta, { marginBottom: 10 }]}>The plugin didn't answer: {errorText(query.error)}. It may still be starting; your work is saved on the host.</Text>
        <Button title="Try again" icon="RefreshCw" theme={props.theme} compact={props.layout.compact} loading={query.refetching} onPress={() => void query.refetch()} />
      </CardRow>
    </Card>
  </View>;
  if (!query.workspace) return <NothingYet {...props} loadError={query.loadError} />;
  return <PanelWorkspace {...props} workspace={query.workspace} loadError={query.error ? "Refresh failed. Showing the last saved state." : query.loadError} />;
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

/** A workspace Follow-up has nothing on yet (no agent, or opted out in Settings). Never a "Track" prompt. */
function NothingYet({ theme, layout, loadError, openOverview, openSettings }: PanelProps & { loadError?: string | null }) {
  const c = theme.colors; const t = text(c);
  const compact = layout.compact;
  if (!compact) return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <PanelTop theme={theme} compact={compact} openOverview={openOverview} openSettings={openSettings} />
    <View style={{ padding: 12, gap: 8 }}>
      <Text style={t.meta}>Nothing to follow here yet. Once an agent opens a PR or records a task in this workspace, its stack and tasks show up here.</Text>
      {loadError && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{loadError}</Text>}
    </View>
  </View>;
  // Phones: teach with the panel's own rail instead of one line of small print at the top of an empty screen.
  const tp = text(c, true);
  const steps: [string, string, string, string][] = [
    ["GitPullRequest", mergedColor(c), "Pull requests, as a stack", "Each PR the agent opens, in merge order, with checks and reviews."],
    ["CircleAlert", c.statusWarning, "What needs you", "Questions, reviews and merges, one action each."],
    ["CircleCheck", c.statusSuccess, "When it's done", "The agent declares Done once every PR and task settles."],
  ];
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <PanelTop theme={theme} compact={compact} openOverview={openOverview} openSettings={openSettings} />
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 24, gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={tp.title}>Nothing to follow here yet</Text>
        <Text style={[tp.body, { color: c.foregroundMuted }]}>Once an agent opens a PR or records a task in this workspace, Follow-up tracks it here.</Text>
      </View>
      <View>
        {steps.map(([icon, color, title, line], i) => <View key={title} style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ alignItems: "center", width: 24 }}>
            <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: tint(color, c) }}><Icon name={icon} size={13} color={color} /></View>
            {i < steps.length - 1 && <View style={{ flex: 1, width: 2, backgroundColor: c.border, marginVertical: 2 }} />}
          </View>
          <View style={{ flex: 1, paddingBottom: i < steps.length - 1 ? 18 : 0, gap: 2, paddingTop: 2 }}>
            <Text style={tp.label}>{title}</Text>
            <Text style={tp.meta}>{line}</Text>
          </View>
        </View>)}
      </View>
      {loadError && <Text accessibilityRole="alert" style={[tp.meta, { color: c.statusDanger }]}>{loadError}</Text>}
      <View style={{ flexDirection: "row" }}><Button theme={theme} compact kind="secondary" icon="Settings" title="Project settings" accessibilityHint="Choose which projects Follow-up tracks" onPress={openSettings} /></View>
    </ScrollView>
  </View>;
}

/** The panel's top bar: back to Home, and settings. No other workspace's counts. */
export function PanelTop({ theme, compact, openOverview, openSettings }: { theme: Theme; compact: boolean; openOverview: () => void; openSettings?: () => void }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: compact ? 12 : 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Button theme={theme} compact={compact} kind="ghost" icon="House" title="Home" accessibilityHint="Opens Follow-up Home with every workspace" onPress={openOverview} />
    <View style={{ flex: 1 }} />
    {openSettings && <VersionMark theme={theme} touch={compact} openSettings={openSettings} />}
    {openSettings && <IconButton icon="Settings" label="Follow-up settings" onPress={openSettings} theme={theme} compact={compact} />}
  </View>;
}

const NO_INBOX = { subscribe: () => () => undefined, version: () => 0 } as unknown as InboxStore;
/**
 * The main agent's open ask (the chat's brief), for the Needs you block: null unless it is a real, flagged ask. The block
 * folds it into the question it points at, or draws its card (with its moves) as the block's first section.
 */
function useMainBrief(w: Workspace, inbox: InboxStore | undefined): Brief | null {
  const row = useInbox(inbox ?? NO_INBOX, () => inbox?.rows().find(r => r.agentId === w.mainAgentId) ?? null);
  const readBrief = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-up", "home-brief", w.mainAgentId, row?.seq ?? 0], queryFn: () => readBrief({ agentId: w.mainAgentId }), enabled: !!inbox && !!row?.needs && !!row?.brief });
  const b = liveBrief(brief.data?.brief);
  // Only a real ask (shared briefAsks): not "No ask stated", which repeats the chat, nor a done brief's "Nothing needed".
  return row?.snooze || !briefAsks(b, row) ? null : b;
}

function PanelWorkspace(props: PanelProps & { workspace: Workspace; loadError?: string | null }) {
  const [state, setState] = useTabState(props.tab, folds, { open: sessionFolds.get(props.workspaceId) ?? [] });
  const isOpen = (key: string) => state.open.includes(key);
  const toggle = (key: string) => { const next = isOpen(key) ? state.open.filter(k => k !== key) : [...state.open, key]; sessionFolds.set(props.workspaceId, next); setState({ open: next }); };
  const { openLarge } = props;
  const compact = props.layout.compact;
  const top = <PanelTop theme={props.theme} compact={compact} openOverview={props.openOverview} openSettings={props.openSettings} />;
  const brief = useMainBrief(props.workspace, props.briefDeps ? props.inbox : undefined);
  const ask = brief && props.briefDeps ? { brief, card: <BriefCard {...({ item: { data: brief }, theme: props.theme, layout: { compact }, agentId: props.workspace.mainAgentId, deps: props.briefDeps, bare: true } as unknown as Parameters<typeof BriefCard>[0])} /> } : null;
  return <WorkspaceView {...props} top={top} ask={ask} folds={{ isOpen, toggle }} resize={openLarge ? { icon: "Maximize2", label: "Open the larger view", onPress: () => openLarge(props.workspaceId) } : null} />;
}



/** The moment the loop closes: the agent declared Done and every requirement settled. */
function ShippedCard({ workspace: w, theme, compact, now }: { workspace: Workspace; theme: Theme; compact: boolean; now: number }) {
  const c = theme.colors; const t = text(c);
  if (summary(w, now).status !== "done" || !w.completion) return null;
  const merged = w.prs.filter(p => p.snapshot?.state === "MERGED").length;
  return <Reveal>
    <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 10, padding: 14, gap: 10, backgroundColor: tint(c.statusSuccess, c), borderWidth: 1, borderColor: tint(c.statusSuccess, c) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: c.statusSuccess }}><Icon name="Check" size={17} color={c.surface0} /></View>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={[t.label, { fontSize: 14, color: c.foreground }]}>Shipped</Text>
          <Text style={t.meta}>{merged ? `${merged} PR${merged === 1 ? "" : "s"} merged · ` : ""}declared {ago(w.completion.declaredAt, now)}</Text>
        </View>
      </View>
      <RichText selectable style={[t.body, { color: c.foreground }]}>{w.completion.summary}</RichText>
      {!!w.completion.unconfirmed?.length && <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <View style={{ paddingTop: 2 }}><Icon name="CircleAlert" size={13} color={c.statusWarning} /></View>
        <Text style={[t.meta, { flex: 1, color: c.foreground }]}>{unconfirmedNote(w.completion.unconfirmed)}</Text>
      </View>}
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
  const actions = recoveryActions(last, { archived: w.archived, starting: recovery.isPending });
  const recoveryState = last ? last.state === "sent" ? "Recovery is running" : last.state === "completed" ? "Last recovery finished" : last.state === "pending" ? "Recovery is ready to run" : last.state === "sending" ? "Starting recovery" : "Recovery needs a check" : null;
  const active = w.prs.some(p => !settledForDisplay(p));
  const shown = open("workspace");
  const openUrl = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
  return <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
    <View style={{ marginTop: -1 }}><FoldRow theme={theme} compact={compact} open={shown} onPress={() => toggle("workspace")} icon="SlidersHorizontal" iconColor={c.foregroundMuted} label="Spec, agent and recovery" /></View>
    {shown && <>
      <SpecRow workspace={w} theme={theme} compact={compact} onEdit={editSpec} />
      <LinkedItemsRow workspace={w} theme={theme} compact={compact} />
      <CardRow theme={theme} compact={compact}><SummaryRow workspaceId={w.id} theme={theme} compact={compact} /></CardRow>
      <CardRow theme={theme} compact={compact}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
            <Text style={t.label}>Main agent</Text>
            <MainAgentName agentId={w.mainAgentId} theme={theme} />
            <Text style={t.meta}>Owns the PRs, tasks and the Done call. Tasks go here.</Text>
          </View>
          {openAgent && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open" accessibilityLabel="Open main agent" onPress={() => openAgent(w.mainAgentId)} />}
        </View>
        <MainChangeNotice workspace={w} theme={theme} compact={compact} />
        {(w.contributorAgentIds ?? []).map(id => <OtherRootAgent key={id} agentId={id} workspace={w} theme={theme} compact={compact} openAgent={openAgent} mainAgentId={w.mainAgentId} />)}
      </CardRow>
      <CardRow theme={theme} compact={compact}>
        <View style={{ gap: 8 }}>
          <View style={{ gap: 2 }}>
            <Text style={t.label}>Recovery</Text>
            <Text style={t.meta}>A separate agent reads this workspace's history to find PRs and tasks Follow-up missed. It never edits code or messages the main agent.</Text>
          </View>
          {recoveryState && <Text style={[t.meta, { color: c.foreground }]}>{recoveryState}{last?.settledAt ? ` · ${ago(last.settledAt)}` : ""}</Text>}
          {!!last?.result && <RichText linkColor={c.foreground} numberOfLines={4} selectable style={t.meta}>{last.result}</RichText>}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {actions.primary.kind === "run-queued" ? <Button title={actions.primary.title} theme={theme} compact={compact} loading={runQueued.isPending} onPress={() => runQueued.mutate(last!.id)} />
              : actions.primary.kind === "retry" ? <Button title={actions.primary.title} icon="RefreshCw" theme={theme} compact={compact} loading={retry.isPending} onPress={() => retry.mutate(last!.id)} />
              : <Button title={actions.primary.title} icon="History" theme={theme} compact={compact} loading={recovery.isPending} disabled={actions.primary.disabled} onPress={() => recovery.mutate()} />}
            {actions.openAgent && openAgent && <Button title="Open recovery agent" kind="ghost" theme={theme} compact={compact} onPress={() => openAgent(last!.recipientAgentId!)} />}
          </View>
        </View>
      </CardRow>
      {/* Graphite's merge-when-ready needs the browser companion; GitHub repositories use auto-merge and never see this. */}
      {active && browserReady === false && w.prs.some(p => !settledForDisplay(p) && p.snapshot && p.snapshot.prWorkflow !== "github") && <CardRow theme={theme} compact={compact}>
        <View style={{ gap: 8 }}>
          <View style={{ gap: 2 }}>
            <Text style={t.label}>Merge when ready</Text>
            <Text style={t.meta}>Optional. With Send to Paseo paired and Graphite open in Chrome, each open PR gets a When ready switch. Chrome asks before each change unless you allowed it for the repository.</Text>
          </View>
          <Button title="Open Graphite" icon="ExternalLink" theme={theme} compact={compact} accessibilityLabel="Connect Graphite" onPress={() => openUrl("https://app.graphite.com")} />
        </View>
      </CardRow>}
    </>}
  </View>;
}

/** An agent's title from Paseo's client state (no fetch), or a short id while it loads or once it's gone. */
function useAgentTitle(agentId: string): string {
  return useAgent(agentId, a => a.title) || `Agent ${agentId.slice(0, 8)}`;
}

/**
 * "Took over from A · 5m ago · reason · Undo" under B's name, for a day after an agent or Follow-up moved the role
 * (main-agent claim rule 5). Quiet: a meta line in this card, never a Needs-you item. Undo makes A main again
 * through the same developer action as Make main agent, which no cooldown blocks.
 */
function MainChangeNotice({ workspace: w, theme, compact }: { workspace: Workspace; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c);
  const now = useNow(60_000);
  const change = recentMainChange(w, now);
  const from = useAgentTitle(change?.from ?? ""); const to = useAgentTitle(change?.to ?? "");
  const control = useRpc(controlRpc); const cache = useQueryClient(); const toast = useToast();
  const undo = useMutation({
    mutationFn: () => control({ workspaceId: w.id, mainAgentId: change!.from }),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); toast.show(`${from} is the main agent again`, { variant: "success" }); },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  if (!change) return null;
  const canUndo = w.enable_tracking && !w.archived && (w.contributorAgentIds ?? []).includes(change.from);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
    {/* The new main's name is the card's title right above, so the line names only who it took over from. */}
    <Text numberOfLines={3} accessibilityLabel={`${to} took over from ${from} ${ago(change.at, now)}${change.reason ? `. ${change.reason}` : ""}`} style={[t.meta, { flex: 1, minWidth: 200 }]}>
      <Text style={{ color: c.foreground }}>Took over from {from}</Text> · {ago(change.at, now)}{change.reason ? ` · ${change.reason}` : ""}
    </Text>
    {canUndo && <Button theme={theme} compact={compact} kind="ghost" title="Undo" accessibilityLabel={`Undo: make ${from} the main agent again`} accessibilityHint={`Tasks, questions and Done move back to ${from}.`} loading={undo.isPending} disabled={undo.isPending} onPress={() => undo.mutate()} />}
  </View>;
}

function MainAgentName({ agentId, theme }: { agentId: string; theme: Theme }) {
  const t = text(theme.colors);
  return <Text numberOfLines={1} style={[t.meta, { color: theme.colors.foreground }]}>{useAgentTitle(agentId)}</Text>;
}

/**
 * Another root agent in this workspace: it can contribute PRs but not ask Tom or call Done. "Make main agent" is
 * the developer's choice (a plugin RPC, never an agent tool). It swaps roles, so the former main appears here with
 * its own Make main agent: that is the undo, and the toast says so instead of a confirmation step.
 */
function OtherRootAgent({ agentId, mainAgentId, workspace: w, theme, compact, openAgent }: { agentId: string; mainAgentId: string; workspace: Workspace; theme: Theme; compact: boolean; openAgent?: (id: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const title = useAgentTitle(agentId); const formerTitle = useAgentTitle(mainAgentId);
  const control = useRpc(controlRpc); const cache = useQueryClient(); const toast = useToast();
  const promote = useMutation({
    mutationFn: () => control({ workspaceId: w.id, mainAgentId: agentId }),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); toast.show(`${title} is now the main agent. To undo, make ${formerTitle} main again.`, { variant: "success" }); },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const canPromote = w.enable_tracking && !w.archived;
  return <View style={{ gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ gap: 2 }}>
      <Text numberOfLines={1} style={compact ? t.label : [t.meta, { color: c.foreground }]}>{title}</Text>
      <Text style={t.meta}>Can add PRs here. Can't ask you questions or call Done.</Text>
    </View>
    {/* Phones: the two actions split one row (no wrap into a second row). */}
    {(openAgent || canPromote) && <View style={{ flexDirection: "row", flexWrap: compact ? "nowrap" : "wrap", gap: 8 }}>
      {canPromote && <Button theme={theme} compact={compact} grow={compact} title="Make main agent" accessibilityLabel={`Make ${title} the main agent`} accessibilityHint={`Tasks, questions and Done move from ${formerTitle} to ${title}.`} loading={promote.isPending} disabled={promote.isPending} onPress={() => promote.mutate()} />}
      {openAgent && <Button theme={theme} compact={compact} kind={compact ? "secondary" : "ghost"} icon="MessageSquare" title="Open" accessibilityLabel={`Open ${title}`} onPress={() => openAgent(agentId)} />}
    </View>}
  </View>;
}

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

const folds = z.object({ open: z.array(z.string()) });
/** Two columns from this content width: actions on the left, the stacks on the right. */
export const WIDE_MIN = 820;

export function WorkspaceView({ theme, layout, workspace: w, navigation, loadError, openSettings, openOverview, folds: { isOpen, toggle }, resize, large = false, top, ask, sources }: PluginHostProps & {
  navigation?: PluginWorkspacePanelProps["navigation"]; workspace: Workspace; loadError?: string | null; openSettings: () => void; openOverview: () => void; top?: ReactNode; /** The main agent's open brief and its card, for the Needs you block. */ ask?: { brief: Brief; card: ReactNode } | null;
  folds: Folds; resize: { icon: "Maximize2" | "Minimize2"; label: string; onPress: () => void } | null; large?: boolean;
  /** Home's sources: the header's More menu (the row menu). Absent in the larger view. */
  sources?: HomeSources;
}) {
  const control = useRpc(controlRpc); const refresh = useRpc(refreshRpc); const browserRead = useRpc(browserStatusRpc);
  const cache = useQueryClient(); const toast = useToast();
  const now = useNow(30_000);
  const compact = layout.compact;
  const [width, setWidth] = useState(0);
  const wide = !compact && width >= WIDE_MIN;
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" | null } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  useQuestionOpener(w.id, setQuestion);
  const [specOpen, setSpecOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<ReactNode>(null);
  // Read when the panel opens and again when a PR sheet opens (its Open-in-browser actions use it); nothing polls it.
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), staleTime: 0, refetchOnMount: "always" });
  useEffect(() => { if (sheet) void browser.refetch(); }, [sheet?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalidated = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const auto = useMutation({ mutationFn: (next: boolean) => control({ workspaceId: w.id, enable_auto_sends: next }), onSuccess: (_, next) => { toast.show(next ? "Auto-send on for this workspace" : "Auto-send off · tasks wait for your Send"); invalidated(); }, onError: e => toast.error(errorText(e)) });
  // Opening a workspace reads its PRs now: background polling backs off for settled repositories (server/github.ts).
  useEffect(() => { const t = setTimeout(invalidated, 1500); void refresh({ workspaceId: w.id }).catch(() => undefined); return () => clearTimeout(t); }, [w.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useMutation({ mutationFn: () => refresh({ workspaceId: w.id }), onSuccess: () => setTimeout(invalidated, 1200), onError: e => toast.error(errorText(e)) });
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const done = summary(w, now).status === "done";
  const openPr = (key: string) => setSheet({ key, intent: null });
  // The expand button only appears while the panel is narrow; a wide panel or the larger view keeps its collapse button.
  const resizeShown = compact ? null : resize?.icon === "Maximize2" && wide ? null : resize;
  const header = <WorkspaceHeader workspace={w} theme={theme} compact={compact} now={now} onSettings={openSettings} onRefresh={() => update.mutate()} refreshing={update.isPending} onAuto={next => auto.mutate(next)} autoPending={auto.isPending} notice={loadError ?? null} onOpenPr={openPr} resize={resizeShown} hideTitle={large} onHome={compact ? openOverview : undefined}
    more={sources ? <PanelMore w={w} sources={sources} theme={theme} compact={compact} openAgent={openAgent} openQuestion={setQuestion} showMenu={setMoreMenu} /> : undefined} />;
  const shipped = <ShippedCard workspace={w} theme={theme} compact={compact} now={now} />;
  const needs = <NeedsYouBlock workspace={w} theme={theme} compact={compact} now={now} brief={ask?.brief ?? null} briefCard={ask?.card ?? null} actions={{ openAgent, openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion }} />;
  // Once shipped, the stack and tasks are history: one quiet fold instead of two near-empty cards.
  const history = done && <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
    <View style={{ marginTop: -1 }}><FoldRow theme={theme} compact={compact} open={isOpen("history")} onPress={() => toggle("history")} icon="History" iconColor={theme.colors.foregroundMuted} label={historyLabel(w)} /></View>
  </View>;
  const showWork = !done || isOpen("history");
  const stacks = showWork && <StacksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpen={openPr} wide={wide} />;
  const tasks = showWork && <TasksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpenQuestion={setQuestion} openAgent={openAgent} now={now} />;
  const log = <ActivityCard workspace={w} theme={theme} compact={compact} now={now} open={isOpen} toggle={toggle} onOpenQuestion={setQuestion} />;
  const extras = <WorkspaceCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} openAgent={openAgent} browserReady={browser.data ? browser.data.ready : null} openOverview={openOverview} editSpec={() => setSpecOpen(true)} />;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    {/* Phones fold the top bar into the header's own row. */}
    {!compact && top}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20, ...(large ? { maxWidth: 1240, width: "100%", alignSelf: "center", paddingHorizontal: 12 } : null) }}>
      {header}
      {wide ? <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 5, minWidth: 0 }}>{shipped}{needs}{history}{tasks}</View>
        <View style={{ flex: 6, minWidth: 0 }}>{stacks}{log}{extras}</View>
      </View> : <>{shipped}{needs}{history}{stacks}{tasks}{log}{extras}</>}
    </ScrollView>
    <PrSheet workspace={w} prKey={sheet?.key ?? null} intent={sheet?.intent ?? null} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />
    <QuestionSheet workspace={w} questionId={question} theme={theme} compact={compact} openAgent={openAgent} onClose={() => setQuestion(null)} />
    <SpecSheet workspace={w} open={specOpen} theme={theme} compact={compact} onClose={() => setSpecOpen(false)} />
    {/* The More menu draws last, at the panel's root, so the panel's own content never paints over it. */}
    {moreMenu}
  </View>;
}
