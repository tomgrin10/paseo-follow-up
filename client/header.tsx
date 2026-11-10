import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Workspace } from "../shared/model";
import { ago, headline, liveLine, stackBar, type LiveIcon } from "../shared/attention";
import { Button, IconButton, Switch, text, type Theme } from "./kit";
import { VersionMark } from "./updates";
import { IconSwap, Spinner } from "./motion";
import { segmentPaint, type Colors } from "./theme";
import { SpecChip } from "./spec";
import { SummaryLine } from "./about";

/** PR status older than this means the poll has stopped working; say so instead of looking current. */
export const STALE_MS = 10 * 60_000;

/** One segment per PR in stack order, coloured by state. The signature of the panel; a segment opens its PR. */
export function StackBar({ workspace, theme, height = 6, onOpen }: { workspace: Pick<Workspace, "prs">; theme: Theme; height?: number; onOpen?: (key: string) => void }) {
  const bar = stackBar(workspace);
  if (!bar.total) return null;
  return <View accessibilityRole="progressbar" accessibilityLabel={`${bar.merged} of ${bar.total} PRs merged`} accessibilityValue={{ min: 0, max: bar.total, now: bar.merged }}
    style={{ flexDirection: "row", gap: 2, height, borderRadius: height / 2, overflow: onOpen ? "visible" : "hidden" }}>
    {bar.segments.map((s, i) => {
      const paint = segmentPaint(theme.colors, s.tone);
      const r = height / 2, first = i === 0, last = i === bar.segments.length - 1;
      const fill = { flex: 1, justifyContent: "center" as const, alignItems: "center" as const, overflow: "hidden" as const, backgroundColor: paint.fill, borderTopLeftRadius: first ? r : 0, borderBottomLeftRadius: first ? r : 0, borderTopRightRadius: last ? r : 0, borderBottomRightRadius: last ? r : 0 };
      // A short centred dash marks the state without filling the slot, so unmerged work never reads as done.
      const mark = Math.max(2, Math.round(height / 3));
      const line = paint.line ? <View style={{ width: "36%", minWidth: 6, height: mark, borderRadius: mark / 2, backgroundColor: paint.line }} /> : null;
      return onOpen
        ? <Pressable key={s.key} accessibilityRole="button" accessibilityLabel={`Open pull request ${s.number}`} hitSlop={{ top: 8, bottom: 8 }} onPress={() => onOpen(s.key)} style={state => [fill, (state as { hovered?: boolean }).hovered ? { opacity: 0.75 } : null]}>{line}</Pressable>
        : <View key={s.key} style={fill}>{line}</View>;
    })}
  </View>;
}

function LiveGlyph({ icon, colors }: { icon: LiveIcon; colors: Colors }) {
  switch (icon) {
    case "spinner": return <Spinner color={colors.accent} size={12} />;
    case "done": return <Icon name="CircleCheck" size={12} color={colors.statusSuccess} />;
    case "paused": return <Icon name="CirclePause" size={12} color={colors.statusWarning} />;
    case "alert": return <Icon name="TriangleAlert" size={12} color={colors.statusWarning} />;
    case "waiting": return <Icon name="Clock" size={12} color={colors.foregroundMuted} />;
    default: return <Icon name="Circle" size={12} color={colors.foregroundMuted} />;
  }
}

export function WorkspaceHeader({ workspace: w, theme, compact, now, onSettings, onRefresh, refreshing, onAuto, autoPending, notice, onOpenPr, resize, hideTitle = false, onHome }: {
  workspace: Workspace; theme: Theme; compact: boolean; now: number; onSettings: () => void; onRefresh: () => void; refreshing: boolean; onAuto: (next: boolean) => void; autoPending: boolean; notice: string | null; onOpenPr?: (key: string) => void;
  /** Expand to the larger view, or collapse back to the panel. Absent where the panel is already as wide as it gets. */
  resize?: { icon: "Maximize2" | "Minimize2"; label: string; onPress: () => void } | null;
  /** The larger view's screen bar already names the workspace. */
  hideTitle?: boolean;
  /** Phones: the panel's Home link joins the header's own bar, one 44px row instead of two. */
  onHome?: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const parts = headline(w, now);
  const live = liveLine(w, now);
  const checked = w.prs.map(p => p.snapshot?.observedAt).filter((v): v is string => !!v).sort().at(-1);
  const stale = !!checked && w.prs.some(p => p.snapshot?.state === "OPEN") && now - Date.parse(checked) > STALE_MS;
  const toneOf = (tone?: string) => tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : tone === "success" ? c.statusSuccess : undefined;
  const pad = compact ? 16 : 12;
  const controls = <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginVertical: compact ? -12 : -4, marginRight: compact ? -10 : -4 }}>
    {!!w.spec?.url && <View style={{ marginRight: 4 }}><SpecChip workspace={w} theme={theme} compact={compact} /></View>}
    <VersionMark theme={theme} touch={compact} openSettings={onSettings} />
    {resize && <IconButton icon={resize.icon} label={resize.label} onPress={resize.onPress} theme={theme} compact={compact} />}
    <IconButton icon="Settings" label="Follow-up settings" onPress={onSettings} theme={theme} compact={compact} />
  </View>;
  const tail = <>
    <View style={{ flexDirection: "row", gap: 6, marginTop: 2 }}>
      <View style={{ paddingTop: 3 }}><IconSwap swapKey={live.icon} size={12}><LiveGlyph icon={live.icon} colors={c} /></IconSwap></View>
      <Text accessibilityLiveRegion="polite" style={[t.meta, { flex: 1, color: live.icon === "spinner" ? c.foreground : c.foregroundMuted }]}>
        {live.text}{live.since ? <Text style={{ color: c.foregroundMuted }}>{` · ${ago(live.since, now)}`}</Text> : null}
      </Text>
    </View>
    {notice && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 3 }}><Icon name="TriangleAlert" size={12} color={c.statusWarning} /></View>
      <Text style={[t.meta, { flex: 1, color: c.statusWarning }]}>{notice}</Text>
    </View>}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2, minHeight: compact ? 44 : 28 }}>
      <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }, stale ? { color: c.statusWarning } : null]}>{checked ? `Checked ${ago(checked, now)}${stale ? " · may be out of date" : ""}` : "Checks GitHub every 15s"}</Text>
      <IconButton icon="RefreshCw" label="Refresh PR status" onPress={onRefresh} theme={theme} compact={compact} disabled={refreshing} spinning={refreshing} />
      <View style={{ flex: 1 }} />
      <Switch theme={theme} compact={compact} label="Auto-send" accessibilityLabel="Auto-send repairs" hint="Send repair batches to the main agent on its own when the agent is idle. Off means each batch waits for your click."
        value={w.enable_auto_sends} disabled={autoPending} onChange={onAuto} />
    </View>
  </>;
  if (compact && onHome) return <View style={{ paddingHorizontal: pad, paddingTop: 4, paddingBottom: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
    {/* One bar: Home on the left, the Spec chip and settings on the right. The host header above names the workspace,
        so the Summary (or the goal, until there is one) is the first line under it. */}
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, marginLeft: -14 }}>
      <Button theme={theme} compact kind="ghost" icon="House" title="Home" accessibilityHint="Opens Follow-up Home with every workspace" onPress={onHome} />
      <View style={{ flex: 1 }} />
      <View style={{ marginVertical: 12 }}>{controls}</View>
    </View>
    <SummaryLine workspace={w} theme={theme} compact />
    <Text accessibilityLiveRegion="polite" style={[t.ask, { color: c.foregroundMuted }]}>
      {parts.map((part, i) => <Text key={part.text} style={toneOf(part.tone) ? { color: toneOf(part.tone) } : { color: c.foreground }}>{i ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{" · "}</Text> : null}{part.text}</Text>)}
    </Text>
    <StackBar workspace={w} theme={theme} onOpen={onOpenPr} />
    {tail}
  </View>;
  return <View style={{ paddingHorizontal: pad, paddingTop: compact ? 14 : 12, paddingBottom: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      {/* On phones the host header right above already shows the workspace name. */}
      {compact || hideTitle ? <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}><SummaryLine workspace={w} theme={theme} compact={compact} lead={hideTitle && !compact} /></View>
        : <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>{w.title}</Text>}
      {controls}
    </View>
    {/* The Summary takes the goal's place; the goal shows until there is one. */}
    {!compact && !hideTitle && <SummaryLine workspace={w} theme={theme} compact={false} />}
    <Text accessibilityLiveRegion="polite" style={[t.meta, { color: c.foregroundMuted, marginTop: 2 }]}>
      {parts.map((part, i) => <Text key={part.text} style={toneOf(part.tone) ? { color: toneOf(part.tone), fontWeight: "600" } : { color: c.foreground }}>{i ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{" · "}</Text> : null}{part.text}</Text>)}
    </Text>
    <StackBar workspace={w} theme={theme} onOpen={onOpenPr} />
    {tail}
  </View>;
}
