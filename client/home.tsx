import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { browserKey, BROWSER_POLL_MS } from "./keys";
import { Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { browserStatusRpc, inboxBriefRpc } from "../shared/contracts";
import { needsYou } from "../shared/attention";
import { briefPane, followUpLog, lastWorkdayEnd, nextNeeds, paneButtons, sameText, sinceLabel, tailSteps, type HomeGroupId, type HomeModel, type LogLine, type TailStep, type Workstream } from "../shared/home";
import { age, snoozeUntil, type InboxRow } from "../shared/inbox";
import { errorText } from "../shared/errors";
import { isLoaded, type LoadSignals } from "../shared/agent-load";
import { BriefCard, type BriefDeps } from "./brief";
import { SummaryLine } from "./about";
import { bottomGap, bottomInset, Button, IconButton, space, text, type Theme } from "./kit";
import { NeedsYouList } from "./needs-you";
import { PrSheet } from "./pr-sheet";
import { QuestionSheet } from "./questions";
import { Age, BadgeView, BRIEF_KEY, glyphColor, HomeList, OVERSEER_KEY, PrChipView, PrSummaryText, type OverseerRowState } from "./home-list";
import { answerLine, overseerRowState } from "../shared/overseer";
import type { OmniboxItem } from "../shared/search";
import { ListTop, SearchField, SortMenu, StatusStrip, UsageMeters, useOmnibox, useSlashToFocus } from "./home-chrome";
import { useHomeModel, useTick, type HomeSources } from "./home-data";
import { laterLabel, useInbox, UndoBar, useNextRelay } from "./inbox";
import { Spinner } from "./motion";
import { Setup, SetupOffer, useOnboarding } from "./onboarding";
import type { OnboardingView } from "../shared/onboarding";
import { withAlpha, isLight, mergedColor, type Colors } from "./theme";
import { UpdateNotice } from "./updates";
import { ReleaseNotesSheet, VersionLine, WhatsNewGate } from "./release-notes";
import { useRowMenu } from "./row-actions";
import { laterChoices } from "../shared/row-menu";
import { RichText } from "./rich-text";

export const HOME_SCREEN = "follow-through";

const mono = Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace";

export type HomeDeps = {
  sources: HomeSources;
  /** Follow-up's settings, on a category when given (the setup flow's deep links). */
  openSettings(category?: string): void;
  /** Docks the workspace's own panel in its explorer column. */
  openPanel(workspaceId: string): void;
  openLog(): void;
  openHome(): void;
  /** Phones: open one Home item as its own screen, so the host's ← (and Android back) returns to the list. */
  openItem?(key: string, extra?: { question?: string }): void;
  briefDeps: BriefDeps;
};

/**
 * Home (design §2–§6): every workstream on the left, the selected one on the right, answered in place.
 * With nothing selected the right side is the brief. `?view=log` shows what Follow-up did on its own.
 */
export function FollowHome(props: PluginScreenProps & { deps: HomeDeps }) {
  // Getting started takes Home's place on a fresh install (or after "Set up Follow-up again") until finished or skipped.
  const onboarding = useOnboarding();
  // Opened from "Set up again": read the flow's state afresh.
  const { refetch } = onboarding;
  useEffect(() => { if (props.params?.setup) void refetch(); }, [props.params?.setup, refetch]);
  if (onboarding.data?.show) return <Setup theme={props.theme} compact={props.layout.compact} view={onboarding.data} deps={{ openSettings: props.deps.openSettings }} />;
  return <HomeBody {...props} onboarding={onboarding.data} />;
}

function HomeBody(props: PluginScreenProps & { deps: HomeDeps; onboarding: OnboardingView | undefined }) {
  const { theme, layout, navigation, params = {}, deps } = props;
  const { inbox } = deps.sources;
  const c = theme.colors;
  const compact = layout.compact;
  const model = useHomeModel(deps.sources);
  const omnibox = useOmnibox(model, deps.sources);
  useSlashToFocus(omnibox, params.view !== "log");
  const [filter, setFilter] = useState<HomeGroupId | null>(null);
  const [selected, setSelected] = useState<string | null>(() => params.item ?? (params.select ? `agent:${params.select}` : null));
  const openAgentRow = useMemo(() => navigation ? (row: InboxRow) => navigation.openAgent({ agentId: row.agentId }) : undefined, [navigation]);
  useNextRelay(inbox, params, openAgentRow);
  useEffect(() => { if (params.select) setSelected(`agent:${params.select}`); }, [params.select]);
  // Phones show one thing at a time. A row opens its own screen (pushed by the host) instead of swapping in place, so the
  // host's ← is the only back control and it lands on the list. Desktop selects in place beside the list.
  const route = compact && deps.openItem ? deps.openItem : null;
  const onSelect = useCallback((key: string) => { if (route) route(key); else setSelected(key === BRIEF_KEY ? null : key); }, [route]);
  const current = selected ? model.byKey.get(selected) ?? (selected.startsWith("agent:") ? [...model.byKey.values()].find(x => x.agentId === selected.slice(6)) ?? null : null) : null;
  const tracked = useSyncExternalStore(deps.sources.live.subscribe, deps.sources.live.version, deps.sources.live.version);
  const rows = useInbox(inbox, () => inbox.rows());
  const pane = useMemo(() => briefPane({ model, rows, tracked: deps.sources.live.all(), now: Date.now() }), [model, rows, tracked, deps.sources.live]);
  const rank = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.rank, deps.sources.extras.rank);
  const overseerStatus = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.overseer, deps.sources.extras.overseer);
  const overseerInbox = useInbox(inbox, () => inbox.overseer());
  const overseer = overseerRowState(overseerStatus, overseerInbox);
  const toast = useToast();
  // The omnibox's "Ask the Overseer" row: send, then show the conversation it lands in.
  const [asking, setAsking] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const pick = useCallback(async (item: OmniboxItem) => {
    if (item.ask === undefined) { if (route) route(item.key); else setSelected(item.key); return; }
    if (asking) return;
    setAsking(true);
    // No toast: the conversation opens on the sent words, which says it more plainly.
    try { await deps.sources.extras.askOverseer(item.ask); omnibox.setQuery(""); omnibox.inputRef.current?.blur(); setPendingAsk(item.ask); if (route) route(OVERSEER_KEY); else setSelected(OVERSEER_KEY); inbox.refresh(); }
    catch (e) { toast.error(errorText(e)); } finally { setAsking(false); }
  }, [asking, deps.sources.extras, omnibox, inbox, toast, route]);
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
  // The row menu's Answer: select the row (phones: open its screen) with that question's card open.
  const [ask, setAsk] = useState<{ key: string; id: string; n: number } | null>(() => params.question && params.item ? { key: params.item, id: params.question, n: 1 } : null);
  const openQuestion = useCallback((s: Workstream, id: string) => {
    if (route) { deps.openItem?.(s.key, { question: id }); return; }
    setSelected(s.key); setAsk(a => ({ key: s.key, id, n: (a?.n ?? 0) + 1 }));
  }, [route, deps]);
  const omniRef = useRef(omnibox); omniRef.current = omnibox;
  const prefillAsk = useCallback((text: string) => { omniRef.current.setQuery(text); setTimeout(() => omniRef.current.inputRef.current?.focus(), 0); }, []);
  const rowMenu = useRowMenu({ sources: deps.sources, openFull, openQuestion, prefillAsk, overseerOn: !!overseerStatus?.enabled });
  const signOffNext = useCallback((s: Workstream) => {
    if (s.agentId) void inbox.signOff([s.agentId]);
    const next = nextNeeds(model, s.key);
    setSelected(next?.key ?? null);
  }, [inbox, model]);

  // null: closed; false: What's new since the previous version; true: every version.
  const [notesOpen, setNotesOpen] = useState<boolean | null>(null);
  const updateNotice = <UpdateNotice theme={theme} compact={compact} openSettings={deps.openSettings} />;
  const updatesFooter = <VersionLine theme={theme} compact={compact} onOpen={setNotesOpen} />;
  const updateSheets = <>
    <WhatsNewGate surface="home" theme={theme} compact={compact} />
    {notesOpen != null && <ReleaseNotesSheet theme={theme} compact={compact} all={notesOpen} onClose={() => setNotesOpen(null)} />}
  </>;
  if (params.view === "log") return <LogView theme={theme} compact={compact} sources={deps.sources} onHome={deps.openHome} onOpen={key => { setSelected(key); deps.openHome(); }} />;

  const detail = selected === OVERSEER_KEY && overseer
    ? <OverseerPane theme={theme} compact={compact} o={overseer} focus={replyFocus} pending={pendingAsk} agentId={overseerStatus?.agentId ?? null} model={overseerStatus?.model ?? null} restartWith={overseerStatus?.restartWith ?? null} configured={overseerStatus?.configured ?? null} deps={deps} navigation={navigation} onBack={compact && !route ? () => setSelected(null) : undefined} />
    : current
    ? <DetailPane key={current.key} s={current} model={model} theme={theme} compact={compact} deps={deps} openFull={openFull} signOffNext={signOffNext} ask={ask?.key === current.key ? ask : null} onBack={compact && !route ? () => setSelected(null) : undefined} />
    : <BriefPane theme={theme} compact={compact} pane={pane} onSelect={key => route ? route(key) : setSelected(key)} openLog={deps.openLog} sources={deps.sources} />;
  // Nothing followed at all: no sort, no meters, just the empty state and its action.
  const nothing = model.groups.every(g => !g.items.length);
  const list = <HomeList model={model} theme={theme} dense={compact} touch={compact} selectedKey={selected} onSelect={onSelect} briefLine={briefLine}
    results={omnibox.results} activeResult={omnibox.active} onResult={item => void pick(item)} filter={filter} overseer={overseer} asking={asking} menu={rowMenu}
    // Phones: the host header already says Follow-up, so no "Home" title row; search, sort and settings share one row and
    // the meters move to the end of the list.
    footer={omnibox.results ? undefined : compact
      ? <View style={{ paddingTop: 16, paddingBottom: 96, gap: 12 }}>{!nothing && <UsageMeters theme={theme} sources={deps.sources} dense />}{updatesFooter}</View>
      : updatesFooter}
    // Phones: the setup offer goes after the Needs-you group when there is one, so the first ask stays high.
    afterNeeds={compact && model.needs > 0 ? <SetupOffer theme={theme} compact view={props.onboarding} /> : undefined}
    emptyAction={compact ? <Button theme={theme} compact kind="secondary" icon="Settings" title="Project settings" onPress={deps.openSettings} /> : undefined}
    top={<ListTop theme={theme} dense={compact} title={compact ? undefined : <ListHeader theme={theme} compact={compact} onSettings={deps.openSettings} />}>
      {/* zIndex: on web every View is its own stacking context, so the sort menu only paints and hit-tests above the
          strip and meters below if this row sits above them. */}
      <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", gap: compact ? 2 : 6, paddingLeft: compact ? 16 : 16, paddingRight: compact ? 6 : 16 }}>
        <SearchField theme={theme} omnibox={omnibox} dense={compact} onEnter={item => void pick(item)} />
        {!(compact && nothing) && <SortMenu theme={theme} mode={model.sort} onChange={deps.sources.extras.setSort} rankedAt={model.rankedAt} touch={compact} rank={rank} onRerank={deps.sources.extras.rankNow} />}
        {compact && <IconButton theme={theme} compact icon="Settings" label="Follow-up settings" onPress={deps.openSettings} />}
      </View>
      {!compact && !omnibox.results && <StatusStrip theme={theme} model={model} filter={filter} onFilter={setFilter} touch={compact} dense={compact} />}
      {!compact && !omnibox.results && <UsageMeters theme={theme} sources={deps.sources} dense={compact} />}
      {!compact && !omnibox.results && <SetupOffer theme={theme} compact={compact} view={props.onboarding} />}
    </ListTop>}
    // Phones: only the search row stays pinned; the status chips and the setup offer scroll away with the list, so a
    // scrolled list keeps the screen instead of sitting under a 250px block.
    header={omnibox.results ? undefined : compact ? <View style={{ gap: 8, paddingTop: 6, paddingBottom: 6 }}>
      <StatusStrip theme={theme} model={model} filter={filter} onFilter={setFilter} touch dense />
      {updateNotice}
      {model.needs === 0 && <SetupOffer theme={theme} compact view={props.onboarding} />}
    </View> : updateNotice} />;

  if (compact) return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {current || selected === OVERSEER_KEY && overseer || selected === BRIEF_KEY ? detail : list}
    {updateSheets}
    <View style={{ position: "absolute", left: 12, right: 12, bottom: bottomGap(true) + (current || selected === OVERSEER_KEY ? 132 : 0) }}><UndoBar store={inbox} theme={theme} touch /></View>
  </View>;
  return <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.surface0 }}>
    <View style={{ flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: c.border }}>
      {list}
      {updateSheets}
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

function DetailPane({ s, model, theme, compact, deps, openFull, signOffNext, ask, onBack }: {
  s: Workstream; model: HomeModel; theme: Theme; compact: boolean; deps: HomeDeps;
  openFull: (s: Workstream) => void; signOffNext: (s: Workstream) => void; onBack?: () => void;
  /** The row menu's Answer: open this question's card (n changes on every pick, so the same question reopens). */
  ask?: { id: string; n: number } | null;
}) {
  const c = theme.colors; const t = text(c, compact);
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
  const [question, setQuestion] = useState<string | null>(() => ask?.id ?? null);
  useEffect(() => { if (ask) setQuestion(ask.id); }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [laterOpen, setLaterOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const b = brief.data?.brief?.state === "open" ? brief.data.brief : null;
  const asks = w ? needsYou(w) : [];
  const items = asks.map(i => i.kind);
  // Say it once: when a Needs-you row already carries the row's line (a question's title or detail), skip the headline.
  const echoed = !!s.line && asks.some(i => sameText(i.title, s.line) || ("detail" in i && sameText(i.detail, s.line)));
  // Phones: one primary per screen. An actionable Needs-you item (Answer, Merge…) outranks Sign off.
  const itemFirst = compact && asks.length > 0;
  const [laterSheet, setLaterSheet] = useState(false);
  const [typing, setTyping] = useState(false);
  // A snoozed row keeps its moves: Sign off is a normal end for something put off, and Later changes the time.
  const flagged = !!row?.needs;
  const plan = paneButtons({ permissions: agent.permissions.length, decisions: !!b?.decisions.some(d => d.options.length), items, flagged, hasAgent: !!s.agentId });
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return; setBusy(key);
    try { await work(); if (done) toast.show(done, { variant: "success" }); inbox.refresh(); } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  const respond = (p: Permission, response: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) =>
    run(`perm:${p.id}`, () => agent.handle!.respondToPermission({ requestId: p.id, response: response as never }), response.behavior === "allow" ? "Allowed" : "Denied");
  const color = glyphColor(s, c, compact);

  const ago = s.at ? age(s.at, Date.now()) : "";
  const metaRest = [ago === "now" ? "just now" : ago, s.project].filter(Boolean).join(" · ");
  // Phones: the host header already says Follow-up and carries ←. The pane head is the full-width title, then one meta
  // line (state, age, project, PRs as text) that ellipsizes instead of wrapping, with Open full as an icon at its end.
  const header = compact ? <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 2, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Text accessibilityRole="header" numberOfLines={3} style={t.title}>{s.title}</Text>
    {/* The Summary: what this workspace is for, right under its name. */}
    {s.workspaceId && w && <View style={{ marginTop: 4 }}><SummaryLine key={s.workspaceId} workspace={w} theme={theme} compact /></View>}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }}>
      <Icon name={s.icon} size={14} color={color} />
      <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>
        {!!s.word && <Text style={{ color, fontWeight: "600" }}>{s.word}</Text>}
        {metaRest ? (s.word ? ` · ${metaRest}` : metaRest) : ""}
        <PrSummaryText s={s} c={c} lead=" · " />
      </Text>
      <IconButton theme={theme} compact icon="PanelRightOpen" label="Open full" onPress={() => openFull(s)} />
    </View>
  </View> : <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {onBack && <IconButton theme={theme} compact icon="ChevronLeft" label="Back to Home" onPress={onBack} />}
      <Icon name={s.icon} size={16} color={color} />
      <Text accessibilityRole="header" numberOfLines={2} style={[t.title, { flex: 1, fontSize: 16 }]}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      <Button theme={theme} compact={compact} icon="PanelRightOpen" title="Open full" accessibilityHint="Opens the agent's chat and docks this list beside it" onPress={() => openFull(s)} />
    </View>
    {s.workspaceId && w && <SummaryLine key={s.workspaceId} workspace={w} theme={theme} compact={false} />}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {!!s.word && <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{s.word}</Text>}
      <Text style={t.meta}>{[s.at ? age(s.at, Date.now()) === "now" ? "just now" : `${age(s.at, Date.now())} ago` : "", s.project].filter(Boolean).join(" · ")}</Text>
      {s.badges.map(x => <BadgeView key={x.text} b={x} c={c} />)}
      <PrChipView s={s} c={c} />
    </View>
  </View>;

  const canMove = plan.buttons.includes("sign_off") || plan.buttons.includes("later");
  const actionBar = !compact && (plan.buttons.includes("sign_off") || plan.buttons.includes("later")) && <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button theme={theme} compact={compact} kind={plan.primary === "sign_off" ? "primary" : "secondary"} icon="Check" title="Sign off" loading={busy === "sign_off"}
        onPress={() => void run("sign_off", () => inbox.signOff([s.agentId!]))} />
      <Button theme={theme} compact={compact} icon="ArrowRight" title="Sign off & next" onPress={() => signOffNext(s)} />
      <Button theme={theme} compact={compact} icon="AlarmClock" title="Later…" onPress={() => setLaterOpen(v => !v)} />
    </View>
    {laterOpen && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {laterChoices(new Date()).map(([k, label]) =>
        <Button key={k} theme={theme} compact={compact} kind="ghost" title={label} onPress={() => { setLaterOpen(false); void inbox.snooze([s.agentId!], snoozeUntil(k, new Date())); }} />)}
    </View>}
  </View>;

  // A snoozed row says when it comes back and offers Bring back now, on every width.
  const snoozedLine = !!row?.needs && !!row.snooze && <View accessibilityLabel={`Later, ${laterLabel(row.snooze.until, Date.now())}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
    <Icon name="AlarmClock" size={14} color={c.foregroundMuted} />
    <Text style={t.meta}>Later {laterLabel(row.snooze.until, Date.now())}</Text>
    <Button theme={theme} compact={compact} kind="secondary" icon="BellRing" title="Bring back now" loading={busy === "bring_back"}
      onPress={() => void run("bring_back", () => inbox.unsnooze([s.agentId!]))} />
  </View>;

  const laterTimes = laterChoices(new Date());
  // Phones: the moves sit in the dock above the composer, in thumb reach, on one row: Sign off, Sign off & next, Later.
  const narrow = useWindowDimensions().width < 380;
  const moves = compact && canMove && !typing && <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
    <View style={{ flex: 1 }}><Button theme={theme} compact grow kind={plan.primary === "sign_off" && !itemFirst ? "primary" : "secondary"} icon={narrow ? undefined : "Check"} title="Sign off" loading={busy === "sign_off"}
      onPress={() => void run("sign_off", () => inbox.signOff([s.agentId!]))} /></View>
    <View style={{ flex: 1.3 }}><Button theme={theme} compact grow icon={narrow ? undefined : "ArrowRight"} title="Sign off & next" onPress={() => signOffNext(s)} /></View>
    <IconButton theme={theme} compact icon="AlarmClock" label="Later…" onPress={() => setLaterSheet(true)} />
  </View>;
  const laterModal = compact && <Modal title="Remind me later" open={laterSheet} onOpenChange={setLaterSheet}>
    <Modal.Content contentContainerStyle={{ paddingVertical: 8 }}>
      {laterTimes.map(([k, label]) => <Pressable key={k} accessibilityRole="button" onPress={() => { setLaterSheet(false); void inbox.snooze([s.agentId!], snoozeUntil(k, new Date())); }}
        style={({ pressed }) => ({ minHeight: 48, justifyContent: "center", paddingHorizontal: 16, backgroundColor: pressed ? c.surface2 : "transparent" })}>
        <Text style={t.body}>{label}</Text>
      </Pressable>)}
    </Modal.Content>
  </Modal>;

  const steps = s.agentId && <View style={{ gap: 8 }}>
    {/* Phones: an unloaded agent is one row, label and why on the left, a quiet Load on the right. */}
    {compact && tail.asleep && !tail.steps?.length && !tail.error ? <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 }}>
      <Icon name="History" size={16} color={c.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={t.label}>Recent steps</Text>
        <Text style={t.meta}>{tail.seenAt ? `Last seen ${age(new Date(tail.seenAt).toISOString(), Date.now())} ago. ` : ""}Not loaded. Loading keeps it in memory for about an hour.</Text>
      </View>
      <Button theme={theme} compact kind="ghost" title={tail.loading ? "Loading…" : "Load"} accessibilityLabel="Load recent steps" accessibilityHint="Loads the agent into memory for about an hour" loading={tail.loading} disabled={tail.loading} onPress={tail.load} />
    </View> : <>
      <Text style={compact ? t.section : [t.small, { fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>{tail.asleep && tail.seenAt ? `Last seen · ${age(new Date(tail.seenAt).toISOString(), Date.now()) === "now" ? "just now" : `${age(new Date(tail.seenAt).toISOString(), Date.now())} ago`}` : tail.steps?.length ? `Recent · last ${tail.steps.length} steps` : "Recent steps"}</Text>
      {!!tail.error && <Text style={t.meta}>{`Couldn't load the agent's steps: ${tail.error}`}</Text>}
      {tail.steps === null ? <Spinner color={c.foregroundMuted} size={12} label="Loading the agent's steps" />
        : tail.steps.length === 0 ? (tail.error ? null : <Text style={t.meta}>{tail.asleep ? "This agent isn't loaded, so its steps aren't shown." : "No steps yet."}</Text>)
        : tail.steps.map((step, i) => <Step key={i} step={step} c={c} last={i === tail.steps!.length - 1} />)}
      {(tail.asleep || (tail.woken && tail.loading)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Button theme={theme} compact={compact} kind="secondary" title={tail.loading ? "Loading…" : "Load recent steps"} loading={tail.loading} disabled={tail.loading} onPress={tail.load} />
        <Text style={[t.small, { flex: 1, minWidth: 160 }]}>Loads the agent into memory for about an hour.</Text>
      </View>}
      {!compact && !!tail.steps?.length && <Text style={t.small}>A preview, not the whole session. Open full for the chat.</Text>}
    </>}
  </View>;
  // "No ask stated" only repeats the chat; the panel already hides it, and on a phone it's dead weight above the ask.
  const showBrief = b && s.agentId && !(b.kind === "permission" && agent.permissions.length) && !(compact && b.source === "none");

  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {header}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 20, gap: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      {agent.permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={busy === `perm:${p.id}`} primary={plan.primary === "allow"} onRespond={r => void respond(p, r)} />)}
      {showBrief ? <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} />
        : echoed || (b && compact && b.source === "none" && asks.length) ? null
        : row?.needs && !agent.permissions.length && !b ? <Text style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{s.line || s.word || "Needs you"}</Text>
        : !row?.needs && s.line ? <Text style={t.body}>{s.line}</Text> : null}
      {w && <NeedsYouList workspace={w} theme={theme} compact={compact} flush skip={b?.decisions.length ? ["question"] : []} feature={compact}
        actions={{ openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion, openAgent: () => openFull(s) }} />}
      {actionBar}
      {snoozedLine}
      {steps}
    </ScrollView>
    {s.agentId && <View style={[{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0 }, bottomInset(compact)]}>
      {moves}
      <ReplyBox theme={theme} compact={compact} agentName={s.title} placeholder={compact ? "Reply to the agent" : undefined} onFocusChange={setTyping} onSend={async text => {
        await agent.handle!.send(text);
        inbox.refresh();
      }} />
    </View>}
    {laterModal}
    {w && sheet && <PrSheet workspace={w} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
    {w && <QuestionSheet workspace={w} questionId={question} theme={theme} compact={compact} onClose={() => setQuestion(null)} />}
  </View>;
}

/**
 * The Overseer's conversation on Home (1.4.0-beta.0): the tail and a reply box, like any agent's detail pane, plus its
 * decision card when it asks which agent should get a task. Before the first start, one Start button.
 */
function OverseerPane({ theme, compact, o, focus = 0, pending = null, agentId, model, restartWith, configured, deps, navigation, onBack }: { theme: Theme; compact: boolean; o: OverseerRowState; focus?: number; pending?: string | null; agentId: string | null; model: string | null; restartWith: string | null; configured: string | null; deps: HomeDeps; navigation: PluginScreenProps["navigation"]; onBack?: () => void }) {
  const c = theme.colors; const t = text(c, compact);
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
  const restartRow = agentId && restartWith && (compact
    // Phones: one row, the why on the left and a short Restart on the right; the full target is the a11y label.
    ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={2} style={[t.meta, { flex: 1, minWidth: 0 }]}>{`Settings say ${short(restartWith)}`}</Text>
      <Button theme={theme} compact icon="RefreshCw" title="Restart" accessibilityLabel={`Restart with ${short(restartWith)}`} accessibilityHint={`Starts a new Overseer on ${restartWith} and hands it the recent conversation`} loading={restarting} onPress={() => void restart()} />
    </View>
    : <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 6 }}>
      <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>{`Running ${model ?? "its first model"} · Settings say ${restartWith}`}</Text>
      <Button theme={theme} compact={compact} icon="RefreshCw" title={`Restart with ${short(restartWith)}`} accessibilityHint={`Starts a new Overseer on ${restartWith} and hands it the recent conversation`} loading={restarting} onPress={() => void restart()} />
    </View>);
  const header = compact ? <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 2, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Text accessibilityRole="header" style={t.title}>Overseer</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }}>
      <Icon name="MessagesSquare" size={14} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{model ?? configured ?? "Not started"}</Text>
      {agentId && navigation && <IconButton theme={theme} compact icon="PanelRightOpen" label="Open full" onPress={() => navigation.openAgent({ agentId })} />}
    </View>
    {restartRow}
  </View> : <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: c.border }}>
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
    {restartRow}
  </View>;
  if (o.state === "start") return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {header}
    <ScrollView contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12 }}>
      <Text style={compact ? t.body : [t.body, { fontSize: 15, lineHeight: 22 }]}>One agent that knows every workspace's state. Tell it "the PRs look good, assign reviewers on all" or "tell the SCIM agent to use option B", and it finds the right agent and passes it on.</Text>
      <Text style={t.meta}>It never merges, posts to people or archives. It starts a new workspace only when you say so.{compact ? " It works in its own workspace, which stays off your lists." : ` It runs on ${configured ?? "Claude · Newest Opus"} in its own workspace, which stays off your lists.`} Change the model in Follow-up settings → Agents.</Text>
      <View style={{ flexDirection: "row" }}><Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Play" title="Start the Overseer" loading={starting} onPress={() => void start()} /></View>
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
    {agentId && <View style={[{ borderTopWidth: 1, borderTopColor: c.border }, bottomInset(compact)]}>
      <ReplyBox theme={theme} compact={compact} agentName="the Overseer" placeholder={compact ? "Ask or give a task" : "Ask or give a task: “assign reviewers on all ready PRs”"} hint={null} focus={focus}
        onSend={async message => { await agent.handle!.send(message); inbox.refresh(); }} />
    </View>}
  </View>;
}

/** "Codex · GPT-6-Luna · low" → "GPT-6-Luna · low": the button already says it's the Overseer's provider change. */
const short = (summary: string) => summary.split(" · ").slice(1).join(" · ") || summary;

function Step({ step, c, last }: { step: TailStep; c: Colors; last: boolean }) {
  const t = text(c);
  if (step.kind === "tool") return <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
    <Icon name="Terminal" size={13} color={step.failed ? c.statusDanger : c.foregroundMuted} />
    <RichText plain numberOfLines={1} style={[t.meta, { flex: 1, fontFamily: mono }]}>{step.text}</RichText>
  </View>;
  if (step.kind === "you") return <View style={{ padding: 10, borderRadius: 8, backgroundColor: c.surface1, gap: 3 }}>
    <Text style={t.small}>You</Text><RichText numberOfLines={3} style={t.body}>{answerLine(step.text) ?? step.text}</RichText>
  </View>;
  if (step.kind === "error") return <RichText numberOfLines={4} style={[t.body, { color: c.statusDanger }]}>{step.text}</RichText>;
  return <RichText selectable numberOfLines={last ? 40 : 4} style={[t.body, { lineHeight: 19 }]}>{step.text.replace(/\*\*/g, "")}</RichText>;
}

function permissionText(p: Permission): string {
  const d = p.detail ?? {};
  const v = [d.command, d.filePath, d.path, d.url, p.input?.command, p.input?.file_path].find(x => typeof x === "string" && x.trim());
  return typeof v === "string" ? v : p.description ?? "";
}

function PermissionBlock({ p, theme, compact, busy, primary, onRespond }: { p: Permission; theme: Theme; compact: boolean; busy: boolean; primary: boolean; onRespond: (r: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const command = permissionText(p);
  // Provider-defined choices ("Always for this session") show as extra secondaries; Allow and Deny always exist.
  const extra = (p.actions ?? []).filter(a => !/^(allow|deny|reject)$/i.test(a.label.trim()));
  return <View accessibilityRole="alert" style={{ padding: 14, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.5), backgroundColor: withAlpha(c.statusWarning, isLight(c) ? 0.06 : 0.08) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ShieldQuestion" size={15} color={c.statusWarning} />
      <Text style={[t.label, { color: c.statusWarning, flex: 1 }]}>{p.title || `Wants to use ${p.name}`}</Text>
    </View>
    {!!command && <View style={{ padding: 10, borderRadius: 7, backgroundColor: c.surface0 }}><Text selectable style={[t.body, { fontFamily: mono }]}>{command}</Text></View>}
    {compact ? <>
      <Text style={t.meta}>Allow runs it once. Deny stops it; reply below with what to do instead.</Text>
      {extra.map(a => <Button key={a.id} theme={theme} compact grow title={a.label} disabled={busy} onPress={() => onRespond({ behavior: a.behavior, selectedActionId: a.id })} />)}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Button theme={theme} compact grow title="Deny" disabled={busy} onPress={() => onRespond({ behavior: "deny" })} /></View>
        <View style={{ flex: 1 }}><Button theme={theme} compact grow kind={primary ? "primary" : "secondary"} icon="Check" title="Allow" loading={busy} onPress={() => onRespond({ behavior: "allow" })} /></View>
      </View>
    </> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>Allow runs it once. Deny stops it; write below what to do instead.</Text>
      <Button theme={theme} compact={compact} title="Deny" disabled={busy} onPress={() => onRespond({ behavior: "deny" })} />
      {extra.map(a => <Button key={a.id} theme={theme} compact={compact} title={a.label} disabled={busy} onPress={() => onRespond({ behavior: a.behavior, selectedActionId: a.id })} />)}
      <Button theme={theme} compact={compact} kind={primary ? "primary" : "secondary"} icon="Check" title="Allow" loading={busy} onPress={() => onRespond({ behavior: "allow" })} />
    </View>}
  </View>;
}

/** The reply box. Sending is the developer writing to the agent, which clears Needs you (binding rule). */
const REPLY_HINT = "Sending clears Needs you. Sign off & next moves on without a reply.";
function ReplyBox({ theme, compact, agentName, onSend, placeholder = "Answer in your own words", hint = REPLY_HINT, focus = 0, onFocusChange, docked = true }: { theme: Theme; compact: boolean; agentName: string; onSend: (text: string) => Promise<void>; placeholder?: string; hint?: string | null; focus?: number; onFocusChange?: (focused: boolean) => void; docked?: boolean }) {
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
  // Phones: a 48-tall box (46 + hairline) with the placeholder on one centred line; it grows as you type.
  // In a dock (the detail pane), the dock draws the hairline; on its own it draws one. Phones keep the hint as the
  // input's accessibility hint instead of small print under it, where it collided with the gesture bar.
  return <View style={{ padding: compact ? 12 : 14, gap: 6, ...(docked ? {} : { borderTopWidth: 1, borderTopColor: c.border }) }}>
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, borderRadius: compact ? 12 : 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingLeft: 12, paddingRight: compact ? 1 : 6, paddingVertical: compact ? 0 : 6 }}>
      <TextInput ref={inputRef} accessibilityLabel={`Reply to ${agentName}`} accessibilityHint={compact && hint ? hint : undefined} onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)} value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} multiline
        numberOfLines={compact ? 1 : undefined}
        onKeyPress={e => { const k = e.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean }; if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) void send(); }}
        style={{ flex: 1, minHeight: compact ? 46 : 36, maxHeight: 140, color: c.foreground, fontSize: 14, lineHeight: 20, paddingVertical: compact ? 13 : 6, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
      <IconButton theme={theme} compact={compact} icon="ArrowUp" label="Send" disabled={!value.trim() || sending} spinning={sending} onPress={() => void send()} color={value.trim() ? c.foreground : undefined} />
    </View>
    {!!hint && !compact && <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{hint}</Text>}
  </View>;
}

// ---------- brief pane ----------

function BriefPane({ theme, compact, pane, onSelect, openLog, sources }: { theme: Theme; compact: boolean; pane: ReturnType<typeof briefPane>; onSelect: (key: string) => void; openLog: () => void; sources: HomeSources }) {
  const c = theme.colors; const t = text(c, compact);
  useTick(30_000);
  const now = Date.now();
  const offline = sources.inbox.offlineSince();
  const observed = sources.live.all().flatMap(w => w.prs.map(p => p.snapshot?.observedAt).filter((x): x is string => !!x)).sort().at(-1) ?? null;
  const date = new Date(now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const section = (title: string, right?: React.ReactNode) => <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
    <Text accessibilityRole="header" style={[t.section, { flex: 1 }]}>{title}</Text>{right}
  </View>;
  const dot = (ok: boolean) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? c.statusSuccess : c.statusWarning }} />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 22, gap: 10 }}>
    {/* Phones: the headline leads and the date sits under it; desktop keeps the date as an eyebrow. */}
    {!compact && <Text style={t.meta}>{date} · {time}</Text>}
    <Text accessibilityRole="header" style={t.headline}>{pane.headline}</Text>
    {compact && <Text style={t.meta}>Morning brief · {date} · {time}</Text>}
    {pane.first && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="ArrowRight" title={`Open ${pane.first.title.length > 40 ? `${pane.first.title.slice(0, 40)}…` : pane.first.title}`} onPress={() => onSelect(pane.first!.key)} />}
    {!!pane.waiting && <Text style={t.body}><Text style={{ color: c.foregroundMuted }}>Waiting on others: </Text>{pane.waiting}</Text>}
    <Text style={t.body}><Text style={{ color: c.foregroundMuted }}>Cleared since {sinceLabel(now)}: </Text>{pane.cleared ?? "nothing yet"}.</Text>

    {/* Phones: the section head is itself a 44 row into the log ("· N · View log ›"), not a tiny "0 · log" link. With
        nothing done, one muted line says so instead of a header, an empty log and the same "since" twice. */}
    {compact && !pane.away.count
      ? <Text style={[t.meta, { marginTop: 6 }]}>Nothing done on its own since {sinceLabel(now)} · no merges, no messages to people.</Text>
      : compact
      ? <Pressable accessibilityRole="link" accessibilityLabel={`Done while you were away: ${pane.away.count}. View log`} onPress={openLog}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, marginTop: 6, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 8, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
        <Text accessibilityRole="header" numberOfLines={1} style={[t.section, { flexShrink: 1 }]}>Done while you were away · {pane.away.count}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[t.meta, { color: c.foreground }]}>View log</Text>
        <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
      </Pressable>
      : section("Done while you were away", <Pressable accessibilityRole="link" onPress={openLog} hitSlop={8}><Text style={[t.small, { color: c.foreground }]}>{pane.away.count} · log</Text></Pressable>)}
    {!(compact && !pane.away.count) && <>
      {pane.away.top.length ? pane.away.top.map(l => <LogRow key={l.key} l={l} c={c} />) : <Text style={t.meta}>Follow-up didn't act on its own since {sinceLabel(now)}.</Text>}
      <Text style={t.meta}>No merges, no messages to people. Those stay yours.</Text>
    </>}

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
      {!!l.detail && <RichText plain numberOfLines={2} style={t.meta}>{`${l.detail}${l.took ? ` · took ${l.took}` : ""}`}</RichText>}
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
