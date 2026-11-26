// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md, docs/needs-you.md#catch-up). It
// renders the same components the panel and Home use (QuestionBody, NeedsYouList, BriefCard, the permission block), so
// the answer flow is the shared one, never a fork (one-answer-flow-for-every-question). The deck's order and every
// move are the pure session in shared/catch-up.ts (context-never-blocks-the-deck, the-card-on-screen-never-moves).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Animated, PanResponder, Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { ImageField, useImageAttachments } from "./image-attach";
import type { ImageUpload } from "../shared/images";
import { useQuery } from "@tanstack/react-query";
import { inboxBriefRpc } from "../shared/contracts";
import { needsYou } from "../shared/attention";
import { liveBrief } from "../shared/brief";
import { age, snoozeUntil } from "../shared/inbox";
import { laterChoices } from "../shared/row-menu";
import { CATCH_UP_RAIL_DEFAULT, CATCH_UP_RAIL_MAX, CATCH_UP_RAIL_MIN } from "../shared/display";
import { CATCH_UP_KEYS, MODE, catchUpKey, contextFor, keyLabel, deckCards, groupOf, openInWorkspace, park, prevPos, applySwipe, skipWorkspace, swipeLock, swipeOutcome, settle as settleCard, startSession, statsOf, sync, type ContextRequest, type DeckCard, type Outcome, type Session } from "../shared/catch-up";
import type { Workspace } from "../shared/model";
import type { ListWorkspace } from "../shared/list";
import { bottomInset, Button, errorText, focusSoon, IconButton, SubmitScope, text, type Theme } from "./kit";
import { glyphColor } from "./home-list";
import { useHomeModel, type HomeSources } from "./home-data";
import { useInbox } from "./inbox";
import { QuestionBody, QuestionDismissX, type SendReady } from "./questions";
import { DismissReveal, useDismiss } from "./dismiss";
import { NeedsYouList } from "./needs-you";
import { BriefCard, type BriefDeps } from "./brief";
import { SummaryLine } from "./about";
import { ReferencesLine } from "./linked";
import { openRowCopy, useWorkspace } from "./workspace-data";
import { mergedColor, withAlpha, tint } from "./theme";
import { RichText } from "./rich-text";
import { DisplaySplit, PermissionBlock, useAgentLive } from "./home";
import { DockedPane } from "./docked-pane";
import { hostDictation } from "./dictation";
import { ownsKey, surfaceVisible } from "../shared/list-keys";
import { useReducedMotion } from "./motion";
import { PRIMARY_FORM } from "./dock";
import { MorePanel, MoveResult, ContextAnswer } from "./more-context";
import { AnswerActions, AnswerView, ReplyForm, useQuestionActs } from "./your-questions";
import { questionLine, questionsByWorkspace } from "../shared/your-questions";

export { MorePanel, MoveResult, ContextAnswer };

/** react-native-web's data attribute, so the option-letter keys find this card's radios. */
const CARD_MARK = { dataSet: { catchUpCard: "1" } } as object;
const RAIL_MIN_PX = 240;
const CARD_MIN_PX = 480;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test((navigator as { platform?: string }).platform ?? "");

export type CatchUpDeps = { sources: HomeSources; briefDeps: BriefDeps; openHome(): void; openPanel(workspaceId: string): void };
type Nav = { openAgent(a: { agentId: string }): void; openWorkspace(a: { workspaceId: string }): void } | undefined;

/** One card's label in the queue rail and in a More context ask: "Q1 · Retry declined cards?", "Merge #255". */
export function cardLabel(card: DeckCard, w: ListWorkspace | undefined): string {
  if (card.kind === "permission") return "Permission";
  if (card.kind === "question") { const q = w?.questions.find(x => x.id === card.questionId); return q ? `${q.id} · ${q.title}` : card.questionId ?? "Question"; }
  if (card.kind === "item" && card.item) return card.item.title;
  if (card.kind === "brief") return card.s.line || card.s.word || "Ask";
  if (card.kind === "answer") return card.ask || "Your question";
  return card.s.line || "Finished";
}
/** The card's own word: a workspace row's word names its first item, the card names its own. */
/** "4m ago", or "just now" (never "now ago"); empty when there's no time. */
const agoText = (a: string) => !a ? "" : a === "now" ? "just now" : `${a} ago`;

function cardWord(card: DeckCard): string {
  if (card.kind === "permission") return "Permission";
  if (card.kind === "question") return card.item?.kind === "question" && card.item.state === "stopped" ? "Agent stopped" : "Question";
  if (card.kind === "finished") return "Finished";
  if (card.kind === "answer") return "Your question";
  if (card.kind === "brief") return card.s.word ?? "Ask";
  switch (card.item?.kind) {
    case "merge": return "Merge"; case "reviewers": return "Add reviewers"; case "send": return "Send"; case "answer": return "Your answer";
    case "hold": return "Paused"; case "retry": case "capped": case "message": return "Retry"; case "check": return "Check"; case "decision": return "Blocked";
    case "person": return card.item.review ? "Re-review" : "Someone else";
    default: return card.s.word ?? "Needs you";
  }
}
const cardIcon = (card: DeckCard) => card.kind === "permission" ? "ShieldQuestion" : card.kind === "question" ? "MessageCircleQuestion" : card.kind === "answer" ? "MessageSquareReply"
  : card.item?.kind === "merge" ? "GitMerge" : card.item?.kind === "reviewers" ? "UserPlus" : card.item?.kind === "person" ? "UserRound" : card.item?.kind === "send" ? "Send" : card.kind === "finished" ? "Flag" : card.s.icon;
/**
 * The card Skip names what it skips, so it never reads as the workspace (Tom, beta.3: "at first I thought it skips the
 * workspace"): the card's kind where one word says it, else "card", the deck's own word ("N skipped" counts cards).
 */
export function skipNoun(card: Pick<DeckCard, "kind" | "item">): string {
  return card.kind === "question" ? "question" : card.kind === "answer" ? "answer" : card.kind === "permission" ? "permission" : card.item?.kind === "merge" ? "merge" : "card";
}
/** The card Skip's tooltip and accessible name: what it does and that the card comes back. */
export const skipCardHint = (noun: string) => `Skip this ${noun}. It comes back after the rest`;
export const skipWorkspaceHint = (n: number) => `Skip this workspace's ${n} cards. They come back after the rest`;
/** The newest ask about this card, if any, from whichever surface asked it (sameCard). */
const askFor = (context: readonly ContextRequest[], card: DeckCard) => contextFor(context, { workspaceId: card.s.workspaceId, cardKey: card.key });

export function CatchUp({ theme, compact, deps, navigation, onExit }: { theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; onExit: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const { inbox, live, extras } = deps.sources;
  const model = useHomeModel(deps.sources);
  const rows = useInbox(inbox, () => inbox.rows());
  const version = useSyncExternalStore(live.subscribe, live.version, live.version);
  const context = useSyncExternalStore(extras.subscribe, extras.context, extras.context);
  // Everything comes from what the client already holds: Home's model, the inbox rows, the listed workspaces.
  // Your questions: each unread answer is a card, last in its workstream (shared deckCards).
  const unread = useMemo(() => questionsByWorkspace(context), [context]);
  const liveCards = useMemo(() => deckCards({ model, rows, items: id => { const w = live.get(id); return w ? needsYou(w as unknown as Workspace) : []; }, answers: id => unread.get(id)?.unread ?? [] }),
    [model, rows, version, live, unread]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(liveCards.map(x => [x.key, x])), [liveCards]);
  // A card that left Needs you keeps its last copy, so it can say "Handled elsewhere" in place.
  const seen = useRef(new Map<string, DeckCard>());
  for (const card of liveCards) seen.current.set(card.key, card);
  const cardOf = (k: string | undefined) => k ? byKey.get(k) ?? seen.current.get(k) ?? null : null;

  const [session, setSession] = useState<Session>(() => startSession(liveCards));
  const settled = (id: string) => { const r = context.find(x => x.id === id); return !r || r.state !== "asking"; };
  useEffect(() => { setSession(s => s.order.length || !liveCards.length ? sync(s, liveCards, settled) : startSession(liveCards)); },
    [liveCards, context]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening and each move read the asks once: a 0.15 host (no feed) is never stale for long, and nothing polls.
  useEffect(() => { void extras.refreshContext(); }, [session.pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const [more, setMore] = useState(false);
  const key = session.order[session.pos];
  const card = cardOf(key);
  const gone = !!key && session.outcomes[key] === "gone";
  const finished = session.pos >= session.order.length;
  const settle = (outcome: Outcome) => { setMore(false); setSession(s => settleCard(s, outcome)); };
  const skip = () => settle("skipped");
  const skipWs = () => { setMore(false); setSession(skipWorkspace); };
  const wsLeft = openInWorkspace(session).length;
  const back = () => { setMore(false); setSession(s => ({ ...s, pos: prevPos(s) })); };
  const jump = (i: number) => { setMore(false); setSession(s => ({ ...s, pos: i })); };
  const w = card?.s.workspaceId ? live.get(card.s.workspaceId) : undefined;
  // The next card's workspace detail is read while this one is on screen, so it paints at once (prefetch, no poll).
  const nextCard = cardOf(session.order[session.pos + 1]);
  useWorkspace(live, nextCard?.s.workspaceId ?? "", { enabled: !!nextCard?.s.workspaceId });

  const ask = async (words: string, images?: ImageUpload[]) => {
    if (!card) return;
    const out = await extras.askContext({ workspaceId: card.s.workspaceId, agentId: card.s.agentId, cardKey: card.key, card: cardLabel(card, w).slice(0, 300), ask: words, ...(images?.length ? { images } : {}) });
    setMore(false);
    // context-never-blocks-the-deck: the workstream waits, the deck moves on.
    if (out.request.state === "asking") setSession(s => park(s, out.request.id, card.key));
  };

  // Desktop keys (CATCH_UP_KEYS, catchUpKey in shared/catch-up.ts): every move has one. The card's controls are found
  // by the names they already carry (option letters, Later (L), Open chat (O)), so a key does exactly what a click does.
  // every-catch-up-key-works-wherever-focus-is: one owner for these keys whatever else is mounted. The listener is the
  // window's, in the capture phase, so it runs before any document listener (Follow-up's list keys take j and k there
  // and stop them); it takes a key only when focus is inside this screen, or on nothing while this screen is the one on
  // view (a Catch up Paseo keeps mounted behind a tab never does), and it finds every control inside its own root.
  const [keysOpen, setKeysOpen] = useState(false);
  const rootRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || compact) return;
    type Ev = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean; target: unknown; preventDefault(): void; stopPropagation(): void };
    type El = { tagName?: string; isContentEditable?: boolean; click?(): void; focus?(): void; closest?(q: string): El | null };
    type Root = El & { querySelector(q: string): El | null; querySelectorAll(q: string): ArrayLike<El>; contains(n: unknown): boolean; checkVisibility?(): boolean; getClientRects?(): { length: number } };
    type Doc = { body?: unknown; visibilityState?: string };
    type Win = { addEventListener(t: string, f: (e: Ev) => void, capture?: boolean): void; removeEventListener(t: string, f: (e: Ev) => void, capture?: boolean): void };
    const doc = (globalThis as { document?: Doc }).document; const win = globalThis as unknown as Win;
    if (!doc || typeof win.addEventListener !== "function") return;
    const mac = isMac();
    const root = () => rootRef.current as unknown as Root | null;
    const inCard = (q: string) => root()?.querySelector(`[data-catch-up-card] ${q}`) ?? null;
    const railItems = () => Array.from(root()?.querySelectorAll("[data-catch-up-rail] [role=\"button\"]") ?? []);
    const onKey = (e: Ev) => {
      const el = e.target as El | null;
      const r = root();
      const onBody = !el || el === doc.body;
      if (!r || !ownsKey({ inside: !!el && r.contains(el), onBody, claimBody: true, visible: onBody && surfaceVisible(r, doc) })) return;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable);
      const hit = catchUpKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, composing: e.isComposing, mac },
        { typing, inMore: !!el?.closest?.("[data-catch-up-more]"), moreOpen: more, inRail: !!el?.closest?.("[data-catch-up-rail]"), answer: card?.kind === "answer" });
      if (!hit || finished && !["back", "keys", "leave", "rail"].includes(hit.action)) return;
      const click = (q: string) => { const b = r.querySelector(q); b?.click?.(); return !!b; };
      switch (hit.action) {
        case "skip": skip(); break;
        case "skip-workspace": if (wsLeft < 2) return; skipWs(); break;
        case "back": back(); break;
        case "more": if (!click('[data-catch-up-card-moves] [aria-label="More context"]')) setMore(v => !v); break;
        case "keys": setKeysOpen(v => !v); break;
        case "leave": onExit(); break;
        case "pick": inCard(`[role="radio"][aria-label^="${hit.arg}. "]`)?.click?.(); break;
        case "own": inCard('[role="radio"][aria-label^="Something else"]')?.click?.(); break;
        case "send": { const b = inCard('[aria-label^="Send your"]') ?? inCard('[aria-label^="Send "]'); if (!b) return; b.click?.(); break; }
        // V: the card's mic (DictationField). No field open yet: Something else opens one first. Focus stays on the
        // mic, so V again stops it (in the field, V would be a letter).
        case "dictate": {
          if (!hostDictation()) return;
          const mic = () => inCard('[data-dictate] [role="button"]') ?? inCard('[data-dictate][role="button"]');
          const hit = (m: El | null) => { m?.click?.(); m?.focus?.(); };
          if (mic()) { hit(mic()); break; }
          const own = inCard('[role="radio"][aria-label^="Something else"]');
          if (!own) return;
          own.click?.();
          setTimeout(() => hit(mic()), 0);
          break;
        }
        // The card's own Dismiss (QuestionBody), so the key does exactly what the click does.
        // The card's own x (client/dismiss.tsx), whatever the card is, so the key does exactly what the click does.
        // Its last button: the x itself, or Remove once armed (so ⇧D twice removes, as two clicks would).
        case "dismiss": { const all = root()?.querySelectorAll('[data-catch-up-card] [data-testid="dismiss-x"] [role="button"]'); const d = all?.length ? all[all.length - 1] : null; if (!d) return; d.click?.(); break; }
        case "note": { const add = inCard('[aria-label^="Add a note"]'); if (add) add.click?.(); else r.querySelector('[aria-label="Tell the agent something"]')?.focus?.(); break; }
        // Its sheet or popover takes focus itself (MoveResult).
        case "later": if (!click('[aria-label="Later (L)"]')) return; break;
        case "chat": if (!click('[aria-label="Open chat (O)"]')) return; break;
        // An answer card's own buttons (AnswerActions), so the key does exactly what the click does.
        case "done": if (!click('[data-catch-up-card] [aria-label="Done (D)"]')) return; break;
        case "reply": if (!click('[data-catch-up-card] [aria-label="Reply (W)"]')) return; break;
        case "task": if (!click('[data-catch-up-card] [aria-label="Make a task (T)"]')) return; break;
        case "chip": r.querySelectorAll("[data-catch-up-more] [role=\"radio\"]")[Number(hit.arg) - 1]?.click?.(); break;
        case "ask": if (!click('[data-catch-up-more] [data-ask-agent] [role="button"]')) return; break;
        case "rail": {
          const items = railItems();
          if (el?.closest?.("[data-catch-up-rail]")) { (el as { blur?(): void }).blur?.(); break; }
          (r.querySelector("[data-catch-up-rail] [data-catch-up-here]") ?? items[0])?.focus?.();
          break;
        }
        case "rail-up": case "rail-down": {
          const items = railItems(); const i = items.indexOf(el as El);
          items[Math.max(0, Math.min(items.length - 1, i + (hit.action === "rail-up" ? -1 : 1)))]?.focus?.();
          break;
        }
        default: return;
      }
      e.preventDefault();
      // Acted: nothing else handles it (a list's j/k under a document listener).
      e.stopPropagation();
    };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  });
  // Phones: the card follows the finger (Paseo's sidebar drag): left skips this card, right goes Back, the card about to
  // show peeks underneath, and a drag held halfway stays there. The direction locks in the first SWIPE_LOCK_PX, so a
  // vertical scroll stays a scroll. Answers are never a swipe: a stray thumb must not decide anything. Reduced motion:
  // no follow, just the move on release. Transforms only (translateX), on the native driver where there is one.
  const reduced = useReducedMotion();
  const drag = useRef(new Animated.Value(0)).current;
  const [dragDir, setDragDir] = useState<"skip-workspace" | "back" | null>(null);
  const width = useRef(390);
  const lock = useRef<"x" | "y" | null>(null);
  // The finger's own offset from where it went down: react-native-web's accumulated gestureState.dx runs ahead of a
  // mouse drag, so the card would outrun the pointer. Every touch start passes the capture phase, so it is read there.
  const origin = useRef({ x: 0, y: 0 });
  type Touch = { nativeEvent: { pageX: number; pageY: number } };
  const offset = (e: Touch) => ({ dx: e.nativeEvent.pageX - origin.current.x, dy: e.nativeEvent.pageY - origin.current.y });
  const canBack = session.pos > 0;
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: e => { origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }; lock.current = null; return false; },
    onMoveShouldSetPanResponderCapture: e => {
      if (!compact || finished) return false;
      const { dx, dy } = offset(e);
      const l = swipeLock(dx, dy);
      if (!l) return false;
      lock.current ??= l;
      return lock.current === "x";
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: e => {
      const { dx } = offset(e);
      setDragDir(dx < 0 ? "skip-workspace" : canBack ? "back" : null);
      // Nothing behind the first card: the drag resists instead of revealing an empty space.
      if (!reduced) drag.setValue(dx > 0 && !canBack ? dx * 0.25 : dx);
    },
    onPanResponderRelease: (e, g) => {
      lock.current = null;
      const out = swipeOutcome({ dx: offset(e).dx, vx: g.vx, width: width.current, canBack });
      // Left skips the whole workspace (Skip workspace, ⇧J); right is Back. The same applySwipe the tests run.
      const act = () => { drag.setValue(0); setDragDir(null); setMore(false); setSession(s => applySwipe(s, out)); };
      if (out === "stay") { setDragDir(null); if (!reduced) Animated.spring(drag, { toValue: 0, bounciness: 0, speed: 20, useNativeDriver: Platform.OS !== "web" }).start(); else drag.setValue(0); return; }
      if (reduced) { act(); return; }
      Animated.timing(drag, { toValue: (out === "skip-workspace" ? -1 : 1) * width.current, duration: 160, useNativeDriver: Platform.OS !== "web" }).start(act);
    },
    onPanResponderTerminate: () => { lock.current = null; setDragDir(null); drag.setValue(0); },
  }), [compact, key, finished, canBack, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = statsOf(session);
  const total = session.order.length;
  const waitingChip = stats.waiting > 0 && <View accessibilityLabel={`${MODE.waiting(stats.waiting)}. They come back as the next card when the answer is ready; Back reaches them any time.`}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: c.surface2 }}>
    <Icon name="Hourglass" size={11} color={c.foregroundMuted} /><Text style={[t.small, { fontWeight: "600" }]}>{MODE.waiting(stats.waiting)}</Text>
  </View>;
  const progress = <View style={{ gap: 6, paddingHorizontal: compact ? 16 : 20, paddingTop: compact ? 8 : 14, paddingBottom: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, minHeight: compact ? 44 : 32 }}>
      {/* Phones: the host header's ← is the only back control (DESIGN.md "One header"). */}
      {!compact && <IconButton theme={theme} compact={compact} icon="X" label={`Leave ${MODE.name} (X)`} tooltip onPress={onExit} />}
      <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>{finished || !total ? MODE.name : <>{MODE.name} <Text style={{ color: c.foregroundMuted, fontWeight: "400", fontVariant: ["tabular-nums"] }}>{MODE.progress(session.pos + 1, total).slice(MODE.name.length + 1)}</Text></>}</Text>
      {waitingChip}
      {!compact && <Pressable accessibilityRole="button" accessibilityLabel="Show the keys (S)" onPress={() => setKeysOpen(v => !v)}><Text style={t.small}>{finished ? "S keys · X leave" : "J skip card · ⇧J skip workspace · K back · M more context · S keys"}</Text></Pressable>}
    </View>
    {/* One segment per card: done in the foreground colour, skipped hollow, waiting for context amber-tinted, the current one amber. */}
    {total > 0 && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 3 }}>
      {total > 24 ? <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: c.border }}><View style={{ width: `${Math.round(100 * (stats.done + stats.later + stats.gone) / total)}%`, height: 4, borderRadius: 2, backgroundColor: c.foreground }} /></View>
        : session.order.map((k, i) => {
          const o = session.outcomes[k];
          const waiting = !o && !!session.parked[groupOf(k)];
          const bg = i === session.pos && !finished ? c.statusWarning : o === "done" || o === "later" ? c.foreground : o ? withAlpha(c.foreground, 0.35) : waiting ? withAlpha(c.statusWarning, 0.4) : c.border;
          return <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: bg }} />;
        })}
    </View>}
  </View>;

  const body = finished || !card ? <Finished theme={theme} compact={compact} stats={stats} empty={!total} onHome={onExit}
      onSkipped={() => setSession(s => ({ ...s, pos: s.order.findIndex(k => s.outcomes[k] === "skipped"), lapped: true }))} />
    // The card on screen is the selected one: its x shows without hover (dismissing-anything-in-needs-you-sends-the-agent-nothing).
    : <DismissReveal.Provider value="always"><CardView key={card.key} card={card} w={w} theme={theme} compact={compact} deps={deps} navigation={navigation} gone={gone} more={more} setMore={setMore}
      request={askFor(context, card)} answer={card.requestId ? context.find(r => r.id === card.requestId) ?? null : null} waiting={!!session.parked[card.s.key]} onAsk={ask}
      sameWorkspace={session.order.filter(k => cardOf(k)?.s.key === card.s.key)}
      onDone={() => settle("done")} onSkip={skip} onSkipWorkspace={wsLeft > 1 ? skipWs : undefined} wsLeft={wsLeft} onBack={session.pos > 0 ? back : undefined} onLater={() => settle("later")} /></DismissReveal.Provider>;

  const rail = <ScrollView {...({ dataSet: { catchUpRail: "1" } } as object)} contentContainerStyle={{ paddingVertical: 8 }}>
    {session.order.map((k, i) => {
      const x = cardOf(k); if (!x) return null;
      const xw = x.s.workspaceId ? live.get(x.s.workspaceId) : undefined;
      const o = session.outcomes[k]; const here = i === session.pos;
      const waiting = !o && !!session.parked[x.s.key];
      const firstOfWs = i === 0 || cardOf(session.order[i - 1])?.s.key !== x.s.key;
      const label = cardLabel(x, xw);
      return <View key={k}>
        {firstOfWs && <Text numberOfLines={1} style={[t.small, { paddingHorizontal: 16, paddingTop: i ? 10 : 2, paddingBottom: 2, fontWeight: "600" }]}>{x.s.title}</Text>}
        <Pressable {...({ dataSet: here ? { catchUpHere: "1" } : {} } as object)} accessibilityRole="button" accessibilityState={{ selected: here }} accessibilityLabel={`${label}${o ? `, ${o === "gone" ? "handled elsewhere" : o}` : waiting ? ", getting context" : ""}`} onPress={() => jump(i)}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 16, backgroundColor: here ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent",
            borderLeftWidth: 2, borderLeftColor: here ? c.statusWarning : "transparent" })}>
          <Icon name={o === "done" ? "CircleCheck" : o === "skipped" ? "CornerUpRight" : o === "later" ? "AlarmClock" : o === "gone" ? "CircleCheck" : waiting ? "Hourglass" : cardIcon(x)} size={13}
            color={o === "done" || o === "gone" ? c.statusSuccess : o || waiting ? c.foregroundMuted : glyphColor(x.s, c, false)} />
          <Text numberOfLines={1} style={[t.meta, { flex: 1, color: o ? c.foregroundMuted : c.foreground, textDecorationLine: o === "done" ? "line-through" : "none" }]}>{label}</Text>
        </Pressable>
      </View>;
    })}
  </ScrollView>;

  // Under the dragged card: the one the release would show, so the drag says where it goes.
  // The peek says exactly what the release does: where Skip workspace lands (skipWorkspace itself), or Back's card.
  const ahead = dragDir === "skip-workspace" ? skipWorkspace(session) : null;
  const peekKey = ahead ? ahead.order[ahead.pos] : dragDir === "back" ? session.order[prevPos(session)] : undefined;
  const peekWhat = dragDir === "back" ? "Back" : wsLeft > 1 ? `Skip workspace · ${wsLeft} cards` : `Skip ${card ? skipNoun(card) : "card"}`;
  const peekCard = cardOf(peekKey);
  const peek = compact && dragDir && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
    style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.surface1, justifyContent: "center", alignItems: dragDir === "skip-workspace" ? "flex-end" : "flex-start", paddingHorizontal: 20 }}>
    <View style={{ maxWidth: "42%", gap: 4, alignItems: dragDir === "skip-workspace" ? "flex-end" : "flex-start" }}>
      <Icon name={dragDir === "back" ? "ChevronLeft" : wsLeft > 1 ? "ChevronsRight" : "ArrowRight"} size={18} color={c.foregroundMuted} />
      <Text style={[t.small, { fontWeight: "600" }]}>{peekWhat}</Text>
      <Text numberOfLines={2} style={[t.meta, { textAlign: dragDir === "skip-workspace" ? "right" : "left" }]}>{peekCard ? `${peekCard.s.title} · ${cardLabel(peekCard, peekCard.s.workspaceId ? live.get(peekCard.s.workspaceId) : undefined)}` : MODE.endOfDeck}</Text>
    </View>
  </View>;
  const main = <View style={{ flex: 1, minWidth: 0, overflow: "hidden" }} onLayout={e => { width.current = e.nativeEvent.layout.width; }} {...pan.panHandlers}>
    {peek}
    <Animated.View {...({ dataSet: { catchUpDrag: "1" } } as object)} style={{ flex: 1, backgroundColor: c.surface0, transform: [{ translateX: drag }],
      ...(dragDir ? { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } } : {}) }}>{body}</Animated.View>
  </View>;
  return <View ref={rootRef} {...({ dataSet: { catchUpRoot: "1" } } as object)} style={{ flex: 1, backgroundColor: c.surface0 }}>
    {progress}
    <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: c.border }}>
      {/* Desktop: the queue rail beside the card, resizable (side-panes-are-resizable); its width is the Display field catch_up_rail_fraction. */}
      {keysOpen && !compact && <KeysSheet theme={theme} onClose={() => setKeysOpen(false)} />}
      {!compact && total > 0 && !finished
        ? <DisplaySplit theme={theme} main={main} side={rail} field="catch_up_rail_fraction" testID="follow-up-catch-up-split" label="Resize the queue"
          defaultFraction={CATCH_UP_RAIL_DEFAULT} range={[CATCH_UP_RAIL_MIN, CATCH_UP_RAIL_MAX]} minSide={RAIL_MIN_PX} minMain={CARD_MIN_PX} />
        : main}
    </View>
  </View>;
}

/** One card: who and what, the ask through its own surface's component, then the deck's moves pinned to the bottom. */
function CardView({ card, w, theme, compact, deps, navigation, gone, more, setMore, request, answer, waiting, onAsk, sameWorkspace, onDone, onSkip, onSkipWorkspace, wsLeft, onBack, onLater }: {
  card: DeckCard; w: ListWorkspace | undefined; theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; gone: boolean; more: boolean; setMore: (v: boolean | ((v: boolean) => boolean)) => void;
  request: ContextRequest | null; /** An `answer` card's question (Your questions). */ answer: ContextRequest | null; waiting: boolean; onAsk: (words: string, images?: ImageUpload[]) => Promise<void>;
  sameWorkspace: string[]; onDone: () => void; onSkip: () => void; onSkipWorkspace?: () => void; wsLeft: number; onBack?: () => void; onLater: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const s = card.s;
  const { workspace: full } = useWorkspace(deps.sources.live, s.workspaceId ?? "");
  const ws = openRowCopy<ListWorkspace>(w, full);
  const [laterOpen, setLaterOpen] = useState(false);
  const [ready, setReady] = useState<SendReady | null>(null);
  const dismiss = useDismiss();
  const openChat = () => { if (!navigation) return; if (s.agentId) navigation.openAgent({ agentId: s.agentId }); else if (s.workspaceId) navigation.openWorkspace({ workspaceId: s.workspaceId }); };
  const word = cardWord(card);
  const compassLine = s.compass ?? (s.priority?.source?.kind === "compass" ? s.priority.reason : null);
  const color = card.item?.kind === "merge" ? mergedColor(c) : card.kind === "finished" ? c.foregroundMuted : c.statusWarning;
  const q = card.kind === "question" ? ws?.questions.find(x => x.id === card.questionId) ?? null : null;
  const nth = sameWorkspace.indexOf(card.key);
  const agentName = s.agent ?? "the agent";
  const noun = skipNoun(card);

  const head = <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={cardIcon(card)} size={14} color={color} />
      <Text numberOfLines={1} style={[t.meta, { flex: 1 }]}>
        <Text style={{ color, fontWeight: "600" }}>{word}</Text>
        {[s.at ? agoText(age(s.at, Date.now())) : "", s.project].filter(Boolean).map(x => ` · ${x}`).join("")}
        {sameWorkspace.length > 1 ? ` · ${nth + 1} of ${sameWorkspace.length} here` : ""}
      </Text>
    </View>
    {/* Skip workspace sits on the line of the workspace it skips, top right, the same place on phone and desktop (Tom,
        beta.4: "maybe put the skip workspace button at the top right?"). Only while more than one card is left; the meta
        line's "1 of 2 here" gives the count, and its accessible name says it. Negative margins keep its 44 px target
        from pushing the title line apart. */}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text accessibilityRole="header" numberOfLines={2} style={[compact ? t.title : [t.title, { fontSize: 17, lineHeight: 23 }], { flex: 1 }]}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      {onSkipWorkspace && <View style={{ marginVertical: compact ? -10 : -6, marginRight: compact ? -14 : -11 }}>
        <Tip label={`${skipWorkspaceHint(wsLeft)} (⇧J)`}><Button theme={theme} compact={compact} kind="ghost" icon="ChevronsRight" title="Skip workspace" accessibilityLabel={skipWorkspaceHint(wsLeft)} accessibilityHint={compact ? undefined : "Shift+J"} onPress={onSkipWorkspace} /></Tip>
      </View>}
    </View>
    {ws && <SummaryLine key={ws.id} workspace={ws} theme={theme} compact={compact} />}
    {full && <ReferencesLine workspace={full} theme={theme} compact={compact} />}
    {/* One muted line of pinned context (docs/compass.md): the note's own words, never a second reason. */}
    {compassLine && <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 }}>
      <Icon name="Compass" size={12} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0, color: c.foregroundMuted }]}>{`Compass · ${compassLine}`}</Text>
    </View>}
  </View>;

  const goneBanner = gone && <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 10, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
    <Icon name="CircleCheck" size={16} color={c.statusSuccess} />
    <Text style={[t.body, { flex: 1 }]}>Handled elsewhere. Nothing left to do here.</Text>
    <Button theme={theme} compact={compact} kind="primary" icon="ArrowRight" title="Next" onPress={onSkip} />
  </View>;

  const isAnswer = card.kind === "answer";
  const acts = useQuestionActs();
  const [replying, setReplying] = useState(false);
  const [answerBusy, setAnswerBusy] = useState<"done" | "task" | "again" | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerRun = (what: "done" | "task" | "again", work: () => Promise<unknown>) => {
    setAnswerBusy(what); setAnswerError(null);
    work().then(onDone, e => setAnswerError(errorText(e))).finally(() => setAnswerBusy(null));
  };
  const answerChat = answer?.askedOf && navigation ? () => navigation.openAgent({ agentId: answer.askedOf! }) : openChat;
  const answerActions = (bar: boolean) => answer && <AnswerActions r={answer} theme={theme} compact={compact} keys bar={bar} busy={answerBusy} openChat={bar ? answerChat : undefined}
    onDone={() => answerRun("done", () => acts.act(answer.id, "done"))} onReply={() => setReplying(true)}
    onTask={() => answerRun("task", () => acts.act(answer.id, "task"))}
    onAskAgain={() => answerRun("again", async () => { await acts.ask({ workspaceId: answer.workspaceId, agentId: answer.cardKey ? answer.agentId : answer.askedOf, cardKey: answer.cardKey, card: answer.card || undefined, ask: answer.ask, via: answer.via === "slash" ? "slash" : answer.cardKey ? "more" : "field" }); await acts.act(answer.id, "done"); })}
    extra={bar ? <Button theme={theme} compact kind="ghost" icon="ArrowRight" title={`Skip ${noun}`} accessibilityLabel={skipCardHint(noun)} onPress={onSkip} /> : undefined} />;
  const askBlock = isAnswer ? answer ? <View style={{ gap: 14 }}>
      <AnswerView r={answer} theme={theme} compact={compact} now={Date.now()} mainAgentId={full?.mainAgentId ?? w?.mainAgentId ?? null} big />
      {replying ? <ReplyForm r={answer} theme={theme} compact={compact} onCancel={() => setReplying(false)} onSent={onDone} /> : !compact && answerActions(false)}
      {!!answerError && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{answerError}</Text>}
    </View> : <RichText selectable style={t.ask}>{card.ask || "Your question"}</RichText>
    : card.kind === "question" && q && ws
    ? <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <RichText plain style={[compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }], { flex: 1, minWidth: 0 }]}>{`${q.id} · ${q.title}`}</RichText>
        <View style={{ marginTop: compact ? -4 : -1, marginRight: -5 }}><QuestionDismissX workspaceId={ws.id} questionId={q.id} theme={theme} compact={compact} onDismissed={onDone} dismiss={dismiss} /></View>
      </View>
      <QuestionBody key={q.id} workspace={ws} question={q} theme={theme} compact={compact} inline={false} dismissAt="host"
        openAgent={id => navigation?.openAgent({ agentId: id })} onAnswered={onDone} onSendReady={setReady} dictate moreContext={false} />
    </View>
    : card.kind === "item" && card.item && full
    ? <View style={{ borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.45), overflow: "hidden" }}>
      <NeedsYouList workspace={full} theme={theme} compact={compact} rows={[card.item]} flush actions={{ after: onDone, openAgent: openChat } as never} />
    </View>
    : card.kind === "permission" ? <PermissionCard s={s} theme={theme} compact={compact} onDone={onDone} />
    : card.kind === "brief" ? <BriefAsk s={s} theme={theme} compact={compact} deps={deps} onDismissed={onDone} />
    : <View style={{ gap: 10 }}>
      <Text style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{s.line || "The agent finished its turn."}</Text>
      <Text style={t.meta}>Nothing to decide. Sign it off once you've read it, or reply.</Text>
      <View style={{ flexDirection: "row", gap: 8 }}><Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Check" title="Sign off" onPress={() => { if (s.agentId) void deps.sources.inbox.signOff([s.agentId]); onDone(); }} /></View>
    </View>;

  // Add context without answering: every card that isn't a question has the agent's reply box (a question has its note).
  const reply = card.kind !== "question" && !isAnswer && s.agentId && <NoteRow theme={theme} compact={compact} agentId={s.agentId} />;
  const contextBlock = request && <ContextAnswer theme={theme} compact={compact} request={request} waiting={waiting} agent={agentName} openChat={openChat} openAgent={navigation ? id => navigation.openAgent({ agentId: id }) : undefined} />;
  // a-move-bar-action-opens-in-view (MOVE_OPENS): More context and Later open where the eye is, a sheet above the
  // phone's bar or a popover on their button on desktop, never appended below the card.
  const closeMore = () => { setMore(false); if (!compact) focusSoon("catch-up-more"); };
  const moreBlock = more && <MorePanel theme={theme} compact={compact} onClose={closeMore} onAsk={onAsk} target={s.workspaceId ? { kind: "workspace", workspaceId: s.workspaceId } : s.agentId ? { kind: "agent", agentId: s.agentId } : null} />;
  const later = (until: string) => { setLaterOpen(false); if (s.agentId) void deps.sources.inbox.snooze([s.agentId], until); onLater(); };
  const laterBlock = laterOpen && <View {...({ dataSet: { catchUpLater: "1" } } as object)} accessibilityRole="menu" accessibilityLabel="Later" style={{ gap: 8 }}>
    <Text style={[t.small, { fontWeight: "600" }]}>Back in your Needs you</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {laterChoices(new Date()).map(([k, label]) => <Button key={k} theme={theme} compact={compact} kind="ghost" icon="AlarmClock" title={label} onPress={() => later(snoozeUntil(k, new Date()))} />)}
    </View>
  </View>;
  const toggleMore = () => { setLaterOpen(false); setMore(v => !v); };
  const toggleLater = () => { setMore(false); setLaterOpen(v => !v); };
  const popover = (open: ReactNode, label: string, width: number) => open && <MoveResult place="popover" theme={theme} label={label} width={width}>{open}</MoveResult>;

  // The deck's moves: in thumb reach on phones, under the card on desktop. Once the card has an answer to send, Send to
  // agent takes the bar's primary slot: the question's own Send (onSendReady), so one click, one flow. Icon-only moves
  // carry their name for screen readers and as a desktop tooltip.
  const send = ready && (compact
    ? <View style={{ flex: 1 }}><Button theme={theme} compact grow kind="primary" icon="Send" title="Send" accessibilityLabel="Send to agent" shortcut disabled={ready.busy} onPress={ready.send} /></View>
    : <Button theme={theme} kind="primary" icon="Send" title="Send to agent" shortcut disabled={ready.busy} onPress={ready.send} />);
  // An answer on a phone: its own actions are the thumb bar (Done, Reply, Task, ⋯ with Open chat and Skip); swipes still move.
  const moves = compact && isAnswer && answer && !replying ? <View {...({ dataSet: { catchUpCardMoves: "1" } } as object)} style={{ paddingHorizontal: 12, paddingTop: 10 }}>{answerActions(true)}</View>
    : <View {...({ dataSet: { catchUpCardMoves: "1" } } as object)} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 12 : 0, paddingTop: compact ? 10 : 4 }}>
    <IconButton theme={theme} compact={compact} icon="ChevronLeft" label={compact ? "Back" : "Back (K or ←)"} tooltip={!compact} disabled={!onBack} onPress={() => onBack?.()} />
    {isAnswer ? null : compact ? <IconButton theme={theme} compact icon="Sparkles" label="More context" onPress={toggleMore} />
      : <View>{popover(moreBlock, "More context", 560)}<Tip label="More context (M)"><Button theme={theme} icon="Sparkles" title="More context" accessibilityHint="M" nativeID="catch-up-more" onPress={toggleMore} /></Tip></View>}
    <View>{!compact && popover(laterBlock, "Later", 380)}<IconButton theme={theme} compact={compact} icon="AlarmClock" label={compact ? "Later" : "Later (L)"} tooltip={!compact} disabled={!s.agentId} onPress={toggleLater} /></View>
    <IconButton theme={theme} compact={compact} icon="MessageSquare" label={compact ? "Open chat" : "Open chat (O)"} tooltip={!compact} disabled={!navigation} onPress={openChat} />
    {!compact && <View style={{ flex: 1 }} />}
    {/* Two skips, named apart: this card (J), and the whole workspace (⇧J), shown only while it has more than one card left. */}
    {compact ? ready ? <IconButton theme={theme} compact icon="ArrowRight" label={skipCardHint(noun)} onPress={onSkip} />
        : <View style={{ flex: 1 }}><Button theme={theme} compact grow icon="ArrowRight" title={`Skip ${noun}`} accessibilityLabel={skipCardHint(noun)} onPress={onSkip} /></View>
      : <>
        <Tip label={`${skipCardHint(noun)} (J or →)`}><Button theme={theme} icon="ArrowRight" title={`Skip ${noun}`} accessibilityLabel={skipCardHint(noun)} accessibilityHint="J" onPress={onSkip} /></Tip>
      </>}
    {send}
  </View>;

  // a-focused-field-and-its-send-stay-in-view: the phone's bar is DockedPane's dock, so while a field has focus or the
  // keyboard is up the bar steps aside and the field (Something else, a note) keeps its Send in view. An open sheet
  // stays (the pane stops above the keyboard), so More context's ask box and its Ask buttons stay in view too.
  const sheet = compact && (moreBlock || laterBlock);
  return <DockedPane compact={compact}
    contentContainerStyle={{ padding: compact ? 16 : 28, gap: compact ? 16 : 18, ...(compact ? {} : { maxWidth: 720, width: "100%", alignSelf: "center" }) }}
    dock={({ yields, typingInContent }) => compact && (sheet && !typingInContent || !yields) && <View style={[{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0 }, bottomInset(compact)]}>
      {sheet && !typingInContent && <MoveResult place="sheet" theme={theme} label={moreBlock ? "More context" : "Later"}>{sheet}</MoveResult>}
      {!yields && moves}
    </View>}>
    {goneBanner}
    {head}
    {contextBlock}
    <View {...CARD_MARK} style={{ gap: 16 }}>{askBlock}</View>
    {reply}
    {/* Desktop: ⌘↵ anywhere on the bar sends, as the bar's Send says (its own SubmitScope). */}
    {!compact && <SubmitScope enabled={!!ready && !ready.busy} onSubmit={() => ready?.send()}>{moves}</SubmitScope>}
  </DockedPane>;
}

function PermissionCard({ s, theme, compact, onDone }: { s: DeckCard["s"]; theme: Theme; compact: boolean; onDone: () => void }) {
  const agent = useAgentLive(s.agentId);
  const t = text(theme.colors, compact);
  if (!agent.permissions.length) return <Text style={t.ask}>{s.line || "Permission"}</Text>;
  return <View style={{ gap: 10 }}>{agent.permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={false} primary
    onRespond={r => { void agent.handle?.respondToPermission({ requestId: p.id, response: r as never }); onDone(); }} />)}</View>;
}

function BriefAsk({ s, theme, compact, deps, onDismissed }: { s: DeckCard["s"]; theme: Theme; compact: boolean; deps: CatchUpDeps; onDismissed?: () => void }) {
  const read = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-up", "home-brief", s.agentId, "catch-up"], queryFn: () => read({ agentId: s.agentId! }), enabled: !!s.agentId });
  const b = liveBrief(brief.data?.brief);
  if (!b) return <Text style={text(theme.colors, compact).ask}>{s.line}</Text>;
  return <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps, onDismissed } as unknown as Parameters<typeof BriefCard>[0])} />;
}

export function Finished({ theme, compact, stats, empty, onHome, onSkipped }: { theme: Theme; compact: boolean; stats: ReturnType<typeof statsOf>; empty: boolean; onHome: () => void; onSkipped: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  // "All caught up" only when it is true: a skipped or waiting card means the developer is not, so the end says so.
  const caughtUp = !stats.skipped && !stats.waiting;
  const icon = caughtUp ? "Check" : stats.waiting ? "Hourglass" : "CornerUpRight";
  const tone = caughtUp ? c.statusSuccess : stats.waiting ? c.statusWarning : c.foregroundMuted;
  const line = [stats.done && `${stats.done} done`, stats.skipped && `${stats.skipped} skipped`, stats.later && `${stats.later} for later`, stats.gone && `${stats.gone} handled elsewhere`].filter(Boolean).join(" · ");
  return <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }}>
    <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: tint(tone, c) }}>
      <Icon name={icon} size={28} color={tone} />
    </View>
    <Text accessibilityRole="header" style={t.headline}>{empty ? MODE.empty : caughtUp ? MODE.finished : MODE.endOfDeck}</Text>
    {!!line && <Text style={[t.body, { color: c.foregroundMuted, textAlign: "center" }]}>{line}</Text>}
    {stats.waiting > 0 && <Text style={[t.body, { textAlign: "center" }]}>{`${MODE.waiting(stats.waiting)}. ${stats.waiting === 1 ? "It comes" : "They come"} back here when the answer is ready; Back reaches ${stats.waiting === 1 ? "it" : "them"} now.`}</Text>}
    {stats.done > 0 && <Text style={[t.meta, { textAlign: "center", maxWidth: 420 }]}>Your answers are on their way; agents pick them up as soon as they're free. Anything new shows in Needs you and the pill.</Text>}
    <View style={{ flexDirection: compact ? "column" : "row", alignSelf: compact ? "stretch" : "center", gap: 8, marginTop: 6 }}>
      {stats.skipped > 0 && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="CornerUpRight" title={`Catch up on ${stats.skipped} skipped`} onPress={onSkipped} />}
      <Button theme={theme} compact={compact} grow={compact} kind={stats.skipped ? "secondary" : "primary"} icon="House" title="Back to Home" onPress={onHome} />
    </View>
  </ScrollView>;
}

/** A keys sheet's rows: a key (as spelled in its list) and what it does. */
export type KeySection = { title: string; keys: readonly { key: string; what: string }[] };

/**
 * S: the keys, from the one list the handler reads (Catch up: shared/catch-up.ts; Home: shared/home-keys.ts). A dialog
 * over the screen; S or its X closes it.
 */
export function KeysSheet({ theme, onClose, label = "Catch up keys", sections: given, keyWidth = 64 }: { theme: Theme; onClose: () => void; label?: string; sections?: readonly KeySection[]; /** The key column, wide enough for the list's longest key so every description lines up. */ keyWidth?: number }) {
  const dictation = !!hostDictation();
  const sections = given ?? catchUpSections(dictation);
  const c = theme.colors; const t = text(c, false);
  const row = (k: KeySection["keys"][number], i: number) => <View key={`${k.key}-${i}`} style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
    <View style={{ width: keyWidth }}><Text style={[t.meta, { alignSelf: "flex-start", paddingHorizontal: 6, borderRadius: 4, borderWidth: 1, borderColor: c.border, color: c.foreground, fontVariant: ["tabular-nums"] }]}>{keyLabel(k.key, isMac())}</Text></View>
    <Text style={[t.meta, { flex: 1, minWidth: 0 }]}>{k.what}</Text>
  </View>;
  return <View role="dialog" accessibilityLabel={label} style={{ position: "absolute", zIndex: 10, right: 20, top: 8, width: 236 + keyWidth, padding: 16, gap: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Text style={[t.label, { flex: 1, fontWeight: "600" }]}>Keys</Text>
      <IconButton theme={theme} compact={false} icon="X" label="Close the keys (S)" tooltip onPress={onClose} />
    </View>
    {sections.filter(s => s.keys.length).map(s => <View key={s.title} style={{ gap: 6 }}>
      <Text style={[t.small, { fontWeight: "600" }]}>{s.title}</Text>{s.keys.map(row)}
    </View>)}
  </View>;
}
/** Catch up's sheet: the dictation key only where the host has a mic. */
const catchUpSections = (dictation: boolean): readonly KeySection[] => [
  { title: "On a card", keys: CATCH_UP_KEYS.filter(k => !k.when && (!k.needs || dictation)) },
  { title: "On an answer to your question", keys: CATCH_UP_KEYS.filter(k => k.when === "answer") },
  { title: "In More context", keys: CATCH_UP_KEYS.filter(k => k.when === "more") },
  { title: "In the queue", keys: CATCH_UP_KEYS.filter(k => k.when === "rail") },
];

/** A desktop hover title on any control (react-native-web drops `title` on a Pressable; IconButton does the same). */
function Tip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<View>(null);
  useEffect(() => { if (Platform.OS === "web") (ref.current as unknown as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("title", label); }, [label]);
  return Platform.OS === "web" ? <View ref={ref}>{children}</View> : <>{children}</>;
}

/**
 * Home's way in. It counts cards (one per thing to act on), which can differ from Needs you's workspace count beside
 * it, so its accessible name and desktop tooltip say what the number is.
 */
export function CatchUpButton({ theme, compact, count, onPress }: { theme: Theme; compact: boolean; count: number; onPress: () => void }): ReactNode {
  if (!count) return null;
  const label = MODE.buttonLabel(count);
  const button = <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Layers" title={MODE.button(count)} accessibilityLabel={label} onPress={onPress} />;
  return Platform.OS === "web" && !compact ? <View {...({ dataSet: { tooltip: label }, title: label } as object)}>{button}</View> : button;
}

/** Tell the agent something with or without acting: a plain message, the detail pane's reply box in a line. */
function NoteRow({ theme, compact, agentId }: { theme: Theme; compact: boolean; agentId: string }) {
  const c = theme.colors;
  const agent = useAgentLive(agentId);
  const [words, setWords] = useState("");
  // Pasted images go with the words through Paseo's own send (every-agent-field-takes-images).
  const img = useImageAttachments({ target: { kind: "agent", agentId } });
  const send = () => {
    const images = img.uploads()?.map(i => ({ data: i.data, mimeType: i.mimeType }));
    void agent.handle?.send(words.trim(), images ? { images } : undefined); setWords(""); img.clear();
  };
  return <ImageField model={img} theme={theme} compact={compact}><View {...PRIMARY_FORM} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
    <TextInput accessibilityLabel="Tell the agent something" placeholder="Tell the agent something" placeholderTextColor={c.foregroundMuted} value={words} onChangeText={setWords} multiline
      style={{ flex: 1, minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} />
    <IconButton theme={theme} compact={compact} icon="Send" label="Send to the agent" tooltip={!compact} disabled={!words.trim() || !!img.blocked} onPress={send} />
  </View></ImageField>;
}
