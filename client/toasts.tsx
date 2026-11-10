import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";
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

export { pushToast, dismissToast, runAction, openQuestion, useQuestionOpener, hasToastHost } from "./toast-store";
import { dismissToast, emit, hosts, subscribe, toastsNow, type ToastItem } from "./toast-store";
let nextHost = 1;

// The host toast's tokens (Paseo 0.15 app-toast): radius 2xl, padding 8/12, gap 8, top 12 below the safe area.
const TOP = 12;
const GAP = 8;

/** Web: where Paseo's own toast ends, so Follow-up's stack sits below it rather than on top of it. */
function hostToastBottom(): number {
  type Box = { bottom: number; height: number };
  type El = { closest(sel: string): El | null; parentElement: El | null; getBoundingClientRect(): Box };
  const doc = (globalThis as { document?: { querySelector(sel: string): El | null } }).document;
  if (Platform.OS !== "web" || !doc) return 0;
  const node = doc.querySelector('[data-testid="app-toast-message"]');
  const box = (node?.closest('[role="alert"], [aria-live]') ?? node?.parentElement)?.getBoundingClientRect();
  return box && box.height > 0 ? box.bottom : 0;
}

/**
 * Mounted beside WhatsNewGate on every Follow-up root (Home, the panel, the sidebar row). Only the first mounted
 * host draws, so two open surfaces never show the same toast twice.
 */
export function ToastHost({ theme, compact }: { theme: Theme; compact: boolean }) {
  const [hostId] = useState(() => nextHost++);
  useEffect(() => { hosts.push(hostId); emit(); return () => { hosts.splice(hosts.indexOf(hostId), 1); emit(); }; }, [hostId]);
  const list = useSyncExternalStore(subscribe, toastsNow, toastsNow);
  const leader = useSyncExternalStore(subscribe, () => hosts[0] === hostId, () => false);
  const [hostBottom, setHostBottom] = useState(0);
  // Only while Follow-up shows a toast: watch for Paseo's own above it (one cheap DOM read a quarter second).
  useEffect(() => {
    if (!leader || !list.length || Platform.OS !== "web") { setHostBottom(0); return; }
    const tick = () => setHostBottom(b => { const next = hostToastBottom(); return next === b ? b : next; });
    tick(); const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [leader, list.length]);
  if (!leader || !list.length) return null;
  const top = hostBottom ? hostBottom + GAP : TOP;
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
  const icon = item.tone === "error" ? "CircleAlert" : item.tone === "warning" ? "TriangleAlert" : item.tone === "success" ? "CircleCheck" : "Info";
  return <View accessibilityRole="alert" accessibilityLiveRegion={item.tone === "error" ? "assertive" : "polite"}
    // Never steals focus: no autoFocus, and the alert role announces it.
    style={{ width: "92%", maxWidth: 480, alignItems: "center" }}>
    <View style={{ alignSelf: "center", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12,
      borderRadius: 16, borderWidth: 1, borderColor: item.tone === "error" ? tone : c.border, backgroundColor: c.surface0,
      shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }}>
      <Icon name={icon} size={15} color={tone} />
      <Text style={{ flexShrink: 1, color: c.foreground, fontSize: 14, lineHeight: 20 }}>{item.message}</Text>
      {item.actions.map(a => <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={`${a.label}: ${item.message}`} hitSlop={compact ? 8 : 4}
        onPress={() => { dismissToast(item.id); a.onPress(); }}
        style={(s: { pressed: boolean; hovered?: boolean }) => ({ minHeight: compact ? 36 : 24, paddingHorizontal: 8, borderRadius: 8, justifyContent: "center", backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
        <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{a.label}</Text>
      </Pressable>)}
      {item.sticky && <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={compact ? 10 : 6} onPress={() => dismissToast(item.id)}
        style={(s: { pressed: boolean; hovered?: boolean }) => ({ padding: 4, borderRadius: 8, backgroundColor: s.pressed || s.hovered ? c.surface2 : "transparent" })}>
        <Icon name="X" size={14} color={c.foregroundMuted} />
      </Pressable>}
    </View>
  </View>;
}

