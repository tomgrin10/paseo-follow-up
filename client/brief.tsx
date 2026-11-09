import { useState } from "react";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { openExternalUrl, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, copyText } from "@getpaseo/plugin/client/ui";
import { BRIEF_KIND, BRIEF_VERSION, briefSchema, collapsedLine, extrasFit, nothingNeededLine, isTight, type Brief, type BriefDecision, type BriefMove } from "../shared/brief";
import { age } from "../shared/inbox";
import { briefKey, HEADLINE_WORD } from "../shared/headline";
/** The card's kind word comes from the same table as the pill and the Needs-you row. */
const word = (kind: Brief["kind"]) => HEADLINE_WORD[briefKey(kind)];
import { briefActionRpc, browserStatusRpc } from "../shared/contracts";
import { errorText } from "../shared/errors";
import type { Workspace } from "../shared/model";
import { useNow } from "./kit";
import { PrSheet } from "./pr-sheet";
import { isLight, withAlpha, type Colors } from "./theme";

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
const clock = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : ""; };
/** Web keyboard focus: a visible ring, since sending an answer is one-shot. */
const ring = (focused: boolean | undefined, c: Colors) => focused && Platform.OS === "web" ? ({ outlineWidth: 2, outlineStyle: "solid", outlineColor: withAlpha(c.accent, 0.6), outlineOffset: 2 } as object) : {};
const letters = (d: BriefDecision) => { const l = d.options.map(o => o.letter); return l.length > 1 ? `${l.slice(0, -1).join(", ")} or ${l.at(-1)}` : l[0] ?? ""; };

function Btn({ label, icon, primary, onPress, c, compact, disabled }: { label: string; icon?: string; primary?: boolean; onPress: () => void; c: Colors; compact: boolean; disabled?: boolean }) {
  const fg = primary ? c.accentForeground : c.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), minHeight: compact ? 44 : 32, paddingHorizontal: compact ? 14 : 12, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", opacity: disabled ? 0.5 : 1,
      backgroundColor: primary ? (pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent) : pressed || hovered ? c.surface2 : "transparent",
      borderWidth: primary ? 0 : 1, borderColor: c.border, flexGrow: compact ? 1 : 0 })}>
    {icon ? <Icon name={icon} size={compact ? 16 : 14} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : 13, lineHeight: compact ? 19 : 17, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}

function OptionRow({ option, recommended, sending, disabled, tight, open, onToggle, onPress, c, compact }: {
  option: BriefDecision["options"][number]; recommended: boolean; sending: boolean; disabled: boolean; tight: boolean; open: boolean; onToggle: () => void; onPress: () => void; c: Colors; compact: boolean;
}) {
  const strong = withAlpha(c.foreground, isLight(c) ? 0.38 : 0.42);
  const showDetail = !!option.consequence && (!tight || open);
  return <View style={{ flexDirection: "row", alignItems: "stretch", borderRadius: 8, borderWidth: 1, borderColor: recommended ? strong : c.border, opacity: disabled && !sending ? 0.5 : 1, overflow: "hidden" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Answer ${option.letter}: ${option.label}${recommended ? " (recommended)" : ""}`} accessibilityHint={option.consequence ?? undefined} accessibilityState={{ disabled, busy: sending }} disabled={disabled} onPress={onPress}
      style={({ hovered, pressed, focused }: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: compact ? 11 : 9, paddingHorizontal: 10, minHeight: compact ? 44 : 0,
        backgroundColor: pressed ? c.surface2 : hovered && !disabled ? withAlpha(c.foreground, 0.05) : "transparent" })}>
      <View style={{ width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: recommended ? c.foreground : c.surface2 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: recommended ? c.surface1 : c.foreground }}>{option.letter}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{option.label}</Text>
          {recommended && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Recommended</Text>}
          {sending && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Sending…</Text>}
        </View>
        {showDetail && <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{option.consequence}</Text>}
      </View>
    </Pressable>
    {tight && !!option.consequence && <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${open ? "Hide" : "Show"} what ${option.letter} means`} onPress={onToggle}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => ({ ...ring(focused, c), width: 44, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: pressed ? c.surface2 : "transparent" })}>
      <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}><Icon name="ChevronDown" size={16} color={c.foregroundMuted} /></View>
    </Pressable>}
  </View>;
}

function Collapsed({ b, c, now }: { b: Brief; c: Colors; now: number }) {
  // F8: history keeps what was asked and what happened, as one muted line (two when an answer was picked).
  const answered = b.state === "answered";
  const icon = b.state === "superseded" ? "History" : "CircleCheck";
  const color = b.state === "superseded" ? c.foregroundMuted : c.statusSuccess;
  const right = answered && b.outcomeAt ? `sent ${clock(b.outcomeAt)}` : age(b.outcomeAt ?? b.at, now);
  return <View accessibilityLiveRegion="polite" style={{ marginVertical: 10, flexDirection: "row", gap: 10, alignItems: answered ? "flex-start" : "center", minHeight: 40, paddingVertical: answered ? 10 : 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }}>
    <View style={{ paddingTop: answered ? 2 : 0 }}><Icon name={icon} size={15} color={color} /></View>
    {answered
      ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{b.ask}</Text>
          <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{b.outcome}</Text>
        </View>
      : <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{collapsedLine(b)}</Text>}
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{right}</Text>
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
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState(false);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
  const workspace = b.workspaceId ? deps.workspace(b.workspaceId) : undefined;
  const browser = useQuery({ queryKey: ["follow-through", "browser"], queryFn: () => browserRead({}), refetchInterval: 5000, enabled: !!sheet });
  if (b.state !== "open") return <Collapsed b={b} c={c} now={now} />;

  const attention = c.statusWarning;
  const acts = b.flagged && ACTS.includes(b.kind);
  const tone = acts || b.kind === "done" || b.kind === "review" || b.kind === "error" ? kindTone(b.kind, c) : c.foregroundMuted;
  const ageText = age(b.at, now);
  const border = acts ? withAlpha(attention, isLight(c) ? 0.5 : 0.45) : c.border;
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return; setBusy(key); setError(null);
    try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
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
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{nothingNeededLine(b.ask)}</Text>
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
        <Text numberOfLines={3} {...(Platform.OS === "web" ? { title: b.ask } as object : {})}
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, color: acts ? c.foreground : c.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: acts ? "600" : "400" }}>{b.ask}</Text>
        {!embedded && moves.map(m => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} />)}
      </View>
      {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text>}
    </View>;
  }

  const tight = isTight(b, compact, height);
  const extra = !!b.context || b.facts.length > 0 || b.links.length > 0;
  const showExtra = !tight || details || extrasFit(b, height);
  const pad = compact ? 14 : 16;
  return <View accessibilityRole="summary" accessibilityLabel={`${acts ? "Needs you" : word(b.kind)}: ${b.ask}`}
    style={{ marginVertical: embedded ? 0 : 10, borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: c.surface1, overflow: "hidden" }}>
    <View style={{ paddingHorizontal: pad, paddingTop: compact ? 12 : 14, paddingBottom: 14, gap: tight ? 10 : 12 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name={ICON[b.kind]} size={14} color={tone} />
          <Text style={{ color: acts ? attention : tone, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{acts ? "Needs you" : word(b.kind)}</Text>
          {acts && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{word(b.kind)}</Text>}
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{ageText}</Text>
        </View>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: compact ? 17 : 19, lineHeight: compact ? 23 : 26, fontWeight: "600", letterSpacing: -0.2 }}>{b.ask}</Text>
      </View>

      {b.decisions.map((d, i) => <View key={d.id} style={{ gap: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{b.decisions.length > 1 ? `${i + 1}. ` : ""}{d.question}</Text>
        {d.options.length > 0 && <View style={{ gap: 6 }}>
          {d.options.map(o => <OptionRow key={o.letter} option={o} recommended={d.recommend === o.letter} sending={busy === `${d.id}:${o.letter}`} disabled={!!busy} tight={tight}
            open={!!open[`${d.id}:${o.letter}`]} onToggle={() => setOpen(v => ({ ...v, [`${d.id}:${o.letter}`]: !v[`${d.id}:${o.letter}`] }))}
            onPress={() => void run(`${d.id}:${o.letter}`, () => act({ agentId, briefId: b.id, decisionId: d.id, choice: o.letter }))} c={c} compact={compact} />)}
        </View>}
        {!tight && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{embedded ? d.options.length ? "Or answer in your own words below." : "Reply below." : d.options.length ? `Or type ${letters(d)} in the composer, or reply in your own words.` : "Reply in the composer."}</Text>}
        {tight && !d.options.length && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{embedded ? "Reply below." : "Reply in the composer."}</Text>}
      </View>)}

      {!!b.mono && !b.ask.endsWith(b.mono) && <View style={{ borderRadius: 8, backgroundColor: withAlpha(c.statusDanger, isLight(c) ? 0.07 : 0.1), paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text selectable numberOfLines={tight ? 3 : undefined} style={{ color: c.foreground, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{b.mono}</Text>
      </View>}

      {extra && tight && !extrasFit(b, height) && <Pressable accessibilityRole="button" aria-expanded={details} accessibilityLabel={details ? "Hide details" : "Show details"} onPress={() => setDetails(v => !v)} hitSlop={6}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 }}>
        <View style={{ transform: [{ rotate: details ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
        <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>Details</Text>
      </Pressable>}

      {showExtra && !!b.context && <Text selectable numberOfLines={4} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{b.context}</Text>}

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

      {!embedded && moves.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {moves.map((m, i) => <Btn key={m.kind} label={busy === m.kind ? `${m.label}…` : m.label} icon={MOVE_ICON[m.kind]} primary={i === 0} disabled={!!busy} onPress={() => press(m)} c={c} compact={compact} />)}
      </View>}

      {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text>}

      {!!b.also && <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Also, from the agent:</Text>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{b.also.ask}</Text>
        {showExtra && !!b.also.context && <Text numberOfLines={3} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{b.also.context}</Text>}
      </View>}
    </View>
    <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: pad, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name="Info" size={12} color={c.foregroundMuted} />
      <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{b.sourceLine}</Text>
    </View>
    {workspace && sheet && <PrSheet workspace={workspace} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={compact} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
  </View>;
}

const MOVE_ICON: Record<BriefMove["kind"], string> = { merge: "GitMerge", open_pr: "ExternalLink", sign_off_next: "ArrowRight", retry: "RotateCcw", copy_error: "Copy", open_subagent: "SquareArrowOutUpRight", add_reviewers: "UserPlus" };

export function contributeBrief(client: PluginClientContext, deps: BriefDeps) {
  const Component = (props: PluginTimelineItemProps<Brief>) => <BriefCard {...props} deps={deps} />;
  return client.addTimelineRenderer({ kind: BRIEF_KIND, version: BRIEF_VERSION, schema: briefSchema, Component });
}
