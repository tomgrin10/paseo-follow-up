import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { PressScale, Spinner } from "./motion";
import { raised, tint, withAlpha, type Colors, type Theme } from "./theme";

export type { Theme } from "./theme";

/** Re-render on an interval so "3m ago" keeps counting between polls. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

export { errorText } from "../shared/errors";

export const text = (colors: Colors) => ({
  title: { color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" as const },
  body: { color: colors.foreground, fontSize: 13, lineHeight: 18 },
  meta: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums" as const] },
  small: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, fontVariant: ["tabular-nums" as const] },
  label: { color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
});

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
/** One button vocabulary for the whole plugin: 32px on desktop with a hit slop, 44px on touch layouts. */
export function Button({ title, onPress, theme, kind = "secondary", disabled = false, loading = false, icon, compact = false, accessibilityLabel, accessibilityHint, grow = false }: {
  title: string; onPress: () => void; theme: Theme; kind?: ButtonKind; disabled?: boolean; loading?: boolean; icon?: string; compact?: boolean; accessibilityLabel?: string; accessibilityHint?: string; grow?: boolean;
}) {
  const c = theme.colors;
  const fg = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground;
  const inactive = disabled || loading;
  return <PressScale accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }}
    disabled={inactive} onPress={onPress} hitSlop={compact ? 0 : 4} outerStyle={grow ? { flexGrow: 1 } : { alignSelf: "flex-start" }}
    style={({ pressed, hovered }) => ({
      minHeight: compact ? 44 : 32, paddingHorizontal: compact ? 14 : 11, borderRadius: compact ? 8 : 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      opacity: disabled ? 0.45 : 1,
      ...(kind === "primary" ? { backgroundColor: pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent }
        : kind === "ghost" ? { backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" }
        : { ...raised(c), backgroundColor: pressed ? c.surface2 : hovered ? c.surface2 : c.surface1 }),
    })}>
    {loading ? <Spinner color={fg} size={12} /> : icon ? <Icon name={icon} size={compact ? 16 : 14} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : 12, lineHeight: compact ? 19 : 16, fontWeight: "600" }}>{title}</Text>
  </PressScale>;
}

/** A square icon-only control with an accessible name, for settings and refresh. */
export function IconButton({ icon, label, onPress, theme, compact = false, disabled = false, spinning = false, color }: { icon: string; label: string; onPress: () => void; theme: Theme; compact?: boolean; disabled?: boolean; spinning?: boolean; color?: string }) {
  const c = theme.colors;
  const size = compact ? 44 : 28;
  return <PressScale accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={compact ? 0 : 6}
    style={({ pressed, hovered }) => ({ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent", opacity: disabled && !spinning ? 0.45 : 1 })}>
    {spinning ? <Spinner color={color ?? c.foregroundMuted} size={14} label={label} /> : <Icon name={icon} size={compact ? 18 : 15} color={color ?? c.foregroundMuted} />}
  </PressScale>;
}

export type CardTone = "plain" | "attention" | "success";
/** A raised container with an icon title. Attention cards trade the ring for a warning border. */
export function Card({ theme, icon, title, tone = "plain", count, right, children, compact = false, style }: {
  theme: Theme; icon: string; title: string; tone?: CardTone; count?: string | number; right?: ReactNode; children: ReactNode; compact?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const c = theme.colors;
  const accent = tone === "attention" ? c.statusWarning : tone === "success" ? c.statusSuccess : null;
  return <View style={[{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, overflow: "hidden", backgroundColor: c.surface0 },
    accent ? { borderWidth: 1, borderColor: withAlpha(accent, 0.7) } : raised(c), style]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}>
      <Icon name={icon} size={14} color={accent ?? c.foregroundMuted} />
      <Text accessibilityRole="header" style={{ color: accent ?? c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{title}</Text>
      {count !== undefined && count !== "" && <Chip theme={theme} color={accent ?? c.foregroundMuted} label={String(count)} />}
      <View style={{ flex: 1 }} />
      {right}
    </View>
    {children}
  </View>;
}

export function Chip({ theme, label, color, icon }: { theme: Theme; label: string; color: string; icon?: string }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: tint(color, theme.colors) }}>
    {icon && <Icon name={icon} size={10} color={color} />}
    <Text numberOfLines={1} style={{ color, fontSize: 11, lineHeight: 16, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
  </View>;
}

/** A labelled switch. `value: null` means the real state is unknown and the control is disabled. */
export function Switch({ theme, label, value, onChange, disabled = false, accessibilityLabel, hint, compact = false }: { theme: Theme; label: string; value: boolean | null; onChange: (next: boolean) => void; disabled?: boolean; accessibilityLabel?: string; hint?: string; compact?: boolean }) {
  const c = theme.colors;
  const on = value === true;
  const inactive = disabled || value === null;
  return <Pressable accessibilityRole="switch" aria-checked={value === null ? "mixed" : on} accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={hint}
    accessibilityState={{ checked: value === null ? "mixed" : on, disabled: inactive }} accessibilityValue={{ text: value === null ? "Unknown" : on ? "On" : "Off" }}
    disabled={inactive} onPress={() => onChange(!on)} hitSlop={compact ? 0 : 4}
    style={({ pressed }) => ({ minHeight: compact ? 44 : 28, flexDirection: "row", alignItems: "center", gap: 8, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{label}</Text>
    <View style={{ width: 30, height: 18, borderRadius: 9, backgroundColor: on ? c.accent : c.surface2, borderWidth: 1, borderColor: on ? c.accent : c.border, justifyContent: "center" }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, marginLeft: value === null ? 8 : on ? 14 : 2, backgroundColor: on ? c.accentForeground : value === null ? c.border : c.foregroundMuted }} />
    </View>
  </Pressable>;
}

/** A row inside a card: hairline on top, hover tint when pressable. */
export function CardRow({ theme, onPress, accessibilityLabel, children, style, first = false }: { theme: Theme; onPress?: () => void; accessibilityLabel?: string; children: ReactNode; style?: StyleProp<ViewStyle>; first?: boolean }) {
  const c = theme.colors;
  const base: ViewStyle = { paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: first ? 0 : 1, borderTopColor: c.border };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
    style={state => [base, { backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" }, style]}>{children}</Pressable>;
}

/** The fold row that hides finished items: "3 merged · Show". */
export function FoldRow({ theme, label, open, onPress, icon, iconColor }: { theme: Theme; label: string; open: boolean; onPress: () => void; icon: string; iconColor: string }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "Hide" : "Show"} ${label}`} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, alignItems: "center" }}><Icon name={icon} size={13} color={iconColor} /></View>
    <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
    <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
  </Pressable>;
}
