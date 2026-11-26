import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NEW_NAME } from "../shared/new-name";
import { View, type FlatList as NativeFlatList } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, FlatList } from "@getpaseo/plugin/client/ui";
import { type Badge, type HomeGroupId, type HomeModel, type Workstream, prChipSpoken, railChips } from "../shared/home";
import { ASK_KEY, excerpt, FIELD_LABEL, type OmniboxItem, type Range, type RowHit, type SearchHit } from "../shared/search";
import { AskRow, PriorityLine } from "./home-chrome";
import { age, wakeLabel, wakeShort } from "../shared/inbox";
import { headlineColor, mergedColor, readable, runningColor, tint, toneColor, withAlpha, type Colors } from "./theme";
import { useMinute } from "./home-data";
import { marked } from "./rich-text";
import { Spinner } from "./motion";
import { Button, focusRing, rowDomId, type Theme } from "./kit";
import { useListKeys } from "./list-keys";
import { bindRowDoubleClick, useRowOpen } from "./row-open";
import { walkOrder } from "../shared/list-keys";
import { BRIEF_KEY, OVERSEER_KEY, QUIET_PAGE, listEntries, type Entry } from "../shared/list-entries";
import { RowMenu, useRowMenuTrigger, type OpenRowMenu, type RowMenuOpen } from "./row-menu";
import type { RowMenuItem, RowMenuSection } from "../shared/row-menu";
import { homeGroupOpen, writeHomeGroupOpen } from "../shared/settings-nav";
import { useViewVersion } from "./view-store";

/**
 * The one list: Home's left side and (on hosts that have it) the sidebar
 * view. Virtualised; rows are memoised on their signature and ages tick on their own, so a minute tick or a poll
 * that changes one row redraws only that row.
 */

export { BRIEF_KEY, OVERSEER_KEY, archivedRow } from "../shared/list-entries";
/** The pinned Overseer row: not started yet (a one-time Start), working, asking, idle, or failed to come back. */
export type OverseerRowState = { state: "start" | "idle" | "running" | "asks" | "error"; line: string;
  /** A list filter's match in `line`, highlighted like a row's (the sidebar view's "Filter workspaces"). */
  ranges?: Range[] };


export type HomeListProps = {
  model: HomeModel;
  theme: Theme;
  /** Navigator and sidebar density: one-line rows without badges. */
  dense?: boolean;
  touch: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** The brief row's one-liner. Absent: no brief row (the sidebar view). */
  briefLine?: string | null;
  /** Content shown under the selected row (an expanded row). */
  renderExpanded?: (s: Workstream) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /** Chrome above the list that never scrolls away: search, sort, status, limits. */
  top?: ReactNode;
  /** Phones: a row placed right after the Needs-you group (the setup offer), so it never pushes the first ask down. */
  afterNeeds?: ReactNode;
  /** Decision Q8's raised Linear issues, drawn first in Needs you when `model.raised` counts any. */
  raised?: ReactNode;
  /** Phones: the action under the "Nothing followed yet" empty state. */
  emptyAction?: ReactNode;
  /** While searching: one flat ranked list instead of the groups. */
  results?: OmniboxItem[] | null;
  /**
   * The sidebar view's filter: `model` is already narrowed to matches (shared/search.ts filterHome); these are the
   * hits, highlighted on the rows. Every group and Quiet fold holding a match is open while it's set.
   */
  hits?: Map<string, SearchHit> | null;
  activeResult?: number;
  onResult?: (item: OmniboxItem) => void;
  /** The status strip's filter: only this group, expanded. */
  filter?: HomeGroupId | null;
  /** The pinned Overseer row under the brief. Absent: the Overseer is off (or this surface has none). */
  overseer?: OverseerRowState | null;
  /** A narrow list (Paseo's sidebar view): the Overseer row stacks like every row there, title then its line. */
  stackOverseer?: boolean;
  /** An omnibox ask is on its way to the Overseer. */
  asking?: boolean;
  /** Sending rows' Send now (only where the server would take it: Workstream.sendNow). Absent: the list offers none. */
  onSendNow?: (s: Workstream) => Promise<void>;
  /**
   * The row menu (right-click, long-press, the menu key): what a row offers, and what a pick does. Required, so no
   * list of workspaces ships without it (every-list-row-has-the-row-menu): without it the browser's or desktop app's
   * own Copy/Paste menu opens instead.
   */
  menu: { build: (s: Workstream) => RowMenuSection[]; pick: (s: Workstream, item: RowMenuItem) => void };
  /**
   * Desktop and web keys (client/list-keys.ts, one-keyboard-walk-for-every-list): ↑/↓ and j/k walk the rows in this
   * list's order, Home/End jump, Enter or O opens, S shows the keys (`onKeys`, Home). "select" moves the selection (Home); "focus" moves only the focus and
   * Enter opens (the sidebar view). `scope`: where the keys count (default: this list); `claimBody`: also with
   * nothing focused.
   */
  keys?: { mode: "select" | "focus"; onOpen: (key: string) => void; onKeys?: () => void; scope?: { current: unknown }; claimBody?: boolean };
  /** The selected row's fill. Paseo's sidebar view passes its own selected-item colour (sidebarSelected); Home: surface2. */
  selectedBg?: string;
};

const noMenu: OpenRowMenu = () => undefined;

/** Where a phone row's text starts: its 14 padding, the 18 glyph, the 10 gap. Older's explainer lines up with it. */
export const TOUCH_ROW_TEXT = 14 + 18 + 10;

export function HomeList({ model, theme, dense = false, touch, selectedKey, onSelect, briefLine, renderExpanded, header, footer, top, afterNeeds, raised, emptyAction, results, hits = null, activeResult = 0, onResult, filter = null, overseer = null, stackOverseer = false, asking = false, menu, onSendNow, keys, selectedBg }: HomeListProps) {
  const c = theme.colors;
  const onOpen = useRowOpen(keys?.onOpen);
  const [openMenu, setOpenMenu] = useState<RowMenuOpen | null>(null);
  const build = menu.build;
  const onMenu = useMemo<OpenRowMenu>(() => (s, anchor, node, keyboard) => {
    const sections = build(s);
    if (sections.length) setOpenMenu({ s, anchor, sections, returnTo: node, keyboard });
  }, [build]);
  const menuKey = openMenu?.s.key ?? null;
  // Group folds persist per device (device document on 0.16), read on every render so the cache paints first. Needs
  // you is the exception: it opens on every mount, and closing it holds only for this mount.
  const view = useViewVersion();
  const [needsClosed, setNeedsClosed] = useState(false);
  const closed = useMemo(() => { const n = new Set(model.groups.map(g => g.id).filter(id => id !== "needs" && !homeGroupOpen(id))); if (needsClosed) n.add("needs"); return n; }, [model.groups, needsClosed, view]);
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<Record<string, number>>({});
  const toggle = useCallback((key: string) => { if (key === "needs") setNeedsClosed(v => !v); else writeHomeGroupOpen(key, !homeGroupOpen(key)); }, []);
  const toggleProject = useCallback((p: string) => setOpenProjects(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; }), []);

  const data = useMemo(() => listEntries({ model, closed, openProjects, pages, briefLine, results, hits, filter, overseer: !!overseer, touch, afterNeeds: !!afterNeeds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, closed, openProjects, pages, briefLine, results, hits, filter, !!overseer, touch, !!afterNeeds]);
  // A result picks through onResult; Row only knows its key.
  const pickResult = useCallback((key: string) => {
    const item = results?.find(i => !i.ask && i.key === key);
    if (item) onResult?.(item);
  }, [results, onResult]);

  const render = useCallback(({ item }: { item: Entry }) => {
    switch (item.type) {
      // "Archived" heads its results like a group: small caps on desktop, sentence case at 13 on phones (GroupHeader).
      case "label": return <Text accessibilityRole={item.key === "l:archived" ? "header" : undefined} style={{ color: c.foregroundMuted, fontSize: item.key === "l:archived" && !touch ? 11 : 13, fontWeight: item.key === "l:archived" ? "600" : "400",
        letterSpacing: item.key === "l:archived" && !touch ? 0.6 : 0, textTransform: item.key === "l:archived" && !touch ? "uppercase" : "none", paddingHorizontal: dense ? 8 : 16, ...(item.key === "l:older" && touch ? { paddingLeft: TOUCH_ROW_TEXT } : null), paddingTop: 12, paddingBottom: 4 }}>{item.text}</Text>;
      case "empty": return <View accessibilityRole="summary" style={{ marginHorizontal: 16, marginTop: 20, gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, lineHeight: 23, fontWeight: "600" }}>Nothing followed yet</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{`Workspaces show up here once their agents work. Start one with ${NEW_NAME}, from an issue, a PR or your words.`}</Text>
        {emptyAction ? <View style={{ flexDirection: "row", marginTop: 6 }}>{emptyAction}</View> : null}
      </View>;
      case "slot": return <View style={{ paddingVertical: 10 }}>{afterNeeds}</View>;
      case "raised": return <>{raised}</>;
      case "hold": return <HoldLine theme={theme} text={item.text} dense={dense} touch={touch} />;
      // The list's own Row (search-row-is-the-list-row); the keyboard-active result wears the selected style.
      case "result": return <Row s={item.s} sig={item.s.sig} hit={item.hit} theme={theme} dense={dense} touch={touch} selected={item.index === activeResult} menuOpen={menuKey === item.s.key}
        onSelect={pickResult} onOpen={onOpen} onMenu={item.archived ? noMenu : onMenu} />;
      case "ask": return <AskRow ask={item.ask} theme={theme} active={item.index === activeResult} dense={dense} touch={touch} sending={!!asking} onPress={() => onResult?.({ provider: "overseer", key: ASK_KEY, ask: item.ask })} />;
      case "brief": return <BriefRow theme={theme} line={briefLine ?? ""} selected={!touch && (selectedKey === null || selectedKey === BRIEF_KEY)} touch={touch} onSelect={onSelect} />;
      case "overseer": return overseer ? <OverseerRow theme={theme} o={overseer} selected={selectedKey === OVERSEER_KEY} touch={touch} stacked={stackOverseer} onSelect={onSelect} selectedBg={selectedBg} /> : null;
      case "header": return <GroupHeader theme={theme} title={item.title} count={item.count} open={item.open} tone={item.group === "needs" && item.count ? c.statusWarning : undefined} dense={dense} touch={touch} folds={item.group === "older" || item.group === "quiet"} onPress={() => toggle(item.group)} />;
      case "fold": return <Pressable accessibilityRole="button" aria-expanded={item.open} accessibilityState={{ expanded: item.open }} accessibilityLabel={`${item.project}, ${item.count}. ${item.open ? "Collapse" : "Expand"}`} onPress={() => toggleProject(item.project)}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 44 : dense ? 28 : 34, paddingHorizontal: dense ? 8 : 16, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
        <Icon name={item.open ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: dense ? 12 : 13, fontWeight: "500" }}>{item.project}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: dense ? 11 : 12, fontVariant: ["tabular-nums"] }}>{item.count}</Text>
        {item.archivable > 0 && <Text numberOfLines={1} style={{ color: c.statusSuccess, fontSize: dense ? 11 : 12 }}>· {item.archivable} ready to archive</Text>}
      </Pressable>;
      case "more": return <Pressable accessibilityRole="button" onPress={() => setPages(p => ({ ...p, [item.project]: (p[item.project] ?? 1) + 1 }))}
        style={{ minHeight: touch ? 44 : 30, justifyContent: "center", paddingHorizontal: dense ? 30 : 42 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Show {Math.min(QUIET_PAGE, item.left)} more of {item.left}</Text>
      </Pressable>;
      case "row": {
        const selected = selectedKey === item.key;
        return <View>
          <Row s={item.s} theme={theme} dense={dense} touch={touch} selected={selected} onSelect={onSelect} onOpen={onOpen} sig={item.s.sig} onMenu={onMenu} menuOpen={menuKey === item.key} hit={item.hit} onSendNow={onSendNow} selectedBg={selectedBg} />
          {selected && renderExpanded ? renderExpanded(item.s) : null}
        </View>;
      }
    }
  }, [theme, c, dense, touch, selectedKey, onSelect, briefLine, renderExpanded, toggle, toggleProject, activeResult, onResult, pickResult, model, overseer?.state, overseer?.line, overseer?.ranges, stackOverseer, asking, afterNeeds, raised, emptyAction, onMenu, menuKey, onSendNow, selectedBg, onOpen]);

  const listRef = useRef<NativeFlatList<Entry>>(null);
  const rootRef = useRef<View>(null);
  // The keyboard walk: the rows as drawn, the brief and the Overseer first (they're rows too). A search walks its
  // results through the omnibox instead.
  const order = useMemo(() => results ? [] : walkOrder(data), [data, results]);
  useListKeys({
    // On while a search shows its results too: the walk has no rows then (walkOrder), but Enter with nothing focused
    // still opens the selection the search picked.
    enabled: !!keys && !touch, order, mode: keys?.mode ?? "focus",
    // Home draws the brief as selected while nothing is.
    selectedKey: selectedKey ?? (order[0] === BRIEF_KEY ? BRIEF_KEY : null),
    scope: () => (keys?.scope?.current ?? rootRef.current) as { contains(n: unknown): boolean; checkVisibility?(): boolean } | null,
    claimBody: keys?.claimBody, onSelect, onOpen: key => keys?.onOpen(key), onKeys: keys?.onKeys ? () => keys.onKeys?.() : undefined,
    reveal: key => { const index = data.findIndex(e => e.key === key); if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }); },
  });
  // Keep the keyboard-active result in view.
  useEffect(() => {
    if (!results?.length) return;
    const at = data.findIndex(e => (e.type === "result" || e.type === "ask") && e.index === activeResult);
    if (at >= 0) listRef.current?.scrollToIndex({ index: at, viewPosition: 0.5, animated: false });
  }, [activeResult, results, data]);
  const list = <FlatList ref={listRef} data={data} keyExtractor={e => e.key} renderItem={render} extraData={`${selectedKey}:${activeResult}:${asking}:${menuKey}`} onScrollToIndexFailed={() => undefined}
    initialNumToRender={30} maxToRenderPerBatch={30} windowSize={9} removeClippedSubviews={false}
    ListHeaderComponent={header ? <>{header}</> : null} ListFooterComponent={footer ? <>{footer}</> : <View style={{ height: 32 }} />}
    style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled" />;
  const overlay = openMenu ? <RowMenu key={`${openMenu.s.key}:${openMenu.anchor?.x ?? "sheet"}:${openMenu.anchor?.y ?? ""}`} menu={openMenu} theme={theme} onClose={() => setOpenMenu(null)} onPick={item => menu.pick(openMenu.s, item)} /> : null;
  // The wrapper is always there, so opening the menu never remounts the list (and its scroll).
  return <View ref={rootRef} style={{ flex: 1, minHeight: 0 }}>{top}{list}{overlay}</View>;
}

function GroupHeader({ theme, title, count, open, tone, dense, touch, folds = false, onPress }: { theme: Theme; title: string; count: number; open: boolean; tone?: string; dense: boolean; touch: boolean; folds?: boolean; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}. ${open ? "Collapse" : "Expand"}`} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: touch ? 44 : dense ? 28 : 34, paddingHorizontal: touch ? 16 : dense ? 8 : 16, paddingTop: touch ? 8 : dense ? 4 : 8 }}>
    {dense && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={touch ? 14 : 12} color={c.foregroundMuted} />}
    {/* Phones: sentence case at 13, the section role; desktop keeps the small caps. */}
    <Text accessibilityRole="header" style={touch ? { color: tone ?? c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" } : { color: tone ?? c.foregroundMuted, fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>{touch ? title.charAt(0) + title.slice(1).toLowerCase() : title}</Text>
    <Text style={{ color: tone ?? c.foregroundMuted, fontSize: touch ? 13 : 11, lineHeight: touch ? 18 : 14, fontVariant: ["tabular-nums"] }}>{count}</Text>
    {/* A group that starts folded keeps its fold control when open, so it can be folded again. */}
    {!dense && (!open || folds) && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={c.foregroundMuted} />}
  </Pressable>;
}

function BriefRow({ theme, line, selected, touch, onSelect }: { theme: Theme; line: string; selected: boolean; touch: boolean; onSelect: (key: string) => void }) {
  const c = theme.colors;
  return <Pressable nativeID={rowDomId(BRIEF_KEY)} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Morning brief. ${line}`} onPress={() => onSelect(BRIEF_KEY)}
    style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c, true), flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 52 : 40, paddingHorizontal: 16, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name="Sun" size={touch ? 16 : 15} color={c.foregroundMuted} />
    <Text style={{ color: c.foreground, fontSize: touch ? 14 : 13, fontWeight: "600" }}>Morning brief</Text>
    <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: touch ? 13 : 12 }}>{line}</Text>
    {touch && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
  </Pressable>;
}

function OverseerRow({ theme, o, selected, touch, stacked = false, onSelect, selectedBg }: { theme: Theme; o: OverseerRowState; selected: boolean; touch: boolean; stacked?: boolean; onSelect: (key: string) => void; selectedBg?: string }) {
  const c = theme.colors;
  const tone = o.state === "asks" ? c.statusWarning : o.state === "error" ? c.statusDanger : o.state === "running" ? runningColor(c) : c.foregroundMuted;
  const icon = o.state === "running" ? <Spinner color={tone} size={13} label="Overseer working" /> : <Icon name="MessagesSquare" size={touch ? 16 : 15} color={o.state === "idle" || o.state === "start" ? c.foregroundMuted : tone} />;
  const lineColor = o.state === "asks" || o.state === "error" ? tone : c.foregroundMuted;
  // Wide Home: one line, the phone's shorter start line. Stacked (the sidebar view): the whole line, wrapping to two.
  const line = marks(!stacked && touch && o.state === "start" ? "Ask about any workspace" : o.line, stacked || !(touch && o.state === "start") ? o.ranges : null, c);
  return <Pressable nativeID={rowDomId(OVERSEER_KEY)} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Overseer. ${o.line}`} onPress={() => onSelect(OVERSEER_KEY)}
    style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c, true), flexDirection: "row", alignItems: stacked ? "flex-start" : "center", gap: 10, minHeight: touch ? 52 : 40, paddingLeft: 14, paddingRight: 16, paddingVertical: stacked ? (touch ? 12 : 8) : 0, borderBottomWidth: 1, borderBottomColor: c.border,
      // Its ask isn't a Needs-you row (it's yours to route), so the edge marks it the way blocking rows are marked.
      borderLeftWidth: 2, borderLeftColor: o.state === "asks" || o.state === "error" ? withAlpha(tone, 0.9) : "transparent",
      backgroundColor: selected ? selectedBg ?? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    {stacked ? <View style={{ paddingTop: 2 }}>{icon}</View> : icon}
    {stacked
      ? <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.foreground, fontSize: touch ? 14 : 13, fontWeight: "600" }}>Overseer</Text>
          <Text numberOfLines={2} style={{ color: lineColor, fontSize: touch ? 13 : 12, lineHeight: touch ? 18 : 16 }}>{line}</Text>
        </View>
      : <>
          <Text style={{ color: c.foreground, fontSize: touch ? 14 : 13, fontWeight: "600" }}>Overseer</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: lineColor, fontSize: touch ? 13 : 12 }}>{line}</Text>
          {touch && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
        </>}
  </Pressable>;
}

/**
 * `text`: the colour carries the state word on its own (phones), so it's lifted to 4.5:1 on dark grounds. Finished
 * uses the host accent and success green, both fill colours at about 3:1 as 12px text.
 */
/** The row's hint, the same on Home rows and search results. */
export const quickActionsHint = (touch: boolean) => touch ? "Long-press for quick actions" : "Quick actions: Shift+F10";

export function glyphColor(s: Pick<Workstream, "tone">, c: Colors, text = false): string {
  const base = s.tone === "running" ? runningColor(c) : s.tone === "success" ? c.statusSuccess : headlineColor(s.tone, c);
  return text ? readable(base, c) : base;
}
const badgeColor = (b: Badge, c: Colors) => b.tone === "danger" ? c.statusDanger : b.tone === "warning" ? c.statusWarning : b.tone === "success" ? c.statusSuccess : b.tone === "merged" ? mergedColor(c) : c.foregroundMuted;

export function BadgeView({ b, c }: { b: Badge; c: Colors }) {
  const col = badgeColor(b, c);
  return <View testID="follow-up-row-chip" style={{ flexShrink: 1, minWidth: 0, paddingHorizontal: 6, height: 20, justifyContent: "center", borderRadius: 4, backgroundColor: b.tone === "muted" ? c.surface2 : tint(col, c) }}>
    <Text numberOfLines={1} style={{ color: col, fontSize: 11, lineHeight: 14, fontWeight: "500" }}>{b.text}</Text>
  </View>;
}

export function PrChipView({ s, c }: { s: Workstream; c: Colors }) {
  if (!s.pr) return null;
  const checks = s.pr.checks;
  return <View testID="follow-up-row-chip" role="img" aria-label={prChipSpoken(s.pr)} style={{ flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, height: 20, borderRadius: 4, borderWidth: 1, borderColor: c.border }}>
    <Icon name="GitPullRequest" size={11} color={toneColor(c, s.pr.tone)} />
    <Text numberOfLines={1} style={{ flexShrink: 0, color: c.foreground, fontSize: 11, lineHeight: 14, fontVariant: ["tabular-nums"] }}>{s.pr.label}</Text>
    {checks && <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: checks.tone === "muted" ? c.foregroundMuted : badgeColor({ text: "", tone: checks.tone }, c), fontSize: 11, lineHeight: 14 }}>{checks.text}</Text>}
  </View>;
}

/** Phones: the PR summary as plain text ("#1402 +1 · 1 thread") inside a meta line, no bordered chip. */
export function PrSummaryText({ s, c, lead = "" }: { s: Workstream; c: Colors; lead?: string }) {
  if (!s.pr) return null;
  const checks = s.pr.checks;
  return <Text>{lead}<Text style={{ color: c.foreground }}>{s.pr.label.replace(/\+(\d)/, " +$1")}</Text>
    {checks && <Text style={{ color: checks.tone === "muted" ? c.foregroundMuted : badgeColor({ text: "", tone: checks.tone }, c) }}>{` ${checks.text}`}</Text>}</Text>;
}

/** A Later row's time column: when it comes back ("in 25m", "tomorrow 09:00"), on the same minute clock as Age. */
export function WakeTime({ until, c, size = 12 }: { until: string; c: Colors; size?: number }) {
  const now = useMinute();
  const text = wakeShort(until, Math.max(now, Date.now()));
  return text ? <Text style={{ color: c.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums"], minWidth: 26, textAlign: "right" }}>{text}</Text> : null;
}
/** The right-hand time: when a Later row comes back, otherwise how long ago. */
function RowTime({ s, c, size }: { s: Workstream; c: Colors; size: number }) {
  return <View testID="follow-up-row-time" style={{ flexShrink: 0 }}>{s.group === "later" && s.wakeAt ? <WakeTime until={s.wakeAt} c={c} size={size} /> : <Age iso={s.at} c={c} size={size} />}</View>;
}

/**
 * row-chips-never-cover-the-time: a desktop row's badges and PR chip, in priority order (most telling first). They yield
 * before the time column ever moves: the rail shrinks first, a chip that doesn't fit wraps onto a second line the rail
 * clips (so the lowest-priority chips drop, last first), and a lone chip truncates. Guarded by
 * `scripts/screenshots.mjs --only rowchips` (CDP boxes at list widths 320, 360 and 400) and tests/row-chips.test.ts.
 */
function ChipRail({ s, c, dim = false }: { s: Workstream; c: Colors; /** An Older row: chips at 60 %, like its glyph. */ dim?: boolean }) {
  const chips = railChips(s);
  if (chips.length === 0) return null;
  return <View testID="follow-up-row-chips" style={{ ...(dim ? { opacity: 0.6 } : {}), flexShrink: 1000, minWidth: 0, height: 20, overflow: "hidden", flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 10, rowGap: 4 }}>
    {chips.map(ch => ch.kind === "badge" ? <BadgeView key={ch.badge.text} b={ch.badge} c={c} /> : <PrChipView key="pr" s={s} c={c} />)}
  </View>;
}

/** The age on the right. It re-renders on the shared minute clock without touching its row. */
export function Age({ iso, c, size = 12 }: { iso: string | null; c: Colors; size?: number }) {
  const now = useMinute();
  const text = age(iso, Math.max(now, Date.now()));
  return text ? <Text style={{ color: c.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums"], minWidth: 26, textAlign: "right" }}>{text}</Text> : null;
}

/** Matched words, highlighted inside a line of text: the hit colour, semibold, on a light warning tint. */
export function marks(text: string, ranges: Range[] | null | undefined, c: Colors): ReactNode {
  if (!ranges?.length) return text;
  return marked(text, 0, ranges, c);
}


/**
 * One row component for every list, Home's groups and search results alike (search-row-is-the-list-row). A search
 * passes `hit`: the matched words are highlighted where they already are (title, "› agent", the ask line), and a match
 * in a field the row doesn't show replaces line 2 with "<Field> · excerpt", so a result is exactly as tall as the row.
 */
type RowProps = { s: Workstream; sig: string; theme: Theme; dense: boolean; touch: boolean; selected: boolean; onSelect: (key: string) => void; onOpen?: (key: string) => void; onMenu: OpenRowMenu; menuOpen?: boolean; hit?: RowHit | null; onSendNow?: (s: Workstream) => Promise<void>; selectedBg?: string };
const Row = memo(function Row({ s, theme, dense, touch, selected, onSelect, onOpen, onMenu, menuOpen = false, hit = null, onSendNow, selectedBg }: RowProps) {
  const c = theme.colors;
  const trigger = useRowMenuTrigger(s, onMenu, touch);
  useEffect(() => {
    if (touch || menuOpen || !onOpen) return;
    return bindRowDoubleClick(trigger.ref.current as unknown as Parameters<typeof bindRowDoubleClick>[0], () => onOpen(s.key));
  }, [touch, menuOpen, onOpen, s.key, trigger.ref]);
  const archived = s.icon === "Archive" && s.sig.startsWith("archived:");
  // An Older row is demoted at one level: its title muted, and its glyph and chips keep their hue at 60 % (still
  // readable as an error or a review), never full red beside a grey title.
  const older = s.group === "older";
  const color = archived ? c.foregroundMuted : older ? withAlpha(glyphColor(s, c, touch), 0.6) : glyphColor(s, c, touch);
  const blocking = s.group === "needs" && s.tier === 0;
  const muted = s.group === "quiet" || s.group === "later" || s.group === "older";
  // Desktop rows are one line beside badges and the PR chip: the ask and the "<Field> · excerpt" line are cut around the
  // match (about 44 characters, the match near the start), so the highlight is never past the "…". Phones and the
  // sidebar view wrap to two lines and keep more.
  const shownLine = hit?.lineRanges ? (() => { const e = excerpt(s.line, hit.lineRanges, touch ? 140 : dense ? 90 : 44); return marks(e.text, e.ranges, c); })() : s.line;
  // What the agent is working on (shared/now.ts) leads, in the title's colour; its place ("2/4") and the state stay muted.
  const lead = s.lead ? <><Text style={{ color: muted ? c.foregroundMuted : c.foreground }}>{s.lead.text}</Text>{s.lead.position ? `\u00a0${s.lead.position}` : ""}{s.line ? " · " : ""}</> : null;
  const line: ReactNode = s.word && s.group !== "needs" ? (s.line ? <>{s.word} · {lead}{shownLine}</> : s.word) : <>{lead}{shownLine}</>;
  const via = hit?.via ? (() => { const e = excerpt(hit.via.text, hit.via.ranges, touch ? 90 : dense ? 90 : 44); return <>{FIELD_LABEL[hit.via.field]} · {marks(e.text, e.ranges, c)}</>; })() : null;
  const title = <>{marks(s.title, hit?.titleRanges, c)}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{" › "}{marks(s.agent, hit?.agentRanges, c)}</Text> : null}</>;
  // Phones: "Working" under every row of a "Running 9" group says nothing the header didn't; one line per row instead.
  const generic = touch && !s.word && !s.lead && s.line === "Working";
  // The reason line: AI priority's, else the workspace's first live Compass note (a live note is a reason).
  const why = s.priority?.reason ? { reason: s.priority.reason, source: s.priority.source } : s.compass ? { reason: s.compass, source: { kind: "compass" as const, label: "Compass" } } : null;
  // Send now: outlined (filled is only for what waits on the developer), and only where the server would take it.
  const sendNow = s.sendNow && onSendNow && !dense ? <SendNowButton s={s} theme={theme} touch={touch} onSendNow={onSendNow} /> : null;
  // A Later row says when it comes back on screen; the label also keeps how long it has waited.
  const wake = s.group === "later" && s.wakeAt ? wakeLabel({ until: s.wakeAt, at: s.at ?? new Date().toISOString() }, Date.now()) : "";
  const waited = s.group === "later" && s.at ? age(s.at, Date.now()) : "";
  const label = [s.title + (s.agent ? ` › ${s.agent}` : ""), s.word, s.lead && [s.lead.text, s.lead.position?.replace("/", " of ")].filter(Boolean).join(" "), s.line, hit?.via && `${FIELD_LABEL[hit.via.field]}: ${hit.via.text}`,
    // Every chip, even one a narrow row hides (row-chips-never-cover-the-time).
    ...s.badges.map(b => b.text), s.pr && prChipSpoken(s.pr), wake && `Later until ${wake}`, waited && (waited === "now" ? "just now" : `waiting ${waited}`)].filter(Boolean).join(". ");
  return <Pressable ref={trigger.ref} nativeID={rowDomId(s.key)} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={label} accessibilityHint={quickActionsHint(touch)}
    onPress={() => onSelect(s.key)} onLongPress={trigger.onLongPress} delayLongPress={450}
    style={state => ({ ...focusRing((state as { focused?: boolean }).focused, c, true), flexDirection: "row", alignItems: dense ? "flex-start" : "center", gap: touch ? 10 : dense ? 8 : 10, minHeight: touch ? 56 : dense ? 36 : 38, paddingLeft: touch ? 14 : dense ? 8 : 16, paddingRight: touch ? 16 : dense ? 8 : 16, paddingVertical: touch ? 12 : dense ? 6 : 0,
      ...(touch ? { borderBottomWidth: 1, borderBottomColor: withAlpha(c.border, 0.6) } : {}),
      borderLeftWidth: 2, borderLeftColor: blocking ? withAlpha(color, 0.9) : "transparent",
      backgroundColor: selected ? selectedBg ?? c.surface2 : menuOpen || state.pressed && touch ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: touch ? 18 : 16, alignItems: "center", paddingTop: touch ? 2 : dense ? 1 : 0 }}>
      {s.tone === "running" && s.icon === "LoaderCircle" ? <Spinner color={color} size={13} label="Running" /> : <Icon name={s.icon} size={touch ? 17 : 15} color={color} />}
    </View>
    {/* Phones: title 15/20 over two lines, then state · reason, then the PRs as plain text (no bordered chips). */}
    {touch ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: muted ? c.foregroundMuted : c.foreground, fontSize: 15, lineHeight: 20, fontWeight: muted ? "400" : "500" }}>{title}</Text>
        <View style={{ paddingTop: 2 }}><RowTime s={s} c={c} size={12} /></View>
      </View>
      {via ? <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{via}</Text>
        : (!!s.word || !!s.line || !!s.lead) && !generic && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
        {s.word && s.group === "needs" ? <Text style={{ color, fontWeight: "600" }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>}
      {!!why && <PriorityLine reason={why.reason} source={why.source} c={c} size={12} lines={2} />}
      {!!s.pr && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"], ...(older ? { opacity: 0.6 } : {}) }}><PrSummaryText s={s} c={c} /></Text>}
      {sendNow && <View style={{ flexDirection: "row", marginTop: 6 }}>{sendNow}</View>}
    </View> : dense ? <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={1} style={{ color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: muted ? "400" : "500" }}>{title}</Text>
      {via ? <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{via}</Text>
        : (!!s.word || !!s.line || !!s.lead) && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
        {s.word && s.group === "needs" ? <Text style={{ color, fontWeight: "600" }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>}
      {!!why && <PriorityLine reason={why.reason} source={why.source} c={c} size={11} lines={2} />}
      {touch && (s.pr || s.badges.length > 0) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {s.badges.map(b => <BadgeView key={b.text} b={b} c={c} />)}<PrChipView s={s} c={c} />
      </View>}
    </View> : <View style={{ flex: 1, minWidth: 0, gap: 1, paddingVertical: why ? 4 : 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {/* The title keeps its width (up to 55 %) and the chips yield; only beside Send now, which can't, does it shrink. */}
      <Text numberOfLines={1} style={{ flexShrink: sendNow ? 1 : 0, minWidth: 0, maxWidth: "55%", color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, fontWeight: muted ? "400" : "500" }}>{title}</Text>
      {/* A Needs-you row's word (Permission, Question…) is why it's there: it keeps its place, the chips yield first. */}
      {!via && s.word && s.group === "needs" ? <Text numberOfLines={1} style={{ flexShrink: 0, color, fontSize: 12 }}>{s.word}</Text> : null}
      {/* -10 takes back the row gap and the separator opens with a no-break space (a leading plain space is trimmed), so
          "Permission · Accept…" reads as one line, and the dot goes with the line when there's no room for it. */}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12, marginLeft: !via && s.word && s.group === "needs" ? -10 : 0 }}>
        {via ?? <>{s.word && s.group === "needs" && s.line ? "\u00a0· " : ""}{line}</>}
      </Text>
      <ChipRail s={s} c={c} dim={older} />
      {sendNow}
    </View>{!!why && <View style={{ paddingRight: 40 }}><PriorityLine reason={why.reason} source={why.source} c={c} /></View>}</View>}
    {!touch && <RowTime s={s} c={c} size={dense ? 11 : 12} />}
  </Pressable>;
}, (a, b) => a.sig === b.sig && a.selected === b.selected && a.theme === b.theme && a.dense === b.dense && a.touch === b.touch && a.onSelect === b.onSelect && a.onOpen === b.onOpen && a.onMenu === b.onMenu && a.menuOpen === b.menuOpen && a.hit === b.hit && a.onSendNow === b.onSendNow && a.selectedBg === b.selectedBg);

/** The machine-wide auto-send hold, once above Sending's rows: the same words on every width (shared/sending.ts). */
function HoldLine({ theme, text: line, dense, touch }: { theme: Theme; text: string; dense: boolean; touch: boolean }) {
  const c = theme.colors;
  return <View accessibilityRole="text" style={{ flexDirection: "row", alignItems: "flex-start", gap: touch ? 10 : 8, marginHorizontal: touch ? 14 : dense ? 8 : 16, marginVertical: 4, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 6, backgroundColor: withAlpha(c.statusWarning, 0.1) }}>
    <View style={{ paddingTop: 2 }}><Icon name="CirclePause" size={touch ? 15 : 13} color={c.statusWarning} /></View>
    <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: touch ? 13 : 12, lineHeight: touch ? 18 : 17 }}>{line}</Text>
  </View>;
}

/** Send now on a Sending row: the developer's Send, through the same path as the Tasks strip's. */
function SendNowButton({ s, theme, touch, onSendNow }: { s: Workstream; theme: Theme; touch: boolean; onSendNow: (s: Workstream) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const n = s.sendNow!.count;
  return <Button theme={theme} compact={touch} kind="secondary" title="Send now" accessibilityLabel={`Send ${s.sendNow!.what} to ${s.title} now`} loading={busy} disabled={busy}
    onPress={() => { setBusy(true); void onSendNow(s).finally(() => setBusy(false)); }} />;
}
