import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { quietFolds, type Badge, type HomeGroupId, type HomeModel, type Workstream } from "../shared/home";
import { age } from "../shared/inbox";
import { headlineColor, mergedColor, runningColor, tint, toneColor, withAlpha, type Colors } from "./theme";
import { useMinute } from "./home-data";
import { Spinner } from "./motion";
import type { Theme } from "./kit";

/**
 * The one list: Home's left side, the docked navigator in the explorer, and (on hosts that have it) the sidebar
 * view. Virtualised; rows are memoised on their signature and ages tick on their own, so a minute tick or a poll
 * that changes one row redraws only that row.
 */

const QUIET_PAGE = 20;
export const BRIEF_KEY = "brief";

type Entry =
  | { type: "brief"; key: string }
  | { type: "header"; key: string; group: HomeGroupId; title: string; count: number; open: boolean }
  | { type: "row"; key: string; s: Workstream }
  | { type: "fold"; key: string; project: string; count: number; archivable: number; open: boolean }
  | { type: "more"; key: string; project: string; left: number };

export type HomeListProps = {
  model: HomeModel;
  theme: Theme;
  /** Navigator and sidebar density: one-line rows without badges. */
  dense?: boolean;
  touch: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** The brief row's one-liner. Absent: no brief row (the navigator). */
  briefLine?: string | null;
  /** Content shown under the selected row (the navigator's expanded row). */
  renderExpanded?: (s: Workstream) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
};

export function HomeList({ model, theme, dense = false, touch, selectedKey, onSelect, briefLine, renderExpanded, header, footer }: HomeListProps) {
  const c = theme.colors;
  const [closed, setClosed] = useState<Set<string>>(new Set(["quiet"]));
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<Record<string, number>>({});
  const toggle = useCallback((key: string) => setClosed(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  const toggleProject = useCallback((p: string) => setOpenProjects(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; }), []);

  const data = useMemo(() => {
    const out: Entry[] = [];
    if (briefLine !== undefined) out.push({ type: "brief", key: BRIEF_KEY });
    for (const g of model.groups) {
      const open = !closed.has(g.id);
      out.push({ type: "header", key: `h:${g.id}`, group: g.id, title: g.title, count: g.items.length, open });
      if (!open) continue;
      if (g.id !== "quiet") { for (const s of g.items) out.push({ type: "row", key: s.key, s }); continue; }
      for (const f of quietFolds(g.items)) {
        const fopen = openProjects.has(f.project);
        out.push({ type: "fold", key: `f:${f.project}`, project: f.project, count: f.items.length, archivable: f.archivable, open: fopen });
        if (!fopen) continue;
        const shown = (pages[f.project] ?? 1) * QUIET_PAGE;
        for (const s of f.items.slice(0, shown)) out.push({ type: "row", key: s.key, s });
        if (f.items.length > shown) out.push({ type: "more", key: `m:${f.project}`, project: f.project, left: f.items.length - shown });
      }
    }
    return out;
  }, [model, closed, openProjects, pages, briefLine]);

  const render = useCallback(({ item }: { item: Entry }) => {
    switch (item.type) {
      case "brief": return <BriefRow theme={theme} line={briefLine ?? ""} selected={selectedKey === null || selectedKey === BRIEF_KEY} touch={touch} onSelect={onSelect} />;
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
          <Row s={item.s} theme={theme} dense={dense} touch={touch} selected={selected} onSelect={onSelect} sig={item.s.sig} />
          {selected && renderExpanded ? renderExpanded(item.s) : null}
        </View>;
      }
    }
  }, [theme, c, dense, touch, selectedKey, onSelect, briefLine, renderExpanded, toggle, toggleProject]);

  return <FlatList data={data} keyExtractor={e => e.key} renderItem={render} extraData={selectedKey}
    initialNumToRender={30} maxToRenderPerBatch={30} windowSize={9} removeClippedSubviews={false}
    ListHeaderComponent={header ? <>{header}</> : null} ListFooterComponent={footer ? <>{footer}</> : <View style={{ height: 32 }} />}
    style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} />;
}

function GroupHeader({ theme, title, count, open, tone, dense, touch, onPress }: { theme: Theme; title: string; count: number; open: boolean; tone?: string; dense: boolean; touch: boolean; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}. ${open ? "Collapse" : "Expand"}`} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: touch ? 44 : dense ? 28 : 34, paddingHorizontal: dense ? 8 : 16, paddingTop: dense ? 4 : 8 }}>
    {dense && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={c.foregroundMuted} />}
    <Text accessibilityRole="header" style={{ color: tone ?? c.foregroundMuted, fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>{title}</Text>
    <Text style={{ color: tone ?? c.foregroundMuted, fontSize: 11, lineHeight: 14, fontVariant: ["tabular-nums"] }}>{count}</Text>
    {!dense && !open && <Icon name="ChevronRight" size={12} color={c.foregroundMuted} />}
  </Pressable>;
}

function BriefRow({ theme, line, selected, touch, onSelect }: { theme: Theme; line: string; selected: boolean; touch: boolean; onSelect: (key: string) => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Morning brief. ${line}`} onPress={() => onSelect(BRIEF_KEY)}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch ? 52 : 40, paddingHorizontal: 16, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <Icon name="Sun" size={15} color={c.foregroundMuted} />
    <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Morning brief</Text>
    <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>{line}</Text>
  </Pressable>;
}

export function glyphColor(s: Pick<Workstream, "tone">, c: Colors): string {
  return s.tone === "running" ? runningColor(c) : s.tone === "success" ? c.statusSuccess : headlineColor(s.tone, c);
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

/** The age on the right. It re-renders on the shared minute clock without touching its row. */
export function Age({ iso, c, size = 12 }: { iso: string | null; c: Colors; size?: number }) {
  const now = useMinute();
  const text = age(iso, Math.max(now, Date.now()));
  return text ? <Text style={{ color: c.foregroundMuted, fontSize: size, fontVariant: ["tabular-nums"], minWidth: 26, textAlign: "right" }}>{text}</Text> : null;
}

type RowProps = { s: Workstream; sig: string; theme: Theme; dense: boolean; touch: boolean; selected: boolean; onSelect: (key: string) => void };
const Row = memo(function Row({ s, theme, dense, touch, selected, onSelect }: RowProps) {
  const c = theme.colors;
  const color = glyphColor(s, c);
  const blocking = s.group === "needs" && s.tier === 0;
  const muted = s.group === "quiet" || s.group === "later";
  const line = [s.word && s.group !== "needs" ? s.word : null, s.line].filter(Boolean).join(" · ");
  const label = [s.title + (s.agent ? ` › ${s.agent}` : ""), s.word, s.line].filter(Boolean).join(". ");
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={label} onPress={() => onSelect(s.key)}
    style={state => ({ flexDirection: "row", alignItems: dense ? "flex-start" : "center", gap: dense ? 8 : 10, minHeight: touch ? 56 : dense ? 36 : 38, paddingLeft: dense ? 8 : 16, paddingRight: dense ? 8 : 16, paddingVertical: dense ? 6 : 0,
      borderLeftWidth: 2, borderLeftColor: blocking ? withAlpha(color, 0.9) : "transparent",
      backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, alignItems: "center", paddingTop: dense ? 1 : 0 }}>
      {s.tone === "running" && s.icon === "LoaderCircle" ? <Spinner color={color} size={13} label="Running" /> : <Icon name={s.icon} size={15} color={color} />}
    </View>
    {dense ? <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text numberOfLines={1} style={{ color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: muted ? "400" : "500" }}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted }}>{` › ${s.agent}`}</Text> : null}</Text>
      {(!!s.word || !!s.line) && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
        {s.word && s.group === "needs" ? <Text style={{ color, fontWeight: "600" }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>}
    </View> : <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "55%", color: muted ? c.foregroundMuted : c.foreground, fontSize: 13, fontWeight: muted ? "400" : "500" }}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12 }}>
        {s.word && s.group === "needs" ? <Text style={{ color }}>{s.word}</Text> : null}{s.word && s.group === "needs" && s.line ? " · " : ""}{line}
      </Text>
      {s.badges.map(b => <BadgeView key={b.text} b={b} c={c} />)}
      <PrChipView s={s} c={c} />
    </View>}
    <Age iso={s.at} c={c} size={dense ? 11 : 12} />
  </Pressable>;
}, (a, b) => a.sig === b.sig && a.selected === b.selected && a.theme === b.theme && a.dense === b.dense && a.touch === b.touch && a.onSelect === b.onSelect);
