import { createElement as h, useEffect, useState } from "react";
import { Image, Platform, View, type ViewStyle } from "react-native";
import { Icon, ScrollView, copyText } from "@getpaseo/plugin/client/ui";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Pressable, Text } from "./text";
import { Spinner } from "./motion";
import { text, type Theme } from "./kit";
import { isLight, readable, runningColor, tint, withAlpha, type Colors } from "./theme";
import { notice } from "./toast-store";
import { cardMediaRpc } from "../shared/contracts";
import { isVideo, type Block, type Cell, type ItemState, type MediaSource, type Tone } from "../shared/cards";
import { parseMd, type Run } from "../shared/card-md";
import {
  CARD_VIEW, barFractions, baseName, bytesLabel, cardMode, cellState, cellText, cellWidth, codeLines, diffTone, fileKind, fitInto, isNumeric, legendItems,
  linePoints, shortNumber, shownAddress, singleBox, tableLayout, textClips, thumbBox, wordCount, type FileKind,
} from "../shared/card-view";
import { readVideo, useMediaData } from "./card-data";
import { MediaViewer, type Viewed } from "./card-viewer";

/**
 * The eight blocks an agent writes into a card (shared/cards.ts), drawn natively in the host's tokens, both themes,
 * every width (the layout math is shared/card-view.ts). Every block handles its limits in place: a long text clips
 * with "Read all", a wide table scrolls with its first column pinned, long lists and code fold with "Show all".
 */
export type BlockCtx = {
  workspaceId: string; theme: Theme; compact: boolean; width: number;
  /** The card says something runs but its agent is idle or gone: running reads "was running" (an amber clock). */
  stale: boolean;
  /** Rows or items that changed in the last update, still unseen: a thin blue edge on the first cell. */
  changed: readonly number[];
  /** A "Q9" in a list item's detail opens that question. */
  openQuestion?: (id: string) => void;
};

export function BlockView({ block, ctx }: { block: Block; ctx: BlockCtx }) {
  switch (block.type) {
    case "text": return <TextBlock md={(block as { md: string }).md} ctx={ctx} />;
    case "media": return <MediaBlock block={block} ctx={ctx} />;
    case "table": return <TableBlock block={block as never} ctx={ctx} />;
    case "facts": return <FactsBlock items={(block as { items: [string, string, Tone?][] }).items} ctx={ctx} />;
    case "list": return <ListBlock block={block as never} ctx={ctx} />;
    case "chart": return <ChartBlock block={block as never} ctx={ctx} />;
    case "files": return <FilesBlock block={block} ctx={ctx} />;
    case "code": return <CodeBlock block={block as never} ctx={ctx} />;
    default: return null;
  }
}

/** Blocks that draw edge to edge (a table's rows meet the card's sides); the rest sit inside the card's padding. */
export const flushBlock = (b: Block) => b.type === "table";

const toneColor = (tone: Tone | undefined, c: Colors) => tone === "good" ? readable(c.statusSuccess, c) : tone === "bad" ? readable(c.statusDanger, c) : tone === "warn" ? readable(c.statusWarning, c) : undefined;
const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" });
const wrapAnywhere: object = Platform.OS === "web" ? { overflowWrap: "anywhere", wordBreak: "break-word" } : {};
const open = (url: string) => { void openExternalUrl(url).catch(() => undefined); };

/** A "Show all N" / "Show less" row under a long list, table or code. */
function ShowAll({ ctx, open: on, total, noun, onPress }: { ctx: BlockCtx; open: boolean; total: number; noun: string; onPress: () => void }) {
  const c = ctx.theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={on} accessibilityState={{ expanded: on }} onPress={onPress} hitSlop={ctx.compact ? 0 : 4}
    style={s => ({ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: ctx.compact ? 44 : 24, paddingVertical: 2, borderRadius: 4, opacity: s.pressed ? 0.7 : 1 })}>
    <Icon name={on ? "ChevronUp" : "ChevronDown"} size={12} color={c.foregroundMuted} />
    <Text style={[text(c).meta, { fontWeight: "600" }]}>{on ? "Show less" : `Show all ${total} ${noun}`}</Text>
  </Pressable>;
}

// ---------- text ----------

function Runs({ runs, ctx, style }: { runs: Run[]; ctx: BlockCtx; style: object }) {
  const c = ctx.theme.colors;
  return <Text selectable style={[style, wrapAnywhere]}>{runs.map((r, i) => {
    const s = { fontWeight: r.bold ? "600" as const : undefined, fontStyle: r.italic ? "italic" as const : undefined };
    if (r.code) return <Text key={i} style={{ fontFamily: mono, fontSize: 12, backgroundColor: c.surface2, color: c.foreground }}>{` ${r.text} `}</Text>;
    // A link shows where it goes: its own words, then the address in muted text, before anyone taps it.
    if (r.url) return <Text key={i} accessibilityRole="link" accessibilityHint={`Opens ${shownAddress(r.url)} in your browser`} onPress={() => open(r.url!)}
      style={[s, { color: c.foreground, textDecorationLine: "underline" }]}>{r.text}{r.text !== r.url ? <Text style={{ color: c.foregroundMuted, textDecorationLine: "none" }}>{` (${shownAddress(r.url)})`}</Text> : null}</Text>;
    return <Text key={i} style={s}>{r.text}</Text>;
  })}</Text>;
}

export function TextBlock({ md, ctx }: { md: string; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const { inner } = cardMode(ctx.width, ctx.compact);
  const clips = textClips(md, inner, ctx.compact);
  const [all, setAll] = useState(false);
  const blocks = parseMd(md);
  const lineHeight = t.body.lineHeight;
  const body = <View style={{ gap: 6 }}>{blocks.map((b, i) => b.kind === "li"
    ? <View key={i} style={{ flexDirection: "row", gap: 6, paddingLeft: 2 }}><Text style={[t.body, { color: c.foregroundMuted, minWidth: 14 }]}>{b.marker}</Text><View style={{ flex: 1, minWidth: 0 }}><Runs runs={b.runs} ctx={ctx} style={t.body} /></View></View>
    : <Runs key={i} runs={b.runs} ctx={ctx} style={b.kind === "h" ? t.label : t.body} />)}</View>;
  if (!clips) return body;
  return <View style={{ gap: 4 }}>
    <View style={all ? undefined : { maxHeight: lineHeight * CARD_VIEW.textLines + 6 * 2, overflow: "hidden" }}>{body}</View>
    <ShowAllWords ctx={ctx} open={all} words={wordCount(md)} onPress={() => setAll(!all)} />
  </View>;
}
function ShowAllWords({ ctx, open: on, words, onPress }: { ctx: BlockCtx; open: boolean; words: number; onPress: () => void }) {
  const c = ctx.theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={on} accessibilityState={{ expanded: on }} onPress={onPress} hitSlop={ctx.compact ? 0 : 4}
    style={s => ({ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: ctx.compact ? 44 : 24, opacity: s.pressed ? 0.7 : 1 })}>
    <Icon name={on ? "ChevronUp" : "ChevronDown"} size={12} color={c.foregroundMuted} />
    <Text style={[text(c).meta, { fontWeight: "600" }]}>{on ? "Show less" : `Read all · ${words.toLocaleString("en-US")} words`}</Text>
  </Pressable>;
}

// ---------- media ----------

type MediaItem = { src: MediaSource; before?: MediaSource; label?: string; caption?: string };
const hashOf = (s: MediaSource | undefined) => s && "hash" in s ? s.hash : null;
const nameOf = (s: MediaSource | undefined) => s?.name ?? "";
const videoOf = (s: MediaSource | undefined) => !!s && "mime" in s && isVideo(s.mime);

/** A missing image or video, drawn in its place with what to do: the card around it still shows. */
export function MediaGap({ name, why, ctx, box }: { name: string; why: string; ctx: BlockCtx; box?: { width: number; height: number } }) {
  const c = ctx.theme.colors;
  return <View accessibilityRole="text" accessibilityLabel={`${why}: ${name}`} style={{ ...(box ? { width: box.width, minHeight: box.height } : {}), flexDirection: "row", gap: 8, alignItems: "flex-start", padding: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
    <Icon name="ImageOff" size={14} color={c.foregroundMuted} />
    <Text style={[text(c).meta, { flex: 1, minWidth: 0 }, wrapAnywhere]}>{why}: <Text style={{ color: c.foreground, fontFamily: mono, fontSize: 11 }}>{name}</Text>{"\n"}Ask the agent to show it again.</Text>
  </View>;
}

/** One image fitted into a box (never cropped, never blown up past 2x), on the surface tint; a tap opens the viewer. */
function Thumb({ src, box, ctx, label, onPress, fitTo = "box" }: { src: MediaSource; box: { width: number; height: number }; ctx: BlockCtx; label: string; onPress?: () => void; fitTo?: "box" | "natural" }) {
  const c = ctx.theme.colors;
  const hash = hashOf(src);
  const m = useMediaData(ctx.workspaceId, hash);
  if (!hash) return <MediaGap name={nameOf(src)} why={(src as { missing?: string }).missing ?? "Missing"} ctx={ctx} box={box} />;
  if (m.error) return <MediaGap name={nameOf(src)} why="Couldn't load" ctx={ctx} box={box} />;
  const drawn = m.size ? fitInto(m.size, box) : box;
  const frame: ViewStyle = { width: box.width, height: fitTo === "natural" && m.size ? drawn.height : box.height, borderRadius: 6, overflow: "hidden", backgroundColor: c.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border };
  const img = m.uri ? <Image source={{ uri: m.uri }} accessibilityIgnoresInvertColors resizeMode="contain" style={{ width: drawn.width, height: drawn.height }} /> : <Spinner color={c.foregroundMuted} size={12} label={`Loading ${label}`} />;
  const inside = img;
  if (!onPress) return <View accessibilityRole="image" accessibilityLabel={label} style={frame}>{inside}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens it larger" onPress={onPress}
    style={s => [frame, { opacity: s.pressed ? 0.85 : 1 }, (s as { hovered?: boolean }).hovered ? { borderColor: withAlpha(c.foreground, 0.3) } : null]}>{inside}</Pressable>;
}

/** A caption short enough to be a tag ("changed") sits after the label in the caption row, never on the image. */
const tagOf = (caption?: string) => caption && caption.length <= 12 ? caption : undefined;
/** Narrow grids show this many before "N more". */
const GRID_SHOWN = 6;
function MoreToggle({ ctx, open, rest, noun, onPress }: { ctx: BlockCtx; open: boolean; rest: number; noun: string; onPress: () => void }) {
  const c = ctx.theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={onPress}
    style={s => ({ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: ctx.compact ? 44 : 24, opacity: s.pressed ? 0.7 : 1 })}>
    <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={c.foregroundMuted} />
    <Text style={[text(c, ctx.compact).meta, { fontWeight: "600" }]}>{open ? "Show less" : `${rest} more ${noun}${rest === 1 ? "" : "s"}`}</Text>
  </Pressable>;
}
function Caption({ ctx, label, caption, lines = 1 }: { ctx: BlockCtx; label?: string; caption?: string; lines?: number }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  if (!label && !caption) return null;
  const tag = tagOf(caption);
  // A short tag ("changed") keeps its own slot after the label in a quiet accent: the label truncates, the reason to look never does.
  if (tag) return <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4, minWidth: 0 }}>
    {label ? <Text numberOfLines={1} style={[t.meta, { color: c.foreground, flexShrink: 1, minWidth: 0 }]}>{label}</Text> : null}
    <Text numberOfLines={1} style={[t.meta, { flexShrink: 0, marginLeft: label ? 4 : 0, color: runningColor(c), fontWeight: "500" }]}>{label ? `· ${tag}` : tag}</Text>
  </View>;
  return <Text numberOfLines={lines} style={[t.meta, { marginTop: 4 }, wrapAnywhere]}>{label ? <Text style={{ color: c.foreground }}>{label}</Text> : null}{label && caption ? " · " : ""}{caption ?? ""}</Text>;
}

export function MediaBlock({ block, ctx }: { block: Extract<Block, { type: "media" }>; ctx: BlockCtx }) {
  const items = block.items as MediaItem[];
  const videos = items.filter(i => videoOf(i.src));
  const images = items.filter(i => !videoOf(i.src));
  const pairs = images.filter(i => i.before);
  const singles = images.filter(i => !i.before);
  const [viewing, setViewing] = useState<Viewed | null>(null);
  const layout = block.layout ?? (pairs.length ? "pairs" : images.length === 1 ? "single" : "grid");
  return <View style={{ gap: 12 }}>
    {pairs.length > 0 && <Pairs items={pairs} ctx={ctx} onOpen={i => setViewing({ items: pairs, index: i })} />}
    {singles.length > 0 && (layout === "single"
      ? singles.map((it, i) => <SingleImage key={i} item={it} ctx={ctx} onOpen={() => setViewing({ items: singles, index: i })} />)
      : <Grid items={singles} ctx={ctx} onOpen={i => setViewing({ items: singles, index: i })} />)}
    {videos.map((v, i) => <VideoView key={i} item={v} ctx={ctx} />)}
    {viewing && <MediaViewer viewed={viewing} workspaceId={ctx.workspaceId} theme={ctx.theme} compact={ctx.compact} onClose={() => setViewing(null)} />}
  </View>;
}

function SingleImage({ item, ctx, onOpen }: { item: MediaItem; ctx: BlockCtx; onOpen: () => void }) {
  const { inner } = cardMode(ctx.width, ctx.compact);
  const m = useMediaData(ctx.workspaceId, hashOf(item.src));
  const box = singleBox(m.size ?? { width: 0, height: 0 }, inner);
  return <View>
    <Thumb src={item.src} box={{ width: inner, height: box.height }} ctx={ctx} label={item.label ?? nameOf(item.src)} onPress={onOpen} />
    <Caption ctx={ctx} label={item.label} caption={item.caption} lines={2} />
  </View>;
}

function Grid({ items, ctx, onOpen }: { items: MediaItem[]; ctx: BlockCtx; onOpen: (i: number) => void }) {
  const { inner, galleryCols } = cardMode(ctx.width, ctx.compact);
  const w = cellWidth(inner, galleryCols);
  const [more, setMore] = useState(false);
  const cap = Math.max(GRID_SHOWN, galleryCols * 2);
  const shown = more ? items : items.slice(0, cap);
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {shown.map((it, i) => <View key={i} style={{ width: w }}>
        <Thumb src={it.src} box={thumbBox(w)} ctx={ctx} label={[it.label ?? nameOf(it.src), it.caption].filter(Boolean).join(", ")} onPress={() => onOpen(i)} />
        <Caption ctx={ctx} label={it.label} caption={it.caption} />
      </View>)}
    </View>
    {items.length > cap && <MoreToggle ctx={ctx} open={more} rest={items.length - cap} noun="image" onPress={() => setMore(!more)} />}
  </View>;
}

/** A Before / After switch: one for the whole set, two equal segments. */
export function BeforeAfter({ value, onChange, theme, compact, big = false }: { value: "before" | "after"; onChange: (v: "before" | "after") => void; theme: Theme; compact: boolean; big?: boolean }) {
  const c = theme.colors;
  const seg = (v: "before" | "after", label: string) => <Pressable key={v} accessibilityRole="radio" aria-checked={value === v} accessibilityState={{ selected: value === v, checked: value === v }} onPress={() => onChange(v)}
    style={s => ({ minHeight: big ? 44 : compact ? 36 : 24, minWidth: big ? 96 : 60, paddingHorizontal: big ? 18 : 10, borderRadius: 6, alignItems: "center", justifyContent: "center",
      backgroundColor: value === v ? c.surface0 : s.pressed ? c.surface2 : "transparent", borderWidth: 1, borderColor: value === v ? c.border : "transparent" })}>
    <Text style={{ color: value === v ? c.foreground : c.foregroundMuted, fontSize: big ? 15 : 12, lineHeight: big ? 20 : 16, fontWeight: value === v ? "600" : "400" }}>{label}</Text>
  </Pressable>;
  return <View accessibilityRole="radiogroup" accessibilityLabel="Show the images before or after" style={{ flexDirection: "row", gap: 2, padding: 2, borderRadius: 8, backgroundColor: c.surface2, alignSelf: "flex-start" }}>
    {seg("before", "Before")}{seg("after", "After")}
  </View>;
}

function Pairs({ items, ctx, onOpen }: { items: MediaItem[]; ctx: BlockCtx; onOpen: (i: number) => void }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const { inner, sideBySide } = cardMode(ctx.width, ctx.compact);
  const [more, setMore] = useState(false);
  const [side, setSide] = useState<"before" | "after">("after");
  if (!sideBySide) {
    // Narrow: a two-up grid of the After (or Before) images, one switch for the set; a tap opens that pair large.
    const w = cellWidth(inner, 2);
    const shown = more ? items : items.slice(0, GRID_SHOWN);
    return <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <BeforeAfter value={side} onChange={setSide} theme={ctx.theme} compact={ctx.compact} />
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} style={[t.meta, { flexShrink: 1 }]}>{ctx.compact ? "Tap one to compare" : "Click one to compare"}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {shown.map((it, i) => <View key={i} style={{ width: w }}>
          <Thumb src={side === "after" ? it.src : it.before!} box={thumbBox(w)} ctx={ctx} label={[`${it.label ?? `Pair ${i + 1}`}, ${side}`, it.caption].filter(Boolean).join(", ")} onPress={() => onOpen(i)} />
          <Caption ctx={ctx} label={it.label} caption={it.caption} />
        </View>)}
      </View>
      {items.length > GRID_SHOWN && <MoreToggle ctx={ctx} open={more} rest={items.length - GRID_SHOWN} noun="pair" onPress={() => setMore(!more)} />}
    </View>;
  }
  const w = cellWidth(inner, 2, 6);
  const shown = more ? items : items.slice(0, CARD_VIEW.pairsShown);
  return <View style={{ gap: 12 }}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 6, marginBottom: -6 }}>
      <Text style={[t.small, { width: w, fontWeight: "600" }]}>Before</Text><Text style={[t.small, { width: w, fontWeight: "600" }]}>After</Text>
    </View>
    {shown.map((it, i) => <View key={i} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Thumb src={it.before!} box={thumbBox(w)} ctx={ctx} label={`${it.label ?? `Pair ${i + 1}`}, before`} onPress={() => onOpen(i)} />
        <Thumb src={it.src} box={thumbBox(w)} ctx={ctx} label={`${it.label ?? `Pair ${i + 1}`}, after`} onPress={() => onOpen(i)} />
      </View>
      <Caption ctx={ctx} label={it.label} caption={it.caption} lines={2} />
    </View>)}
    {items.length > CARD_VIEW.pairsShown && <Pressable accessibilityRole="button" aria-expanded={more} accessibilityState={{ expanded: more }} onPress={() => setMore(!more)}
      style={s => ({ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: ctx.compact ? 44 : 24, opacity: s.pressed ? 0.7 : 1 })}>
      <Icon name={more ? "ChevronUp" : "ChevronDown"} size={12} color={c.foregroundMuted} />
      <Text style={[t.meta, { fontWeight: "600" }]}>{more ? "Show less" : `${items.length - CARD_VIEW.pairsShown} more pair${items.length - CARD_VIEW.pairsShown === 1 ? "" : "s"}`}</Text>
    </Pressable>}
  </View>;
}

/**
 * A video: a poster with its name and size. Desktop web plays it in place on a tap (its bytes read then, never ahead).
 * Paseo's phone app gives plugins no video player (checked against 0.17), so a phone says "Play on your computer".
 */
function VideoView({ item, ctx }: { item: MediaItem; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const read = useRpc(cardMediaRpc);
  const { inner } = cardMode(ctx.width, ctx.compact);
  const hash = hashOf(item.src);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"poster" | "loading" | "error">("poster");
  useEffect(() => () => { if (url?.startsWith("blob:")) (globalThis as { URL?: { revokeObjectURL(u: string): void } }).URL?.revokeObjectURL(url); }, [url]);
  if (!hash) return <MediaGap name={nameOf(item.src)} why={(item.src as { missing?: string }).missing ?? "Missing"} ctx={ctx} />;
  const playable = Platform.OS === "web" && !ctx.compact;
  const box = { width: inner, height: Math.round(inner * 9 / 16) };
  const bytes = "bytes" in item.src ? item.src.bytes : undefined;
  const name = item.label ?? nameOf(item.src);
  const play = () => { setState("loading"); readVideo(read, ctx.workspaceId, hash).then(u => { setUrl(u); setState("poster"); }, () => setState("error")); };
  const poster = <View style={{ width: box.width, height: box.height, borderRadius: 8, overflow: "hidden", backgroundColor: isLight(c) ? "#1d1f24" : c.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border }}>
    {state === "loading" ? <Spinner color="#ffffff" size={18} label="Loading the video" />
      : playable ? <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}><Icon name="Play" size={20} color="#ffffff" /></View>
      : <View style={{ alignItems: "center", gap: 6, paddingHorizontal: 16 }}><Icon name="MonitorPlay" size={22} color="#ffffff" /><Text style={{ color: "#ffffff", fontSize: 13, lineHeight: 18, fontWeight: "600", textAlign: "center" }}>Play on your computer</Text><Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, lineHeight: 16, textAlign: "center" }}>Paseo's phone app can't play videos here yet</Text></View>}
  </View>;
  return <View>
    {url && playable ? h("video", { src: url, controls: true, autoPlay: true, style: { width: box.width, maxHeight: CARD_VIEW.singleMaxHeight, borderRadius: 8, background: "#000", display: "block" } })
      : playable ? <Pressable accessibilityRole="button" accessibilityLabel={`Play ${name}`} onPress={play} style={s => ({ opacity: s.pressed ? 0.85 : 1 })}>{poster}</Pressable>
      : <View accessibilityRole="image" accessibilityLabel={`${name}, a video: play it on your computer`}>{poster}</View>}
    {state === "error" && <Text accessibilityRole="alert" style={[t.meta, { color: readable(c.statusDanger, c), marginTop: 4 }]}>Couldn't load the video. Ask the agent to show it again.</Text>}
    <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
      <Text numberOfLines={2} style={[t.meta, { flex: 1, minWidth: 0 }, wrapAnywhere]}>{item.caption ? <><Text style={{ color: c.foreground }}>{name}</Text>{` · ${item.caption}`}</> : name}</Text>
      {bytes !== undefined && <Text style={t.meta}>{bytesLabel(bytes)}</Text>}
    </View>
  </View>;
}

// ---------- state glyphs ----------

/** A state's glyph: done, running (or the amber clock when stale), failed, warning, to do, skipped. Read aloud as its word. */
export function StateGlyph({ state, stale, theme, size = 14 }: { state: ItemState; stale: boolean; theme: Theme; size?: number }) {
  const c = theme.colors;
  const box = { width: size + 2, height: size + 2, alignItems: "center" as const, justifyContent: "center" as const };
  switch (state) {
    case "done": return <View style={box}><Icon name="Check" size={size} color={readable(c.statusSuccess, c)} /></View>;
    case "failed": return <View style={box}><Icon name="X" size={size} color={readable(c.statusDanger, c)} /></View>;
    case "warning": return <View style={box}><Icon name="TriangleAlert" size={size - 1} color={readable(c.statusWarning, c)} /></View>;
    case "running": return <View style={box}>{stale ? <Icon name="Clock" size={size - 1} color={readable(c.statusWarning, c)} /> : <Icon name="LoaderCircle" size={size} color={runningColor(c)} />}</View>;
    case "todo": return <View style={box}><View style={{ width: size - 5, height: size - 5, borderRadius: size, borderWidth: 1.5, borderColor: c.foregroundMuted }} /></View>;
    case "skipped": return <View style={box}><Icon name="Minus" size={size - 2} color={c.foregroundMuted} /></View>;
  }
}

function Legend({ states, ctx }: { states: ItemState[]; ctx: BlockCtx }) {
  const t = text(ctx.theme.colors, ctx.compact);
  const items = legendItems(states, ctx.stale);
  if (items.length < 2 && !(ctx.stale && states.includes("running"))) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2 }}>
    {items.map(i => <View key={i.state} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><StateGlyph state={i.state} stale={ctx.stale} theme={ctx.theme} size={12} /><Text style={t.small}>{i.word}</Text></View>)}
  </View>;
}

// ---------- table ----------

type TableBlockData = Extract<Block, { type: "table" }> & { columns: string[]; rows: Cell[][]; highlight?: number; recommend?: number };

export function TableBlock({ block, ctx }: { block: TableBlockData; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const pad = cardMode(ctx.width, ctx.compact).pad;
  const rec = block.recommend !== undefined && block.recommend > 0 && block.recommend < block.columns.length ? block.recommend : undefined;
  const lay = tableLayout(block.columns, block.rows, ctx.width, { recommend: rec, compact: ctx.compact });
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, CARD_VIEW.tableRows);
  // A wide table: the first column pinned, the rest scroll sideways under an edge fade; rows keep one height across both.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const seen = (k: string, hgt: number) => setHeights(p => (p[k] ?? 0) >= hgt ? p : { ...p, [k]: hgt });
  const green = readable(c.statusSuccess, c);
  const cellPad = { paddingVertical: ctx.compact ? 9 : 7, paddingHorizontal: 8 };
  const headCell = (j: number) => <View key={j} onLayout={lay.scroll ? e => seen("h", e.nativeEvent.layout.height) : undefined}
    style={[cellPad, { width: lay.widths[j], minHeight: heights.h, paddingTop: 6, paddingBottom: 6, justifyContent: "flex-end", borderBottomWidth: 1, borderBottomColor: c.border },
      j === 0 ? { paddingLeft: pad } : null, j === block.columns.length - 1 ? { paddingRight: pad } : null,
      rec === j ? { backgroundColor: tint(c.statusSuccess, c), borderLeftWidth: 2, borderLeftColor: green } : null]}>
    <Text style={[t.small, { fontWeight: "600", color: rec === j ? green : c.foregroundMuted, textAlign: lay.numeric[j] ? "right" : lay.states[j] ? "center" : "left" }, Platform.OS === "web" ? { wordBreak: "normal", overflowWrap: "break-word" } as object : null]}>{block.columns[j]}</Text>
    {rec === j && <Text style={{ color: green, fontSize: 10, lineHeight: 14, fontWeight: "600" }}>Recommended</Text>}
  </View>;
  const bodyCell = (row: Cell[], i: number, j: number) => {
    const cell = row[j];
    const state = cellState(cell);
    const tone = cell && typeof cell === "object" ? cell.tone : undefined;
    const changed = j === 0 && ctx.changed.includes(i);
    const last = i === rows.length - 1;
    return <View key={j} onLayout={lay.scroll ? e => seen(`r${i}`, e.nativeEvent.layout.height) : undefined}
      style={[cellPad, { width: lay.widths[j], minHeight: heights[`r${i}`], justifyContent: "center", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border },
        j === 0 ? { paddingLeft: pad } : null, j === block.columns.length - 1 ? { paddingRight: pad } : null,
        block.highlight === i ? { backgroundColor: tint(c.statusSuccess, c) } : null,
        rec === j ? { borderLeftWidth: 2, borderLeftColor: withAlpha(green, 0.7) } : null,
        changed ? { borderLeftWidth: 2, borderLeftColor: runningColor(c), paddingLeft: pad - 2 } : null]}>
      {state ? <View accessibilityLabel={legendItems([state], ctx.stale)[0]?.word ?? state} style={{ alignItems: lay.states[j] ? "center" : "flex-start" }}>{cell && typeof cell === "object" && cell.value !== undefined
        ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><StateGlyph state={state} stale={ctx.stale} theme={ctx.theme} size={13} /><Text style={t.body}>{String(cell.value)}</Text></View>
        : <StateGlyph state={state} stale={ctx.stale} theme={ctx.theme} />}</View>
        : <Text selectable style={[ctx.compact ? t.body : { fontSize: 12, lineHeight: 16, color: c.foreground }, { textAlign: lay.numeric[j] ? "right" : "left", color: toneColor(tone, c) ?? c.foreground, fontWeight: j === 0 ? "500" : undefined },
          lay.numeric[j] ? { fontVariant: ["tabular-nums"] } : null, wrapAnywhere]}>{cellText(cell)}</Text>}
    </View>;
  };
  const cols = block.columns.map((_, j) => j);
  const tableRows = (from: number[]) => <>
    <View style={{ flexDirection: "row" }}>{from.map(headCell)}</View>
    {rows.map((r, i) => <View key={i} style={{ flexDirection: "row" }}>{from.map(j => bodyCell(r, i, j))}</View>)}
  </>;
  const legend = lay.legend.length > 0 && <View style={{ paddingHorizontal: pad, paddingTop: 8 }}><Legend states={lay.legend} ctx={ctx} /></View>;
  const more = block.rows.length > CARD_VIEW.tableRows && <View style={{ paddingHorizontal: pad, paddingTop: 4 }}><ShowAll ctx={ctx} open={all} total={block.rows.length} noun="rows" onPress={() => setAll(!all)} /></View>;
  if (!lay.scroll) return <View accessibilityRole="summary" accessibilityLabel={`Table: ${block.columns.filter(Boolean).join(", ")}`}>{tableRows(cols)}{more}{legend}</View>;
  return <View accessibilityLabel={`Table: ${block.columns.filter(Boolean).join(", ")}; scrolls sideways`}>
    <View style={{ flexDirection: "row" }}>
      <View style={{ zIndex: 1, backgroundColor: c.surface0, borderRightWidth: 1, borderRightColor: c.border }}>{tableRows([0])}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexDirection: "column" }}>{tableRows(cols.slice(1))}</ScrollView>
        <EdgeFade color={c.surface0} />
      </View>
    </View>
    {more}{legend}
  </View>;
}

/** The fade at a scrolling table's right edge, so a cut column reads as "more this way" (a few strips: no gradients on native). */
function EdgeFade({ color }: { color: string }) {
  const steps = [0.15, 0.35, 0.55, 0.75, 0.9];
  return <View pointerEvents="none" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 25, flexDirection: "row" }}>
    {steps.map(a => <View key={a} style={{ width: 5, backgroundColor: withAlpha(color, a) }} />)}
  </View>;
}

// ---------- facts ----------

function FactsBlock({ items, ctx }: { items: [string, string, Tone?][]; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const { inner } = cardMode(ctx.width, ctx.compact);
  const cols = Math.max(2, Math.min(4, Math.floor((inner + 16) / (ctx.compact ? 140 : 150))));
  const w = cellWidth(inner, cols, 16);
  return <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 8 }}>
    {items.map(([label, value, tone], i) => <View key={i} style={{ width: w }}>
      <Text style={[t.small, wrapAnywhere]}>{label}</Text>
      <Text selectable style={[t.label, { color: toneColor(tone, c) ?? c.foreground, fontVariant: ["tabular-nums"] }, wrapAnywhere]}>{value}</Text>
    </View>)}
  </View>;
}

// ---------- list ----------

type ListItem = { text: string; detail?: string; state?: ItemState; tag?: string; refs?: string[]; at?: string };

/** A ref: a URL opens outside Paseo (its address shown); a file:line is copied, since Paseo gives plugins no file panel to open. */
function Ref({ value, ctx }: { value: string; ctx: BlockCtx }) {
  const c = ctx.theme.colors;
  const url = /^https?:\/\//.test(value) ? value : null;
  const shown = url ? shownAddress(url) : value;
  return <Pressable accessibilityRole={url ? "link" : "button"} accessibilityLabel={url ? `Open ${shown}` : `Copy ${value}`} accessibilityHint={url ? "Opens in your browser" : "Copies it, to open in your editor"} hitSlop={ctx.compact ? 6 : 3}
    onPress={() => { if (url) open(url); else void copyText(value).then(() => notice(`Copied ${value}`), () => undefined); }}
    style={s => ({ paddingHorizontal: 5, paddingVertical: ctx.compact ? 4 : 1, borderRadius: 4, backgroundColor: s.pressed ? c.surface2 : (s as { hovered?: boolean }).hovered ? withAlpha(c.foreground, 0.12) : c.surface2, maxWidth: "100%" })}>
    <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 11, lineHeight: 15, color: c.foregroundMuted, textDecorationLine: url ? "underline" : "none" }}>{shown}</Text>
  </Pressable>;
}

/** "Waits for you: Q9": a question id in an item's detail opens that question. */
function DetailText({ detail, ctx }: { detail: string; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const parts = detail.split(/(\bQ\d+\b)/);
  return <Text selectable style={[t.meta, wrapAnywhere]}>{parts.map((p, i) => /^Q\d+$/.test(p) && ctx.openQuestion
    ? <Text key={i} accessibilityRole="link" onPress={() => ctx.openQuestion!(p)} style={{ color: runningColor(c), textDecorationLine: "underline" }}>{p}</Text> : p)}</Text>;
}

function ListBlock({ block, ctx }: { block: { items: ListItem[]; ranked?: boolean }; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const [all, setAll] = useState(false);
  const items = all ? block.items : block.items.slice(0, CARD_VIEW.listItems);
  const glyphs = !block.ranked && block.items.some(i => i.state);
  return <View>
    {items.map((it, i) => <View key={i} style={[{ flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: ctx.compact ? 9 : 7 }, i ? { borderTopWidth: 1, borderTopColor: c.border } : null,
      ctx.changed.includes(i) ? { borderLeftWidth: 2, borderLeftColor: runningColor(c), paddingLeft: 6, marginLeft: -8 } : null]}>
      {block.ranked ? <View style={{ width: 18, height: 18, borderRadius: 5, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center", marginTop: 1 }}><Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 14, fontWeight: "600" }}>{i + 1}</Text></View>
        : glyphs ? <View accessibilityLabel={it.state ? legendItems([it.state], ctx.stale)[0]?.word : undefined} style={{ width: 16, paddingTop: 1 }}>{it.state ? <StateGlyph state={it.state} stale={ctx.stale} theme={ctx.theme} /> : null}</View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2 }}>
          <Text selectable style={[t.body, { flexShrink: 1, fontWeight: block.ranked || it.state === "running" ? "600" : undefined }, wrapAnywhere]}>{it.text}</Text>
          {!!it.tag && <View style={{ paddingHorizontal: 6, borderRadius: 999, backgroundColor: c.surface2 }}><Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{it.tag}</Text></View>}
        </View>
        {!!it.detail && <DetailText detail={it.detail} ctx={ctx} />}
        {!!it.refs?.length && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 1 }}>{it.refs.map(r => <Ref key={r} value={r} ctx={ctx} />)}</View>}
      </View>
      {!!it.at && <Text style={[t.meta, { flexShrink: 0 }]}>{it.at}</Text>}
    </View>)}
    {block.items.length > CARD_VIEW.listItems && <ShowAll ctx={ctx} open={all} total={block.items.length} noun="items" onPress={() => setAll(!all)} />}
  </View>;
}

// ---------- chart ----------

type ChartData = { kind: "bars" | "line"; labels: string[]; series: { name: string; values: number[] }[]; unit?: string; better?: "lower" | "higher" };

function ChartBlock({ block, ctx }: { block: ChartData; ctx: BlockCtx }) {
  return block.kind === "line" ? <LineChart block={block} ctx={ctx} /> : <BarChart block={block} ctx={ctx} />;
}

const seriesColors = (c: Colors, n: number) => n === 2 ? [withAlpha(c.foregroundMuted, 0.55), runningColor(c)] : [runningColor(c)];
const fmt = (v: number, unit?: string) => `${shortNumber(v)}${unit ? (/^[%×x]$/.test(unit) ? unit : ` ${unit}`) : ""}`;

function ChartLegend({ block, ctx, right }: { block: ChartData; ctx: BlockCtx; right?: string }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const colors = seriesColors(c, block.series.length);
  const note = [block.unit, block.better ? `${block.better} is better` : null].filter(Boolean).join(", ");
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 2, marginBottom: 8 }}>
    {block.series.map((s, i) => <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: colors[i] }} /><Text style={t.small}>{s.name}</Text></View>)}
    <View style={{ flex: 1 }} />
    {(right || note) && <Text style={t.small}>{right ?? note}</Text>}
  </View>;
}

function BarChart({ block, ctx }: { block: ChartData; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const [all, setAll] = useState(false);
  const fr = barFractions(block.series);
  const colors = seriesColors(c, block.series.length);
  const labels = all ? block.labels : block.labels.slice(0, CARD_VIEW.listItems + 2);
  return <View>
    <ChartLegend block={block} ctx={ctx} />
    <View style={{ gap: 9 }}>
      {labels.map((l, i) => <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        accessibilityLabel={`${l}: ${block.series.map(s => `${s.name} ${fmt(s.values[i], block.unit)}`).join(", ")}`}>
        <Text numberOfLines={2} style={[t.small, { width: CARD_VIEW.barLabel, color: c.foreground, fontWeight: "600" }, wrapAnywhere]}>{l}</Text>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {block.series.map((s, k) => <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: `${Math.max(fr[k][i] * 100, s.values[i] ? 0.8 : 0)}%`, flexShrink: 1, height: ctx.compact ? 9 : 8, borderTopRightRadius: 4, borderBottomRightRadius: 4, backgroundColor: colors[k] }} />
            <Text numberOfLines={1} style={[t.small, { flexShrink: 0, color: k === block.series.length - 1 ? c.foreground : c.foregroundMuted, fontWeight: k === block.series.length - 1 && block.series.length > 1 ? "600" : undefined }]}>{fmt(s.values[i], block.unit)}</Text>
          </View>)}
        </View>
      </View>)}
    </View>
    {block.labels.length > CARD_VIEW.listItems + 2 && <ShowAll ctx={ctx} open={all} total={block.labels.length} noun="bars" onPress={() => setAll(!all)} />}
  </View>;
}

/** A line of one series: drawn as short rotated segments (no SVG in a plugin), the last point marked, first and last x labels. A tap shows a point's value. */
function LineChart({ block, ctx }: { block: ChartData; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const { inner } = cardMode(ctx.width, ctx.compact);
  const s = block.series[0];
  const box = { width: inner, height: CARD_VIEW.lineHeight };
  const pts = linePoints(s.values, box);
  const [pick, setPick] = useState<number | null>(null);
  const shown = pick ?? s.values.length - 1;
  const blue = runningColor(c);
  const step = pts.length > 1 ? pts[1].x - pts[0].x : box.width;
  return <View>
    <ChartLegend block={block} ctx={ctx} right={`${block.labels[shown]} · ${fmt(s.values[shown], block.unit)}`} />
    <View accessibilityRole="image" accessibilityLabel={`${s.name}: from ${fmt(s.values[0], block.unit)} at ${block.labels[0]} to ${fmt(s.values.at(-1)!, block.unit)} at ${block.labels.at(-1)}`} style={{ width: box.width, height: box.height }}>
      {[0, 0.5, 1].map(f => <View key={f} style={{ position: "absolute", left: 0, right: 0, top: 10 + f * (box.height - 20), height: 1, backgroundColor: c.border }} />)}
      {pts.slice(1).map((p, i) => {
        const a = pts[i]; const dx = p.x - a.x, dy = p.y - a.y; const len = Math.hypot(dx, dy);
        return <View key={i} style={{ position: "absolute", left: (a.x + p.x) / 2 - len / 2, top: (a.y + p.y) / 2 - 1, width: len, height: 2, borderRadius: 1, backgroundColor: blue, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
      })}
      <View style={{ position: "absolute", left: pts[shown].x - 0.5, top: pts[shown].y, width: 1, height: Math.max(0, box.height - 10 - pts[shown].y), backgroundColor: withAlpha(blue, 0.35) }} />
      <View style={{ position: "absolute", left: pts[shown].x - 5, top: pts[shown].y - 5, width: 10, height: 10, borderRadius: 5, backgroundColor: blue, borderWidth: 2, borderColor: c.surface0 }} />
      {pts.map((p, i) => <Pressable key={`t${i}`} accessibilityRole="button" accessibilityLabel={`${block.labels[i]}: ${fmt(s.values[i], block.unit)}`} onPress={() => setPick(i)} onHoverIn={() => setPick(i)} onHoverOut={() => setPick(null)}
        style={{ position: "absolute", left: Math.max(0, p.x - step / 2), width: Math.max(4, Math.min(p.x + step / 2, box.width) - Math.max(0, p.x - step / 2)), top: 0, bottom: 0 }} />)}
    </View>
    <View style={{ flexDirection: "row", marginTop: 2 }}><Text style={t.small}>{block.labels[0]}</Text><View style={{ flex: 1 }} /><Text style={t.small}>{block.labels.at(-1)}</Text></View>
  </View>;
}

// ---------- files ----------

const FILE_ICONS: Record<FileKind, string> = { image: "Image", video: "Film", markdown: "FileText", pdf: "FileText", page: "ExternalLink", archive: "Archive", data: "FileSpreadsheet", file: "File" };

type FileItem = { path?: string; url?: string; label?: string; note?: string; bytes?: number; gone?: boolean; media?: Extract<MediaSource, { hash: string }> };
function FilesBlock({ block, ctx }: { block: Extract<Block, { type: "files" }>; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const [viewing, setViewing] = useState<Viewed | null>(null);
  const [playing, setPlaying] = useState<FileItem | null>(null);
  const items = block.items as FileItem[];
  return <View>
    {items.map((f, i) => {
      const kind = fileKind(f);
      const name = f.label ?? (f.url ? shownAddress(f.url) : baseName(f.path ?? ""));
      // A link's icon already says it opens outside; a narrow card keeps its width for the name and address.
      const right = f.gone ? "moved or deleted" : f.url ? (cardMode(ctx.width, ctx.compact).freshInSubtitle ? null : "opens in your browser") : bytesLabel(f.bytes);
      const note = f.gone ? `Not found: ${f.path}. Ask the agent to show it again.` : f.url ? [f.note, shownAddress(f.url)].filter(Boolean).join(" · ") : f.note ?? f.path;
      const act = f.gone ? null : f.url ? () => open(f.url!)
        : f.media && kind === "image" ? () => setViewing({ items: [{ src: f.media! }], index: 0 })
        : f.media && kind === "video" ? () => setPlaying(playing === f ? null : f)
        : () => { void copyText(f.path!).then(() => notice(`Copied ${f.path}`), () => undefined); };
      const hint = f.url ? `Opens ${shownAddress(f.url)} in your browser` : f.media ? "Opens it here" : "Copies its path, to open in your editor";
      const row = <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: ctx.compact ? 10 : 7 }}>
        <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}><Icon name={f.gone ? "FileX" : FILE_ICONS[kind]} size={14} color={f.gone ? readable(c.statusWarning, c) : c.foregroundMuted} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.body, { color: f.gone ? c.foregroundMuted : c.foreground }, wrapAnywhere]}>{name}</Text>
          {!!note && <Text numberOfLines={2} style={[t.meta, wrapAnywhere]}>{note}</Text>}
        </View>
        {!!right && <Text numberOfLines={1} style={[t.small, { flexShrink: 0, maxWidth: 120, textAlign: "right" }]}>{right}</Text>}
        {!f.gone && !f.url && !f.media && <Icon name="Copy" size={13} color={c.foregroundMuted} />}
      </View>;
      return <View key={i} style={i ? { borderTopWidth: 1, borderTopColor: c.border } : undefined}>
        {act ? <Pressable accessibilityRole={f.url ? "link" : "button"} accessibilityLabel={name} accessibilityHint={hint} onPress={act}
          style={s => ({ borderRadius: 6, backgroundColor: s.pressed ? c.surface2 : (s as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>{row}</Pressable> : row}
        {playing === f && f.media && <View style={{ paddingBottom: 8 }}><VideoView item={{ src: f.media as Extract<MediaSource, { hash: string }>, label: name }} ctx={ctx} /></View>}
      </View>;
    })}
    {viewing && <MediaViewer viewed={viewing} workspaceId={ctx.workspaceId} theme={ctx.theme} compact={ctx.compact} onClose={() => setViewing(null)} />}
  </View>;
}

// ---------- code ----------

function CodeBlock({ block, ctx }: { block: { text: string; ref?: string; lang?: string; diff?: boolean; mark?: number[] }; ctx: BlockCtx }) {
  const c = ctx.theme.colors; const t = text(c, ctx.compact);
  const lines = codeLines(block.text, block.ref);
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, CARD_VIEW.codeLines);
  const digits = String(lines.at(-1)?.n ?? 1).length;
  const font = { fontFamily: mono, fontSize: ctx.compact ? 12 : 11.5, lineHeight: 17 };
  return <View style={{ gap: 4 }}>
    <View style={{ borderRadius: 7, borderWidth: 1, borderColor: c.border, overflow: "hidden", backgroundColor: c.surface0 }}>
      {(block.ref || block.lang) && <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Icon name="FileCode" size={11} color={c.foregroundMuted} />
        {block.ref ? <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${block.ref}`} onPress={() => { void copyText(block.ref!).then(() => notice(`Copied ${block.ref}`), () => undefined); }} style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[font, { color: c.foregroundMuted, fontSize: 11 }]}>{block.ref}</Text></Pressable> : <View style={{ flex: 1 }} />}
        {!!block.lang && <Text style={[font, { color: c.foregroundMuted, fontSize: 11 }]}>{block.lang}</Text>}
      </View>}
      <View style={{ paddingVertical: 4 }}>
        {shown.map((l, i) => {
          const tone = block.diff ? diffTone(l.text) : null;
          const marked = block.mark?.includes(l.n);
          const bg = marked ? tint(c.statusWarning, c) : tone === "add" ? tint(c.statusSuccess, c) : tone === "del" ? tint(c.statusDanger, c) : undefined;
          return <View key={i} style={{ flexDirection: "row", backgroundColor: bg, paddingRight: 8 }}>
            <Text accessibilityElementsHidden importantForAccessibility="no" style={[font, { width: digits * 7.5 + 16, paddingRight: 8, textAlign: "right", color: withAlpha(c.foregroundMuted, 0.75) }]}>{l.n}</Text>
            <Text selectable style={[font, { flex: 1, minWidth: 0, color: c.foreground }, wrapAnywhere]}>{l.text || " "}</Text>
          </View>;
        })}
      </View>
    </View>
    {lines.length > CARD_VIEW.codeLines && <ShowAll ctx={ctx} open={all} total={lines.length} noun="lines" onPress={() => setAll(!all)} />}
  </View>;
}

/** The first image a card holds, for the question row's thumbnail. */
export function firstImage(blocks: readonly Block[]): MediaSource | null {
  for (const b of blocks) if (b.type === "media") for (const i of b.items as MediaItem[]) if (hashOf(i.src) && !videoOf(i.src)) return i.src;
  return null;
}
/** A small thumbnail (the question row's), or nothing. */
export function MiniThumb({ src, workspaceId, theme, size }: { src: MediaSource; workspaceId: string; theme: Theme; size: { width: number; height: number } }) {
  const m = useMediaData(workspaceId, hashOf(src));
  const c = theme.colors;
  const drawn = m.size ? fitInto(m.size, size) : size;
  return <View style={{ width: size.width, height: size.height, borderRadius: 5, overflow: "hidden", backgroundColor: c.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border }}>
    {m.uri ? <Image source={{ uri: m.uri }} resizeMode="contain" accessibilityIgnoresInvertColors style={{ width: drawn.width, height: drawn.height }} /> : null}
  </View>;
}
export type { Viewed };
