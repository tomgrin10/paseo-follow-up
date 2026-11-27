/**
 * The Markdown a card's text block holds (shared/cards.ts `text`), parsed to data the view draws natively: paragraphs,
 * bullet and numbered lists, bold, italics, inline code and links. Raw HTML is never parsed: it stays text. A link keeps
 * its address so the view can show it; only http(s) links are links (javascript:, data: and the rest stay text).
 */
export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; url?: string };
export type MdBlock = { kind: "p"; runs: Run[] } | { kind: "li"; marker: string; runs: Run[] } | { kind: "h"; runs: Run[] };

export function parseMd(md: string): MdBlock[] {
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: "p", runs: inline(para.join(" ")) }); para = []; } };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (bullet) { flush(); out.push({ kind: "li", marker: "•", runs: inline(bullet[1]) }); }
    else if (numbered) { flush(); out.push({ kind: "li", marker: `${numbered[1]}.`, runs: inline(numbered[2]) }); }
    else if (heading) { flush(); out.push({ kind: "h", runs: inline(heading[1]) }); }
    else para.push(line.trim());
  }
  flush();
  return out;
}

const safe = (url: string) => { try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : null; } catch { return null; } };

/** Inline marks: `code` first (nothing inside it is a mark), then [label](url), **bold**, *italic* / _italic_, bare URLs. */
export function inline(text: string): Run[] {
  const runs: Run[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|(https?:\/\/[^\s)]+)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) runs.push({ text: text.slice(at, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], code: true });
    else if (m[2] !== undefined) { const url = safe(m[3]); runs.push(url ? { text: m[2], url } : { text: m[2] }); }
    else if (m[4] !== undefined || m[5] !== undefined) runs.push(...inline(m[4] ?? m[5]).map(r => ({ ...r, bold: true })));
    else if (m[6] !== undefined || m[7] !== undefined) runs.push(...inline(m[6] ?? m[7]).map(r => ({ ...r, italic: true })));
    else if (m[8] !== undefined) { const url = safe(m[8].replace(/[.,;:]+$/, "")); const tail = m[8].slice(url?.length ?? m[8].length); runs.push(url ? { text: url, url } : { text: m[8] }); if (tail) runs.push({ text: tail }); }
    at = m.index! + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}
