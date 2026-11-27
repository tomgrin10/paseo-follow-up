// Your questions (docs/needs-you.md#your-questions): what the developer asked an agent, and what came of it. One card,
// the same component in the workspace panel and Home's detail pane, under Needs you: the ask field, unread answers in
// full with Done · Reply · Make a task · ⋯, questions still asking, and the history. It reads the client's one store of
// questions (Home's extras, kept current by the home feed; client/more-context.tsx), so nothing polls, and every act is
// one request (`follow.question-action`, which the agent tool `question_action` also makes).
import { PagedRows } from "./paged-list";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View, type StyleProp, type TextStyle } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal, TextInput, copyText } from "@getpaseo/plugin/client/ui";
import type { ContextRequest } from "../shared/catch-up";
import { HISTORY_FILTERS, askingNow, questionCounts, questionHistory, questionOutcome, questionSource, unreadAnswer, type HistoryFilter, type QuestionAction } from "../shared/your-questions";
import { ago } from "../shared/attention";
import { errorText } from "../shared/errors";
import { Button, IconButton, SubmitScope, text, useNow, type Theme } from "./kit";
import { raised, tint, withAlpha } from "./theme";
import { FoldButton, PANEL_FOLDS, useFold } from "./fold";
import { RichText } from "./rich-text";
import { Spinner } from "./motion";
import { PRIMARY_FORM } from "./dock";
import { DictationField, useCaret, type FieldPad } from "./dictation";
import { ImageField, useImageAttachments } from "./image-attach";
import type { ImageTarget, ImageUpload } from "../shared/images";
import { useContextStore } from "./more-context";
import { notice } from "./toast-store";
import type { PaseoWorkspaces } from "./home-data";

export const ASK_HINT = "The answer lands here. In a chat, /ask does the same.";
const FILTER_LABEL: Record<HistoryFilter, string> = { all: "All", open: "Open", tasks: "Tasks" };

/** This workspace's questions from the one store: unread answers and asking ones newest first, and the whole history. */
export function useWorkspaceQuestions(workspaceId: string) {
  const { source, requests } = useContextStore();
  return useMemo(() => {
    const mine = requests.filter(r => r.workspaceId === workspaceId);
    const newest = [...mine].reverse();
    return { source, all: mine, unread: newest.filter(unreadAnswer), asking: newest.filter(askingNow) };
  }, [source, requests, workspaceId]);
}

/** One act on a question through the store; the store shows its result at once. Throws the server's refusal. */
export function useQuestionActs() {
  const { source } = useContextStore();
  return {
    ready: !!source?.questionAction,
    act: async (id: string, action: QuestionAction, extra: { text?: string; images?: ImageUpload[] } = {}) => {
      if (!source?.questionAction) throw new Error("Follow-up isn't connected yet.");
      return source.questionAction({ id, action, ...(extra.text ? { text: extra.text } : {}), ...(extra.images?.length ? { images: extra.images } : {}) });
    },
    ask: async (input: { workspaceId: string | null; agentId?: string | null; ask: string; via: "field" | "slash" | "more"; cardKey?: string | null; card?: string; images?: ImageUpload[] }) => {
      if (!source) throw new Error("Follow-up isn't connected yet.");
      const { images, ...rest } = input;
      return (await source.askContext({ ...rest, ...(images?.length ? { images } : {}) })).request;
    },
  };
}

/** The answer's state line: "Answered · 4m ago · main agent", "Answered · from its chat", "Couldn't ask". */
export function answerMeta(r: ContextRequest, now: number, mainAgentId?: string | null): string {
  const who = !r.askedOf ? "" : r.askedOf === mainAgentId ? "main agent" : "another agent";
  const how = r.state === "failed" ? "Couldn't ask" : r.state === "chat" ? r.answer ? "Answered · from its chat" : "Answered in its chat" : "Answered";
  return [how, ago(r.settledAt ?? r.askedAt, now), who].filter(Boolean).join(" · ");
}

/** An answer's words: `code` spans in the mono face on a quiet tint (no literal backticks); the rest stays RichText (links). */
function AnswerText({ children, style, theme }: { children: string; style: StyleProp<TextStyle>; theme: Theme }) {
  // Paragraphs a half line apart, not a whole blank line.
  const paras = children.split(/\n\s*\n/).filter(p => p.trim());
  if (paras.length > 1) return <View style={{ gap: 8 }}>{paras.map((p, i) => <AnswerText key={i} style={style} theme={theme}>{p}</AnswerText>)}</View>;
  const parts = children.split(/`([^`\n]+)`/);
  if (parts.length === 1) return <RichText selectable style={style}>{children}</RichText>;
  const c = theme.colors;
  return <Text selectable style={style}>{parts.map((p, i) => i % 2
    ? <Text key={i} style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, backgroundColor: c.surface2, borderRadius: 3, ...(Platform.OS === "web" && p.length <= 40 ? { whiteSpace: "nowrap" } as object : {}) }}>{p}</Text>
    : <RichText key={i} selectable>{p}</RichText>)}</Text>;
}

/** The question, then its answer quoted (or why there's none). The same on the card, Catch up's card and the history. */
export function AnswerView({ r, theme, compact, now, mainAgentId, meta = true, big = false }: { r: ContextRequest; theme: Theme; compact: boolean; now: number; mainAgentId?: string | null; meta?: boolean; big?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const dot = r.state === "failed" ? c.statusDanger : c.statusWarning;
  return <View style={{ gap: 8 }}>
    {meta && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <Text style={[t.meta, { flex: 1 }]}>{answerMeta(r, now, mainAgentId)}</Text>
    </View>}
    <RichText selectable style={big ? [t.title, compact ? {} : { fontSize: 17, lineHeight: 24, fontWeight: "500" }] : [t.body, { fontSize: compact ? 15 : 14, lineHeight: compact ? 22 : 20 }]}>{r.ask}</RichText>
    {r.answer ? <View style={{ borderLeftWidth: 2, borderLeftColor: withAlpha(c.foregroundMuted, 0.4), paddingLeft: 12 }}>
      <AnswerText theme={theme} style={[t.body, { fontSize: compact ? 15 : 14, lineHeight: compact ? 23 : 21 }]}>{r.answer}</AnswerText>
    </View>
      : r.state === "chat" ? <Text style={t.meta}>The agent ended its turn without answering here. Its answer is in its chat.</Text>
      : r.state === "failed" ? <Text style={[t.meta, { color: c.statusDanger }]}>{r.error ?? "The question didn't reach the agent."}</Text>
      : null}
  </View>;
}

/**
 * What to do with an answer: Done (primary), Reply, Make a task, and ⋯ (Copy, Open in chat). Only what the server
 * takes: no Make a task without an answer, Ask again in place of Reply for a failed ask. `keys`: Catch up's desktop
 * card names its keys (D, W, T, O). `bar`: a phone's thumb bar (Done grows, Make a task reads "Task").
 */
export function AnswerActions({ r, theme, compact, onDone, onReply, onTask, onAskAgain, openChat, busy, keys = false, bar = false, extra }: {
  r: ContextRequest; theme: Theme; compact: boolean; onDone: () => void; onReply: () => void; onTask: () => void; onAskAgain: () => void; openChat?: () => void;
  busy: QuestionAction | "again" | null; keys?: boolean; bar?: boolean; /** More items for ⋯ (Catch up: Skip). */ extra?: ReactNode;
}) {
  const c = theme.colors; const t = text(c, compact);
  const [more, setMore] = useState(false);
  // A narrow row can't hold Done · Reply · Make a task · ⋯ on one line: Make a task reads "Task" there (its label stays
  // whole), and narrower still (a phone's panel, ~306 pt) Done, Reply and Task drop their icons, so the row never wraps.
  const [width, setWidth] = useState(0);
  const narrow = width > 0 && width < (keys ? 440 : 380);
  const tight = width > 0 && width < (compact ? 340 : 300);
  const failed = r.state === "failed";
  const k = (key: string) => keys && !compact ? ` (${key})` : "";
  const copy = () => { void copyText(r.answer ? `Q: ${r.ask}\nA: ${r.answer}` : r.ask).then(() => notice("Copied the question and its answer")).catch(() => undefined); setMore(false); };
  const menu = more && <View accessibilityLabel="More actions" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
    {!!r.answer && <Button theme={theme} compact={compact} kind="ghost" icon="Copy" title="Copy" accessibilityLabel="Copy the question and its answer" onPress={copy} />}
    {openChat && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title={`Open in chat${k("O")}`} accessibilityLabel={`Open in chat${k("O")}`} onPress={() => { setMore(false); openChat(); }} />}
    {extra}
  </View>;
  return <View style={{ gap: 8 }}>
    {/* ⋯ sits outside the wrapping group, so it stays at the row's end when the buttons wrap. */}
    <View onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: bar ? "nowrap" : "wrap", gap: 8, flexShrink: 1, minWidth: 0 }}>
      <Button theme={theme} compact={compact} grow={bar} kind="primary" icon={tight ? undefined : "Check"} title={`Done${k("D")}`} accessibilityLabel={`Done${k("D")}`} accessibilityHint="Marks the answer read; it stays in the history" loading={busy === "done"} disabled={!!busy} onPress={onDone} />
      {failed ? <Button theme={theme} compact={compact} icon="RotateCcw" title="Ask again" loading={busy === "again"} disabled={!!busy} onPress={onAskAgain} />
        : <Button theme={theme} compact={compact} icon={tight ? undefined : "Reply"} title={`Reply${k("W")}`} accessibilityLabel={`Reply${k("W")}`} accessibilityHint="Asks a follow-up question in the same thread" disabled={!!busy} onPress={onReply} />}
      {!!r.answer && !failed && <Button theme={theme} compact={compact} icon={tight ? undefined : "ListTodo"} title={`${bar || narrow ? "Task" : "Make a task"}${k("T")}`} accessibilityLabel={`Make a task${k("T")}`} accessibilityHint="Adds a task for the agent that answered, with this question and answer as its note" loading={busy === "task"} disabled={!!busy} onPress={onTask} />}
      {!r.answer && r.state === "chat" && openChat && <Button theme={theme} compact={compact} icon="MessageSquare" title={`Open chat${k("O")}`} accessibilityLabel={`Open chat${k("O")}`} onPress={openChat} />}
    </View>
      <IconButton theme={theme} compact={compact} icon="Ellipsis" label={more ? "Fewer actions" : "More actions"} tooltip={!compact} onPress={() => setMore(v => !v)} />
    </View>
    {menu}
    {!!r.answer && r.state === "chat" && <Text style={t.small}>Taken from its chat: the agent ended its turn without answering here.</Text>}
  </View>;
}

/** A text field that reaches an agent: Paseo's dictation inside it, pasted images on it (every-agent-field-takes-images). */
function AgentField({ theme, compact, label, placeholder, value, onChange, disabled, autoFocus, lines = 1, img, right }: {
  theme: Theme; compact: boolean; label: string; placeholder: string; value: string; onChange: (v: string) => void; disabled?: boolean; autoFocus?: boolean; lines?: number;
  img: ReturnType<typeof useImageAttachments>; right?: ReactNode;
}) {
  const c = theme.colors;
  const caret = useCaret();
  // One focus ring: the field's own border turns accent; the browser's outline stays off (as in new-settings.tsx).
  const [focused, setFocused] = useState(false);
  const field = (pad: FieldPad) => <TextInput accessibilityLabel={label} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} value={value} onChangeText={onChange} onSelectionChange={caret.onSelectionChange}
    multiline editable={!disabled} autoFocus={autoFocus} maxLength={2000} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={[{ minHeight: compact ? 44 : lines > 1 ? 56 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: focused ? c.accent : c.border, color: c.foreground, backgroundColor: c.surface0, fontSize: compact ? 15 : 13,
      ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : null) }, pad]} />;
  return <ImageField model={img} theme={theme} compact={compact}><View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
    <View style={{ flex: 1, minWidth: 0 }}><DictationField theme={theme} compact={compact} field={field} disabled={disabled} onText={said => onChange(caret.insert(value, said, 2000))} /></View>
    {right}
  </View></ImageField>;
}

/** Reply: an inline field under the answer. It asks a follow-up in the same thread, of the same agent. */
export function ReplyForm({ r, theme, compact, onSent, onCancel }: { r: ContextRequest; theme: Theme; compact: boolean; onSent: () => void; onCancel: () => void }) {
  const c = theme.colors;
  const acts = useQuestionActs();
  const img = useImageAttachments({ target: (r.askedOf ? { kind: "agent", agentId: r.askedOf } : r.workspaceId ? { kind: "workspace", workspaceId: r.workspaceId } : null) as ImageTarget | null });
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    if (!words.trim() || busy || img.blocked) return;
    setBusy(true); setError(null);
    acts.act(r.id, "reply", { text: words.trim(), images: img.uploads() }).then(() => { img.clear(); setWords(""); onSent(); }, e => setError(errorText(e))).finally(() => setBusy(false));
  };
  return <SubmitScope enabled={!!words.trim() && !busy && !img.blocked} onSubmit={send}><View {...PRIMARY_FORM} style={{ gap: 8 }}>
    <AgentField theme={theme} compact={compact} label="Your reply" placeholder="Ask a follow-up…" value={words} onChange={setWords} disabled={busy} autoFocus lines={2} img={img} />
    {!!error && <Text accessibilityRole="alert" style={[text(c, compact).meta, { color: c.statusDanger }]}>{error}</Text>}
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      <Button theme={theme} compact={compact} kind="ghost" title="Cancel" onPress={onCancel} />
      <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Send" title="Send reply" shortcut loading={busy} disabled={!words.trim() || busy || !!img.blocked} onPress={send} />
    </View>
  </View></SubmitScope>;
}

/** One unread answer on the card: the answer in full, its actions, and Reply's field when open. */
function AnswerItem({ r, theme, compact, now, mainAgentId, openAgent }: { r: ContextRequest; theme: Theme; compact: boolean; now: number; mainAgentId: string | null; openAgent?: (agentId: string) => void }) {
  const c = theme.colors;
  const acts = useQuestionActs();
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState<QuestionAction | "again" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (what: QuestionAction | "again", work: () => Promise<unknown>, done?: string) => {
    setBusy(what); setError(null);
    work().then(() => { if (done) notice(done); }, e => setError(errorText(e))).finally(() => setBusy(null));
  };
  const openChat = openAgent && r.askedOf ? () => openAgent(r.askedOf!) : undefined;
  return <View {...({ dataSet: { yourQuestion: r.id } } as object)} style={{ gap: 10, paddingHorizontal: compact ? 14 : 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border }}>
    <AnswerView r={r} theme={theme} compact={compact} now={now} mainAgentId={mainAgentId} />
    {replying ? <ReplyForm r={r} theme={theme} compact={compact} onCancel={() => setReplying(false)} onSent={() => { setReplying(false); notice("Reply sent · it shows here while the agent answers"); }} />
      : <AnswerActions r={r} theme={theme} compact={compact} busy={busy} openChat={openChat}
        onDone={() => run("done", () => acts.act(r.id, "done"), "Done · in History")}
        onReply={() => setReplying(true)}
        onTask={() => run("task", () => acts.act(r.id, "task"), "Made a task for the agent that answered")}
        onAskAgain={() => run("again", async () => { await acts.ask({ workspaceId: r.workspaceId, agentId: r.cardKey ? r.agentId : r.askedOf, cardKey: r.cardKey, card: r.card || undefined, ask: r.ask, via: r.via === "slash" ? "slash" : r.cardKey ? "more" : "field" }); await acts.act(r.id, "done"); })} />}
    {!!error && <Text accessibilityRole="alert" style={[text(c, compact).meta, { color: c.statusDanger }]}>{error}</Text>}
  </View>;
}

/** A question still asking: spinner, when it was sent, and Withdraw (never Done: there is nothing to read yet). */
function AskingItem({ r, theme, compact, now, busyAgent }: { r: ContextRequest; theme: Theme; compact: boolean; now: number; /** The workspace is running (Paseo's directory): the question waits for the turn to end. */ busyAgent: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const acts = useQuestionActs();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = () => { setBusy(true); setError(null); acts.act(r.id, "withdraw").then(() => notice("Withdrawn · in History"), e => setError(errorText(e))).finally(() => { setBusy(false); setConfirm(false); }); };
  const line = `Asking · ${r.deliveredAt ? `sent ${ago(r.deliveredAt, now)}` : `queued ${ago(r.askedAt, now)}`}${busyAgent ? " · the agent is mid-turn" : ""}`;
  return <View {...({ dataSet: { yourQuestion: r.id } } as object)} style={{ gap: 6, paddingHorizontal: compact ? 14 : 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Spinner color={c.foregroundMuted} size={12} label="Asking" />
      <Text style={[t.meta, { flex: 1 }]}>{line}</Text>
      {/* Two presses, like every other removal in Needs you: Withdraw, then Withdraw it or Keep. */}
      {confirm ? <View style={{ flexDirection: "row", gap: 6 }}>
        <Button theme={theme} compact={compact} kind="ghost" title="Keep" disabled={busy} onPress={() => setConfirm(false)} />
        <Button theme={theme} compact={compact} kind="danger" title="Withdraw it" accessibilityLabel={`Withdraw it: ${r.ask.slice(0, 60)}`} accessibilityHint="Takes the question back; a message still queued isn't sent" loading={busy} disabled={busy} onPress={withdraw} />
      </View>
        : <Pressable accessibilityRole="button" accessibilityLabel={`Withdraw: ${r.ask.slice(0, 60)}`} hitSlop={compact ? 12 : 6} onPress={() => setConfirm(true)}
          style={state => ({ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? c.surface1 : "transparent" })}>
          <Text style={t.meta}>Withdraw</Text>
        </Pressable>}
    </View>
    <RichText selectable style={[t.body, { fontSize: compact ? 15 : 14, lineHeight: compact ? 22 : 20 }]}>{r.ask}</RichText>
    {!!error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
  </View>;
}

/** The ask field and its hint line: a free question to the workspace's main agent (follow.context-ask, no card). */
function AskField({ workspaceId, theme, compact, folded = false }: { workspaceId: string; theme: Theme; compact: boolean; /** One line until tapped (Home's phone pane, under the dock's reply field). */ folded?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState(!folded);
  const acts = useQuestionActs();
  const img = useImageAttachments({ target: { kind: "workspace", workspaceId } });
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    if (!words.trim() || busy || img.blocked) return;
    setBusy(true); setError(null);
    // The words and images stay unless the question is recorded.
    acts.ask({ workspaceId, ask: words.trim(), via: "field", images: img.uploads() }).then(() => { setWords(""); img.clear(); }, e => setError(errorText(e))).finally(() => setBusy(false));
  };
  const sendButton = (words.trim() || busy) ? <IconButton theme={theme} compact={compact} icon="Send" label="Ask the main agent" tooltip={!compact} spinning={busy} disabled={!words.trim() || busy || !!img.blocked} color={c.foreground} onPress={send} /> : null;
  // Folded: one quiet row, so the pane shows one text field (the dock's) until you choose to ask.
  if (!open && !words) return <View style={{ paddingHorizontal: compact ? 14 : 12, paddingBottom: 12 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Ask the main agent" accessibilityHint="Opens a field for a question to the workspace's main agent" onPress={() => setOpen(true)}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 10, borderRadius: 6, backgroundColor: pressed ? c.surface2 : c.surface1 })}>
      <Icon name="MessageSquarePlus" size={16} color={c.foregroundMuted} />
      <Text style={[t.body, { color: c.foregroundMuted, flex: 1 }]}>Ask the main agent…</Text>
    </Pressable>
  </View>;
  return <View {...PRIMARY_FORM} style={{ gap: 6, paddingHorizontal: compact ? 14 : 12, paddingBottom: 12 }}>
    <AgentField theme={theme} compact={compact} label="Ask the main agent" placeholder="Ask the main agent…" value={words} onChange={setWords} disabled={busy} autoFocus={folded} img={img} right={sendButton} />
    {!!error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    <Text style={t.small}>{ASK_HINT}</Text>
  </View>;
}

/** One history row: how it ended, when, where from; the question; tap to read the answer; its replies under it. */
function HistoryRow({ r, replies, theme, compact, now, depth = 0 }: { r: ContextRequest; replies: Map<string, ContextRequest[]>; theme: Theme; compact: boolean; now: number; depth?: number }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState(false);
  const unread = unreadAnswer(r);
  const line = [questionOutcome(r), ago(r.settledAt ?? r.askedAt, now), questionSource(r)].filter(Boolean).join(" · ");
  const kids = replies.get(r.id) ?? [];
  const readable = !!r.answer || r.state === "failed";
  return <View>
    <Pressable accessibilityRole="button" aria-expanded={readable ? open : undefined} accessibilityState={readable ? { expanded: open } : undefined} accessibilityLabel={`${r.ask}. ${line}`} disabled={!readable} onPress={() => setOpen(v => !v)}
      style={state => ({ gap: 4, paddingVertical: 10, paddingLeft: 10 + depth * 14, paddingRight: 10, borderTopWidth: depth ? 0 : 1, borderTopColor: c.border, borderRadius: depth ? 6 : 0,
        backgroundColor: (state as { hovered?: boolean }).hovered && readable ? c.surface1 : "transparent" })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {depth > 0 && <Icon name="CornerDownRight" size={12} color={c.foregroundMuted} />}
        <Text style={[t.meta, { flex: 1 }]}>{line}</Text>
        {unread && <View style={{ paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, backgroundColor: tint(c.statusWarning, c) }}><Text style={[t.small, { color: c.statusWarning, fontWeight: "600" }]}>Unread</Text></View>}
        {readable && <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />}
      </View>
      <RichText plain style={[t.body, { fontSize: compact ? 15 : 14, lineHeight: compact ? 22 : 20 }]}>{r.ask}</RichText>
    </Pressable>
    {/* The answer sits below the row's tap target, so its links stay links (rich-text.tsx: no link inside a pressable row). */}
    {open && readable && <View style={{ marginLeft: 22 + depth * 14, marginRight: 10, marginBottom: 10, borderLeftWidth: 2, borderLeftColor: withAlpha(c.foregroundMuted, 0.4), paddingLeft: 12 }}>
      {r.answer ? <AnswerText theme={theme} style={t.body}>{r.answer}</AnswerText> : <Text style={[t.meta, { color: c.statusDanger }]}>{r.error ?? "The question didn't reach the agent."}</Text>}
    </View>}
    {kids.map(k => <HistoryRow key={k.id} r={k} replies={replies} theme={theme} compact={compact} now={now} depth={depth + 1} />)}
  </View>;
}

/** The history: search over questions and answers, All / Open / Tasks, newest first, replies as a thread. */
export function QuestionHistory({ workspaceId, theme, compact }: { workspaceId: string; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const now = useNow(30_000);
  const { all } = useWorkspaceQuestions(workspaceId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const counts = useMemo(() => Object.fromEntries(HISTORY_FILTERS.map(f => [f, questionHistory(all, { filter: f }).length])) as Record<HistoryFilter, number>, [all]);
  const shown = questionHistory(all, { filter, query });
  // A thread: a reply sits under its question when both are shown; otherwise it stands on its own.
  const ids = new Set(shown.map(r => r.id));
  const replies = new Map<string, ContextRequest[]>();
  for (const r of [...shown].reverse()) if (r.parentId && ids.has(r.parentId)) replies.set(r.parentId, [...(replies.get(r.parentId) ?? []), r]);
  const roots = shown.filter(r => !r.parentId || !ids.has(r.parentId));
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, minHeight: compact ? 44 : 34, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
      <Icon name="Search" size={14} color={c.foregroundMuted} />
      <TextInput accessibilityLabel="Search questions and answers" placeholder="Search questions and answers" placeholderTextColor={c.foregroundMuted} value={query} onChangeText={setQuery}
        style={{ flex: 1, minWidth: 0, paddingVertical: 6, color: c.foreground, fontSize: compact ? 15 : 13, outlineStyle: "none" } as object} />
      {!!query && <IconButton theme={theme} compact={compact} icon="X" label="Clear the search" onPress={() => setQuery("")} />}
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel="Show" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {HISTORY_FILTERS.map(f => <Pressable key={f} accessibilityRole="radio" accessibilityState={{ checked: filter === f }} accessibilityLabel={`${FILTER_LABEL[f]}, ${counts[f]}`} onPress={() => setFilter(f)}
        style={{ minHeight: compact ? 44 : 26, justifyContent: "center", paddingHorizontal: 10, borderRadius: 999, backgroundColor: filter === f ? c.foreground : c.surface2 }}>
        <Text style={[t.meta, { color: filter === f ? c.surface0 : c.foregroundMuted, fontWeight: filter === f ? "600" : "400" }]}>{`${FILTER_LABEL[f]} ${counts[f]}`}</Text>
      </Pressable>)}
    </View>
    <View>
      {/* Pages of 25 threads (invariant pr-scale-lists-batch-not-throw, "every list pages"): 30 days of questions never draw at once. */}
      <PagedRows items={roots} searching={!!query} resetKey={`${filter}|${query}`} theme={theme} compact={compact} noun="questions"
        row={r => <HistoryRow key={r.id} r={r} replies={replies} theme={theme} compact={compact} now={now} />} />
      {!roots.length && <Text style={[t.meta, { paddingVertical: 12 }]}>{query ? "No question or answer has those words." : filter === "open" ? "Nothing open: every question has its answer read." : filter === "tasks" ? "No answer has become a task yet." : "No questions yet. Ask one above."}</Text>}
    </View>
  </View>;
}

const noSubscribe = () => () => undefined;
/** Whether Paseo's directory has the workspace running: the store Home and the panel already keep, no read of its own. */
export function useWorkspaceRunning(paseo: PaseoWorkspaces | undefined, workspaceId: string): boolean {
  return useSyncExternalStore(paseo?.subscribe ?? noSubscribe, () => !!paseo?.get(workspaceId)?.archive?.running, () => false);
}

/**
 * The card. `openAgent` opens an agent's chat (absent where there is no navigation). Phones open the history in a
 * sheet; desktop unfolds it in the card.
 */
export function YourQuestionsCard({ workspaceId, mainAgentId, theme, compact, openAgent, style, running = false, foldAsk = false, fold = false }: { workspaceId: string; mainAgentId: string | null; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; style?: object;
  /** Paseo's directory says the workspace is running (no read of its own): asking rows add "the agent is mid-turn". */ running?: boolean;
  /** The pane has a docked reply field: the ask field stays one line until tapped. */ foldAsk?: boolean;
  /** The workspace panel's section: the header folds it (client/fold.tsx), keeping its counts. */ fold?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const now = useNow(30_000);
  const q = useWorkspaceQuestions(workspaceId);
  const [history, setHistory] = useState(false);
  const counts = questionCounts({ unread: q.unread, asking: q.asking });
  const total = q.all.length;
  const folding = useFold(fold ? PANEL_FOLDS.questions : null, true);
  const open = folding.open;
  const headStyle = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: compact ? 14 : 12, paddingTop: 12, paddingBottom: 10, minHeight: compact ? 44 : undefined } as const;
  const headInner = <>
    <Icon name="MessageSquareReply" size={compact ? 16 : 14} color={c.foregroundMuted} />
    <Text accessibilityRole={fold ? undefined : "header"} numberOfLines={fold ? 1 : undefined} style={[t.label, { flex: 1, minWidth: 0 }]}>Your questions</Text>
    {!!counts && <View accessibilityLabel={counts} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {!!q.unread.length && <View style={{ paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, backgroundColor: c.surface2 }}><Text style={[t.meta, { color: c.foreground, fontWeight: "600" }]}>{`${q.unread.length} answer${q.unread.length === 1 ? "" : "s"}`}</Text></View>}
      {!!q.asking.length && <Text style={t.meta}>{`${q.asking.length} asking`}</Text>}
    </View>}
  </>;
  const header = fold
    ? <View accessibilityRole="header"><FoldButton open={open} onToggle={folding.toggle} label={counts ? `Your questions, ${counts}` : "Your questions"} theme={theme} chevron="end"
        style={(hovered, pressed) => [headStyle, { flexWrap: "nowrap", paddingTop: 10, paddingBottom: open ? 8 : 10, backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" }]}>{headInner}</FoldButton></View>
    : <View style={headStyle}>{headInner}</View>;
  const historyRow = total > 0 && <Pressable accessibilityRole="button" aria-expanded={compact ? undefined : history} accessibilityState={compact ? undefined : { expanded: history }} accessibilityLabel={`History, ${total} question${total === 1 ? "" : "s"}`} accessibilityHint="Search every question and answer, kept 30 days" onPress={() => setHistory(v => !v)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 14 : 12, minHeight: compact ? 48 : 38, borderTopWidth: 1, borderTopColor: c.border,
      backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name={!compact && history ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
    <Text style={[t.body, { color: c.foregroundMuted }]}>{`History · ${total}`}</Text>
    <View style={{ flex: 1 }} />
    {!compact && <Text numberOfLines={1} style={t.small}>search, kept 30 days</Text>}
  </Pressable>;
  return <View {...({ dataSet: { yourQuestions: workspaceId } } as object)} style={[{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, backgroundColor: c.surface0, overflow: "hidden" },
    // In the panel it is one of the sections, raised like the others. Amber is Needs you's alone (invariant 135): an
    // unread answer says so in its neutral chip, not with an amber border.
    fold ? raised(c) : { borderWidth: 1, borderColor: c.border }, style]}>
    {header}
    {open && <>
    <AskField workspaceId={workspaceId} theme={theme} compact={compact} folded={foldAsk} />
    {q.unread.map(r => <AnswerItem key={r.id} r={r} theme={theme} compact={compact} now={now} mainAgentId={mainAgentId} openAgent={openAgent} />)}
    {q.asking.map(r => <AskingItem key={r.id} r={r} theme={theme} compact={compact} now={now} busyAgent={!!running} />)}
    {historyRow}
    {!compact && history && <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingTop: 2 }}><QuestionHistory workspaceId={workspaceId} theme={theme} compact={false} /></View>}
    {compact && <Modal title="Your questions" icon={<Icon name="MessageSquareReply" size={18} color={c.foregroundMuted} />} open={history} onOpenChange={next => { if (!next) setHistory(false); }}>
      <Modal.Content contentContainerStyle={{ padding: 16 }}>
        <QuestionHistory workspaceId={workspaceId} theme={theme} compact />
      </Modal.Content>
    </Modal>}
    </>}
  </View>;
}

