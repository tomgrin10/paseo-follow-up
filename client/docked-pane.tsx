// A scrolling pane with a bar docked under it (`a-focused-field-and-its-send-stay-in-view`). Home's detail pane, the
// Overseer's pane and setup draw through it, so none of them handles the keyboard or a focused field its own way.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { dockState, isField, revealFocused, type DockNode, type DockState } from "./dock";
import { KeyboardRoom, ScrollView, useKeyboard } from "./keyboard";

type Doc = { activeElement?: DockNode | null };
type DomNode = DockNode & { contains(n: unknown): boolean; addEventListener(e: string, f: (e: { target: unknown }) => void): void; removeEventListener(e: string, f: (e: { target: unknown }) => void): void };

/**
 * The pane: `header`, a scroll view holding `children`, and the bar `dock(yields)` draws under it. On a phone, while
 * a field in the pane has focus or the keyboard is up, `yields` is true and the dock drops its extras (Home's Sign
 * off row, setup's Back and Continue), the pane stops above the keyboard (it is a KeyboardRoom, client/keyboard.tsx),
 * and the focused field's primary form (the field with its Send, marked PRIMARY_FORM; on native, the field with room
 * for its Send) scrolls into view, again whenever the keyboard or the dock changes size.
 */
export function DockedPane({ compact, header, children, dock, style, contentContainerStyle, scrollRef }: {
  compact: boolean; header?: ReactNode | ((s: DockState) => ReactNode); children: ReactNode; dock?: (s: DockState) => ReactNode;
  style?: StyleProp<ViewStyle>; contentContainerStyle?: StyleProp<ViewStyle>;
  scrollRef?: React.MutableRefObject<unknown>;
}) {
  const root = useRef<View | null>(null);
  const dockRef = useRef<View | null>(null);
  const ownScroll = useRef<unknown>(null);
  const scroll = scrollRef ?? ownScroll;
  const [focus, setFocus] = useState({ field: false, inDock: false });
  const keyboard = useKeyboard(compact);
  const state = dockState({ compact, fieldFocused: focus.field, fieldInDock: focus.inDock, keyboardUp: keyboard.up });
  const yields = state.yields;
  const inDock = (n: unknown) => !!n && !!(dockRef.current as unknown as DomNode | null)?.contains(n);
  // Web: track focus inside the pane, and keep the focused field's form on screen.
  const reveal = () => {
    if (Platform.OS !== "web") return;
    const node = root.current as unknown as DomNode | null;
    const active = (globalThis as { document?: Doc }).document?.activeElement;
    if (node && active && node.contains(active)) revealFocused(active);
  };
  useEffect(() => {
    if (Platform.OS !== "web" || !compact) return;
    const node = root.current as unknown as DomNode | null;
    if (!node) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => { const t = setTimeout(() => { timers.delete(t); f(); }, ms); timers.add(t); };
    const onIn = (e: { target: unknown }) => {
      if (!isField(e.target as DockNode)) return;
      setFocus({ field: true, inDock: inDock(e.target) });
      // Once the dock has yielded and the keyboard has settled.
      later(0, reveal); later(320, reveal);
    };
    const onOut = () => later(0, () => {
      const active = (globalThis as { document?: Doc }).document?.activeElement;
      const field = !!active && node.contains(active) && isField(active);
      setFocus({ field, inDock: field && inDock(active) });
    });
    node.addEventListener("focusin", onIn); node.addEventListener("focusout", onOut);
    return () => { node.removeEventListener("focusin", onIn); node.removeEventListener("focusout", onOut); timers.forEach(clearTimeout); };
  }, [compact]);
  useEffect(() => { if (yields) { reveal(); const t = setTimeout(reveal, 320); return () => clearTimeout(t); } }, [yields, state.typingInContent, keyboard.top]);
  return <KeyboardRoom compact={compact} style={style}><View ref={root} style={{ flex: 1 }}>
    {typeof header === "function" ? header(state) : header}
    <ScrollView ref={scroll as never} style={{ flex: 1 }} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps="handled" revealRoom={NATIVE_SEND_ROOM}>{children}</ScrollView>
    <View ref={dockRef}>{dock?.(state)}</View>
  </View></KeyboardRoom>;
}

/** Native: what is kept clear under the focused input, about one row of actions (Send) plus the gap above it. */
const NATIVE_SEND_ROOM = 96;
