import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { readOpen, writeOpen, SETTINGS_CATEGORIES, type SettingsCategory } from "../shared/settings-nav";
import { text, type Theme } from "./kit";

/**
 * One collapsible block: chevron, title, a one-line summary and a count. Open or closed is remembered per device
 * (`follow-up.settings.fold.<id>`); until the developer chooses, `defaultOpen` decides. The body mounts only when
 * open, so whatever it loads (gh suggestions, long lists) waits until then.
 */
export function Disclosure({ id, title, summary, count, defaultOpen, theme, compact, children, framed = true }: {
  id: string; title: string; summary?: string | null; count?: string | number | null; defaultOpen: boolean; theme: Theme; compact: boolean; children: ReactNode; framed?: boolean;
}) {
  const c = theme.colors; const t = text(c);
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const toggle = () => { const next = !open; writeOpen(id, next); setOpen(next); };
  const header = <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
    accessibilityLabel={`${title}${summary ? `, ${summary}` : ""}`} accessibilityHint={open ? "Collapses" : "Expands"} onPress={toggle}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 48 : 36, paddingLeft: framed ? (compact ? 16 : 14) : 36, paddingRight: compact ? 16 : 14, paddingVertical: 6,
      backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? (framed ? c.surface2 : c.surface1) : "transparent" })}>
    <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={[t.label, { flexShrink: 0 }]}>{title}</Text>
    <Text numberOfLines={1} style={[t.meta, { flex: 1, minWidth: 0 }]}>{summary ?? ""}</Text>
    {count != null && count !== "" && <Text style={[t.meta, { fontVariant: ["tabular-nums"] }]}>{count}</Text>}
  </Pressable>;
  // Nested: the chevron sits under the parent's title (one fixed step in), and the body indents to this title.
  if (!framed) return <View>{header}{open && <View>{children}</View>}</View>;
  return <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
    {header}
    {open && <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>{children}</View>}
  </View>;
}

/** Desktop: one row of tabs under the host's own settings nav (a second rail would squeeze the cards). */
export function CategoryTabs({ value, onChange, theme }: { value: SettingsCategory; onChange: (id: SettingsCategory) => void; theme: Theme }) {
  const c = theme.colors;
  return <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 }}>
    {SETTINGS_CATEGORIES.map(cat => {
      const active = cat.id === value;
      return <Pressable key={cat.id} accessibilityRole="tab" accessibilityState={{ selected: active }} aria-selected={active} onPress={() => onChange(cat.id)}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 10, marginBottom: -1, borderBottomWidth: 2,
          borderBottomColor: active ? c.foreground : "transparent", borderTopLeftRadius: 6, borderTopRightRadius: 6,
          backgroundColor: !active && (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
        <Icon name={cat.icon} size={14} color={active ? c.foreground : c.foregroundMuted} />
        <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: active ? "600" : "400" }}>{cat.title}</Text>
      </Pressable>;
    })}
  </View>;
}

/** Phone: the category list. Each row's line comes from data already loaded, else a fixed description; it fetches nothing. */
export function CategoryList({ onOpen, summaries, theme }: { onOpen: (id: SettingsCategory) => void; summaries: Partial<Record<SettingsCategory, string | null>>; theme: Theme }) {
  const c = theme.colors; const t = text(c);
  return <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
    {SETTINGS_CATEGORIES.map((cat, i) => <Pressable key={cat.id} accessibilityRole="button" accessibilityLabel={cat.title} accessibilityHint={summaries[cat.id] ?? cat.blurb} onPress={() => onOpen(cat.id)}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
      <Icon name={cat.icon} size={18} color={c.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={t.label}>{cat.title}</Text>
        <Text numberOfLines={1} style={t.meta}>{summaries[cat.id] ?? cat.blurb}</Text>
      </View>
      <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
    </Pressable>)}
  </View>;
}

/** Phone: the back row above a drilled-in category. */
export function BackHeader({ title, onBack, theme }: { title: string; onBack: () => void; theme: Theme }) {
  const c = theme.colors;
  // The whole row goes back (44 px tall), not just the chevron.
  return <Pressable accessibilityRole="button" accessibilityLabel={`Back to settings from ${title}`} onPress={onBack}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 8, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
    <Icon name="ChevronLeft" size={18} color={c.foregroundMuted} />
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, lineHeight: 23, fontWeight: "600" }}>{title}</Text>
  </Pressable>;
}
