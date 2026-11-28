// A one-line field's placeholder always fits on its one line (`a-placeholder-never-wraps`, AGENTS.md invariant 153).
// React Native on Android draws a single-line TextInput's placeholder as a wrapping hint: one too long for the field
// breaks onto a second line that the one-line field clips (React Native issue 14839, open since 2017). A web <input>
// clips it mid-word instead. So the field never hands the platform a placeholder wider than its text room: it takes
// the longest of the field's wordings that fits, else the shortest cut after its last whole word that fits with "…",
// else none. A hint is never cut inside a word: "Sear…" says less than no hint.

/** Each wording, preferred (longest) first; one string is a single wording. */
export type Placeholder = string | readonly string[];

export const placeholderWordings = (p: Placeholder): readonly string[] => (typeof p === "string" ? [p] : p);
/** The full wording: the field's accessible name whatever wording is shown. */
export const fullPlaceholder = (p: Placeholder): string => placeholderWordings(p)[0] ?? "";

// Advance widths in em, rounded up from Roboto (Android's system sans), which runs wider than SF and Inter: an
// estimate where the platform offers no measure (native). Better a word shorter than a clipped line.
const NARROW = new Set([..."iljI.,:;'!|"]);
const SEMI = new Set([..."tfr()[]-/ "]);
const WIDE = new Set([..."mwMW@%"]);
/** Width of `text` in px at `fontSize` px: an upper estimate for the system sans. */
export function estimateTextWidth(text: string, fontSize: number, letterSpacing = 0): number {
  let em = 0;
  for (const ch of text) {
    em += NARROW.has(ch) ? 0.27 : SEMI.has(ch) ? 0.36 : WIDE.has(ch) ? 0.9 : ch === "…" ? 0.8 : /[A-Z]/.test(ch) ? 0.7 : 0.58;
  }
  return em * fontSize * 1.05 + letterSpacing * [...text].length;
}

/**
 * The wording to show in `room` px of text width: the first that fits, else the last cut after a whole word with "…"
 * ("Filter, or paste…"), else "". Before the field has a width (`room` null) it is `before`: the full wording by
 * default, the one the field asked for.
 */
export function fitPlaceholder(p: Placeholder, room: number | null, measure: (text: string) => number, before: "full" | "shortest" = "full"): string {
  const all = placeholderWordings(p);
  if (!all.length) return "";
  if (room === null || !Number.isFinite(room)) return before === "full" ? all[0]! : all[all.length - 1]!;
  for (const w of all) if (measure(w) <= room) return w;
  const words = all[all.length - 1]!.split(/(?<=\s)/);
  for (let n = words.length - 1; n > 0; n--) {
    const cut = `${words.slice(0, n).join("").trimEnd().replace(/[,;:–—-]+$/, "")}…`;
    if (measure(cut) <= room) return cut;
  }
  return "";
}

type Style = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/**
 * The horizontal text room of a field `width` px wide with this flattened style: its width less its left and right
 * padding. `nativeDefault` is the platform's own padding where the style sets none (Android's EditText has some).
 */
export function textRoom(width: number, style: Style, nativeDefault = 0): number {
  const side = (...keys: string[]) => { for (const k of keys) { const v = num(style[k]); if (v !== undefined) return v; } return nativeDefault; };
  return width - side("paddingLeft", "paddingStart", "paddingHorizontal", "padding") - side("paddingRight", "paddingEnd", "paddingHorizontal", "padding")
    - (num(style.borderLeftWidth) ?? num(style.borderWidth) ?? 0) - (num(style.borderRightWidth) ?? num(style.borderWidth) ?? 0);
}

/** The font size the platform draws: the style's (React Native's default 14) times the system font scale, capped. */
export function drawnFontSize(style: Style, fontScale: number, opts: { allowFontScaling?: boolean; maxFontSizeMultiplier?: number | null } = {}): number {
  const size = num(style.fontSize) ?? 14;
  if (opts.allowFontScaling === false) return size;
  const cap = opts.maxFontSizeMultiplier && opts.maxFontSizeMultiplier >= 1 ? opts.maxFontSizeMultiplier : Infinity;
  return size * Math.min(Math.max(fontScale || 1, 1 / 4), cap);
}
