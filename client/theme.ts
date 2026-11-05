import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ViewStyle } from "react-native";
import type { PrTone } from "../shared/attention";

export type Theme = PluginHostProps["theme"];
export type Colors = Theme["colors"];

function channels(color: string): number[] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) return (hex[1].length === 3 ? [...hex[1]].map(d => d + d) : hex[1].match(/../g)!).map(d => parseInt(d, 16));
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
  return fn ? fn.slice(1, 4).map(Number) : null;
}

/** Light when the page ground is bright; unknown colours count as dark, Paseo's default. */
export function isLight(colors: Colors): boolean {
  const rgb = channels(colors.surface0);
  if (!rgb) return false;
  const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

export function withAlpha(color: string, alpha: number): string {
  const rgb = channels(color);
  return rgb ? `rgba(${rgb.join(", ")}, ${alpha})` : color;
}

/** A tag fill in the same hue as its text: 12% on light grounds, 16% on dark ones. */
export function tint(color: string, colors: Colors): string {
  return withAlpha(color, isLight(colors) ? 0.12 : 0.16);
}

/** Card depth: a hairline ring plus a soft lift in light themes, a single faint ring in dark ones. */
export function raised(colors: Colors): ViewStyle {
  return isLight(colors)
    ? { boxShadow: "0px 0px 0px 1px rgba(0, 0, 0, 0.07), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 6px 0px rgba(0, 0, 0, 0.04)" } as ViewStyle
    : { boxShadow: "0px 0px 0px 1px rgba(255, 255, 255, 0.08)" } as ViewStyle;
}

/** Paseo's merged purple. The plugin SDK omits statusMerged, so match the host's light and dark values. */
export function mergedColor(colors: Colors): string {
  const provided = (colors as Colors & { statusMerged?: string }).statusMerged;
  return provided ?? (isLight(colors) ? "#7347af" : "#a890d5");
}

export function toneColor(colors: Colors, tone: PrTone): string {
  switch (tone) {
    case "merged": return mergedColor(colors);
    case "approved": return colors.statusSuccess;
    case "danger": return colors.statusDanger;
    case "warning": return colors.statusWarning;
    default: return colors.foregroundMuted;
  }
}

/**
 * Bar segments: only merged PRs are solid, so the filled length is real progress. Every other PR is
 * a neutral track carrying a short dash in its full status hue, the same colour as its rail text.
 */
export function segmentPaint(colors: Colors, tone: PrTone): { fill: string; line: string | null } {
  if (tone === "merged") return { fill: mergedColor(colors), line: null };
  const fill = withAlpha(colors.foregroundMuted, isLight(colors) ? 0.16 : 0.22);
  switch (tone) {
    case "approved": case "danger": case "warning": return { fill, line: toneColor(colors, tone) };
    default: return { fill, line: null };
  }
}

export const mono = { fontVariant: ["tabular-nums"] as ("tabular-nums")[] };
