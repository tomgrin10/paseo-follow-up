import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { GROUP_TITLE, homeCounts, type HomeGroupId, type HomeModel } from "../shared/home";
import { FIELD_LABEL, excerpt, highlightRuns, homeSearchDocs, indexDocs, omniboxResults, workspaceProvider, type OmniboxItem, type OmniboxProvider, type Range } from "../shared/search";
import { SORT_HINT, SORT_LABEL, SORT_MODES, type SortMode } from "../shared/sort";
import { priorityNote, PRIORITY_SOURCE_LABEL } from "../shared/priorities";
import { meters, meterText, type Meter } from "../shared/usage";
import { resourceText, resourceTone, type Resources } from "../shared/resources";
import type { HomeSources } from "./home-data";
import type { Workstream } from "../shared/home";
import { Age, PrChipView } from "./home-list";
import { useMinute } from "./home-data";
import { withAlpha, type Colors } from "./theme";
import type { Theme } from "./kit";

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
};

/**
 * The search state for one list. The index is rebuilt only when Home's sources change, never per keystroke.
 * `extraProviders` is the seam for the next build's "Ask the Overseer" row, listed after the workspace results.
 */
export function useOmnibox(model: HomeModel, sources: HomeSources, extraProviders: readonly OmniboxProvider[] = []): Omnibox {
  const [query, setQueryState] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<TextInput | null>(null);
  const live = useSyncExternalStore(sources.live.subscribe, sources.live.version, sources.live.version);
  const paseo = useSyncExternalStore(sources.paseo.subscribe, sources.paseo.version, sources.paseo.version);
  const extras = useSyncExternalStore(sources.extras.subscribe, sources.extras.version, sources.extras.version);
  const searching = query.trim().length > 0;
  // Built lazily: nothing is indexed until the developer types.
  const index = useMemo(() => searching ? indexDocs(homeSearchDocs({ model, paseo: sources.paseo.all(), tracked: sources.live.all(), archived: sources.live.archived(), agents: sources.extras.agents() })) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, model, live, paseo, extras]);
  const providers = useMemo(() => index ? [workspaceProvider(index), ...extraProviders] : [], [index, extraProviders]);
  const results = useMemo(() => searching ? omniboxResults(providers, query) : null, [providers, query, searching]);
  const setQuery = useCallback((q: string) => { setQueryState(q); setActive(0); }, []);
  const move = useCallback((delta: number) => setActive(a => Math.max(0, Math.min((results?.length ?? 1) - 1, a + delta))), [results]);
  // ⌘K "Follow-up: Search".
  const token = useSyncExternalStore(sources.extras.subscribe, sources.extras.focusToken, sources.extras.focusToken);
  const first = useRef(token);
  useEffect(() => { if (token !== first.current) inputRef.current?.focus(); }, [token]);
  return { query, setQuery, results, active: Math.min(active, Math.max(0, (results?.length ?? 1) - 1)), move, inputRef };
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
  const { query, setQuery, results, active, move, inputRef } = omnibox;
  return <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, height: dense ? 30 : 32, paddingHorizontal: 8, borderRadius: 6,
    borderWidth: 1, borderColor: focused ? withAlpha(c.foreground, 0.35) : c.border, backgroundColor: c.surface1 }}>
    <Icon name="Search" size={13} color={c.foregroundMuted} />
    <TextInput ref={inputRef} value={query} onChangeText={setQuery} placeholder="Search workspaces, branches, PRs" placeholderTextColor={c.foregroundMuted}
      accessibilityLabel="Search workspaces, branches, PRs" autoCorrect={false} autoCapitalize="none" spellCheck={false} returnKeyType="go"
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onSubmitEditing={() => { const item = results?.[active]; if (item) onEnter(item); }}
      onKeyPress={e => {
        const key = (e.nativeEvent as { key?: string }).key;
        if (key === "ArrowDown") { e.preventDefault?.(); move(1); }
        else if (key === "ArrowUp") { e.preventDefault?.(); move(-1); }
        else if (key === "Escape") { if (query) setQuery(""); else inputRef.current?.blur(); }
      }}
      style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 13, paddingVertical: 0, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }} />
    {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => { setQuery(""); inputRef.current?.focus(); }}>
      <Icon name="X" size={13} color={c.foregroundMuted} />
    </Pressable>}
    {!query && !focused && Platform.OS === "web" && <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 4, borderRadius: 3, borderWidth: 1, borderColor: c.border }}>/</Text>}
  </View>;
}

// ---------- sort ----------

export function SortMenu({ theme, mode, onChange, rankedAt, touch }: { theme: Theme; mode: SortMode; onChange: (m: SortMode) => void; rankedAt: string | null; touch: boolean }) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const now = useMinute();
  return <View style={{ position: "relative", zIndex: 20 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Sort: ${SORT_LABEL[mode]}`} aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => setOpen(o => !o)}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 4, height: touch ? 36 : 30, paddingHorizontal: 8, borderRadius: 6, backgroundColor: open || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
      <Icon name="ArrowUpDown" size={13} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12 }}>{SORT_LABEL[mode]}</Text>
      <Icon name="ChevronDown" size={12} color={c.foregroundMuted} />
    </Pressable>
    {open && <View accessibilityRole="menu" style={{ position: "absolute", top: touch ? 40 : 34, right: 0, minWidth: 220, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1,
      shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
      {SORT_MODES.map(m => <Pressable key={m} accessibilityRole="menuitem" accessibilityState={{ selected: m === mode }} onPress={() => { onChange(m); setOpen(false); }}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 44 : 34, paddingHorizontal: 10, backgroundColor: (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
        <View style={{ width: 14, alignSelf: "flex-start", paddingTop: 2 }}>{m === mode && <Icon name="Check" size={13} color={c.foreground} />}</View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 17 }}>{SORT_LABEL[m]}</Text>
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{SORT_HINT[m]}</Text>
        </View>
      </Pressable>)}
      <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4, marginTop: 4, borderTopWidth: 1, borderTopColor: c.border }}>Priority: {priorityNote(rankedAt, now)}</Text>
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
    return <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={n === null ? label : `${label}, ${n}${selected ? ". Showing only these; press to show all" : ". Show only these"}`} onPress={onPress}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 5, height: touch ? 36 : 30, paddingHorizontal: 8, borderRadius: 15,
        borderWidth: 1, borderColor: selected ? withAlpha(c.foreground, 0.4) : "transparent",
        backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
      {n !== null && <Text style={{ color, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{n}</Text>}
      <Text style={{ color: selected ? c.foreground : muted ? withAlpha(c.foregroundMuted, 0.6) : c.foregroundMuted, fontSize: 12 }}>{label}</Text>
      {selected && <Icon name="X" size={11} color={c.foregroundMuted} />}
    </Pressable>;
  };
  return <View accessibilityRole="toolbar" accessibilityLabel="Status" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: dense ? 0 : 2, rowGap: 2, paddingHorizontal: dense ? 4 : 10 }}>
    {STRIP.map(s => chip(s.id, s.label, counts[s.id], filter === s.id, () => onFilter(filter === s.id ? null : s.id), s.id === "needs" && counts.needs ? c.statusWarning : undefined))}
    {counts.later > 0 && chip("later", "Later", counts.later, filter === "later", () => onFilter(filter === "later" ? null : "later"))}
    {counts.archivable > 0 && <Text style={{ color: c.statusSuccess, fontSize: 12, paddingHorizontal: 6 }}>{counts.archivable} to archive</Text>}
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
  const vm = usage.resources && resourceText(usage.resources) ? usage.resources : null;
  if (!list.length && !vm) return null;
  const detail = list.find(m => m.family === open);
  return <View style={{ paddingHorizontal: dense ? 8 : 16, gap: 4 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 2 }}>
      {vm && <VmMeter r={vm} c={c} />}
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
 * "VM memory 72% · CPU 40%", the resource governor's view. Amber from 75% of Paseo's memory limit, red from 85%;
 * the caption says when Follow-up has paused its own background work because of it.
 */
function VmMeter({ r, c }: { r: Resources; c: Colors }) {
  const memory = resourceTone("memory", r.memoryPct, r.level), cpu = resourceTone("cpu", r.cpuPct, r.level);
  const worst = memory === "danger" || cpu === "danger" ? "danger" : memory === "warning" || cpu === "warning" ? "warning" : "ok";
  const color = toneColor({ tone: worst }, c);
  const paused = r.level === "critical" ? "Follow-up paused background work and extras" : r.level === "constrained" ? "Follow-up paused background work" : null;
  const text = resourceText(r)!;
  return <View accessibilityRole="text" accessibilityLabel={`${text}${paused ? `. ${paused}` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 }}>
    <Bar pct={r.memoryPct ?? r.cpuPct ?? 0} color={color} c={c} />
    <Text numberOfLines={1} style={{ color: worst === "ok" ? c.foregroundMuted : color, fontSize: 11, fontVariant: ["tabular-nums"] }}>
      {text}{paused ? ` · ${paused.replace("Follow-up paused", "paused")}` : ""}
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

export function ResultRow({ item, theme, active, dense, touch, onPress, s: row }: { item: OmniboxItem; theme: Theme; active: boolean; dense: boolean; touch: boolean; onPress: () => void; s?: Workstream }) {
  const c = theme.colors;
  const { hit } = item;
  const via = hit.via ? excerpt(hit.via.text, hit.via.ranges, dense ? 56 : 90) : null;
  const archived = hit.group === "archived";
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${hit.title}${hit.via ? `, ${FIELD_LABEL[hit.via.field]}: ${hit.via.text}` : ""}`} onPress={onPress}
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

/** The muted reason and source chip a fresh external priority adds to a row. */
export function PriorityLine({ reason, source, c, size = 12 }: { reason: string; source: { kind: keyof typeof PRIORITY_SOURCE_LABEL; label: string } | null; c: Colors; size?: number }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
    {source && <View style={{ paddingHorizontal: 5, height: 16, justifyContent: "center", borderRadius: 3, backgroundColor: c.surface2 }}>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10, lineHeight: 13 }}>{PRIORITY_SOURCE_LABEL[source.kind]}</Text>
    </View>}
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: size, fontStyle: "italic" }}>{reason}</Text>
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
