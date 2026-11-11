import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon } from "@getpaseo/plugin/client/ui";
import { GROUP_TITLE, quietFolds, type Badge, type HomeGroupId, type HomeModel, type Workstream } from "../shared/home";
import { ASK_KEY, type OmniboxItem, type WorkspaceItem } from "../shared/search";
import { AskRow, PriorityLine, ResultRow } from "./home-chrome";
import { age, wakeLabel, wakeShort } from "../shared/inbox";
import { headlineColor, mergedColor, readable, runningColor, tint, toneColor, withAlpha, type Colors } from "./theme";
import { useMinute } from "./home-data";
import { Spinner } from "./motion";
import { rowDomId, type Theme } from "./kit";
import { RowMenu, useRowMenuTrigger, type OpenRowMenu, type RowMenuOpen } from "./row-menu";
import type { RowMenuItem, RowMenuSection } from "../shared/row-menu";

/**
 * The one list: Home's left side and (on hosts that have it) the sidebar
 * view. Virtualised; rows are memoised on their signature and ages tick on their own, so a minute tick or a poll
 * that changes one row redraws only that row.
 */

const QUIET_PAGE = 20;
export const BRIEF_KEY = "brief";
export const OVERSEER_KEY = "overseer";
/** The pinned Overseer row: not started yet (a one-time Start), working, asking, idle, or failed to come back. */
export type OverseerRowState = { state: "start" | "idle" | "running" | "asks" | "error"; line: string };

type Entry =
  | { type: "brief"; key: string }
  | { type: "overseer"; key: string }
  | { type: "header"; key: string; group: HomeGroupId; title: string; count: number; open: boolean }
  | { type: "row"; key: string; s: Workstream }
  | { type: "fold"; key: string; project: string; count: number; archivable: number; open: boolean }
  | { type: "more"; key: string; project: string; left: number }
  | { type: "result"; key: string; item: WorkspaceItem; index: number }
  | { type: "ask"; key: string; ask: string; index: number }
  | { type: "label"; key: string; text: string }
  | { type: "empty"; key: string }
  | { type: "slot"; key: string };

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
  /** Phones: the action under the "Nothing followed yet" empty state. */
  emptyAction?: ReactNode;
  /** While searching: one flat ranked list instead of the groups. */
  results?: OmniboxItem[] | null;
  activeResult?: number;
  onResult?: (item: OmniboxItem) => void;
  /** The status strip's filter: only this group, expanded. */
  filter?: HomeGroupId | null;
  /** The pinned Overseer row under the brief. Absent: the Overseer is off (or this surface has none). */
  overseer?: OverseerRowState | null;
  /** An omnibox ask is on its way to the Overseer. */
  asking?: boolean;
  /** The row menu (right-click, long-press, the menu key): what a row offers, and what a pick does. Absent: no menu. */
  menu?: { build: (s: Workstream) => RowMenuSection[]; pick: (s: Workstream, item: RowMenuItem) => void };
};

export function HomeList({ model, theme, dense = false, touch, selectedKey, onSelect, briefLine, renderExpanded, header, footer, top, afterNeeds, emptyAction, results, activeResult = 0, onResult, filter = null, overseer = null, asking = false, menu }: HomeListProps) {
  const c = theme.colors;
  const [openMenu, setOpenMenu] = useState<RowMenuOpen | null>(null);
  const build = menu?.build;
  const onMenu = useMemo<OpenRowMenu | undefined>(() => build ? (s, anchor, node, keyboard) => {
    const sections = build(s);
    if (sections.length) setOpenMenu({ s, anchor, sections, returnTo: node, keyboard });
  } : undefined, [build]);
  const menuKey = openMenu?.s.key ?? null;
  const [closed, setClosed] = useState<Set<string>>(new Set(["quiet"]));
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<Record<string, number>>({});
  const toggle = useCallback((key: string) => setClosed(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  const toggleProject = useCallback((p: string) => setOpenProjects(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; }), []);

  const data = useMemo(() => {
    const out: Entry[] = [];
    if (results) {
      // Search ignores the sort and the groups: ranked by match, archived ones last under their own label.
      let archivedShown = false;
      results.forEach((item, index) => {
        if (item.ask !== undefined) {
          // The ask row closes the list; with no match it follows the "no match" line.
          if (index === 0) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
          out.push({ type: "ask", key: item.key, ask: item.ask, index });
          return;
        }
        if (item.hit.group === "archived" && !archivedShown) { archivedShown = true; out.push({ type: "label", key: "l:archived", text: "Archived" }); }
        out.push({ type: "result", key: `r:${item.provider}:${item.key}`, item, index });
      });
      if (!results.length) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
      return out;
    }
    if (briefLine !== undefined && !filter) out.push({ type: "brief", key: BRIEF_KEY });
    if (overseer && !filter) out.push({ type: "overseer", key: OVERSEER_KEY });
    for (const g of model.groups) {
      if (filter && g.id !== filter) continue;
      const open = !!filter || !closed.has(g.id);
      // Phones with one group filtered: the chip above already says "N Needs you ×"; no header repeating it.
      if (!(touch && filter)) out.push({ type: "header", key: `h:${g.id}`, group: g.id, title: g.title, count: g.items.length, open });
      if (!open) { if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
      if (g.id !== "quiet") { for (const s of g.items) out.push({ type: "row", key: s.key, s }); if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
      for (const f of quietFolds(g.items)) {
        const fopen = openProjects.has(f.project);
        out.push({ type: "fold", key: `f:${f.project}`, project: f.project, count: f.items.length, archivable: f.archivable, open: fopen });
        if (!fopen) continue;
        const shown = (pages[f.project] ?? 1) * QUIET_PAGE;
        for (const s of f.items.slice(0, shown)) out.push({ type: "row", key: s.key, s });
        if (f.items.length > shown) out.push({ type: "more", key: `m:${f.project}`, project: f.project, left: f.items.length - shown });
      }
    }
    // Phones: nothing followed yet says so and what fills the list, instead of a blank screen under the pinned rows.
    if (touch && !filter && model.groups.every(g => !g.items.length)) out.push({ type: "empty", key: "l:nothing" });
    return out;
    if (filter && !out.length) out.push({ type: "label", key: "l:empty", text: `Nothing in ${GROUP_TITLE[filter as HomeGroupId]} right now.` });
    return out;
  }, [model, closed, openProjects, pages, briefLine, results, filter, !!overseer, touch, !!afterNeeds]);

  const render = useCallback(({ item }: { item: Entry }) => {
    switch (item.type) {
      case "label": return <Text accessibilityRole={item.key === "l:archived" ? "header" : undefined} style={{ color: c.foregroundMuted, fontSize: item.key === "l:archived" ? 11 : 13, fontWeight: item.key === "l:archived" ? "600" : "400",
        letterSpacing: item.key === "l:archived" ? 0.6 : 0, textTransform: item.key === "l:archived" ? "uppercase" : "none", paddingHorizontal: dense ? 8 : 16, paddingTop: 12, paddingBottom: 4 }}>{item.text}</Text>;
      case "empty": return <View accessibilityRole="summary" style={{ marginHorizontal: 16, marginTop: 20, gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, lineHeight: 23, fontWeight: "600" }}>Nothing followed yet</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 20 }}>Follow a workspace from its Follow-up panel, or turn a project on in Settings so its workspaces join on their own. They show up here once their agents work.</Text>
        {emptyAction ? <View style={{ flexDirection: "row", marginTop: 6 }}>{emptyAction}</View> : null}
      </View>;
      case "slot": return <View style={{ paddingVertical: 10 }}>{afterNeeds}</View>;
      case "result": return <ResultRow item={item.item} s={model.byKey.get(item.item.key)} theme={theme} active={item.index === activeResult || menuKey === item.item.key} dense={dense} touch={touch} onPress={() => onResult?.(item.item)} onMenu={onMenu} />;
      case "ask": return <AskRow ask={item.ask} theme={theme} active={item.index === activeResult} dense={dense} touch={touch} sending={!!asking} onPress={() => onResult?.({ provider: "overseer", key: ASK_KEY, ask: item.ask })} />;
      case "brief": return <BriefRow theme={theme} line={briefLine ?? ""} selected={!touch && (selectedKey === null || selectedKey === BRIEF_KEY)} touch={touch} onSelect={onSelect} />;
      case "overseer": return overseer ? <OverseerRow theme={theme} o={overseer} selected={selectedKey === OVERSEER_KEY} touch={touch} onSelect={onSelect} /> : null;
      case "header": return <GroupHeader theme={theme} title={item.title} count={item.count} open={item.open} tone={item.group === "needs" && item.count ? c.statusWarning : undefined} dense={dense} touch={touch} onPress={() => toggle(item.group)} />;
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
          <Row s={item.s} theme={theme} dense={dense} touch={touch} selected={selected} onSelect={onSelect} sig={item.s.sig} onMenu={onMenu} menuOpen={menuKey === item.key} />
          {selected && renderExpanded ? renderExpanded(item.s) : null}
        </View>;
      }
    }
  }, [theme, c, dense, touch, selectedKey, onSelect, briefLine, renderExpanded, toggle, toggleProject, activeResult, onResult, model, overseer?.state, overseer?.line, asking, afterNeeds, emptyAction, onMenu, menuKey]);

  const listRef = useRef<FlatList<Entry>>(null);
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
  const overlay = openMenu && menu ? <RowMenu key={`${openMenu.s.key}:${openMenu.anchor?.x ?? "sheet"}:${openMenu.anchor?.y ?? ""}`} menu={openMenu} theme={theme} onClose={() => setOpenMenu(null)} onPick={item => menu.pick(openMenu.s, item)} /> : null;
  // With a menu the wrapper is always there, so opening one never remounts the list (and its scroll).
  return top || menu ? <View style={{ flex: 1, minHeight: 0 }}>{top}{list}{overlay}</View> : list;
}

function GroupHeader({ theme, title, count, open, tone, dense, touch, onPress }: { theme: Theme; title: string; count: number; open: boolean; tone?: string; dense: boolean; touch: boolean; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}. ${open ? "Collapse" : "Expand"}`} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: touch ? 44 : dense ? 28 : 34, paddingHorizontal: touch ? 16 : dense ? 8 : 16, paddingTop: touch ? 8 : dense ? 4 : 8 }}>
    {dense && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={touch ? 14 : 12} color={c.foregroundMuted} />}
    {/* Phones: sentence case at 13, the section role; desktop keeps the small caps. */}
    <Text accessibilityRole="header" style={touch ? { color: tone ?? c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" } : { color: tone ?? c.foregroundMuted, fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>{touch ? title.charAt(0) + title.slice(1).toLowerCase() : title}</Text>
    <Text style={{ color: tone ?? c.foregroundMuted, fontSize: touch ? 13 : 11, lineHeight: touch ? 18 : 14, fontVariant: ["tabular-nums"] }}>{count}</Text>
    {!dense && !open && <Icon name="ChevronRight" size={12} color={c.foregroundMuted} />}
  </Pressable>;
}

function BriefRow({ theme, line, selected, touch, onSelect }: { theme: Theme; line: string; selected: boolean; touch: boolean; onSelect: (key: string) => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Morning brief. ${line}`} onPress={() => onSelect(BRIEF_KEY)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 52 : 40, paddingHorizontal: 16, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name="Sun" size={touch ? 16 : 15} color={c.foregroundMuted} />
    <Text style={{ color: c.foreground, fontSize: touch ? 14 : 13, fontWeight: "600" }}>Morning brief</Text>
    <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: touch ? 13 : 12 }}>{line}</Text>
    {touch && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
  </Pressable>;
}

function OverseerRow({ theme, o, selected, touch, onSelect }: { theme: Theme; o: OverseerRowState; selected: boolean; touch: boolean; onSelect: (key: string) => void }) {
  const c = theme.colors;
  const tone = o.state === "asks" ? c.statusWarning : o.state === "error" ? c.statusDanger : o.state === "running" ? runningColor(c) : c.foregroundMuted;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Overseer. ${o.line}`} onPress={() => onSelect(OVERSEER_KEY)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 52 : 40, paddingLeft: 14, paddingRight: 16, borderBottomWidth: 1, borderBottomColor: c.border,
      // Its ask isn't a Needs-you row (it's yours to route), so the edge marks it the way blocking rows are marked.
      borderLeftWidth: 2, borderLeftColor: o.state === "asks" || o.state === "error" ? withAlpha(tone, 0.9) : "transparent",
      backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    {o.state === "running" ? <Spinner color={tone} size={13} label="Overseer working" /> : <Icon name="MessagesSquare" size={touch ? 16 : 15} color={o.state === "idle" || o.state === "start" ? c.foregroundMuted : tone} />}
    <Text style={{ color: c.foreground, fontSize: touch ? 14 : 13, fontWeight: "600" }}>Overseer</Text>
    <Text numberOfLines={1} style={{ flex: 1, color: o.state === "asks" || o.state === "error" ? tone : c.foregroundMuted, fontSize: touch ? 13 : 12 }}>{touch && o.state === "start" ? "Ask about any workspace" : o.line}</Text>
    {touch && <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />}
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
  return <View style={{ paddingHorizontal: 6, height: 20, justifyContent: "center", borderRadius: 4, backgroundColor: b.tone === "muted" ? c.surface2 : tint(col, c) }}>
    <Text numberOfLines={1} style={{ color: col, fontSize: 11, lineHeight: 14, fontWeight: "500" }}>{b.text}</Text>
  </View>;
}

export function PrChipView({ s, c }: { s: Workstream; c: Colors }) {
  if (!s.pr) return null;
  const checks = s.pr.checks;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, height: 20, borderRadius: 4, borderWidth: 1, borderColor: c.border }}>
    <Icon name="GitPullRequest" size={11} color={toneColor(c, s.pr.tone)} />
    <Text style={{ color: c.foreground, fontSize: 11, lineHeight: 14, fontVariant: ["tabular-nums"] }}>{s.pr.label}</Text>
    {checks && <Text style={{ color: checks.tone === "muted" ? c.foregroundMuted : badgeColor({ text: "", tone: checks.tone }, c), fontSize: 11, lineHeight: 14 }}>{checks.text}</Text>}
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
  return s.group === "later" && s.wakeAt ? <WakeTime until={s.wakeAt} c={c} size={size} /> : <Age iso={s.at} c={c} size={size} />;
}

/** The age on the right. It re-renders on the shared minute clock without touching its row. */
export function Age({ iso, c, size = 12 }: { iso: string | null; c: Colors; size?: number }) {
  const now = useMinute();
  const text = age(iso, Math.max(now, Date.now()));
  return text ? <Text style={{ color: c.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums"], minWidth: 26, textAlign: "right" }}>{text}</Text> : null;
}

type RowProps = { s: Workstream; sig: string; theme: Theme; dense: boolean; touch: boolean; selected: boolean; onSelect: (key: string) => void; onMenu?: OpenRowMenu; menuOpen?: boolean };
const Row = memo(function Row({ s, theme, dense, touch, selected, onSelect, onMenu, menuOpen = false }: RowProps) {
  const c = theme.colors;
  const trigger = useRowMenuTrigger(s, onMenu, touch);
  const color = glyphColor(s, c, touch);
  const blocking = s.group === "needs" && s.tier === 0;
  const muted = s.group === "quiet" || s.group === "later";
  const line = [s.word && s.group !== "needs" ? s.word : null, s.line].filter(Boolean).join(" · ");
  // Phones: "Working" under every row of a "Running 9" group says nothing the header didn't; one line per row instead.
  const generic = touch && !s.word && (s.line === "Working" || s.line === "Fixing");
  // A Later row says when it comes back on screen; the label also keeps how long it has waited.
  const wake = s.group === "later" && s.wakeAt ? wakeLabel({ until: s.wakeAt, at: s.at ?? new Date().toISOString() }, Date.now()) : "";
  const waited = s.group === "later" && s.at ? age(s.at, Date.now()) : "";
  const label = [s.title + (s.agent ? ` › ${s.agent}` : ""), s.word, s.line, wake && `Later until ${wake}`, waited && (waited === "now" ? "just now" : `waiting ${waited}`)].filter(Boolean).join(". ");
  return <Pressable ref={trigger.ref} nativeID={rowDomId(s.key)} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={label} accessibilityHint={onMenu ? quickActionsHint(touch) : undefined}
    onPress={() => onSelect(s.key)} onLongPress={trigger.onLongPress} delayLongPress={450}
    style={state => ({ flexDirection: "row", alignItems: dense ? "flex-start" : "center", gap: touch ? 10 : dense ? 8 : 10, minHeight: touch ? 56 : dense ? 36 : 38, paddingLeft: touch ? 14 : dense ? 8 : 16, paddingRight: touch ? 16 : dense ? 8 : 16, paddingVertical: touch ? 12 : dense ? 6 : 0,
      ...(touch ? { borderBottomWidth: 1, borderBottomColor: withAlpha(c.border, 0.6) } : {}),
      borderLeftWidth: 2, borderLeftColor: blocking ? withAlpha(color, 0.9) : "transparent",
      backgroundColor: selected || menuOpen || state.pressed && touch ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: touch ? 18 : 16, alignItems: "center", paddingTop: touch ? 2 : dense ? 1 : 0 }}>
      {s.tone === "running" && s.icon === "LoaderCircle" ? <Spinner color={color} size={13} label="Running" /> : <Icon name={s.icon} size={touch ? 17 : 15} color={color} />}
    </View>
    {/* Phones: title 15/20 over two lines, then state · reason, then the PRs as plain text (no bordered chips). */}
    {touch ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: muted ? c.foregroundMuted : c.foreground, fontSize: 15, lineHeight: 20, fontWeight: muted ? "400" : "500" }}>{s.title}</Text>
        <View style={{ paddingTop: 2 }}><RowTime s={s} c={c} size={12} /></View>
      </View>
      {(!!s.word || !!s.line) && !generic && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
        {s.word && s.group === "needs" ? <Text style={{ color, fontWeight: "600" }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>}
      {!!s.priority?.reason && <PriorityLine reason={s.priority.reason} source={s.priority.source} c={c} size={12} lines={2} />}
      {!!s.pr && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] }}><PrSummaryText s={s} c={c} /></Text>}
    </View> : dense ? <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={1} style={{ color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: muted ? "400" : "500" }}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted }}>{` › ${s.agent}`}</Text> : null}</Text>
      {(!!s.word || !!s.line) && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
        {s.word && s.group === "needs" ? <Text style={{ color, fontWeight: "600" }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>}
      {!!s.priority?.reason && <PriorityLine reason={s.priority.reason} source={s.priority.source} c={c} size={11} lines={2} />}
      {touch && (s.pr || s.badges.length > 0) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {s.badges.map(b => <BadgeView key={b.text} b={b} c={c} />)}<PrChipView s={s} c={c} />
      </View>}
    </View> : <View style={{ flex: 1, minWidth: 0, gap: 1, paddingVertical: s.priority?.reason ? 4 : 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "55%", color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, fontWeight: muted ? "400" : "500" }}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12 }}>
        {s.word && s.group === "needs" ? <Text style={{ color }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>
      {s.badges.map(b => <BadgeView key={b.text} b={b} c={c} />)}
      <PrChipView s={s} c={c} />
    </View>{!!s.priority?.reason && <View style={{ paddingRight: 40 }}><PriorityLine reason={s.priority.reason} source={s.priority.source} c={c} /></View>}</View>}
    {!touch && <RowTime s={s} c={c} size={dense ? 11 : 12} />}
  </Pressable>;
}, (a, b) => a.sig === b.sig && a.selected === b.selected && a.theme === b.theme && a.dense === b.dense && a.touch === b.touch && a.onSelect === b.onSelect && a.onMenu === b.onMenu && a.menuOpen === b.menuOpen);
