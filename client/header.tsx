import type { ReactNode } from "react";
import type { SettingsCategory } from "../shared/settings-nav";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Workspace } from "../shared/model";
import { ago, barMarks, headline, headerLine, stackBar, type LiveIcon } from "../shared/attention";
import { Button, IconButton, Switch, text, type Theme } from "./kit";
import { VersionMark } from "./updates";
import { IconSwap, Spinner } from "./motion";
import { segmentPaint, type Colors } from "./theme";
import { ReferencesLine } from "./linked";
import { WhyItMatters } from "./why-it-matters";
import { SummaryLine } from "./about";

/** PR status older than this means the poll has stopped working; say so instead of looking current. */
export const STALE_MS = 10 * 60_000;

/**
 * One mark per PR in stack order, coloured by state; past STACK_BAR_BUDGET PRs, runs or slices of the stack as wide as
 * their share (`barMarks`, stack-bar-reads-at-any-size). The signature of the panel. A mark opens its loudest PR on
 * desktop only: on a phone the marks are 6-8 pt wide and 2 pt apart, far under the 44 pt touch rule, and the Pull
 * requests card's rows right below open every PR, so the compact header draws it without `onOpen` (one progress bar,
 * no buttons).
 */
export function StackBar({ workspace, theme, height = 6, onOpen }: { workspace: Pick<Workspace, "prs">; theme: Theme; height?: number; onOpen?: (key: string) => void }) {
  const bar = stackBar(workspace);
  if (!bar.total) return null;
  // The label says what the marks show, so a phone's bar (no per-mark buttons) still tells a screen reader what is red (failed checks or a conflict: the header's "to fix").
  const failing = bar.segments.filter(s => s.tone === "danger").length;
  return <View accessibilityRole="progressbar" accessibilityLabel={`${bar.merged} of ${bar.total} PRs merged${failing ? `, ${failing} to fix` : ""}`} accessibilityValue={{ min: 0, max: bar.total, now: bar.merged }}
    style={{ flexDirection: "row", gap: 2, height, borderRadius: height / 2, overflow: onOpen ? "visible" : "hidden" }}>
    {barMarks(bar.segments).map((s, i, marks) => {
      const paint = segmentPaint(theme.colors, s.tone);
      const r = height / 2, first = i === 0, last = i === marks.length - 1;
      const fill = { flex: s.count, minWidth: 6, justifyContent: "center" as const, alignItems: "center" as const, overflow: "hidden" as const, backgroundColor: paint.fill, borderTopLeftRadius: first ? r : 0, borderBottomLeftRadius: first ? r : 0, borderTopRightRadius: last ? r : 0, borderBottomRightRadius: last ? r : 0 };
      // A short centred dash marks the state without filling the slot, so unmerged work never reads as done.
      const mark = Math.max(2, Math.round(height / 3));
      const line = paint.line ? <View style={{ width: "36%", minWidth: 6, height: mark, borderRadius: mark / 2, backgroundColor: paint.line }} /> : null;
      return onOpen
        ? <Pressable key={s.key} accessibilityRole="button" accessibilityLabel={s.count === 1 ? `Open pull request ${s.number}` : `${s.count} pull requests, #${s.from} to #${s.to}: open #${s.number}`} hitSlop={{ top: 8, bottom: 8 }} onPress={() => onOpen(s.key)} style={state => [fill, (state as { hovered?: boolean }).hovered ? { opacity: 0.75 } : null]}>{line}</Pressable>
        : <View key={s.key} style={fill}>{line}</View>;
    })}
  </View>;
}

function LiveGlyph({ icon, colors }: { icon: LiveIcon; colors: Colors }) {
  switch (icon) {
    case "spinner": return <Spinner color={colors.accent} size={12} />;
    case "sent": return <Icon name="Send" size={12} color={colors.accent} />;
    case "done": return <Icon name="CircleCheck" size={12} color={colors.statusSuccess} />;
    case "paused": return <Icon name="CirclePause" size={12} color={colors.statusWarning} />;
    case "alert": return <Icon name="TriangleAlert" size={12} color={colors.statusWarning} />;
    case "failing": return <Icon name="CircleX" size={12} color={colors.statusDanger} />;
    case "waiting": return <Icon name="Clock" size={12} color={colors.foregroundMuted} />;
    default: return <Icon name="Circle" size={12} color={colors.foregroundMuted} />;
  }
}

export function WorkspaceHeader({ workspace: w, theme, compact, now, onSettings, onRefresh, refreshing, onAuto, autoPending, notice, onOpenPr, resize, hideTitle = false, onHome, more, openAgent, agentLines = false, dense = false, titleLead, titleTail, actions, forceTitle = false, moves }: {
  workspace: Workspace; theme: Theme; compact: boolean; now: number; onSettings: (category?: SettingsCategory) => void; onRefresh: () => void; refreshing: boolean; onAuto: (next: boolean) => void; autoPending: boolean; notice: string | null; onOpenPr?: (key: string) => void;
  /** The place's icon action: the side panel's "Open in a tab", the tab's "Open chat". */
  resize?: { icon: "Maximize2" | "Minimize2" | "MessageSquare"; label: string; onPress: () => void } | null;
  /** The larger view's screen bar already names the workspace. */
  hideTitle?: boolean;
  /** Phones: the panel's Home link joins the header's own bar, one 44px row instead of two. */
  onHome?: () => void;
  /** The More button (client/panel-menu.tsx), before the gear. */
  more?: ReactNode;
  /** Why it matters' Ask the Overseer opens the Overseer's chat with the draft in it. */
  openAgent?: (agentId: string) => void;
  /** Each agent's line is drawn below (client/now-lines.tsx), so "Main agent is working (on 1 repair)" isn't said twice. */
  agentLines?: boolean;
  /** The dense tier (shared/workspace-layout.ts): under 560 px of content. */
  dense?: boolean;
  /** Home's title line: before the title (Back, the row's glyph), after it (" › agent"), and its Open. */
  titleLead?: ReactNode; titleTail?: ReactNode; actions?: ReactNode;
  /** Home: the title shows on a phone too (its host header says Follow-up, not the workspace). */
  forceTitle?: boolean;
  /** Home's moves on this item (Sign off, Sign off & next, Later), last in the head. */
  moves?: ReactNode;
}) {
  const c = theme.colors; const t = text(c, compact);
  const parts = headline(w, now);
  const live = headerLine(w, now);
  const checked = w.prs.map(p => p.snapshot?.observedAt).filter((v): v is string => !!v).sort().at(-1);
  const stale = !!checked && w.prs.some(p => p.snapshot?.state === "OPEN") && now - Date.parse(checked) > STALE_MS;
  const toneOf = (tone?: string) => tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : tone === "success" ? c.statusSuccess : undefined;
  const pad = compact ? 16 : 12;
  const controls = <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginVertical: compact ? -12 : -4, marginRight: compact ? -10 : -4 }}>
    {actions}
    {resize && <IconButton icon={resize.icon} label={resize.label} onPress={resize.onPress} theme={theme} compact={compact} />}
    {more}
    <IconButton icon="Settings" label="Follow-up settings" onPress={() => onSettings()} theme={theme} compact={compact} />
  </View>;
  const tail = <>
    {!(agentLines && (live.icon === "spinner" || live.icon === "sent")) && <View style={{ flexDirection: "row", gap: 6, marginTop: 2 }}>
      <View style={{ paddingTop: 3 }}><IconSwap swapKey={live.icon} size={12}><LiveGlyph icon={live.icon} colors={c} /></IconSwap></View>
      <Text accessibilityLiveRegion="polite" style={[t.meta, { flex: 1, color: live.icon === "spinner" || live.icon === "sent" ? c.foreground : c.foregroundMuted }]}>
        {live.text}{live.since ? <Text style={{ color: c.foregroundMuted }}>{` · ${ago(live.since, now)}`}</Text> : null}
      </Text>
    </View>}
    {notice && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 3 }}><Icon name="TriangleAlert" size={12} color={c.statusWarning} /></View>
      <Text style={[t.meta, { flex: 1, color: c.statusWarning }]}>{notice}</Text>
    </View>}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2, minHeight: compact ? 44 : 28 }}>
      <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }, stale && !w.githubOff ? { color: c.statusWarning } : null]}>{w.githubOff ? "Not checking GitHub" : checked ? `Checked ${ago(checked, now)}${stale ? " · may be out of date" : ""}` : "Checks GitHub every 15s"}</Text>
      <IconButton icon="RefreshCw" label={w.githubOff ? "Check GitHub again" : "Refresh PR status"} onPress={onRefresh} theme={theme} compact={compact} disabled={refreshing} spinning={refreshing} />
      <View style={{ flex: 1 }} />
      <Switch theme={theme} compact={compact} label={dense ? "Auto" : "Auto-send"} accessibilityLabel="Auto-send repairs" hint="Send repairs to the main agent on its own when the agent is idle. Off means each message waits for your click."
        value={w.enable_auto_sends} disabled={autoPending} onChange={onAuto} />
    </View>
    {moves}
  </>;
  if (compact && onHome) return <View style={{ paddingHorizontal: pad, paddingTop: 4, paddingBottom: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
    {/* One bar: Home on the left, settings on the right. The host header above names the workspace,
        so the Summary (or the goal, until there is one) is the first line under it. */}
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, marginLeft: -14 }}>
      <Button theme={theme} compact kind="ghost" icon="House" title="Home" accessibilityHint="Opens Follow-up Home with every workspace" onPress={onHome} />
      {/* The version sits with Home, as on Home's own title line, not beside the cog. */}
      <View style={{ marginLeft: 8 }}><VersionMark theme={theme} touch openSettings={onSettings} /></View>
      <View style={{ flex: 1 }} />
      <View style={{ marginVertical: 12 }}>{controls}</View>
    </View>
    <SummaryLine workspace={w} theme={theme} compact />
    {/* Spec and Linked: their own line, as on desktop and Home. The 44px bar can't hold them beside Home, the version
        and settings at 390pt without pushing settings off-screen. */}
    <ReferencesLine workspace={w} theme={theme} compact />
    <WhyItMatters workspace={w} theme={theme} compact openAgent={openAgent} />
    <Text accessibilityLiveRegion="polite" style={[t.ask, { color: c.foregroundMuted }]}>
      {parts.map((part, i) => <Text key={part.text} style={toneOf(part.tone) ? { color: toneOf(part.tone) } : { color: c.foreground }}>{i ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{" · "}</Text> : null}{part.text}</Text>)}
    </Text>
    <StackBar workspace={w} theme={theme} onOpen={compact ? undefined : onOpenPr} />
    {tail}
  </View>;
  return <View style={{ paddingHorizontal: pad, paddingTop: compact ? 14 : 12, paddingBottom: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      {/* On phones the host header right above already shows the workspace name. */}
      {titleLead}
      {(compact && !forceTitle) || hideTitle ? <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}><SummaryLine workspace={w} theme={theme} compact={compact} lead={hideTitle && !compact} /></View>
        : <Text accessibilityRole="header" numberOfLines={3} style={[t.title, { flex: 1 }]}>{w.title}{titleTail}</Text>}
      {controls}
    </View>
    {/* The Summary takes the goal's place; the goal shows until there is one. */}
    {(!compact || forceTitle) && !hideTitle && <SummaryLine workspace={w} theme={theme} compact={compact} />}
    {/* The references line: Spec and Linked, one line, only when there's a spec or anything linked. */}
    <ReferencesLine workspace={w} theme={theme} compact={compact} />
    <WhyItMatters workspace={w} theme={theme} compact={compact} openAgent={openAgent} />
    <Text accessibilityLiveRegion="polite" style={[t.meta, { color: c.foregroundMuted, marginTop: 2 }]}>
      {parts.map((part, i) => <Text key={part.text} style={toneOf(part.tone) ? { color: toneOf(part.tone), fontWeight: "600" } : { color: c.foreground }}>{i ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{" · "}</Text> : null}{part.text}</Text>)}
    </Text>
    <StackBar workspace={w} theme={theme} onOpen={compact ? undefined : onOpenPr} />
    {tail}
  </View>;
}
