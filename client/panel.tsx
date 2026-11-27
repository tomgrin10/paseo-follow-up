import { finishedTask } from "../shared/finished";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PagedRows } from "./paged-list";
import type { SettingsCategory } from "../shared/settings-nav";
import { recoveryActions } from "./recovery-actions";
import { Platform, View, type ScrollView as NativeScrollView } from "react-native";
import { Text } from "./text";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "./keyboard";
import { useAgent, useRpc, useTabState, openExternalUrl, type PluginHostProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import type { InboxStore } from "./inbox-store";
import { useInbox } from "./inbox";
import { PeekHost } from "./turn-view";
import { AgentCard, type ViewPlace } from "./agent-card";
import { DockedPane } from "./docked-pane";
import type { DockState } from "./dock";
import { PermissionBlock, useAgentLive } from "./home";
import { AGENT_SHARE, layoutFor, placeCards, type Layout } from "../shared/workspace-layout";
import { workspaceNow } from "../shared/now";
import type { InboxRow } from "../shared/inbox";
import { BriefCard, type BriefDeps } from "./brief";
import { briefAsks, liveBrief, type Brief } from "../shared/brief";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { controlRpc, refreshRpc, browserStatusRpc, recoverRpc, sendRpc, inboxBriefRpc } from "../shared/contracts";
import { summary, type Workspace } from "../shared/model";
import { recentMainChange } from "../shared/home";
import { followUpObligations, recoveryBatch } from "../shared/follow-up";
import { settledForDisplay } from "../shared/presentation";
import { ago, needsYou } from "../shared/attention";
import { unconfirmedNote } from "../shared/status";
import { Button, Card, CardRow, FoldRow, IconButton, errorText, text, useNow, type Theme } from "./kit";
import { VersionMark } from "./updates";
import { Reveal, Skeleton } from "./motion";
import { WorkspaceHeader } from "./header";
import { PanelMore } from "./panel-menu";
import type { HomeSources } from "./home-data";
import { NeedsYouBlock, overviewKey, workspaceKey } from "./needs-you";
import { YourQuestionsCard, useWorkspaceRunning } from "./your-questions";
import { browserKey } from "./keys";
import { useWorkspace } from "./workspace-data";
import type { LiveStore } from "./live";
import { StacksCard } from "./stacks";
import { TasksCard } from "./tasks";
import { MessagesCard } from "./messages";
import { PrSheet } from "./pr-sheet";
import { ActivityCard, QuestionSheet } from "./questions";
import type { Question } from "../shared/questions";
import { SpecRow, SpecSheet } from "./spec";
import { LinkedItemsRow } from "./linked";
import { mergedColor, tint } from "./theme";
import { SummaryRow } from "./about";
import { WhatsNewGate } from "./release-notes";
import { SetupGate } from "./setup-gate";
import { ViewSync } from "./view-store";
import { RichText } from "./rich-text";
import { ToastHost, useQuestionOpener } from "./toasts";

export { overviewKey, workspaceKey };

export type PanelLinks = { openSettings: (category?: SettingsCategory) => void; openOverview: () => void; /** Opens the workspace view as a tab in the main area (`follow-up-view`). */ openView?: (workspaceId: string) => void };
/** `place`: the side panel (`follow-up`) or the main area's tab (`follow-up-view`); the same view, its controls differ. */
type PanelProps = PluginWorkspacePanelProps & PanelLinks & { inbox?: InboxStore; live?: LiveStore; briefDeps?: BriefDeps; sources?: HomeSources; place: "panel" | "tab" };

/**
 * The workspace panel (explorer column, or a tab on the phone): this workspace only. A Home button on top, then
 * the main agent's open ask with its moves (sign off, decisions), and the workspace's own cards: repairs, PR stack,
 * tasks, questions, spec, activity and Details. What needs you elsewhere lives on Home.
 */
export function FollowPanel(props: PanelProps) {
  return <><ViewSync /><PanelBody {...props} /><WhatsNewGate surface="panel" theme={props.theme} compact={props.layout.compact} /><SetupGate surface="panel" theme={props.theme} compact={props.layout.compact} deps={{ openSettings: props.openSettings, openHome: props.openOverview }} /><ToastHost theme={props.theme} compact={props.layout.compact} /></>;
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
      <View style={{ flexDirection: "row" }}><Button theme={theme} compact kind="secondary" icon="Settings" title="Project settings" accessibilityHint="Choose which projects Follow-up tracks" onPress={() => openSettings("following")} /></View>
    </ScrollView>
  </View>;
}

/** The panel's top bar: back to Home, and settings. No other workspace's counts. */
export function PanelTop({ theme, compact, openOverview, openSettings }: { theme: Theme; compact: boolean; openOverview: () => void; openSettings?: (category?: SettingsCategory) => void }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: compact ? 12 : 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Button theme={theme} compact={compact} kind="ghost" icon="House" title="Home" accessibilityHint="Opens Follow-up Home with every workspace" onPress={openOverview} />
    <View style={{ flex: 1 }} />
    {openSettings && <VersionMark theme={theme} touch={compact} openSettings={openSettings} />}
    {openSettings && <IconButton icon="Settings" label="Follow-up settings" onPress={() => openSettings()} theme={theme} compact={compact} />}
  </View>;
}

const NO_INBOX = { subscribe: () => () => undefined, version: () => 0, rows: () => [] } as unknown as InboxStore;
const NO_ROWS: readonly InboxRow[] = [];
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
  const { openView, place, navigation } = props;
  const compact = props.layout.compact;
  const top = <PanelTop theme={props.theme} compact={compact} openOverview={props.openOverview} openSettings={props.openSettings} />;
  const brief = useMainBrief(props.workspace, props.briefDeps ? props.inbox : undefined);
  const ask = brief && props.briefDeps ? { brief, card: <BriefCard {...({ item: { data: brief }, theme: props.theme, layout: { compact }, agentId: props.workspace.mainAgentId, deps: props.briefDeps, bare: true } as unknown as Parameters<typeof BriefCard>[0])} /> } : null;
  // The side panel opens the full view as a tab; the tab opens the main agent's chat.
  const resize = place === "panel" ? (openView ? { icon: "Maximize2" as const, label: "Open in a tab", onPress: () => openView(props.workspaceId) } : null)
    : navigation ? { icon: "MessageSquare" as const, label: "Open chat", onPress: () => navigation.openAgent({ agentId: props.workspace.mainAgentId }) } : null;
  return <WorkspaceView {...props} top={top} ask={ask} folds={{ isOpen, toggle }} resize={resize} />;
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
function WorkspaceCard({ workspace: w, theme, compact, openAgent, browserReady, openOverview, editSpec }: { workspace: Workspace; theme: Theme; compact: boolean; openAgent?: (id: string) => void; browserReady: boolean | null; openOverview: () => void; editSpec: () => void }) {
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
  const openUrl = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
  // Quiet and folded by default; open or closed is remembered per device, like every panel section.
  return <Card theme={theme} compact={compact} icon="SlidersHorizontal" title="Spec, agent and recovery" fold={{ id: "workspace", defaultOpen: false }}>
    <>
      <SpecRow workspace={w} theme={theme} compact={compact} onEdit={editSpec} />
      <LinkedItemsRow workspace={w} theme={theme} compact={compact} />
      <CardRow theme={theme} compact={compact}><SummaryRow workspaceId={w.id} theme={theme} compact={compact} /></CardRow>
      <CardRow theme={theme} compact={compact}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
            <Text style={t.label}>Main agent</Text>
            <MainAgentName agentId={w.mainAgentId} theme={theme} />
            <Text style={t.meta}>Owns the PRs, tasks and the Done call. Repairs are sent here.</Text>
          </View>
          {openAgent && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open" accessibilityLabel="Open main agent" onPress={() => openAgent(w.mainAgentId)} />}
        </View>
        <MainChangeNotice workspace={w} theme={theme} compact={compact} />
        <PagedRows items={w.contributorAgentIds ?? []} theme={theme} compact={compact} noun="agents" row={id => <OtherRootAgent key={id} agentId={id} workspace={w} theme={theme} compact={compact} openAgent={openAgent} mainAgentId={w.mainAgentId} />} />
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
    </>
  </Card>;
}

/**
 * How an agent's title is read: Paseo's client state (no fetch) inside a workspace panel. The larger view is a screen
 * with no client state, where useAgent throws ("Plugin state hooks must run inside a workspace panel"): there the
 * title is the short id. Once Spec, agent and recovery's fold was remembered per device, opening it in the panel
 * crashed the larger view on its next open.
 */
const AgentTitleSource = createContext<(agentId: string) => string | null | undefined>((agentId: string) => useAgent(agentId, a => a.title));
const noClientState = () => null;

/** An agent's title, or a short id while it loads, once it's gone, or in the larger view. */
function useAgentTitle(agentId: string): string {
  return useContext(AgentTitleSource)(agentId) || `Agent ${agentId.slice(0, 8)}`;
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
  const tasks = followUpObligations(w).filter(o => finishedTask(o)).length;
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

/** A card's slot in the layout: measured, and placed by shared/workspace-layout.ts. */
function Slot({ id, onHeight, children }: { id: string; onHeight: (id: string, h: number) => void; children: ReactNode }) {
  return <View onLayout={e => onHeight(id, Math.round(e.nativeEvent.layout.height))}>{children}</View>;
}

type PanelCard = { key: string; node: ReactNode; column?: number };
/**
 * The cards in columns, placed from their measured heights (invariant 149, a-card-resize-redraws-no-other-card). The
 * heights live here, not in WorkspaceView: a card that grows or shrinks (a question picked or closed in Needs you)
 * redraws these columns alone, and every card in them is the same element as before, so React skips it.
 */
function Columns({ cards, columns }: { cards: readonly PanelCard[]; columns: number }) {
  // Measured heights and the last placement (so a card whose height changes with its column doesn't flip back and forth).
  const [heights, setHeights] = useState<Record<string, number>>({});
  const placed = useRef<Record<string, number>>({});
  const onHeight = useCallback((id: string, h: number) => setHeights(prev => prev[id] === h ? prev : { ...prev, [id]: h }), []);
  const where = placeCards(cards, columns, heights, placed.current);
  placed.current = where;
  return <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
    {Array.from({ length: columns }, (_, col) => <View key={col} style={{ flex: columns === 2 ? (col === 0 ? AGENT_SHARE : 1 - AGENT_SHARE) : 1, minWidth: 0 }}>
      {cards.filter(x => where[x.key] === col).map(x => <Slot key={x.key} id={x.key} onHeight={onHeight}>{x.node}</Slot>)}
    </View>)}
  </View>;
}

/** A pending permission of one agent in the workspace, with Allow and Deny, in Needs you (`permissions`). */
function AgentPermissions({ agentId, theme, compact }: { agentId: string; theme: Theme; compact: boolean }) {
  const agent = useAgentLive(agentId);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (id: string, response: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) => {
    if (busy) return; setBusy(id);
    try { await agent.handle!.respondToPermission({ requestId: id, response: response as never }); toast.show(response.behavior === "allow" ? "Allowed" : "Denied", { variant: "success" }); }
    catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  return <>{agent.permissions.map(p => <View key={p.id} style={{ padding: compact ? 14 : 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
    <PermissionBlock p={p} theme={theme} compact={compact} busy={busy === p.id} primary note="Allow runs it once. Deny stops it." onRespond={r => void respond(p.id, r)} />
  </View>)}</>;
}

/**
 * The workspace view (invariant 135, one-workspace-view): the same view in Home's detail pane, the side panel and the
 * main tab. Its layout comes from its own width only (shared/workspace-layout.ts): one column (dense, then roomy), two
 * from 760, three from 1400; the head spans them and cards go to the shorter column. `place` adds only its own head
 * controls and decides the reply box (client/agent-card.tsx): the side panel sits beside the chat, so it has none.
 */
export function WorkspaceView({ theme, layout, workspace: w, navigation, loadError, openSettings, openOverview, folds: { isOpen, toggle }, resize, top, ask, sources, paseo, inbox, place, head, moves, dock, onSent }: PluginHostProps & {
  /** The inbox rows' store, for each agent's line (client/now-lines.tsx). Absent: the lines read the record alone. */
  inbox?: InboxStore;
  navigation?: PluginWorkspacePanelProps["navigation"]; workspace: Workspace; loadError?: string | null; openSettings: (category?: SettingsCategory) => void; openOverview: () => void;
  /** Above the scroll (the panel's Home bar, Home's phone head). */ top?: ReactNode;
  /** The main agent's open brief and its card, for the Needs you block. */ ask?: { brief: Brief; card: ReactNode } | null;
  folds: Folds;
  /** The head's icon action: the side panel's "Open in a tab". */
  resize: { icon: "Maximize2" | "Minimize2" | "MessageSquare"; label: string; onPress: () => void } | null;
  /** Home's sources: the header's More menu (the row menu). */
  sources?: HomeSources;
  /** Paseo's workspace list where Home's sources aren't passed: Your questions' running state. */
  paseo?: HomeSources["paseo"];
  place: ViewPlace;
  /** Home's own head: its title line and Open (client/home.tsx). */
  head?: { lead?: ReactNode; tail?: ReactNode; actions?: ReactNode };
  /** Home's moves on this item, at the end of the head (the layout says how dense). */
  moves?: (l: Layout) => ReactNode;
  /** A phone's bottom dock (Home's moves and reply box), through DockedPane (invariant 43). */
  dock?: (s: DockState) => ReactNode;
  onSent?: () => void;
}) {
  const control = useRpc(controlRpc); const refresh = useRpc(refreshRpc); const browserRead = useRpc(browserStatusRpc);
  const cache = useQueryClient(); const toast = useToast();
  const now = useNow(30_000);
  const compact = layout.compact;
  const [width, setWidth] = useState(0);
  const lay = layoutFor(compact ? 0 : width);
  // The tasks footer's "in Activity" link scrolls here (showActivity).
  const scrollRef = useRef<unknown>(null);
  const logRef = useRef<View>(null);
  const logY = useRef(0);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" | null } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  // An Activity row's question past what follow.get carries (shared/history.ts): the sheet draws the page's copy.
  const [oldQuestion, setOldQuestion] = useState<Question | null>(null);
  useQuestionOpener(w.id, setQuestion);
  const [specOpen, setSpecOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<ReactNode>(null);
  // Read when the view opens and again when a PR sheet opens (its Open-in-browser actions use it); nothing polls it.
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), staleTime: 0, refetchOnMount: "always" });
  useEffect(() => { if (sheet) void browser.refetch(); }, [sheet?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalidated = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const auto = useMutation({ mutationFn: (next: boolean) => control({ workspaceId: w.id, enable_auto_sends: next }), onSuccess: (_, next) => { toast.show(next ? "Auto-send on for this workspace" : "Auto-send off · repairs wait for your Send"); invalidated(); }, onError: e => toast.error(errorText(e)) });
  // Opening a workspace reads its PRs now: background polling backs off for settled repositories (server/github.ts).
  useEffect(() => { const t = setTimeout(invalidated, 1500); void refresh({ workspaceId: w.id }).catch(() => undefined); return () => clearTimeout(t); }, [w.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useMutation({ mutationFn: () => refresh({ workspaceId: w.id }), onSuccess: () => setTimeout(invalidated, 1200), onError: e => toast.error(errorText(e)) });
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const done = summary(w, now).status === "done";
  const openPr = (key: string) => setSheet({ key, intent: null });
  const header = <WorkspaceHeader workspace={w} theme={theme} compact={compact} now={now} onSettings={openSettings} onRefresh={() => update.mutate()} refreshing={update.isPending} onAuto={next => auto.mutate(next)} autoPending={auto.isPending} notice={loadError ?? null} onOpenPr={openPr}
    resize={resize} onHome={compact && place === "panel" ? openOverview : undefined} openAgent={openAgent} agentLines={!done} dense={lay.dense}
    titleLead={head?.lead} titleTail={head?.tail} actions={head?.actions} forceTitle={place === "home"} moves={moves?.(lay)}
    more={sources ? <PanelMore w={w} sources={sources} theme={theme} compact={compact} openAgent={openAgent} openQuestion={setQuestion} showMenu={setMoreMenu} /> : undefined} />;
  const running = useWorkspaceRunning(sources?.paseo ?? paseo, w.id);
  const rows = useInbox(inbox ?? NO_INBOX, () => inbox?.rows() ?? NO_ROWS);
  // A pending permission is the developer's to answer: first in Needs you, with Allow and Deny; the agent's row says so.
  const permitting = workspaceNow(w, rows, now).filter(n => n.state.kind === "permission").map(n => n.agentId);
  const permissions = permitting.length ? { count: permitting.length, node: <>{permitting.map(id => <AgentPermissions key={id} agentId={id} theme={theme} compact={compact} />)}</> } : null;
  const shipped = <ShippedCard workspace={w} theme={theme} compact={compact} now={now} />;
  // The agent card: every agent's line, Recent steps and the reply box (the side panel draws none; a phone's Home docks it).
  const agentCard = <AgentCard workspace={w} inbox={inbox} theme={theme} compact={compact} steps={lay.steps} now={now} place={place} openAgent={openAgent} onSent={onSent} reply={place !== "panel" && !dock} />;
  const needs = <NeedsYouBlock workspace={w} theme={theme} compact={compact} now={now} brief={ask?.brief ?? null} briefCard={ask?.card ?? null} permissions={permissions} actions={{ openAgent, openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion }} fold />;
  // Your questions (docs/needs-you.md#your-questions): under the agent card in one column.
  const agentName = (id: string) => id === w.mainAgentId ? "Main agent" : w.taskAgents?.[id]?.title?.trim() || "Agent";
  const questions = <YourQuestionsCard workspaceId={w.id} mainAgentId={w.mainAgentId} theme={theme} compact={compact} openAgent={openAgent} running={running} fold />;
  // Once shipped, the stack and tasks are history: one quiet fold instead of two near-empty cards.
  const history = done && <View style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
    <View style={{ marginTop: -1 }}><FoldRow theme={theme} compact={compact} open={isOpen("history")} onPress={() => toggle("history")} icon="History" iconColor={theme.colors.foregroundMuted} label={historyLabel(w)} /></View>
  </View>;
  const showWork = !done || isOpen("history");
  const multi = lay.columns > 1;
  const stacks = showWork && <StacksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpen={openPr} wide={multi} />;
  // The tasks footer's "in Activity" goes there: on the web the least scroll that shows it (it can sit in another
  // column), on a phone its offset in the one column.
  const showActivity = () => {
    const node = logRef.current as unknown as { scrollIntoView?(o: object): void } | null;
    if (Platform.OS === "web" && node?.scrollIntoView) node.scrollIntoView({ block: "start", behavior: "smooth" });
    else (scrollRef.current as NativeScrollView | null)?.scrollTo({ y: logY.current, animated: true });
  };
  const tasks = showWork && <TasksCard workspace={w} theme={theme} compact={compact} open={isOpen} toggle={toggle} onOpenQuestion={setQuestion} openAgent={openAgent} onShowActivity={showActivity} now={now} />;
  // The send queue (what Follow-up sends the main agent next, and the repairs in it): the outbox, under the reply box.
  const messages = showWork && <MessagesCard workspace={w} theme={theme} compact={compact} openAgent={openAgent} now={now} />;
  const log = <View ref={logRef} onLayout={e => { logY.current = e.nativeEvent.layout.y; }}><ActivityCard workspace={w} theme={theme} compact={compact} now={now} open={isOpen} toggle={toggle} onOpenQuestion={(id, q) => { setOldQuestion(q ?? null); setQuestion(id); }} /></View>;
  const workspaceCard = <WorkspaceCard workspace={w} theme={theme} compact={compact} openAgent={openAgent} browserReady={browser.data ? browser.data.ready : null} openOverview={openOverview} editSpec={() => setSpecOpen(true)} />;
  // Home is a screen, with no client state (useAgent throws there): agent titles read the short id.
  const extras = place === "home" ? <AgentTitleSource.Provider value={noClientState}>{workspaceCard}</AgentTitleSource.Provider> : workspaceCard;
  // Priority order. The left column (the wide one in two) is the agent's, or Needs you's while anything waits on the
  // developer: it reads first, as in one column, and the agent card moves to the next column. In two columns the
  // decisions and PRs stay right and the record joins the shorter column; in three every other card goes to the
  // shorter of the two right columns.
  const waiting = needsYou(w, now).length > 0 || !!permissions || !!ask?.card;
  const right = lay.columns === 2 ? 1 : undefined;
  const agentCol = waiting ? 1 : 0;
  const cards: PanelCard[] = [
    { key: "shipped", node: shipped, column: 0 }, ...(waiting ? [{ key: "needs", node: needs, column: 0 }] : []),
    { key: "agent", node: agentCard, column: agentCol }, { key: "messages", node: messages, column: agentCol }, { key: "history", node: history, column: agentCol },
    ...(waiting ? [] : [{ key: "needs", node: needs, column: right }]), { key: "questions", node: questions, column: right }, { key: "stacks", node: stacks, column: right },
    { key: "tasks", node: tasks, column: right }, { key: "log", node: log }, { key: "extras", node: extras },
  ].filter(x => !!x.node);
  const one = <>{shipped}{needs}{agentCard}{messages}{questions}{history}{stacks}{tasks}{log}{extras}</>;
  return <View testID={`follow-up-view-${place}`} onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    {/* Agent rows peek at their agent's turn on hover (client/turn-view.tsx), where Recent steps start folded. */}
    <PeekHost where={place === "panel" ? "panel" : "main"} theme={theme} compact={compact} openAgent={openAgent} names={agentName} enabled={place === "panel"}>
    <DockedPane compact={compact} scrollRef={scrollRef as never} header={!compact || place !== "panel" ? top : undefined} dock={dock} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
      {header}
      {multi ? <Columns cards={cards} columns={lay.columns} /> : one}
    </DockedPane>
    </PeekHost>
    <PrSheet workspace={w} prKey={sheet?.key ?? null} intent={sheet?.intent ?? null} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />
    <QuestionSheet workspace={w} questionId={question} fallback={oldQuestion} theme={theme} compact={compact} openAgent={openAgent} onClose={() => setQuestion(null)} />
    <SpecSheet workspace={w} open={specOpen} theme={theme} compact={compact} onClose={() => setSpecOpen(false)} />
    {/* The More menu draws last, at the view's root, so its own content never paints over it. */}
    {moreMenu}
  </View>;
}
