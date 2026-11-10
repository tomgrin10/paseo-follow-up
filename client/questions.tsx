// The question dialog and its answer form. The layout of options with a recommendation, the
// "what the agent does meanwhile" line and Copy are adapted from Progress
// (@stevecastaneda/paseo-progress, MIT, © 2026 Steve Castaneda); see THIRD_PARTY_NOTICES.md.
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { answerQuestionRpc } from "../shared/contracts";
import type { Workspace } from "../shared/model";
import { isOpen, questionState, replyText, type Question } from "../shared/questions";
import { ago } from "../shared/attention";
import { activity, type ActivityTone } from "../shared/activity";
import { Button, Card, CardRow, Chip, FoldRow, IconButton, errorText, text, type Theme } from "./kit";
import { Spinner } from "./motion";
import { mergedColor, tint, withAlpha, type Colors } from "./theme";
import { overviewKey, workspaceKey } from "./keys";

const who = (w: Workspace, agentId: string | null) => !agentId || agentId === w.mainAgentId ? "the main agent" : "a root session";

/** What the agent is doing while the question is open, in the developer's terms. */
export function meanwhile(w: Workspace, q: Question): { icon: string; color: (c: Colors) => string; text: string } {
  if (q.taskId && !q.options.length) return { icon: "Clock", color: c => c.foregroundMuted, text: "A task is blocked on this. The agent works on the rest." };
  switch (questionState(q)) {
    case "stopped": return { icon: "CirclePause", color: c => c.statusWarning, text: q.big ? `The agent stopped and waits for your answer. Big question: ${q.big}.` : "The agent stopped and waits for your answer." };
    case "building": return { icon: "Hammer", color: c => c.foregroundMuted, text: `The agent is building ${q.recommend} while you decide. Pick another option and it undoes that first.` };
    default: return q.big
      ? { icon: "Hand", color: c => c.statusWarning, text: `Big question: ${q.big}. The agent builds nothing this affects until you answer.` }
      : { icon: "Clock", color: c => c.foregroundMuted, text: "The agent holds what this affects and keeps working on the rest." };
  }
}

function deliveryLine(w: Workspace, q: Question, now: number): { icon: string; tone: "success" | "warning" | "muted" | "spinner"; text: string } | null {
  const d = q.answer?.delivery;
  if (!d) return null;
  switch (d.state) {
    case "sent": return { icon: "CircleCheck", tone: "success", text: `Sent to ${who(w, d.to)} ${ago(d.at, now)}` };
    case "sending": return { icon: "", tone: "spinner", text: "Sending to the agent…" };
    case "queued": return { icon: "Clock", tone: "muted", text: `${d.reason ?? "Waiting for the agent."} It goes out on the next check.` };
    case "unconfirmed": return { icon: "TriangleAlert", tone: "warning", text: d.reason ?? "Paseo didn't confirm the message. Check the agent's chat before resending." };
    case "copied": return { icon: "Copy", tone: "muted", text: `Copied ${ago(d.at, now)}. Paste it into the agent's chat, or send it from here.` };
    case "recorded": return { icon: "MessageSquare", tone: "muted", text: `You answered in chat; the agent recorded it ${ago(d.at, now)}.` };
  }
}

/** A radio card: the question options, and setup's Updates choice (no letter there). */
export function OptionCard({ theme, letter, label, consequence, recommended, selected, disabled, onPress, compact, dense = false }: { theme: Theme; letter?: string; label: string; consequence?: string; recommended: boolean; selected: boolean; disabled: boolean; onPress: () => void; compact: boolean; dense?: boolean }) {
  const c = theme.colors; const t = text(c);
  return <Pressable accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected, disabled }} accessibilityLabel={`${letter ? `${letter}. ` : ""}${label}${recommended ? ". Recommended" : ""}${consequence ? `. ${consequence}` : ""}`}
    disabled={disabled} onPress={onPress}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: dense ? 10 : 12, paddingVertical: compact ? 12 : dense ? 8 : 10, borderRadius: 8, borderWidth: selected ? 1.5 : 1,
      borderColor: selected ? c.accent : c.border, margin: selected ? 0 : 0.5,
      backgroundColor: selected ? withAlpha(c.accent, 0.08) : state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered && !disabled ? c.surface1 : "transparent" })}>
    <View style={{ width: 18, height: 18, marginTop: 1, borderRadius: 9, borderWidth: selected ? 5 : 1.5, borderColor: selected ? c.accent : c.foregroundMuted }} />
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 }}>
        <Text style={t.label}>{letter ? <><Text style={{ fontVariant: ["tabular-nums"] }}>{letter}</Text>{"  "}</> : null}{label}</Text>
        {recommended && <Chip theme={theme} icon="ThumbsUp" label="Recommended" color={c.foregroundMuted} />}
      </View>
      {!!consequence && <Text numberOfLines={dense ? 2 : undefined} style={t.meta}>{consequence}</Text>}
    </View>
  </Pressable>;
}

const inputStyle = (c: Colors, compact: boolean, lines: number) => ({ minHeight: compact ? 44 : 18 * lines + 16, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface1, fontSize: 13, lineHeight: 18, textAlignVertical: "top" as const });

/**
 * One question with its answer form. Send records the answer and messages the asking agent straight
 * away; Copy records it and puts a reply on the clipboard instead. Used by the dialog and the pill.
 */
export function QuestionBody({ workspace: w, question: q, theme, compact, now = Date.now(), dense = false, bodyMaxHeight, openAgent, onAnswered, onDetails }: {
  workspace: Workspace; question: Question; theme: Theme; compact: boolean; now?: number; dense?: boolean; bodyMaxHeight?: number; openAgent?: (agentId: string) => void; onAnswered?: () => void; onDetails?: () => void;
}) {
  const c = theme.colors; const t = text(c);
  const toast = useToast(); const cache = useQueryClient();
  const answerRpc = useRpc(answerQuestionRpc);
  const open = isOpen(q);
  const [choice, setChoice] = useState<string | null>(q.answer?.choice ?? null);
  const [words, setWords] = useState(q.answer?.words ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  // The pill's scrolling body: track whether more sits below the fold, so it can say so.
  const [scroll, setScroll] = useState({ content: 0, view: 0, offset: 0 });
  const more = scroll.content - scroll.view - scroll.offset > 4;
  useEffect(() => { setChoice(q.answer?.choice ?? null); setWords(q.answer?.words ?? ""); }, [q.id]);
  const refresh = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const free = !q.options.length;
  const answer = free ? words.trim() : choice;
  const note = free ? undefined : words.trim() || undefined;
  const run = useMutation({
    mutationFn: async (action: "send" | "copy" | "resend") => {
      if (action === "copy") await copyText(replyText(q, q.answer?.choice ?? answer!, q.answer?.words ?? note));
      return answerRpc({ workspaceId: w.id, questionId: q.id, choice: q.answer?.choice ?? answer!, words: q.answer?.words ?? note, action });
    },
    onSuccess: (result, action) => {
      const d = result.question.answer?.delivery;
      if (action === "copy") toast.show(`Copied the ${q.id} answer. Paste it into the agent's chat.`, { variant: "success" });
      else if (d?.state === "sent") toast.show(`Sent your ${q.id} answer to the agent`, { variant: "success" });
      else if (d?.state === "queued") toast.show(`Answer saved. It goes to the agent when it can take it.`, { variant: "info" });
      else toast.show("Paseo didn't confirm the message. Check the agent's chat before resending.", { variant: "warning" });
      refresh(); onAnswered?.();
    },
    onError: error => { toast.error(errorText(error)); refresh(); },
  });
  const state = meanwhile(w, q);
  const delivery = deliveryLine(w, q, now);
  const pr = q.prKey ? w.prs.find(p => p.key === q.prKey) : null;
  const task = q.taskId ? w.obligations.find(o => o.id === q.taskId) : null;
  const chosen = q.options.find(o => o.letter === q.answer?.choice);
  const deliveryColor = delivery?.tone === "success" ? c.statusSuccess : delivery?.tone === "warning" ? c.statusWarning : c.foregroundMuted;
  const context = (!!q.background || !!q.links.length || pr || task) && <View style={{ gap: 8 }}>
    {!!q.background && <Text selectable numberOfLines={dense ? 3 : undefined} style={t.meta}>{q.background}</Text>}
    {!dense && q.links.map((link, i) => <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={link.url ? "Globe" : "FileText"} size={13} color={c.foregroundMuted} />
      {link.url ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${link.label || link.url}`} onPress={() => { void openExternalUrl(link.url!).catch(() => undefined); }} hitSlop={4}
        style={state => ({ flexShrink: 1, opacity: state.pressed ? 0.7 : 1 })}>
        <Text numberOfLines={1} style={[t.meta, { color: c.foreground, textDecorationLine: "underline" }]}>{link.label || link.url}{link.label ? <Text style={{ color: c.foregroundMuted, textDecorationLine: "none" }}>{`  ${hostOf(link.url)}`}</Text> : null}</Text>
      </Pressable> : <Text selectable numberOfLines={1} style={[t.meta, { flexShrink: 1, color: c.foreground }]}>{link.label ? `${link.label}  ` : ""}<Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{link.path}</Text></Text>}
    </View>)}
    {!dense && pr && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="GitPullRequest" size={13} color={pr.snapshot?.state === "MERGED" ? mergedColor(c) : c.foregroundMuted} />
      <Text numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>About #{pr.number}{pr.snapshot?.title ? ` · ${pr.snapshot.title}` : ""}</Text>
    </View>}
    {!dense && task && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ListChecks" size={13} color={c.foregroundMuted} />
      <Text numberOfLines={2} style={[t.meta, { flexShrink: 1 }]}>Task: {task.title}</Text>
    </View>}
  </View>;
  // In the pill popover the answer field and actions stay pinned below a scrolling body.
  const pinned = dense && !!bodyMaxHeight;
  const input = <View style={{ gap: 6 }}>
    {free && !dense && <Text style={t.meta}>No options were given. Write the decision for the agent.</Text>}
    <TextInput accessibilityLabel={free ? `Your answer to ${q.id}` : `Note for the agent about ${q.id}, optional`} placeholder={free ? "Your answer" : "Add a note for the agent (optional)"} placeholderTextColor={c.foregroundMuted}
      multiline value={words} editable={!run.isPending} onChangeText={setWords} maxLength={2000} autoFocus={pinned && !free && noteOpen} style={inputStyle(c, compact, free && !dense ? 3 : 2)} />
  </View>;
  // Context comes before the options so the developer reads why before choosing.
  const body = <View style={{ gap: dense ? 10 : 14 }}>
    <View style={{ gap: 6 }}>
      <Text selectable style={[t.body, { fontSize: dense ? 13 : 15, lineHeight: dense ? 19 : 22 }]}>{q.question}</Text>
      {/* Phones: who asked and when is meta under the question, not a footnote after the buttons. */}
      {compact && !dense && <Text style={t.small}>Asked {ago(q.askedAt, now)} by {who(w, q.askedBy)}{q.taskId && !q.options.length ? " (blocked task)" : ""}</Text>}
      {open && <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={12} color={state.color(c)} /></View>
        <Text style={[t.meta, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
      </View>}
    </View>
    {q.closed && <View style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 2 }}><Icon name="MessageCircleOff" size={12} color={c.foregroundMuted} /></View>
      <Text style={[t.meta, { flex: 1 }]}>Withdrawn {ago(q.closed.at, now)}: {q.closed.reason}</Text>
    </View>}
    {context}
    {!!q.options.length && <View accessibilityRole="radiogroup" accessibilityLabel={`Options for ${q.id}`} style={{ gap: 6 }}>
      {q.options.map(o => <OptionCard key={o.letter} theme={theme} compact={compact} dense={dense} letter={o.letter} label={o.label} consequence={o.consequence} recommended={q.recommend === o.letter}
        selected={(open ? choice : q.answer?.choice) === o.letter} disabled={!open || run.isPending} onPress={() => setChoice(o.letter)} />)}
    </View>}
    {q.answer && <View style={{ gap: 6, padding: 10, borderRadius: 8, backgroundColor: tint(c.statusSuccess, c) }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ paddingTop: 2 }}><Icon name="CircleCheck" size={13} color={c.statusSuccess} /></View>
        <Text selectable style={[t.label, { flex: 1 }]}>{q.answer.by === "agent" ? "Answered in chat: " : "You answered "}{q.answer.choice}{chosen ? ` · ${chosen.label}` : ""}</Text>
      </View>
      {!!q.answer.words && <Text selectable style={[t.meta, { color: c.foreground, paddingLeft: 19 }]}>{q.answer.words}</Text>}
      {delivery && <View style={{ flexDirection: "row", gap: 6, paddingLeft: 19 }}>
        {delivery.tone === "spinner" ? <View style={{ paddingTop: 2 }}><Spinner color={c.foregroundMuted} size={11} /></View> : <View style={{ paddingTop: 2 }}><Icon name={delivery.icon} size={11} color={deliveryColor} /></View>}
        <Text style={[t.meta, { flex: 1, color: deliveryColor }]}>{delivery.text}</Text>
      </View>}
    </View>}
    {open && !pinned && input}
  </View>;
  const actions = (open || q.answer && ["queued", "unconfirmed", "copied"].includes(q.answer.delivery.state)) && <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {open && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Send" title="Send to agent" accessibilityLabel={`Send your ${q.id} answer to the agent`} accessibilityHint={compact ? `Puts your answer straight into the asking agent's chat, even mid-turn. Follow-up keeps it under ${q.id}.` : undefined} disabled={!answer || run.isPending} loading={run.isPending && run.variables === "send"} onPress={() => run.mutate("send")} />}
      {open && <Button theme={theme} compact={compact} icon="Copy" title="Copy" accessibilityLabel={`Copy your ${q.id} answer instead of sending it`} disabled={!answer || run.isPending} loading={run.isPending && run.variables === "copy"} onPress={() => run.mutate("copy")} />}
      {q.answer?.delivery.state === "copied" && <Button theme={theme} compact={compact} kind="primary" icon="Send" title="Send to agent" accessibilityLabel={`Send your ${q.id} answer to the agent`} loading={run.isPending} onPress={() => run.mutate("send")} />}
      {q.answer && ["queued", "unconfirmed"].includes(q.answer.delivery.state) && <Button theme={theme} compact={compact} icon="RotateCcw" title={q.answer.delivery.state === "queued" ? "Try now" : "Resend"} accessibilityLabel={`Send the ${q.id} answer again`} loading={run.isPending} onPress={() => run.mutate("resend")} />}
      {q.answer && ["queued", "unconfirmed"].includes(q.answer.delivery.state) && <Button theme={theme} compact={compact} kind="ghost" icon="Copy" title="Copy" accessibilityLabel={`Copy the ${q.id} answer`} onPress={() => { void copyText(replyText(q, q.answer!.choice, q.answer!.words)).then(() => toast.show("Copied", { variant: "success" }), () => toast.error("Couldn't copy here")); }} />}
      {q.answer?.delivery.state === "unconfirmed" && openAgent && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" onPress={() => openAgent(q.askedBy ?? w.mainAgentId)} />}
      {pinned && open && !free && !noteOpen && <Button theme={theme} compact={compact} kind="ghost" icon="Pencil" title="Note" accessibilityLabel={`Add a note for the agent about ${q.id}`} onPress={() => setNoteOpen(true)} />}
      {dense && onDetails && <IconButton theme={theme} compact={compact} icon="Maximize2" label={`Open ${q.id} with its links and full context`} onPress={onDetails} />}
    </View>
    {open && !dense && !compact && <Text style={t.small}>Send puts your answer straight into the asking agent's chat, even mid-turn. Follow-up keeps it under {q.id}.</Text>}
  </View>;
  // In the pill popover the question scrolls and the answer field and actions stay put, so Send is never cut off.
  if (pinned) {
    const showInput = open && (free || noteOpen);
    return <View style={{ gap: 10 }}>
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
      {showInput && input}
      {actions}
    </View>;
  }
  return <View style={{ gap: dense ? 10 : 14 }}>
    {body}
    {actions}
    {!dense && !compact && <Text style={t.small}>Asked {ago(q.askedAt, now)} by {who(w, q.askedBy)}{q.taskId && !q.options.length ? " (blocked task)" : ""}</Text>}
  </View>;
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

/** The question dialog: a sheet on phones, a dialog on desktop. */
export function QuestionSheet({ workspace: w, questionId, theme, compact, onClose, openAgent }: { workspace: Workspace; questionId: string | null; theme: Theme; compact: boolean; onClose: () => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors;
  const q = questionId ? w.questions.find(x => x.id === questionId) ?? null : null;
  const color = !q ? c.foregroundMuted : q.answer ? c.statusSuccess : q.closed ? c.foregroundMuted : c.statusWarning;
  return <Modal title={q ? `${q.id} · ${q.title}` : "Question"} icon={<Icon name={q?.answer ? "MessageCircleReply" : "MessageCircleQuestion"} size={18} color={color} />} open={!!q} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      {q && <QuestionBody key={q.id} workspace={w} question={q} theme={theme} compact={compact} openAgent={openAgent} />}
    </Modal.Content>
  </Modal>;
}

/** The pill steps through open questions ("1 of 3") and answers them without leaving the chat. */
export function QuestionStepper({ workspace: w, theme, compact, openAgent, onAnswered, onDetails, bodyMaxHeight }: { workspace: Workspace; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; onAnswered?: () => void; onDetails?: (id: string) => void; bodyMaxHeight?: number }) {
  const c = theme.colors; const t = text(c);
  const open = w.questions.filter(isOpen).sort((a, b) => Number(questionState(b) === "stopped") - Number(questionState(a) === "stopped"));
  const [index, setIndex] = useState(0);
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
      <Text accessibilityRole="header" numberOfLines={2} style={[t.label, { flex: 1 }]}>{q.id} · {q.title}</Text>
      {open.length > 1 && <>
        <Text accessibilityLabel={`Question ${at + 1} of ${open.length}`} style={[t.small, { marginLeft: 4 }]}>{at + 1} of {open.length}</Text>
        {arrow("ChevronLeft", "Previous question", -1)}{arrow("ChevronRight", "Next question", 1)}
      </>}
    </View>
    <QuestionBody key={q.id} workspace={w} question={q} theme={theme} compact={compact} dense bodyMaxHeight={bodyMaxHeight} openAgent={openAgent} onAnswered={onAnswered} onDetails={onDetails ? () => onDetails(q.id) : undefined} />
  </View>;
}

const toneColor = (c: Colors, tone: ActivityTone) => tone === "merged" ? mergedColor(c) : tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;

/** The workspace's log: a timeline of what happened, and every question under its ref. */
export function ActivityCard({ workspace: w, theme, compact, now, open, toggle, onOpenQuestion }: { workspace: Workspace; theme: Theme; compact: boolean; now: number; open: (key: string) => boolean; toggle: (key: string) => void; onOpenQuestion: (id: string) => void }) {
  const c = theme.colors; const t = text(c);
  const rows = activity(w);
  const questions = [...w.questions].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const [tab, setTab] = useState<"timeline" | "questions">("timeline");
  if (!rows.length && !questions.length) return null;
  const all = open("activity");
  const LIMIT = 5;
  const tabButton = (id: "timeline" | "questions", label: string, count?: number) => {
    const selected = tab === id;
    return <Pressable key={id} accessibilityRole="tab" aria-selected={selected} accessibilityState={{ selected }} accessibilityLabel={count !== undefined ? `${label}, ${count}` : label} onPress={() => setTab(id)} hitSlop={4}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 36 : 24, paddingHorizontal: 9, borderRadius: 999, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      {count !== undefined && <Text style={{ color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{count}</Text>}
    </Pressable>;
  };
  const list = tab === "timeline" ? rows : questions;
  const shown = all ? list : list.slice(0, LIMIT);
  return <Card theme={theme} compact={compact} icon="Activity" title="Activity"
    right={questions.length ? <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 2, marginVertical: -4 }}>{tabButton("timeline", "Timeline")}{tabButton("questions", "Questions", questions.length)}</View> : undefined}>
    {/* The timeline is drawn on the same rail as the stacks: a 2px line through 16px state nodes. */}
    {tab === "timeline" ? <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6, borderTopWidth: 1, borderTopColor: c.border }}>
      {(shown as typeof rows).map((r, i, all) => {
        const color = toneColor(c, r.tone);
        return <View key={r.key} style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 2, height: 8, backgroundColor: i === 0 ? "transparent" : c.border }} />
            <View style={{ width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: tint(color, c) }}><Icon name={r.icon} size={10} color={color} /></View>
            <View style={{ width: 2, flex: 1, minHeight: 4, backgroundColor: i === all.length - 1 ? "transparent" : c.border }} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2, paddingTop: 6, paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text numberOfLines={2} style={[t.body, { flex: 1 }]}>{r.text}</Text>
              <Text style={t.small}>{ago(r.at, now)}</Text>
            </View>
            {(r.detail || r.took) && <Text numberOfLines={2} style={t.meta}>{[r.detail, r.took ? `took ${r.took}` : null].filter(Boolean).join(" · ")}</Text>}
          </View>
        </View>;
      })}
    </View> : (shown as typeof questions).map(q => {
      const chosen = q.options.find(o => o.letter === q.answer?.choice);
      const status = q.answer ? `${q.answer.choice}${chosen ? ` · ${chosen.label}` : ""}` : q.closed ? `Withdrawn: ${q.closed.reason}` : "Waiting for you";
      const icon = q.answer ? "MessageCircleReply" : q.closed ? "MessageCircleOff" : "MessageCircleQuestion";
      const color = q.answer ? c.statusSuccess : q.closed ? c.foregroundMuted : c.statusWarning;
      return <CardRow key={q.id} theme={theme} onPress={() => onOpenQuestion(q.id)} accessibilityLabel={`${q.id}, ${q.title}. ${status}. Open`}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={icon} size={13} color={color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text numberOfLines={1} style={[t.body, { flex: 1 }]}>{q.id} · {q.title}</Text>
              <Text style={t.small}>{ago(q.answer?.at ?? q.closed?.at ?? q.askedAt, now)}</Text>
            </View>
            <Text numberOfLines={2} style={[t.meta, !q.answer && !q.closed ? { color: c.statusWarning } : null]}>{status}</Text>
          </View>
        </View>
      </CardRow>;
    })}
    {list.length > LIMIT && <FoldRow theme={theme} compact={compact} open={all} onPress={() => toggle("activity")} icon="History" iconColor={c.foregroundMuted} label={all ? "Show less" : `Show all ${list.length}`} />}
  </Card>;
}
