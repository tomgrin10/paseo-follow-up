import { type ReactNode } from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable } from "./text";
import { readOpen, writeOpen } from "../shared/settings-nav";
import { useViewVersion } from "./view-store";
import type { Theme } from "./theme";

/**
 * The one fold (invariant 132, panel-sections-fold): every collapsible block, in settings and in the workspace's panel,
 * reads its state here and draws its header through FoldButton. Open or closed is remembered per device and per
 * block id (`follow-up.settings.fold.<id>`, in the device document on 0.16), never per workspace; until the
 * developer chooses, `defaultOpen` decides.
 */
export function useFold(id: string | null, defaultOpen: boolean): { open: boolean; toggle: () => void } {
  // Read from device storage on every render: the localStorage cache paints first, the device document once it loads.
  useViewVersion();
  const open = id === null ? true : readOpen(id, defaultOpen);
  return { open, toggle: () => { if (id !== null) writeOpen(id, !open); } };
}

/**
 * A fold's header: a button with its expanded state, toggled by a click or Enter (React Native Web's press; Space
 * never reaches it in Paseo, whose window listener takes it first). `label` is what a screen
 * reader hears (the title, then the summary or count). `chevron`: "lead" draws a right/down chevron first (settings),
 * "end" an up/down chevron last (the panel's cards).
 */
export function FoldButton({ open, onToggle, label, theme, chevron, style, children }: {
  open: boolean; onToggle: () => void; label: string; theme: Theme; chevron: "lead" | "end";
  style: (hovered: boolean, pressed: boolean) => StyleProp<ViewStyle>; children: ReactNode;
}) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
    accessibilityLabel={label} accessibilityHint={open ? "Collapses" : "Expands"} onPress={onToggle}
    style={state => style(!!(state as { hovered?: boolean }).hovered, state.pressed)}>
    {chevron === "lead" && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />}
    {children}
    {chevron === "end" && <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />}
  </Pressable>;
}

export { PANEL_FOLDS, type PanelFold } from "../shared/settings-nav";
