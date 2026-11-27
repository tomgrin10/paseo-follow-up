import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Modal as RNModal, ScrollView, Platform, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Pressable } from "./text";
import { floatingPlacement, intersectFloatBox, type FloatBox, type FloatSide } from "../shared/floating";

type Node = { getBoundingClientRect?(): { left: number; top: number; width: number; height: number }; measureInWindow?(f: (x: number, y: number, width: number, height: number) => void): void };
type Events = { addEventListener(t: string, f: () => void, capture?: boolean): void; removeEventListener(t: string, f: () => void, capture?: boolean): void };
type Browser = Events & { visualViewport?: Events & { offsetLeft: number; offsetTop: number; width: number; height: number }; ResizeObserver?: new (f: () => void) => { observe(n: unknown): void; disconnect(): void } };

/**
 * One bounded surface for every custom menu/popover. RN Modal preserves React/plugin context while moving the web
 * subtree to document.body, outside transformed panels, clipped sidebar slots and host footer stacking contexts.
 * Nonmodal keys help stays in its visible pane instead. The probe stays with the opener; resize and captured scroll
 * remeasure it only while the popup is mounted.
 */
export function FloatingSurface({ children, anchor, side = "below", width = 256, onClose, role = "dialog", label, style, contentRef, onSize, dismissOnEscape = true, dataSet, modal = true }: {
  children: ReactNode; anchor?: { x: number; y: number }; side?: FloatSide; width?: number; onClose?: () => void;
  role?: "menu" | "dialog" | "alertdialog" | "region"; label?: string; style?: ViewStyle; dataSet?: Record<string, string>;
  modal?: boolean; dismissOnEscape?: boolean; contentRef?: { current: unknown }; onSize?: (s: { width: number; height: number }) => void;
}) {
  const win = useWindowDimensions();
  const owner = useId();
  const probe = useRef<View>(null);
  const wasVisible = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [box, setBox] = useState<FloatBox | null>(null);
  const [viewport, setViewport] = useState<FloatBox>({ x: 0, y: 0, width: win.width, height: win.height });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const browser = globalThis as unknown as Browser;
    const measure = () => {
      const v = browser.visualViewport;
      const next = v ? { x: v.offsetLeft, y: v.offsetTop, width: v.width, height: v.height } : { x: 0, y: 0, width: win.width, height: win.height };
      setViewport(old => old.x === next.x && old.y === next.y && old.width === next.width && old.height === next.height ? old : next);
      const node = probe.current as unknown as Node | null;
      const save = (x: number, y: number, width: number, height: number) => setBox(old => old?.x === x && old.y === y && old.width === width && old.height === height ? old : { x, y, width, height });
      const r = node?.getBoundingClientRect?.();
      if (r) {
        if (r.width > 0 && r.height > 0) wasVisible.current = true;
        else if (wasVisible.current) closeRef.current?.(); // A kept tab was hidden: its portal must leave too.
        save(r.left, r.top, r.width, r.height);
      }
      else node?.measureInWindow?.(save);
    };
    measure();
    if (Platform.OS !== "web") return;
    browser.addEventListener?.("resize", measure); browser.addEventListener?.("scroll", measure, true);
    browser.visualViewport?.addEventListener("resize", measure); browser.visualViewport?.addEventListener("scroll", measure);
    const observer = browser.ResizeObserver ? new browser.ResizeObserver(measure) : null;
    if (probe.current) observer?.observe(probe.current);
    return () => { browser.removeEventListener?.("resize", measure); browser.removeEventListener?.("scroll", measure, true); browser.visualViewport?.removeEventListener("resize", measure); browser.visualViewport?.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [win.width, win.height]);
  useEffect(() => {
    if (Platform.OS !== "web" || !onClose || !dismissOnEscape) return;
    const doc = (globalThis as { document?: { addEventListener(t: string, f: (e: { key: string; preventDefault(): void }) => void): void; removeEventListener(t: string, f: (e: { key: string; preventDefault(): void }) => void): void } }).document;
    const close = (e: { key: string; preventDefault(): void }) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    doc?.addEventListener("keydown", close);
    return () => doc?.removeEventListener("keydown", close);
  }, [onClose, dismissOnEscape]);
  const target = anchor ? { ...anchor, width: 0, height: 0 } : box;
  const area = !modal && box ? intersectFloatBox(box, viewport) : viewport;
  const at = floatingPlacement(target ?? { x: 0, y: 0, width: 0, height: 0 }, { width, height: size?.height ?? 0 }, area, anchor ? "point" : side);
  const content = <View ref={contentRef as never} role={role} aria-label={label} {...({ dataSet: { ...dataSet, floatingOwner: owner } } as object)}
    onLayout={e => { const next = e.nativeEvent.layout; setSize(old => old?.width === next.width && old.height === next.height ? old : { width: next.width, height: next.height }); onSize?.(next); }}
    style={[style, { position: "absolute", ...at, left: at.left - (modal ? 0 : box?.x ?? 0), top: at.top - (modal ? 0 : box?.y ?? 0), zIndex: 1000, opacity: size && target ? 1 : 0, overflow: "hidden" }]}>
    <ScrollView style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ gap: style?.gap }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  </View>;
  return <>
    <View ref={probe} nativeID={owner} collapsable={false} pointerEvents="none" style={{ position: "absolute", inset: 0 }} />
    {/* Web Escape belongs to keydown, never RN Web's additional keyup callback. Native keeps hardware Back.
        Nonmodal keys help stays within its visible pane, so the list behind it keeps its keyboard walk. */}
    {modal ? <RNModal transparent visible animationType="none" onRequestClose={Platform.OS === "web" ? undefined : onClose}>
      <View style={{ flex: 1 }}>
        <Pressable accessible={false} focusable={false} onPress={onClose} style={{ position: "absolute", inset: 0 }} />
        {content}
      </View>
    </RNModal> : content}
  </>;
}
