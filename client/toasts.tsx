import { useEffect, useState, useSyncExternalStore } from "react";
import { AppRegistry, Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { Component, type ReactNode } from "react";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Theme } from "./kit";

/**
 * Follow-up's one toast system. Paseo's toast API (`useToast`) shows one message at a time, with no buttons and no
 * toast that stays, so an error that needs Retry and Open can't go through it. ToastHost draws Follow-up's toasts
 * in the host toast's own place and shape (top centre, 92 % up to 480 px, surface0, a 1 px border that turns
 * destructive on an error, md shadow) and stacks them below it. Every Follow-up success and error goes here while a
 * Follow-up root is mounted; with none mounted, `runAction` falls back to the host toast, so nothing is lost silently.
 * Toasts appear without motion (nothing to reduce) and never take focus.
 */

export { pushToast, dismissToast, notice, runAction, runUndoable, openQuestion, useQuestionOpener, hasToastHost } from "./toast-store";
import { dismissToast, emit, holdToast, hosts, subscribe, toastsNow, undoShortcut, type KeyLike, type ToastItem } from "./toast-store";
type UndoKey = KeyLike & { preventDefault(): void; stopPropagation(): void };
const isMac = () => /Mac|iPhone|iPad/.test((globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? "");
/** Web only: the Undo button's name says its key, so screen readers and hover-less users can find it. */
const undoKeyHint = () => Platform.OS === "web" ? (isMac() ? " (⌘Z)" : " (Ctrl+Z)") : "";
let nextHost = 1;

// The host toast's tokens (Paseo 0.15 app-toast): radius 2xl, padding 8/12, gap 8, top 12 below the safe area.
const TOP = 12;
const GAP = 8;

/** Web: where Paseo's own toast ends, so Follow-up's stack sits below it rather than on top of it. */
/** Where Paseo's own toast last sat (its top), so Follow-up's lands in the same place when it shows alone. */
let hostTop = 0;
function hostToastBottom(): number {
  type Box = { top: number; bottom: number; height: number };
  type El = { closest(sel: string): El | null; parentElement: El | null; getBoundingClientRect(): Box };
  const doc = (globalThis as { document?: { querySelector(sel: string): El | null } }).document;
  if (Platform.OS !== "web" || !doc) return 0;
  const node = doc.querySelector('[data-testid="app-toast-message"]');
  const box = (node?.closest('[role="alert"], [aria-live]') ?? node?.parentElement)?.getBoundingClientRect();
  if (box && box.height > 0) { hostTop = box.top; return box.bottom; }
  return 0;
}

/**
 * Mounted beside WhatsNewGate on every Follow-up root (Home, the panel, the sidebar row). Only the first mounted
 * host draws, so two open surfaces never show the same toast twice.
 */
export function ToastHost({ theme, compact }: { theme: Theme; compact: boolean }) {
  const [hostId] = useState(() => nextHost++);
  useEffect(() => { hosts.push(hostId); emit(); return () => { hosts.splice(hosts.indexOf(hostId), 1); emit(); }; }, [hostId]);
  const leader = useSyncExternalStore(subscribe, () => hosts[0] === hostId, () => false);
  // Web: every Follow-up root sits inside a clipped container (sidebar row, panel, Home), where position: fixed is
  // trapped and the toast never shows. The leader hands its theme to a layer of its own on document.body.
  const layered = Platform.OS === "web" && webLayer();
  useEffect(() => { if (layered && leader) setLayerProps({ theme, compact }); }, [layered, leader, theme, compact]);
  // Ctrl/Cmd+Z runs the showing Undo toast's Undo (undoShortcut decides when). One listener: the leader's.
  useEffect(() => {
    const doc = (globalThis as { document?: { addEventListener(t: string, f: (e: UndoKey) => void, c: boolean): void; removeEventListener(t: string, f: (e: UndoKey) => void, c: boolean): void } }).document;
    if (Platform.OS !== "web" || !leader || !doc) return;
    const mac = isMac();
    // Stopped here: the host's own Ctrl/Cmd+Z mustn't also act on the same press.
    const onKey = (e: UndoKey) => { if (undoShortcut(e, mac)) { e.preventDefault(); e.stopPropagation(); } };
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, [leader]);
  if (layered) return null;
  return leader ? <ToastStack theme={theme} compact={compact} /> : null;
}

// ---------- web: a top-level layer outside every Follow-up container ----------

let layerProps: { theme: Theme; compact: boolean } | null = null;
const layerListeners = new Set<() => void>();
function setLayerProps(next: { theme: Theme; compact: boolean }) { layerProps = next; for (const l of layerListeners) l(); }
const LAYER_KEY = "follow-up-toasts";
let layerMounted: boolean | null = null;

/** Mounts the toast layer once: a pointer-transparent div on document.body with its own react-native-web root. */
function webLayer(): boolean {
  if (layerMounted !== null) return layerMounted;
  try {
    type El = { id: string; setAttribute(k: string, v: string): void; appendChild(c: El): void };
    const doc = (globalThis as { document?: { body?: El; createElement(tag: string): El } }).document;
    if (!doc?.body || typeof AppRegistry?.runApplication !== "function") return (layerMounted = false);
    const root = doc.createElement("div");
    root.id = LAYER_KEY;
    root.setAttribute("style", "position:fixed;inset:0 0 auto 0;height:0;overflow:visible;z-index:2147483000;pointer-events:none;");
    doc.body.appendChild(root);
    AppRegistry.registerComponent(LAYER_KEY, () => ToastLayer);
    AppRegistry.runApplication(LAYER_KEY, { rootTag: root, initialProps: {} });
    return (layerMounted = true);
  } catch { return (layerMounted = false); }
}

function ToastLayer() {
  const props = useSyncExternalStore(l => { layerListeners.add(l); return () => { layerListeners.delete(l); }; }, () => layerProps, () => layerProps);
  const hosted = useSyncExternalStore(subscribe, () => hosts.length > 0, () => false);
  if (!props || !hosted) return null;
  return <IconSafe><ToastStack theme={props.theme} compact={props.compact} /></IconSafe>;
}

/** The layer is a separate root; if a host component it uses ever needs Paseo's context there, fail to no toast, never a crash. */
class IconSafe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

function ToastStack({ theme, compact }: { theme: Theme; compact: boolean }) {
  const list = useSyncExternalStore(subscribe, toastsNow, toastsNow);
  const [hostBottom, setHostBottom] = useState(0);
  // Only while Follow-up shows a toast: watch for Paseo's own above it (one cheap DOM read a quarter second).
  useEffect(() => {
    if (!list.length || Platform.OS !== "web") { setHostBottom(0); return; }
    const tick = () => setHostBottom(b => { const next = hostToastBottom(); return next === b ? b : next; });
    tick(); const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [list.length]);
  if (!list.length) return null;
  // Alone, it takes Paseo's toast place: below the app header (measured once a host toast has shown), not over it.
  const top = hostBottom ? hostBottom + GAP : hostTop || (Platform.OS === "web" ? (compact ? 72 : 44) : TOP);
  const position = Platform.OS === "web"
    ? { position: "fixed", top: `max(${top}px, calc(env(safe-area-inset-top) + ${top}px))` } as unknown as object
    : { position: "absolute" as const, top: top + (compact ? 44 : 0) };
  return <View pointerEvents="box-none" style={[{ left: 16, right: 16, zIndex: 1000, alignItems: "center", gap: GAP }, position]}>
    {list.map(item => <ToastView key={item.id} item={item} theme={theme} compact={compact} />)}
  </View>;
}

function ToastView({ item, theme, compact }: { item: ToastItem; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const tone = item.tone === "error" ? c.statusDanger : item.tone === "warning" ? c.statusWarning : item.tone === "success" ? c.statusSuccess : c.foregroundMuted;
  const opens = item.actions.some(a => a.label === "Open");
  const icon = item.tone === "error" ? "CircleAlert" : item.tone === "warning" ? "TriangleAlert" : item.tone === "success" ? "CircleCheck" : "Info";
  // pointerEvents="auto": the web layer and the stack are pointer-transparent (pointer-events is inherited), so the
  // toast itself must take clicks back, or Undo, Retry and Open can't be pressed.
  return <Pressable pointerEvents="auto" accessibilityRole="alert" accessibilityLiveRegion={item.tone === "error" ? "assertive" : "polite"} focusable={false}
    // Never steals focus: no autoFocus, and the alert role announces it. Hover or focus inside holds its timer.
    onHoverIn={() => holdToast(item.id, true)} onHoverOut={() => holdToast(item.id, false)}
    onFocus={() => holdToast(item.id, true)} onBlur={() => holdToast(item.id, false)}
    style={{ width: "92%", maxWidth: 480, alignItems: "center" }}>
    <View style={{ alignSelf: "center", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12,
      borderRadius: 16, borderWidth: 1, borderColor: item.tone === "error" ? tone : c.border, backgroundColor: c.surface0,
      shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }}>
      {/* Never crushed by a wrapping message. */}
      <View style={{ flexShrink: 0 }}><Icon name={icon} size={15} color={tone} /></View>
      {/* With Open the message is one short line and the reason waits behind Open, so it may clamp; otherwise it is the
          only copy of the reason and shows in full. */}
      <Text style={{ flexShrink: 1, color: c.foreground, fontSize: 14, lineHeight: 20 }} numberOfLines={opens ? 2 : undefined}>{item.message}</Text>
      {item.actions.map(a => <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={`${a.label}${a.label === "Undo" ? undoKeyHint() : ""}: ${item.message}`} hitSlop={8}
        onPress={() => { dismissToast(item.id); a.onPress(); }}
        // Desktop matches the host toast's height (no 24 px floor); phones keep 36 px and use hitSlop instead of padding.
        style={(s: { pressed: boolean; hovered?: boolean }) => ({ minHeight: compact ? 36 : 20, paddingHorizontal: compact ? 4 : 8, borderRadius: 8, justifyContent: "center", backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
        <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{a.label}</Text>
      </Pressable>)}
      {item.sticky && <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={compact ? 10 : 6} onPress={() => dismissToast(item.id)}
        style={(s: { pressed: boolean; hovered?: boolean }) => ({ padding: compact ? 6 : 4, minWidth: compact ? 28 : 24, minHeight: compact ? 28 : 24, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
        <Icon name="X" size={14} color={c.foregroundMuted} />
      </Pressable>}
    </View>
  </Pressable>;
}

