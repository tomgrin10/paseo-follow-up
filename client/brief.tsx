import { useState, useSyncExternalStore } from "react";
import { browserKey, BROWSER_POLL_MS } from "./keys";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { openExternalUrl, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { BRIEF_KIND, BRIEF_VERSION, askedDecisions, pickedCount, briefSchema, collapsedLine, extrasFit, hasOriginal, nothingNeededLine, isTight, pastRows, selectsFirst, sendBar, type Brief, type BriefDecision, type BriefMove } from "../shared/brief";
import { age } from "../shared/inbox";
import { briefKey, HEADLINE_WORD } from "../shared/headline";
/** The card's kind word comes from the same table as the pill and the Needs-you row. */
const word = (kind: Brief["kind"]) => HEADLINE_WORD[briefKey(kind)];
import { briefActionRpc, browserStatusRpc } from "../shared/contracts";
import { errorText } from "../shared/errors";
import { OTHER, OTHER_LABEL, isOther } from "../shared/questions";
import type { Workspace } from "../shared/model";
import { SubmitScope, submitHint, text, useNow } from "./kit";
import { RichText } from "./rich-text";
import { PrSheet } from "./pr-sheet";
import { isLight, withAlpha, type Colors } from "./theme";
import { runAction } from "./toasts";

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

function Btn({ label, icon, primary, onPress, c, compact, disabled, shortcut = false }: { label: string; icon?: string; primary?: boolean; onPress: () => void; c: Colors; compact: boolean; disabled?: boolean; shortcut?: boolean }) {
  const fg = primary ? c.accentForeground : c.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), minHeight: compact ? 44 : 32, paddingHorizontal: compact ? 14 : 12, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", opacity: disabled ? 0.5 : 1,
      backgroundColor: primary ? (pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent) : pressed || hovered ? c.surface2 : "transparent",
      borderWidth: primary ? 0 : 1, borderColor: c.border, flexGrow: compact ? 1 : 0 })}>
    {icon ? <Icon name={icon} size={compact ? 16 : 14} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : 13, lineHeight: compact ? 19 : 17, fontWeight: "600" }}>{label}</Text>
    {shortcut && !compact && Platform.OS === "web" && <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: fg, opacity: 0.6, fontSize: 11, lineHeight: 16, fontWeight: "500" }}>{submitHint()}</Text>}
  </Pressable>;
}

/**
 * Picks on a multi-decision card, per brief, shared by every copy of the card on this client (the chat, the panel and
 * Home render the same brief), so a pick made in one shows in the others. In memory only; nothing is sent until Send.
 */
const cardStore = (toggle: boolean) => {
  const values = new Map<string, Record<string, string>>(); const listeners = new Set<() => void>();
  const none: Record<string, string> = {};
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    get: (briefId: string) => values.get(briefId) ?? none,
    /** Picks `letter`; picking the same letter again clears that decision (it can then be skipped). */
    set(briefId: string, decisionId: string, value: string) {
      const next = { ...values.get(briefId) };
      if (toggle && next[decisionId] === value || !value) delete next[decisionId]; else next[decisionId] = value;
      values.set(briefId, next); for (const l of listeners) l();
    },
    clear(briefId: string) { if (values.delete(briefId)) for (const l of listeners) l(); },
  };
};
const pickStore = cardStore(true);
/** Something else's words, per decision, shared the same way so a half-written answer survives a re-render elsewhere. */
const wordStore = cardStore(false);
const useWords = (briefId: string) => useSyncExternalStore(wordStore.subscribe, () => wordStore.get(briefId), () => wordStore.get(briefId));
/** Picks that can be sent: Something else counts only once it has words. */
const ready = (picks: Record<string, string>, words: Record<string, string>) => Object.fromEntries(Object.entries(picks).filter(([id, c]) => !isOther(c) || !!words[id]?.trim()));
const usePicks = (briefId: string) => useSyncExternalStore(pickStore.subscribe, () => pickStore.get(briefId), () => pickStore.get(briefId));

/**
 * One option. `send` answers on tap (a single-decision card); `select` marks it as this decision's pick (a card with
 * several decisions, sent together); `readonly` shows a past card, the chosen option marked and the rest dimmed.
 */
function OptionRow({ option, recommended, sending, disabled, tight, open, onToggle, onPress, c, compact, mode = "send", selected = false, answered = false, other = false }: {
  option: BriefDecision["options"][number]; recommended: boolean; sending: boolean; disabled: boolean; tight: boolean; open: boolean; onToggle: () => void; onPress: () => void; c: Colors; compact: boolean;
  mode?: "send" | "select" | "readonly"; selected?: boolean; answered?: boolean; other?: boolean;
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
  const label = other ? `${option.label}${readonly ? `: ${option.consequence ?? ""}` : ", write your own answer"}` : mode === "select" ? `${option.letter}: ${option.label}${recommended ? " (recommended)" : ""}` : readonly ? `${option.letter}: ${option.label}${selected ? " (your answer)" : ""}` : `Answer ${option.letter}: ${option.label}${recommended ? " (recommended)" : ""}`;
  return <View style={{ flexDirection: "row", alignItems: "stretch", borderRadius: 8, borderWidth: 1, borderColor: border, backgroundColor: marked && !readonly ? withAlpha(c.accent, isLight(c) ? 0.06 : 0.1) : "transparent", opacity: dim ? 0.45 : 1, overflow: "hidden" }}>
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
          {readonly && selected && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Your answer</Text>}
          {sending && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Sending…</Text>}
        </View>
        {showDetail && <RichText linkColor={c.foreground} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{option.consequence}</RichText>}
      </View>
    </Pressable>
    {tight && !!option.consequence && <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${open ? "Hide" : "Show"} what ${option.letter} means`} onPress={onToggle}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), width: 44, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
      <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}><Icon name="ChevronDown" size={16} color={c.foregroundMuted} /></View>
    </Pressable>}
  </View>;
}

/**
 * The card's body: decisions, error text, details, context, facts and links, and the agent's extra ask. Shared by the
 * open card and by a past card's read-only "Show full question", so a past question reads exactly as it was asked.
 */
function BriefBody({ b, c, compact, tight, embedded, height, mode, picks, onPick, busy, onSend, words = {}, onWords, onSendOther }: {
  b: Brief; c: Colors; compact: boolean; tight: boolean; embedded: boolean; height: number;
  mode: "send" | "select" | "readonly"; picks: Record<string, string>; onPick: (decisionId: string, letter: string) => void; busy: string | null; onSend?: (key: string) => void;
  words?: Record<string, string>; onWords?: (decisionId: string, text: string) => void; onSendOther?: (decisionId: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState(false);
  const readonly = mode === "readonly";
  const extra = !!b.context || b.facts.length > 0 || b.links.length > 0;
  const showExtra = readonly || !tight || details || extrasFit(b, height);
  const numbered = b.decisions.length > 1;
  return <>
    {b.decisions.map((d, i) => <View key={d.id} accessibilityRole={mode === "select" ? "radiogroup" : undefined} accessibilityLabel={mode === "select" ? d.question : undefined} style={{ gap: 8 }}>
      {(numbered || d.question.trim() !== b.ask.trim()) && <RichText style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: numbered ? "600" : "400" }}>{`${numbered ? `${i + 1}. ` : ""}${d.question}`}</RichText>}
      {d.options.length > 0 && <View style={{ gap: 6 }}>
        {d.options.map(o => <OptionRow key={o.letter} option={o} recommended={d.recommend === o.letter} mode={mode} selected={readonly ? d.chosen === o.letter : picks[d.id] === o.letter} answered={readonly && !!d.chosen}
          sending={busy === `${d.id}:${o.letter}`} disabled={!!busy} tight={tight && !readonly}
          open={!!open[`${d.id}:${o.letter}`]} onToggle={() => setOpen(v => ({ ...v, [`${d.id}:${o.letter}`]: !v[`${d.id}:${o.letter}`] }))}
          onPress={() => mode === "send" ? onSend?.(`${d.id}:${o.letter}`) : onPick(d.id, o.letter)} c={c} compact={compact} />)}
        {/* Built in after the agent's options on every decision: the developer's own answer. */}
        {(!readonly || isOther(d.chosen)) && <OptionRow other option={{ letter: "", label: OTHER_LABEL, consequence: readonly ? `"${d.words ?? ""}"` : null }} recommended={false} mode={mode}
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
      </View>}
      {readonly && b.state === "answered" && d.options.length > 0 && !d.chosen && numbered && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Skipped</Text>}
      {!readonly && mode === "send" && !tight && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{embedded ? d.options.length ? "" : "Reply below." : d.options.length ? `Or type ${letters(d)} in the composer.` : "Reply in the composer."}</Text>}
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

    {showExtra && !!b.context && <RichText selectable linkColor={c.foreground} numberOfLines={readonly ? undefined : 4} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{b.context}</RichText>}

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
function SendBar({ b, picks, busy, error, onSend, c, compact }: { b: Brief; picks: Record<string, string>; busy: string | null; error: string | null; onSend: () => void; c: Colors; compact: boolean }) {
  const bar = sendBar(b, picks);
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Btn shortcut label={busy === "answers" ? "Sending…" : bar.label} icon="Send" primary={bar.ready && !bar.partial} disabled={!bar.ready || !!busy} onPress={onSend} c={c} compact={compact} />
      {!bar.ready && <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Pick your answers, then send them in one message.</Text>}
    </View>
    {bar.skipped && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{bar.skipped}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>Couldn't send: {error} Your picks are kept; try again.</Text>}
  </View>;
}

/** "Show full question" / "Show original": a past card opens back up, read-only. */
function Reveal({ label, open, onPress, c, compact }: { label: string; open: boolean; onPress: () => void; c: Colors; compact: boolean }) {
  const text = open ? label.replace(/^Show/, "Hide") : label;
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
function Past({ b, c, now, compact, height }: { b: Brief; c: Colors; now: number; compact: boolean; height: number }) {
  const [expanded, setExpanded] = useState(false);
  const answered = b.state === "answered";
  const asked = askedDecisions(b);
  const picked = answered && asked.some(d => d.chosen);
  const icon = b.state === "superseded" ? "History" : "CircleCheck";
  const color = b.state === "superseded" ? c.foregroundMuted : c.statusSuccess;
  const right = answered && b.outcomeAt ? `Answered ${clock(b.outcomeAt)}` : age(b.outcomeAt ?? b.at, now);
  const body = expanded && <View style={{ gap: 10, paddingTop: 4 }}>
    <BriefBody b={b} c={c} compact={compact} tight={false} embedded height={height} mode="readonly" picks={{}} onPick={() => undefined} busy={null} />
  </View>;
  if (!picked) return <View accessibilityLiveRegion="polite" style={{ marginVertical: 10, gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}>
    <View style={{ flexDirection: "row", gap: 10, alignItems: answered ? "flex-start" : "center", minHeight: 24 }}>
      <View style={{ paddingTop: answered ? 2 : 0 }}><Icon name={icon} size={15} color={color} /></View>
      {answered
        ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <RichText linkColor={c.foreground} numberOfLines={expanded ? undefined : 1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{b.ask}</RichText>
            <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{b.outcome}</Text>
          </View>
        : <Text numberOfLines={expanded ? undefined : 1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{collapsedLine(b)}</Text>}
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
    {hasOriginal(b) && <View style={{ paddingLeft: 25 }}><Reveal label={answered ? "Show full question" : "Show original"} open={expanded} onPress={() => setExpanded(v => !v)} c={c} compact={compact} /></View>}
    {body}
  </View>;
  // Answered with picks: the ask, then each decision's question and the picked option, so the answer is never
  // separated from what it answered.
  return <View accessibilityRole="summary" accessibilityLabel={`Answered: ${b.ask}`} style={{ marginVertical: 10, gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}><Icon name="CircleCheck" size={15} color={c.statusSuccess} /></View>
      <RichText style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{b.ask}</RichText>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 20, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
    {!expanded && <View style={{ gap: 6, paddingLeft: 23 }}>
      {pastRows(b).map(r => <View key={r.id} style={{ gap: 1 }}>
        {!!r.question && <RichText linkColor={c.foreground} numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{r.question}</RichText>}
        <RichText style={{ color: r.answer ? c.foreground : c.foregroundMuted, fontSize: 13, lineHeight: 19, fontWeight: r.answer ? "600" : "400" }}>{r.answer ?? "Skipped"}</RichText>
      </View>)}
    </View>}
    <View style={{ paddingLeft: 23 }}><Reveal label="Show full question" open={expanded} onPress={() => setExpanded(v => !v)} c={c} compact={compact} /></View>
    {expanded && <View style={{ paddingLeft: 23 }}>{body}</View>}
  </View>;
}

/** `embedded`: inside Home's detail pane, which has its own reply box and action bar, so the card drops its moves. */
export function BriefCard({ item, theme, layout, agentId, deps, embedded = false }: PluginTimelineItemProps<Brief> & { deps: BriefDeps; embedded?: boolean }) {
  const c = theme.colors; const b = item.data; const compact = layout.compact;
  const now = useNow(60_000);
  const { height } = useWindowDimensions();
  const act = useRpc(briefActionRpc);
  const browserRead = useRpc(browserStatusRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [why, setWhy] = useState(false);
  const picks = usePicks(b.id);
  const words = useWords(b.id);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const workspace = b.workspaceId ? deps.workspace(b.workspaceId) : undefined;
  const browser = useQuery({ queryKey: browserKey, queryFn: () => browserRead({}), refetchInterval: BROWSER_POLL_MS, enabled: !!sheet });
  if (b.state !== "open") return <Past b={b} c={c} now={now} compact={compact} height={height} />;

  const attention = c.statusWarning;
  const acts = b.flagged && ACTS.includes(b.kind);
  const tone = acts || b.kind === "done" || b.kind === "review" || b.kind === "error" ? kindTone(b.kind, c) : c.foregroundMuted;
  const ageText = age(b.at, now);
  const border = acts ? withAlpha(attention, isLight(c) ? 0.5 : 0.45) : c.border;
  // Every send from the card (a pick, Something else, Send answers, the keyboard's Send) goes through runAction: the
  // card keeps the picks and words and says what failed, and the toast offers Retry. Success is the card itself.
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return; setBusy(key); setError(null);
    await runAction({ label: "Brief", toast, run: work, success: () => null, onError: e => setError(errorText(e)), failure: "Your answer wasn't sent" });
    setBusy(null);
  };
  const press = (m: BriefMove) => {
    if ((m.kind === "merge" || m.kind === "add_reviewers") && m.prKey) { if (workspace?.prs.some(p => p.key === m.prKey)) setSheet({ key: m.prKey, intent: m.kind === "merge" ? "merge" : "reviewers" }); else if (b.workspaceId) deps.openPanel(b.workspaceId); }
    else if (m.kind === "open_pr" && m.url) void openExternalUrl(m.url).catch(() => undefined);
    else if (m.kind === "sign_off_next") { deps.signOff(agentId); deps.openNext(agentId); }
    else if (m.kind === "retry") void run("retry", () => act({ agentId, briefId: b.id, move: "retry" }));
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
    return <View accessibilityRole="summary" accessibilityLabel={`${acts ? "Needs you: " : ""}${b.ask}. ${b.sourceLine}`}
      style={{ marginVertical: embedded ? 0 : 10, gap: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Icon name={ICON[b.kind]} size={14} color={tone} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: acts ? attention : tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{acts ? "Needs you" : word(b.kind)}</Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 8 }}>
        <RichText numberOfLines={3} tooltip={b.ask}
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, color: acts ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: acts ? "600" : "400" }}>{b.ask}</RichText>
        {!embedded && moves.map(m => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} />)}
      </View>
      {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text>}
    </View>;
  }

  const tight = isTight(b, compact, height);
  const pad = compact ? 14 : 16;
  const multi = selectsFirst(b);
  const sendOne = (key: string) => { const [decisionId, choice] = key.split(":"); void run(key, () => act({ agentId, briefId: b.id, decisionId, choice })); };
  const sendable = ready(picks, words);
  const sendAll = () => void run("answers", async () => { await act({ agentId, briefId: b.id, choices: Object.entries(sendable).map(([decisionId, choice]) => ({ decisionId, choice, ...(isOther(choice) ? { words: words[decisionId].trim() } : {}) })) }); pickStore.clear(b.id); wordStore.clear(b.id); });
  // The keyboard's Send: every pick on a multi-decision card, or a single card's Something else once it has words.
  const otherId = !multi ? askedDecisions(b).find(d => isOther(picks[d.id]))?.id : undefined;
  const keySend = multi ? (sendBar(b, sendable).ready ? () => sendAll() : null) : otherId && words[otherId]?.trim() ? () => sendOther(otherId) : null;
  const sendOther = (decisionId: string) => { const text = words[decisionId]?.trim(); if (text) void run(`${decisionId}:${OTHER}`, async () => { await act({ agentId, briefId: b.id, decisionId, choice: OTHER, words: text }); pickStore.clear(b.id); wordStore.clear(b.id); }); };
  return <View accessibilityRole="summary" accessibilityLabel={`${acts ? "Needs you" : word(b.kind)}: ${b.ask}`}
    style={{ marginVertical: embedded ? 0 : 10, borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: c.surface1, overflow: "hidden" }}>
    <SubmitScope enabled={!!keySend && !busy} onSubmit={() => keySend?.()} style={{ paddingHorizontal: pad, paddingTop: compact ? 12 : 14, paddingBottom: 14, gap: tight ? 10 : 12 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name={ICON[b.kind]} size={14} color={tone} />
          <Text style={{ color: acts ? attention : tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{acts ? "Needs you" : word(b.kind)}</Text>
          {acts && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{word(b.kind)}</Text>}
          {multi && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>· {pickedCount(b, sendable)} of {askedDecisions(b).length} picked</Text>}
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>
          {/* Phones: where the card's facts come from sits behind ⓘ instead of a footer under every card. */}
          {compact && <Pressable accessibilityRole="button" accessibilityLabel={why ? "Hide where this comes from" : "Where this comes from"} aria-expanded={why} accessibilityState={{ expanded: why }}
            onPress={() => setWhy(v => !v)} style={{ width: 44, height: 44, marginVertical: -15, marginRight: -14, alignItems: "center", justifyContent: "center" }}>
            <Icon name="Info" size={14} color={why ? c.foreground : c.foregroundMuted} />
          </Pressable>}
        </View>
        {/* The ask role on phones (react-native-web ignores hitSlop, so the ⓘ above is a real 44 box); desktop keeps 19/26. */}
        <RichText accessibilityRole="header" style={compact ? text(c, true).ask : { color: c.foreground, fontSize: 19, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2 }}>{b.ask}</RichText>
      </View>

      <BriefBody b={b} c={c} compact={compact} tight={tight} embedded={embedded} height={height} mode={multi ? "select" : "send"} picks={picks}
        onPick={(decisionId, letter) => { if (!busy) pickStore.set(b.id, decisionId, letter); }} busy={busy} onSend={sendOne}
        words={words} onWords={(decisionId, t) => wordStore.set(b.id, decisionId, t)} onSendOther={sendOther} />

      {multi && <SendBar b={b} picks={sendable} busy={busy} error={error} onSend={sendAll} c={c} compact={compact} />}

      {!embedded && moves.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {moves.map((m, i) => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} primary={i === 0 && !multi} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} />)}
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

const MOVE_ICON: Record<BriefMove["kind"], string> = { merge: "GitMerge", open_pr: "ExternalLink", sign_off_next: "ArrowRight", retry: "RotateCcw", copy_error: "Copy", open_subagent: "SquareArrowOutUpRight", add_reviewers: "UserPlus" };

export function contributeBrief(client: PluginClientContext, deps: BriefDeps) {
  const Component = (props: PluginTimelineItemProps<Brief>) => <BriefCard {...props} deps={deps} />;
  return client.addTimelineRenderer({ kind: BRIEF_KIND, version: BRIEF_VERSION, schema: briefSchema, Component });
}
