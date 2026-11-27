import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import type { Theme } from "./theme";

/**
 * A section's help text behind a small ? after its title (docs/client.md#section-hints): no section carries help text
 * in its body. Desktop shows it on hover or focus; touch opens it on a tap, and a tap anywhere else (or on the ? again)
 * closes it. The bubble draws under the header, over the section's own content, so the owner (Card) lets it overflow
 * while it is open (`onOpenChange`).
 */
export function useHint(onOpenChange?: (open: boolean) => void) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const was = useRef(open);
  useEffect(() => { if (was.current !== open) { was.current = open; onOpenChange?.(open); } }, [open, onOpenChange]);
  // A tap elsewhere closes a pinned hint (web; native closes on the ? again).
  const node = useRef<View>(null);
  useEffect(() => {
    if (!pinned || Platform.OS !== "web") return;
    const doc = (globalThis as { document?: { addEventListener(t: string, f: (e: { target: unknown }) => void, o?: boolean): void; removeEventListener(t: string, f: (e: { target: unknown }) => void, o?: boolean): void } }).document;
    if (!doc) return;
    const away = (e: { target: unknown }) => {
      const el = node.current as unknown as { contains?: (n: unknown) => boolean } | null;
      if (!el?.contains?.(e.target)) setPinned(false);
    };
    doc.addEventListener("pointerdown", away, true);
    return () => doc.removeEventListener("pointerdown", away, true);
  }, [pinned]);
  return { open, node, hover: setHovered, toggle: () => setPinned(p => !p), close: () => { setPinned(false); setHovered(false); } };
}

export type HintState = ReturnType<typeof useHint>;

/** The ? itself: muted, 13 px, a 44 px target on touch. Its accessible name says what it is; the hint is its description. */
export function HintIcon({ hint, text, theme, compact }: { hint: HintState; text: string; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const size = compact ? 44 : 20;
  return <View ref={hint.node} style={{ flexShrink: 0, marginHorizontal: compact ? -12 : -2 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="About this section" accessibilityHint={text} aria-expanded={hint.open} accessibilityState={{ expanded: hint.open }}
      onHoverIn={() => hint.hover(true)} onHoverOut={() => hint.hover(false)} onFocus={() => hint.hover(true)} onBlur={() => hint.hover(false)}
      onPress={hint.toggle} hitSlop={compact ? 0 : 6}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon name="CircleHelp" size={13} color={hint.open ? c.foreground : c.foregroundMuted} />
    </Pressable>
  </View>;
}

/** The hint's words, drawn as a small bubble under the header (absolute, so the card's content doesn't move). */
export function HintBubble({ hint, text, theme }: { hint: HintState; text: string; theme: Theme }) {
  const c = theme.colors;
  if (!hint.open) return null;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ position: "absolute", top: "100%", left: 8, right: 8, zIndex: 20, marginTop: -2, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
      backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, maxWidth: 360 }}>
    <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 17 }}>{text}</Text>
  </View>;
}
