import { FloatingSurface } from "./floating-surface";
// More context, the one component and the one request path for every surface that answers a question
// (more-context-is-the-same-on-every-surface, docs/needs-you.md#more-context): Catch up's card (its move bar opens
// MorePanel), and QuestionBody everywhere else: the panel's Needs you card, Home's detail pane, the question dialog, the
// pill, phones. "I don't get it" first, then your own words; the ask goes to the card's workspace's main agent
// (follow.context-ask, the same request ask_context makes), and the answer shows on the question wherever you look at it,
// because every reader matches it with `contextFor` (shared/catch-up.ts).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { CONTEXT_ASKS, askHeadline, contextFor, keyLabel, questionCardKey, type ContextRequest } from "../shared/catch-up";
import type { RpcInput } from "@getpaseo/plugin";
import type { contextAskRpc, questionActionRpc } from "../shared/contracts";
import type { ListQuestion, ListWorkspace } from "../shared/list";
import { errorText } from "../shared/errors";
import { Button, IconButton, text, type Theme } from "./kit";
import { withAlpha } from "./theme";
import { RichText } from "./rich-text";
import { PRIMARY_FORM } from "./dock";
import { ImageField, useImageAttachments } from "./image-attach";
import type { ImageTarget, ImageUpload } from "../shared/images";

const CATCH_UP_FOOTNOTE = "This workspace steps aside while you keep going, and comes back as your next card with the answer. Back reaches it any time.";
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test((navigator as { platform?: string }).platform ?? "");

/**
 * The client's one store of More context asks: Home's extras (client/home-view.ts), which the home feed keeps current,
 * so nothing polls. index.client.tsx hands it over once; every surface reads the same asks and asks through it.
 */
export type ContextSource = {
  context(): ContextRequest[];
  subscribe(listener: () => void): () => void;
  askContext(input: RpcInput<typeof contextAskRpc>): Promise<{ request: ContextRequest }>;
  /** Your questions' acts (follow.question-action): the store takes the result at once. */
  questionAction?(input: RpcInput<typeof questionActionRpc>): Promise<{ request: ContextRequest; reply?: ContextRequest; taskId?: string }>;
  /** Reads the asks once. A 0.15 host has no feed, and the store starts empty, so a fresh panel would miss an ask. */
  refreshContext?(): Promise<void>;
};
/** Sources already read: the first question card on screen reads the asks once per client, never per card or on a timer. */
const read = new WeakSet<ContextSource>();
let source: ContextSource | null = null;
const sourceListeners = new Set<() => void>();
export function setContextSource(next: ContextSource | null): void { source = next; for (const l of sourceListeners) l(); }
const noAsks: ContextRequest[] = [];
const idle = () => () => undefined;

/** The one store (or null before the client set it), and every question in it, kept current by the home feed. */
export function useContextStore(): { source: ContextSource | null; requests: ContextRequest[] } {
  const current = useSyncExternalStore(l => { sourceListeners.add(l); return () => { sourceListeners.delete(l); }; }, () => source, () => source);
  const requests = useSyncExternalStore(current?.subscribe ?? idle, current?.context ?? (() => noAsks), current?.context ?? (() => noAsks));
  useEffect(() => { if (current && !read.has(current)) { read.add(current); void current.refreshContext?.().catch(() => undefined); } }, [current]);
  return { source: current, requests };
}

/** The newest ask about one question, from any surface, and the way to ask. Null `ask` when no source is set. */
export function useQuestionContext(workspaceId: string, questionId: string): { request: ContextRequest | null; ask: ((words: string, card: string, agentId: string | null, images?: ImageUpload[]) => Promise<ContextRequest>) | null } {
  const { source: current, requests } = useContextStore();
  const cardKey = questionCardKey(workspaceId, questionId);
  const request = contextFor(requests, { workspaceId, cardKey });
  return {
    request,
    ask: current && (async (words, card, agentId, images) => (await current.askContext({ workspaceId, agentId, cardKey, card: card.slice(0, 300), ask: words, ...(images?.length ? { images } : {}) })).request),
  };
}

/**
 * More context on a question card outside Catch up: a quiet link where the answer is written, never a new top-level
 * button. Open, it is Catch up's panel (suggestions, then your own words) in Catch up's sheet; asked, the card says it
 * is waiting; answered, the answer sits on the question. `children` are the row's other quiet links (they follow it).
 */
export function QuestionMoreContext({ workspace: w, question: q, theme, compact, openAgent, children }: { workspace: Pick<ListWorkspace, "id" | "mainAgentId">; question: Pick<ListQuestion, "id" | "title" | "askedBy">; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; children?: ReactNode }) {
  const c = theme.colors;
  const { request, ask } = useQuestionContext(w.id, q.id);
  const [open, setOpen] = useState(false);
  const asking = request?.state === "asking";
  const agentId = q.askedBy ?? w.mainAgentId ?? null;
  const chatOf = request?.askedOf ?? w.mainAgentId ?? null;
  const onAsk = async (words: string, images?: ImageUpload[]) => { await ask!(words, `${q.id} · ${q.title}`, agentId, images); setOpen(false); };
  const link = !!ask && !asking && !open && <Pressable accessibilityRole="button" accessibilityLabel={`More context on ${q.id}`} accessibilityHint="Ask the agent to explain this question" hitSlop={6} onPress={() => setOpen(true)}
    style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: compact ? 44 : 28, paddingHorizontal: 4, marginLeft: -4, borderRadius: 6, opacity: pressed ? 0.7 : 1, backgroundColor: hovered ? withAlpha(c.foreground, 0.05) : "transparent" })}>
    <Icon name="Sparkles" size={14} color={c.foregroundMuted} />
    <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>{request ? "Ask more" : "More context"}</Text>
  </Pressable>;
  if (!ask && !request && !children) return null;
  return <View {...({ dataSet: { moreContext: q.id } } as object)} style={{ gap: 8 }}>
    {request && <ContextAnswer theme={theme} compact={compact} request={request} waiting={false} onQuestion agent="the agent"
      openChat={() => { if (chatOf) openAgent?.(chatOf); }} chatDisabled={!openAgent || !chatOf} openAgent={openAgent} />}
    {open && ask && <MoveResult place="sheet" inset theme={theme} label="More context">
      <MorePanel theme={theme} compact={compact} onClose={() => setOpen(false)} onAsk={onAsk} target={{ kind: "workspace", workspaceId: w.id }}
        footnote="Keep going meanwhile: the answer shows on this question here, on Home and in Catch up." />
    </MoveResult>}
    {(link || children) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 16 }}>{link}{children}</View>}
  </View>;
}

/**
 * Where a move's result opens (MOVE_OPENS, a-move-bar-action-opens-in-view): a sheet in the phone's dock or a popover
 * on its desktop button. Focus moves into it (its first choice), and on the web it scrolls into view the least distance.
 */
export function MoveResult({ place, theme, label, width, inset = false, children, onClose }: { place: "sheet" | "popover"; theme: Theme; label: string; width?: number; /** Inside a card: no margins of its own. */ inset?: boolean; children: ReactNode; onClose?: () => void }) {
  const c = theme.colors;
  const ref = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const t = setTimeout(() => {
      const node = ref.current as unknown as { querySelector?(q: string): { focus?(o?: object): void } | null; scrollIntoView?(o: object): void } | null;
      node?.scrollIntoView?.({ block: "nearest" });
      // The first choice: More context's suggestions ("I don't get it" leads), else Later's first time.
      (node?.querySelector?.('[role="radio"]') ?? node?.querySelector?.('[role="menu"] [role="button"]'))?.focus?.({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (place === "popover") return <FloatingSurface side="above" dataSet={{ moveResult: place }} width={width} onClose={onClose} label={label} contentRef={ref}
    style={{ padding: 16, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>{children}</FloatingSurface>;
  return <View ref={ref} {...({ dataSet: { moveResult: place } } as object)} role="dialog" accessibilityLabel={label}
    style={[{ padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
      inset ? {} : { marginHorizontal: 12, marginTop: 12 }]}>
    {children}
  </View>;
}

/** What came back for this card: the answer, "answered in its chat", a failure, or (seen going Back) that it's still asking. */
export function ContextAnswer({ theme, compact, request, waiting, agent, openChat, openAgent, onQuestion = false, chatDisabled = false }: { theme: Theme; compact: boolean; request: ContextRequest; waiting: boolean; agent: string; openChat: () => void; openAgent?: (agentId: string) => void;
  /** On a question card outside Catch up: a pending ask says where its answer will show. */ onQuestion?: boolean; chatDisabled?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const who = request.target === "overseer" ? "Overseer" : agent === "the agent" ? "The agent" : agent;
  const asking = request.state === "asking";
  return <View accessibilityLiveRegion="polite" style={{ gap: 8, padding: compact ? 14 : 16, borderRadius: 12, borderWidth: 1, borderColor: asking ? c.border : withAlpha(c.statusSuccess, 0.4), backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={asking ? "Hourglass" : request.state === "failed" ? "CircleAlert" : "Sparkles"} size={14} color={request.state === "failed" ? c.statusDanger : c.foregroundMuted} />
      <RichText plain style={[t.small, { flex: 1 }]}>{asking ? `Asked ${who === "Overseer" ? "the Overseer" : who === "The agent" ? "the agent" : who}${waiting ? " · this comes back as the next card when it answers. You can still act on it now" : onQuestion ? " · the answer shows here when it comes. You can still answer now" : ""}` : `${who} · you asked: ${askHeadline(request.ask)}`}</RichText>
    </View>
    {request.state === "answered" && request.answer && <RichText selectable style={t.body}>{request.answer}</RichText>}
    {/* Turn-end capture: the agent ended its turn without context_reply, and its last message after the ask is the answer. */}
    {request.state === "chat" && request.answer && <View style={{ gap: 4 }}>
      <RichText selectable style={t.body}>{request.answer}</RichText>
      <Text style={t.small}>From its chat: the agent answered there, not with a reply here.</Text>
    </View>}
    {request.state === "chat" && !request.answer && <View style={{ gap: 8 }}>
      <Text style={t.body}>{who === "Overseer" ? "The Overseer answered in its own chat, not here: it can't reply on a card." : `${who} answered in its chat.`}</Text>
      {/* A 2.2.0-beta.3 ask of the Overseer: its answer is in the Overseer's chat (an-ask-goes-only-to-an-agent-that-can-answer-it). */}
      <View style={{ flexDirection: "row" }}>{who === "Overseer"
        ? <Button theme={theme} compact={compact} icon="MessageSquare" title="Open Overseer" disabled={!request.askedOf || !openAgent} onPress={() => request.askedOf && openAgent?.(request.askedOf)} />
        : <Button theme={theme} compact={compact} icon="MessageSquare" title="Open chat" disabled={chatDisabled} onPress={openChat} />}</View>
    </View>}
    {request.state === "failed" && <Text style={t.body}>{request.error ?? "The ask didn't go through. Try again, or open the chat."}</Text>}
  </View>;
}

/**
 * More context: "I don't get it" first (most asks just need explaining), then the developer's own words, to one place:
 * the card's workspace's main agent, the one that can answer on the card (an-ask-goes-only-to-an-agent-that-can-answer-
 * it). It may wake, because the developer asked. The deck moves on and this workspace comes back when the answer is ready.
 */
export function MorePanel({ theme, compact, onClose, onAsk, footnote = CATCH_UP_FOOTNOTE, target }: { theme: Theme; compact: boolean; onClose: () => void;
  /** `images`: pasted on the ask (every-agent-field-takes-images); they ride the ask to the card's main agent. */
  onAsk: (words: string, images?: ImageUpload[]) => Promise<void>; /** What happens while the agent answers, in this surface's terms. */ footnote?: string;
  /** The card's workspace: its main agent gets the ask (an-ask-goes-only-to-an-agent-that-can-answer-it). */
  target: ImageTarget | null }) {
  const c = theme.colors; const t = text(c, compact);
  const img = useImageAttachments({ target });
  const [words, setWords] = useState<string>(CONTEXT_ASKS[0].text);
  const [picked, setPicked] = useState<string>(CONTEXT_ASKS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    if (!words.trim() || busy || img.blocked) return;
    setBusy(true); setError(null);
    // The words and images stay unless the ask is recorded.
    onAsk(words.trim(), img.uploads()).then(() => img.clear(), e => setError(errorText(e))).finally(() => setBusy(false));
  };
  return <View {...({ dataSet: { catchUpMore: "1" } } as object)} style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="Sparkles" size={14} color={c.foreground} />
      <Text style={[t.label, { flex: 1, fontWeight: "600" }]}>More context</Text>
      <IconButton theme={theme} compact={compact} icon="X" label="Close more context" onPress={onClose} />
    </View>
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {CONTEXT_ASKS.map((x, i) => <Pressable key={x.id} accessibilityLabel={compact ? x.label : `${x.label} (${i + 1})`} accessibilityRole="radio" accessibilityState={{ checked: picked === x.id }} onPress={() => { setPicked(x.id); setWords(x.text); }}
        style={{ minHeight: compact ? 36 : 28, justifyContent: "center", paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: picked === x.id ? c.foreground : c.border, backgroundColor: picked === x.id ? c.surface2 : "transparent" }}>
        <Text style={[t.meta, { color: picked === x.id ? c.foreground : c.foregroundMuted }]}>{x.label}</Text>
      </Pressable>)}
    </View>
    <View {...PRIMARY_FORM} style={{ gap: 10 }}>
    <ImageField model={img} theme={theme} compact={compact}><TextInput accessibilityLabel="What do you want to know?" placeholder="What do you want to know?" placeholderTextColor={c.foregroundMuted} value={words} multiline
      onChangeText={v => { setWords(v); setPicked(CONTEXT_ASKS.find(x => x.text === v)?.id ?? ""); }}
      style={{ minHeight: compact ? 84 : 76, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} /></ImageField>
    {!!error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    <View {...({ dataSet: { askAgent: "1" } } as object)} style={{ flexDirection: "row" }}>
      <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="MessageSquareText" title="Ask the agent" loading={busy} disabled={!words.trim() || busy || !!img.blocked}
        accessibilityHint={compact ? "Asks this workspace's main agent, which may wake it" : `Asks this workspace's main agent, which may wake it. ${keyLabel("⌘↵", isMac())}`} onPress={send} />
    </View>
    </View>
    <Text style={t.small}>{footnote}</Text>
  </View>;
}

