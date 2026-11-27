import { useEffect, useRef, useState } from "react";
import { Image, Modal as RNModal, Platform, View, useWindowDimensions } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { Spinner, useReducedMotion } from "./motion";
import type { Theme } from "./kit";
import { fitInto } from "../shared/card-view";
import type { MediaSource } from "../shared/cards";
import { useMediaData } from "./card-data";
import { BeforeAfter } from "./card-blocks";

/**
 * A card's images larger, inside Paseo (never a browser tab): the image fitted to the window on a dark backdrop, the
 * X top right, ‹ › between the items (and ← →), Esc or the X closes. A before/after pair is where comparing has to be
 * easy on a 360 px phone: both images sit at the same place and size, so one switch (Before | After, a big thumb-reach
 * control at the bottom) flips them without moving anything, and pressing and holding the image shows the other side
 * until you let go. A window wide enough for both (from 900 px) shows the pair side by side instead.
 */
export type Viewed = { items: { src: MediaSource; before?: MediaSource; label?: string; caption?: string }[]; index: number };

const hashOf = (s: MediaSource | undefined) => s && "hash" in s ? s.hash : null;
const SIDE_BY_SIDE_MIN = 900;

export function MediaViewer({ viewed, workspaceId, theme, compact, onClose }: { viewed: Viewed; workspaceId: string; theme: Theme; compact: boolean; onClose: () => void }) {
  const win = useWindowDimensions();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(viewed.index);
  const [side, setSide] = useState<"before" | "after">("after");
  const [holding, setHolding] = useState(false);
  const item = viewed.items[index];
  const pair = !!item?.before;
  const wide = pair && win.width >= SIDE_BY_SIDE_MIN;
  const shownSide = holding ? (side === "after" ? "before" : "after") : side;
  const count = viewed.items.length;
  const go = (d: number) => { setIndex(i => (i + d + count) % count); setHolding(false); };
  const close = useRef<View>(null);
  useEffect(() => { (close.current as unknown as { focus?: () => void } | null)?.focus?.(); }, []);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const d = (globalThis as { document?: { addEventListener(t: string, f: (e: { key: string; preventDefault(): void; stopPropagation(): void }) => void, c: boolean): void; removeEventListener(t: string, f: (e: { key: string }) => void, c: boolean): void } }).document;
    const onKey = (e: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight" && count > 1) { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" && count > 1) { e.preventDefault(); go(-1); }
      else if (pair && !wide && (e.key === "b" || e.key === "a")) setSide(e.key === "b" ? "before" : "after");
    };
    d?.addEventListener("keydown", onKey as never, true);
    return () => d?.removeEventListener("keydown", onKey as never, true);
  });
  if (!item) return null;
  const phone = win.width < 768;
  const top = phone ? 56 : 60; const bottom = pair && !wide ? (phone ? 112 : 96) : count > 1 ? 72 : 32; const sideGap = phone ? 0 : 56;
  const box = wide ? { width: Math.floor((win.width - 2 * sideGap - 16) / 2), height: win.height - top - bottom } : { width: win.width - 2 * sideGap, height: win.height - top - bottom };
  const label = item.label ?? (item.src as { name?: string }).name ?? "Image";
  const layer = <View role="dialog" aria-modal aria-label={label} accessibilityViewIsModal style={{ position: Platform.OS === "web" ? "fixed" as never : "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, backgroundColor: "#08080a" }}>
    <View style={{ height: top, flexDirection: "row", alignItems: "center", paddingHorizontal: phone ? 8 : 16, gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, paddingLeft: phone ? 8 : 0 }}>
        <Text numberOfLines={1} style={{ color: "#ffffff", fontSize: phone ? 15 : 14, lineHeight: 20, fontWeight: "600" }}>{label}</Text>
        <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, lineHeight: 16 }}>{[count > 1 ? `${index + 1} of ${count}` : null, item.caption ?? null].filter(Boolean).join(" · ")}</Text>
      </View>
      <Pressable ref={close} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}
        style={s => ({ width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: s.pressed ? "rgba(255,255,255,0.18)" : (s as { hovered?: boolean }).hovered ? "rgba(255,255,255,0.1)" : "transparent" })}>
        <Icon name="X" size={phone ? 22 : 18} color="#ffffff" />
      </Pressable>
    </View>
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: sideGap }}>
      {wide ? <>
        <Big src={item.before!} box={box} workspaceId={workspaceId} label={`${label}, before`} tag="Before" />
        <Big src={item.src} box={box} workspaceId={workspaceId} label={`${label}, after`} tag="After" />
      </> : <Pressable accessible={pair} accessibilityRole={pair ? "button" : undefined} accessibilityLabel={pair ? `Hold to see ${side === "after" ? "before" : "after"}` : undefined}
        onPressIn={pair ? () => setHolding(true) : undefined} onPressOut={pair ? () => setHolding(false) : undefined} delayLongPress={10_000}>
        <Big src={pair && shownSide === "before" ? item.before! : item.src} box={box} workspaceId={workspaceId} label={pair ? `${label}, ${shownSide}` : label} tag={pair ? (shownSide === "before" ? "Before" : "After") : undefined} />
      </Pressable>}
    </View>
    <View style={{ height: bottom, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {count > 1 && <Nav icon="ChevronLeft" label="Previous" onPress={() => go(-1)} />}
        {pair && !wide && <BeforeAfter value={side} onChange={v => { setSide(v); setHolding(false); }} theme={{ ...theme, colors: { ...theme.colors, surface0: "#2b2d31", surface2: "rgba(255,255,255,0.12)", foreground: "#ffffff", foregroundMuted: "rgba(255,255,255,0.72)", border: "rgba(255,255,255,0.25)" } }} compact big />}
        {count > 1 && <Nav icon="ChevronRight" label="Next" onPress={() => go(1)} />}
      </View>
      {pair && !wide && <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, lineHeight: 16 }}>Press and hold the image to see the other one</Text>}
    </View>
  </View>;
  if (Platform.OS === "web" && !compact) return layer;
  return <RNModal transparent visible animationType={reduced ? "none" : "fade"} statusBarTranslucent onRequestClose={onClose}>{layer}</RNModal>;
}

function Nav({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
    style={s => ({ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: s.pressed ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.12)" })}>
    <Icon name={icon} size={20} color="#ffffff" />
  </Pressable>;
}

function Big({ src, box, workspaceId, label, tag }: { src: MediaSource; box: { width: number; height: number }; workspaceId: string; label: string; tag?: string }) {
  const m = useMediaData(workspaceId, hashOf(src));
  const drawn = m.size ? fitInto(m.size, box, 3) : { width: Math.min(box.width, 320), height: Math.min(box.height, 200) };
  return <View style={{ alignItems: "center", gap: 6 }}>
    {tag && <View style={{ paddingHorizontal: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.14)" }}><Text style={{ color: "#ffffff", fontSize: 12, lineHeight: 18, fontWeight: "600" }}>{tag}</Text></View>}
    <View style={{ width: drawn.width, height: drawn.height, alignItems: "center", justifyContent: "center" }}>
      {m.uri ? <Image source={{ uri: m.uri }} accessibilityLabel={label} accessibilityIgnoresInvertColors resizeMode="contain" style={{ width: drawn.width, height: drawn.height }} />
        : m.error || !hashOf(src) ? <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 13 }}>{(src as { missing?: string }).missing ?? "Couldn't load this image"}</Text>
        : <Spinner color="#ffffff" size={16} label={`Loading ${label}`} />}
    </View>
  </View>;
}
