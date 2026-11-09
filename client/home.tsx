import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { browserKey, BROWSER_POLL_MS } from "./keys";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { browserStatusRpc, inboxBriefRpc } from "../shared/contracts";
import { needsYou } from "../shared/attention";
import { briefPane, followUpLog, lastWorkdayEnd, nextNeeds, paneButtons, sinceLabel, tailSteps, type HomeGroupId, type HomeModel, type LogLine, type TailStep, type Workstream } from "../shared/home";
import { age, snoozeUntil, type InboxRow } from "../shared/inbox";
import { errorText } from "../shared/errors";
import { isLoaded, type LoadSignals } from "../shared/agent-load";
import { BriefCard, type BriefDeps } from "./brief";
import { AboutSection } from "./about";
import { Button, IconButton, text, type Theme } from "./kit";
import { NeedsYouList } from "./needs-you";
import { PrSheet } from "./pr-sheet";
import { QuestionSheet } from "./questions";
import { Age, BadgeView, BRIEF_KEY, glyphColor, HomeList, OVERSEER_KEY, PrChipView, type OverseerRowState } from "./home-list";
import { answerLine, overseerRowState } from "../shared/overseer";
import type { OmniboxItem } from "../shared/search";
import { ListTop, SearchField, SortMenu, StatusStrip, UsageMeters, useOmnibox, useSlashToFocus } from "./home-chrome";
import { useHomeModel, useTick, type HomeSources } from "./home-data";
import { useInbox, UndoBar, useNextRelay } from "./inbox";
import { Spinner } from "./motion";
import { withAlpha, isLight, mergedColor, type Colors } from "./theme";

export const HOME_SCREEN = "follow-through";
const mono = Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace";

export type HomeDeps = {
  sources: HomeSources;
  openSettings(): void;
  /** Docks the workspace's own panel in its explorer column. */
  openPanel(workspaceId: string): void;
  openLog(): void;
  openHome(): void;
  briefDeps: BriefDeps;
};

/**
 * Home (design §2–§6): every workstream on the left, the selected one on the right, answered in place.
 * With nothing selected the right side is the brief. `?view=log` shows what Follow-up did on its own.
 */
export function FollowHome(props: PluginScreenProps & { deps: HomeDeps }) {
  const { theme, layout, navigation, params = {}, deps } = props;
  const { inbox } = deps.sources;
  const c = theme.colors;
  const compact = layout.compact;
  const model = useHomeModel(deps.sources);
  const omnibox = useOmnibox(model, deps.sources);
  useSlashToFocus(omnibox, params.view !== "log");
  const [filter, setFilter] = useState<HomeGroupId | null>(null);
  const [selected, setSelected] = useState<string | null>(() => params.select ? `agent:${params.select}` : null);
  const openAgentRow = useMemo(() => navigation ? (row: InboxRow) => navigation.openAgent({ agentId: row.agentId }) : undefined, [navigation]);
  useNextRelay(inbox, params, openAgentRow);
  useEffect(() => { if (params.select) setSelected(`agent:${params.select}`); }, [params.select]);
  const onSelect = useCallback((key: string) => setSelected(key === BRIEF_KEY ? null : key), []);
  const current = selected ? model.byKey.get(selected) ?? (selected.startsWith("agent:") ? [...model.byKey.values()].find(x => x.agentId === selected.slice(6)) ?? null : null) : null;
  const tracked = useSyncExternalStore(deps.sources.live.subscribe, deps.sources.live.version, deps.sources.live.version);
  const rows = useInbox(inbox, () => inbox.rows());
  const pane = useMemo(() => briefPane({ model, rows, tracked: deps.sources.live.all(), now: Date.now() }), [model, rows, tracked, deps.sources.live]);
  const overseerStatus = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.overseer, deps.sources.extras.overseer);
  const overseerInbox = useInbox(inbox, () => inbox.overseer());
  const overseer = overseerRowState(overseerStatus, overseerInbox);
  const toast = useToast();
  // The omnibox's "Ask the Overseer" row: send, then show the conversation it lands in.
  const [asking, setAsking] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const pick = useCallback(async (item: OmniboxItem) => {
    if (item.ask === undefined) { setSelected(item.key); return; }
    if (asking) return;
    setAsking(true);
    // No toast: the conversation opens on the sent words, which says it more plainly.
    try { await deps.sources.extras.askOverseer(item.ask); omnibox.setQuery(""); omnibox.inputRef.current?.blur(); setPendingAsk(item.ask); setSelected(OVERSEER_KEY); inbox.refresh(); }
    catch (e) { toast.error(errorText(e)); } finally { setAsking(false); }
  }, [asking, deps.sources.extras, omnibox, inbox, toast]);
  // ⌘K "Follow-up: Ask the Overseer" opens Home with `?ask=<nonce>`: select it and focus its reply box. A param, not
  // shared state, so it works whether Home was already open or mounts fresh.
  const [replyFocus, setReplyFocus] = useState(0);
  useEffect(() => {
    if (!params.ask) return;
    if (overseerStatus && !overseerStatus.enabled) { toast.show("The Overseer is off. Turn it on in Follow-up settings."); return; }
    setSelected(OVERSEER_KEY); setReplyFocus(n => n + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.ask]);
  const briefLine = [pane.counts.needs ? `${pane.counts.needs} need you` : "Nothing needs you", pane.counts.fixing ? `${pane.counts.fixing} being fixed` : "", pane.away.count ? `${pane.away.count} done while away` : ""].filter(Boolean).join(" · ");

  const openFull = useCallback((s: Workstream) => {
    if (!navigation) return;
    if (s.agentId) navigation.openAgent({ agentId: s.agentId }); else if (s.workspaceId) navigation.openWorkspace({ workspaceId: s.workspaceId });
    // The explorer needs the workspace route first; then dock that workspace's panel beside the chat.
    if (!compact && s.workspaceId) { const id = s.workspaceId; setTimeout(() => deps.openPanel(id), 900); }
  }, [navigation, compact, deps]);
  const signOffNext = useCallback((s: Workstream) => {
    if (s.agentId) void inbox.signOff([s.agentId]);
    const next = nextNeeds(model, s.key);
    setSelected(next?.key ?? null);
  }, [inbox, model]);

  if (params.view === "log") return <LogView theme={theme} compact={compact} sources={deps.sources} onHome={deps.openHome} onOpen={key => { setSelected(key); deps.openHome(); }} />;

  const detail = selected === OVERSEER_KEY && overseer
    ? <OverseerPane theme={theme} compact={compact} o={overseer} focus={replyFocus} pending={pendingAsk} agentId={overseerStatus?.agentId ?? null} model={overseerStatus?.model ?? null} restartWith={overseerStatus?.restartWith ?? null} configured={overseerStatus?.configured ?? null} deps={deps} navigation={navigation} onBack={compact ? () => setSelected(null) : undefined} />
    : current
    ? <DetailPane key={current.key} s={current} model={model} theme={theme} compact={compact} deps={deps} openFull={openFull} signOffNext={signOffNext} onBack={compact ? () => setSelected(null) : undefined} />
    : <BriefPane theme={theme} compact={compact} pane={pane} onSelect={key => setSelected(key)} openLog={deps.openLog} sources={deps.sources} />;
  const list = <HomeList model={model} theme={theme} dense={compact} touch={compact} selectedKey={selected} onSelect={onSelect} briefLine={briefLine}
    results={omnibox.results} activeResult={omnibox.active} onResult={item => void pick(item)} filter={filter} overseer={overseer} asking={asking}
    top={<ListTop theme={theme} dense={compact} title={<ListHeader theme={theme} compact={compact} onSettings={deps.openSettings} />}>
      {/* zIndex: on web every View is its own stacking context, so the sort menu only paints and hit-tests above the
          strip and meters below if this row sits above them. */}
      <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: compact ? 12 : 16 }}>
        <SearchField theme={theme} omnibox={omnibox} dense={compact} onEnter={item => void pick(item)} />
        <SortMenu theme={theme} mode={model.sort} onChange={deps.sources.extras.setSort} rankedAt={model.rankedAt} touch={compact} />
      </View>
      {!omnibox.results && <StatusStrip theme={theme} model={model} filter={filter} onFilter={setFilter} touch={compact} dense={compact} />}
      {!omnibox.results && <UsageMeters theme={theme} sources={deps.sources} dense={compact} />}
    </ListTop>} />;

  if (compact) return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {current || selected === OVERSEER_KEY && overseer ? detail : list}
    <View style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}><UndoBar store={inbox} theme={theme} touch /></View>
  </View>;
  return <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.surface0 }}>
    <View style={{ flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: c.border }}>
      {list}
      <View style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}><UndoBar store={inbox} theme={theme} touch={false} /></View>
    </View>
    <View style={{ width: "42%", minWidth: 380, maxWidth: 680 }}>{detail}</View>
  </View>;
}

function ListHeader({ theme, compact, onSettings }: { theme: Theme; compact: boolean; onSettings: () => void }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 }}>
    <Text accessibilityRole="header" style={{ flex: 1, color: c.foreground, fontSize: compact ? 17 : 15, fontWeight: "600" }}>Home</Text>
    <IconButton theme={theme} compact={compact} icon="Settings" label="Follow-up settings" onPress={onSettings} />
  </View>;
}

// ---------- detail pane ----------

type Permission = { id: string; name: string; title?: string; description?: string; detail?: Record<string, unknown>; input?: Record<string, unknown>; actions?: { id: string; label: string; behavior: "allow" | "deny"; variant?: string }[] };

/** The selected agent's live state: pending permissions and status, from its own handle (never the whole list). */
function useAgentLive(agentId: string | null) {
  const paseo = usePaseo();
  const handle = useMemo(() => agentId ? paseo.agents.ref(agentId) : null, [paseo, agentId]);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!handle) return;
    let live = true;
    void handle.refresh().then(() => live && bump(n => n + 1)).catch(() => undefined);
    const off = handle.subscribe(() => { if (live) bump(n => n + 1); });
    return () => { live = false; off(); };
  }, [handle]);
  return { handle, permissions: (handle?.pendingPermissions ?? []) as unknown as Permission[], status: handle?.status ?? null };
}

/** The last steps Home read per agent this session, and when, shown while the agent isn't loaded. */
const seenSteps = new Map<string, { steps: TailStep[]; at: number }>();
/**
 * "Recent · last N steps", read only for the selected agent, refreshed when its status or flag changes.
 * Reading a timeline loads an unloaded agent for an hour (see shared/agent-load.ts), so an agent that isn't loaded
 * shows the steps Home saw last (marked with when) and waits for an explicit "Load recent steps".
 */
function useTail(handle: ReturnType<typeof useAgentLive>["handle"], key: string, n = 6) {
  const [steps, setSteps] = useState<TailStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [wake, setWake] = useState(0);
  const [asleep, setAsleep] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unknown, setUnknown] = useState(false);
  useEffect(() => { setWake(0); setUnknown(false); }, [handle]);
  // A snapshot that never arrives counts as not loaded instead of spinning forever.
  useEffect(() => { if (!handle) return; const id = setTimeout(() => setUnknown(true), 5_000); return () => clearTimeout(id); }, [handle]);
  useEffect(() => {
    if (!handle) { setSteps([]); return; }
    const current = handle.current();
    if (!current && !unknown) return;
    const loaded = !!current && isLoaded(current as unknown as LoadSignals);
    if (!loaded && !wake) {
      const seen = seenSteps.get(handle.id);
      setAsleep(true); setSteps(seen?.steps ?? []); setSeenAt(seen?.at ?? null); setError(null); return;
    }
    setAsleep(false);
    let live = true; setLoading(true);
    handle.timeline.refetch({ direction: "tail", limit: 40 }).then(page => {
      if (!live) return;
      const entries = [...(page as unknown as { entries: { seqStart: number; item: Parameters<typeof tailSteps>[0][number] }[] }).entries].sort((a, b) => a.seqStart - b.seqStart);
      const next = tailSteps(entries.map(e => e.item), n);
      seenSteps.set(handle.id, { steps: next, at: Date.now() }); setSteps(next); setSeenAt(null); setError(null);
    }).catch(e => { if (live) { setError(errorText(e)); setSteps(s => s ?? []); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [handle, key, wake, unknown, n]);
  return { steps, error, seenAt, asleep, loading, woken: wake > 0, load: () => setWake(n => n + 1) };
}

function DetailPane({ s, model, theme, compact, deps, openFull, signOffNext, onBack }: {
  s: Workstream; model: HomeModel; theme: Theme; compact: boolean; deps: HomeDeps;
  openFull: (s: Workstream) => void; signOffNext: (s: Workstream) => void; onBack?: () => void;
}) {
  const c = theme.colors; const t = text(c);
  const toast = useToast();
  const { inbox, live } = deps.sources;
  const row = useInbox(inbox, () => s.agentId ? inbox.rows().find(r => r.agentId === s.agentId) ?? null : null);
  const w = useSyncExternalStore(live.subscribe, () => s.workspaceId ? live.get(s.workspaceId) : undefined, () => undefined);
  const agent = useAgentLive(s.agentId);
  const readBrief = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-through", "home-brief", s.agentId, row?.seq ?? 0], queryFn: () => readBrief({ agentId: s.agentId! }), enabled: !!s.agentId && !!row?.brief });
  const tail = useTail(agent.handle, `${row?.seq ?? 0}:${agent.status ?? ""}`);
  const browserRead = useRpc(browserStatusRpc);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), refetchInterval: BROWSER_POLL_MS, enabled: !!sheet });
  const [question, setQuestion] = useState<string | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const b = brief.data?.brief?.state === "open" ? brief.data.brief : null;
  const items = w ? needsYou(w).map(i => i.kind) : [];
  const flagged = !!row?.needs && !row.snooze;
  const plan = paneButtons({ permissions: agent.permissions.length, decisions: !!b?.decisions.some(d => d.options.length), items, flagged, hasAgent: !!s.agentId });
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return; setBusy(key);
    try { await work(); if (done) toast.show(done, { variant: "success" }); inbox.refresh(); } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  const respond = (p: Permission, response: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) =>
    run(`perm:${p.id}`, () => agent.handle!.respondToPermission({ requestId: p.id, response: response as never }), response.behavior === "allow" ? "Allowed" : "Denied");
  const color = glyphColor(s, c);

  const header = <View style={{ paddingHorizontal: compact ? 16 : 20, paddingTop: 12, paddingBottom: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {onBack && <IconButton theme={theme} compact icon="ChevronLeft" label="Back to Home" onPress={onBack} />}
      <Icon name={s.icon} size={16} color={color} />
      <Text accessibilityRole="header" numberOfLines={2} style={[t.title, { flex: 1, fontSize: 16 }]}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      <Button theme={theme} compact={compact} icon="PanelRightOpen" title="Open full" accessibilityHint="Opens the agent's chat and docks this list beside it" onPress={() => openFull(s)} />
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {!!s.word && <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{s.word}</Text>}
      <Text style={t.meta}>{[s.at ? age(s.at, Date.now()) === "now" ? "just now" : `${age(s.at, Date.now())} ago` : "", s.project].filter(Boolean).join(" · ")}</Text>
      {s.badges.map(x => <BadgeView key={x.text} b={x} c={c} />)}
      <PrChipView s={s} c={c} />
    </View>
  </View>;

  const actionBar = (plan.buttons.includes("sign_off") || plan.buttons.includes("later")) && <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button theme={theme} compact={compact} kind={plan.primary === "sign_off" ? "primary" : "secondary"} icon="Check" title="Sign off" loading={busy === "sign_off"}
        onPress={() => void run("sign_off", () => inbox.signOff([s.agentId!]))} />
      <Button theme={theme} compact={compact} icon="ArrowRight" title="Sign off & next" onPress={() => signOffNext(s)} />
      <Button theme={theme} compact={compact} icon="AlarmClock" title="Later…" onPress={() => setLaterOpen(v => !v)} />
    </View>
    {laterOpen && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {([["hour", "In 1 hour"], ["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"], ["next-event", "Next event"]] as const).map(([k, label]) =>
        <Button key={k} theme={theme} compact={compact} kind="ghost" title={label} onPress={() => { setLaterOpen(false); void inbox.snooze([s.agentId!], snoozeUntil(k, new Date())); }} />)}
    </View>}
  </View>;

  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {header}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 20, gap: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {!compact && s.workspaceId && w && <AboutSection key={s.workspaceId} workspaceId={s.workspaceId} theme={theme} compact={compact} flush />}
      {agent.permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={busy === `perm:${p.id}`} primary={plan.primary === "allow"} onRespond={r => void respond(p, r)} />)}
      {b && s.agentId && !(b.kind === "permission" && agent.permissions.length) ? <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} />
        : row?.needs && !agent.permissions.length && !b ? <Text style={[t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{s.line || s.word || "Needs you"}</Text>
        : !row?.needs && s.line ? <Text style={t.body}>{s.line}</Text> : null}
      {w && <NeedsYouList workspace={w} theme={theme} compact={compact} flush skip={b?.decisions.length ? ["question"] : []}
        actions={{ openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion, openAgent: () => openFull(s) }} />}
      {actionBar}
      {/* On a phone the ask and its moves come first; the reminder sits under them. */}
      {compact && s.workspaceId && w && <AboutSection key={s.workspaceId} workspaceId={s.workspaceId} theme={theme} compact={compact} flush />}
      {s.agentId && <View style={{ gap: 8 }}>
        <Text style={[t.small, { fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>{tail.asleep && tail.seenAt ? `Last seen · ${age(new Date(tail.seenAt).toISOString(), Date.now()) === "now" ? "just now" : `${age(new Date(tail.seenAt).toISOString(), Date.now())} ago`}` : tail.steps?.length ? `Recent · last ${tail.steps.length} steps` : "Recent steps"}</Text>
        {!!tail.error && <Text style={t.meta}>{`Couldn't load the agent's steps: ${tail.error}`}</Text>}
        {tail.steps === null ? <Spinner color={c.foregroundMuted} size={12} label="Loading the agent's steps" />
          : tail.steps.length === 0 ? (tail.error ? null : <Text style={t.meta}>{tail.asleep ? "This agent isn't loaded, so its steps aren't shown." : "No steps yet."}</Text>)
          : tail.steps.map((step, i) => <Step key={i} step={step} c={c} last={i === tail.steps!.length - 1} />)}
        {(tail.asleep || (tail.woken && tail.loading)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Button theme={theme} compact={compact} kind="secondary" title={tail.loading ? "Loading…" : "Load recent steps"} loading={tail.loading} disabled={tail.loading} onPress={tail.load} />
          <Text style={[t.small, { flex: 1, minWidth: 160 }]}>Loads the agent into memory for about an hour.</Text>
        </View>}
        {!!tail.steps?.length && <Text style={t.small}>A preview, not the whole session. Open full for the chat.</Text>}
      </View>}
    </ScrollView>
    {s.agentId && <ReplyBox theme={theme} compact={compact} agentName={s.title} onSend={async text => {
      await agent.handle!.send(text);
      inbox.refresh();
    }} />}
    {w && sheet && <PrSheet workspace={w} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
    {w && <QuestionSheet workspace={w} questionId={question} theme={theme} compact={compact} onClose={() => setQuestion(null)} />}
  </View>;
}

/**
 * The Overseer's conversation on Home (1.4.0-beta.0): the tail and a reply box, like any agent's detail pane, plus its
 * decision card when it asks which agent should get a task. Before the first start, one Start button.
 */
function OverseerPane({ theme, compact, o, focus = 0, pending = null, agentId, model, restartWith, configured, deps, navigation, onBack }: { theme: Theme; compact: boolean; o: OverseerRowState; focus?: number; pending?: string | null; agentId: string | null; model: string | null; restartWith: string | null; configured: string | null; deps: HomeDeps; navigation: PluginScreenProps["navigation"]; onBack?: () => void }) {
  const c = theme.colors; const t = text(c);
  const toast = useToast();
  const { inbox, extras } = deps.sources;
  const row = useInbox(inbox, () => inbox.overseer());
  const agent = useAgentLive(agentId);
  const tail = useTail(agent.handle, `${row?.seq ?? 0}:${agent.status ?? ""}`, 8);
  const readBrief = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-through", "overseer-brief", agentId, row?.seq ?? 0], queryFn: () => readBrief({ agentId: agentId! }), enabled: !!agentId && !!row?.brief });
  const b = brief.data?.brief?.state === "open" ? brief.data.brief : null;
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    if (restarting) return; setRestarting(true);
    try { const next = await extras.restartOverseer(); toast.show(`The Overseer now runs on ${next?.model ?? restartWith}; its recent conversation was handed over`, { variant: "success" }); } catch (e) { toast.error(errorText(e)); } finally { setRestarting(false); }
  };
  const start = async () => {
    if (starting) return; setStarting(true);
    try { await extras.startOverseer(); toast.show("The Overseer is ready", { variant: "success" }); } catch (e) { toast.error(errorText(e)); } finally { setStarting(false); }
  };
  const header = <View style={{ paddingHorizontal: compact ? 16 : 20, paddingTop: 12, paddingBottom: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {onBack && <IconButton theme={theme} compact icon="ChevronLeft" label="Back to Home" onPress={onBack} />}
      <Icon name="MessagesSquare" size={16} color={c.foreground} />
      <Text accessibilityRole="header" style={[t.title, { fontSize: 16 }]}>Overseer</Text>
      <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{model ?? ""}</Text>
      {agentId && navigation && (compact
        ? <IconButton theme={theme} compact icon="PanelRightOpen" label="Open full" onPress={() => navigation.openAgent({ agentId })} />
        : <Button theme={theme} icon="PanelRightOpen" title="Open full" accessibilityHint="Opens the Overseer's whole chat" onPress={() => navigation.openAgent({ agentId })} />)}
    </View>
    {/* Settings → Agents changed: offered, never done mid-conversation on its own. */}
    {agentId && restartWith && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 6 }}>
      <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>{`Running ${model ?? "its first model"} · Settings say ${restartWith}`}</Text>
      <Button theme={theme} compact={compact} icon="RefreshCw" title={`Restart with ${short(restartWith)}`} accessibilityHint={`Starts a new Overseer on ${restartWith} and hands it the recent conversation`} loading={restarting} onPress={() => void restart()} />
    </View>}
  </View>;
  if (o.state === "start") return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {header}
    <ScrollView contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12 }}>
      <Text style={[t.body, { fontSize: 15, lineHeight: 22 }]}>One agent that knows every workspace's state. Tell it "the PRs look good, assign reviewers on all" or "tell the SCIM agent to use option B", and it finds the right agent and passes it on.</Text>
      <Text style={t.meta}>It never merges, posts to people or archives. It starts a new workspace only when you say so. It runs on {configured ?? "Claude · Newest Opus"} in its own workspace, which stays off your lists. Change the model in Follow-up settings → Agents.</Text>
      <View style={{ flexDirection: "row" }}><Button theme={theme} compact={compact} kind="primary" icon="Play" title="Start the Overseer" loading={starting} onPress={() => void start()} /></View>
    </ScrollView>
  </View>;
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {header}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {o.state === "error" && <Text accessibilityRole="alert" style={[t.body, { color: c.statusDanger }]}>{o.line}</Text>}
      {tail.steps === null ? <Spinner color={c.foregroundMuted} size={12} label="Loading the conversation" />
        : tail.steps.length === 0 ? <Text style={t.meta}>{tail.error ? `Couldn't load the conversation: ${tail.error}` : "Nothing yet. Ask it what needs you, or give it a task for one of your agents."}</Text>
        : tail.steps.map((step, i) => <Step key={i} step={step} c={c} last={i === tail.steps!.length - 1} />)}
      {/* An ask just sent from the omnibox, until the conversation shows it. */}
      {pending && tail.steps && !tail.steps.some(x => x.kind === "you" && x.text.trim() === pending) && <Step step={{ kind: "you", text: pending }} c={c} last={false} />}
      {(o.state === "running" || pending && tail.steps && !tail.steps.some(x => x.kind === "you" && x.text.trim() === pending)) && <Spinner color={c.foregroundMuted} size={12} label="The Overseer is working" />}
      {/* Its open ask, after the conversation that led to it. Only something Tom can act on; never "No ask stated". */}
      {b && agentId && (b.kind === "decision" && b.decisions.some(d => d.options.length) || b.kind === "action") ? <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} /> : null}
    </ScrollView>
    {agentId && <ReplyBox theme={theme} compact={compact} agentName="the Overseer" placeholder="Ask or give a task: “assign reviewers on all ready PRs”" hint={null} focus={focus}
      onSend={async message => { await agent.handle!.send(message); inbox.refresh(); }} />}
  </View>;
}

/** "Codex · GPT-6-Luna · low" → "GPT-6-Luna · low": the button already says it's the Overseer's provider change. */
const short = (summary: string) => summary.split(" · ").slice(1).join(" · ") || summary;

function Step({ step, c, last }: { step: TailStep; c: Colors; last: boolean }) {
  const t = text(c);
  if (step.kind === "tool") return <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
    <Icon name="Terminal" size={13} color={step.failed ? c.statusDanger : c.foregroundMuted} />
    <Text numberOfLines={1} style={[t.meta, { flex: 1, fontFamily: mono }]}>{step.text}</Text>
  </View>;
  if (step.kind === "you") return <View style={{ padding: 10, borderRadius: 8, backgroundColor: c.surface1, gap: 3 }}>
    <Text style={t.small}>You</Text><Text numberOfLines={3} style={t.body}>{answerLine(step.text) ?? step.text}</Text>
  </View>;
  if (step.kind === "error") return <Text numberOfLines={4} style={[t.body, { color: c.statusDanger }]}>{step.text}</Text>;
  return <Text selectable numberOfLines={last ? 40 : 4} style={[t.body, { lineHeight: 19 }]}>{step.text.replace(/\*\*/g, "")}</Text>;
}

function permissionText(p: Permission): string {
  const d = p.detail ?? {};
  const v = [d.command, d.filePath, d.path, d.url, p.input?.command, p.input?.file_path].find(x => typeof x === "string" && x.trim());
  return typeof v === "string" ? v : p.description ?? "";
}

function PermissionBlock({ p, theme, compact, busy, primary, onRespond }: { p: Permission; theme: Theme; compact: boolean; busy: boolean; primary: boolean; onRespond: (r: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) => void }) {
  const c = theme.colors; const t = text(c);
  const command = permissionText(p);
  // Provider-defined choices ("Always for this session") show as extra secondaries; Allow and Deny always exist.
  const extra = (p.actions ?? []).filter(a => !/^(allow|deny|reject)$/i.test(a.label.trim()));
  return <View accessibilityRole="alert" style={{ padding: 14, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.5), backgroundColor: withAlpha(c.statusWarning, isLight(c) ? 0.06 : 0.08) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ShieldQuestion" size={15} color={c.statusWarning} />
      <Text style={[t.label, { color: c.statusWarning, flex: 1 }]}>{p.title || `Wants to use ${p.name}`}</Text>
    </View>
    {!!command && <View style={{ padding: 10, borderRadius: 7, backgroundColor: c.surface0 }}><Text selectable style={[t.body, { fontFamily: mono }]}>{command}</Text></View>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>Allow runs it once. Deny stops it; write below what to do instead.</Text>
      <Button theme={theme} compact={compact} title="Deny" disabled={busy} onPress={() => onRespond({ behavior: "deny" })} />
      {extra.map(a => <Button key={a.id} theme={theme} compact={compact} title={a.label} disabled={busy} onPress={() => onRespond({ behavior: a.behavior, selectedActionId: a.id })} />)}
      <Button theme={theme} compact={compact} kind={primary ? "primary" : "secondary"} icon="Check" title="Allow" loading={busy} onPress={() => onRespond({ behavior: "allow" })} />
    </View>
  </View>;
}

/** The reply box. Sending is the developer writing to the agent, which clears Needs you (binding rule). */
function ReplyBox({ theme, compact, agentName, onSend, placeholder = "Answer in your own words", hint = "Sending clears Needs you. Sign off & next moves on without a reply.", focus = 0 }: { theme: Theme; compact: boolean; agentName: string; onSend: (text: string) => Promise<void>; placeholder?: string; hint?: string | null; focus?: number }) {
  const c = theme.colors;
  const inputRef = useRef<TextInput | null>(null);
  // Focus when asked to (⌘K), never on a plain mount. The closing command palette hands focus back to where it was,
  // after us, so keep claiming it for a moment until it sticks.
  useEffect(() => {
    if (!focus) return;
    const timers = [0, 150, 400, 800, 1400].map(ms => setTimeout(() => {
      const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
      const input = inputRef.current as unknown;
      if (!doc || doc.activeElement !== input) inputRef.current?.focus();
    }, ms));
    return () => timers.forEach(clearTimeout);
  }, [focus]);
  const toast = useToast();
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    try { await onSend(text); setValue(""); toast.show("Sent", { variant: "success" }); }
    catch (e) { toast.error(errorText(e)); } finally { setSending(false); }
  };
  return <View style={{ padding: compact ? 12 : 14, borderTopWidth: 1, borderTopColor: c.border, gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingLeft: 12, paddingRight: 6, paddingVertical: 6 }}>
      <TextInput ref={inputRef} accessibilityLabel={`Reply to ${agentName}`} value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} multiline
        onKeyPress={e => { const k = e.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean }; if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) void send(); }}
        style={{ flex: 1, minHeight: compact ? 44 : 36, maxHeight: 140, color: c.foreground, fontSize: 14, lineHeight: 20, paddingVertical: 6, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
      <IconButton theme={theme} compact={compact} icon="ArrowUp" label="Send" disabled={!value.trim() || sending} spinning={sending} onPress={() => void send()} color={value.trim() ? c.foreground : undefined} />
    </View>
    {!!hint && <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{hint}</Text>}
  </View>;
}

// ---------- brief pane ----------

function BriefPane({ theme, compact, pane, onSelect, openLog, sources }: { theme: Theme; compact: boolean; pane: ReturnType<typeof briefPane>; onSelect: (key: string) => void; openLog: () => void; sources: HomeSources }) {
  const c = theme.colors; const t = text(c);
  useTick(30_000);
  const now = Date.now();
  const offline = sources.inbox.offlineSince();
  const observed = sources.live.all().flatMap(w => w.prs.map(p => p.snapshot?.observedAt).filter((x): x is string => !!x)).sort().at(-1) ?? null;
  const date = new Date(now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const section = (title: string, right?: React.ReactNode) => <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
    <Text accessibilityRole="header" style={[t.small, { flex: 1, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>{title}</Text>{right}
  </View>;
  const dot = (ok: boolean) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? c.statusSuccess : c.statusWarning }} />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 22, gap: 10 }}>
    <Text style={t.meta}>{date} · {time}</Text>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: compact ? 19 : 21, lineHeight: compact ? 26 : 29, fontWeight: "600", letterSpacing: -0.2 }}>{pane.headline}</Text>
    {pane.first && <Button theme={theme} compact={compact} kind="primary" icon="ArrowRight" title={`Open ${pane.first.title.length > 40 ? `${pane.first.title.slice(0, 40)}…` : pane.first.title}`} onPress={() => onSelect(pane.first!.key)} />}
    {!!pane.waiting && <Text style={t.body}><Text style={{ color: c.foregroundMuted }}>Waiting on others: </Text>{pane.waiting}</Text>}
    <Text style={t.body}><Text style={{ color: c.foregroundMuted }}>Cleared since {sinceLabel(now)}: </Text>{pane.cleared ?? "nothing yet"}.</Text>

    {section("Done while you were away", <Pressable accessibilityRole="link" onPress={openLog} hitSlop={8}><Text style={[t.small, { color: c.foreground }]}>{pane.away.count} · log</Text></Pressable>)}
    {pane.away.top.length ? pane.away.top.map(l => <LogRow key={l.key} l={l} c={c} />) : <Text style={t.meta}>Follow-up didn't act on its own since {sinceLabel(now)}.</Text>}
    <Text style={t.meta}>No merges, no messages to people. Those stay yours.</Text>

    {section("Sources")}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{dot(offline === null)}<Text style={t.meta}>Paseo {offline === null ? "live" : `offline ${age(new Date(offline).toISOString(), now)}`}</Text></View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{dot(!!observed && now - Date.parse(observed) < 15 * 60_000)}<Text style={t.meta}>GitHub {observed ? age(observed, now) : "no PRs yet"}</Text></View>
    </View>
  </ScrollView>;
}

function LogRow({ l, c, onOpen }: { l: LogLine; c: Colors; onOpen?: () => void }) {
  const t = text(c);
  const tone = l.tone === "success" ? c.statusSuccess : l.tone === "danger" ? c.statusDanger : l.tone === "warning" ? c.statusWarning : l.tone === "merged" ? mergedColor(c) : c.foregroundMuted;
  return <Pressable accessibilityRole={onOpen ? "button" : "text"} disabled={!onOpen} onPress={onOpen} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 3 }}>
    <View style={{ paddingTop: 2 }}><Icon name={l.icon} size={13} color={tone} /></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={t.body}>{l.text} <Text style={{ color: c.foregroundMuted }}>· {l.workspaceTitle}</Text></Text>
      {!!l.detail && <Text numberOfLines={2} style={t.meta}>{l.detail}{l.took ? ` · took ${l.took}` : ""}</Text>}
    </View>
    <Age iso={l.at} c={c} />
  </Pressable>;
}

/** "Done while you were away": only what Follow-up did on its own. What it left for the developer is on Home. */
function LogView({ theme, compact, sources, onHome, onOpen }: { theme: Theme; compact: boolean; sources: HomeSources; onHome: () => void; onOpen: (key: string) => void }) {
  const c = theme.colors; const t = text(c);
  const version = useSyncExternalStore(sources.live.subscribe, sources.live.version, sources.live.version);
  const [days, setDays] = useState(0);
  const since = useMemo(() => days ? Date.now() - days * 86_400_000 : lastWorkdayEnd(Date.now()), [days]);
  const lines = useMemo(() => followUpLog(sources.live.all(), since), [version, since, sources.live]);
  const needs = sources.inbox.rows().filter(r => r.needs && !r.snooze).length;
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 28, gap: 12, maxWidth: 820, width: "100%", alignSelf: "center" }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Button theme={theme} compact={compact} kind="ghost" icon="House" title="Home" onPress={onHome} />
    </View>
    <Text accessibilityRole="header" style={[t.title, { fontSize: 20, lineHeight: 26 }]}>Done while you were away</Text>
    <Text style={t.meta}>What Follow-up did on its own {days ? `in the last ${days} days` : `since ${sinceLabel(Date.now())}`}: repairs it sent and how they went. It never merges, messages people, starts or archives workspaces.</Text>
    <Pressable accessibilityRole="button" onPress={onHome} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, backgroundColor: c.surface1 }}>
      <Icon name="Inbox" size={14} color={needs ? c.statusWarning : c.foregroundMuted} />
      <Text style={[t.body, { flex: 1 }]}>{needs ? `${needs} thing${needs === 1 ? "" : "s"} it left for you are on Home.` : "Nothing is waiting for you on Home."}</Text>
      <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
    </Pressable>
    {lines.length ? lines.map(l => <LogRow key={l.key} l={l} c={c} onOpen={() => onOpen(`agent:${l.agentId}`)} />) : <Text style={t.meta}>Nothing in this window.</Text>}
    {!days && <Button theme={theme} compact={compact} kind="ghost" title="Show the last 7 days" onPress={() => setDays(7)} />}
  </ScrollView>;
}
