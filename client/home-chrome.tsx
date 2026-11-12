import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, ScrollView, TextInput, View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { GROUP_TITLE, homeCounts, type HomeGroupId, type HomeModel } from "../shared/home";
import { FIELD_LABEL, excerpt, highlightRuns, homeSearchDocs, indexDocs, defaultActive, omniboxResults, overseerProvider, workspaceProvider, type OmniboxItem, type OmniboxProvider, type Range, type WorkspaceItem } from "../shared/search";
import { DEFAULT_SORT, SORT_HINT, SORT_LABEL, SORT_MODES, type SortMode } from "../shared/sort";
import { priorityNote, PRIORITY_SOURCE_LABEL } from "../shared/priorities";
import { rankCost } from "../shared/ranker";
import { meters, meterText, type Meter } from "../shared/usage";
import { resourceMeter, type Resources } from "../shared/resources";
import type { HomeSources } from "./home-data";
import type { Workstream } from "../shared/home";
import { Age, glyphColor, PrChipView, PrSummaryText, quickActionsHint } from "./home-list";
import { useMinute } from "./home-data";
import { Spinner } from "./motion";
import { withAlpha, type Colors } from "./theme";
import type { Theme } from "./kit";
import { useRowMenuTrigger, type OpenRowMenu } from "./row-menu";
import { MenuItemContent, menuGlyph, menuItemRow } from "./menu-item";
import { useLinkedIndex } from "./linked";

/**
 * Home's chrome above the list (1.3.0-beta.2): the omnibox, the sort menu, the status strip and the provider
 * meters. It sits outside the scrolling list, so the status is visible without scrolling.
 */

// ---------- the omnibox ----------

export type Omnibox = {
  query: string;
  setQuery(q: string): void;
  /** null while the query is empty: the list shows its groups. */
  results: OmniboxItem[] | null;
  active: number;
  move(delta: number): void;
  inputRef: React.RefObject<TextInput | null>;
  /** The Overseer is on, so a query can also be an ask. */
  askOn: boolean;
};

/**
 * The search state for one list. The index is rebuilt only when Home's sources change, never per keystroke.
 * The Overseer's "Ask the Overseer: <query>" row comes last while the Overseer is on; `extraProviders` go between.
 */
export function useOmnibox(model: HomeModel, sources: HomeSources, extraProviders: readonly OmniboxProvider[] = []): Omnibox {
  const [query, setQueryState] = useState("");
  // null: the default row. -1: none, so Enter does nothing.
  const [active, setActive] = useState<number | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const live = useSyncExternalStore(sources.live.subscribe, sources.live.version, sources.live.version);
  const paseo = useSyncExternalStore(sources.paseo.subscribe, sources.paseo.version, sources.paseo.version);
  const extras = useSyncExternalStore(sources.extras.subscribe, sources.extras.version, sources.extras.version);
  const searching = query.trim().length > 0;
  const overseer = useSyncExternalStore(sources.extras.subscribe, sources.extras.overseer, sources.extras.overseer);
  const askOn = !!overseer?.enabled;
  // Linked keys and titles: fetched only while there's a query (client/linked.tsx explains why).
  const linked = useLinkedIndex(searching);
  // Built lazily: nothing is indexed until the developer types.
  const index = useMemo(() => searching ? indexDocs(homeSearchDocs({ model, paseo: sources.paseo.all(), tracked: sources.live.all(), archived: sources.live.archived(), agents: sources.extras.agents(), linked })) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, model, live, paseo, extras, linked]);
  const providers = useMemo(() => index ? [workspaceProvider(index), ...extraProviders, overseerProvider(askOn)] : [], [index, extraProviders, askOn]);
  const results = useMemo(() => searching ? omniboxResults(providers, query) : null, [providers, query, searching]);
  const setQuery = useCallback((q: string) => { setQueryState(q); setActive(null); }, []);
  const fallback = defaultActive(results);
  const current = active ?? fallback;
  const move = useCallback((delta: number) => setActive(a => Math.max(0, Math.min((results?.length ?? 1) - 1, (a ?? fallback) + delta))), [results, fallback]);
  // ⌘K "Follow-up: Search".
  const token = useSyncExternalStore(sources.extras.subscribe, sources.extras.focusToken, sources.extras.focusToken);
  const first = useRef(token);
  useEffect(() => { if (token !== first.current) inputRef.current?.focus(); }, [token]);
  return { query, setQuery, results, active: Math.min(current, Math.max(0, (results?.length ?? 1) - 1)), move, inputRef, askOn };
}

type DomKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown; preventDefault(): void };
/** `/` focuses the search while this surface is on screen (web and desktop; native has no global keys). */
export function useSlashToFocus(omnibox: Omnibox, enabled = true) {
  useEffect(() => {
    const doc = (globalThis as { document?: { addEventListener: (t: string, f: (e: DomKey) => void) => void; removeEventListener: (t: string, f: (e: DomKey) => void) => void } }).document;
    if (!enabled || !doc || Platform.OS !== "web") return;
    const onKey = (e: DomKey) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName ?? ""))) return;
      e.preventDefault();
      omnibox.inputRef.current?.focus();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [omnibox.inputRef, enabled]);
}

export function SearchField({ theme, omnibox, dense, onEnter }: { theme: Theme; omnibox: Omnibox; dense: boolean; onEnter: (item: OmniboxItem) => void }) {
  const c = theme.colors;
  const [focused, setFocused] = useState(false);
  const { query, setQuery, results, active, move, inputRef, askOn } = omnibox;
  const placeholder = askOn ? dense ? "Search or ask the Overseer" : "Search, or ask the Overseer" : "Search workspaces, branches, PRs";
  // `dense` is the phone layout: a 44px field with a rounder shape and body-size text.
  return <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: dense ? 8 : 6, height: dense ? 44 : 32, paddingHorizontal: dense ? 12 : 8, borderRadius: dense ? 12 : 6,
    borderWidth: 1, borderColor: focused ? withAlpha(c.foreground, 0.35) : c.border, backgroundColor: c.surface1 }}>
    <Icon name="Search" size={dense ? 16 : 13} color={c.foregroundMuted} />
    <TextInput ref={inputRef} value={query} onChangeText={setQuery} placeholder={placeholder} placeholderTextColor={c.foregroundMuted}
      accessibilityLabel={placeholder} autoCorrect={false} autoCapitalize="none" spellCheck={false} returnKeyType="go"
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onSubmitEditing={() => { const item = results?.[active]; if (item) onEnter(item); }}
      onKeyPress={e => {
        const key = (e.nativeEvent as { key?: string }).key;
        if (key === "ArrowDown") { e.preventDefault?.(); move(1); }
        else if (key === "ArrowUp") { e.preventDefault?.(); move(-1); }
        else if (key === "Escape") { if (query) setQuery(""); else inputRef.current?.blur(); }
      }}
      style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: dense ? 15 : 13, paddingVertical: 0, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
    {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={dense ? 14 : 8} onPress={() => { setQuery(""); inputRef.current?.focus(); }}>
      <Icon name="X" size={dense ? 16 : 13} color={c.foregroundMuted} />
    </Pressable>}
    {!query && !focused && !dense && Platform.OS === "web" && <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 4, borderRadius: 3, borderWidth: 1, borderColor: c.border }}>/</Text>}
  </View>;
}

// ---------- sort ----------

export type RankState = { enabled: boolean; running: boolean; healthLine: string; error: string | null; costUsd?: number | null; last?: { ok: boolean; skipped: string | null; provider: string | null } | null } | null;


export function SortMenu({ theme, mode, onChange, rankedAt, touch, rank = null, onRerank }: { theme: Theme; mode: SortMode; onChange: (m: SortMode) => void; rankedAt: string | null; touch: boolean; rank?: RankState; onRerank?: () => Promise<{ ok: boolean; skipped: string | null; error: string | null; top?: { title: string }[] }> }) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const now = useMinute();
  const toast = useToast();
  const running = !!rank?.running;
  const rerank = async () => {
    if (!onRerank || running) return;
    setOpen(false);
    try {
      const r = await onRerank();
      if (!r.ok) toast.error(r.error ?? "Couldn't re-rank.");
      else if (r.skipped === "busy") toast.show("Still ranking; Home updates when it's done");
      else toast.show(r.skipped === "same" ? "Nothing new in Linear, Slack, GitHub or the plan since the last ranking" : r.top?.[0] ? `Re-ranked · ${r.top[0].title} first` : "Re-ranked", { variant: "success" });
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  // "Ranked 12m ago · Slack unavailable": the age, then any source the last run couldn't read.
  // The footer keeps the standing ranking's age and cost while a new one runs; the menu item says "Ranking…".
  const note = [priorityNote(rankedAt, now), rankedAt && rank?.enabled ? rankCost(rank) : "", rank?.enabled ? rank.healthLine : ""].filter(Boolean).join(" · ");
  return <View style={{ position: "relative", zIndex: 20 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Sort: ${SORT_LABEL[mode]}${running ? ", ranking" : ""}`} aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => setOpen(o => !o)}
      style={state => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, height: touch ? 44 : 30, minWidth: touch ? 44 : undefined, paddingHorizontal: touch ? 0 : 8, borderRadius: touch ? 8 : 6, backgroundColor: open || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      {/* Phones: an icon; the mode's name lives in the menu (and the accessible name). */}
      {running ? <Spinner color={c.foreground} size={12} label="Ranking" /> : <Icon name="ArrowUpDown" size={touch ? 18 : 13} color={touch && mode !== DEFAULT_SORT ? c.foreground : c.foregroundMuted} />}
      {/* Phones: the icon carries no label, so a non-default sort shows as a dot on it. */}
      {touch && mode !== DEFAULT_SORT && <View style={{ position: "absolute", top: 9, right: 9, width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent }} />}
      {!touch && <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12 }}>{SORT_LABEL[mode]}</Text>}
      {!touch && <Icon name="ChevronDown" size={12} color={c.foregroundMuted} />}
    </Pressable>
    {open && <View accessibilityRole="menu" style={{ position: "absolute", top: touch ? 48 : 34, right: 0, minWidth: touch ? 240 : 220, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1,
      shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
      {SORT_MODES.map(m => <Pressable key={m} accessibilityRole="menuitem" accessibilityState={{ selected: m === mode }} onPress={() => { onChange(m); setOpen(false); }}
        style={state => ({ ...menuItemRow(touch), minHeight: touch ? 48 : 34, paddingHorizontal: touch ? 12 : 10, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
        <MenuItemContent theme={theme} touch={touch} glyph={m === mode ? "Check" : null} label={SORT_LABEL[m]} hint={SORT_HINT[m]} />
      </Pressable>)}
      <View style={{ marginTop: 4, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 2 }}>
        {rank?.enabled && onRerank && <Pressable accessibilityRole="menuitem" accessibilityState={{ busy: running, disabled: running }} disabled={running} onPress={() => void rerank()}
          style={state => ({ ...menuItemRow(touch), minHeight: touch ? 48 : 34, paddingHorizontal: touch ? 12 : 10, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
          <MenuItemContent theme={theme} touch={touch} glyph={running ? <Spinner color={c.foregroundMuted} size={menuGlyph(touch).size - 2} label="Ranking" /> : "RefreshCw"} label={running ? "Ranking…" : "Re-rank now"} muted={running} />
        </Pressable>}
        {/* Phones: before anything is ranked, "Priority: By urgency" only repeats the checked row's hint. */}
        {!(touch && !rankedAt) && <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 4 }}>Priority: {note}</Text>}
      </View>
    </View>}
  </View>;
}

// ---------- status strip ----------

const STRIP: { id: HomeGroupId; label: string }[] = [
  { id: "needs", label: "Needs you" }, { id: "fixing", label: "Fixing" }, { id: "running", label: "Running" }, { id: "waiting", label: "Waiting" }, { id: "quiet", label: "Quiet" },
];

/**
 * Counts for each group, always visible. A count filters the list to its group; the active one shows an × and
 * tapping it (or "All") goes back. Zero counts are muted, never hidden, so the line doesn't jump.
 */
export function StatusStrip({ theme, model, filter, onFilter, touch, dense }: { theme: Theme; model: HomeModel; filter: HomeGroupId | null; onFilter: (g: HomeGroupId | null) => void; touch: boolean; dense: boolean }) {
  const c = theme.colors;
  const counts = homeCounts(model);
  const chip = (key: string, label: string, n: number | null, selected: boolean, onPress: () => void, tone?: string) => {
    const muted = n === 0;
    const color = selected ? c.foreground : muted ? withAlpha(c.foregroundMuted, 0.6) : tone ?? c.foreground;
    const pill = (hovered?: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 5, height: touch ? 32 : 30, paddingHorizontal: touch ? 10 : 8, borderRadius: 16,
      borderWidth: 1, borderColor: selected ? withAlpha(c.foreground, 0.4) : "transparent",
      backgroundColor: selected ? c.surface2 : hovered ? c.surface1 : "transparent" });
    return <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={n === null ? label : `${label}, ${n}${selected ? ". Showing only these; press to show all" : ". Show only these"}`} onPress={onPress}
      // Phones: a 32-tall chip inside a real 44 touch box (react-native-web ignores hitSlop).
      style={touch ? { paddingVertical: 6 } : state => pill((state as { hovered?: boolean }).hovered)}>
      {state => {
        const inner = <>
          {n !== null && <Text style={{ color, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{n}</Text>}
          <Text style={{ color: selected ? c.foreground : muted ? withAlpha(c.foregroundMuted, 0.6) : c.foregroundMuted, fontSize: 12 }}>{label}</Text>
          {selected && <Icon name="X" size={11} color={c.foregroundMuted} />}
        </>;
        return touch ? <View style={pill((state as { hovered?: boolean }).hovered)}>{inner}</View> : inner;
      }}
    </Pressable>;
  };
  const chips = <>
    {STRIP.filter(s => !touch || counts[s.id] > 0 || filter === s.id).map(s => chip(s.id, s.label, counts[s.id], filter === s.id, () => onFilter(filter === s.id ? null : s.id), s.id === "needs" && counts.needs ? c.statusWarning : undefined))}
    {counts.later > 0 && chip("later", "Later", counts.later, filter === "later", () => onFilter(filter === "later" ? null : "later"))}
    {counts.archivable > 0 && <Text style={{ color: c.statusSuccess, fontSize: 12, paddingHorizontal: 6 }}>{counts.archivable} to archive</Text>}
  </>;
  // Phones: only groups that have something, on one line that scrolls sideways instead of wrapping.
  if (touch) return <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="toolbar" accessibilityLabel="Status"
    contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 2 }}>{chips}</ScrollView>;
  return <View accessibilityRole="toolbar" accessibilityLabel="Status" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: dense ? 0 : 2, rowGap: 2, paddingHorizontal: dense ? 4 : 10 }}>
    {chips}
  </View>;
}

// ---------- provider meters ----------

const toneColor = (m: Pick<Meter, "tone">, c: Colors) => m.tone === "danger" ? c.statusDanger : m.tone === "warning" ? c.statusWarning : c.foregroundMuted;

/** "Claude 5h 62% · 7d 41% · resets 14:10". Tap for each account. Nothing when Smart Session isn't there. */
export function UsageMeters({ theme, sources, dense }: { theme: Theme; sources: HomeSources; dense: boolean }) {
  const c = theme.colors;
  const usage = useSyncExternalStore(sources.extras.subscribe, sources.extras.usage, sources.extras.usage);
  const now = useMinute();
  const list = useMemo(() => meters(usage, Math.max(now, Date.now())), [usage, now]);
  const [open, setOpen] = useState<string | null>(null);
  const vm = usage.resources && resourceMeter(usage.resources, now) ? usage.resources : null;
  if (!list.length && !vm) return null;
  const detail = list.find(m => m.family === open);
  return <View style={{ paddingHorizontal: dense ? 8 : 16, gap: 4 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 2 }}>
      {vm && <VmMeter r={vm} c={c} now={Math.max(now, Date.now())} />}
      {list.map(m => <Pressable key={m.family} accessibilityRole="button" accessibilityLabel={`${meterText(m, now)}. ${m.accounts.length > 1 ? `${m.accounts.length} accounts; ` : ""}show detail`}
        aria-expanded={open === m.family} onPress={() => setOpen(o => o === m.family ? null : m.family)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 }}>
        <Bar pct={Math.max(...m.windows.map(w => w.pct))} color={toneColor(m, c)} c={c} />
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
          {meterText(m, now)}{m.accounts.length > 1 ? ` · ${m.accounts.length} accounts` : ""}
        </Text>
      </Pressable>)}
    </View>
    {detail && <View style={{ gap: 2, paddingLeft: 4, paddingBottom: 2 }}>
      {detail.accounts.map(a => <Text key={a.id} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        {`${a.name}${a.isDefault ? " (default)" : ""}: ${a.windows.map(w => `${w.label} ${w.pct}%`).join(" · ")}`}
      </Text>)}
    </View>}
  </View>;
}
/**
 * "Paseo memory 72% · CPU 40%", the resource governor's view. Text stays muted like the provider meters; the bar
 * and the "· paused" suffix take amber or red when Follow-up has held back its own work. Old readings dim.
 */
function VmMeter({ r, c, now }: { r: Resources; c: Colors; now: number }) {
  const m = resourceMeter(r, now);
  if (!m) return null;
  const color = toneColor(m, c);
  return <View accessibilityRole="text" accessibilityLabel={m.label} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22, opacity: m.stale ? 0.6 : 1 }}>
    <Bar pct={m.pct} color={color} c={c} />
    <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
      {m.text}{m.suffix ? <Text style={{ color: m.tone === "ok" ? c.foregroundMuted : color, fontWeight: "500" }}>{` ${m.suffix}`}</Text> : null}
    </Text>
  </View>;
}
function Bar({ pct, color, c }: { pct: number; color: string; c: Colors }) {
  return <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: c.border, overflow: "hidden" }}>
    <View style={{ width: `${Math.min(100, pct)}%`, height: 4, backgroundColor: color === c.foregroundMuted ? withAlpha(c.foreground, 0.45) : color }} />
  </View>;
}

// ---------- results ----------

export function Highlighted({ text, ranges, color, hit, mark, size, weight, lines = 1 }: { text: string; ranges: Range[]; color: string; hit: string; mark: string; size: number; weight?: "400" | "500" | "600"; lines?: number }) {
  return <Text numberOfLines={lines} style={{ color, fontSize: size, fontWeight: weight ?? "400" }}>
    {highlightRuns(text, ranges).map((r, i) => r.hit ? <Text key={i} style={{ color: hit, fontWeight: "600", backgroundColor: withAlpha(mark, 0.22), borderRadius: 2 }}>{r.text}</Text> : r.text)}
  </Text>;
}

/** The group as a small status chip on a search result. */
export function GroupChip({ group, c }: { group: HomeGroupId | "archived"; c: Colors }) {
  const label = group === "archived" ? "Archived" : group === "needs" ? "Needs you" : group === "fixing" ? "Fixing" : GROUP_TITLE[group];
  const color = group === "needs" ? c.statusWarning : group === "fixing" || group === "running" ? c.foreground : c.foregroundMuted;
  return <View style={{ paddingHorizontal: 6, height: 18, justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: c.border }}>
    <Text numberOfLines={1} style={{ color, fontSize: 10, lineHeight: 13 }}>{label}</Text>
  </View>;
}

export function ResultRow({ item, theme, active, dense, touch, onPress, s: row, onMenu }: { item: WorkspaceItem; theme: Theme; active: boolean; dense: boolean; touch: boolean; onPress: () => void; s?: Workstream; onMenu: OpenRowMenu }) {
  const c = theme.colors;
  const trigger = useRowMenuTrigger(row, onMenu, touch);
  const { hit } = item;
  const via = hit.via ? excerpt(hit.via.text, hit.via.ranges, dense ? 56 : 90) : null;
  const archived = hit.group === "archived";
  // Phones: the list's own row (glyph, two-line 15/20 title with the age, state word in tone, PRs as text, a divider),
  // with the match highlighted. No group pill: the state word already says it.
  if (touch) {
    const tone = row ? glyphColor(row, c, true) : c.foregroundMuted;
    return <Pressable ref={trigger.ref} onLongPress={trigger.onLongPress} delayLongPress={450} accessibilityHint={row ? quickActionsHint(touch) : undefined} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${hit.title}${row?.word ? `. ${row.word}` : ""}${hit.via ? `, ${FIELD_LABEL[hit.via.field]}: ${hit.via.text}` : ""}`} onPress={onPress}
      style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 56, paddingLeft: 14, paddingRight: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: withAlpha(c.border, 0.6),
        backgroundColor: active || state.pressed ? c.surface2 : "transparent" })}>
      <View style={{ paddingTop: 2 }}><Icon name={archived ? "Archive" : row?.icon ?? "Circle"} size={17} color={archived ? c.foregroundMuted : tone} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}><Highlighted text={hit.title} ranges={hit.titleRanges} color={archived ? c.foregroundMuted : c.foreground} hit={c.foreground} mark={c.statusWarning} size={15} weight="500" lines={2} /></View>
          {row && <Age iso={row.at} c={c} size={12} />}
        </View>
        {via ? <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{FIELD_LABEL[hit.via!.field]} · <Highlighted text={via.text} ranges={via.ranges} color={c.foregroundMuted} hit={c.foreground} mark={c.statusWarning} size={13} /></Text>
          : archived ? <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>Archived</Text>
          : row && (row.word || row.line) ? <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
            {row.word ? <Text style={{ color: tone, fontWeight: "600" }}>{row.word}</Text> : null}{row.word && row.line ? " · " : ""}{row.line}
          </Text> : null}
        {row?.pr && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}><PrSummaryText s={row} c={c} /></Text>}
      </View>
    </Pressable>;
  }
  return <Pressable ref={trigger.ref} onLongPress={trigger.onLongPress} delayLongPress={450} accessibilityHint={row ? quickActionsHint(touch) : undefined} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${hit.title}${hit.via ? `, ${FIELD_LABEL[hit.via.field]}: ${hit.via.text}` : ""}`} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 56 : dense ? 40 : 44, paddingHorizontal: dense ? 8 : 16, paddingVertical: 4,
      borderLeftWidth: 2, borderLeftColor: active ? withAlpha(c.foreground, 0.5) : "transparent",
      backgroundColor: active ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Highlighted text={hit.title} ranges={hit.titleRanges} color={archived ? c.foregroundMuted : c.foreground} hit={c.foreground} mark={c.statusWarning} size={13} weight="500" />
      {!via && row && (row.word || row.line) ? <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{[row.word, row.line].filter(Boolean).join(" · ")}</Text> : null}
      {via && <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{FIELD_LABEL[hit.via!.field]}</Text>
        <View style={{ flex: 1, minWidth: 0 }}><Highlighted text={via.text} ranges={via.ranges} color={c.foregroundMuted} hit={c.foreground} mark={c.statusWarning} size={12} /></View>
      </View>}
    </View>
    {row && !dense && <PrChipView s={row} c={c} />}
    <GroupChip group={hit.group} c={c} />
    {row && <Age iso={row.at} c={c} size={dense ? 11 : 12} />}
  </Pressable>;
}

/**
 * The omnibox's last row: the query as an ask for the Overseer. Enter (or a tap) sends it as typed; the Overseer
 * finds the agent that owns it. Quiet until it's the active row, so it never competes with real matches.
 */
export function AskRow({ ask, theme, active, dense, touch, sending, onPress }: { ask: string; theme: Theme; active: boolean; dense: boolean; touch: boolean; sending: boolean; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active, busy: sending }} accessibilityLabel={`Ask the Overseer: ${ask}`} accessibilityHint="Sends this to the Overseer, which passes it to the agent that owns it" disabled={sending} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 56 : dense ? 40 : 44, paddingHorizontal: dense ? 8 : 16, paddingVertical: 4,
      borderLeftWidth: 2, borderLeftColor: active ? withAlpha(c.foreground, 0.5) : "transparent",
      backgroundColor: active ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Text numberOfLines={dense ? 2 : 1} style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 }}>
      <Text style={{ color: c.foregroundMuted }}>Ask the Overseer: </Text>
      <Text style={{ color: c.foreground, fontWeight: "500" }}>{ask}</Text>
    </Text>
    {sending ? <Spinner color={c.foregroundMuted} size={12} label="Sending to the Overseer" />
      : active && Platform.OS === "web" && !touch ? <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 4, borderRadius: 3, borderWidth: 1, borderColor: withAlpha(c.foreground, 0.2) }}>↵</Text> : null}
    <Icon name="MessagesSquare" size={14} color={active ? c.foreground : c.foregroundMuted} />
  </Pressable>;
}

/** The muted reason and source chip a fresh external priority adds to a row. */
export function PriorityLine({ reason, source, c, size = 12, lines = 1 }: { reason: string; source: { kind: keyof typeof PRIORITY_SOURCE_LABEL; label: string } | null; c: Colors; size?: number; lines?: number }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
    {source && <View style={{ paddingHorizontal: 5, height: 16, justifyContent: "center", borderRadius: 3, backgroundColor: c.surface2 }}>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10, lineHeight: 13 }}>{PRIORITY_SOURCE_LABEL[source.kind]}</Text>
    </View>}
    <Text numberOfLines={lines} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: size, fontStyle: "italic" }}>{reason}</Text>
  </View>;
}

/** The non-scrolling top of a list: search + sort, then status, then meters. */
export function ListTop({ theme, dense, title, children }: { theme: Theme; dense: boolean; title?: ReactNode; children: ReactNode }) {
  const c = theme.colors;
  return <View style={{ zIndex: 10, gap: 6, paddingTop: dense ? 6 : 8, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 }}>
    {title}
    {children}
  </View>;
}
