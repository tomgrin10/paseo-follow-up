import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { age, displayReason, nextAfter, REASON_LABEL, REASON_WORD, rowTitle, sectionRows, snoozeUntil, wakeLabel, type InboxRow, type Reason } from "../shared/inbox";
import { Button, IconButton, useNow, type Theme } from "./kit";
import { Spinner } from "./motion";
import { mergedColor, raised, runningColor, type Colors } from "./theme";
import type { InboxStore } from "./inbox-store";

export const INBOX_SCREEN = "follow-through";
const RULE = "Agents stay here until you sign them off or reply. Opening one doesn't clear it.";

export function useInbox<T>(store: InboxStore, select: () => T): T {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  return select();
}

export function reasonGlyph(reason: Reason, c: Colors): { name: string; color: string } {
  switch (reason) {
    case "permission": return { name: "CircleHelp", color: c.statusWarning };
    case "error": return { name: "CircleX", color: c.statusDanger };
    case "paused": return { name: "CirclePause", color: c.statusWarning };
    case "ci": return { name: "GitPullRequestClosed", color: c.statusDanger };
    case "review": return { name: "MessageSquare", color: c.statusWarning };
    case "finished": return { name: "CircleCheck", color: c.statusSuccess };
    case "pr_closed": return { name: "GitMerge", color: mergedColor(c) };
  }
}
const running = (row: InboxRow) => ["running", "initializing"].includes(row.status);
const label = (row: InboxRow) => { const t = rowTitle(row); return t.agent ? `${t.primary} › ${t.agent}` : t.primary; };

/** The status glyph. A flagged agent that is also running gets a small spinner on the glyph, not a second dot. */
function Glyph({ row, theme, size }: { row: InboxRow; theme: Theme; size: number }) {
  const c = theme.colors;
  const shown = displayReason(row.needs);
  const g = shown ? reasonGlyph(shown.reason, c) : row.resumesAt ? { name: "CirclePause", color: c.foregroundMuted } : row.snooze ? { name: "AlarmClock", color: c.foregroundMuted } : row.signedOffAt && !running(row) ? { name: "Check", color: c.statusSuccess } : null;
  return <View style={{ width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" }}>
    {g ? <Icon name={g.name} size={size} color={g.color} /> : <View accessibilityLabel="Running" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: runningColor(c) }} />}
    {g && running(row) && !row.snooze && <View accessibilityLabel="Running" style={{ position: "absolute", right: -3, bottom: -3, width: 11, height: 11, borderRadius: 6, backgroundColor: c.surface0, alignItems: "center", justifyContent: "center" }}>
      <Spinner color={runningColor(c)} size={8} label="Running" />
    </View>}
  </View>;
}

type RowProps = {
  row: InboxRow; theme: Theme; now: number; dense: boolean; touch: boolean; active?: boolean;
  onOpen?: () => void; onSignOff?: () => void; onMore?: () => void; moreOpen?: boolean;
  selecting?: boolean; checked?: boolean; onCheck?: () => void; trailing?: string; onUndo?: () => void;
};

/**
 * One agent: line 1 is the title and age, line 2 the reason and its detail. In a narrow row the
 * "› Agent" part of the title moves to the start of line 2, so a long workspace title never hides both names.
 */
export function InboxRowView({ row, theme, now, dense, touch, active, onOpen, onSignOff, onMore, moreOpen, selecting, checked, onCheck, trailing, onUndo }: RowProps) {
  const c = theme.colors;
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(false);
  const title = rowTitle(row);
  const shown = displayReason(row.needs);
  const primary = dense ? 12 : 13; const secondary = dense ? 11 : 12;
  // Change 2: when "Title › Agent" won't fit, the agent name moves to the reason line so neither name is hidden.
  // Estimated from the text length (≈0.56em per glyph) against the room left after the glyph, age and buttons.
  const room = width - (dense ? 34 : 40) - (touch ? 132 : 88);
  const narrow = width > 0 && !!title.agent && (title.primary.length + title.agent.length + 3) * primary * 0.56 > room;
  const more = (row.needs?.reasons.length ?? 0) - 1;
  const days = row.needs ? now - Date.parse(row.needs.since) > 86_400_000 : false;
  const right = trailing ?? (row.needs ? age(row.needs.since, now) : row.signedOffAt ? age(row.signedOffAt, now) : row.resumesAt ? `resumes ${wakeLabel({ until: row.resumesAt, at: "" }, now)}` : running(row) ? age(row.lastActivityAt, now) : "");
  const reasonColor = shown ? reasonGlyph(shown.reason, c).color : c.foregroundMuted;
  const second: ReactNode[] = [];
  if (title.agent && narrow) second.push(<Text key="a" style={{ color: c.foreground }}>{title.agent} · </Text>);
  if (shown) second.push(<Text key="r" style={{ color: reasonColor, fontWeight: "600" }}>{REASON_LABEL[shown.reason]}</Text>);
  else if (row.signedOffAt && !running(row)) second.push(<Text key="s" style={{ color: c.statusSuccess }}>Signed off</Text>);
  else if (row.resumesAt) second.push(<Text key="p">Paused at the limit</Text>);
  else if (running(row)) second.push(<Text key="w">Working</Text>);
  if (shown?.detail) second.push(<Text key="d">{` · ${shown.detail}`}</Text>);
  if (more > 0) second.push(<Text key="m">{` · +${more}`}</Text>);
  if (!row.enable_finish_flags && !shown) second.push(<Text key="f">{second.length ? " · " : ""}Finishes not flagged</Text>);
  if (row.delegatedFrom && !shown) second.push(<Text key="g">{second.length ? " · " : ""}Delegated</Text>);
  const quiet = !row.needs || !!row.snooze;
  const showCheck = !!onSignOff && !selecting && (touch || hover || !dense);
  const a11y = [label(row), shown ? `${REASON_LABEL[shown.reason]}${shown.detail ? `: ${shown.detail}` : ""}` : "", right ? `waiting ${right}` : ""].filter(Boolean).join(". ");
  return <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as object)}
    style={{ flexDirection: "row", alignItems: "center", minHeight: touch ? 56 : dense ? 40 : 48, paddingLeft: dense ? 8 : 12, paddingRight: dense ? 4 : 8, borderRadius: dense ? 6 : 0, backgroundColor: active || moreOpen ? c.surface2 : hover && onOpen ? c.surface1 : "transparent" }}>
    {selecting && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} aria-checked={checked} accessibilityLabel={`Select ${label(row)}`} onPress={onCheck} hitSlop={6}
      style={{ width: touch ? 44 : 24, height: touch ? 44 : 28, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 1.5, borderColor: checked ? c.accent : c.foregroundMuted, backgroundColor: checked ? c.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {checked && <Icon name="Check" size={10} color={c.accentForeground} />}
      </View>
    </Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityHint={onOpen ? "Opens the agent" : undefined} disabled={!onOpen && !selecting} onPress={selecting ? onCheck : onOpen}
      style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: dense ? 8 : 10, paddingVertical: dense ? 4 : 7 }}>
      <Glyph row={row} theme={theme} size={dense ? 14 : 16} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: quiet ? c.foregroundMuted : c.foreground, fontSize: primary, lineHeight: primary + 4, fontWeight: quiet ? "400" : "500" }}>
            {title.primary}{title.agent && !narrow ? <Text style={{ color: c.foregroundMuted }}>{` › ${title.agent}`}</Text> : null}
          </Text>
        </View>
        {second.length > 0 && <Text numberOfLines={shown?.reason === "permission" ? 2 : 1} style={{ color: c.foregroundMuted, fontSize: secondary, lineHeight: secondary + 4 }}>{second}</Text>}
      </View>
    </Pressable>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: 6 }}>
      {!!right && !(showCheck && dense && !touch) && <Text numberOfLines={1} style={{ color: days ? c.statusWarning : c.foregroundMuted, fontSize: secondary, fontVariant: ["tabular-nums"], marginRight: onSignOff || onMore ? 2 : 4 }}>{right}</Text>}
      {onUndo && <Button theme={theme} compact={touch} kind="ghost" icon="Undo2" title="Undo" accessibilityLabel={`Undo sign-off for ${label(row)}`} onPress={onUndo} />}
      {onMore && !selecting && <IconButton theme={theme} compact={touch} icon="Ellipsis" label={`More for ${label(row)}`} onPress={onMore} />}
      {showCheck && <SignOffButton theme={theme} touch={touch} label={`Sign off ${label(row)}`} onPress={onSignOff!} />}
    </View>
  </View>;
}

function SignOffButton({ theme, touch, label: name, onPress }: { theme: Theme; touch: boolean; label: string; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} hitSlop={touch ? 6 : 4}
    style={state => ({ width: touch ? 44 : 28, height: touch ? 44 : 28, alignItems: "center", justifyContent: "center" })}>
    {state => <View style={{ width: touch ? 32 : 24, height: touch ? 32 : 24, borderRadius: 6, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center", backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface2 : c.surface1 }}>
      <Icon name="Check" size={touch ? 16 : 14} color={c.foreground} />
    </View>}
  </Pressable>;
}

/** The ⋯ actions for one row, inline under it: Later…, mute this turn, and the per-agent finish switch. */
function RowMenu({ row, store, theme, touch, close }: { row: InboxRow; store: InboxStore; theme: Theme; touch: boolean; close: () => void }) {
  const c = theme.colors;
  const later = (choice: "hour" | "tonight" | "tomorrow" | "next-event") => { void store.snooze([row.agentId], snoozeUntil(choice, new Date())); close(); };
  return <View style={{ marginLeft: touch ? 12 : 34, marginRight: 8, marginBottom: 6, paddingVertical: 8, paddingHorizontal: 10, gap: 8, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
    {row.needs && !row.snooze && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, marginRight: 2 }}>Later</Text>
      <Button theme={theme} compact={touch} title="1 hour" onPress={() => later("hour")} />
      <Button theme={theme} compact={touch} title="Tonight" onPress={() => later("tonight")} />
      <Button theme={theme} compact={touch} title="Tomorrow 09:00" onPress={() => later("tomorrow")} />
      <Button theme={theme} compact={touch} title="Next event" onPress={() => later("next-event")} />
    </View>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {running(row) && <Button theme={theme} compact={touch} icon="BellOff" title="Sign off · mute this turn" onPress={() => { void store.signOff([row.agentId], { muteTurn: true }); close(); }} />}
      <Button theme={theme} compact={touch} icon={row.enable_finish_flags ? "BellMinus" : "Bell"} title={row.enable_finish_flags ? "Don't flag finishes" : "Flag finishes again"}
        accessibilityHint="Permission prompts and errors still flag this agent" onPress={() => { void store.setFinishFlags(row.agentId, !row.enable_finish_flags); close(); }} />
    </View>
  </View>;
}

/** The undo bar: in-surface, so it can carry an Undo action that host toasts can't. Lasts 6 s. */
export function UndoBar({ store, theme, touch }: { store: InboxStore; theme: Theme; touch: boolean }) {
  const c = theme.colors;
  const recent = useInbox(store, () => store.recent());
  useEffect(() => {
    if (!recent) return;
    const id = setTimeout(() => store.clearRecent(), Math.max(0, 6_000 - (Date.now() - recent.at)));
    return () => clearTimeout(id);
  }, [recent, store]);
  if (!recent) return null;
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 52 : 40, paddingLeft: 12, paddingRight: 4, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, ...raised(c) }}>
    <Icon name="CircleCheck" size={15} color={c.statusSuccess} />
    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12 }}>Signed off <Text style={{ color: c.foregroundMuted }}>{recent.label}</Text></Text>
    <Button theme={theme} compact={touch} kind="ghost" icon="Undo2" title="Undo" onPress={() => void store.undo()} />
  </View>;
}

function SectionHeader({ theme, title, count, open, onToggle, tone, right, dense }: { theme: Theme; title: string; count: number; open: boolean; onToggle: () => void; tone?: string; right?: ReactNode; dense: boolean }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", minHeight: dense ? 28 : 32, paddingLeft: dense ? 4 : 0 }}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}. ${open ? "Collapse" : "Expand"}`} onPress={onToggle}
      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: dense ? 28 : 32 }}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
      <Text accessibilityRole="header" style={{ color: tone ?? c.foreground, fontSize: dense ? 12 : 13, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: tone ?? c.foregroundMuted, fontSize: dense ? 11 : 12, fontVariant: ["tabular-nums"] }}>{count}</Text>
    </Pressable>
    {right}
  </View>;
}

export type InboxNav = { openAgent?: (row: InboxRow) => void; activeAgentId?: string | null };

/**
 * The inbox itself: Needs you, Later, Running and Signed off today, with multi-select, first run and
 * empty states. Rendered at the top of Follow-up's screen today, and as the sidebar view on hosts that have one.
 */
export function InboxSections({ store, theme, touch, dense, nav, runningCap = 8 }: { store: InboxStore; theme: Theme; touch: boolean; dense: boolean; nav: InboxNav; runningCap?: number }) {
  const c = theme.colors;
  const now = useNow(30_000);
  useInbox(store, () => store.version());
  const data = store.data();
  const rows = store.rows();
  const [open, setOpen] = useState({ needs: true, later: true, running: true, signed: false, unsorted: false });
  const [menu, setMenu] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [showAllRunning, setShowAllRunning] = useState(false);
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));
  if (!store.enabled()) return null;
  const needs = sectionRows(rows, "needs", now);
  const later = sectionRows(rows, "later", now);
  const live = sectionRows(rows, "running", now);
  const signed = sectionRows(rows, "signed", now);
  const unsorted = data?.unsorted ?? null;
  const offline = store.offlineSince();
  const cameBack = store.cameBack();
  const pick = (id: string) => setChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const exitSelect = () => { setSelecting(false); setChecked(new Set()); };
  const finishedOnly = needs.filter(r => r.needs!.reasons.every(x => x.reason === "finished" || x.reason === "pr_closed"));
  const nextWake = later.map(r => r.snooze!).filter(s => /^\d{4}-/.test(s.until)).sort((a, b) => a.until.localeCompare(b.until))[0];
  const row = (r: InboxRow, extra: Partial<RowProps> = {}) => <View key={r.agentId}>
    <InboxRowView row={r} theme={theme} now={now} dense={dense} touch={touch} active={nav.activeAgentId === r.agentId}
      onOpen={nav.openAgent ? () => nav.openAgent!(r) : undefined} moreOpen={menu === r.agentId} onMore={() => setMenu(menu === r.agentId ? null : r.agentId)} {...extra} />
    {menu === r.agentId && <RowMenu row={r} store={store} theme={theme} touch={touch} close={() => setMenu(null)} />}
  </View>;
  const gap = dense ? 2 : 6;
  return <View style={{ gap }}>
    {offline !== null && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12, paddingHorizontal: dense ? 8 : 0 }}>Can't reach the host. Showing what was loaded before; sign-offs sync when it's back.</Text>}
    {cameBack.length > 0 && <Pressable accessibilityRole="button" onPress={() => store.clearCameBack()} style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: dense ? 8 : 0 }}>
      <Icon name="Info" size={13} color={c.statusWarning} />
      <Text style={{ flex: 1, color: c.foreground, fontSize: 12 }}>{cameBack.length === 1 ? "1 agent" : `${cameBack.length} agents`} came back while offline, so their sign-off didn't apply. Dismiss</Text>
    </Pressable>}
    {data?.error && <Text style={{ color: c.statusWarning, fontSize: 12, paddingHorizontal: dense ? 8 : 0 }}>{data.error}</Text>}

    <SectionHeader theme={theme} dense={dense} title="Needs you" count={needs.length} tone={needs.length ? undefined : c.foregroundMuted} open={open.needs} onToggle={() => toggle("needs")}
      right={needs.length > 0 && <View style={{ flexDirection: "row" }}>
        {selecting && finishedOnly.length > 0 && <Button theme={theme} compact={touch} kind="ghost" title="Select finished" onPress={() => setChecked(new Set(finishedOnly.map(r => r.agentId)))} />}
        <IconButton theme={theme} compact={touch} icon={selecting ? "X" : "ListChecks"} label={selecting ? "Stop selecting" : "Select agents"} onPress={() => { if (selecting) exitSelect(); else { setMenu(null); setSelecting(true); } }} />
      </View>} />
    {open.needs && <>
      {needs.map(r => row(r, { onSignOff: () => void store.signOff([r.agentId]), selecting, checked: checked.has(r.agentId), onCheck: () => pick(r.agentId) }))}
      {needs.length === 0 && <View style={{ paddingVertical: dense ? 8 : 10, paddingHorizontal: dense ? 8 : 0, gap: 3 }}>
        <Text style={{ color: c.foreground, fontSize: dense ? 12 : 13, fontWeight: "600" }}>Nothing needs you</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: dense ? 11 : 12, lineHeight: dense ? 15 : 17 }}>{RULE}{nextWake ? ` Next wake-up: ${wakeLabel(nextWake, now)}.` : ""}</Text>
      </View>}
    </>}
    {selecting && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 52 : 40, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
      <Text style={{ flex: 1, color: c.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{checked.size} selected</Text>
      <Button theme={theme} compact={touch} title="Later" disabled={!checked.size} onPress={() => { void store.snooze([...checked], snoozeUntil("tomorrow", new Date())); exitSelect(); }} />
      <Button theme={theme} compact={touch} kind="primary" icon="Check" title={`Sign off ${checked.size || ""}`.trim()} disabled={!checked.size} onPress={() => { void store.signOff([...checked]); exitSelect(); }} />
    </View>}

    {data?.firstRun && unsorted && <View style={{ marginTop: 4, padding: 12, gap: 8, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}><Text style={{ color: c.foreground, fontWeight: "600" }}>Agents stay in Needs you until you sign them off or reply.</Text> Opening one doesn't clear it. Sign off with ✓, /ok or ⌘K.</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}><Text style={{ color: c.foreground, fontWeight: "600" }}>Unsorted · {unsorted.length} older idle agent{unsorted.length === 1 ? "" : "s"}</Text> were idle for over 7 days, so they weren't added.</Text>
      {confirmAll
        ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foreground, fontSize: 12 }}>Sign off all {unsorted.length}? One Undo restores them for 24 h.</Text>
          <Button theme={theme} compact={touch} kind="primary" title={`Sign off ${unsorted.length}`} onPress={() => { setConfirmAll(false); void store.unsortedSignOff(); }} />
          <Button theme={theme} compact={touch} kind="ghost" title="Cancel" onPress={() => setConfirmAll(false)} />
        </View>
        : <View style={{ flexDirection: "row", gap: 8 }}>
          <Button theme={theme} compact={touch} icon="List" title={open.unsorted ? "Hide" : "Review"} onPress={() => toggle("unsorted")} />
          <Button theme={theme} compact={touch} title={`Sign off ${unsorted.length}…`} onPress={() => setConfirmAll(true)} />
        </View>}
      {open.unsorted && <View style={{ marginHorizontal: -8 }}>
        {unsorted.slice(0, 50).map(r => <InboxRowView key={r.agentId} row={r} theme={theme} now={now} dense touch={touch} trailing={age(r.lastActivityAt, now)}
          onOpen={nav.openAgent ? () => nav.openAgent!(r) : undefined} onSignOff={() => void store.unsortedSignOff([r.agentId])} />)}
        {unsorted.length > 50 && <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 8 }}>and {unsorted.length - 50} more</Text>}
      </View>}
    </View>}
    {data?.batchUndo && !unsorted && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: dense ? 8 : 0 }}>
      <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>Signed off {data.batchUndo.count} at once · {age(data.batchUndo.at, now)} ago</Text>
      <Button theme={theme} compact={touch} kind="ghost" icon="Undo2" title="Undo all" onPress={() => void store.batchUndo()} />
    </View>}

    {later.length > 0 && <>
      <SectionHeader theme={theme} dense={dense} title="Later" count={later.length} open={open.later} onToggle={() => toggle("later")} />
      {open.later && later.map(r => row(r, { trailing: wakeLabel(r.snooze!, now), onSignOff: () => void store.signOff([r.agentId]) }))}
    </>}
    {live.length > 0 && <>
      <SectionHeader theme={theme} dense={dense} title="Running" count={live.length} open={open.running} onToggle={() => toggle("running")} />
      {open.running && (showAllRunning ? live : live.slice(0, runningCap)).map(r => row(r))}
      {open.running && live.length > runningCap && !showAllRunning && <Button theme={theme} compact={touch} kind="ghost" title={`+${live.length - runningCap} more`} onPress={() => setShowAllRunning(true)} />}
    </>}
    {signed.length > 0 && <>
      <SectionHeader theme={theme} dense={dense} title="Signed off today" count={signed.length} open={open.signed} onToggle={() => toggle("signed")} />
      {open.signed && signed.map(r => row(r, { onUndo: r.undoable ? () => void store.undo([r.agentId]) : undefined, onMore: undefined }))}
    </>}
  </View>;
}

/**
 * Sidebar header item: "Needs you N". Registered once, synchronously (the host resolves sidebar items
 * when the installation mounts); it renders nothing at zero unless the developer keeps it always on.
 */
export function contributeHeaderItem(client: PluginClientContext, store: InboxStore) {
  function NeedsYouItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
    const count = useInbox(store, () => sectionRows(store.rows(), "needs", Date.now()).length);
    const visible = useInbox(store, () => store.enabled() && (count > 0 || store.headerWhenEmpty()));
    const c = theme.colors;
    if (!visible) return null;
    return <SidebarRow icon="Inbox" label="Needs you" active={currentScreen?.screenId === INBOX_SCREEN && currentScreen.params.section === "needs"} onPress={() => openScreen({ screenId: INBOX_SCREEN, params: { section: "needs" } })}
      trailing={count > 0 ? <View accessibilityLabel={`${count} need${count === 1 ? "s" : ""} you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View> : undefined} />;
  }
  return client.addSidebarHeaderItem({ id: "needs-you", title: "Needs you", Component: NeedsYouItem });
}

/**
 * Above the composer, one split control: the status ("Needs you · finished 12m") signs off on click,
 * and "More" beside it opens "Sign off & next", "Later…", "Mute this turn" and the finish switch.
 * Paseo has no split pill and rejects an empty pill label, so these are two adjacent pills. After a sign-off the status pill turns
 * into "Signed off · Undo" for 6 s.
 */
export function contributeInboxPills(client: PluginClientContext, store: InboxStore, openNext: (from: string) => void) {
  const pills = new Map<string, { workspaceId: string; key: string; status: PluginButtonRegistration; menu: PluginButtonRegistration | null }>();
  let undoTimer: ReturnType<typeof setTimeout> | null = null;
  const statusIcon = (agentId: string) => function StatusIcon(props: PluginButtonIconProps) {
    const reason = useInbox(store, () => { const r = store.rows().find(x => x.agentId === agentId); return r?.needs ? displayReason(r.needs)?.reason ?? null : null; });
    const c = props.theme.colors;
    if (!reason) return <Icon name="Undo2" size={props.size} color={c.foregroundMuted} />;
    const g = reasonGlyph(reason, c);
    return <Icon name={g.name} size={props.size} color={g.color} />;
  };
  const menuItems = (row: InboxRow) => [
    { kind: "item" as const, id: "next", title: "Sign off & next", icon: "ArrowRight", behavior: { kind: "action" as const, onPress() { void store.signOff([row.agentId]); openNext(row.agentId); } } },
    { kind: "item" as const, id: "later", title: "Later…", icon: "AlarmClock", behavior: { kind: "menu" as const, items: ([["hour", "In 1 hour"], ["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"], ["next-event", "Until the next event"]] as const).map(([id, title]) => ({ kind: "item" as const, id, title, behavior: { kind: "action" as const, onPress() { void store.snooze([row.agentId], snoozeUntil(id, new Date())); } } })) } },
    { kind: "item" as const, id: "mute", title: "Mute this turn", icon: "BellOff", visible: running(row), behavior: { kind: "action" as const, onPress() { void store.signOff([row.agentId], { muteTurn: true }); } } },
    { kind: "separator" as const, id: "sep" },
    { kind: "item" as const, id: "finishes", title: row.enable_finish_flags ? "Don't flag finishes" : "Flag finishes again", icon: row.enable_finish_flags ? "BellMinus" : "Bell", behavior: { kind: "action" as const, onPress() { void store.setFinishFlags(row.agentId, !row.enable_finish_flags); } } },
  ];
  const publish = () => {
    const now = Date.now();
    const recent = store.recent();
    const wanted = new Map<string, { row: InboxRow; label: string; title: string; undo: boolean }>();
    for (const row of store.rows()) {
      if (!row.workspaceId) continue;
      const shown = displayReason(row.needs);
      if (shown && !row.snooze) {
        const status = `Needs you · ${REASON_WORD[shown.reason].toLowerCase()} ${age(row.needs!.since, now)}`;
        wanted.set(row.agentId, { row, undo: false, label: `${REASON_WORD[shown.reason]} · ${age(row.needs!.since, now)}`, title: store.data()?.firstRun ? `${status}. Click to sign off. ${RULE}` : `${status}. Click to sign off.` });
      } else if (recent && recent.agentIds.includes(row.agentId) && now - recent.at < 6_000) {
        wanted.set(row.agentId, { row, undo: true, label: "Undo sign-off", title: "Signed off. Click to undo." });
      }
    }
    for (const [agentId, entry] of pills) {
      const next = wanted.get(agentId);
      if (!next || next.row.workspaceId !== entry.workspaceId) { entry.status.remove(); entry.menu?.remove(); pills.delete(agentId); }
    }
    for (const [agentId, next] of wanted) try {
      const key = `${next.label}|${next.undo}|${next.row.enable_finish_flags}|${running(next.row)}`;
      const status = { title: next.title, label: next.label, behavior: { kind: "action" as const, onPress() { if (next.undo) void store.undo([agentId]); else void store.signOff([agentId]); } } };
      const entry = pills.get(agentId);
      if (!entry) {
        const registration = client.addComposerPill({ id: "needs-you", workspaceId: next.row.workspaceId!, agentId, button: { ...status, icon: statusIcon(agentId) } });
        const menu = next.undo ? null : client.addComposerPill({ id: "needs-you-menu", workspaceId: next.row.workspaceId!, agentId, button: { title: "More sign-off options", label: "More", icon: "Ellipsis", behavior: { kind: "menu", items: menuItems(next.row) } } });
        pills.set(agentId, { workspaceId: next.row.workspaceId!, key, status: registration, menu });
      } else if (entry.key !== key) {
        entry.status.update(status);
        if (next.undo) { entry.menu?.remove(); entry.menu = null; }
        else if (entry.menu) entry.menu.update({ behavior: { kind: "menu", items: menuItems(next.row) } });
        else entry.menu = client.addComposerPill({ id: "needs-you-menu", workspaceId: next.row.workspaceId!, agentId, button: { title: "More sign-off options", label: "More", icon: "Ellipsis", behavior: { kind: "menu", items: menuItems(next.row) } } });
        entry.key = key;
      }
    } catch { /* One agent's pill must never hide the others. */ }
    if (recent && Date.now() - recent.at < 6_000) { if (undoTimer) clearTimeout(undoTimer); undoTimer = setTimeout(publish, 6_000 - (Date.now() - recent.at) + 50); }
  };
  const unsubscribe = store.subscribe(publish);
  // Ages count up between polls.
  const ticker = setInterval(publish, 60_000);
  return () => { unsubscribe(); clearInterval(ticker); if (undoTimer) clearTimeout(undoTimer); for (const p of pills.values()) { p.status.remove(); p.menu?.remove(); } pills.clear(); };
}

/** ⌘K items and /ok. The keyboard path is ⌘K, "ok", Enter. */
export function contributeInboxCommands(client: PluginClientContext, store: InboxStore, openNext: (from: string | null) => void) {
  const removers = [
    client.addCommandCenterItem({ id: "inbox-sign-off-next", title: "Sign off & next", icon: "ArrowRight", keywords: ["ok", "done", "ack", "needs you", "sign off", "next"], context: "agent",
      onSelect({ agent }) { void store.signOff([agent.id]); openNext(agent.id); } }),
    client.addCommandCenterItem({ id: "inbox-sign-off", title: "Sign off", icon: "Check", keywords: ["ok", "done", "ack", "needs you", "sign off"], context: "agent",
      onSelect({ agent }) { void store.signOff([agent.id]); } }),
    client.addCommandCenterItem({ id: "inbox-later", title: "Later: tomorrow 09:00", icon: "AlarmClock", keywords: ["ok", "snooze", "later", "needs you"], context: "agent",
      onSelect({ agent }) { void store.snooze([agent.id], snoozeUntil("tomorrow", new Date())); } }),
    client.addCommandCenterItem({ id: "inbox-undo", title: "Undo last sign-off", icon: "Undo2", keywords: ["ok", "undo", "needs you", "sign off"], context: "global",
      onSelect() { void store.undo(); } }),
    client.addCommandCenterItem({ id: "inbox-next", title: "Next needing me", icon: "Inbox", keywords: ["ok", "next", "needs you", "inbox"], context: "global",
      onSelect() { openNext(null); } }),
    client.addSlashCommand({ name: "ok", description: "Sign off this agent (Needs you). /ok next opens the next one", argumentHint: "[next]", context: "agent",
      onSubmit({ agent, args }) { void store.signOff([agent.id]); if (/^\s*next\b/i.test(args)) openNext(agent.id); } }),
  ];
  return () => { for (const r of removers) r(); };
}

/** "Sign off & next" target, honouring D9 and skipping the agent just signed off. */
export function nextTarget(store: InboxStore, from: string | null): InboxRow | null {
  return nextAfter(store.rows(), from, Date.now());
}

/** Follow-up's screen relays "& next": opening the screen with `next` hands off to the host's navigation. */
export function useNextRelay(store: InboxStore, params: Record<string, string>, openAgent: ((row: InboxRow) => void) | undefined) {
  const done = useRef<string | null>(null);
  const ready = useInbox(store, () => !!store.data());
  useEffect(() => {
    const token = params.next;
    if (!token || !openAgent || !ready || done.current === token) return;
    done.current = token;
    const target = nextTarget(store, params.from ?? null);
    if (target) openAgent(target);
  }, [params.next, params.from, ready, openAgent, store]);
}
