/**
 * Links inside text an agent or the developer wrote (a question, a brief, a task's evidence, a Done summary). Pure, so
 * every surface and the tests share one rule; client/rich-text.tsx renders the result. No markdown: only bare
 * http(s) URLs and GitHub PR keys (`owner/repo#123`) become links.
 */
export type TextRun = { text: string; url?: string };

// A URL runs to the next whitespace or bracket/quote that can't be part of it; trailing punctuation is trimmed below.
const URL = /https?:\/\/[^\s<>"'`]+/gi;
// owner/repo#123, not inside a URL or a path (a/b/c#1), and not followed by more word characters.
const PR_KEY = /(?<![\w./#-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d+)(?![\w#])/g;
const TRAILING = /[.,;:!?…]+$/;

/** Drops sentence punctuation and an unbalanced closing bracket from the end of a matched URL. */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1).replace(TRAILING, "");
  }
  return url;
}

/** The text split into plain runs and link runs, in order. Joining every run's `text` gives the input back. */
export function linkify(input: string): TextRun[] {
  const text = input ?? "";
  const hits: { start: number; end: number; url: string }[] = [];
  for (const m of text.matchAll(URL)) {
    const url = trimUrl(m[0]);
    if (/^https?:\/\/[^/\s]+/i.test(url)) hits.push({ start: m.index!, end: m.index! + url.length, url });
  }
  for (const m of text.matchAll(PR_KEY)) {
    const start = m.index!, end = start + m[0].length;
    if (hits.some(h => start < h.end && end > h.start)) continue;
    hits.push({ start, end, url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` });
  }
  hits.sort((a, b) => a.start - b.start);
  const runs: TextRun[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start > at) runs.push({ text: text.slice(at, h.start) });
    runs.push({ text: text.slice(h.start, h.end), url: h.url });
    at = h.end;
  }
  if (at < text.length || !runs.length) runs.push({ text: text.slice(at) });
  return runs;
}

/** Whether the text has anything to link, so a surface can skip the extra elements when it doesn't. */
export const hasLinks = (text: string | null | undefined) => !!text && linkify(text).some(r => r.url);
