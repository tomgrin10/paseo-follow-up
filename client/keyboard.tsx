// The phone keyboard never covers the field you type in (`the-keyboard-never-covers-a-field`). Paseo moves its own
// composer above the keyboard and positions fields in its sheets (the SDK's TextInput), but a plugin's screens and
// panels get nothing: the app draws edge to edge, so the window doesn't shrink for the keyboard on iOS or Android.
// Every Follow-up surface draws inside a KeyboardRoom (index.client.tsx), every field is client/field.tsx's Field,
// and scroll views that hold fields are this file's ScrollView. The room stops above the keyboard; the focused field
// scrolls into view, or the room lifts by what scrolling can't cover. The math is pure, in client/dock.ts.
import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, View, type KeyboardEvent, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView as NativeScrollView, type ScrollViewProps, type StyleProp, type ViewStyle } from "react-native";
import { ScrollView as HostScrollView } from "@getpaseo/plugin/client/ui";
import { KEYBOARD_MIN, keyboardOverlap, revealFocused, revealPlan, roomOverlap, type DockNode } from "./dock";

/** The keyboard: whether it is up, and its top edge in window coordinates (null when down or not over the page). */
export type KeyboardState = { up: boolean; top: number | null };
const DOWN: KeyboardState = { up: false, top: null };

type Viewport = { height: number; offsetTop: number; addEventListener(e: "resize" | "scroll", f: () => void): void; removeEventListener(e: "resize" | "scroll", f: () => void): void };
type Win = { innerHeight: number; innerWidth: number; visualViewport?: Viewport; addEventListener(e: "resize", f: () => void): void; removeEventListener(e: "resize", f: () => void): void };

// One set of listeners for the whole client, started by the first reader and stopped by the last: events only, no polling.
let state: KeyboardState = DOWN;
const readers = new Set<(s: KeyboardState) => void>();
let stop: (() => void) | null = null;
const publish = (next: KeyboardState) => {
  if (next.up === state.up && next.top === state.top) return;
  state = next;
  readers.forEach(f => f(state));
};
function start(): () => void {
  if (Platform.OS === "web") {
    // The keyboard either shrinks the visual viewport over an unchanged page (iOS Safari, Chrome's default) or resizes
    // the page itself (`interactive-widget=resizes-content`: the window got shorter at the same width).
    const win = globalThis as unknown as Win;
    const vv = win.visualViewport;
    let tallest = win.innerHeight, width = win.innerWidth;
    const check = () => {
      if (win.innerWidth !== width) { width = win.innerWidth; tallest = win.innerHeight; }
      tallest = Math.max(tallest, win.innerHeight);
      const overlap = vv ? keyboardOverlap({ innerHeight: win.innerHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop }) : 0;
      const up = overlap > KEYBOARD_MIN || tallest - win.innerHeight > KEYBOARD_MIN;
      publish(up ? { up, top: overlap > KEYBOARD_MIN && vv ? vv.offsetTop + vv.height : null } : DOWN);
    };
    vv?.addEventListener("resize", check); vv?.addEventListener("scroll", check); win.addEventListener("resize", check);
    return () => { vv?.removeEventListener("resize", check); vv?.removeEventListener("scroll", check); win.removeEventListener("resize", check); };
  }
  const ios = Platform.OS === "ios";
  const shown = (e: KeyboardEvent) => publish({ up: true, top: e.endCoordinates.screenY });
  const subs = [
    Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", shown),
    ...(ios ? [Keyboard.addListener("keyboardWillChangeFrame", e => { if (state.up) shown(e); })] : []),
    Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => publish(DOWN)),
  ];
  return () => subs.forEach(s => s.remove());
}

/** The keyboard, for phones: on the web only when `active` (compact); native always reads it. */
export function useKeyboard(active: boolean): KeyboardState {
  const on = active || Platform.OS !== "web";
  const [k, setK] = useState<KeyboardState>(on ? state : DOWN);
  useEffect(() => {
    if (!on) { setK(DOWN); return; }
    readers.add(setK);
    if (!stop) stop = start();
    setK(state);
    return () => { readers.delete(setK); if (!readers.size && stop) { stop(); stop = null; state = DOWN; } };
  }, [on]);
  return k;
}

type Box = (f: (top: number, height: number) => void) => void;
type Measurable = { measureInWindow?(f: (x: number, y: number, w: number, h: number) => void): void } | null;
const boxOf = (ref: { current: unknown }): Box => f => (ref.current as Measurable)?.measureInWindow?.((_x, y, _w, h) => f(y, h));

/** A scroll view's part in revealing a field: where it is, how far it can scroll, and the room its fields keep below. */
type RevealScroll = { measure: Box; offset(): number; maxOffset(): number; scrollTo(y: number): void; room: number };
const ScrollContext = createContext<RevealScroll | null>(null);

/** The focused field, as its room sees it. */
export type FocusedField = { measure: Box; node: () => unknown; scroll: RevealScroll | null };
type Room = { focus(f: FocusedField): void; blur(f: FocusedField): void };
const RoomContext = createContext<Room | null>(null);

/** For Field: the room it reports focus to and the scroll view around it. */
export const useFieldRoom = () => ({ room: useContext(RoomContext), scroll: useContext(ScrollContext) });

/**
 * A surface's frame: it stops above the keyboard (padding by what the keyboard covers of it, measured, so a host that
 * already moved or shrank the surface leaves nothing to do), and once that has laid out, brings the focused field into
 * view. Rooms nest: a field reports to the nearest, and an inner room under an outer one that already stopped finds
 * nothing covered. `compact` turns it on for the web; native always is.
 */
export function KeyboardRoom({ compact, style, children }: { compact: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const kb = useKeyboard(compact);
  const frame = useRef<View | null>(null);
  const [bottom, setBottom] = useState<number | null>(null);
  const [lift, setLift] = useState(0);
  const focused = useRef<FocusedField | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const measure = useCallback(() => boxOf(frame)((y, h) => setBottom(b => (b === y + h ? b : y + h))), []);
  useEffect(() => { if (kb.up) measure(); else setLift(0); }, [kb.up, kb.top, measure]);
  const overlap = roomOverlap(bottom, kb.top);
  const room = useMemo<Room>(() => ({
    focus(f) { focused.current = f; setFocusTick(t => t + 1); },
    blur(f) { if (focused.current === f) focused.current = null; },
  }), []);
  // Once the padding has laid out (and again after the keyboard's animation), reveal the focused field.
  useEffect(() => {
    if (!kb.up) return;
    const reveal = () => {
      const f = focused.current;
      if (!f) return;
      if (Platform.OS === "web") { revealFocused(f.node() as DockNode); return; }
      const top = kb.top;
      if (top === null) return;
      f.measure((fieldTop, h) => {
        const go = (scroll: { top: number; bottom: number; offset: number; maxOffset: number } | null) => {
          const plan = revealPlan({ fieldTop, fieldBottom: fieldTop + h, keyboardTop: top, room: f.scroll?.room ?? 0, scroll });
          if (plan.scrollTo !== null) f.scroll!.scrollTo(plan.scrollTo);
          if (plan.lift) setLift(l => l + plan.lift);
        };
        if (!f.scroll) { go(null); return; }
        const s = f.scroll;
        s.measure((st, sh) => go({ top: st, bottom: st + sh, offset: s.offset(), maxOffset: s.maxOffset() }));
      });
    };
    const timers = [60, 360].map(ms => setTimeout(reveal, ms));
    return () => timers.forEach(clearTimeout);
  }, [kb.up, kb.top, overlap, focusTick]);
  const onLayout = useCallback((_e: LayoutChangeEvent) => { if (kb.up) measure(); }, [kb.up, measure]);
  return <RoomContext.Provider value={room}>
    <View ref={frame} onLayout={onLayout} style={[{ flexGrow: 1, flexShrink: 1 }, style, overlap ? { paddingBottom: overlap } : null]}>
      <View style={[{ flexGrow: 1, flexShrink: 1 }, lift ? { transform: [{ translateY: -lift }] } : null]}>{children}</View>
    </View>
  </RoomContext.Provider>;
}

/**
 * The SDK's ScrollView, telling the fields inside it how to scroll them into view. `revealRoom`: what stays clear
 * under a focused field (a docked pane keeps room for its Send). Use it for every scroll view that holds a Field.
 */
export const ScrollView = forwardRef<NativeScrollView, ScrollViewProps & { revealRoom?: number }>(function ScrollView({ revealRoom = 0, onScroll, onLayout, onContentSizeChange, scrollEventThrottle, ...props }, ref) {
  const own = useRef<NativeScrollView | null>(null);
  const m = useRef({ offset: 0, content: 0, height: 0 });
  const setRef = useCallback((s: NativeScrollView | null) => {
    own.current = s;
    if (typeof ref === "function") ref(s); else if (ref) ref.current = s;
  }, [ref]);
  const ctx = useMemo<RevealScroll>(() => ({
    measure: boxOf(own), room: revealRoom,
    offset: () => m.current.offset,
    maxOffset: () => Math.max(0, m.current.content - m.current.height),
    scrollTo: y => own.current?.scrollTo({ y, animated: true }),
  }), [revealRoom]);
  return <ScrollContext.Provider value={ctx}>
    <HostScrollView {...props} ref={setRef} scrollEventThrottle={scrollEventThrottle ?? 100}
      onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => { m.current.offset = e.nativeEvent.contentOffset.y; onScroll?.(e); }}
      onLayout={e => { m.current.height = e.nativeEvent.layout.height; onLayout?.(e); }}
      onContentSizeChange={(w, h) => { m.current.content = h; onContentSizeChange?.(w, h); }} />
  </ScrollContext.Provider>;
});
