import { useMemo, useState, useSyncExternalStore } from "react";
import { browserKey, liveBriefKey, LIVE_BRIEF_POLL_MS, workspaceKey } from "./keys";
import { Platform, View, useWindowDimensions } from "react-native";
import { Pressable, Text } from "./text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openExternalUrl, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { BRIEF_KIND, BRIEF_VERSION, askedDecisions, cardPicks, notedCount, pickedCount, briefSchema, collapsedLine, extrasFit, hasOriginal, nothingNeededLine, isTight, pastRows, pastTone, selectsFirst, sendBar, shownBrief, pastAsk, liveBrief, newAnswerId, undeliveredReason, type Brief, type BriefDecision, type BriefMove } from "../shared/brief";
import { age } from "../shared/inbox";
import { noReviewReposVersion, onNoReviewRepos } from "../shared/pr-workflow";
import { briefKey, HEADLINE_WORD } from "../shared/headline";
/** The card's kind word comes from the same table as the pill and the Needs-you row. */
const word = (kind: Brief["kind"]) => HEADLINE_WORD[briefKey(kind)];
import { answerQuestionRpc, briefActionRpc, browserStatusRpc, inboxBriefRpc } from "../shared/contracts";
import { errorText, mootNote } from "../shared/errors";
import { OTHER, OTHER_LABEL, isOther } from "../shared/questions";
import type { Workspace } from "../shared/model";
import { SubmitScope, submitHint, text, useNow } from "./kit";
import { PrLinksProvider, RichText } from "./rich-text";
import { prLinksByNumber } from "../shared/presentation";
import { cardStore } from "./card-store";
import { PrSheet } from "./pr-sheet";
import { isLight, withAlpha, type Colors } from "./theme";
import { dismissToast, notice, runAction, runUndoable } from "./toasts";

/**
 * The brief card (design §2): the ask in one line, decisions as option rows, only the context needed, and the one
 * move for this kind of ask. It sits at the end of the timeline, right above the composer and the Needs-you control.
 */
export type BriefDeps = {
  signOff(agentId: string): void;
  openNext(from: string): void;
  openAgent(agentId: string): void;
  workspace(id: string): Workspace | undefined;
  /** Opens Follow-up's panel for a workspace whose record this client hasn't loaded yet. */
  openPanel(workspaceId: string): void;
  /** Done's Undo window, so the composer pill says Done (and its Undo cancels the same toast) until it ends. */
  noteDone?(agentId: string, cancel: () => void): void;
  endDone?(agentId: string): void;
};

const mono = () => (Platform.OS === "ios" ? "Menlo" : "ui-monospace, SFMono-Regular, Menlo, monospace");
/** Kinds the developer has to act on wear the attention tone; a plain finish and the fallback stay neutral. */
const ACTS: Brief["kind"][] = ["decision", "action", "review", "reviewers", "permission", "paused", "error"];
const ICON: Record<Brief["kind"], string> = { decision: "MessageCircleQuestion", action: "Hand", review: "GitPullRequest", reviewers: "UserPlus", permission: "ShieldQuestion", paused: "CirclePause", error: "CircleX", done: "CircleCheck", unknown: "CircleDashed" };
const kindTone = (kind: Brief["kind"], c: Colors) => kind === "error" ? c.statusDanger : kind === "review" || kind === "done" ? c.statusSuccess : kind === "unknown" ? c.foregroundMuted : c.statusWarning;
const factTone = (tone: string, c: Colors) => tone === "ok" ? c.statusSuccess : tone === "warn" ? c.statusWarning : tone === "bad" ? c.statusDanger : c.foregroundMuted;
/** The time in the device's own format (12- or 24-hour), like the chat's timestamps. */
const clock = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; };
/** Whether the focused element got focus from the keyboard (a tap or click doesn't draw the ring). */
const keyboardFocus = () => { try { return !!(globalThis as { document?: { activeElement?: { matches?(q: string): boolean } | null } }).document?.activeElement?.matches?.(":focus-visible"); } catch { return true; } };
/** Web keyboard focus: a visible ring, since sending an answer is one-shot. Not after a tap, where it read as a state. */
const ring = (focused: boolean | undefined, c: Colors) => focused && Platform.OS === "web" && keyboardFocus() ? ({ outlineWidth: 2, outlineStyle: "solid", outlineColor: withAlpha(c.accent, 0.6), outlineOffset: 2 } as object) : {};
const letters = (d: BriefDecision) => { const l = d.options.map(o => o.letter); return l.length > 1 ? `${l.slice(0, -1).join(", ")} or ${l.at(-1)}` : l[0] ?? ""; };

function Btn({ label, icon, primary, onPress, c, compact, disabled, shortcut = false, hint }: { label: string; icon?: string; primary?: boolean; onPress: () => void; c: Colors; compact: boolean; disabled?: boolean; shortcut?: boolean; hint?: string }) {
  const fg = primary ? c.accentForeground : c.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), minHeight: compact ? 44 : 32, paddingHorizontal: compact ? 14 : 12, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", opacity: disabled ? 0.5 : 1,
      backgroundColor: primary ? (pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent) : pressed || hovered ? c.surface2 : "transparent",
      borderWidth: primary ? 0 : 1, borderColor: c.border, flexGrow: compact ? 1 : 0 })}>
    {icon ? <Icon name={icon} size={compact ? 16 : 14} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : 13, lineHeight: compact ? 19 : 17, fontWeight: "600" }}>{label}</Text>
    {shortcut && !compact && Platform.OS === "web" && <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: fg, opacity: 0.6, fontSize: 11, lineHeight: 16, fontWeight: "500" }}>{submitHint()}</Text>}
  </Pressable>;
}

/** Picks on a multi-decision card (client/card-store.ts): a pick made in one copy of the card shows in the others. */
const pickStore = cardStore(true);
/** Something else's words, per decision, shared the same way so a half-written answer survives a re-render elsewhere. */
const wordStore = cardStore(false);
/** A note on a lettered pick ("A, but…"), per decision, and whether its field is open; kept like the words. */
const noteStore = cardStore(false);
const noteOpenStore = cardStore(false);
const useNotes = (briefId: string) => useSyncExternalStore(noteStore.subscribe, () => noteStore.get(briefId), () => noteStore.get(briefId));
const useNotesOpen = (briefId: string) => useSyncExternalStore(noteOpenStore.subscribe, () => noteOpenStore.get(briefId), () => noteOpenStore.get(briefId));
/** A sent answer leaves nothing behind on the card: picks, Something else's words and notes. */
const clearCard = (briefId: string) => { pickStore.clear(briefId); wordStore.clear(briefId); noteStore.clear(briefId); noteOpenStore.clear(briefId); };
const useWords = (briefId: string) => useSyncExternalStore(wordStore.subscribe, () => wordStore.get(briefId), () => wordStore.get(briefId));
/** Picks that can be sent: Something else counts only once it has words. */
const ready = (picks: Record<string, string>, words: Record<string, string>) => Object.fromEntries(Object.entries(picks).filter(([id, c]) => !isOther(c) || !!words[id]?.trim()));
const usePicks = (briefId: string) => useSyncExternalStore(pickStore.subscribe, () => pickStore.get(briefId), () => pickStore.get(briefId));

/**
 * One option. `send` answers on tap (a single-decision card); `select` marks it as this decision's pick (a card with
 * several decisions, sent together); `readonly` shows a past card, the chosen option marked and the rest dimmed.
 */
function OptionRow({ option, recommended, sending, disabled, tight, open, onToggle, onPress, c, compact, mode = "send", selected = false, answered = false, other = false, answerLabel = "Your answer", withNote = false }: {
  option: BriefDecision["options"][number]; recommended: boolean; sending: boolean; disabled: boolean; tight: boolean; open: boolean; onToggle: () => void; onPress: () => void; c: Colors; compact: boolean;
  mode?: "send" | "select" | "readonly"; selected?: boolean; answered?: boolean; other?: boolean; answerLabel?: string;
  /** A single-decision card with a note typed: the tap sends this letter with it, and the row says so. */
  withNote?: boolean;
}) {
  const strong = withAlpha(c.foreground, isLight(c) ? 0.38 : 0.42);
  const showDetail = !!option.consequence && (!tight || open);
  const readonly = mode === "readonly";
  // Something else marks itself in send mode too: tapping it opens the answer field instead of sending.
  const marked = selected && (mode !== "send" || other);
  // While picking, only a pick is loud: a recommendation keeps its label but not the filled badge, so it never looks
  // picked. A past card mutes what wasn't picked through colour, not opacity, so it stays readable.
  const dim = !readonly && disabled && !sending;
  const muted = readonly && answered && !selected;
  const loudRecommend = recommended && mode === "send";
  const border = marked ? c.accent : loudRecommend ? strong : c.border;
  const badge = marked ? c.accent : loudRecommend ? c.foreground : c.surface2;
  const badgeText = marked ? c.accentForeground : loudRecommend ? c.surface1 : muted ? c.foregroundMuted : c.foreground;
  const noted = withNote && mode === "send" && !other;
  const chip = noted ? <View style={{ flexDirection: "row", alignItems: "center", gap: 5, alignSelf: compact ? "flex-start" : "center", marginTop: compact ? 4 : 0, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: withAlpha(c.accent, isLight(c) ? 0.08 : 0.14) }}>
    <Icon name="Send" size={12} color={c.accent} />
    <Text numberOfLines={1} style={{ color: c.accent, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{`Send ${option.letter} with note`}</Text>
  </View> : null;
  const label = noted ? `Send ${option.letter} with your note: ${option.label}${recommended ? " (recommended)" : ""}` : other ? `${option.label}${readonly ? `: ${option.consequence ?? ""}` : ", write your own answer"}` : mode === "select" ? `${option.letter}: ${option.label}${recommended ? " (recommended)" : ""}` : readonly ? `${option.letter}: ${option.label}${selected ? " (your answer)" : ""}` : `Answer ${option.letter}: ${option.label}${recommended ? " (recommended)" : ""}`;
  return <View style={{ flexDirection: "row", alignItems: "stretch", borderRadius: 8, borderWidth: 1, borderColor: noted ? withAlpha(c.accent, recommended ? 0.9 : 0.5) : border, backgroundColor: marked && !readonly ? withAlpha(c.accent, isLight(c) ? 0.06 : 0.1) : "transparent", opacity: dim ? 0.45 : 1, overflow: "hidden" }}>
    <Pressable accessibilityRole={mode === "select" || other && !readonly ? "radio" : readonly ? "text" : "button"} accessibilityLabel={label} accessibilityHint={mode === "select" && selected ? "Tap again to clear" : option.consequence ?? undefined}
      accessibilityState={mode === "select" || other && !readonly ? { checked: selected, disabled } : { disabled: disabled || readonly, busy: sending }} disabled={disabled || readonly} onPress={onPress}
      style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: readonly ? (compact ? 8 : 7) : compact ? 11 : 9, paddingHorizontal: 10, minHeight: readonly ? 0 : compact ? 44 : 0,
        backgroundColor: readonly ? "transparent" : pressed ? c.surface2 : hovered && !disabled ? withAlpha(c.foreground, 0.05) : "transparent" })}>
      <View style={{ width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: badge }}>
        {marked ? <Icon name="Check" size={13} color={badgeText} /> : other ? <Icon name="PenLine" size={12} color={badgeText} /> : <Text style={{ fontSize: 12, fontWeight: "700", color: badgeText }}>{option.letter}</Text>}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, flexWrap: "wrap" }}>
          <RichText linkColor={c.foreground} style={{ color: muted ? c.foregroundMuted : c.foreground, fontSize: 14, lineHeight: 20, fontWeight: muted ? "400" : "600" }}>{`${marked && !other ? `${option.letter} · ` : ""}${option.label}`}</RichText>
          {recommended && !readonly && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Recommended</Text>}
          {readonly && selected && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{answerLabel}</Text>}
          {sending && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Sending…</Text>}
        </View>
        {showDetail && <RichText linkColor={c.foreground} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{option.consequence}</RichText>}
        {compact && chip}
      </View>
      {!compact && chip}
    </Pressable>
    {tight && !!option.consequence && <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${open ? "Hide" : "Show"} what ${option.letter} means`} onPress={onToggle}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), width: 44, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
      <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}><Icon name="ChevronDown" size={16} color={c.foregroundMuted} /></View>
    </Pressable>}
  </View>;
}

/** "Add note" / "Remove note": a quiet text link (muted, 13px), 44 tall on phones. */
function NoteLink({ icon, label, a11y, disabled, onPress, c, compact }: { icon: string; label: string; a11y: string; disabled: boolean; onPress: () => void; c: Colors; compact: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={6}
    style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: compact ? 44 : 28, paddingHorizontal: 4, marginLeft: -4, borderRadius: 6, opacity: disabled ? 0.5 : pressed ? 0.7 : 1, backgroundColor: hovered && !disabled ? withAlpha(c.foreground, 0.05) : "transparent" })}>
    <Icon name={icon} size={14} color={c.foregroundMuted} />
    <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}

/**
 * The card's body: decisions, error text, details, context, facts and links, and the agent's extra ask. Shared by the
 * open card and by a past card's read-only "Show full question", so a past question reads exactly as it was asked.
 */
function BriefBody({ b, c, compact, tight, embedded, height, mode, picks, onPick, busy, onSend, words = {}, onWords, onSendOther, notes = {}, notesOpen = {}, onNote, onNoteOpen }: {
  b: Brief; c: Colors; compact: boolean; tight: boolean; embedded: boolean; height: number;
  mode: "send" | "select" | "readonly"; picks: Record<string, string>; onPick: (decisionId: string, letter: string) => void; busy: string | null; onSend?: (key: string) => void;
  words?: Record<string, string>; onWords?: (decisionId: string, text: string) => void; onSendOther?: (decisionId: string) => void;
  /** Notes on lettered picks, and which decisions have the note field open (client/card-store.ts: they survive re-renders). */
  notes?: Record<string, string>; notesOpen?: Record<string, string>; onNote?: (decisionId: string, text: string) => void; onNoteOpen?: (decisionId: string, open: boolean) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState(false);
  const [fullContext, setFullContext] = useState(false);
  // Only the copy whose "Add note" was pressed takes focus: the chat, the panel and Home can show the same card, and a
  // field opening in another copy (the store is shared) must never pull the caret out of the one being typed in.
  const [focusNote, setFocusNote] = useState<string | null>(null);
  const [contextWidth, setContextWidth] = useState(0);
  const readonly = mode === "readonly";
  // An agent's brief_action answered this card for the developer: say whose answer it is, never "Your answer".
  const answerLabel = b.answeredBy?.startsWith("agent:") ? `${b.answeredByTitle ?? "An agent"}'s answer` : "Your answer";
  const extra = !!b.context || b.facts.length > 0 || b.links.length > 0;
  const showExtra = readonly || !tight || details || extrasFit(b, height);
  const numbered = b.decisions.length > 1;
  return <>
    {b.decisions.map((d, i) => <View key={d.id} accessibilityRole={mode === "select" ? "radiogroup" : undefined} accessibilityLabel={mode === "select" ? d.question : undefined} style={{ gap: 8 }}>
      {(numbered || d.question.trim() !== b.ask.trim()) && <RichText style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: numbered ? "600" : "400" }}>{`${numbered ? `${i + 1}. ` : ""}${d.question}`}</RichText>}
      {d.options.length > 0 && <View style={{ gap: 6 }}>
        {d.options.map(o => <OptionRow key={o.letter} option={o} recommended={d.recommend === o.letter} mode={mode} answerLabel={answerLabel} selected={readonly ? d.chosen === o.letter : picks[d.id] === o.letter} answered={readonly && !!d.chosen}
          sending={busy === `${d.id}:${o.letter}`} disabled={!!busy} tight={tight && !readonly} withNote={!!notesOpen[d.id] && !!notes[d.id]?.trim()}
          open={!!open[`${d.id}:${o.letter}`]} onToggle={() => setOpen(v => ({ ...v, [`${d.id}:${o.letter}`]: !v[`${d.id}:${o.letter}`] }))}
          onPress={() => mode === "send" ? onSend?.(`${d.id}:${o.letter}`) : onPick(d.id, o.letter)} c={c} compact={compact} />)}
        {/* Built in after the agent's options on every decision: the developer's own answer. */}
        {(!readonly || isOther(d.chosen)) && <OptionRow other option={{ letter: "", label: OTHER_LABEL, consequence: readonly ? `"${d.words ?? ""}"` : null }} recommended={false} mode={mode} answerLabel={answerLabel}
          selected={readonly ? isOther(d.chosen) : isOther(picks[d.id])} answered={readonly && !!d.chosen} sending={busy === `${d.id}:${OTHER}`} disabled={!!busy} tight={false} open={false} onToggle={() => undefined}
          onPress={() => onPick(d.id, OTHER)} c={c} compact={compact} />}
        {!readonly && isOther(picks[d.id]) && <View style={{ gap: 8 }}>
          <TextInput accessibilityLabel={`Your answer${numbered ? ` to question ${i + 1}` : ""}, required`} placeholder="Your answer (required)" placeholderTextColor={c.foregroundMuted} autoFocus multiline maxLength={2000}
            value={words[d.id] ?? ""} editable={!busy} onChangeText={t => onWords?.(d.id, t)}
            style={{ minHeight: compact ? 66 : 58, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: words[d.id]?.trim() ? c.border : withAlpha(c.accent, 0.7), color: c.foreground, backgroundColor: c.surface0, fontSize: 14, lineHeight: 20, textAlignVertical: "top" }} />
          {mode === "send" && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <Btn shortcut label={busy === `${d.id}:${OTHER}` ? "Sending…" : "Send answer"} icon="Send" primary disabled={!words[d.id]?.trim() || !!busy} onPress={() => onSendOther?.(d.id)} c={c} compact={compact} />
            {!words[d.id]?.trim() && <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Write your answer, then send it.</Text>}
          </View>}
        </View>}
        {/* A note on a lettered pick ("A, but…"): quiet until asked for, never in the way of the one-tap answer. */}
        {!readonly && !isOther(picks[d.id]) && (notesOpen[d.id] ? <View style={{ gap: 6, marginTop: 2 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Note</Text>
          <TextInput accessibilityLabel={`Note for the agent${numbered ? ` on decision ${i + 1}` : ""}, optional`} placeholder={mode === "select" ? "Sent with your pick for this decision" : "Sent with the option you tap"}
            placeholderTextColor={c.foregroundMuted} autoFocus={focusNote === d.id} multiline maxLength={2000} value={notes[d.id] ?? ""} editable={!busy} onChangeText={t => onNote?.(d.id, t)}
            style={{ minHeight: compact ? 66 : 58, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0, fontSize: 14, lineHeight: 20, textAlignVertical: "top" }} />
          <NoteLink icon="X" label="Remove note" a11y={`Remove the note${numbered ? ` on decision ${i + 1}` : ""}`} disabled={!!busy} onPress={() => { onNote?.(d.id, ""); onNoteOpen?.(d.id, false); setFocusNote(null); }} c={c} compact={compact} />
        </View> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14 }}>
          <NoteLink icon="MessageSquarePlus" label="Add note" a11y={numbered ? `Add note to decision ${i + 1}` : "Add note"} disabled={!!busy} onPress={() => { setFocusNote(d.id); onNoteOpen?.(d.id, true); }} c={c} compact={compact} />
          {mode === "send" && !tight && !embedded && <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{`Or type ${letters(d)} in the composer.`}</Text>}
        </View>)}
      </View>}
      {readonly && !!d.chosen && !isOther(d.chosen) && !!d.words && <RichText selectable linkColor={c.foreground} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{`Note: ${d.words}`}</RichText>}
      {readonly && b.state === "answered" && d.options.length > 0 && !d.chosen && numbered && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Skipped</Text>}
      {!readonly && mode === "send" && !tight && !d.options.length && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{embedded ? "Reply below." : "Reply in the composer."}</Text>}
      {!readonly && (mode === "select" || tight) && !d.options.length && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{embedded ? "Reply below." : "Reply in the composer."}</Text>}
    </View>)}

    {!!b.mono && !b.ask.endsWith(b.mono) && <View style={{ borderRadius: 8, backgroundColor: withAlpha(c.statusDanger, isLight(c) ? 0.07 : 0.1), paddingHorizontal: 10, paddingVertical: 8 }}>
      <RichText selectable numberOfLines={tight && !readonly ? 3 : undefined} style={{ color: c.foreground, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{b.mono}</RichText>
    </View>}

    {!readonly && extra && tight && !extrasFit(b, height) && <Pressable accessibilityRole="button" aria-expanded={details} accessibilityLabel={details ? "Hide details" : "Show details"} onPress={() => setDetails(v => !v)} hitSlop={6}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 }}>
      <View style={{ transform: [{ rotate: details ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
      <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>Details</Text>
    </Pressable>}

    {showExtra && !!b.context && <View onLayout={e => setContextWidth(e.nativeEvent.layout.width)}>
      <RichText selectable linkColor={c.foreground} numberOfLines={readonly || fullContext ? undefined : CONTEXT_LINES} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{b.context}</RichText>
    </View>}
    {/* Clamped by lines (a word boundary, with an ellipsis), never cut in the data; long context opens in full. */}
    {showExtra && !readonly && clamps(b.context, CONTEXT_LINES, contextWidth) && <Reveal label="Show more" openLabel="Show less" open={fullContext} onPress={() => setFullContext(v => !v)} c={c} compact={compact} />}

    {showExtra && (b.facts.length > 0 || b.links.length > 0) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {b.facts.slice(0, 3).map((f, i) => { const col = factTone(f.tone, c); return <View key={`f${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, minHeight: 24, borderRadius: 6, backgroundColor: f.tone === "muted" ? c.surface2 : withAlpha(col, isLight(c) ? 0.1 : 0.14) }}>
        <Icon name={f.icon} size={12} color={col} />
        <Text style={{ color: f.tone === "muted" || isLight(c) ? c.foreground : col, fontSize: 12, lineHeight: 16, fontWeight: "500" }}>{f.label}</Text>
      </View>; })}
      {b.links.map((l, i) => <Pressable key={`l${i}`} accessibilityRole={l.url ? "link" : "text"} disabled={!l.url} onPress={() => l.url && void openExternalUrl(l.url).catch(() => undefined)} hitSlop={compact ? 10 : 4}
        style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, minHeight: 24, borderRadius: 6, backgroundColor: c.surface2 }}>
        <Icon name={l.url ? "ExternalLink" : l.pr ? "GitPullRequest" : "File"} size={12} color={c.foregroundMuted} />
        <Text selectable={!l.url} numberOfLines={1} style={{ color: c.foreground, fontSize: 12, lineHeight: 16, fontWeight: "500", maxWidth: 260 }}>{l.label}</Text>
      </Pressable>)}
    </View>}
  </>;
}

/** The decision-card's send bar: one message for every pick, or an explicit partial send that names what it skips. */
function SendBar({ b, picks, noted = 0, busy, error, onSend, c, compact }: { b: Brief; picks: Record<string, string>; noted?: number; busy: string | null; error: string | null; onSend: () => void; c: Colors; compact: boolean }) {
  const bar = sendBar(b, picks);
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Btn shortcut label={busy === "answers" ? "Sending…" : bar.label} icon="Send" primary={bar.ready && !bar.partial} disabled={!bar.ready || !!busy} onPress={onSend} c={c} compact={compact} />
      {!bar.ready && <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Pick your answers, then send them in one message.</Text>}
      {bar.ready && noted > 0 && <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{noted === 1 ? "1 with a note" : `${noted} with notes`}</Text>}
    </View>
    {bar.skipped && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{bar.skipped}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>Couldn't send: {error} Your picks are kept; try again.</Text>}
  </View>;
}

/** "Show full question" / "Show original": a past card opens back up, read-only. */
const CONTEXT_LINES = 4;
/**
 * Whether 13px text likely runs past `lines` lines at its measured width, so it gets Show more. It errs toward showing
 * the toggle (a wide 7px a character): a toggle that reveals nothing costs less than text nobody can read.
 */
const clamps = (t: string | null | undefined, lines: number, width: number) => !!t && t.length > lines * Math.max(30, (width || 300) / 7);

function Reveal({ label, openLabel, open, onPress, c, compact }: { label: string; openLabel?: string; open: boolean; onPress: () => void; c: Colors; compact: boolean }) {
  const text = open ? openLabel ?? label.replace(/^Show/, "Hide") : label;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={text} onPress={onPress} hitSlop={6}
    style={({ focused }: { pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 })}>
    <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
    <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>{text}</Text>
  </Pressable>;
}

/**
 * A card that's no longer open keeps its question (1.4.0). Answered: the ask, each decision with what was picked, and
 * "Show full question" opens the original read-only. Superseded or signed off: the one muted line, plus "Show original".
 */
function Past({ b, c, now, compact, height, pending = false, onResend, resending = false }: { b: Brief; c: Colors; now: number; compact: boolean; height: number; pending?: boolean; onResend?: () => void; resending?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const answered = b.state === "answered";
  const ask = pastAsk(b.ask);
  const asked = askedDecisions(b);
  const picked = answered && asked.some(d => d.chosen);
  // The answer is recorded the moment Send is pressed; getting it to the agent can take Paseo a minute or more (a dormant
  // agent resumes first). Until it lands the card reads as in progress, and if every retry failed it says so with Send again.
  const sending = pending || b.delivery?.state === "sending";
  const failed = b.delivery?.state === "failed";
  // Pending reads as in progress (a dashed circle), and becomes the solid check when the send lands.
  const icon = b.state === "superseded" ? "History" : failed ? "CircleAlert" : sending ? "CircleDashed" : "CircleCheck";
  const spoken = pending ? `Done, sending (undo available): ${ask}` : failed ? `Answer not delivered: ${ask}` : sending ? `Answered, sending to the agent: ${ask}` : undefined;
  const color = failed ? c.statusDanger : pastTone(b.state, sending) === "success" ? c.statusSuccess : c.foregroundMuted;
  // A Done card already says "Done" as its outcome; its time stands alone rather than repeating it.
  const right = b.delivery?.state === "sending" && !pending ? "Sending…" : answered && b.outcomeAt ? (b.outcome === "Done" ? clock(b.outcomeAt) : `Answered ${clock(b.outcomeAt)}`) : age(b.outcomeAt ?? b.at, now);
  const undelivered = (indent: number) => failed && <View style={{ paddingLeft: indent, gap: 8, alignItems: "flex-start" }}>
    <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{`Not delivered to the agent: ${undeliveredReason(b.delivery?.error)} Your answer is kept.`}</Text>
    {onResend && <Btn label={resending ? "Sending…" : "Send again"} icon="RotateCcw" onPress={onResend} disabled={resending} c={c} compact={compact} hint="Sends the same answer once more" />}
  </View>;
  const body = expanded && <View style={{ gap: 10, paddingTop: 4 }}>
    <BriefBody b={b} c={c} compact={compact} tight={false} embedded height={height} mode="readonly" picks={{}} onPick={() => undefined} busy={null} />
  </View>;
  if (!picked) return <View accessibilityLiveRegion="polite" accessibilityLabel={spoken} style={{ marginVertical: 10, gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}>
    <View style={{ flexDirection: "row", gap: 10, alignItems: answered ? "flex-start" : "center", minHeight: 24 }}>
      <View style={{ paddingTop: answered ? 2 : 0 }}><Icon name={icon} size={15} color={color} /></View>
      {answered && b.outcome !== "Done"
        ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <RichText linkColor={c.foreground} numberOfLines={expanded ? undefined : 1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{ask}</RichText>
            <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{b.outcome}</Text>
          </View>
        : <Text numberOfLines={expanded ? undefined : 1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{collapsedLine(b)}</Text>}
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
    {undelivered(25)}
    {hasOriginal(b) && <View style={{ paddingLeft: 25 }}><Reveal label={answered ? (b.kind === "action" ? "Show full ask" : "Show full question") : "Show original"} open={expanded} onPress={() => setExpanded(v => !v)} c={c} compact={compact} /></View>}
    {body}
  </View>;
  // Answered with picks: the ask, then each decision's question and the picked option, so the answer is never
  // separated from what it answered.
  return <View accessibilityRole="summary" accessibilityLabel={spoken ?? `Answered: ${ask}`} style={{ marginVertical: 10, gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}><Icon name={icon} size={15} color={color} /></View>
      <RichText style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{ask}</RichText>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 20, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
    {!expanded && <View style={{ gap: 6, paddingLeft: 23 }}>
      {pastRows(b).map(r => <View key={r.id} style={{ gap: 1 }}>
        {!!r.question && <RichText linkColor={c.foreground} numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{r.question}</RichText>}
        <RichText style={{ color: r.answer ? c.foreground : c.foregroundMuted, fontSize: 13, lineHeight: 19, fontWeight: r.answer ? "600" : "400" }}>{r.answer ?? "Skipped"}</RichText>
      </View>)}
    </View>}
    {undelivered(23)}
    <View style={{ paddingLeft: 23 }}><Reveal label="Show full question" open={expanded} onPress={() => setExpanded(v => !v)} c={c} compact={compact} /></View>
    {expanded && <View style={{ paddingLeft: 23 }}>{body}</View>}
  </View>;
}

/** `embedded`: inside Home's detail pane, which has its own reply box and action bar, so the card drops its moves. */
/** `snoozed`: the row is in Later, so the card wears the row's muted tone and says "Later" instead of "Needs you". */
/** `bare`: a section of the Needs you block (client/needs-you.tsx), whose frame says "Needs you": no border, margin or second label. */
type BriefCardProps = PluginTimelineItemProps<Brief> & { deps: BriefDeps; embedded?: boolean; snoozed?: boolean; bare?: boolean };
/** A brief names its PRs ("#240 is merged"): each "#N" its workspace tracks opens that PR (a-row-that-names-a-pr-opens-it-in-one-click). */
export function BriefCard(props: BriefCardProps) {
  const workspace = props.item.data.workspaceId ? props.deps.workspace(props.item.data.workspaceId) : undefined;
  const prs = useMemo(() => workspace ? prLinksByNumber(workspace.prs) : undefined, [workspace?.prs]);
  return <PrLinksProvider prs={prs}><BriefCardBody {...props} /></PrLinksProvider>;
}

function BriefCardBody({ item, theme, layout, agentId, deps, embedded = false, snoozed = false, bare = false }: BriefCardProps) {
  const c = theme.colors; const row = item.data; const compact = layout.compact;
  // The row is a snapshot; the live brief decides (shownBrief). Only a row that still looks open asks, one query per
  // agent for every card in its chat. A card is actionable only when the server says this exact brief is open.
  const readBrief = useRpc(inboxBriefRpc);
  const cache = useQueryClient();
  const live = useQuery({ queryKey: liveBriefKey(agentId), queryFn: () => readBrief({ agentId }), enabled: row.state === "open" && !!agentId, refetchInterval: LIVE_BRIEF_POLL_MS, staleTime: 5_000 });
  const workspace = row.workspaceId ? deps.workspace(row.workspaceId) : undefined;
  const checked = shownBrief(row, live.data, workspace?.questions ?? []);
  // The check itself failed (or there's no agent to ask): don't leave a dead card. The server still validates every
  // action against the stored brief, and a moot refusal reconciles, so acting on the row is safe.
  const unverifiable = live.isError || !agentId;
  const shown = row.state !== "open" ? { brief: row, actionable: false } : unverifiable && checked.brief.state === "open" ? { ...checked, actionable: true } : checked;
  const b = shown.brief;
  // "No ask stated" while this workspace has an open question would tell the developer there's nothing to do: the
  // fallback points at the questions instead (Needs you asks them; one ask, one surface each).
  const waitingOn = b.source === "none" && b.state === "open" ? (workspace?.questions ?? []).filter(q => !q.answer && !q.closed).map(q => q.id) : [];
  const askText = waitingOn.length ? `Waiting on your answer to ${waitingOn.join(", ")}` : b.ask;
  // A refusal that means "already answered or replaced" isn't a failure: re-read, and the card shows what happened.
  const reconcile = (e?: unknown) => { if (e !== undefined) notice(mootNote(e), toast); setError(null); void cache.invalidateQueries({ queryKey: liveBriefKey(agentId) }); if (row.workspaceId) void cache.invalidateQueries({ queryKey: workspaceKey(row.workspaceId) }); };
  const now = useNow(60_000);
  useSyncExternalStore(onNoReviewRepos, noReviewReposVersion, noReviewReposVersion);
  const { height } = useWindowDimensions();
  const act = useRpc(briefActionRpc);
  const answerQuestion = useRpc(answerQuestionRpc);
  const browserRead = useRpc(browserStatusRpc);
  const [sending, setBusy] = useState<string | null>(null);
  // Until the server confirms this brief is the open one, every control waits ("checking" matches no button's key).
  const busy = sending ?? (shown.actionable ? null : "checking");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [why, setWhy] = useState(false);
  // Done collapses the card the moment it's pressed; the server's answered brief replaces this when the send lands.
  const [marked, setMarked] = useState<string | null>(null);
  // The send landed: green at once, before the server's answered brief replaces the card.
  const [sent, setSent] = useState(false);
  const picks = usePicks(b.id);
  const words = useWords(b.id);
  const notes = useNotes(b.id);
  const notesOpen = useNotesOpen(b.id);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), enabled: !!sheet, staleTime: 0, refetchOnMount: "always" });
  // Send again on an undelivered answer: the same answerId, so the server resends that answer and never a second one.
  const resend = () => {
    // Only a send in flight blocks it: a resolved card is never "actionable", but its undelivered answer can go again.
    if (sending || !b.answerId) return; setBusy("resend");
    void runAction({ label: "Answer", toast, run: () => act({ agentId, briefId: b.id, answerId: b.answerId! }), success: () => null, reconcile, failure: "Your answer wasn't sent again" }).finally(() => setBusy(null));
  };
  // An add-reviewers card for a PR the agent merges itself isn't an ask: gone the moment the repository flips to No
  // review, back on Undo (invariant a-no-review-repo-never-asks-for-review-or-merge).
  if (b.state === "open" && !liveBrief(b)) return null;
  if (shown.brief.state !== "open") return <Past b={shown.brief} c={c} now={now} compact={compact} height={height} onResend={b.answerId ? resend : undefined} resending={sending === "resend"} />;
  // Muted until the send lands: the server's answered brief then replaces this, green.
  if (marked) return <Past b={{ ...b, state: "answered", outcome: "Done", outcomeAt: marked }} pending={!sent} c={c} now={now} compact={compact} height={height} />;

  const attention = c.statusWarning;
  const flaggedAct = b.flagged && ACTS.includes(b.kind);
  // In Later the card goes quiet like its Home row: no attention colour, and its label says Later.
  const acts = flaggedAct && !snoozed;
  const tone = !snoozed && (acts || b.kind === "done" || b.kind === "review" || b.kind === "error") ? kindTone(b.kind, c) : c.foregroundMuted;
  const ageText = age(b.at, now);
  const border = acts ? withAlpha(attention, isLight(c) ? 0.5 : 0.45) : c.border;
  // Every send from the card (a pick, Something else, Send answers, the keyboard's Send) goes through runAction: the
  // card keeps the picks and words and says what failed, and the toast offers Retry. Success is the card itself.
  // One answerId per Send: the toast's Retry runs the same closure, so it repeats this answer instead of sending a second.
  const run = async (key: string, work: (answerId: string) => Promise<unknown>, failure = "Your answer wasn't sent") => {
    if (busy) return; setBusy(key); setError(null);
    const answerId = newAnswerId();
    await runAction({ label: "Brief", toast, run: () => work(answerId), success: () => null, onError: e => setError(errorText(e)), reconcile, failure });
    setBusy(null);
  };
  // Done: "Done: <ask>" can't be unsent, so it goes out when the toast's Undo window ends (runUndoable). A failure
  // reopens the card with the reason; the toast keeps Retry, and Open brings the agent's chat back.
  const markDone = () => {
    if (busy || marked) return;
    setError(null); setSent(false); setMarked(new Date().toISOString());
    const doneId = newAnswerId();
    const id = runUndoable("Telling the agent it's done", { label: "Done", toast, run: () => act({ agentId, briefId: b.id, move: "done", answerId: doneId }), success: "Marked done. The agent has it.",
      failure: "Done not sent", open: () => deps.openAgent(agentId), onSuccess: () => setSent(true), onError: e => { setMarked(null); setError(errorText(e)); }, reconcile: e => { setMarked(null); reconcile(e); } }, () => setMarked(null), `done:${b.id}`, () => deps.endDone?.(agentId));
    // The pill's Undo is this toast's Undo: it closes the toast (so nothing is sent) and reopens the card.
    if (id !== null) deps.noteDone?.(agentId, () => { dismissToast(id); setMarked(null); });
  };
  const press = (m: BriefMove) => {
    if ((m.kind === "merge" || m.kind === "add_reviewers") && m.prKey) { if (workspace?.prs.some(p => p.key === m.prKey)) setSheet({ key: m.prKey, intent: m.kind === "merge" ? "merge" : "reviewers" }); else if (b.workspaceId) deps.openPanel(b.workspaceId); }
    else if (m.kind === "open_pr" && m.url) void openExternalUrl(m.url).catch(() => undefined);
    else if (m.kind === "sign_off_next") { deps.signOff(agentId); deps.openNext(agentId); }
    else if (m.kind === "retry") void run("retry", answerId => act({ agentId, briefId: b.id, move: "retry", answerId }), "Retry didn't start");
    else if (m.kind === "done") markDone();
    else if (m.kind === "copy_error" && b.mono) void copyText(b.mono).catch(() => undefined);
    else if (m.kind === "open_subagent" && m.agentId) deps.openAgent(m.agentId);
  };
  // A merge runs Follow-up's own merge flow, so it needs the tracked workspace; without one it isn't offered.
  const moves = b.moves.filter(m => (m.kind !== "merge" && m.kind !== "add_reviewers") || !!b.workspaceId);

  // F7: "Nothing needed" is one muted line, no buttons. Paseo's own running and idle state says the rest.
  if (b.kind === "done" && b.source === "agent" && !b.flagged) return <View accessibilityRole="summary" accessibilityLabel={nothingNeededLine(b.ask)}
    style={{ marginVertical: 6, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingHorizontal: 4 }}>
    <Icon name="Check" size={13} color={c.foregroundMuted} />
    <RichText linkColor={c.foreground} numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{nothingNeededLine(b.ask)}</RichText>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>
  </View>;

  if (b.slim) {
    // Permission: Paseo's own prompt below is the control (F9). Fallback: the paragraph is right above.
    // The label and age share the top line so the ask always gets the full width; at a narrow panel the move wraps under it.
    return <View accessibilityRole="summary" accessibilityLabel={`${acts ? "Needs you: " : ""}${askText}. ${b.sourceLine}`}
      style={[{ marginVertical: embedded ? 0 : 10, gap: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: border }, bare && BARE]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Icon name={ICON[b.kind]} size={14} color={tone} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: acts ? attention : tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{acts && !bare ? "Needs you" : flaggedAct && !bare ? "Later" : word(b.kind)}</Text>
        <View style={{ flex: 1 }} />
        {/* In Later the age would read as a second clock beside "Later until"; the pane header keeps it. */}
        {!snoozed && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 8 }}>
        <RichText numberOfLines={3} tooltip={askText}
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, color: acts ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: acts ? "600" : "400" }}>{askText}</RichText>
        {!embedded && moves.map(m => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} hint={MOVE_HINT[m.kind]} />)}
      </View>
      {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text>}
    </View>;
  }

  const tight = isTight(b, compact, height);
  const pad = compact ? 14 : 16;
  const multi = selectsFirst(b);
  // One answer path: a decision stored as an open question (the brief points at it) is answered as that question
  // (follow.answer-question), like the panel's, Home's and the pill's; the brief resolves once its questions settle
  // (briefQuestionsEvent). Only a decision with no tracked question goes through the brief's own action.
  type DecisionPick = { decisionId: string; choice: string; words?: string };
  const asQuestions = (list: DecisionPick[]) => !!workspace && list.length > 0 && list.every(x => b.questionIds.includes(x.decisionId) && workspace.questions.some(q => q.id === x.decisionId && !q.answer && !q.closed));
  const answer = async (list: DecisionPick[], answerId: string) => {
    if (!asQuestions(list)) return act({ agentId, briefId: b.id, answerId, ...(list.length === 1 ? list[0] : { choices: list }) });
    for (const x of list) await answerQuestion({ workspaceId: workspace!.id, questionId: x.decisionId, choice: x.choice, ...(x.words ? { words: x.words } : {}), action: "send" });
    void cache.invalidateQueries({ queryKey: liveBriefKey(agentId) }); void cache.invalidateQueries({ queryKey: workspaceKey(workspace!.id) });
  };
  // A tap sends the letter, with the note when one is typed; a sent answer clears the card (clearCard).
  const sendOne = (key: string) => { const [decisionId, choice] = key.split(":"); void run(key, async answerId => { await answer(cardPicks({ [decisionId]: choice }, {}, notesOpen[decisionId] ? notes : {}), answerId); clearCard(b.id); }); };
  const sendable = ready(picks, words);
  const openNotes = Object.fromEntries(Object.entries(notes).filter(([id]) => notesOpen[id]));
  const sendAll = () => void run("answers", async answerId => { await answer(cardPicks(sendable, words, openNotes), answerId); clearCard(b.id); });
  // The keyboard's Send: every pick on a multi-decision card, or a single card's Something else once it has words.
  const otherId = !multi ? askedDecisions(b).find(d => isOther(picks[d.id]))?.id : undefined;
  const keySend = multi ? (sendBar(b, sendable).ready ? () => sendAll() : null) : otherId && words[otherId]?.trim() ? () => sendOther(otherId) : null;
  const sendOther = (decisionId: string) => { const text = words[decisionId]?.trim(); if (text) void run(`${decisionId}:${OTHER}`, async answerId => { await answer([{ decisionId, choice: OTHER, words: text }], answerId); clearCard(b.id); }); };
  return <View accessibilityRole="summary" accessibilityLabel={`${acts ? "Needs you" : flaggedAct ? "Later" : word(b.kind)}: ${askText}`}
    style={[{ marginVertical: embedded ? 0 : 10, borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: c.surface1, overflow: "hidden" }, bare && BARE]}>
    <SubmitScope enabled={!!keySend && !busy} onSubmit={() => keySend?.()} style={{ paddingHorizontal: pad, paddingTop: compact ? 12 : 14, paddingBottom: 14, gap: tight ? 10 : 12 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name={ICON[b.kind]} size={14} color={tone} />
          <Text style={{ color: acts ? attention : tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{acts && !bare ? "Needs you" : flaggedAct && !bare ? "Later" : word(b.kind)}</Text>
          {flaggedAct && !bare && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{word(b.kind)}</Text>}
          {multi && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>· {pickedCount(b, sendable)} of {askedDecisions(b).length} picked</Text>}
          <View style={{ flex: 1 }} />
          {/* In Later the age would read as a second clock beside "Later until"; the pane header keeps it. */}
        {!snoozed && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>}
          {/* Phones: where the card's facts come from sits behind ⓘ instead of a footer under every card. */}
          {compact && <Pressable accessibilityRole="button" accessibilityLabel={why ? "Hide where this comes from" : "Where this comes from"} aria-expanded={why} accessibilityState={{ expanded: why }}
            onPress={() => setWhy(v => !v)} style={{ width: 44, height: 44, marginVertical: -15, marginRight: -14, alignItems: "center", justifyContent: "center" }}>
            <Icon name="Info" size={14} color={why ? c.foreground : c.foregroundMuted} />
          </Pressable>}
        </View>
        {/* The ask role on phones (react-native-web ignores hitSlop, so the ⓘ above is a real 44 box); desktop keeps 19/26. */}
        {/* Bare: a section of the Needs you block, so the same size as its question titles. */}
        <RichText accessibilityRole="header" style={compact || bare ? text(c, compact).ask : { color: c.foreground, fontSize: 19, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2 }}>{askText}</RichText>
      </View>

      <BriefBody b={b} c={c} compact={compact} tight={tight} embedded={embedded} height={height} mode={multi ? "select" : "send"} picks={picks}
        onPick={(decisionId, letter) => { if (!busy) pickStore.set(b.id, decisionId, letter); }} busy={busy} onSend={sendOne}
        words={words} onWords={(decisionId, t) => wordStore.set(b.id, decisionId, t)} onSendOther={sendOther}
        notes={notes} notesOpen={notesOpen} onNote={(decisionId, t) => noteStore.set(b.id, decisionId, t)} onNoteOpen={(decisionId, open) => noteOpenStore.set(b.id, decisionId, open ? "1" : "")} />

      {multi && <SendBar b={b} picks={sendable} noted={notedCount(sendable, openNotes)} busy={busy} error={error} onSend={sendAll} c={c} compact={compact} />}

      {!embedded && moves.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {moves.map((m, i) => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} primary={i === 0 && !multi} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} hint={MOVE_HINT[m.kind]} />)}
      </View>}

      {!!error && !multi && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text>}

      {!!b.also && <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Also, from the agent:</Text>
        <RichText style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{b.also.ask}</RichText>
        {!tight && !!b.also.context && <RichText linkColor={c.foreground} numberOfLines={3} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{b.also.context}</RichText>}
      </View>}
    </SubmitScope>
    {(!compact || why) && <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: pad, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name="Info" size={12} color={c.foregroundMuted} />
      <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{b.sourceLine}</Text>
    </View>}
    {workspace && sheet && <PrSheet workspace={workspace} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
  </View>;
}

const BARE = { marginVertical: 0, borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" } as const;
const MOVE_HINT: Partial<Record<BriefMove["kind"], string>> = { done: "Tells the agent you did this. Undo for 6 seconds." };
const MOVE_ICON: Record<BriefMove["kind"], string> = { merge: "GitMerge", open_pr: "ExternalLink", sign_off_next: "ArrowRight", retry: "RotateCcw", copy_error: "Copy", open_subagent: "SquareArrowOutUpRight", add_reviewers: "UserPlus", done: "Check" };

export function contributeBrief(client: PluginClientContext, deps: BriefDeps) {
  const Component = (props: PluginTimelineItemProps<Brief>) => <BriefCard {...props} deps={deps} />;
  return client.addTimelineRenderer({ kind: BRIEF_KIND, version: BRIEF_VERSION, schema: briefSchema, Component });
}
