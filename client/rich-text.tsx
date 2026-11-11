import { Platform, type StyleProp, type TextStyle } from "react-native";
import { Text } from "./text";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { linkify } from "../shared/links";

const open = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
// Web: a long URL has no spaces to wrap at, so let it break anywhere rather than push the sheet sideways.
const wrap: TextStyle = Platform.OS === "web" ? { overflowWrap: "anywhere", wordBreak: "break-word" } as unknown as TextStyle : {};

/**
 * Text an agent or the developer wrote: a question, an option, a brief, a task's evidence, a Done summary, a batch
 * result. The one way Follow-up renders it (tests/rich-text.test.ts fails on a plain <Text> around such a field), so a
 * URL or `owner/repo#123` anywhere in it is a link: underlined, keyboard-focusable on web, opened in the browser.
 *
 * `plain` keeps the text inert, for a one-line title inside a row that is itself pressable (a link inside a row's tap
 * target is a trap); the row opens a surface that shows the same text with its links.
 */
export function RichText({ children, style, linkColor, numberOfLines, selectable, plain = false, accessibilityRole, tooltip }: {
  children: string | null | undefined; style?: StyleProp<TextStyle>; linkColor?: string; numberOfLines?: number; selectable?: boolean; plain?: boolean; accessibilityRole?: "header" | "text"; tooltip?: string;
}) {
  const runs = linkify(children ?? "");
  const linked = !plain && runs.some(r => r.url);
  return <Text style={[style, linked ? wrap : null]} numberOfLines={numberOfLines} selectable={selectable} accessibilityRole={accessibilityRole} {...(tooltip && Platform.OS === "web" ? { title: tooltip } as object : {})}>
    {linked ? runs.map((r, i) => r.url
      ? <Text key={i} accessibilityRole="link" accessibilityLabel={`Open ${r.text}`} accessibilityHint="Opens in your browser"
          // Web: an anchor, so Tab reaches it and Enter opens it; the click opens it through Paseo, not this page.
          {...(Platform.OS === "web" ? { href: r.url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } } : {})}
          onPress={(e: { preventDefault?: () => void; stopPropagation?: () => void }) => { e?.preventDefault?.(); e?.stopPropagation?.(); open(r.url!); }}
          style={[{ textDecorationLine: "underline" }, linkColor ? { color: linkColor } : null]}>{r.text}</Text>
      : r.text) : children ?? ""}
  </Text>;
}
