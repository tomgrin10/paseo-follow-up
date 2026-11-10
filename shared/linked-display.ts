import { LINKED_KINDS, classifyLink, type LinkedKind, type LinkedViewItem } from "./linked";

/**
 * What the Linked chip, the Linked sheet and Home's search show (design §5). Pure, so every rule here (counts, order,
 * folding, grouping, paste-to-add, row copy) is tested without rendering; client/linked.tsx only draws it.
 */

type Counts = Partial<Record<LinkedKind, number>>;
const NOUNS: Record<LinkedKind, [one: string, many: string]> = {
  linear: ["Linear issue", "Linear issues"], slack: ["Slack thread", "Slack threads"], artifact: ["artifact", "artifacts"],
  doc: ["doc", "docs"], issue: ["GitHub issue", "GitHub issues"], link: ["link", "links"],
};
/** Group heads in the sheet: "Linear · 6". */
export const KIND_HEADS: Record<LinkedKind, string> = { linear: "Linear", slack: "Slack", artifact: "Artifacts", doc: "Docs", issue: "GitHub issues", link: "Links" };
export const countNoun = (kind: LinkedKind, n: number) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`;
/** Sources the chip shows before folding the rest into +N. */
export const CHIP_MAX = { desktop: 4, phone: 3 } as const;

export type ChipPart = { kind: LinkedKind; count: number };
export type LinkedChipModel = { parts: ChipPart[]; more: number; total: number; tooltip: string; label: string };

/**
 * The chip: one mark and count per kind with items, in the fixed order (linear, slack, artifact, doc, issue, link),
 * at most `max` kinds, then `+N` where N is the hidden kinds' item total. `counts` is the view's: done and cancelled
 * count (an inventory, not a to-do list); the spec, PRs and unconfirmed candidates don't. Null: nothing to show.
 */
export function linkedChip(counts: Counts | undefined, max: number): LinkedChipModel | null {
  const all = LINKED_KINDS.filter(k => (counts?.[k] ?? 0) > 0).map(kind => ({ kind, count: counts![kind]! }));
  if (!all.length) return null;
  const parts = all.slice(0, Math.max(1, max));
  const hidden = all.slice(parts.length);
  const more = hidden.reduce((n, p) => n + p.count, 0);
  const total = all.reduce((n, p) => n + p.count, 0);
  const said = (list: ChipPart[]) => list.map(p => countNoun(p.kind, p.count)).join(", ");
  return {
    parts, more, total,
    tooltip: all.map(p => countNoun(p.kind, p.count)).join(" · "),
    label: `Linked: ${said(parts)}${hidden.length ? `, and ${more} more: ${said(hidden)}` : ""}. Opens the list.`,
  };
}

/** The references line (Spec and Linked) shows only when there's a spec or any linked item; otherwise nothing, as before. */
export function referencesShown(specUrl: string | null | undefined, counts: Counts | undefined): boolean {
  return !!specUrl || LINKED_KINDS.some(k => (counts?.[k] ?? 0) > 0);
}

// ---------- the sheet ----------

export const finished = (i: Pick<LinkedViewItem, "statusTone">) => i.statusTone === "done" || i.statusTone === "cancelled";
/** A group with more open rows than this shows FOLD_SHOW of them plus "Show N more", so a fold never hides only one or two. */
export const FOLD_OVER = 10;
export const FOLD_SHOW = 8;

export type LinkedGroup = {
  kind: LinkedKind; head: string;
  /** Items in the group, without the spec (its own chip counts it), so heads agree with the chip. */
  count: number;
  /** Open rows on screen: the spec first, then newest first. */
  rows: LinkedViewItem[];
  /** Open rows behind "Show N more". */
  moreOpen: number;
  /** Done and cancelled, behind "▸ N done" (empty while filtering: matches all show). */
  done: LinkedViewItem[];
};

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** Every word of the filter appears in the item's key, title, status, why or kind. */
export function itemMatches(i: LinkedViewItem, query: string): boolean {
  const ws = words(query);
  if (!ws.length) return true;
  const hay = [i.key, i.title, i.status, i.why, KIND_HEADS[i.kind], i.spec ? "spec" : null].filter(Boolean).join(" ").toLowerCase();
  return ws.every(w => hay.includes(w));
}

/**
 * The sheet's groups, in the chip's kind order. Open items first (the spec on top, then newest first); done and
 * cancelled fold into "N done" at the end. More than FOLD_OVER open rows show FOLD_SHOW plus "Show N more" unless
 * the kind is in `expanded`. A filter shows every match unfolded.
 */
export function linkedGroups(items: readonly LinkedViewItem[], opts: { query?: string; expanded?: ReadonlySet<LinkedKind> } = {}): LinkedGroup[] {
  const query = opts.query?.trim() ?? "";
  const filtering = !!query;
  const out: LinkedGroup[] = [];
  for (const kind of LINKED_KINDS) {
    const mine = items.filter(i => i.kind === kind && itemMatches(i, query));
    if (!mine.length) continue;
    const newest = (a: LinkedViewItem, b: LinkedViewItem) => Number(b.spec) - Number(a.spec) || b.firstSeen.localeCompare(a.firstSeen) || a.key.localeCompare(b.key);
    const open = mine.filter(i => filtering || !finished(i)).sort(newest);
    const done = filtering ? [] : mine.filter(finished).sort(newest);
    const fold = !filtering && open.length > FOLD_OVER && !opts.expanded?.has(kind);
    out.push({ kind, head: KIND_HEADS[kind], count: mine.filter(i => !i.spec).length, rows: fold ? open.slice(0, FOLD_SHOW) : open, moreOpen: fold ? open.length - FOLD_SHOW : 0, done });
  }
  return out;
}

export type PasteAdd =
  | { action: "add"; ref: string; key: string; kind: LinkedKind; label: string; hint: string }
  | { action: "refuse"; key: string; message: string };

/**
 * The field's "+ Add …" row: what's typed is a Linear key or a link (explicit, so any http(s) URL counts) that isn't in
 * the list yet. A PR is refused on the spot: it has its own card. Anything else is just a filter (null).
 */
export function pasteToAdd(query: string, items: readonly Pick<LinkedViewItem, "key">[]): PasteAdd | null {
  const ref = query.trim();
  if (!ref || /\s/.test(ref)) return null;
  const c = classifyLink(ref, true);
  if (!c) return null;
  if (c.kind === "pr") return { action: "refuse", key: c.key, message: "Pull requests live in the Pull requests card, not here." };
  if (items.some(i => i.key === c.key)) return null;
  const label = c.kind === "linear" || c.kind === "issue" ? c.key : readableUrl(c.url ?? ref);
  const hint = { linear: "Linear issue · checked with Linear", slack: "Slack thread", artifact: "Claude artifact", doc: "Doc", issue: "GitHub issue", link: "Link" }[c.kind];
  return { action: "add", ref, key: c.key, kind: c.kind, label, hint };
}

/** "docs.google.com › …/edit" style: the host and the last path segment, never the whole URL. */
export function readableUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).at(-1);
    return tail ? `${u.hostname.replace(/^www\./, "")} › ${decodeURIComponent(tail).slice(0, 60)}` : u.hostname.replace(/^www\./, "");
  } catch { return url.slice(0, 80); }
}
const hostOf = (url: string | null) => { try { return url ? new URL(url).hostname.replace(/^www\./, "") : null; } catch { return null; } };

export type RowGlyph = { type: "state"; tone: "todo" | "active" | "done" | "cancelled" } | { type: "brand"; icon: "linear" | "slack" | "claude" | "notion" | "googleDocs" | "github" } | { type: "lucide"; name: "File" | "Link" };
export type LinkedRowCopy = { lead: string | null; title: string; meta: string; glyph: RowGlyph; spec: boolean; label: string };

/** Who linked it, and why: the agent's `why` is the most useful line in the sheet. */
export function linkedWho(i: LinkedViewItem, mainAgentId: string | null): string {
  if (i.spec) return "This workspace's spec";
  if (i.origin === "manual") return "Added by you";
  if (i.origin === "published") return i.by && mainAgentId && i.by !== mainAgentId ? "Published from a root session" : "Published by the main agent";
  if (i.origin === "registered") {
    const who = i.by && i.by === mainAgentId ? "Main agent" : "Another agent";
    return i.why ? `${who}: ${i.why}` : `Linked by ${who === "Main agent" ? "the main agent" : "another agent"}`;
  }
  return i.why ?? "Seen in this workspace's work";
}
/** Slack thread ts (in the key) as "Nov 3". */
function threadDate(key: string): string | null {
  const ts = /\/(\d{10})\.\d{6}$/.exec(key)?.[1];
  return ts ? new Date(Number(ts) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
}
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One row of the sheet: a lead, the title, and a meta line (design table). */
export function linkedRow(i: LinkedViewItem, mainAgentId: string | null): LinkedRowCopy {
  const who = linkedWho(i, mainAgentId);
  const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
  const base = { spec: i.spec };
  switch (i.kind) {
    case "linear": {
      const tone = i.statusTone ?? "todo";
      return { ...base, lead: i.key, title: i.title ?? i.key, meta: i.status ? join(i.status, lower(who)) : who, glyph: { type: "state", tone }, label: i.key };
    }
    case "slack": {
      const date = threadDate(i.key);
      return { ...base, lead: null, title: i.title ?? "Slack thread", meta: join(date ? `Thread from ${date}` : null, date ? lower(who) : who), glyph: { type: "brand", icon: "slack" }, label: i.title ?? "the Slack thread" };
    }
    case "artifact":
      return { ...base, lead: null, title: i.title ?? "Untitled artifact", meta: who, glyph: { type: "brand", icon: "claude" }, label: i.title ?? "the artifact" };
    case "doc": {
      const host = hostOf(i.url);
      const icon = host && /notion\.(so|site)$/.test(host) ? "notion" : host && /google\.com$/.test(host) ? "googleDocs" : null;
      return { ...base, lead: null, title: i.title ?? readableUrl(i.url ?? i.key), meta: join(host, host ? lower(who) : who), glyph: icon ? { type: "brand", icon } : { type: "lucide", name: "File" }, label: i.title ?? "the doc" };
    }
    case "issue":
      return { ...base, lead: i.key, title: i.title ?? i.key, meta: i.status ? join(i.status, lower(who)) : who, glyph: { type: "brand", icon: "github" }, label: i.key };
    default: {
      const host = hostOf(i.url);
      return { ...base, lead: null, title: i.title ?? readableUrl(i.url ?? i.key), meta: join(host, host ? lower(who) : who), glyph: { type: "lucide", name: "Link" }, label: i.title ?? host ?? "the link" };
    }
  }
}

/** The sheet's empty state (design §5). */
export const LINKED_EMPTY = "Nothing linked yet. Agents link the issues and threads they start from. Paste one above to add it.";

// ---------- Home search ----------

/** An item as Home's search index needs it. */
export type LinkedSearchItem = { key: string; kind: LinkedKind; title: string | null };
/**
 * The text a linked item is searched by and shown as on the result's second line ("Linked · HER-1312 Vendor sync drops
 * SCIM groups"). Keys that are URLs or Slack ids are never shown; the title stands in.
 */
export function linkedSearchText(i: LinkedSearchItem): string | null {
  if (i.kind === "linear" || i.kind === "issue") return i.title ? `${i.key} ${i.title}` : i.key;
  return i.title ?? (i.kind === "link" || i.kind === "doc" ? readableUrl(i.key) : null);
}
