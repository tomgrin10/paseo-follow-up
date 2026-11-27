import { CARD_LIMITS, ago, type Cell, type ItemState } from "./cards";

/**
 * How a card an agent shows (shared/cards.ts) lays out in the workspace view, as pure math so the view, its unit test
 * (tests/card-view.test.ts) and the harness guard (`scripts/screenshots.mjs --only cards`) agree. Everything adapts by
 * the card's own width, never by where it is mounted (one-workspace-view): the same card is the side panel's, a
 * column of the tab's, Home's pane's and a phone's.
 */
export const CARD_VIEW = {
  /** Before | After side by side from here; under it, a two-up grid of the After images with one Before/After switch. */
  pairsSideBySide: 520,
  /** Under this the freshness moves from the header to the subtitle line, so the title keeps the row. */
  narrowHead: 440,
  /** Pairs drawn side by side before "N more pairs". */
  pairsShown: 3,
  /** A text block over this many lines clips with "Read all · N words". */
  textLines: 6,
  /** A gallery thumbnail is at least this wide; under `narrowHead` it is always two a row. */
  thumbMin: 150,
  /** A single image or video is never taller than this (a tall screenshot scrolls in the viewer, not the card). */
  singleMaxHeight: 420,
  /** Thumbnails keep this shape (width / height); the image is fitted inside, never cropped. */
  thumbAspect: 16 / 10,
  /** Tiny images (an icon) are never blown up past this factor. */
  maxUpscale: 2,
  /** A table column is at least this wide, and a text column at most `colMax` before its cells wrap. */
  colMin: 56, colMax: 220, firstColMax: 168,
  /** Rows a table shows before "Show all N rows". */
  tableRows: 12,
  /** List items before "Show all N". */
  listItems: 10,
  /** Code lines before "Show all N lines". */
  codeLines: 20,
  /** Charts: the bar label column, and a line chart's height. */
  barLabel: 72, lineHeight: 120,
  /** A changed row's thin edge clears after this long on screen. */
  changedSeenMs: 3_000,
} as const;

/** What a card's width decides. `pad` is the block's side padding (12 desktop, 14 on a phone). */
export function cardMode(width: number, compact: boolean) {
  const pad = compact ? 14 : 12;
  const inner = Math.max(0, width - 2 * pad);
  return {
    pad, inner,
    sideBySide: width >= CARD_VIEW.pairsSideBySide,
    freshInSubtitle: width < CARD_VIEW.narrowHead,
    galleryCols: width < CARD_VIEW.narrowHead ? 2 : Math.max(2, Math.min(4, Math.floor((inner + 8) / (CARD_VIEW.thumbMin + 8)))),
  };
}

/** One thumbnail cell's width for `cols` columns with an 8 px gap. */
export const cellWidth = (inner: number, cols: number, gap = 8) => Math.max(0, Math.floor((inner - gap * (cols - 1)) / cols));

/**
 * An image fitted into a box without cropping or blowing up: a tall image is pillar-boxed, a wide one letter-boxed, a
 * tiny one drawn at most `maxUpscale` times its size. Unknown size (0) fills the box.
 */
export function fitInto(natural: { width: number; height: number }, box: { width: number; height: number }, maxUpscale: number = CARD_VIEW.maxUpscale): { width: number; height: number } {
  if (!(natural.width > 0 && natural.height > 0)) return { width: box.width, height: box.height };
  const k = Math.min(box.width / natural.width, box.height / natural.height, maxUpscale);
  return { width: Math.max(1, Math.round(natural.width * k)), height: Math.max(1, Math.round(natural.height * k)) };
}

/** A thumbnail box for a cell width. */
export const thumbBox = (width: number) => ({ width, height: Math.round(width / CARD_VIEW.thumbAspect) });

/** A single image's box: the full width at its own shape, never taller than `singleMaxHeight`, never blown up past 2x. */
export function singleBox(natural: { width: number; height: number }, inner: number): { width: number; height: number } {
  if (!(natural.width > 0 && natural.height > 0)) return thumbBox(inner);
  return fitInto(natural, { width: inner, height: CARD_VIEW.singleMaxHeight });
}

/** "2,400 words". */
export function wordCount(md: string): number {
  return md.replace(/[`*_#>[\]()]/g, " ").split(/\s+/).filter(Boolean).length;
}
/**
 * Whether a text block clips at its width: its lines (paragraph by paragraph, at about 7 px a character, 6.6 on desktop's
 * 13 px) passed `textLines`. An estimate the view errs short on, so a block that just fits never shows "Read all".
 */
export function textLinesAt(md: string, inner: number, compact: boolean): number {
  const perLine = Math.max(12, Math.floor(inner / (compact ? 7.4 : 6.6)));
  return md.split(/\n/).reduce((n, para) => n + Math.max(para.trim() ? 1 : 0.5, Math.ceil(para.length / perLine)), 0);
}
export const textClips = (md: string, inner: number, compact: boolean) => textLinesAt(md, inner, compact) > CARD_VIEW.textLines + 1;

// ---------- tables ----------

/** A cell's text as drawn (a state cell draws a glyph, read aloud as its word). */
export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") return cell.value !== undefined ? String(cell.value) : cell.state ? STATE_WORDS[cell.state] : "";
  return String(cell);
}
export const cellState = (cell: Cell | undefined): ItemState | null => cell && typeof cell === "object" && cell.state ? cell.state : null;
const NUMERIC = /^[−+\-~≈]?\s?[$€£]?[\d.,]+\s?(ms|s|m|h|d|%|x|×|k|K|M|MB|GB|KB|kB|B|req\/s|\/s|rps)?$/;
/** A number or a number with a unit ("640 ms", "−53%", "$18"): right-aligned in tabular figures. */
export function isNumeric(cell: Cell | undefined): boolean {
  if (typeof cell === "number") return true;
  const v = typeof cell === "object" && cell ? cell.value : cell;
  return typeof v === "number" || typeof v === "string" && NUMERIC.test(v.trim());
}

/**
 * Column widths and how a table fits its card. A column is as wide as its longest cell (about 7 px a character at 12 px,
 * plus 16 padding), at least `colMin`, at most `colMax` (the first `firstColMax`; their cells wrap). A column that holds
 * only states is a glyph wide. When the columns are wider than the card, it scrolls sideways with the first column
 * pinned and an edge fade; otherwise the columns share the extra width. A column is numeric (right-aligned) when every
 * non-empty cell is a number, unless the table is an option comparison (it has a recommended column), which aligns left.
 */
export type TableLayout = { widths: number[]; scroll: boolean; total: number; numeric: boolean[]; states: boolean[]; legend: ItemState[] };
export function tableLayout(columns: readonly string[], rows: readonly (readonly Cell[])[], width: number, options: { recommend?: number; compact?: boolean } = {}): TableLayout {
  const ch = options.compact ? 7.4 : 6.8;
  const n = columns.length;
  const states = columns.map((_, j) => rows.length > 0 && rows.every(r => r[j] === undefined || r[j] === null || cellState(r[j]) !== null) && rows.some(r => cellState(r[j]) !== null));
  const numeric = columns.map((_, j) => options.recommend === undefined && j > 0 && !states[j] && rows.some(r => cellText(r[j]) !== "") && rows.every(r => cellText(r[j]) === "" || isNumeric(r[j])));
  // A header breaks only between words (never "Chrom / e"): its column is at least its longest word, at the header's
  // semibold width, plus the cell's padding.
  const hch = options.compact ? 8 : 7.4;
  const headMin = (h: string, j: number) => Math.ceil(Math.max(0, ...h.split(/\s+/).map(w => w.length)) * hch) + 16 + (options.recommend === j ? 12 : 0);
  const natural = columns.map((h, j) => Math.max(Math.min(headMin(h, j), j === 0 ? CARD_VIEW.firstColMax : CARD_VIEW.colMax), naturalOf(h, j)));
  function naturalOf(h: string, j: number): number {
    if (states[j]) return Math.max(CARD_VIEW.colMin, Math.ceil(h.length * ch * 0.92) + 16);
    // A header may wrap onto two lines ("Before / p95"), so its longest word sets its width, never the whole header.
    const longest = Math.max(headerChars(h) * 0.92, ...rows.map(r => longestWordAware(cellText(r[j]))));
    const cap = j === 0 ? CARD_VIEW.firstColMax : CARD_VIEW.colMax;
    return Math.min(cap, Math.max(CARD_VIEW.colMin, Math.ceil(longest * ch) + 16 + (options.recommend === j ? 12 : 0)));
  }
  const total = natural.reduce((a, b) => a + b, 0);
  const legend = [...new Set(rows.flatMap(r => r.map(cellState)).filter((s): s is ItemState => !!s))];
  if (total <= width || n === 0) {
    const extra = n ? (width - total) / n : 0;
    const widths = natural.map(w => Math.floor(w + extra));
    return { widths, scroll: false, total: widths.reduce((a, b) => a + b, 0), numeric, states, legend };
  }
  return { widths: natural, scroll: true, total, numeric, states, legend };
}
/** A header's width in characters: short ones whole, longer ones wrap to two lines at their longest word. */
function headerChars(h: string): number {
  if (h.length <= 8) return h.length;
  return Math.max(Math.ceil(h.length / 2), ...h.split(/\s+/).map(w => w.length));
}
/** A cell's width in characters for layout: its length, but a cell that will wrap counts as its longest word or 18 characters. */
function longestWordAware(text: string): number {
  if (text.length <= 22) return text.length;
  return Math.max(18, ...text.split(/\s+/).map(w => Math.min(w.length, 30)));
}

/** The one-line legend's words, in the order the design gives them. */
export const STATE_WORDS: Record<ItemState, string> = { done: "passed", failed: "failed", running: "running", warning: "warning", todo: "not started", skipped: "skipped" };
export const LEGEND_ORDER: ItemState[] = ["done", "failed", "running", "warning", "todo", "skipped"];
/** The legend for a table's states; with `stale`, running reads "was running" (the amber clock). */
export function legendItems(states: readonly ItemState[], stale: boolean): { state: ItemState; word: string }[] {
  return LEGEND_ORDER.filter(s => states.includes(s)).map(s => ({ state: s, word: s === "running" && stale ? "was running" : STATE_WORDS[s] }));
}

// ---------- charts ----------

/** Bar widths as fractions of the track (the largest value fills `fill` of it, so its number fits beside it). */
export function barFractions(series: readonly { values: readonly number[] }[], fill = 0.78): number[][] {
  const max = Math.max(0, ...series.flatMap(s => s.values.map(v => Math.abs(v))));
  return series.map(s => s.values.map(v => max > 0 ? Math.abs(v) / max * fill : 0));
}
/** A line chart's points in a box, the last one marked; one axis from zero (or the minimum when it is negative). */
export function linePoints(values: readonly number[], box: { width: number; height: number }, pad = { x: 6, y: 10 }): { x: number; y: number }[] {
  const max = Math.max(...values), min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (box.width - 2 * pad.x) / (values.length - 1) : 0;
  return values.map((v, i) => ({ x: pad.x + i * step, y: box.height - pad.y - (v - min) / span * (box.height - 2 * pad.y) }));
}
/** "1.2M", "812k", "96": short numbers for chart labels. */
export function shortNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e4) return `${trim(v / 1e3)}k`;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : trim(v);
}
const trim = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, "");

// ---------- files, code ----------

/** "18 KB", "12 MB". */
export function bytesLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
export type FileKind = "image" | "video" | "markdown" | "pdf" | "page" | "archive" | "data" | "file";
export function fileKind(item: { path?: string; url?: string; media?: { mime: string } }): FileKind {
  if (item.url) return "page";
  if (item.media) return item.media.mime.startsWith("video/") ? "video" : "image";
  const ext = (item.path ?? "").toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (["html", "htm"].includes(ext)) return "page";
  if (["zip", "tgz", "gz", "tar"].includes(ext)) return "archive";
  if (["json", "csv", "tsv", "jsonl", "ndjson", "txt", "log"].includes(ext)) return "data";
  return "file";
}
/** A URL as the row shows it before opening: the host and path, never the query. */
export function shownAddress(url: string): string {
  try { const u = new URL(url); return `${u.host}${u.pathname === "/" ? "" : u.pathname}`; } catch { return url; }
}
/** A path's last part, for a row title. */
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Code lines with their numbers: from `ref`'s first line ("src/charge.ts:84-92"), else 1. */
export function codeLines(text: string, ref?: string): { n: number; text: string }[] {
  const start = Number(/:(\d+)/.exec(ref ?? "")?.[1] ?? 1) || 1;
  return text.replace(/\n$/, "").split("\n").map((t, i) => ({ n: start + i, text: t }));
}
/** A diff line's tone from its first character. */
export const diffTone = (line: string): "add" | "del" | null => line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : null;

// ---------- the card itself ----------

/**
 * A folded card is one header: a title of at most two lines and one line under it. Its height budget, per layout, is
 * what the harness guard checks on every width (tests: no folded card taller than this).
 */
export const foldedBudget = (compact: boolean) => compact ? 96 : 76;

/**
 * The view's order of cards in a section: newest update first when the view opens, then stable. A card that updates
 * keeps its place ("newest update first" applies on next open), a new one comes first.
 */
export function stableOrder(previous: readonly string[] | null, cards: readonly { id: string; updatedAt: string }[]): string[] {
  const newest = [...cards].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(c => c.id);
  if (!previous) return newest;
  const ids = new Set(cards.map(c => c.id));
  const kept = previous.filter(id => ids.has(id));
  const fresh = newest.filter(id => !kept.includes(id));
  return [...fresh, ...kept];
}

/**
 * Where a card sits (DESIGN "Where cards live"): a card an open question points at goes right under Needs you; the
 * rest go after Your questions in one column, join the movable pool in two, and follow Pull requests in three.
 */
export type CardPlace = "pointed" | "other";
export const placeOf = (cardId: string, pointed: ReadonlySet<string>): CardPlace => pointed.has(cardId) ? "pointed" : "other";

/** The open questions pointing at cards: card id → question id (the first open one), from the questions' links. */
export function pointedCards(questions: readonly { id: string; answer?: unknown; closed?: unknown; links?: readonly { card?: string }[] | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const q of questions) if (!q.answer && !q.closed) for (const l of q.links ?? []) if (l.card && !out.has(l.card)) out.set(l.card, q.id);
  return out;
}

/** Whether a card starts folded as old: not updated for 7 days and not kept. The developer's own fold wins after. */
export const startsFolded = (card: { updatedAt: string; keep: boolean }, now: number) => !card.keep && now - Date.parse(card.updatedAt) > CARD_LIMITS.oldMs;

/** The header's freshness at `now`, from the server's kind (it knows the agent's turn) and the card's time: never a ticking clock between renders. */
export function freshLabel(kind: "live" | "updated" | "stale" | "old", serverLabel: string, updatedAt: string, now: number): string {
  const since = now - Date.parse(updatedAt);
  // Under a minute reads "just now", never "0 s" (or "agent idle · 12 s").
  const recent = since < 60_000;
  if (kind === "live") return recent ? "live · just now" : `live · ${ago(since)} ago`;
  if (kind === "updated") return recent ? "Updated just now" : `Updated ${ago(since)} ago`;
  if (kind === "old") return `${ago(since)} ago`;
  return serverLabel.replace(/· \d+ s$/, "· just now");
}
