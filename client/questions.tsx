// The question dialog and its answer form. The layout of options with a recommendation, the
// "what the agent does meanwhile" line and Copy are adapted from Progress
// (@stevecastaneda/paseo-progress, MIT, © 2026 Steve Castaneda); see THIRD_PARTY_NOTICES.md.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Pressable, Text, copyable } from "./text";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { activityRpc, answerQuestionRpc } from "../shared/contracts";
import { ImageField, useImageAttachments } from "./image-attach";
import type { Workspace } from "../shared/model";
import type { ListQuestion, ListWorkspace } from "../shared/list";
import { OTHER, OTHER_LABEL, closedLine, isDismissed, answerDraft, answerHeading, answerLabel, answerStatus, answerMessage, answerHasActions, resendTitle, isOpen, isOther, isDoneOnly, questionState, TASK_DONE, type Question } from "../shared/questions";
import { ago } from "../shared/attention";
import { RETRYING_DETAIL, deliveryStatus, receiptNote } from "../shared/queue";
import { mootNote, sentence } from "../shared/errors";
import { type ActivityTone } from "../shared/activity";
import { activityPage, type ActivityTab } from "../shared/history";
import { PAGE, pageInfo } from "../shared/paged";
import { Pager } from "./paged-list";
import { Button, Card, CardRow, Chip, FoldRow, IconButton, SubmitScope, errorText, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { DictationField, useCaret, type FieldPad } from "./dictation";
import { NoteLink } from "./brief";
import { QuestionMoreContext } from "./more-context";
import { PRIMARY_FORM } from "./dock";
import { mergedColor, tint, withAlpha, type Colors } from "./theme";
import { activityKey, overviewKey, workspaceKey } from "./keys";
import { PrLinksProvider, RichText } from "./rich-text";
import { prLinksByNumber } from "../shared/presentation";
import { notice, openQuestion, runAction } from "./toasts";
import { DismissX, useDismiss } from "./dismiss";
import { putInChatOrCopy } from "../shared/put-in-chat";
import { useChatComposer } from "./put-in-chat";
import { Marked, NoMatchRow, useSectionSearch } from "./section-search";
import { questionStatus } from "../shared/section-search";
import { answerImagesKey, clearPendingAnswer, failPendingAnswer, pendingKey, setPendingAnswer, usePendingAnswer, usePendingAnswers, type PendingAnswer } from "./pending-answers";

const who = (w: Pick<ListWorkspace, "mainAgentId">, agentId: string | null) => !agentId || agentId === w.mainAgentId ? "the main agent" : "a root session";

/**
 * What the agent is doing while the question is open, in the developer's terms. `pending` is required, so every
 * surface that describes a question also says when the developer's answer didn't reach Paseo, or is on its way;
 * pass null only where the surface shows that itself (QuestionBody's Not sent · Retry line).
 */
export function meanwhile(w: ListWorkspace, q: ListQuestion, pending: PendingAnswer | null | undefined): { icon: string; color: (c: Colors) => string; text: string } {
  if (pending?.error) return { icon: "CircleAlert", color: c => c.statusDanger, text: `Your answer wasn't sent: ${sentence(pending.error)} Open it to retry; your words are kept.` };
  if (pending) return { icon: "Send", color: c => c.foregroundMuted, text: "Sending your answer…" };
  if (q.taskId && q.need === "action") return { icon: "Clock", color: c => c.foregroundMuted, text: "A task waits on this. The agent works on the rest meanwhile." };
  if (q.taskId && !q.options.length) return { icon: "Clock", color: c => c.foregroundMuted, text: "A task is blocked on this. The agent works on the rest." };
  switch (questionState(q)) {
    case "stopped": return { icon: "CirclePause", color: c => c.statusWarning, text: q.big ? `The agent stopped and waits for your answer. Big question: ${q.big}.` : "The agent stopped and waits for your answer." };
    case "building": return { icon: "Hammer", color: c => c.foregroundMuted, text: `The agent is building ${q.recommend} while you decide. Pick another option and it undoes that first.` };
    default: return q.big
      ? { icon: "Hand", color: c => c.statusWarning, text: `Big question: ${q.big}. The agent builds nothing this affects until you answer.` }
      : { icon: "Clock", color: c => c.foregroundMuted, text: "The agent holds what this affects and keeps working on the rest." };
  }
}

function deliveryLine(w: ListWorkspace, q: ListQuestion, now: number): { icon: string; tone: "success" | "warning" | "muted" | "spinner"; text: string } | null {
  const d = q.answer?.delivery;
  if (!d) return null;
  switch (d.state) {
    // Paseo 0.17.2+'s receipt: held until the agent's turn ends (muted, a clock), or a turn stopped to take it.
    case "sent": {
      const note = receiptNote(d.receipt);
      const held = d.receipt?.deliveryStatus === "queued";
      return { icon: held ? "Clock" : "CircleCheck", tone: held ? "muted" : "success", text: `Sent to ${who(w, d.to)} ${ago(d.at, now)}${note ? `. ${note}` : ""}` };
    }
    // The queue's states read one way everywhere (shared/queue.ts deliveryStatus).
    case "sending": case "queued": case "retrying": case "failed": case "cancelled": {
      const s = deliveryStatus({ state: d.state, reason: d.reason, nextAt: d.nextAt });
      return { icon: s.tone === "spinner" ? "" : d.state === "queued" ? "Clock" : d.state === "retrying" ? "RotateCcw" : d.state === "cancelled" ? "CircleSlash" : "TriangleAlert", tone: s.tone === "danger" ? "warning" : s.tone, text: s.detail };
    }
    case "unconfirmed": return { icon: "RotateCcw", tone: "muted", text: RETRYING_DETAIL };
    case "copied": return { icon: "Copy", tone: "muted", text: `Copied ${ago(d.at, now)}. Paste it into the agent's chat, or send it from here.` };
    case "signed-off": return { icon: "Check", tone: "muted", text: `You signed it off ${ago(d.at, now)}; Follow-up didn't see it in the chat.` };
    case "in-chat": return { icon: "MessageSquareText", tone: "muted", text: `Put in ${who(w, d.to)}'s chat ${ago(d.at, now)}. Send it there, or send it from here.` };
    case "recorded": return { icon: "MessageSquare", tone: "muted", text: `You answered in chat; the agent recorded it ${ago(d.at, now)}.` };
  }
}

/** A radio card: the question options, and setup's Updates choice (no letter there). */
export function OptionCard({ theme, letter, label, consequence, recommended, selected, disabled, onPress, compact, dense = false, own = false }: { theme: Theme; letter?: string; own?: boolean; label: string; consequence?: string; recommended: boolean; selected: boolean; disabled: boolean; onPress: () => void; compact: boolean; dense?: boolean }) {
  const c = theme.colors; const t = text(c);
  return <Pressable accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected, disabled }} accessibilityLabel={`${letter ? `${letter}. ` : ""}${label}${recommended ? ". Recommended" : ""}${consequence ? `. ${consequence}` : ""}`}
    disabled={disabled} onPress={onPress}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: dense ? 10 : 12, paddingVertical: compact ? 12 : dense ? 8 : 10, borderRadius: 8, borderWidth: selected ? 1.5 : 1,
      borderColor: selected ? c.accent : c.border, margin: selected ? 0 : 0.5,
      backgroundColor: selected ? withAlpha(c.accent, 0.08) : state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered && !disabled ? c.surface1 : "transparent" })}>
    <View style={{ width: 18, height: 18, marginTop: 1, borderRadius: 9, borderWidth: selected ? 5 : 1.5, borderColor: selected ? c.accent : c.foregroundMuted }} />
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 }}>
        {/* The built-in Something else: a pencil in the letter's slot, so its label lines up with the agent's options. */}
        {own ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name="PenLine" size={12} color={c.foregroundMuted} /><Text style={t.label}>{label}</Text></View>
          : <Text style={t.label}>{letter ? <><Text style={{ fontVariant: ["tabular-nums"] }}>{letter}</Text>{"  "}</> : null}<RichText linkColor={c.foreground} style={t.label}>{label}</RichText></Text>}
        {recommended && <Chip theme={theme} icon="ThumbsUp" label="Recommended" color={c.foregroundMuted} />}
      </View>
      {!!consequence && <RichText selectable={copyable} linkColor={c.foreground} numberOfLines={dense ? 2 : undefined} style={t.meta}>{consequence}</RichText>}
    </View>
  </Pressable>;
}

const inputStyle = (c: Colors, compact: boolean, lines: number) => ({ minHeight: compact ? 44 : 18 * lines + 16, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface1, fontSize: 13, lineHeight: 18, textAlignVertical: "top" as const });
/** The actions row width (px) from which Done shows its ⌘↵ hint (one-done-button). */
const DONE_HINT_MIN_WIDTH = 400;

/** A sendable answer, handed to a surface that also offers Send outside the form (Catch up's move bar). */
export type SendReady = { send: () => void; busy: boolean };

/**
 * One question with its answer form. Send records the answer and messages the asking agent straight
 * away; Copy records it and puts a reply on the clipboard instead. The one answer flow every question surface draws
 * (the dialog, Needs you on Home and in the panel, the pill, phones): what its field means comes from answerDraft
 * (`one-answer-flow-for-every-question`), never from the surface.
 */
export function QuestionBody({ workspace: w, question: q, theme, compact, now = Date.now(), dense = false, bodyMaxHeight, openAgent, onAnswered, onDetails, onClose, inline = false, onSendReady, dictate = false, moreContext = true, dismissAt = inline ? "host" : "top", afterAsk }: {
  /** What the host card says about the ask (the brief's context, what the agent does meanwhile), right under the ask: the ask reads first on every surface. */
  afterAsk?: ReactNode;
  workspace: ListWorkspace; question: ListQuestion; theme: Theme; compact: boolean; now?: number; dense?: boolean; bodyMaxHeight?: number; openAgent?: (agentId: string) => void; onAnswered?: () => void; onDetails?: () => void;
  /** Inside the Needs you block: its header says the title and when it was asked, its footer what the agent does meanwhile. */
  inline?: boolean;
  /**
   * Where the card's small x sits (dismissing-anything-in-needs-you-sends-the-agent-nothing): "top", the body's top
   * right; "host", in the header of whatever draws this body (the Needs you block, the pill, Catch up), next to its age;
   * "foot", at the end of the "Asked … by" line, for the dialog, whose header's top right is its own close.
   */
  dismissAt?: "top" | "host" | "foot";
  /** The dialog's close: Send and Copy close it at once and report the outcome as a toast. */
  onClose?: () => void;
  /**
   * Catch up's move bar: told whenever this answer becomes sendable (or stops being), with this form's own Send, so a
   * Send outside the card runs exactly this flow (`one-answer-flow-for-every-question`), never a copy of it.
   */
  onSendReady?: (send: SendReady | null) => void;
  /** Catch up: a mic beside the field (DictationField), when the host has Paseo's dictation. */
  dictate?: boolean;
  /**
   * More context on the question (more-context-is-the-same-on-every-surface). Catch up passes false: its move bar has
   * the same More context, and its card shows the answer.
   */
  moreContext?: boolean;
}) {
  const c = theme.colors; const t = text(c);
  const toast = useToast(); const cache = useQueryClient();
  const answerRpc = useRpc(answerQuestionRpc);
  const open = isOpen(q);
  // Paseo 0.16: the asking agent's composer, for Put in chat. Null on 0.15, or when the app doesn't know that agent.
  const asker = q.askedBy ?? w.mainAgentId ?? null;
  const composer = useChatComposer(open || q.answer?.delivery.state === "in-chat" ? asker : null);
  // Pasted images (every-agent-field-takes-images) ride the answer's message to the asking agent, on Send only.
  // A failed send keeps them under the answer's key (pending-answers), so the card's Retry sends them again.
  const img = useImageAttachments({ target: asker ? { kind: "agent", agentId: asker } : { kind: "workspace", workspaceId: w.id }, keep: answerImagesKey(w.id, q.id) });
  const [choice, setChoice] = useState<string | null>(q.answer?.choice ?? null);
  const [words, setWords] = useState(q.answer?.words ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  // The pill's scrolling body: track whether more sits below the fold, so it can say so.
  const [scroll, setScroll] = useState({ content: 0, view: 0, offset: 0 });
  const more = scroll.content - scroll.view - scroll.offset > 4;
  // An answer that didn't reach the server comes back filled in ("Not sent · Retry"), so nothing typed is lost.
  const pending = usePendingAnswer(w.id, q.id);
  const unsent = open && pending?.error ? pending : undefined;
  // Answered or withdrawn elsewhere since: the unsent copy has nothing left to do.
  useEffect(() => { if (pending && !open) clearPendingAnswer(w.id, q.id); }, [open, !!pending]);
  useEffect(() => { setChoice(unsent?.choice ?? q.answer?.choice ?? null); setWords(unsent?.words ?? q.answer?.words ?? ""); }, [q.id, !!unsent]);
  const refresh = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const free = !q.options.length;
  // The field is shown only once its role is known: Something else (the answer, so Send waits for words) or Add note
  // on a lettered pick. One rule for every surface (shared/questions.ts answerDraft).
  const draft = answerDraft(q, { choice, words, noteOpen });
  const caret = useCaret();
  const other = draft.own;
  const answer = draft.answer;
  // What Send sends with the answer: Something else's words or a pick's note, from the draft (what-you-typed-is-what-gets-sent).
  const sentWords = draft.words;
  // one-done-button: an action card is answered by Done itself; the options and Send appear only for Reply instead.
  const doneOnly = open && isDoneOnly(q) && !other;
  // Done keeps its ⌘↵ hint where the row fits Done, the hint, Add note and Reply instead on one line (Home's pane);
  // the narrow panel drops the hint so Reply instead doesn't wrap. Ctrl+Enter sends Done either way.
  const [rowWidth, setRowWidth] = useState(0);
  const done = () => quick("send", { choice: TASK_DONE.letter, words: choice === TASK_DONE.letter ? sentWords : undefined });
  const run = useMutation({
    mutationFn: async (action: "send" | "copy" | "resend") => {
      if (action === "copy") await copyText(answerMessage(q, q.answer?.choice ?? answer!, q.answer?.words ?? sentWords));
      return answerRpc({ workspaceId: w.id, questionId: q.id, choice: q.answer?.choice ?? answer!, words: q.answer?.words ?? sentWords, action });
    },
    onSuccess: (result, action) => {
      const d = result.question.answer?.delivery;
      if (action === "copy") toast.show(`Copied the ${q.id} answer. Paste it into the agent's chat.`, { variant: "success" });
      else if (d?.state === "sent") toast.show(`Sent your ${q.id} answer to the agent`, { variant: "success" });
      else if (d?.state === "failed" || d?.state === "cancelled") toast.show(deliveryStatus({ state: d.state, reason: d.reason }).detail, { variant: "warning" });
      else toast.show(`Answer saved. Follow-up delivers it and retries on its own.`, { variant: "info" });
      refresh();
    },
    onError: error => { toast.error(errorText(error)); refresh(); },
  });
  /**
   * Send (or Copy) from an open question closes the dialog or moves the pill on at once; the server call runs in
   * the background and its outcome is a toast. The answer is kept in pending-answers until the server has it.
   */
  /**
   * Put in chat: the answer goes into the asking agent's composer (put-in-chat-never-rewrites-a-draft) and is recorded
   * as in-chat once it is there. When the composer can't be reached nothing was inserted, so it falls back to Copy.
   */
  const putIn = () => {
    if (!answer || !composer) return;
    const message = answerMessage(q, answer, sentWords);
    onClose?.();
    void putInChatOrCopy(composer, message, {
      inChat: () => quick("chat"),
      copy: () => { toast.show("Couldn't open the agent's chat, so your answer was copied instead.", { variant: "info" }); quick("copy"); },
    });
  };
  const quick = (action: "send" | "copy" | "chat", pick?: { choice: string; words?: string }) => {
    const chosen = pick?.choice ?? answer; const said = pick ? pick.words : sentWords;
    if (!chosen) return;
    const images = action === "send" ? img.uploads() : undefined;
    const input = { workspaceId: w.id, questionId: q.id, choice: chosen, words: said, action, ...(images ? { images } : {}) };
    if (action === "copy") void copyText(answerMessage(q, chosen, said)).catch(() => undefined);
    // The unsent copy keeps exactly what was sent, so Retry (which rebuilds the draft from it) sends it again.
    setPendingAnswer(w.id, q.id, { choice: chosen, words: said, images });
    const agent = who(w, q.askedBy);
    void runAction({
      label: `Answer to ${q.id}`, toast, run: () => answerRpc(input),
      success: result => {
        const d = result.question.answer?.delivery;
        if (action === "copy") return { message: `Copied the ${q.id} answer. Paste it into the agent's chat.` };
        if (action === "chat") return { message: `Your ${q.id} answer is in ${agent}'s chat. Send it there.` };
        if (d?.state === "sent") return { message: `Sent to ${agent}` };
        if (d?.state === "failed" || d?.state === "cancelled") return { tone: "warning", message: deliveryStatus({ state: d.state, reason: d.reason }).detail };
        // Recorded and queued: Follow-up sends it within seconds and retries on its own.
        return { message: `Sending to ${agent}` };
      },
      onSuccess: () => { clearPendingAnswer(w.id, q.id); img.clear(); refresh(); },
      onError: error => { failPendingAnswer(w.id, q.id, errorText(error)); refresh(); },
      // Answered or withdrawn elsewhere first: nothing to retry. Drop the unsent copy; the card shows the recorded answer.
      reconcile: e => { clearPendingAnswer(w.id, q.id); refresh(); notice(mootNote(e, free || isOther(answer)), toast); },
      failure: `Answer to ${q.id} not sent`, open: () => openQuestion(w.id, q.id),
    });
    onClose?.(); onAnswered?.();
  };
  /**
   * Dismiss (dismissing-anything-in-needs-you-sends-the-agent-nothing): the question no longer matters. It closes and
   * leaves Needs you; nothing goes to the agent. Undo in the toast reopens it. The card moves on as after an answer.
   */
  const dismissAny = useDismiss();
  const dismissX = open && dismissAt !== "host" ? <QuestionDismissX workspaceId={w.id} questionId={q.id} theme={theme} compact={compact} disabled={run.isPending} onDismissed={() => { onClose?.(); onAnswered?.(); }} dismiss={dismissAny} /> : null;
  // The footer's Send calls the latest quick through a ref, so it never sends a stale choice or words.
  // On an action card the form's Send is Done (one-done-button), wherever it is pressed from.
  const quickRef = useRef(quick); quickRef.current = doneOnly ? (action: "send" | "copy" | "chat") => action === "send" ? done() : quick(action) : quick;
  const sendable = open && (!!answer || doneOnly) && !img.blocked;
  useEffect(() => { onSendReady?.(sendable ? { send: () => quickRef.current("send"), busy: run.isPending } : null); }, [sendable, run.isPending]);
  useEffect(() => () => onSendReady?.(null), []);
  // The body says Not sent · Retry itself, with the button; the state line stays on what the agent is doing.
  const state = meanwhile(w, q, null);
  const delivery = deliveryLine(w, q, now);
  const heading = answerHeading(q);
  const pr = q.prKey ? w.prs.find(p => p.key === q.prKey) : null;
  const task = q.taskId ? w.obligations.find(o => o.id === q.taskId) : null;
  const deliveryColor = delivery?.tone === "success" ? c.statusSuccess : delivery?.tone === "warning" ? c.statusWarning : c.foregroundMuted;
  const context = (!!q.background || !!q.links?.length || pr || (task && !(inline && task.title.trim() === q.title.trim()))) && <View style={{ gap: 8 }}>
    {!!q.background && <RichText selectable linkColor={c.foreground} numberOfLines={dense ? 3 : undefined} style={t.meta}>{q.background}</RichText>}
    {!dense && q.links?.map((link, i) => <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={link.url ? "Globe" : "FileText"} size={13} color={c.foregroundMuted} />
      {link.url ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${link.label || link.url}`} onPress={() => { void openExternalUrl(link.url!).catch(() => undefined); }} hitSlop={4}
        style={state => ({ flexShrink: 1, opacity: state.pressed ? 0.7 : 1 })}>
        <Text numberOfLines={1} style={[t.meta, { color: c.foreground, textDecorationLine: "underline" }]}>{link.label || link.url}{link.label ? <Text style={{ color: c.foregroundMuted, textDecorationLine: "none" }}>{`  ${hostOf(link.url)}`}</Text> : null}</Text>
      </Pressable> : <Text selectable numberOfLines={1} style={[t.meta, { flexShrink: 1, color: c.foreground }]}>{link.label ? `${link.label}  ` : ""}<Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{link.path}</Text></Text>}
    </View>)}
    {!dense && pr && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="GitPullRequest" size={13} color={pr.snapshot?.state === "MERGED" ? mergedColor(c) : c.foregroundMuted} />
      {/* "#142" opens the PR (a-row-that-names-a-pr-opens-it-in-one-click). */}
      <PrLinksProvider prs={prLinksByNumber([pr])}><RichText linkColor={c.foreground} numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>{`About #${pr.number}${pr.snapshot?.title ? ` · ${pr.snapshot.title}` : ""}`}</RichText></PrLinksProvider>
    </View>}
    {!dense && task && !(inline && task.title.trim() === q.title.trim()) && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ListChecks" size={13} color={c.foregroundMuted} />
      <RichText linkColor={c.foreground} numberOfLines={2} style={[t.meta, { flexShrink: 1 }]}>{`Task: ${task.title}`}</RichText>
    </View>}
  </View>;
  // Cmd+Enter (and Enter outside the answer field) does what Send does, only when Send is enabled.
  const submittable = !run.isPending && !img.blocked && (open ? !!answer || doneOnly : q.answer?.delivery.state === "copied" || q.answer?.delivery.state === "in-chat");
  // In the pill popover the answer field and actions stay pinned below a scrolling body.
  const pinned = dense && !!bodyMaxHeight;
  // Re-keyed by role, so the field that opens on Something else or Add note takes the caret; typing never re-keys it.
  const input = draft.field && <View style={{ gap: 6 }}>
    {!!draft.heading && <Text style={[t.small, { fontWeight: "600" }]}>{draft.heading}</Text>}
    {(() => {
      const field = (pad: FieldPad) => <TextInput key={draft.field} accessibilityLabel={draft.label} placeholder={draft.placeholder} placeholderTextColor={c.foregroundMuted}
        multiline value={words} editable={!run.isPending} onChangeText={setWords} onSelectionChange={caret.onSelectionChange} maxLength={2000} autoFocus={!free && (other || noteOpen)} style={[inputStyle(c, compact, draft.field === "answer" && !dense ? 3 : 2), pad]} />;
      // Dictated words land in this same field's words (what-you-typed-is-what-gets-sent), at the caret, never sent.
      return <ImageField model={img} theme={theme} compact={compact}>{dictate ? <DictationField key={draft.field} theme={theme} compact={compact} keyHint field={field} disabled={run.isPending}
        onText={said => setWords(prev => caret.insert(prev, said, 2000))} /> : field(null)}</ImageField>;
    })()}
  </View>;
  // Context comes before the options so the developer reads why before choosing.
  const body = <View style={{ gap: dense ? 10 : 14 }}>
    <View style={{ gap: 6 }}>
      {/* Inline: the block's header carries the title, so the question reads as body text under it. */}
      {(() => {
        const question = <RichText selectable style={[inline ? text(c, compact).body : [t.body, { fontSize: dense ? 13 : 15, lineHeight: dense ? 19 : 22 }], { flex: 1, minWidth: 0 }]}>{q.question}</RichText>;
        return dismissX && dismissAt === "top" ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>{question}<View style={{ marginTop: -2, marginRight: -5 }}>{dismissX}</View></View> : question;
      })()}
      {/* Phones: who asked and when is meta under the question, not a footnote after the buttons. */}
      {compact && !dense && !inline && <Text style={t.small}>Asked {ago(q.askedAt, now)} by {who(w, q.askedBy)}{q.taskId && !q.options.length ? " (blocked task)" : ""}</Text>}
      {open && !inline && <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={12} color={state.color(c)} /></View>
        <Text style={[t.meta, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
      </View>}
    </View>
    {afterAsk}
    {q.closed && <View style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 2 }}><Icon name={isDismissed(q) ? "X" : "MessageCircleOff"} size={12} color={c.foregroundMuted} /></View>
      <Text style={[t.meta, { flex: 1 }]}>{isDismissed(q) ? `${closedLine(q)} ${ago(q.closed.at, now)}. The agent wasn't messaged.` : `Withdrawn ${ago(q.closed.at, now)}: ${q.closed.reason}`}</Text>
    </View>}
    {context}
    {/* Read before choosing: More context sits under the question's own context, its answer with it. */}
    {/* The question's quiet row: More context (Catch up's move bar has its own). Dismiss is the card's x, top right. */}
    {open && moreContext && <QuestionMoreContext workspace={w} question={q} theme={theme} compact={compact} openAgent={openAgent} />}
    {!!q.options.length && !doneOnly && <View accessibilityRole="radiogroup" accessibilityLabel={`Options for ${q.id}`} style={{ gap: 6 }}>
      {q.options.map(o => <OptionCard key={o.letter} theme={theme} compact={compact} dense={dense} letter={o.letter} label={o.label} consequence={o.consequence} recommended={q.recommend === o.letter}
        selected={(open ? choice : q.answer?.choice) === o.letter} disabled={!open || run.isPending} onPress={() => setChoice(o.letter)} />)}
      {/* Built in on every question with options, after the agent's own: the developer's own answer. */}
      {(open || isOther(q.answer?.choice)) && <OptionCard theme={theme} compact={compact} dense={dense} own label={OTHER_LABEL} consequence={open && !dense ? "Write your own answer" : undefined} recommended={false}
        selected={open ? other : isOther(q.answer?.choice)} disabled={!open || run.isPending} onPress={() => setChoice(OTHER)} />}
    </View>}
    {/* Not sent yet (copied, or in the agent's message box) never reads as answered: no check, no green. Only a
        delivered answer is green; queued, retrying or failed keeps the check but stays neutral (answerHeading). */}
    {heading && <View style={{ gap: 6, padding: 10, borderRadius: 8, backgroundColor: heading.delivered ? tint(c.statusSuccess, c) : c.surface1 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}><Icon name={heading.waiting ? "CircleDashed" : "CircleCheck"} size={13} color={heading.delivered ? c.statusSuccess : c.foregroundMuted} /></View>
        <RichText selectable style={[t.label, { flex: 1 }]}>{heading.text}</RichText>
      </View>
      {!!q.answer?.words && <RichText selectable style={[t.meta, { color: c.foreground, paddingLeft: 19 }]}>{q.answer.words}</RichText>}
      {delivery && <View style={{ flexDirection: "row", gap: 6, paddingLeft: 19 }}>
        {delivery.tone === "spinner" ? <View style={{ paddingTop: 2 }}><Spinner color={c.foregroundMuted} size={11} /></View> : <View style={{ paddingTop: 2 }}><Icon name={delivery.icon} size={11} color={deliveryColor} /></View>}
        <Text style={[t.meta, { flex: 1, color: deliveryColor }]}>{delivery.text}</Text>
      </View>}
    </View>}
    {unsent && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 2 }}><Icon name="CircleAlert" size={12} color={c.statusDanger} /></View>
      <Text style={[t.meta, { flex: 1, color: c.statusDanger }]}>Not sent · {unsent.error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Retry sending your ${q.id} answer`} hitSlop={6} disabled={!answer} onPress={() => quick("send")}>
        <Text style={[t.meta, { color: c.foreground, fontWeight: "600", textDecorationLine: "underline" }]}>Retry</Text>
      </Pressable>
    </View>}
    {/* A note on a lettered pick: the brief card's quiet links, under the options, in every mode. */}
    {open && (draft.canAddNote || draft.canRemoveNote) && !(doneOnly && draft.canAddNote) && <NoteLink icon={draft.canAddNote ? "MessageSquarePlus" : "X"} label={draft.canAddNote ? "Add note" : "Remove note"}
      a11y={draft.canAddNote ? `Add a note for the agent about ${q.id}` : `Remove the note on ${q.id}`} disabled={run.isPending} c={c} compact={compact}
      onPress={() => { if (draft.canAddNote) setNoteOpen(true); else { setWords(""); setNoteOpen(false); } }} />}
  </View>;
  const actions = (open || q.answer && answerHasActions(q.answer.delivery)) && <View style={{ gap: 6 }}>
    <View onLayout={doneOnly ? e => setRowWidth(e.nativeEvent.layout.width) : undefined} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {doneOnly && <Button shortcut={rowWidth >= DONE_HINT_MIN_WIDTH} theme={theme} compact={compact} grow={compact} kind="primary" icon="Check" title="Done" accessibilityLabel={`Done: tell the agent you did ${q.id}`} accessibilityHint="Sends Done to the agent at once" disabled={run.isPending || !!img.blocked} onPress={done} />}
      {doneOnly && choice !== TASK_DONE.letter && <NoteLink icon="MessageSquarePlus" label="Add note" a11y={`Add a note for the agent, sent with Done on ${q.id}`} disabled={run.isPending} c={c} compact={compact}
        onPress={() => { setChoice(TASK_DONE.letter); setNoteOpen(true); }} />}
      {doneOnly && <NoteLink icon="Reply" label="Reply instead" a11y={`Write a reply to ${q.id} instead of Done`} disabled={run.isPending} c={c} compact={compact} onPress={() => { setChoice(OTHER); setNoteOpen(false); }} />}
      {open && !doneOnly && <Button shortcut theme={theme} compact={compact} grow={compact} kind="primary" icon="Send" title="Send to agent" accessibilityLabel={`Send your ${q.id} answer to the agent`} accessibilityHint={img.blocked ? img.blocked : other && !words.trim() ? "Write your answer first" : compact ? `Puts your answer straight into the asking agent's chat, even mid-turn. Follow-up keeps it under ${q.id}.` : undefined} disabled={!answer || run.isPending || !!img.blocked} onPress={() => quick("send")} />}
      {open && !doneOnly && composer && <Button theme={theme} compact={compact} icon="MessageSquareText" title="Put in chat" accessibilityLabel={`Put your ${q.id} answer in the agent's chat, to read over and send there`} disabled={!answer || run.isPending} onPress={putIn} />}
      {/* Paseo 0.16: Copy steps back to an icon beside Put in chat (both move the words without sending). 0.15 keeps the label. */}
      {open && !doneOnly && !composer && <Button theme={theme} compact={compact} icon="Copy" title="Copy" accessibilityLabel={`Copy your ${q.id} answer instead of sending it`} disabled={!answer || run.isPending} onPress={() => quick("copy")} />}
      {open && !doneOnly && composer && <IconButton theme={theme} compact={compact} icon="Copy" label="Copy answer" tooltip disabled={!answer || run.isPending} onPress={() => quick("copy")} />}
      {(q.answer?.delivery.state === "copied" || q.answer?.delivery.state === "in-chat") && <Button shortcut theme={theme} compact={compact} kind="primary" icon="Send" title="Send to agent" accessibilityLabel={`Send your ${q.id} answer to the agent`} loading={run.isPending} onPress={() => run.mutate("send")} />}
      {q.answer && resendTitle(q.answer.delivery) && <Button theme={theme} compact={compact} kind={q.answer.delivery.state === "failed" ? "primary" : undefined} icon="RotateCcw" title={resendTitle(q.answer.delivery)!} accessibilityLabel={q.answer.delivery.state === "failed" ? `Send the ${q.id} answer again` : `Try sending the ${q.id} answer now`} loading={run.isPending} onPress={() => run.mutate("resend")} />}
      {q.answer && (q.answer.delivery.state === "failed" || q.answer.delivery.state === "cancelled") && <Button theme={theme} compact={compact} kind="ghost" icon="Copy" title="Copy" accessibilityLabel={`Copy the ${q.id} answer`} onPress={() => { void copyText(answerMessage(q, q.answer!.choice, q.answer!.words)).then(() => toast.show("Copied", { variant: "success" }), () => toast.error("Couldn't copy here")); }} />}
      {q.answer?.delivery.state === "in-chat" && composer && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquareText" title="Open chat" accessibilityLabel={`Open the chat your ${q.id} answer is in`} onPress={() => { onClose?.(); void composer.focus().catch(() => undefined); }} />}
      {(q.answer?.delivery.state === "failed" || q.answer?.delivery.state === "unconfirmed") && openAgent && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" onPress={() => openAgent(q.askedBy ?? w.mainAgentId)} />}
      {dense && onDetails && <IconButton theme={theme} compact={compact} icon="Maximize2" label={`Open ${q.id} with its links and full context`} onPress={onDetails} />}
    </View>
    {/* Same words as the brief card's, so a disabled Send always says why. */}
    {doneOnly ? null : open && draft.hint ? <Text style={t.small}>{draft.hint}</Text>
      // Two ways to deliver (Paseo 0.16) need telling apart everywhere, the phone and the Needs you block included.
      : open && !dense && composer ? <Text style={t.small}>Send delivers it now, even mid-turn. Put in chat adds it to your message box to edit first.</Text>
      : open && !dense && !compact && !inline && <Text style={t.small}>Send puts your answer straight into the asking agent's chat, even mid-turn. Follow-up keeps it under {q.id}.</Text>}
  </View>;
  // In the pill popover the question scrolls and the answer field and actions stay put, so Send is never cut off.
  if (pinned) {
    const showInput = open && !!draft.field;
    return <SubmitScope enabled={submittable} onSubmit={() => doneOnly ? done() : open ? quick("send") : run.mutate("send")} style={{ gap: 10 }}>
      <View>
        <ScrollView style={{ maxHeight: bodyMaxHeight! - (showInput ? 62 : 0), flexGrow: 0 }} contentContainerStyle={{ paddingRight: 2 }} scrollEventThrottle={32}
          onLayout={e => { const view = e.nativeEvent.layout.height; setScroll(s => ({ ...s, view })); }}
          onContentSizeChange={(_, content) => setScroll(s => ({ ...s, content }))}
          onScroll={e => { const offset = e.nativeEvent.contentOffset.y; setScroll(s => ({ ...s, offset })); }}>{body}</ScrollView>
        {more && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 6 }}>
          <Icon name="ChevronDown" size={12} color={c.foregroundMuted} />
          <Text style={t.small}>More below</Text>
        </View>}
      </View>
      {/* The field with its Send: kept on screen together while typing (a-focused-field-and-its-send-stay-in-view). */}
      <View {...PRIMARY_FORM} style={{ gap: 10 }}>
        {showInput && input}
        {actions}
      </View>
    </SubmitScope>;
  }
  return <SubmitScope enabled={submittable} onSubmit={() => doneOnly ? done() : open ? quick("send") : run.mutate("send")} style={{ gap: dense ? 10 : 14 }}>
    {body}
    {/* The field with its Send: kept on screen together while typing (a-focused-field-and-its-send-stay-in-view). */}
    <View {...PRIMARY_FORM} style={{ gap: dense ? 10 : 14 }}>
      {open && input}
      {actions}
    </View>
    {!dense && !compact && !inline && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={[t.small, { flex: 1 }]}>Asked {ago(q.askedAt, now)} by {who(w, q.askedBy)}{q.taskId && !q.options.length ? " (blocked task)" : ""}</Text>
      {dismissAt === "foot" && dismissX}
    </View>}
  </SubmitScope>;
}

/** A question's x: closes it as dismissed (follow.dismiss with "question:Qn"), sends the agent nothing, Undo in the toast. */
export function QuestionDismissX({ workspaceId, questionId, theme, compact, disabled, onDismissed, dismiss }: { workspaceId: string; questionId: string; theme: Theme; compact: boolean; disabled?: boolean; onDismissed?: () => void; dismiss: ReturnType<typeof useDismiss> }) {
  return <DismissX theme={theme} compact={compact} label={`Remove ${questionId}`} disabled={disabled} onPress={() => dismiss({ workspaceId, key: `question:${questionId}` }, { onDismissed })} />;
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

/** The question dialog: a sheet on phones, a dialog on desktop. */
export function QuestionSheet({ workspace: w, questionId, theme, compact, onClose, openAgent, fallback }: { workspace: Workspace; questionId: string | null; theme: Theme; compact: boolean; onClose: () => void; openAgent?: (agentId: string) => void;
  /** The question as an Activity page carried it: an old settled one follow.get no longer sends (shared/history.ts). */
  fallback?: Question | null }) {
  const c = theme.colors;
  const q = questionId ? w.questions.find(x => x.id === questionId) ?? (fallback?.id === questionId ? fallback : null) : null;
  const color = !q ? c.foregroundMuted : q.answer ? c.statusSuccess : q.closed ? c.foregroundMuted : c.statusWarning;
  return <Modal title={q ? `${q.id} · ${q.title}` : "Question"} icon={<Icon name={q?.answer ? "MessageCircleReply" : "MessageCircleQuestion"} size={18} color={color} />} open={!!q} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      {q && <QuestionBody key={q.id} workspace={w} question={q} theme={theme} compact={compact} openAgent={openAgent} onClose={onClose} dismissAt={compact ? "top" : "foot"} />}
    </Modal.Content>
  </Modal>;
}

/** The pill steps through open questions ("1 of 3") and answers them without leaving the chat. */
export function QuestionStepper({ workspace: w, theme, compact, openAgent, onAnswered, onDetails, bodyMaxHeight }: { workspace: ListWorkspace; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; onAnswered?: () => void; onDetails?: (id: string) => void; bodyMaxHeight?: number }) {
  const c = theme.colors; const t = text(c);
  const pending = usePendingAnswers();
  // An answer on its way (sent, no reply yet) steps the pill on at once; one that failed comes back as Not sent.
  const open = w.questions.filter(q => isOpen(q) && !(pending[pendingKey(w.id, q.id)] && !pending[pendingKey(w.id, q.id)].error)).sort((a, b) => Number(questionState(b) === "stopped") - Number(questionState(a) === "stopped"));
  const [index, setIndex] = useState(0);
  const dismiss = useDismiss();
  if (!open.length) return null;
  const at = Math.min(index, open.length - 1);
  const q = open[at];
  const step = (by: number) => setIndex((at + by + open.length) % open.length);
  const arrow = (icon: string, label: string, by: number) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => step(by)} hitSlop={6}
    style={state => ({ width: compact ? 40 : 26, height: compact ? 40 : 26, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name={icon} size={15} color={c.foregroundMuted} />
  </Pressable>;
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 40 : 26 }}>
      <Icon name={questionState(q) === "stopped" ? "CirclePause" : "MessageCircleQuestion"} size={14} color={c.statusWarning} />
      <RichText accessibilityRole="header" numberOfLines={2} style={[t.label, { flex: 1 }]}>{`${q.id} · ${q.title}`}</RichText>
      {open.length > 1 && <>
        <Text accessibilityLabel={`Question ${at + 1} of ${open.length}`} style={[t.small, { marginLeft: 4 }]}>{at + 1} of {open.length}</Text>
        {arrow("ChevronLeft", "Previous question", -1)}{arrow("ChevronRight", "Next question", 1)}
      </>}
      <QuestionDismissX workspaceId={w.id} questionId={q.id} theme={theme} compact={compact} onDismissed={onAnswered} dismiss={dismiss} />
    </View>
    <QuestionBody key={q.id} workspace={w} question={q} theme={theme} compact={compact} dense bodyMaxHeight={bodyMaxHeight} openAgent={openAgent} onAnswered={onAnswered} onDetails={onDetails ? () => onDetails(q.id) : undefined} dismissAt="host" />
  </View>;
}

const toneColor = (c: Colors, tone: ActivityTone) => tone === "merged" ? mergedColor(c) : tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;

/**
 * The workspace's log: a timeline of what happened, and every question under its ref. Paged (client/paged-list.tsx):
 * folded it shows the newest few, "Show all N" opens pages of PAGE.size, and a search finds across every page. Its rows
 * come a page at a time from follow.activity (the worker holds the whole history; follow.get carries only the newest,
 * shared/history.ts), with the panel's own copy drawn until the first page answers.
 */
export function ActivityCard({ workspace: w, theme, compact, now, open, toggle, onOpenQuestion }: { workspace: Workspace; theme: Theme; compact: boolean; now: number; open: (key: string) => boolean; toggle: (key: string) => void; onOpenQuestion: (id: string, question?: Question) => void }) {
  const c = theme.colors; const t = text(c);
  const [tab, setTab] = useState<ActivityTab>("timeline");
  const [page, setPage] = useState({ key: "", at: 0 });
  const all = open("activity");
  const read = useRpc(activityRpc);
  const [remote, setRemote] = useState<{ matches: number; total: number } | null>(null);
  // Activity searches both tabs at once on the worker; each tab chip then counts its own matches.
  const search = useSectionSearch<never>(w.id, "activity", { theme, compact, items: [], fields: () => [], remote });
  const query = search.query?.trim() ?? "";
  const searching = !!query;
  const paged = all || searching;
  const key = `${tab}|${query}|${paged}`;
  const at = page.key === key ? page.at : 0;
  const limit = paged ? PAGE.size : PAGE.preview;
  const input = { workspaceId: w.id, tab, ...(query ? { query } : {}), offset: at * limit, limit };
  const local = useMemo(() => ({ ...activityPage(w, input), error: null }), [w, tab, query, at, limit]); // eslint-disable-line react-hooks/exhaustive-deps
  const reply = useQuery({ queryKey: activityKey(w.id, w.updatedAt, tab, query, at * limit, limit), queryFn: () => read(input), placeholderData: keepPreviousData, staleTime: 15_000, refetchOnWindowFocus: false });
  // Until the worker answers this workspace's first page, the panel's own (bounded) copy draws it.
  const d = reply.data && !reply.data.error && reply.data.tab === tab ? reply.data : local;
  const counts = d.counts;
  useEffect(() => { const next = searching ? { matches: counts.timeline + counts.questions, total: d.all } : null; setRemote(r => r?.matches === next?.matches && r?.total === next?.total ? r : next); }, [searching, counts.timeline, counts.questions, d.all]);
  const info = pageInfo(d.total, at, limit);
  if (!d.all && !searching) return null;
  const hasQuestions = searching ? counts.questions > 0 || counts.timeline > 0 : d.counts.questions > 0;
  const tabButton = (id: ActivityTab, label: string, count?: number) => {
    const selected = tab === id;
    return <Pressable key={id} accessibilityRole="tab" aria-selected={selected} accessibilityState={{ selected }} accessibilityLabel={count !== undefined ? `${label}, ${count}` : label} onPress={() => setTab(id)} hitSlop={4}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 36 : 24, paddingHorizontal: 7, borderRadius: 999, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      {count !== undefined && <Text style={{ color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{count}</Text>}
    </Pressable>;
  };
  const tabs = (withCounts: boolean) => <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 0, marginVertical: -4 }}>{tabButton("timeline", "Timeline", withCounts ? counts.timeline : undefined)}{tabButton("questions", "Questions", counts.questions)}</View>;
  const rows = d.timeline, questions = d.questions;
  const empty = tab === "timeline" ? !rows.length : !questions.length;
  const footer = !paged
    ? d.total > PAGE.preview && <FoldRow theme={theme} compact={compact} open={false} onPress={() => toggle("activity")} icon="History" iconColor={c.foregroundMuted} label={`Show all ${d.total}`} />
    : (info.pages > 1 || !searching) && <Pager theme={theme} compact={compact} info={info} busy={reply.isFetching && reply.isPlaceholderData} noun={tab === "timeline" ? "events" : "questions"}
      onPage={p => setPage({ key, at: p })} onLess={searching ? undefined : () => { setPage({ key, at: 0 }); toggle("activity"); }} />;
  return <Card theme={theme} compact={compact} icon="Activity" title="Activity" search={search.header}
    right={<View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>{hasQuestions ? tabs(false) : null}{search.button}</View>}>
    {/* Searching: the tabs move under the field and count their matches, so a hit in the other tab is never hidden. */}
    {search.header && <View style={{ flexDirection: "row", paddingHorizontal: compact ? 14 : 12, paddingTop: 6, paddingBottom: 10 }}>{tabs(searching)}</View>}
    {searching && !counts.timeline && !counts.questions && <NoMatchRow section="activity" query={query} theme={theme} compact={compact} />}
    {searching && (counts.timeline > 0 || counts.questions > 0) && empty && <View style={{ paddingHorizontal: compact ? 14 : 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={t.meta}>{`Nothing in ${tab === "timeline" ? "Timeline" : "Questions"} matches. ${tab === "timeline" ? counts.questions : counts.timeline} in ${tab === "timeline" ? "Questions" : "Timeline"}.`}</Text>
    </View>}
    {/* The timeline is drawn on the same rail as the stacks: a 2px line through 16px state nodes. */}
    {empty ? null : tab === "timeline" ? <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6, borderTopWidth: 1, borderTopColor: c.border }}>
      {rows.map(({ row: r, hit }, i) => {
        const color = toneColor(c, r.tone);
        return <View key={r.key} style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 2, height: 8, backgroundColor: i === 0 && info.page === 0 ? "transparent" : c.border }} />
            <View style={{ width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: tint(color, c) }}><Icon name={r.icon} size={10} color={color} /></View>
            <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: i === rows.length - 1 && info.page === info.pages - 1 ? "transparent" : c.border }} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2, paddingTop: 6, paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              {hit ? <Marked numberOfLines={2} text={r.text} ranges={hit.ranges[0]} theme={theme} style={[t.body, { flex: 1 }]} /> : <Text numberOfLines={2} style={[t.body, { flex: 1 }]}>{r.text}</Text>}
              <Text style={t.small}>{ago(r.at, now)}</Text>
            </View>
            {(r.detail || r.took) && <RichText marks={hit && r.detail ? { ranges: hit.ranges[1], colors: c } : undefined} linkColor={c.foreground} numberOfLines={2} style={t.meta}>{[r.detail, r.took ? `took ${r.took}` : null].filter(Boolean).join(" · ")}</RichText>}
          </View>
        </View>;
      })}
    </View> : questions.map(({ question: q, hit }) => {
      // Until it reached the agent the row says where it is, in muted, like every other surface (answerStatus).
      const s = answerStatus(q);
      const status = questionStatus(q);
      const icon = q.answer ? "MessageCircleReply" : q.closed ? "MessageCircleOff" : "MessageCircleQuestion";
      const color = s?.delivered ? c.statusSuccess : q.answer || q.closed ? c.foregroundMuted : c.statusWarning;
      return <CardRow key={q.id} theme={theme} onPress={() => onOpenQuestion(q.id, q as Question)} accessibilityLabel={`${q.id}, ${q.title}. ${status}. Open`}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={icon} size={13} color={color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              {hit ? <Marked numberOfLines={1} text={`${q.id} · ${q.title}`} ranges={hit.ranges[0]} theme={theme} style={[t.body, { flex: 1 }]} /> : <RichText plain numberOfLines={1} style={[t.body, { flex: 1 }]}>{`${q.id} · ${q.title}`}</RichText>}
              <Text style={t.small}>{ago(q.answer?.at ?? q.closed?.at ?? q.askedAt, now)}</Text>
            </View>
            {hit ? <Marked numberOfLines={2} text={status} ranges={hit.ranges[1]} theme={theme} style={[t.meta, !q.answer && !q.closed ? { color: c.statusWarning } : null]} />
              : <RichText plain numberOfLines={2} style={[t.meta, !q.answer && !q.closed ? { color: c.statusWarning } : null]}>{status}</RichText>}
          </View>
        </View>
      </CardRow>;
    })}
    {footer || null}
  </Card>;
}
