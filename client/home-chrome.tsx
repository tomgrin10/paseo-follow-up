import { FloatingSurface } from "./floating-surface";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View, type TextInput } from "react-native";
import { AttachImageButton, ImageField, useImageAttachments, type ImageAttachments } from "./image-attach";
import { OVERSEER_ASK_KEY } from "./unsent-images";
import { Pressable, Text } from "./text";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { homeCounts, type HomeGroupId, type HomeModel } from "../shared/home";
import { layoutHint, filterHome, homeSearchDocs, indexDocs, defaultActive, omniboxResults, overseerProvider, workspaceProvider, type OmniboxItem, type OmniboxProvider } from "../shared/search";
import { LayoutCapture, type LayoutKey } from "../shared/layout-swap";
import { DEFAULT_SORT, isMenuSort, MENU_SORTS, SORT_HINT, SORT_LABEL, type SortMode } from "../shared/sort";
import { GROUPING_LABEL, GROUPINGS, homeViewFiltered, SHOW_ITEMS, SHOW_LABEL, TITLE_LABEL, TITLE_SOURCES, type HomeView } from "../shared/home-arrange";
import { PRIORITY_SOURCE_LABEL } from "../shared/priorities";
import { rankFooter } from "../shared/ranker";
import { meters, meterText, type Meter } from "../shared/usage";
import { resourceMeter, type Resources } from "../shared/resources";
import type { HomeSources } from "./home-data";
import { useMinute } from "./home-data";
import { Spinner } from "./motion";
import { withAlpha, type Colors } from "./theme";
import { text, type Theme } from "./kit";
import { MenuItemContent, menuGlyph, menuItemRow } from "./menu-item";
import { useSearchFocusField } from "./search-focus";
import { useLinkedIndex } from "./linked";
import { Field } from "./field";

/**
 * Home's chrome above the list (1.3.0-beta.2): the omnibox, the sort menu, the status strip and the provider
 * meters. It sits outside the scrolling list, so the status is visible without scrolling.
 */

// ---------- the omnibox ----------

export type Omnibox = {
  query: string;
  setQuery(q: string): void;
  setPhysical?: (q: string | null) => void;
  layoutHint?: string | null;
  /** null while the query is empty: the list shows its groups. */
  results: OmniboxItem[] | null;
  active: number;
  move(delta: number): void;
  inputRef: React.RefObject<TextInput | null>;
  /** The search field's onLayout: a waiting search request tries again when the field comes on screen. */
  onSearchLayout: () => void;
  /**
   * Asks for the caret in the search (every-search-request-lands-in-the-visible-search), only when a Home search is on
   * screen: true when it asked. A Home kept mounted behind another screen asks nothing.
   */
  focusSearch(): boolean;
  /** The Overseer is on, so a query can also be an ask. */
  askOn: boolean;
  /** Images pasted or dropped on the search while the Overseer is on: they go with the ask (every-agent-field-takes-images). */
  images: ImageAttachments;
};

/**
 * The search state for one list. The index is rebuilt only when Home's sources change, never per keystroke.
 * The Overseer's "Ask the Overseer: <query>" row comes last while the Overseer is on; `extraProviders` go between.
 */
export function useOmnibox(model: HomeModel, sources: HomeSources, extraProviders: readonly OmniboxProvider[] = []): Omnibox {
  const [query, setQueryState] = useState("");
  const [physical, setPhysical] = useState<string | null>(null);
  // null: the default row. -1: none, so Enter does nothing.
  const [active, setActive] = useState<number | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const live = useSyncExternalStore(sources.live.subscribe, sources.live.version, sources.live.version);
  const paseo = useSyncExternalStore(sources.paseo.subscribe, sources.paseo.version, sources.paseo.version);
  const extras = useSyncExternalStore(sources.extras.subscribe, sources.extras.version, sources.extras.version);
  const searching = query.trim().length > 0;
  const overseer = useSyncExternalStore(sources.extras.subscribe, sources.extras.overseer, sources.extras.overseer);
  const askOn = !!overseer?.enabled;
  // An ask Paseo hasn't taken yet keeps its images under OVERSEER_ASK_KEY (client/unsent-images.ts).
  const images = useImageAttachments({ target: askOn ? { kind: "overseer" } : null, keep: OVERSEER_ASK_KEY });
  // Linked keys and titles: fetched only while there's a query (client/linked.tsx explains why).
  const linked = useLinkedIndex(searching);
  // Built lazily: nothing is indexed until the developer types.
  const index = useMemo(() => searching ? indexDocs(homeSearchDocs({ model, paseo: sources.paseo.all(), tracked: sources.live.all(), archived: sources.live.archived(), agents: sources.extras.agents(), linked })) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, model, live, paseo, extras, linked]);
  const providers = useMemo(() => index ? [workspaceProvider(index, Date.now(), physical), ...extraProviders, overseerProvider(askOn)] : [], [index, extraProviders, askOn, physical]);
  const results = useMemo(() => searching ? omniboxResults(providers, query) : null, [providers, query, searching]);
  const setQuery = useCallback((q: string) => { setQueryState(q); setActive(null); }, []);
  const fallback = defaultActive(results);
  const current = active ?? fallback;
  const move = useCallback((delta: number) => setActive(a => Math.max(0, Math.min((results?.length ?? 1) - 1, (a ?? fallback) + delta))), [results, fallback]);
  // every-search-request-lands-in-the-visible-search: this field takes a search request (the key, ⌘K, `/`) while it is
  // the one on screen, on mount, on layout, or when focus moves without the developer (client/search-focus.ts); what
  // the developer typed before it landed becomes the query.
  const onSearchLayout = useSearchFocusField(sources.extras.searchFocus, inputRef, setQuery);
  const focusSearch = useCallback(() => { const f = sources.extras.searchFocus; if (!f.shown()) return false; f.request(); return true; }, [sources.extras.searchFocus]);
  const hint = layoutHint((results ?? []).flatMap(r => r.hit ? [r.hit] : []));
  return { query, setQuery, setPhysical, layoutHint: hint, results, active: Math.min(current, Math.max(0, (results?.length ?? 1) - 1)), move, inputRef, onSearchLayout, focusSearch, askOn, images };
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
      // The one owner of search focus: only the Home search on screen takes it, so a Home kept mounted behind
      // another screen neither swallows the key nor focuses a hidden field.
      if (omnibox.focusSearch()) e.preventDefault();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [omnibox.focusSearch, enabled]);
}

/**
 * The one query field: Home's omnibox (SearchField) and the sidebar view's filter (FilterField) are this with
 * different words. `dense` is the phone layout: a 44px field with a rounder shape and body-size text.
 */
export function QueryField({ theme, value, onChange, placeholder, icon, dense, inputRef, slashHint, slashTitle, onSubmit, onArrow, listKeys = false, count, autoFocus = false, onEscape, onLayoutQuery, trailing, onLayout }: {
  /** The field's own layout (Home's search: a waiting search request tries again). */
  onLayout?: () => void;
  /** A control at the field's end, before its ✕ (Home's search asking the Overseer: Add image). */
  trailing?: ReactNode;
  /** Its arrows step into the list below (client/list-keys.ts): the sidebar filter, and Home's search while empty. */
  listKeys?: boolean;
  onLayoutQuery?: (q: string | null) => void;
  /** "2 of 12" at the field's end (a panel section's search), in place of the field's own ✕: the section has its own. */
  count?: string;
  autoFocus?: boolean;
  /** Esc's own action (a section search closes); without it Esc clears, then leaves the field. */
  onEscape?: () => void;
  theme: Theme; value: string; onChange: (q: string) => void; placeholder: string; icon: string; dense: boolean;
  /** The key chip at the field's end (web, desktop width): "/" or the search-from-anywhere key; false for none. */
  /** The chip's hover title (web): what each key does. */
  slashTitle?: string;
  inputRef: { current: TextInput | null }; slashHint: string | false; onSubmit?: () => void; onArrow?: (delta: number) => void;
}) {
  const c = theme.colors;
  const [focused, setFocused] = useState(false);
  const capture = useRef(new LayoutCapture());
  const layoutCallback = useRef(onLayoutQuery); layoutCallback.current = onLayoutQuery;
  useEffect(() => {
    if (Platform.OS !== "web" || !onLayoutQuery) return;
    type Input = { value: string; selectionStart: number | null; selectionEnd: number | null };
    type InputEvent = LayoutKey & { target: unknown };
    type Listen = (name: string, listener: (e: InputEvent) => void, capture: boolean) => void;
    const doc = (globalThis as unknown as { document?: { addEventListener: Listen; removeEventListener: Listen } }).document;
    if (!doc) return;
    const belongs = (e: InputEvent) => e.target === inputRef.current;
    const key = (e: InputEvent) => {
      if (!belongs(e)) return;
      const input = e.target as Input;
      capture.current.key(e, input.value, input.selectionStart, input.selectionEnd);
    };
    const reset = (e: InputEvent) => { if (belongs(e)) { capture.current.reset(); layoutCallback.current?.(null); } };
    doc.addEventListener("keydown", key, true);
    const resets = ["paste", "cut", "drop", "compositionstart", "compositionend", "select"];
    for (const event of resets) doc.addEventListener(event, reset, true);
    return () => { doc.removeEventListener("keydown", key, true); for (const event of resets) doc.removeEventListener(event, reset, true); };
  }, [inputRef, !!onLayoutQuery]);
  return <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: dense ? 8 : 6, height: dense ? 44 : 32, paddingHorizontal: dense ? 12 : 8, borderRadius: dense ? 12 : 6,
    borderWidth: 1, borderColor: focused ? withAlpha(c.foreground, 0.35) : c.border, backgroundColor: c.surface1 }}>
    <Icon name={icon as never} size={dense ? 16 : 13} color={c.foregroundMuted} />
    <Field ref={inputRef} onLayout={onLayout} value={value} onChangeText={q => { onLayoutQuery?.(capture.current.change(q)); onChange(q); }} placeholder={placeholder} placeholderTextColor={c.foregroundMuted}
      accessibilityLabel={placeholder} autoFocus={autoFocus} autoCorrect={false} autoCapitalize="none" spellCheck={false} returnKeyType="go"
      {...(listKeys || onLayout ? { dataSet: { ...(listKeys ? { listKeys: "1" } : {}), ...(onLayout ? { followUpSearch: "1" } : {}) } } as object : {})}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onSubmitEditing={onSubmit}
      // A single-line field blurs on submit by default, which dropped focus on the page after a search pick while the
      // results stayed up, so the second Enter reached nothing (the-selected-workspace-opens-with-enter).
      blurOnSubmit={false}
      onKeyPress={e => {
        const key = (e.nativeEvent as { key?: string }).key;
        if (key === "ArrowDown" && onArrow) { e.preventDefault?.(); onArrow(1); }
        else if (key === "ArrowUp" && onArrow) { e.preventDefault?.(); onArrow(-1); }
        else if (key === "Escape") { if (onEscape) onEscape(); else if (value) onChange(""); else inputRef.current?.blur(); }
      }}
      style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: dense ? 15 : 13, paddingVertical: 0, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
    {trailing}
    {count !== undefined ? !!count && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: dense ? 13 : 12, fontVariant: ["tabular-nums"] }}>{count}</Text>
      : !!value && <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${placeholder.toLowerCase()}`} hitSlop={dense ? 14 : 8} onPress={() => { onChange(""); inputRef.current?.focus(); }}>
      <Icon name="X" size={dense ? 16 : 13} color={c.foregroundMuted} />
    </Pressable>}
    {slashHint && !value && !focused && !dense && Platform.OS === "web" && <Text accessibilityElementsHidden importantForAccessibility="no"
      // React Native Web drops title props on Text; keep the existing chip's DOM title current directly.
      ref={node => { (node as unknown as { setAttribute?: (key: string, value: string) => void } | null)?.setAttribute?.("title", slashTitle ?? ""); }} style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 4, borderRadius: 3, borderWidth: 1, borderColor: c.border, fontVariant: ["tabular-nums"] }}>{slashHint}</Text>}
  </View>;
}

/**
 * Home's search. Its chip names the search-from-anywhere key when one is set (it works here too), else "/"; plain "/"
 * focuses it on Home either way (useSlashToFocus).
 */
/** `onEnter`: the active result, or null when the query is empty (Home then opens its selection). */
export function SearchField({ theme, omnibox, dense, onEnter, anywhereKey }: { theme: Theme; omnibox: Omnibox; dense: boolean; onEnter: (item: OmniboxItem | null) => void; anywhereKey?: string | null }) {
  const { query, setQuery, results, active, move, inputRef, askOn } = omnibox;
  const placeholder = askOn ? dense ? "Search or ask the Overseer" : "Search, or ask the Overseer" : "Search workspaces, branches, PRs";
  // The bar stays one line: a paste or drop lands here, and Home draws the thumbnails on their own line under it.
  if (askOn) return <ImageField model={omnibox.images} theme={theme} compact={dense} row={false} attach="inline" style={{ flex: 1, minWidth: 0 }}><QueryField theme={theme} onLayoutQuery={omnibox.setPhysical} value={query} onChange={setQuery} placeholder={placeholder} icon="Search" dense={dense} inputRef={inputRef} onLayout={omnibox.onSearchLayout} slashHint={anywhereKey || "/"}
    trailing={<AttachImageButton model={omnibox.images} theme={theme} compact={dense} label="Add image for the Overseer" />}
    slashTitle={anywhereKey ? `${anywhereKey} from anywhere · / on Home` : "/ focuses the search"}
    onSubmit={() => { const item = results?.[active]; if (item || !query.trim()) onEnter(item ?? null); }} onArrow={move} listKeys={!query.trim()} /></ImageField>;
  return <QueryField theme={theme} onLayoutQuery={omnibox.setPhysical} value={query} onChange={setQuery} placeholder={placeholder} icon="Search" dense={dense} inputRef={inputRef} onLayout={omnibox.onSearchLayout} slashHint={anywhereKey || "/"}
    slashTitle={anywhereKey ? `${anywhereKey} from anywhere · / on Home` : "/ focuses the search"}
    onSubmit={() => { const item = results?.[active]; if (item || !query.trim()) onEnter(item ?? null); }} onArrow={move} listKeys={!query.trim()} />;
}

/**
 * The sidebar view's filter (2.1): narrows the list in place with Home search's matcher (shared/search.ts
 * `filterHome`), keeping groups and the chosen order. Archived workspaces stay out; Home's search finds those.
 */
export type ListFilter = { setPhysical?: (q: string | null) => void; layoutHint?: string | null; query: string; setQuery: (q: string) => void; model: HomeModel; hits: ReturnType<typeof filterHome>["hits"]; inputRef: { current: TextInput | null } };
export function useListFilter(model: HomeModel, sources: HomeSources): ListFilter {
  const [physical, setPhysical] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInput | null>(null);
  const live = useSyncExternalStore(sources.live.subscribe, sources.live.version, sources.live.version);
  const paseo = useSyncExternalStore(sources.paseo.subscribe, sources.paseo.version, sources.paseo.version);
  const extras = useSyncExternalStore(sources.extras.subscribe, sources.extras.version, sources.extras.version);
  const searching = query.trim().length > 0;
  const linked = useLinkedIndex(searching);
  // The same documents Home's search indexes, minus archived ones; built only while there's a query.
  const index = useMemo(() => searching ? indexDocs(homeSearchDocs({ model, paseo: sources.paseo.all(), tracked: sources.live.all(), agents: sources.extras.agents(), linked })) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, model, live, paseo, extras, linked]);
  const filtered = useMemo(() => index ? filterHome(model, index, query, Date.now(), physical) : { model, hits: null }, [index, model, query, physical]);
  return { query, setQuery, setPhysical, layoutHint: layoutHint([...(filtered.hits?.values() ?? [])]), model: filtered.model, hits: filtered.hits, inputRef };
}
/** "Filter workspaces": a filter icon and no key binding, so it never reads as Paseo's own Search (the Command Center, ⌘K). */
export function FilterField({ theme, filter, dense }: { theme: Theme; filter: ListFilter; dense: boolean }) {
  return <QueryField theme={theme} onLayoutQuery={filter.setPhysical} value={filter.query} onChange={filter.setQuery} placeholder="Filter workspaces" icon="ListFilter" dense={dense} inputRef={filter.inputRef} slashHint={false} listKeys />;
}

/** Kept outside the textbox: never changes the query or adds a decision to the search flow. */
export function LayoutNotice({ theme, query, dense }: { theme: Theme; query?: string | null; dense: boolean }) {
  return <Text accessibilityLiveRegion="polite" numberOfLines={2} style={{ ...text(theme.colors, dense).meta, ...(query ? { paddingTop: 4 } : { height: 0 }) }}>{query ? `Showing results for “\u2068${query}\u2069”` : ""}</Text>;
}

// ---------- display (sort, grouping, filters) ----------

export type RankState = { enabled: boolean; running: boolean; healthLine: string; error: string | null; costUsd?: number | null; last?: { ok: boolean; skipped: string | null; provider: string | null } | null } | null;


type Rerank = () => Promise<{ ok: boolean; skipped: string | null; error: string | null; top?: { title: string }[] }>;
type DisplayPage = "root" | "grouping" | "sort" | "title" | "show" | "projects" | "labels";

/**
 * Home's and the sidebar view's Display menu: Paseo's sidebar options button and menu shape (one row per decision with
 * its current value, its options a page down), over the one setting both lists share (`home_sort` + `home_view`,
 * shared/home-arrange.ts). Sort keeps Follow-up's orders with Re-rank now and the ranking's age; Project and Labels
 * filter, and appear once there is something to filter by (or a filter is on). A filter on shows as a dot.
 */
export function DisplayMenu({ theme, mode, onSort, view, onView, projects, labels, rankedAt, touch, rank = null, onRerank }: { theme: Theme; mode: SortMode; onSort: (m: SortMode) => void;
  view: HomeView; onView: (patch: Partial<HomeView>) => void; projects: readonly string[]; labels: readonly string[]; rankedAt: string | null; touch: boolean; rank?: RankState; onRerank?: Rerank }) {
  const c = theme.colors;
  const [page, setPage] = useState<DisplayPage | null>(null);
  const now = useMinute();
  const toast = useToast();
  const running = !!rank?.running;
  const close = () => setPage(null);
  const rerank = async () => {
    if (!onRerank || running) return;
    close();
    try {
      const r = await onRerank();
      if (!r.ok) toast.error(r.error ?? "Couldn't re-rank.");
      else if (r.skipped === "busy") toast.show("Still ranking; Home updates when it's done");
      else toast.show(r.skipped === "same" ? "Nothing new in Linear, Slack, GitHub or the plan since the last ranking" : r.top?.[0] ? `Re-ranked · ${r.top[0].title} first` : "Re-ranked", { variant: "success" });
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  // "Ranked 12m ago": only when the ranking last ran (and a failed run's reason); never its cost.
  const note = rankFooter({ rankedAt, now, rank });
  const filtered = homeViewFiltered(view);
  const sort = isMenuSort(mode) ? mode : DEFAULT_SORT;
  const item = (key: string, label: string, onPress: () => void, opts: { glyph?: string | ReactNode | null; hint?: string | null; value?: string | null; next?: boolean; selected?: boolean; disabled?: boolean; muted?: boolean } = {}) =>
    <Pressable key={key} accessibilityRole="menuitem" accessibilityState={{ selected: opts.selected, disabled: opts.disabled }} disabled={opts.disabled} onPress={onPress}
      style={state => ({ ...menuItemRow(touch), minHeight: touch ? 48 : 34, paddingHorizontal: touch ? 12 : 10, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      <MenuItemContent theme={theme} touch={touch} glyph={opts.glyph ?? null} label={label} hint={opts.hint} muted={opts.muted} quietGlyph={!!opts.next || key === "background"}
        trailing={opts.value !== undefined || opts.next ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0, maxWidth: "55%" }}>
          {!!opts.value && <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: touch ? 14 : 12 }}>{opts.value}</Text>}
          {opts.next && <Icon name="ChevronRight" size={touch ? 16 : 13} color={c.foregroundMuted} />}
        </View> : undefined} />
    </Pressable>;
  const sep = (key: string) => <View key={key} style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />;
  const back = (title: string) => <Pressable key="back" accessibilityRole="menuitem" accessibilityLabel={`Back from ${title}`} onPress={() => setPage("root")}
    style={state => ({ ...menuItemRow(touch), minHeight: touch ? 44 : 30, paddingHorizontal: touch ? 12 : 10, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
    <MenuItemContent theme={theme} touch={touch} glyph="ChevronLeft" quietGlyph label={title} muted />
  </Pressable>;
  const choose = <T extends string>(key: string, current: readonly T[] | T, value: T, label: string, set: () => void, hint?: string) =>
    item(key, label, set, { glyph: (Array.isArray(current) ? current.includes(value) : current === value) ? "Check" : null, hint, selected: Array.isArray(current) ? current.includes(value) : current === value });
  const toggleIn = (list: readonly string[], v: string) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];
  const filterValue = (list: readonly string[], all: string) => !list.length ? all : list.length === 1 ? list[0]! : `${list.length} selected`;
  const showProjects = projects.length > 1 || view.projects.length > 0;
  const showLabels = labels.length > 0 || view.labels.length > 0;
  const shown = SHOW_ITEMS.filter(k => view.show[k]).map(k => SHOW_LABEL[k]);
  let body: ReactNode;
  switch (page) {
    case "grouping": body = <>{back("Grouping")}{GROUPINGS.map(g => choose(g, view.grouping, g, GROUPING_LABEL[g], () => { onView({ grouping: g }); close(); }))}</>; break;
    case "sort": body = <>{back("Sort")}{MENU_SORTS.map(m => choose(m, sort, m, SORT_LABEL[m], () => { onSort(m); close(); }, SORT_HINT[m]))}
      {(rank?.enabled && onRerank || note) && sep("s1")}
      {rank?.enabled && onRerank && item("rerank", running ? "Ranking…" : "Re-rank now", () => void rerank(), { glyph: running ? <Spinner color={c.foregroundMuted} size={menuGlyph(touch).size - 2} label="Ranking" /> : "RefreshCw", disabled: running, muted: running })}
      {note && <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: touch ? 12 : 10, paddingTop: 4, paddingBottom: 6 }}>{note}</Text>}</>; break;
    case "title": body = <>{back("Title")}{TITLE_SOURCES.map(t => choose(t, view.title, t, TITLE_LABEL[t], () => { onView({ title: t }); close(); }))}</>; break;
    // Show's items toggle in place: the menu stays open so several can change at once.
    case "show": body = <>{back("Show")}{SHOW_ITEMS.map(k => item(k, SHOW_LABEL[k], () => onView({ show: { ...view.show, [k]: !view.show[k] } }), { glyph: view.show[k] ? "Check" : null, selected: view.show[k] }))}</>; break;
    case "projects": body = <>{back("Project")}{item("all", "All projects", () => onView({ projects: [] }), { glyph: view.projects.length ? null : "Check", selected: !view.projects.length })}{sep("p1")}
      <ScrollView style={{ maxHeight: touch ? 360 : 280 }}>{[...new Set([...projects, ...view.projects])].map(p => choose(`p:${p}`, view.projects, p, p, () => onView({ projects: toggleIn(view.projects, p) })))}</ScrollView></>; break;
    case "labels": body = <>{back("Labels")}{item("all", "All labels", () => onView({ labels: [] }), { glyph: view.labels.length ? null : "Check", selected: !view.labels.length })}{sep("l1")}
      <ScrollView style={{ maxHeight: touch ? 360 : 280 }}>{[...new Set([...labels, ...view.labels])].map(l => choose(`l:${l}`, view.labels, l, l, () => onView({ labels: toggleIn(view.labels, l) })))}</ScrollView></>; break;
    default: body = <>
      {item("grouping", "Grouping", () => setPage("grouping"), { glyph: "LayoutList", value: GROUPING_LABEL[view.grouping], next: true })}
      {item("sort", "Sort", () => setPage("sort"), { glyph: "ArrowUpDown", value: SORT_LABEL[sort], next: true })}
      {item("title", "Title", () => setPage("title"), { glyph: "Type", value: TITLE_LABEL[view.title], next: true })}
      {item("show", "Show", () => setPage("show"), { glyph: "Eye", value: shown.length === SHOW_ITEMS.length ? "All" : shown.length ? `${shown.length} on` : "None", next: true })}
      {(showProjects || showLabels) && sep("r1")}
      {showProjects && item("projects", "Project", () => setPage("projects"), { glyph: "Folder", value: filterValue(view.projects, "All"), next: true })}
      {showLabels && item("labels", "Labels", () => setPage("labels"), { glyph: "Tag", value: filterValue(view.labels, "All"), next: true })}
      {sep("r2")}
      {/* A setting, not a command: its state reads On or Off like the rows above show their values. */}
      {item("background", "Show background", () => onView({ show_background: !view.show_background }), { glyph: view.show_background ? "Eye" : "EyeOff", value: view.show_background ? "On" : "Off", selected: view.show_background })}
    </>;
  }
  return <View style={{ position: "relative", zIndex: 20 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Display: grouping ${GROUPING_LABEL[view.grouping]}, sort ${SORT_LABEL[sort]}${filtered ? ", filtered" : ""}${running ? ", ranking" : ""}`}
      aria-expanded={!!page} accessibilityState={{ expanded: !!page }} onPress={() => setPage(p => p ? null : "root")}
      style={state => ({ alignItems: "center", justifyContent: "center", height: touch ? 44 : 32, width: touch ? 44 : 32, borderRadius: touch ? 8 : 6, backgroundColor: page || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      {running ? <Spinner color={c.foreground} size={12} label="Ranking" /> : <Icon name="Settings2" size={touch ? 18 : 14} color={page ? c.foreground : c.foregroundMuted} />}
      {/* A filter narrows the list: a neutral dot, as Paseo marks its own filtered sidebar. */}
      {filtered && <View style={{ position: "absolute", top: touch ? 9 : 5, right: touch ? 9 : 5, width: 6, height: 6, borderRadius: 3, backgroundColor: c.foreground }} />}
    </Pressable>
    {page && <FloatingSurface role="menu" label="Display" width={touch ? 280 : 232} onClose={close} style={{ padding: 4, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1,
      shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>{body}</FloatingSurface>}
  </View>;
}

/** One line above the list while a Project or Labels filter is on: what narrows it, and Clear. */
export function FilterLine({ theme, view, onView, touch }: { theme: Theme; view: HomeView; onView: (patch: Partial<HomeView>) => void; touch: boolean }) {
  const c = theme.colors;
  if (!homeViewFiltered(view)) return null;
  const parts = [view.projects.length && `Project: ${view.projects.join(", ")}`, view.labels.length && `Labels: ${view.labels.join(", ")}`].filter(Boolean).join(" · ");
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: touch ? 8 : 6 }}>
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: touch ? 13 : 12 }}>{parts}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Clear filters" onPress={() => onView({ projects: [], labels: [] })} hitSlop={8}>
      <Text style={{ color: c.foreground, fontSize: touch ? 13 : 12, fontWeight: "500" }}>Clear</Text>
    </Pressable>
  </View>;
}

// ---------- status strip ----------

const STRIP: { id: HomeGroupId; label: string }[] = [
  { id: "needs", label: "Needs you" }, { id: "sending", label: "Sending" }, { id: "running", label: "Working" }, { id: "waiting", label: "Waiting" }, { id: "quiet", label: "Quiet" },
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
export function UsageMeters({ theme, sources, dense, hold = false }: { theme: Theme; sources: HomeSources; dense: boolean;
  /** Home's hold line is on screen (HomeModel.hold): the memory meter doesn't repeat "· paused". */ hold?: boolean }) {
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
      {vm && <VmMeter r={vm} c={c} now={Math.max(now, Date.now())} holdShown={hold} />}
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
function VmMeter({ r, c, now, holdShown }: { r: Resources; c: Colors; now: number; holdShown: boolean }) {
  const m = resourceMeter(r, now, undefined, { holdShown });
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
/**
 * The reason line: why a row ranks where it does, with its source. A Compass reason leads with the compass glyph and
 * names Compass after it ("Dana: client call Tue · Compass"); other sources keep their chip.
 */
export function PriorityLine({ reason, source, c, size = 12, lines = 1 }: { reason: string; source: { kind: keyof typeof PRIORITY_SOURCE_LABEL; label: string } | null; c: Colors; size?: number; lines?: number }) {
  if (source?.kind === "compass") return <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 }}>
    <Icon name="Compass" size={size} color={c.foregroundMuted} />
    <Text numberOfLines={lines} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: size }}>
      <Text style={{ fontStyle: "italic" }}>{reason}</Text>{" · Compass"}
    </Text>
  </View>;
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
