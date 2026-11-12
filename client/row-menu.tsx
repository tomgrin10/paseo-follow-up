import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, useWindowDimensions, View, type ViewStyle } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { flatItems, isMenuKey, moveFocus, placeMenu, sheetArmed, type RowMenuItem, type RowMenuSection } from "../shared/row-menu";
import type { Workstream } from "../shared/home";
import { Button, text, type Theme } from "./kit";
import { isLight, withAlpha, type Colors } from "./theme";

/**
 * The row menu's two shapes: a popover at the pointer (right-click, or the menu key at the row) and, on touch, a sheet
 * (long-press). The contents come from `rowMenu()` in shared/row-menu.ts; this file only draws and drives them.
 */

/** Where the menu opens: a viewport point for the popover, or null for the touch sheet. */
export type MenuAnchor = { x: number; y: number } | null;
/** `keyboard`: opened with the menu key, so the first item takes focus (a pointer open starts with nothing active). */
export type RowMenuOpen = { s: Workstream; anchor: MenuAnchor; sections: RowMenuSection[]; returnTo: DomNode | null; keyboard?: boolean };
export type OpenRowMenu = (s: Workstream, anchor: MenuAnchor, node: DomNode | null, keyboard?: boolean) => void;

const web = Platform.OS === "web";
/** The slice of the DOM this file touches (the plugin compiles without the DOM lib). */
type DomEvent = { key: string; shiftKey?: boolean; clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void };
export type DomNode = {
  addEventListener(type: string, f: (e: DomEvent) => void, capture?: boolean): void; removeEventListener(type: string, f: (e: DomEvent) => void, capture?: boolean): void;
  getBoundingClientRect(): { left: number; bottom: number }; focus(): void; querySelector?(q: string): DomNode | null; querySelectorAll?(q: string): ArrayLike<DomNode>;
};
const doc = () => (globalThis as { document?: Pick<DomNode, "addEventListener" | "removeEventListener"> }).document;
/** A long-press on Android's web view also fires `contextmenu`; the second open within this window is the same gesture. */
const SAME_GESTURE_MS = 700;

/**
 * Wires a row to the menu: a DOM `contextmenu` listener on the row's own node (so the browser's menu is replaced only
 * on rows, never elsewhere), the menu key or Shift+F10 while the row has focus, and `onLongPress` for touch.
 */
export function useRowMenuTrigger(s: Workstream | undefined, maybeOpen: OpenRowMenu | undefined, touch: boolean) {
  const open = s ? maybeOpen : undefined;
  const ref = useRef<View>(null);
  const last = useRef(0);
  const sRef = useRef(s); sRef.current = s;
  const fire = useCallback((anchor: MenuAnchor, node: DomNode | null, keyboard = false) => {
    if (!open || Date.now() - last.current < SAME_GESTURE_MS) return;
    last.current = Date.now();
    if (sRef.current) open(sRef.current, anchor, node, keyboard);
  }, [open]);
  useEffect(() => {
    if (!web || !open) return;
    const node = ref.current as unknown as DomNode | null;
    if (!node?.addEventListener) return;
    const atRow = (): MenuAnchor => { const r = node.getBoundingClientRect(); return { x: r.left + 24, y: r.bottom - 4 }; };
    const onContext = (e: DomEvent) => {
      e.preventDefault(); e.stopPropagation();
      // A keyboard-raised contextmenu has no pointer position: open at the row.
      const pointer = !!(e.clientX || e.clientY);
      fire(touch ? null : pointer ? { x: e.clientX, y: e.clientY } : atRow(), node, !pointer);
    };
    const onKey = (e: DomEvent) => { if (!isMenuKey(e)) return; e.preventDefault(); e.stopPropagation(); fire(touch ? null : atRow(), node, true); };
    node.addEventListener("contextmenu", onContext);
    node.addEventListener("keydown", onKey);
    return () => { node.removeEventListener("contextmenu", onContext); node.removeEventListener("keydown", onKey); };
  }, [open, touch, fire]);
  const onLongPress = open && touch ? () => fire(null, ref.current as unknown as DomNode | null) : undefined;
  return { ref, onLongPress };
}

/** The open menu, drawn once by the list. Picking a leaf calls `onPick` and the caller closes the menu at once. */
export function RowMenu({ menu, theme, onClose, onPick }: { menu: RowMenuOpen; theme: Theme; onClose: () => void; onPick: (item: RowMenuItem) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RowMenuItem | null>(null);
  const close = useCallback(() => {
    onClose();
    // Focus goes back to the row the menu came from.
    const back = menu.returnTo;
    if (back?.focus) setTimeout(() => back.focus(), 0);
  }, [onClose, menu.returnTo]);
  const choose = useCallback((item: RowMenuItem) => {
    if (item.children) { setExpanded(k => k === item.key ? null : item.key); return; }
    if (item.confirm && confirm?.key !== item.key) { setConfirm(item); return; }
    close(); onPick(item);
  }, [close, onPick, confirm]);
  const body = { menu, theme, expanded, setExpanded, confirm, setConfirm, choose, close };
  return menu.anchor ? <Popover {...body} anchor={menu.anchor} /> : <Sheet {...body} />;
}

type BodyProps = { menu: RowMenuOpen; theme: Theme; expanded: string | null; setExpanded: (k: string | null) => void; confirm: RowMenuItem | null; setConfirm: (i: RowMenuItem | null) => void; choose: (i: RowMenuItem) => void; close: () => void };

function Popover({ menu, theme, expanded, setExpanded, confirm, setConfirm, choose, close, anchor }: BodyProps & { anchor: { x: number; y: number } }) {
  const c = theme.colors;
  const viewport = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const items = flatItems(menu.sections, expanded);
  const [active, setActive] = useState(menu.keyboard ? 0 : -1);
  // The ring shows only while the keyboard drives the menu; hover keeps the quiet fill.
  const [keys, setKeys] = useState(!!menu.keyboard);
  const nodes = useRef<(DomNode | null)[]>([]);
  const confirmRef = useRef<DomNode | null>(null);
  const focusAt = (i: number) => { setActive(i); nodes.current[i]?.focus?.(); };
  const confirmButtons = () => Array.from(confirmRef.current?.querySelectorAll?.("[tabindex]") ?? []);
  useLayoutEffect(() => { if (confirm) setTimeout(() => confirmButtons()[0]?.focus(), 0); else if (size && active >= 0) setTimeout(() => nodes.current[active]?.focus?.(), 0); }, [size, confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!web) return;
    const onKey = (e: DomEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (confirm) setConfirm(null); else close(); return; }
      if (confirm) {
        // The confirm step keeps focus on its two buttons: Tab, Shift+Tab and the arrows move between Cancel and the action.
        if (["Tab", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault(); e.stopPropagation();
          const buttons = confirmButtons(); const at = buttons.findIndex(b => b === (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement);
          buttons[at === 1 ? 0 : 1]?.focus();
        }
        return;
      }
      if (e.key === "Tab") { e.preventDefault(); close(); return; }
      setKeys(true);
      const item = items[active];
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); focusAt(moveFocus(active, items.length, e.key)); return; }
      if (e.key === "ArrowRight" && item?.children) { e.preventDefault(); setExpanded(item.key); setTimeout(() => focusAt(active + 1), 0); return; }
      if (e.key === "ArrowLeft") {
        // Only from inside the open Later: back to Later, closed.
        const parent = items.findIndex(i => i.key === expanded);
        const inside = parent >= 0 && !!items[parent].children?.some(ch => ch.key === item?.key);
        if (inside) { e.preventDefault(); setExpanded(null); setTimeout(() => focusAt(parent), 0); }
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && item) {
        e.preventDefault(); e.stopPropagation();
        if (item.children) { setExpanded(expanded === item.key ? null : item.key); if (expanded !== item.key) setTimeout(() => focusAt(active + 1), 0); }
        else choose(item);
      }
    };
    const d = doc();
    d?.addEventListener("keydown", onKey, true);
    return () => d?.removeEventListener("keydown", onKey, true);
  });

  // `fixed` is relative to the nearest transformed ancestor (the workspace panel is one), not always the window: the
  // overlay measures where it really starts and how big it is, and the menu is placed in that box.
  const overlay = useRef<DomNode | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const r = (overlay.current as unknown as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null)?.getBoundingClientRect?.();
    if (r && r.width > 0) setBox({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, [viewport.width, viewport.height]);
  const local = box ? { x: anchor.x - box.x, y: anchor.y - box.y } : anchor;
  // Drawn invisibly once to measure, then placed inside the box (flipped up or left near an edge).
  const at = size ? placeMenu(local, size, box ?? viewport) : { left: local.x, top: local.y };
  const fixed = { position: web ? "fixed" : "absolute" } as unknown as ViewStyle;
  return <View ref={overlay as never} style={[fixed, { top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }]}>
    {/* Outside the menu: a click or another right-click closes it. */}
    <Pressable accessible={false} onPress={close} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
    <View role={confirm ? "alertdialog" : "menu"} aria-label={confirm ? confirm.label.replace(/…$/, "") : `Actions for ${menu.s.title}`}
      onLayout={e => { const { width, height } = e.nativeEvent.layout; if (!size || size.height !== height || size.width !== width) setSize({ width, height }); }}
      style={{ position: "absolute", left: at.left, top: at.top, opacity: size ? 1 : 0, width: 256, maxHeight: (box ?? viewport).height - 16, paddingVertical: 4, borderRadius: 8, backgroundColor: c.surface1, ...floating(c) }}>
      {confirm ? <ConfirmBody theme={theme} item={confirm} onCancel={() => setConfirm(null)} onConfirm={() => choose(confirm)} cancelRef={confirmRef} /> : menu.sections.map((sec, si) => <View key={sec.key} style={si ? { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: c.border } : undefined}>
        {sec.items.map(item => {
          const open = expanded === item.key;
          const row = (i: RowMenuItem, child: boolean) => {
            const index = items.findIndex(x => x.key === i.key);
            return <MenuRow key={i.key} item={i} theme={theme} touch={false} child={child} open={open} active={index === active} ring={keys && index === active}
              nodeRef={n => { nodes.current[index] = n; }} onHover={() => { setKeys(false); setActive(index); }} onPress={() => { setActive(index); choose(i); }} />;
          };
          return <View key={item.key}>{row(item, false)}{open && item.children && <View role="group" aria-label={item.label}>{item.children.map(ch => row(ch, true))}</View>}</View>;
        })}
      </View>)}
    </View>
  </View>;
}

function Sheet({ menu, theme, expanded, confirm, setConfirm, choose: pick, close }: BodyProps) {
  const c = theme.colors; const t = text(c, true);
  const state = [menu.s.word, menu.s.line].filter(Boolean).join(" · ");
  // The long-press that opened the sheet must not also pick the item that slid up under the finger (sheetArmed).
  const released = useRef<number | null>(web ? null : 0);
  useEffect(() => {
    if (!web) return;
    const d = doc();
    const lift = () => { if (released.current === null) released.current = Date.now(); };
    const onKey = (e: DomEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    d?.addEventListener("touchend", lift, true); d?.addEventListener("pointerup", lift, true); d?.addEventListener("keydown", onKey, true);
    return () => { d?.removeEventListener("touchend", lift, true); d?.removeEventListener("pointerup", lift, true); d?.removeEventListener("keydown", onKey, true); };
  }, [close]);
  const choose = (item: RowMenuItem) => { if (sheetArmed(released.current, Date.now())) pick(item); };
  return <Modal title={menu.s.title} open onOpenChange={o => { if (!o) close(); }}>
    <Modal.Content contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 0, gap: 0 }}>
      {confirm ? <View style={{ paddingHorizontal: 16 }}><ConfirmBody theme={theme} item={confirm} touch onCancel={() => setConfirm(null)} onConfirm={() => choose(confirm)} /></View>
        : <View role="menu" aria-label={`Actions for ${menu.s.title}`}>
          {/* Which row this is, the way the list says it, so a long-press on the wrong row shows before a pick. */}
          {!!state && <Text numberOfLines={2} style={[t.meta, { paddingHorizontal: 16, paddingBottom: 8 }]}>{state}</Text>}
          {menu.sections.map((sec, si) => <View key={sec.key} style={si || state ? { marginTop: si ? 6 : 0, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.border } : undefined}>
            {sec.items.map(item => <View key={item.key}>
              <MenuRow item={item} theme={theme} touch open={expanded === item.key} onPress={() => choose(item)} />
              {/* Later's times as one row of chips: one row of height instead of four, Home's density. */}
              {expanded === item.key && item.children && <View role="group" aria-label={item.label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 46, paddingRight: 16, paddingBottom: 10 }}>
                {item.children.map(ch => <Button key={ch.key} theme={theme} compact kind="secondary" title={ch.label.replace(/^In 1 hour$/, "1 hour")} accessibilityLabel={`Later: ${ch.label}`} onPress={() => choose(ch)} />)}
              </View>}
            </View>)}
          </View>)}
        </View>}
    </Modal.Content>
  </Modal>;
}

function MenuRow({ item, theme, touch, child = false, open = false, active = false, ring = false, nodeRef, onHover, onPress }: {
  item: RowMenuItem; theme: Theme; touch: boolean; child?: boolean; open?: boolean; active?: boolean; ring?: boolean; nodeRef?: (n: DomNode | null) => void; onHover?: () => void; onPress: () => void;
}) {
  const c = theme.colors; const t = text(c, touch);
  // Later opens in place (a disclosure), so it says expanded/collapsed, not "has a submenu".
  return <Pressable ref={nodeRef as never} accessibilityRole="menuitem" aria-expanded={item.children ? open : undefined}
    accessibilityState={item.children ? { expanded: open } : undefined} accessibilityLabel={item.hint ? `${item.label}: ${item.hint}` : item.label}
    onPress={onPress} onHoverIn={onHover}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: touch ? 12 : 9, minHeight: touch ? 48 : 32, paddingVertical: item.hint ? (touch ? 6 : 4) : 0,
      paddingLeft: (touch ? 16 : 10) + (child ? (touch ? 30 : 23) : 0), paddingRight: touch ? 16 : 10,
      marginHorizontal: touch ? 0 : 4, borderRadius: touch ? 0 : 5,
      // Touch has no hover: a fill without a finger on it reads as selected.
      backgroundColor: state.pressed ? c.surface2 : active || (!touch && (state as { hovered?: boolean }).hovered) ? withAlpha(c.foreground, 0.07) : "transparent",
      // The keyboard's focus ring: a 2px ring at 3:1 or better, only while keys drive the menu.
      ...(ring ? { boxShadow: `inset 0 0 0 2px ${withAlpha(c.foreground, 0.55)}` } as object : {}),
      ...(web ? { outlineStyle: "none" } as object : {}) })}>
    <View style={{ width: touch ? 18 : 14, alignItems: "center" }}>
      {!child && <Icon name={item.icon} size={touch ? 17 : 14} color={c.foregroundMuted} />}
    </View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={t.body}>{item.label}</Text>
      {!!item.hint && <Text numberOfLines={1} style={touch ? t.meta : t.small}>{item.hint}</Text>}
    </View>
    {item.children && <Icon name={open ? "ChevronDown" : "ChevronRight"} size={touch ? 16 : 13} color={c.foregroundMuted} />}
  </Pressable>;
}

function ConfirmBody({ theme, item, touch = false, onCancel, onConfirm, cancelRef }: { theme: Theme; item: RowMenuItem; touch?: boolean; onCancel: () => void; onConfirm: () => void; /** The body's node: the confirm step finds its two buttons in it (Cancel first). */ cancelRef?: { current: DomNode | null } }) {
  const c = theme.colors;
  return <View ref={cancelRef as never} style={{ gap: touch ? 14 : 10, paddingHorizontal: touch ? 0 : 12, paddingVertical: touch ? 8 : 8 }}>
    <Text style={{ color: c.foreground, fontSize: touch ? 15 : 13, lineHeight: touch ? 21 : 18 }}>{item.confirm}</Text>
    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
      <Button theme={theme} compact={touch} kind="ghost" title="Cancel" onPress={onCancel} />
      <Button theme={theme} compact={touch} kind="danger" title={item.label.replace(/…$/, "")} onPress={onConfirm} />
    </View>
  </View>;
}

/** A floating surface: Home's raised ring (DESIGN.md) plus a lift that still reads on a near-black page. */
function floating(c: Colors): ViewStyle {
  return { boxShadow: isLight(c)
    ? "0px 0px 0px 1px rgba(0, 0, 0, 0.08), 0px 4px 12px rgba(0, 0, 0, 0.10), 0px 12px 32px rgba(0, 0, 0, 0.10)"
    : "0px 0px 0px 1px rgba(255, 255, 255, 0.12), 0px 8px 28px rgba(0, 0, 0, 0.55)" } as ViewStyle;
}
