import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePagedList } from "./paged-list";
import { browserKey } from "./keys";
import { Platform, TextInput, useWindowDimensions, View } from "react-native";
import { AttachImageButton, ImageAttachmentsRow, ImageField, useImageAttachments } from "./image-attach";
import { imageTargetKey, type ImageTarget } from "../shared/images";
import { dropUnsent, keepUnsent, OVERSEER_ASK_KEY, unsent } from "./unsent-images";
import { Pressable, Text } from "./text";
import { usePaseo, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { browserStatusRpc, controlRpc, inboxBriefRpc, sendRpc } from "../shared/contracts";
import { needsYou, workspaceSnoozed } from "../shared/attention";
import { briefAsks, briefCardShown, liveBrief } from "../shared/brief";
import { briefPane, followUpLog, lastWorkdayEnd, nextNeeds, paneButtons, prChipSpoken, sameText, sinceLabel, tailSteps, type HomeGroupId, type HomeModel, type LogLine, type TailStep, type Workstream } from "../shared/home";
import { age, backLabel, snoozeUntil, type InboxRow } from "../shared/inbox";
import { errorText } from "../shared/errors";
import { isLoaded, type LoadSignals } from "../shared/agent-load";
import { prLinksByNumber } from "../shared/presentation";
import { BriefCard, type BriefDeps } from "./brief";
import { SummaryLine } from "./about";
import { ReferencesLine } from "./linked";
import { WhyItMatters } from "./why-it-matters";
import { bottomGap, bottomInset, Button, focusSoon, IconButton, space, text, type Theme } from "./kit";
import { DispatchRows, NewHost, openNew, useNewOpen } from "./new";
import { NobodyRows, QueueScreen, SinceBlock } from "./brief-since";
import type { NewKey } from "./search-key";
import { DockedPane } from "./docked-pane";
import type { DockState } from "./dock";
import { NeedsYouBlock } from "./needs-you";
import { YourQuestionsCard, useWorkspaceRunning } from "./your-questions";
import { HeldMerges } from "./merge-button";
import { PrSheet } from "./pr-sheet";
import { StatsPage, type StatsParams } from "./pr-stats";
import { QuestionSheet } from "./questions";
import { isDoneOnly } from "../shared/questions";
import { DismissReveal } from "./dismiss";
import { Age, BadgeView, BRIEF_KEY, glyphColor, HomeList, OVERSEER_KEY, PrChipView, PrSummaryText, type OverseerRowState } from "./home-list";
import { answerLine, overseerRowState } from "../shared/overseer";
import type { OmniboxItem } from "../shared/search";
import { LayoutNotice, ListTop, SearchField, SortMenu, StatusStrip, UsageMeters, useOmnibox, useSlashToFocus } from "./home-chrome";
import { useHomeModel, useTick, type HomeSources } from "./home-data";
import { laterLabel, useInbox, UndoBar, useNextRelay } from "./inbox";
import { Spinner } from "./motion";
import { Setup, SetupOffer, useOnboarding } from "./onboarding";
import { FinishSetupLine, SetupGate } from "./setup-gate";
import { reopenSetup, setupClosed } from "./setup-ui";
import { finishSetupLine } from "../shared/setup-popup";
import type { OnboardingView } from "../shared/onboarding";
import { withAlpha, isLight, mergedColor, type Colors } from "./theme";
import { UpdateNotice, VersionMark } from "./updates";
import { WhatsNewGate } from "./release-notes";
import { ViewSync, useViewVersion } from "./view-store";
import { CatchUp, CatchUpButton, KeysSheet } from "./catch-up";
import { searchEnter } from "../shared/list-keys";
import { HOME_KEYS } from "../shared/home-keys";
import { deckCards } from "../shared/catch-up";
import { questionsByWorkspace } from "../shared/your-questions";
import { ResizableSplit } from "./split";
import { PeekHost } from "./turn-view";
import { useMarkTimelineOnScreen } from "./on-screen";
import type { SearchKey } from "./search-key";

import { displayPreferences, displayRpc, writeDisplay, HOME_DETAIL_DEFAULT, HOME_DETAIL_MAX, HOME_DETAIL_MIN, type DisplayClient } from "../shared/display";
import { subscribeDisplay } from "./display";
import { useRowMenu } from "./row-actions";
import { laterChoices } from "../shared/row-menu";
import { PrLinksProvider, RichText } from "./rich-text";
import { TOAST_ANCHOR, ToastHost, useQuestionOpener } from "./toasts";
import { openRowCopy, useDetailGate, useWorkspace } from "./workspace-data";
import type { ListWorkspace } from "../shared/list";
import { NEW_NAME } from "../shared/new-name";

/** Home without a search key (tests, older wiring): no subscription, no label. */
const noSubscribe = () => () => undefined;
const noLabel = () => null;

export const HOME_SCREEN = "follow-up";

const mono = Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace";

export type HomeDeps = {
  sources: HomeSources;
  /** Follow-up's settings, on a category when given (the setup flow's deep links). */
  openSettings(category?: string): void;
  /** Docks the workspace's own panel in its explorer column. */
  openPanel(workspaceId: string): void;
  openLog(): void;
  /** The Morning brief's Linear queue screen (`?view=queue`, client/brief-since.tsx). */
  openQueue?(): void;
  /** Catch up: Needs you one card at a time (`?view=catchup`). */
  openCatchUp?(): void;
  /** The PR stats page (`?view=stats`, docs/pr-stats.md#the-page); a phone's person opens as its own screen. */
  openStats?(params?: StatsParams): void;
  openHome(): void;
  /** Phones: open one Home item as its own screen, so the host's ← (and Android back) returns to the list. */
  openItem?(key: string, extra?: { question?: string }): void;
  briefDeps: BriefDeps;
  /** The search-from-anywhere key (client/search-key.ts), for the search field's chip. */
  searchKey?: SearchKey;
  /** New from anywhere's key, for Home's + New tooltip. */
  newKey?: NewKey;
};

/**
 * Home (design §2–§6): every workstream on the left, the selected one on the right, answered in place.
 * With nothing selected the right side is the brief. `?view=log` shows what Follow-up did on its own.
 */
/** The pane's Sign off, where focus goes after Bring back now. */
const PANE_PRIMARY = "follow-up-pane-primary";

export function FollowHome(props: PluginScreenProps & { deps: HomeDeps }) {
  // Setup is a popup over Home (setup-is-one-popup): Home keeps only its Finish setup line once Close puts it away.
  const onboarding = useOnboarding();
  // Opened from "Set up again": read the flow's state afresh.
  const { refetch } = onboarding;
  useEffect(() => { if (props.params?.setup) { reopenSetup(); void refetch(); } }, [props.params?.setup, refetch]);
  return <>
    <HomeBody {...props} onboarding={onboarding.data} />
    <SetupGate surface="home" theme={props.theme} compact={props.layout.compact} deps={{ openSettings: props.deps.openSettings, openHome: props.deps.openHome }} />
  </>;
}

function HomeBody(props: PluginScreenProps & { deps: HomeDeps; onboarding: OnboardingView | undefined }) {
  const { theme, layout, navigation, params = {}, deps } = props;
  const { inbox } = deps.sources;
  const c = theme.colors;
  const compact = layout.compact;
  // "Nobody's on it" (raised issues, urgent Compass asks) are Needs-you items with no workspace row. The worker sends
  // them on the home feed; the model counts them (model.raised) and they head the group. Catch up's deck and
  // model.needs stay workspaces.
  const model = useHomeModel(deps.sources);
  // The setup row: an existing install's offer, or Finish setup once Close has put setup's popup away.
  useViewVersion();
  const setupRow = !!props.onboarding?.offer || !!finishSetupLine(props.onboarding, setupClosed());
  const queue = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.queue, deps.sources.extras.queue);
  const raisedKeys = useMemo(() => new Set(queue.needs.map(r => r.key)), [queue.needs]);
  const omnibox = useOmnibox(model, deps.sources);
  const searchKey = deps.searchKey;
  const anywhereKey = useSyncExternalStore(searchKey?.subscribe ?? noSubscribe, searchKey?.label ?? noLabel, searchKey?.label ?? noLabel);
  useSlashToFocus(omnibox, params.view !== "log" && params.view !== "catchup" && params.view !== "stats" && params.view !== "queue");
  const [filter, setFilter] = useState<HomeGroupId | null>(null);
  const [selected, setSelected] = useState<string | null>(() => params.item ?? (params.select ? `agent:${params.select}` : null));
  const openAgentRow = useMemo(() => navigation ? (row: InboxRow) => navigation.openAgent({ agentId: row.agentId }) : undefined, [navigation]);
  // A created-workspace card in chat: open that workspace, then dock its Follow-up panel (the same steps as openFull).
  const openWorkspaceRelay = useMemo(() => navigation ? (workspaceId: string) => {
    navigation.openWorkspace({ workspaceId });
    if (compact) deps.openPanel(workspaceId); else setTimeout(() => deps.openPanel(workspaceId), 900);
  } : undefined, [navigation, compact, deps]);
  const archivedIds = useCallback(() => new Set(deps.sources.live.archived().map(w => w.id)), [deps.sources.live]);
  useNextRelay(inbox, params, openAgentRow, openWorkspaceRelay, archivedIds);
  useEffect(() => { if (params.select) setSelected(`agent:${params.select}`); }, [params.select]);
  // An already-open Home asked to show an item (the sidebar view's Overseer row: Start and Restart live here). `at` makes
  // the same item twice a second request.
  useEffect(() => { if (params.item && params.at) setSelected(params.item); }, [params.item, params.at]);
  // Phones show one thing at a time. A row opens its own screen (pushed by the host) instead of swapping in place, so the
  // host's ← is the only back control and it lands on the list. Desktop selects in place beside the list.
  const route = compact && deps.openItem ? deps.openItem : null;
  const onSelect = useCallback((key: string) => { if (route) route(key); else setSelected(key === BRIEF_KEY ? null : key); }, [route]);
  // A key names a row (`ws:…`, an agent row) or, from a ⌘K or chat link, an agent (`agent:<id>`): one lookup for both.
  const resolve = (key: string | null) => key ? model.byKey.get(key) ?? (key.startsWith("agent:") ? [...model.byKey.values()].find(x => x.agentId === key.slice(6)) ?? null : null) : null;
  const current = resolve(selected);
  const tracked = useSyncExternalStore(deps.sources.live.subscribe, deps.sources.live.version, deps.sources.live.version);
  const rows = useInbox(inbox, () => inbox.rows());
  // Go through's count is its cards (one per ask), the same deck the mode opens on.
  // Your questions: each unread answer is a card too (shared deckCards), so the button counts what Catch up deals.
  const questions = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.context, deps.sources.extras.context);
  const deckSize = useMemo(() => { const unread = questionsByWorkspace(questions); return deckCards({ model, rows, items: id => { const w = deps.sources.live.get(id); return w ? needsYou(w as never) : []; }, answers: id => unread.get(id)?.unread ?? [] }).length; }, [model, rows, tracked, deps.sources.live, questions]);
  const pane = useMemo(() => briefPane({ model, rows, tracked: deps.sources.live.all(), now: Date.now() }), [model, rows, tracked, deps.sources.live]);
  const rank = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.rank, deps.sources.extras.rank);
  const overseerStatus = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.overseer, deps.sources.extras.overseer);
  const prStatsOn = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.prStatsOn, deps.sources.extras.prStatsOn);
  const openStats = prStatsOn && deps.openStats ? () => deps.openStats!() : undefined;
  const overseerInbox = useInbox(inbox, () => inbox.overseer());
  const overseer = overseerRowState(overseerStatus, overseerInbox);
  const toast = useToast();
  // A Sending row's Send now: the developer's Send (follow.send), the same path as the Tasks strip's.
  const send = useRpc(sendRpc);
  const sendNow = useCallback(async (s: Workstream) => {
    if (!s.workspaceId || !s.sendNow) return;
    try {
      const after = await send({ workspaceId: s.workspaceId, batchId: s.sendNow.batchId });
      const b = after.batches.find(x => x.id === s.sendNow!.batchId);
      toast.show(!b || ["sent", "sending", "completed"].includes(b.state) ? `Sent to ${s.title}` : b.result || "Queued. It goes out when the main agent is free.", { variant: !b || ["sent", "sending", "completed"].includes(b.state) ? "success" : "info" });
    } catch (e) { toast.error(errorText(e)); } finally { deps.sources.live.refresh(); }
  }, [send, toast, deps.sources.live]);
  // The omnibox's "Ask the Overseer" row: send, then show the conversation it lands in.
  const [asking, setAsking] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  // Enter in the search (the-selected-workspace-opens-with-enter): the first press shows the result in the pane, a
  // press on the result already showing opens its chat, and with no query Enter opens what is selected.
  const openRef = useRef<(key: string) => void>(() => undefined);
  const selectedRef = useRef<string | null>(null); selectedRef.current = current?.key ?? selected;
  const pick = useCallback(async (picked: OmniboxItem | null) => {
    if (!route && (!picked || picked.ask === undefined)) {
      const move = searchEnter({ item: picked ? resolve(picked.key)?.key ?? picked.key : null, selected: selectedRef.current, query: omnibox.query });
      if (move === "open") { openRef.current(picked?.key ?? selectedRef.current!); return; }
    }
    if (!picked) return;
    const item = picked;
    if (item.ask === undefined) { if (route) route(item.key); else setSelected(item.key); return; }
    if (asking) return;
    setAsking(true);
    // No toast: the conversation opens on the sent words, which says it more plainly.
    // Kept until Paseo takes the ask (client/unsent-images.ts): a failure leaves them on the search, and Home opened
    // again after it shows them there.
    const uploads = omnibox.images.uploads(); keepUnsent(OVERSEER_ASK_KEY, uploads);
    try { await deps.sources.extras.askOverseer(item.ask, uploads); dropUnsent(OVERSEER_ASK_KEY); omnibox.images.clear(); omnibox.setQuery(""); omnibox.inputRef.current?.blur(); setPendingAsk(item.ask); if (route) route(OVERSEER_KEY); else setSelected(OVERSEER_KEY); inbox.refresh(); }
    catch (e) { toast.error(errorText(e)); } finally { setAsking(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking, deps.sources.extras, omnibox, inbox, toast, route, model]);
  // ⌘K "Follow-up: Ask the Overseer" opens Home with `?ask=<nonce>`: select it and focus its reply box. A param, not
  // shared state, so it works whether Home was already open or mounts fresh.
  // New (client/new.tsx): every entry point opens Home with `?new=<nonce>` (and `source` when it carries one).
  // It never navigates again: the request already brought Home here (new-opens-where-you-are).
  useEffect(() => { if (params.new) openNew(params.source ? { source: params.source } : {}, { navigate: null }); }, [params.new]); // eslint-disable-line react-hooks/exhaustive-deps
  const newLabel = useSyncExternalStore(deps.newKey?.subscribe ?? noSubscribe, deps.newKey?.label ?? noLabel, deps.newKey?.label ?? noLabel);
  const dispatches = useSyncExternalStore(deps.sources.extras.subscribe, deps.sources.extras.dispatches, deps.sources.extras.dispatches);
  // New closing may have started one: without the feed, Home reads them then (home-view refreshDispatches).
  const newOpen = useNewOpen();
  const wasOpen = useRef(newOpen);
  useEffect(() => { if (wasOpen.current && !newOpen) deps.sources.extras.refreshDispatches(); wasOpen.current = newOpen; }, [newOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const dispatchRows = <DispatchRows records={dispatches} theme={theme} compact={compact} navigation={navigation} />;
  const newHost = <NewHost theme={theme} layout={layout} navigation={navigation} openSettings={() => deps.openSettings()} />;
  const [replyFocus, setReplyFocus] = useState(0);
  useEffect(() => {
    if (!params.ask) return;
    if (overseerStatus && !overseerStatus.enabled) { toast.show("The Overseer is off. Turn it on in Follow-up settings."); return; }
    setSelected(OVERSEER_KEY); setReplyFocus(n => n + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.ask]);
  const briefLine = [pane.counts.needs ? `${pane.counts.needs} need you` : "Nothing needs you", pane.counts.sending ? `${pane.counts.sending} sending` : "", pane.away.count ? `${pane.away.count} done while away` : "", queue.heard ?? ""].filter(Boolean).join(" · ");

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
  // Home's keys count anywhere on Home (the list and its detail), not just in the list.
  const homeRef = useRef<View>(null);
  const prefillAsk = useCallback((text: string) => { omniRef.current.setQuery(text); setTimeout(() => omniRef.current.inputRef.current?.focus(), 0); }, []);
  const rowMenu = useRowMenu({ sources: deps.sources, openFull, openQuestion, prefillAsk, overseerOn: !!overseerStatus?.enabled });
  const signOffNext = useCallback((s: Workstream) => {
    if (s.agentId) void inbox.signOff([s.agentId]);
    const next = nextNeeds(model, s.key);
    setSelected(next?.key ?? null);
  }, [inbox, model]);

  const updateNotice = <UpdateNotice theme={theme} compact={compact} openSettings={deps.openSettings} />;
  const updateSheets = <>
    <ViewSync />
    <WhatsNewGate surface="home" theme={theme} compact={compact} />
    <ToastHost theme={theme} compact={compact} />
  </>;
  if (params.view === "catchup") return <View style={{ flex: 1 }}>
    <CatchUp theme={theme} compact={compact} deps={{ sources: deps.sources, briefDeps: deps.briefDeps, openHome: deps.openHome, openPanel: deps.openPanel }} navigation={navigation as never} onExit={deps.openHome} />
    {updateSheets}
  </View>;
  if (params.view === "stats") return <View style={{ flex: 1 }}>
    <StatsPage key={params.n ?? "stats"} theme={theme} compact={compact} params={{ repo: params.repo, period: params.period, person: params.person, sort: params.sort }}
      deps={{ onHome: deps.openHome, openSettings: () => deps.openSettings("following"), openStats: p => deps.openStats?.(p) }} />
    {updateSheets}
  </View>;
  if (params.view === "queue") return <View style={{ flex: 1 }}>
    <QueueScreen theme={theme} compact={compact} onHome={deps.openHome} navigation={navigation} />
    {newHost}
    {updateSheets}
  </View>;
  if (params.view === "log") return <LogView theme={theme} compact={compact} sources={deps.sources} onHome={deps.openHome} onOpen={key => { setSelected(key); deps.openHome(); }} />;

  const detail = selected === OVERSEER_KEY && overseer
    ? <OverseerPane theme={theme} compact={compact} o={overseer} focus={replyFocus} pending={pendingAsk} agentId={overseerStatus?.agentId ?? null} model={overseerStatus?.model ?? null} restartWith={overseerStatus?.restartWith ?? null} configured={overseerStatus?.configured ?? null} deps={deps} navigation={navigation} onBack={compact && !route ? () => setSelected(null) : undefined} />
    : current
    ? <DetailPane key={current.key} s={current} model={model} theme={theme} compact={compact} deps={deps} openFull={openFull} signOffNext={signOffNext} ask={ask?.key === current.key ? ask : null} onBack={compact && !route ? () => setSelected(null) : undefined} openAgent={navigation ? agentId => navigation.openAgent({ agentId }) : undefined} />
    : <BriefPane theme={theme} compact={compact} pane={pane} catchUp={deps.openCatchUp} deckSize={deckSize} onSelect={key => route ? route(key) : setSelected(key)} openLog={deps.openLog} sources={deps.sources}
      queue={deps.openQueue ? <SinceBlock theme={theme} compact={compact} openQueue={deps.openQueue} onStarted={() => deps.sources.extras.refreshDispatches()} navigation={navigation} raised={raisedKeys} revision={queue.revision} /> : null} />;
  // Nothing followed at all: no sort, no meters, just the empty state and its action.
  const nothing = model.groups.every(g => !g.items.length);
  // Enter on a row: its chat, as Open full does. The brief has nothing to open; the Overseer opens once it runs.
  const openKey = (key: string) => {
    if (key === OVERSEER_KEY) { const id = overseerStatus?.agentId; if (id && navigation) navigation.openAgent({ agentId: id }); return; }
    const s = resolve(key); if (s) openFull(s);
  };
  openRef.current = openKey;
  // S: Home's keys (desktop web), from the one list (shared/home-keys.ts).
  const [keysOpen, setKeysOpen] = useState(false);
  const list = <HomeList model={model} theme={theme} dense={compact} touch={compact} selectedKey={selected} onSelect={onSelect} briefLine={briefLine}
    keys={{ mode: "select", onOpen: openKey, onKeys: () => setKeysOpen(v => !v), scope: homeRef, claimBody: true }}
    results={omnibox.results} activeResult={omnibox.active} onResult={item => void pick(item)} filter={filter} overseer={overseer} asking={asking} menu={rowMenu} onSendNow={sendNow}
    // Phones: the host header already says Follow-up, so no "Home" title row; search, sort and settings share one row and
    // the meters move to the end of the list.
    footer={omnibox.results ? undefined : compact
      ? <View style={{ paddingTop: 16, paddingBottom: 96, gap: 12 }}>{!nothing && <UsageMeters theme={theme} sources={deps.sources} dense hold={!!model.hold} />}
        {/* Phones: the version is a muted caption at the end of the list, never in the strip (Q51: it hid chips). */}
        <View style={{ flexDirection: "row", paddingHorizontal: 6 }}><VersionMark theme={theme} touch openSettings={deps.openSettings} /></View></View>
      : undefined}
    // Phones: the setup offer goes after the Needs-you group when there is one, so the first ask stays high.
    raised={<NobodyRows theme={theme} compact={compact} data={queue} onDismissed={deps.sources.extras.refreshQueue} />}
    afterNeeds={compact && model.needs > 0 && setupRow ? <><SetupOffer theme={theme} compact view={props.onboarding} /><FinishSetupLine theme={theme} compact /></> : undefined}
    emptyAction={<Button theme={theme} compact={compact} kind="primary" icon="Plus" title={NEW_NAME} onPress={() => openNew()} />}
    top={<ListTop theme={theme} dense={compact} title={compact ? undefined : <ListHeader theme={theme} compact={compact} onSettings={deps.openSettings} onKeys={() => setKeysOpen(v => !v)} onStats={openStats} onNew={() => openNew()} newLabel={newLabel} />}>
      {/* zIndex: on web every View is its own stacking context, so the sort menu only paints and hit-tests above the
          strip and meters below if this row sits above them. */}
      <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", gap: compact ? 2 : 6, paddingLeft: compact ? 16 : 16, paddingRight: compact ? 6 : 16 }}>
        <SearchField theme={theme} omnibox={omnibox} dense={compact} onEnter={item => void pick(item)} anywhereKey={anywhereKey} />
        {compact && <IconButton theme={theme} compact icon="Plus" label={NEW_NAME} onPress={() => openNew()} />}
        {!(compact && nothing) && <SortMenu theme={theme} mode={model.sort} onChange={deps.sources.extras.setSort} rankedAt={model.rankedAt} touch={compact} rank={rank} onRerank={deps.sources.extras.rankNow} />}
        {compact && openStats && <IconButton theme={theme} compact icon="ChartNoAxesColumn" label="PR stats" onPress={openStats} />}
        {compact && <IconButton theme={theme} compact icon="Settings" label="Follow-up settings" onPress={deps.openSettings} />}
      </View>
      {/* Images pasted on the search ride the Overseer ask; their own line, so the search row stays one line. */}
      {(!!omnibox.images.images.length || !!omnibox.images.refusal) && <View style={{ paddingHorizontal: 16, gap: 4 }}>
        <ImageAttachmentsRow model={omnibox.images} theme={theme} compact={compact} />
        {!!omnibox.images.images.length && !omnibox.images.blocked && <Text style={text(theme.colors, compact).small}>{omnibox.query.trim() ? "Sent with your ask to the Overseer." : "Type your ask; these go with it to the Overseer."}</Text>}
      </View>}
      <View style={{ paddingHorizontal: 16 }}><LayoutNotice theme={theme} query={omnibox.layoutHint} dense={compact} /></View>
      {!omnibox.results && dispatchRows}
      {!compact && !omnibox.results && <StatusStrip theme={theme} model={model} filter={filter} onFilter={setFilter} touch={compact} dense={compact} />}
      {!compact && !omnibox.results && <UsageMeters theme={theme} sources={deps.sources} dense={compact} hold={!!model.hold} />}
      {!compact && !omnibox.results && <><SetupOffer theme={theme} compact={compact} view={props.onboarding} /><FinishSetupLine theme={theme} compact={compact} /></>}
    </ListTop>}
    // Phones: only the search row stays pinned; the status chips and the setup offer scroll away with the list, so a
    // scrolled list keeps the screen instead of sitting under a 250px block.
    header={omnibox.results ? undefined : compact ? <View style={{ gap: 8, paddingTop: 6, paddingBottom: 6 }}>
      {/* No title row on phones. The strip has the row to itself, so every chip is reachable (Q51: "Sending" pushed
          Waiting, Quiet and Later behind the version); the version is at the end of the list. */}
      <StatusStrip theme={theme} model={model} filter={filter} onFilter={setFilter} touch dense />
      {model.needs > 0 && deps.openCatchUp && <View style={{ paddingHorizontal: 16 }}><CatchUpButton theme={theme} compact count={deckSize} onPress={deps.openCatchUp} /></View>}
      {updateNotice}
      {model.needs === 0 && <><SetupOffer theme={theme} compact view={props.onboarding} /><FinishSetupLine theme={theme} compact /></>}
    </View> : updateNotice} />;

  if (compact) return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {current || selected === OVERSEER_KEY && overseer || selected === BRIEF_KEY ? detail : list}
    {updateSheets}
    <View style={{ position: "absolute", left: 12, right: 12, bottom: bottomGap(true) + (current || selected === OVERSEER_KEY ? 132 : 0) }}><UndoBar store={inbox} theme={theme} touch /></View>
    {newHost}
  </View>;
  return <View ref={homeRef} style={{ flex: 1, flexDirection: "row", backgroundColor: c.surface0 }}>
    {/* A row with an agent peeks at its turn beside it (client/turn-view.tsx), except the selected one: its pane shows it. */}
    <PeekHost where="main" theme={theme} compact={false} openAgent={navigation ? agentId => navigation.openAgent({ agentId }) : undefined} names={id => inbox.rows().find(r => r.agentId === id)?.title ?? "Agent"}>
    <HomeSplit theme={theme} detail={detail} main={<View style={{ flex: 1, minWidth: 0 }}>
      {list}
      {updateSheets}
      <View style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}><UndoBar store={inbox} theme={theme} touch={false} /></View>
    </View>} />
    </PeekHost>
    {keysOpen && <KeysSheet theme={theme} label="Home keys" keyWidth={104} onClose={() => setKeysOpen(false)} sections={[
      { title: "In the list", keys: HOME_KEYS.filter(k => !k.when) },
      { title: "In the search", keys: HOME_KEYS.filter(k => k.when === "search").map(k => k.key === "/" && anywhereKey ? { ...k, key: `/ or ${anywhereKey}` } : k) },
      { title: "Answering", keys: HOME_KEYS.filter(k => k.when === "pane") },
    ]} />}
    {newHost}
  </View>;
}

/**
 * Home's list beside its right pane (the brief, or the selected item), with the divider between them
 * (side-panes-are-resizable). The pane's share is the Display setting `home_detail_fraction`, so set_display reaches it.
 */
function HomeSplit({ theme, main, detail }: { theme: Theme; main: ReactNode; detail: ReactNode }) {
  return <DisplaySplit theme={theme} main={main} side={detail} field="home_detail_fraction" testID="follow-up-home-split" label="Resize the detail pane"
    defaultFraction={HOME_DETAIL_DEFAULT} range={[HOME_DETAIL_MIN, HOME_DETAIL_MAX]} minSide={HOME_DETAIL_MIN_PX} minMain={HOME_LIST_MIN_PX} />;
}

/** A resizable side pane whose share is a Display field (Home's detail pane, Catch up's queue rail). */
export function DisplaySplit({ theme, main, side, field, defaultFraction, range, minSide, minMain, label, testID }: {
  theme: Theme; main: ReactNode; side: ReactNode; field: "home_detail_fraction" | "catch_up_rail_fraction";
  defaultFraction: number; range: [number, number]; minSide: number; minMain: number; label: string; testID: string;
}) {
  const settings = useSettings(displayPreferences);
  const readDisplay = useRpc(displayRpc.read); const saveDisplay = useRpc(displayRpc.write);
  const toast = useToast();
  // The host's settings read paints first; the Display feed (an agent's set_display, another device) and this
  // device's own saves replace it. undefined = never set (the default); null = nothing pushed yet.
  const [pushed, setPushed] = useState<number | undefined | null>(null);
  useEffect(() => subscribeDisplay(values => setPushed(values[field])), [field]);
  const fraction = pushed !== null ? pushed : settings.status === "ready" ? settings.values[field] : undefined;
  const commit = (next: number) => {
    setPushed(next);
    const client: DisplayClient = { rpc: (contract, input) => (contract as unknown) === displayRpc.read ? readDisplay(input as never) : saveDisplay(input as never) };
    void writeDisplay(client, { [field]: next })
      .then(ok => { if (!ok) toast.error("Couldn't save the pane's width. It resets when this screen reopens."); })
      .catch(e => toast.error(errorText(e)));
  };
  return <ResizableSplit theme={theme} main={main} side={side} testID={testID} label={label}
    fraction={fraction} defaultFraction={defaultFraction} range={range} minSide={minSide} minMain={minMain} onCommit={commit} />;
}

/** The right pane is never narrower than this, and the list keeps at least HOME_LIST_MIN_PX (its rows keep their reason line). */
const HOME_DETAIL_MIN_PX = 360;
const HOME_LIST_MIN_PX = 480;

function ListHeader({ theme, compact, onSettings, onKeys, onStats, onNew, newLabel }: { theme: Theme; compact: boolean; onSettings: () => void; onKeys?: () => void; onStats?: () => void; onNew?: () => void; newLabel?: string | null }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 }}>
    {/* Home first, the version second: a muted caption on the title's line, never a control beside the cog. */}
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: compact ? 17 : 15, fontWeight: "600" }}>Home</Text>
      <VersionMark theme={theme} touch={compact} openSettings={onSettings} />
    </View>
    {/* New first, then the other header controls. */}
    {onNew && <Button theme={theme} compact={compact} kind="secondary" icon="Plus" title={NEW_NAME} keyHint={newLabel ?? undefined} accessibilityLabel={newLabel ? `${NEW_NAME} (${newLabel})` : `${NEW_NAME}`} onPress={onNew} />}
    {/* The keys sheet's way in for the mouse (S from the keyboard); desktop web, where the keys are. */}
    {onKeys && Platform.OS === "web" && <IconButton theme={theme} compact={compact} icon="Keyboard" label="Keys (S)" tooltip onPress={onKeys} />}
    {/* Shown once a repository has PR statistics (docs/pr-stats.md#where-it-opens-from). */}
    {onStats && <IconButton theme={theme} compact={compact} icon="ChartNoAxesColumn" label="PR stats" tooltip onPress={onStats} />}
    <IconButton theme={theme} compact={compact} icon="Settings" label="Follow-up settings" onPress={onSettings} />
  </View>;
}

// ---------- detail pane ----------

type Permission = { id: string; name: string; title?: string; description?: string; detail?: Record<string, unknown>; input?: Record<string, unknown>; actions?: { id: string; label: string; behavior: "allow" | "deny"; variant?: string }[] };

/** The selected agent's live state: pending permissions and status, from its own handle (never the whole list). */
export function useAgentLive(agentId: string | null) {
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

/**
 * Send now under a queued message's line in the detail pane: phones list Sending rows without it (dense rows), so this
 * is where a phone sends a waiting repair (a-repair-goes-to-a-free-main-agent). The same Send as the row's and the
 * Tasks strip's: taken while the main agent is busy, it goes the moment the main agent is free.
 */
function DetailSendNow({ s, theme, compact, deps }: { s: Workstream; theme: Theme; compact: boolean; deps: HomeDeps }) {
  const send = useRpc(sendRpc); const toast = useToast();
  const [busy, setBusy] = useState(false);
  const n = s.sendNow!.count;
  const press = async () => {
    if (!s.workspaceId || !s.sendNow) return;
    setBusy(true);
    try {
      const after = await send({ workspaceId: s.workspaceId, batchId: s.sendNow.batchId });
      const b = after.batches.find(x => x.id === s.sendNow!.batchId);
      const out = !b || ["sent", "sending", "completed"].includes(b.state);
      toast.show(out ? `Sent to ${s.title}` : b.result || "Queued. It goes out when the main agent is free.", { variant: out ? "success" : "info" });
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(false); deps.sources.live.refresh(); }
  };
  return <View style={{ flexDirection: "row" }}>
    <Button theme={theme} compact={compact} kind="secondary" title="Send now" accessibilityLabel={`Send ${s.sendNow!.what} to ${s.title} now`} loading={busy} disabled={busy} onPress={() => void press()} />
  </View>;
}

function DetailPane({ s, model, theme, compact, deps, openFull, signOffNext, ask, onBack, openAgent }: {
  s: Workstream; model: HomeModel; theme: Theme; compact: boolean; deps: HomeDeps;
  openFull: (s: Workstream) => void; signOffNext: (s: Workstream) => void; onBack?: () => void;
  /** Why it matters' Ask the Overseer opens the Overseer's chat with the draft in it. */
  openAgent?: (agentId: string) => void;
  /** The row menu's Answer: open this question's card (n changes on every pick, so the same question reopens). */
  ask?: { id: string; n: number } | null;
}) {
  const c = theme.colors; const t = text(c, compact);
  const toast = useToast();
  const { inbox, live } = deps.sources;
  const row = useInbox(inbox, () => s.agentId ? inbox.rows().find(r => r.agentId === s.agentId) ?? null : null);
  // The open row paints from the list form at once; its PR sheet and question sheet draw detail the list leaves out,
  // so they wait for the full workspace, read once (useWorkspace). Until it answers, the list form draws the rest.
  const { workspace: full, failure } = useWorkspace(live, s.workspaceId ?? "");
  const listed = useSyncExternalStore(live.subscribe, () => s.workspaceId ? live.get(s.workspaceId) : undefined, () => undefined);
  const w: ListWorkspace | undefined = openRowCopy<ListWorkspace>(listed, full);
  const agent = useAgentLive(s.agentId);
  // This pane draws the agent's Recent steps, so its row doesn't peek (shared/peek.ts timelineOnScreen).
  useMarkTimelineOnScreen(s.agentId);
  const readBrief = useRpc(inboxBriefRpc);
  const control = useRpc(controlRpc);
  const brief = useQuery({ queryKey: ["follow-up", "home-brief", s.agentId, row?.seq ?? 0], queryFn: () => readBrief({ agentId: s.agentId! }), enabled: !!s.agentId && !!row?.brief });
  const tail = useTail(agent.handle, `${row?.seq ?? 0}:${agent.status ?? ""}`);
  const browserRead = useRpc(browserStatusRpc);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), enabled: !!sheet, staleTime: 0, refetchOnMount: "always" });
  const [question, setQuestion] = useState<string | null>(() => ask?.id ?? null);
  useEffect(() => { if (ask) setQuestion(ask.id); }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useDetailGate(failure, !!sheet, () => setSheet(null));
  useDetailGate(failure, !!question, () => setQuestion(null));
  useQuestionOpener(w?.id, setQuestion);
  const [laterOpen, setLaterOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const b = liveBrief(brief.data?.brief);
  const asks = w ? needsYou(w) : [];
  const items = asks.map(i => i.kind);
  // Say it once: when a Needs-you row already carries the row's line (a question's title or detail), skip the headline.
  const echoed = !!s.line && asks.some(i => sameText(i.title, s.line) || ("detail" in i && sameText(i.detail, s.line)));
  // Phones: one primary per screen. An actionable Needs-you item (Answer, Merge…) outranks Sign off.
  const itemFirst = compact && asks.length > 0;
  const [laterSheet, setLaterSheet] = useState(false);
  // A snoozed row keeps its moves: Sign off is a normal end for something put off, and Later changes the time.
  const flagged = !!row?.needs;
  // one-done-button: while an action card waits here, Done tells the agent and Sign off doesn't, so Sign off yields:
  // never the primary, and the row's ✕ instead of a ✓ that would read as Done.
  const actionOpen = !!w && asks.some(i => i.kind === "question" && w.questions.some(q => q.id === i.questionId && isDoneOnly(q)));
  const signOffIcon = actionOpen ? "X" : "Check";
  const planned = paneButtons({ permissions: agent.permissions.length, decisions: !!b?.decisions.some(d => d.options.length), items, flagged, hasAgent: !!s.agentId });
  const plan = actionOpen && planned.primary === "sign_off" ? { ...planned, primary: "item" as const } : planned;
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return; setBusy(key);
    try { await work(); if (done) toast.show(done, { variant: "success" }); inbox.refresh(); } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  const respond = (p: Permission, response: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) =>
    run(`perm:${p.id}`, () => agent.handle!.respondToPermission({ requestId: p.id, response: response as never }), response.behavior === "allow" ? "Allowed" : "Denied");
  const color = glyphColor(s, c, compact);

  // A snoozed row says when it comes back and offers Bring back now, on every width.
  // The workspace's own Later (a workspace-only Needs-you row) reads the same and comes back the same way.
  const wsSnooze = !row?.needs && w && s.key === `ws:${w.id}` && w.snooze && workspaceSnoozed(w, asks, Date.now()) ? w.snooze : null;
  const later = row?.needs && row.snooze ? { until: row.snooze.until, back: () => inbox.unsnooze([s.agentId!]) }
    : wsSnooze && w ? { until: wsSnooze.until, back: async () => { await control({ workspaceId: w.id, snooze: null }); live.refresh(); } } : null;
  // Workspace Later under an agent flag: the agent's row shows, and the workspace's own items stay put off until their
  // time (the developer chose that; a new item still breaks it). Said in the pane so it isn't hidden (docs/needs-you.md).
  const wsUnder = row?.needs && w && w.snooze && s.key !== `ws:${w.id}` && workspaceSnoozed(w, asks, Date.now()) ? w.snooze : null;
  const laterText = later ? `Later ${laterLabel(later.until, Date.now())}` : "";
  const ago = s.at ? age(s.at, Date.now()) : "";
  const metaRest = [laterText, ago === "now" ? "just now" : ago, s.project].filter(Boolean).join(" · ");
  // Phones: the host header already says Follow-up and carries ←. The pane head is the full-width title, then one meta
  // line (state, age, project, PRs as text) that ellipsizes instead of wrapping, with Open full as an icon at its end.
  // While typing (DockedPane yields) the phone head keeps only the title, so the form gets the height.
  const header = ({ yields: writing }: DockState) => compact ? <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 2, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <Text accessibilityRole="header" numberOfLines={writing ? 1 : 3} style={t.title}>{s.title}</Text>
    {/* The Summary: what this workspace is for, right under its name. */}
    {!writing && s.workspaceId && w && <View style={{ marginTop: 4 }}><SummaryLine key={s.workspaceId} workspace={w} theme={theme} compact /></View>}
    {!writing && s.workspaceId && w && <View style={{ marginTop: 6 }}><ReferencesLine key={`refs:${s.workspaceId}`} workspace={w} theme={theme} compact /></View>}
    {!writing && s.workspaceId && w && <View style={{ marginTop: 6 }}><WhyItMatters key={`why:${s.workspaceId}`} workspace={w} theme={theme} compact openAgent={openAgent} /></View>}
    {!writing && <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }}>
      <Icon name={s.icon} size={14} color={color} />
      {/* Read as one line, with the PR summary in words: a nested Text can't carry its own label. */}
      <Text numberOfLines={1} accessibilityLabel={[s.word, metaRest, s.pr && prChipSpoken(s.pr)].filter(Boolean).join(" · ")} style={[t.meta, { flex: 1, minWidth: 0 }]}>
        {!!s.word && <Text style={{ color, fontWeight: "600" }}>{s.word}</Text>}
        {metaRest ? (s.word ? ` · ${metaRest}` : metaRest) : ""}
        <PrSummaryText s={s} c={c} lead=" · " />
      </Text>
      <IconButton theme={theme} compact icon="PanelRightOpen" label="Open full" onPress={() => openFull(s)} />
    </View>}
  </View> : <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {onBack && <IconButton theme={theme} compact icon="ChevronLeft" label="Back to Home" onPress={onBack} />}
      <Icon name={s.icon} size={16} color={color} />
      <Text accessibilityRole="header" numberOfLines={2} style={[t.title, { flex: 1, fontSize: 16 }]}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      <Button theme={theme} compact={compact} icon="PanelRightOpen" title="Open full" keyHint="↵" accessibilityHint="Opens the agent's chat and docks this list beside it (Enter)" onPress={() => openFull(s)} />
    </View>
    {s.workspaceId && w && <SummaryLine key={s.workspaceId} workspace={w} theme={theme} compact={false} />}
    {s.workspaceId && w && <ReferencesLine key={`refs:${s.workspaceId}`} workspace={w} theme={theme} compact={false} />}
    {s.workspaceId && w && <WhyItMatters key={`why:${s.workspaceId}`} workspace={w} theme={theme} compact={false} openAgent={openAgent} />}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {!!s.word && <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{s.word}</Text>}
      <Text style={t.meta}>{[laterText, s.at ? age(s.at, Date.now()) === "now" ? "just now" : `${age(s.at, Date.now())} ago` : "", s.project].filter(Boolean).join(" · ")}</Text>
      {s.badges.map(x => <BadgeView key={x.text} b={x} c={c} />)}
      <PrChipView s={s} c={c} />
    </View>
  </View>;

  const canMove = plan.buttons.includes("sign_off") || plan.buttons.includes("later");
  const actionBar = !compact && (plan.buttons.includes("sign_off") || plan.buttons.includes("later")) && <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button nativeID={PANE_PRIMARY} theme={theme} compact={compact} kind={plan.primary === "sign_off" ? "primary" : "secondary"} icon={signOffIcon} title="Sign off" loading={busy === "sign_off"}
        onPress={() => void run("sign_off", () => inbox.signOff([s.agentId!]))} />
      <Button theme={theme} compact={compact} icon="ArrowRight" title="Sign off & next" onPress={() => signOffNext(s)} />
      <Button theme={theme} compact={compact} icon="AlarmClock" title="Later…" onPress={() => setLaterOpen(v => !v)} />
    </View>
    {laterOpen && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {laterChoices(new Date()).map(([k, label]) =>
        <Button key={k} theme={theme} compact={compact} kind="ghost" title={label} onPress={() => { setLaterOpen(false); void inbox.snooze([s.agentId!], snoozeUntil(k, new Date())); }} />)}
    </View>}
  </View>;

  // Bring back now removes itself, so focus moves to the pane's first move (Sign off) once the row is back.
  // What's in Later here, one row each: this row's own Later, and (under an agent's flag) the workspace's own items.
  // The header already says "Later until …", so each row says when it's back and offers Bring back now with a name
  // that tells the two apart. Bring back removes its row, so focus moves to the pane's Sign off.
  const laterRows = [
    later && { key: "bring_back", who: wsUnder ? "This agent" : null, until: later.until, label: `Bring back ${s.title} now`, back: later.back },
    wsUnder && w && { key: "bring_back_ws", who: "Workspace items", until: wsUnder.until, label: `Bring back ${s.title}'s workspace items now`,
      back: async () => { await control({ workspaceId: w.id, snooze: null }); live.refresh(); } },
  ].filter(Boolean) as { key: string; who: string | null; until: string; label: string; back: () => Promise<unknown> }[];
  const laterBlock = laterRows.length > 0 && <View style={{ gap: compact ? 10 : 6 }}>
    {laterRows.map(r => <View key={r.key} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 6 }}>
      <Icon name="AlarmClock" size={14} color={c.foregroundMuted} />
      <Text style={[t.meta, { flexShrink: 1 }]}>{[r.who, backLabel(r.until, Date.now())].filter(Boolean).join(" · ")}</Text>
      <Button theme={theme} compact={compact} kind="secondary" icon="BellRing" title="Bring back now" accessibilityLabel={r.label} loading={busy === r.key}
        onPress={() => void run(r.key, async () => { await r.back(); focusSoon(PANE_PRIMARY); })} />
    </View>)}
  </View>;

  const laterTimes = laterChoices(new Date());
  // Phones: the moves sit in the dock above the composer, in thumb reach, on one row: Sign off, Sign off & next, Later.
  const narrow = useWindowDimensions().width < 380;
  // The dock's extras step aside while a field in the pane has focus (DockedPane, a-focused-field-and-its-send-stay-in-view).
  const moves = compact && canMove && <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
    <View style={{ flex: 1 }}><Button nativeID={PANE_PRIMARY} theme={theme} compact grow kind={plan.primary === "sign_off" && !itemFirst ? "primary" : "secondary"} icon={narrow ? undefined : signOffIcon} title="Sign off" loading={busy === "sign_off"}
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
        : <PrLinksProvider prs={w ? prLinksByNumber(w.prs) : undefined}>{tail.steps.map((step, i) => <Step key={i} step={step} c={c} last={i === tail.steps!.length - 1} />)}</PrLinksProvider>}
      {(tail.asleep || (tail.woken && tail.loading)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Button theme={theme} compact={compact} kind="secondary" title={tail.loading ? "Loading…" : "Load recent steps"} loading={tail.loading} disabled={tail.loading} onPress={tail.load} />
        <Text style={[t.small, { flex: 1, minWidth: 160 }]}>Loads the agent into memory for about an hour.</Text>
      </View>}
      {!compact && !!tail.steps?.length && <Text style={t.small}>A preview, not the whole session. Open full for the chat.</Text>}
    </>}
  </View>;
  // "No ask stated" only repeats the chat; the panel already hides it, and on a phone it's dead weight above the ask.
  // Nor beside a drawn Needs-you item (shared briefCardShown, a-brief-without-an-ask-never-sits-beside-needs-you).
  const showBrief = b && s.agentId && briefCardShown(b, row, asks.length) && !(b.kind === "permission" && agent.permissions.length) && !(compact && b.source === "none");
  // A flagged ask in a tracked workspace is part of its one Needs you block (shared/needs-block.ts): folded into the
  // question it points at, or the block's first section. In Later, or with no workspace, the card stays on its own.
  // Only a real ask joins it (shared briefAsks): a done brief on a row flagged for something else stays out of the count.
  const inBlock = !!w && !!showBrief && !later && briefAsks(b, row);

  const running = useWorkspaceRunning(deps.sources.paseo, w?.id ?? "");
  // Home's detail pane is the selected workspace: every x in it shows without hover (client/dismiss.tsx).
  return <DismissReveal.Provider value="always"><DockedPane compact={compact} header={header} style={{ backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 20, gap: 16, paddingBottom: 24 }}
    dock={({ yields, typingInContent }) => s.agentId && !typingInContent && <View nativeID={compact ? TOAST_ANCHOR : undefined} style={[{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0 }, bottomInset(compact)]}>
      {!yields && moves}
      <ReplyBox theme={theme} compact={compact} agentName={s.title} placeholder={compact ? "Reply to the agent" : undefined} target={{ kind: "agent", agentId: s.agentId }} onSend={async (text, images) => {
        await agent.handle!.send(text, images?.length ? { images } : undefined);
        inbox.refresh();
      }} />
    </View>}>
      {agent.permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={busy === `perm:${p.id}`} primary={plan.primary === "allow"} onRespond={r => void respond(p, r)} />)}
      {showBrief ? inBlock ? null : <BriefCard {...({ embedded: true, snoozed: !!later, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} />
        : echoed || (b && compact && b.source === "none" && asks.length) ? null
        : row?.needs && !agent.permissions.length && !b ? <Text style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{s.line || s.word || "Needs you"}</Text>
        : !row?.needs && s.line ? <Text style={t.body}>{s.line}</Text> : null}
      {!row?.needs && s.sendNow && <DetailSendNow s={s} theme={theme} compact={compact} deps={deps} />}
      {w && <NeedsYouBlock workspace={w} theme={theme} compact={compact} now={Date.now()} style={{ marginHorizontal: 0, marginTop: 0 }}
        brief={inBlock ? b : null} briefCard={inBlock && <BriefCard {...({ embedded: true, bare: true, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} />}
        actions={{ openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion, openAgent: () => openFull(s) }} />}
      {w && <YourQuestionsCard workspaceId={w.id} mainAgentId={w.mainAgentId} theme={theme} compact={compact} style={{ marginHorizontal: 0, marginTop: 0 }}
        openAgent={openAgent} running={running} foldAsk={compact && !!s.agentId} />}
      {w && <HeldMerges workspace={w} theme={theme} compact={compact} />}
      {actionBar}
      {laterBlock}
      {steps}
    </DockedPane>
    {laterModal}
    {full && sheet && <PrSheet workspace={full} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
    {full && <QuestionSheet workspace={full} questionId={question} theme={theme} compact={compact} onClose={() => setQuestion(null)} />}
  </DismissReveal.Provider>;
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
  useMarkTimelineOnScreen(agentId);
  const tail = useTail(agent.handle, `${row?.seq ?? 0}:${agent.status ?? ""}`, 8);
  const readBrief = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-up", "overseer-brief", agentId, row?.seq ?? 0], queryFn: () => readBrief({ agentId: agentId! }), enabled: !!agentId && !!row?.brief });
  const b = liveBrief(brief.data?.brief);
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
  return <DockedPane compact={compact} header={header} style={{ backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12, paddingBottom: 24 }}
    dock={({ typingInContent }) => agentId && !typingInContent && <View style={[{ borderTopWidth: 1, borderTopColor: c.border }, bottomInset(compact)]}>
      <ReplyBox theme={theme} compact={compact} agentName="the Overseer" placeholder={compact ? "Ask or give a task" : "Ask or give a task: “assign reviewers on all ready PRs”"} hint={null} focus={focus} target={{ kind: "overseer" }}
        onSend={async (message, images) => { await agent.handle!.send(message, images?.length ? { images } : undefined); inbox.refresh(); }} />
    </View>}>
      {o.state === "error" && <Text accessibilityRole="alert" style={[t.body, { color: c.statusDanger }]}>{o.line}</Text>}
      {tail.steps === null ? <Spinner color={c.foregroundMuted} size={12} label="Loading the conversation" />
        : tail.steps.length === 0 ? <Text style={t.meta}>{tail.error ? `Couldn't load the conversation: ${tail.error}` : "Nothing yet. Ask it what needs you, or give it a task for one of your agents."}</Text>
        : tail.steps.map((step, i) => <Step key={i} step={step} c={c} last={i === tail.steps!.length - 1} />)}
      {/* An ask just sent from the omnibox, until the conversation shows it. */}
      {pending && tail.steps && !tail.steps.some(x => x.kind === "you" && x.text.trim() === pending) && <Step step={{ kind: "you", text: pending }} c={c} last={false} />}
      {(o.state === "running" || pending && tail.steps && !tail.steps.some(x => x.kind === "you" && x.text.trim() === pending)) && <Spinner color={c.foregroundMuted} size={12} label="The Overseer is working" />}
      {/* Its open ask, after the conversation that led to it. Only something Tom can act on; never "No ask stated". */}
      {b && agentId && (b.kind === "decision" && b.decisions.some(d => d.options.length) || b.kind === "action") ? <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} /> : null}
  </DockedPane>;
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
  // Anyone but the developer (another agent, a child's finish, Follow-up's own send, an Overseer forward): outlined,
  // labelled by sender, never "You" and never the raw envelope (shared/message-sender.ts).
  if (step.kind === "message") return <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, gap: 3 }}>
    <Text numberOfLines={1} style={t.small}>{step.from}</Text><RichText numberOfLines={3} style={t.body}>{answerLine(step.text) ?? step.text}</RichText>
  </View>;
  if (step.kind === "error") return <RichText numberOfLines={4} style={[t.body, { color: c.statusDanger }]}>{step.text}</RichText>;
  return <RichText selectable numberOfLines={last ? 40 : 4} style={[t.body, { lineHeight: 19 }]}>{step.text.replace(/\*\*/g, "")}</RichText>;
}

function permissionText(p: Permission): string {
  const d = p.detail ?? {};
  const v = [d.command, d.filePath, d.path, d.url, p.input?.command, p.input?.file_path].find(x => typeof x === "string" && x.trim());
  return typeof v === "string" ? v : p.description ?? "";
}

/** `note`: the line under the command; null drops it (the peek has no reply box to point at). `flat`: no card of its own (inside the peek). */
export function PermissionBlock({ p, theme, compact, busy, primary, onRespond, note, flat }: { p: Permission; theme: Theme; compact: boolean; busy: boolean; primary: boolean; note?: string | null; flat?: boolean; onRespond: (r: { behavior: "allow" | "deny"; selectedActionId?: string; message?: string }) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const command = permissionText(p);
  // Provider-defined choices ("Always for this session") show as extra secondaries; Allow and Deny always exist.
  const extra = (p.actions ?? []).filter(a => !/^(allow|deny|reject)$/i.test(a.label.trim()));
  return <View accessibilityRole="alert" style={flat ? { gap: 8 } : { padding: 14, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.5), backgroundColor: withAlpha(c.statusWarning, isLight(c) ? 0.06 : 0.08) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ShieldQuestion" size={15} color={c.statusWarning} />
      <Text style={[t.label, { color: c.statusWarning, flex: 1 }]}>{p.title || `Wants to use ${p.name}`}</Text>
    </View>
    {!!command && <View style={{ padding: 10, borderRadius: 7, backgroundColor: flat ? c.surface2 : c.surface0 }}><Text selectable style={[t.body, { fontFamily: mono }, Platform.OS === "web" ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-all" } as object : null]}>{command}</Text></View>}
    {compact ? <>
      {note !== null && <Text style={t.meta}>{note ?? "Allow runs it once. Deny stops it; reply below with what to do instead."}</Text>}
      {extra.map(a => <Button key={a.id} theme={theme} compact grow title={a.label} disabled={busy} onPress={() => onRespond({ behavior: a.behavior, selectedActionId: a.id })} />)}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Button theme={theme} compact grow title="Deny" disabled={busy} onPress={() => onRespond({ behavior: "deny" })} /></View>
        <View style={{ flex: 1 }}><Button theme={theme} compact grow kind={primary ? "primary" : "secondary"} icon={primary ? "Check" : undefined} title="Allow" loading={busy} onPress={() => onRespond({ behavior: "allow" })} /></View>
      </View>
    </> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {note === null ? <View style={{ flex: 1 }} /> : <Text style={[t.meta, { flex: 1, minWidth: 180 }]}>{note ?? "Allow runs it once. Deny stops it; write below what to do instead."}</Text>}
      <Button theme={theme} compact={compact} title="Deny" disabled={busy} onPress={() => onRespond({ behavior: "deny" })} />
      {extra.map(a => <Button key={a.id} theme={theme} compact={compact} title={a.label} disabled={busy} onPress={() => onRespond({ behavior: a.behavior, selectedActionId: a.id })} />)}
      <Button theme={theme} compact={compact} kind={primary ? "primary" : "secondary"} icon={primary ? "Check" : undefined} title="Allow" loading={busy} onPress={() => onRespond({ behavior: "allow" })} />
    </View>}
  </View>;
}

/** The reply box. Sending is the developer writing to the agent, which clears Needs you (binding rule). */
const REPLY_HINT = "Sending clears Needs you. Sign off & next moves on without a reply.";
export function ReplyBox({ theme, compact, agentName, onSend, placeholder = "Answer in your own words", hint = REPLY_HINT, focus = 0, onFocusChange, docked = true, target }: { theme: Theme; compact: boolean; agentName: string;
  /** `images`: the pasted images (every-agent-field-takes-images), sent with the words through Paseo's own send. */
  onSend: (text: string, images?: { data: string; mimeType: string }[]) => Promise<void>; placeholder?: string; hint?: string | null; focus?: number; onFocusChange?: (focused: boolean) => void; docked?: boolean;
  /** Who reads it, so a recipient that can't take images says so before Send. */
  target: ImageTarget | null }) {
  const c = theme.colors;
  // A send under way keeps its words and images under the recipient's key until Paseo takes it (client/unsent-images.ts):
  // after a failure the box shows them again, even if it was closed and opened again, and Send sends them again.
  const keep = target ? `reply:${imageTargetKey(target)}` : undefined;
  const img = useImageAttachments({ target, keep });
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
  const [value, setValue] = useState(() => (keep && unsent(keep)?.text) || "");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = value.trim();
    if (!text || sending || img.blocked) return;
    setSending(true);
    const uploads = img.uploads();
    if (keep) keepUnsent(keep, uploads, value);
    const images = uploads?.map(i => ({ data: i.data, mimeType: i.mimeType }));
    try { await onSend(text, images); if (keep) dropUnsent(keep); setValue(""); img.clear(); toast.show("Sent", { variant: "success" }); }
    catch (e) { toast.error(`${errorText(e)}${images?.length ? ` Your ${images.length === 1 ? "image is" : "images are"} still attached.` : ""}`); } finally { setSending(false); }
  };
  // Phones: a 48-tall box (46 + hairline) with the placeholder on one centred line; it grows as you type.
  // In a dock (the detail pane), the dock draws the hairline; on its own it draws one. Phones keep the hint as the
  // input's accessibility hint instead of small print under it, where it collided with the gesture bar.
  return <View style={{ padding: compact ? 12 : 14, gap: 6, ...(docked ? {} : { borderTopWidth: 1, borderTopColor: c.border }) }}>
    {/* The images sit inside the composer, above the words, so they read as part of the message Send sends. */}
    <ImageField model={img} theme={theme} compact={compact} row={false} attach="inline">
    <View style={{ borderRadius: compact ? 12 : 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    {(!!img.images.length || !!img.refusal) && <View style={{ paddingHorizontal: 12, paddingTop: 10 }}><ImageAttachmentsRow model={img} theme={theme} compact={compact} /></View>}
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 12, paddingRight: compact ? 1 : 6, paddingVertical: compact ? 0 : 6 }}>
      <TextInput ref={inputRef} accessibilityLabel={`Reply to ${agentName}`} accessibilityHint={compact && hint ? hint : undefined} onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)} value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} multiline
        numberOfLines={compact ? 1 : undefined}
        onKeyPress={e => { const k = e.nativeEvent as unknown as { key: string; metaKey?: boolean; ctrlKey?: boolean }; if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) void send(); }}
        style={{ flex: 1, minHeight: compact ? 46 : 36, maxHeight: 140, color: c.foreground, fontSize: 14, lineHeight: 20, paddingVertical: compact ? 13 : 6, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
      <AttachImageButton model={img} theme={theme} compact={compact} />
      <IconButton theme={theme} compact={compact} icon="ArrowUp" label="Send" disabled={!value.trim() || sending || !!img.blocked} spinning={sending} onPress={() => void send()} color={value.trim() && !img.blocked ? c.foreground : undefined} />
    </View>
    </View>
    </ImageField>
    {!!hint && !compact && <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{hint}</Text>}
  </View>;
}

// ---------- brief pane ----------

function BriefPane({ theme, compact, pane, onSelect, openLog, sources, catchUp, deckSize = 0, queue = null }: { theme: Theme; compact: boolean; pane: ReturnType<typeof briefPane>; onSelect: (key: string) => void; openLog: () => void; sources: HomeSources; catchUp?: () => void; deckSize?: number; queue?: ReactNode }) {
  const c = theme.colors; const t = text(c, compact);
  useTick(30_000);
  const now = Date.now();
  const offline = sources.inbox.offlineSince();
  // works-without-github: the worker sets githubOff on every workspace with PRs while GitHub is off.
  const githubOff = sources.live.all().find(w => w.githubOff)?.githubOff ?? null;
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
    {catchUp && deckSize > 0 ? <CatchUpButton theme={theme} compact={compact} count={deckSize} onPress={catchUp} /> : pane.first && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="ArrowRight" title={`Open ${pane.first.title.length > 40 ? `${pane.first.title.slice(0, 40)}…` : pane.first.title}`} onPress={() => onSelect(pane.first!.key)} />}
    {/* The Morning brief's Linear queue: what moved since the developer last read it (client/brief-since.tsx). */}
    {queue}
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
      {githubOff
        ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.foregroundMuted }} /><Text style={t.meta}>{githubOff === "missing" ? "GitHub not connected" : "GitHub signed out"}</Text></View>
        : <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{dot(!!observed && now - Date.parse(observed) < 15 * 60_000)}<Text style={t.meta}>GitHub {observed ? age(observed, now) : "no PRs yet"}</Text></View>}
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
  // A week of a busy host is hundreds of lines: pages (client/paged-list.tsx), a new window starts at page 1.
  const page = usePagedList({ items: lines, resetKey: String(days), theme, compact, noun: "lines" });
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 28, gap: 12, maxWidth: 820, width: "100%", alignSelf: "center" }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Button theme={theme} compact={compact} kind="ghost" icon="House" title="Home" onPress={onHome} />
    </View>
    <Text accessibilityRole="header" style={[t.title, { fontSize: 20, lineHeight: 26 }]}>Done while you were away</Text>
    <Text style={t.meta}>What Follow-up did on its own {days ? `in the last ${days} days` : `since ${sinceLabel(Date.now())}`}: messages it sent and how they went. It never merges, messages people, starts or archives workspaces.</Text>
    <Pressable accessibilityRole="button" onPress={onHome} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, backgroundColor: c.surface1 }}>
      <Icon name="Inbox" size={14} color={needs ? c.statusWarning : c.foregroundMuted} />
      <Text style={[t.body, { flex: 1 }]}>{needs ? `${needs} thing${needs === 1 ? "" : "s"} it left for you are on Home.` : "Nothing is waiting for you on Home."}</Text>
      <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
    </Pressable>
    {lines.length ? page.shown.map(l => <LogRow key={l.key} l={l} c={c} onOpen={() => onOpen(`agent:${l.agentId}`)} />) : <Text style={t.meta}>Nothing in this window.</Text>}
    {page.footer}
    {!days && <Button theme={theme} compact={compact} kind="ghost" title="Show the last 7 days" onPress={() => setDays(7)} />}
  </ScrollView>;
}
