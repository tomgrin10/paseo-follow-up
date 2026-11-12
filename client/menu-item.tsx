import type { ReactNode } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text } from "./text";
import { text, type Theme } from "./kit";

/**
 * One layout for every menu item (invariant menu-glyphs-center-on-their-item): a leading glyph slot centred on the
 * item, the label (and its hint) beside it, an optional trailing glyph. The glyph scales with touch as the text does.
 * Menus build their Pressable (focus, hover, press) and put this inside; none builds its own glyph slot, so a check or
 * an icon can't sit at the top of a two-line item on one menu and in the middle on another.
 */
export const menuGlyph = (touch: boolean) => ({ slot: touch ? 18 : 14, size: touch ? 17 : 14, gap: touch ? 12 : 9 });

/** The item row's own layout; the menu adds its padding, height and state colours. */
export const menuItemRow = (touch: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: menuGlyph(touch).gap });

export function MenuItemContent({ theme, touch, glyph, label, hint, muted = false, quietGlyph = false, trailing }: {
  theme: Theme; touch: boolean;
  /** An icon name, a node (a spinner), or nothing: the slot keeps its width either way so labels line up. */
  glyph?: string | ReactNode | null;
  label: string; hint?: string | null;
  /** The whole item reads as unavailable (a running job). */ muted?: boolean;
  /** Only the glyph is muted (the row menu's action icons). */ quietGlyph?: boolean;
  trailing?: ReactNode;
}) {
  const c = theme.colors; const t = text(c, touch); const g = menuGlyph(touch);
  return <>
    <View testID="menu-glyph" style={{ width: g.slot, alignSelf: "center", alignItems: "center", justifyContent: "center" }}>
      {typeof glyph === "string" ? <Icon name={glyph as never} size={g.size} color={muted || quietGlyph ? c.foregroundMuted : c.foreground} /> : glyph}
    </View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={muted ? { ...t.body, color: c.foregroundMuted } : t.body}>{label}</Text>
      {!!hint && <Text numberOfLines={1} style={touch ? t.meta : t.small}>{hint}</Text>}
    </View>
    {trailing}
  </>;
}
