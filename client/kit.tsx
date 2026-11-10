import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
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

/**
 * The type scale. Desktop values are the long-standing ones; `compact` (phones) steps body and titles up for reading at
 * arm's length and keeps hierarchy in weight and colour: one 600 line per block, supporting text muted. `ask` is the one
 * line per pane you act on; `section` heads groups (sentence case on phones, small caps on desktop).
 */
export const text = (colors: Colors, compact = false) => {
  const cap = (n: number) => Platform.OS === "web" ? {} : { maxFontSizeMultiplier: n };
  return {
    headline: { color: colors.foreground, fontSize: compact ? 20 : 21, lineHeight: compact ? 26 : 29, fontWeight: "600" as const, letterSpacing: -0.2, ...cap(1.4) },
    title: { color: colors.foreground, fontSize: compact ? 17 : 15, lineHeight: compact ? 23 : 21, fontWeight: "600" as const, ...cap(1.4) },
    ask: { color: colors.foreground, fontSize: compact ? 16 : 15, lineHeight: compact ? 22 : 21, fontWeight: "600" as const, ...cap(1.4) },
    body: { color: colors.foreground, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, ...cap(1.4) },
    meta: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums" as const], ...cap(1.25) },
    small: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, fontVariant: ["tabular-nums" as const], ...cap(1.25) },
    label: { color: colors.foreground, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, fontWeight: "600" as const, ...cap(1.4) },
    section: compact
      ? { color: colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" as const, ...cap(1.25) }
      : { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, fontWeight: "600" as const, letterSpacing: 0.5, textTransform: "uppercase" as const },
  };
};

/** Spacing tokens. Phones get a 16 gutter, roomier rows and 44px controls; desktop keeps today's density. */
export const space = (compact = false) => compact
  ? { gutter: 16, section: 16, stack: 6, rowV: 12, rowH: 16, card: 14, control: 44, row: 48 }
  : { gutter: 12, section: 12, stack: 4, rowV: 9, rowH: 12, card: 12, control: 32, row: 32 };

/**
 * Bottom clearance for anything that touches the screen's bottom edge on a phone (the composer dock, the undo bar,
 * sheet footers). The plugin has no safe-area provider: web uses env() (0 unless the host sets viewport-fit=cover, so
 * the max() still leaves 12), native uses the gesture-bar / home-indicator heights. Desktop gets nothing.
 */
export function bottomInset(compact: boolean, extra = 0): ViewStyle {
  if (!compact) return {};
  if (Platform.OS === "web") return { paddingBottom: `max(${12 + extra}px, calc(env(safe-area-inset-bottom) + ${extra}px))` as unknown as number };
  return { paddingBottom: (Platform.OS === "ios" ? 34 : 24) + extra };
}
/** The same clearance as a number, for absolutely positioned bars (web can't do env() in `bottom`, so it uses 12). */
export const bottomGap = (compact: boolean) => !compact || Platform.OS === "web" ? 12 : Platform.OS === "ios" ? 34 : 24;

// ---------- keyboard send ----------
//
// Root cause of "I can't press command+enter to send (or enter)": no card or sheet had a key handler at all, and the
// answer field is multiline, so Enter only added a newline. Every dialog or card with a primary action wraps its body in
// SubmitScope and marks that Button with `shortcut` (tests/keyboard-send.test.ts fails otherwise).

type DomKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing?: boolean; target: unknown; preventDefault(): void; stopPropagation(): void };
type DomNode = { addEventListener(t: "keydown", f: (e: DomKey) => void): void; removeEventListener(t: "keydown", f: (e: DomKey) => void): void };
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test((navigator as { platform?: string }).platform ?? navigator.userAgent ?? "");
/** "⌘↵" on a Mac, "Ctrl ↵" elsewhere: the hint a primary Button shows on desktop web. */
export const submitHint = () => isMac() ? "⌘↵" : "Ctrl ↵";

/**
 * What a keydown inside a SubmitScope does. Cmd+Enter (Ctrl+Enter off a Mac) submits from anywhere, including the
 * note field. Plain Enter submits only when focus is on nothing that uses Enter itself: not a multiline field, a
 * button, a link, a radio or a switch. Repeats, IME composition and Shift/Alt never submit.
 */
export function submitKey(e: Pick<DomKey, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing">, target: { tag?: string; role?: string | null; multiline?: boolean }, mac: boolean): boolean {
  if (e.key !== "Enter" || e.repeat || e.isComposing || e.altKey || e.shiftKey) return false;
  if (mac ? e.metaKey : e.ctrlKey) return true;
  if (e.metaKey || e.ctrlKey) return false;
  const tag = (target.tag ?? "").toUpperCase();
  if (tag === "TEXTAREA" || target.multiline || tag === "BUTTON" || tag === "A" || tag === "SELECT") return false;
  return !["button", "link", "radio", "checkbox", "switch", "tab", "menuitem", "option"].includes(target.role ?? "");
}

/**
 * Wraps a card or sheet whose primary action the keyboard can trigger. Fires `onSubmit` once per press and never while
 * `enabled` is false (Send disabled, e.g. Something else with no words), and stops the key so the host's own
 * Cmd+Enter (the composer) doesn't also act on it. Web only; native keyboards submit through the button.
 */
export function SubmitScope({ enabled, onSubmit, children, style, accessibilityRole, accessibilityLabel }: { enabled: boolean; onSubmit: () => void; children: ReactNode; style?: StyleProp<ViewStyle>; accessibilityRole?: "summary"; accessibilityLabel?: string }) {
  const ref = useRef<View>(null);
  const latest = useRef({ enabled, onSubmit }); latest.current = { enabled, onSubmit };
  const busy = useRef(false);
  useEffect(() => {
    const node = ref.current as unknown as DomNode | null;
    if (Platform.OS !== "web" || !node?.addEventListener) return;
    const onKey = (e: DomKey) => {
      const t = e.target as { tagName?: string; getAttribute?: (n: string) => string | null } | null;
      if (!submitKey(e, { tag: t?.tagName, role: t?.getAttribute?.("role") ?? null }, isMac())) return;
      e.preventDefault(); e.stopPropagation();
      if (!latest.current.enabled || busy.current) return;
      busy.current = true; setTimeout(() => { busy.current = false; }, 600);
      latest.current.onSubmit();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, []);
  return <View ref={ref} style={style} accessibilityRole={accessibilityRole} accessibilityLabel={accessibilityLabel}>{children}</View>;
}

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
/** One button vocabulary for the whole plugin: 32px on desktop with a hit slop, 44px on touch layouts. */
export function Button({ title, onPress, theme, kind = "secondary", disabled = false, loading = false, icon, compact = false, accessibilityLabel, accessibilityHint, grow = false, shortcut = false }: {
  title: string; onPress: () => void; theme: Theme; kind?: ButtonKind; disabled?: boolean; loading?: boolean; icon?: string; compact?: boolean; accessibilityLabel?: string; accessibilityHint?: string; grow?: boolean;
  /** The SubmitScope's action: shows a quiet ⌘↵ on desktop web. */ shortcut?: boolean;
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
    {shortcut && !compact && Platform.OS === "web" && <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: fg, opacity: 0.6, fontSize: 11, lineHeight: 16, fontWeight: "500", marginLeft: 2 }}>{submitHint()}</Text>}
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 8 : 7, paddingHorizontal: compact ? 14 : 12, paddingTop: 10, paddingBottom: 8, minHeight: compact ? 44 : undefined }}>
      <Icon name={icon} size={compact ? 16 : 14} color={accent ?? c.foregroundMuted} />
      <Text accessibilityRole="header" style={{ color: accent ?? c.foreground, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, fontWeight: "600" }}>{title}</Text>
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
export function CardRow({ theme, onPress, accessibilityLabel, children, style, first = false, compact = false }: { theme: Theme; onPress?: () => void; accessibilityLabel?: string; children: ReactNode; style?: StyleProp<ViewStyle>; first?: boolean; compact?: boolean }) {
  const c = theme.colors;
  const base: ViewStyle = { paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 9, borderTopWidth: first ? 0 : 1, borderTopColor: c.border };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
    style={state => [base, { backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" }, style]}>{children}</Pressable>;
}

/** The fold row that hides finished items: "3 merged · Show". */
export function FoldRow({ theme, label, open, onPress, icon, iconColor, compact = false }: { theme: Theme; label: string; open: boolean; onPress: () => void; icon: string; iconColor: string; compact?: boolean }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "Hide" : "Show"} ${label}`} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 14 : 12, paddingVertical: 8, minHeight: compact ? 48 : undefined, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, alignItems: "center" }}><Icon name={icon} size={13} color={iconColor} /></View>
    <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
    <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
  </Pressable>;
}
