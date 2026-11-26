import { z } from "zod";

/**
 * Every list that grows with use is drawn and sent in pages (invariant pr-scale-lists-batch-not-throw, "every list
 * pages"). 2026-11-26, Tom: a busy workspace (~175 questions, a long activity log) lagged on the Activity card's
 * "Show all", then made the whole sidebar scroll for ever. A folded list shows `preview` rows and "Show all N"; Show all
 * opens pages of `size` rows with "26–50 of 312" and Previous/Next. Search finds across every page and pages its hits.
 */
export const PAGE = {
  /** Rows on one page once a list is opened ("Show all"). */
  size: 25,
  /** Rows a folded list shows before "Show all N". */
  preview: 5,
  /** Finished items an agent tool returns in full before it says "+N more" (paging or a filter gets the rest). */
  recentDone: 5,
  /** The most rows one paged read returns, whatever it asks for. */
  maxLimit: 100,
} as const;

export type PageInfo = {
  /** 0-based, clamped to the pages there are. */
  page: number;
  pages: number;
  total: number;
  /** 0-based index of the first row on this page, and one past the last. */
  from: number;
  to: number;
};

/** Which rows page `page` holds; a page past the end clamps to the last one (a list that shrank under it). */
export function pageInfo(total: number, page: number, size: number = PAGE.size): PageInfo {
  const n = Math.max(0, Math.floor(total));
  const per = Math.max(1, Math.floor(size));
  const pages = Math.max(1, Math.ceil(n / per));
  const at = Math.min(Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)), pages - 1);
  return { page: at, pages, total: n, from: at * per, to: Math.min(n, (at + 1) * per) };
}

/** "26–50 of 312", "1 of 1", "0 of 0". The pager's one line, read aloud as "Rows 26 to 50 of 312". */
export function pageLabel(p: Pick<PageInfo, "from" | "to" | "total">): string {
  if (!p.total) return "0 of 0";
  return p.to - p.from <= 1 ? `${p.from + 1} of ${p.total}` : `${p.from + 1}–${p.to} of ${p.total}`;
}
export const pageSpoken = (p: Pick<PageInfo, "from" | "to" | "total">): string =>
  !p.total ? "No rows" : p.to - p.from <= 1 ? `Row ${p.from + 1} of ${p.total}` : `Rows ${p.from + 1} to ${p.to} of ${p.total}`;

export function pageOf<T>(items: readonly T[], page: number, size: number = PAGE.size): { items: T[]; info: PageInfo } {
  const info = pageInfo(items.length, page, size);
  return { items: items.slice(info.from, info.to), info };
}

/** offset/limit as a paged read takes them (agent tools, follow.activity), bounded by PAGE.maxLimit. */
export const pageInput = {
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().positive().max(PAGE.maxLimit).optional(),
};
export function window<T>(items: readonly T[], offset = 0, limit: number = PAGE.size): { items: T[]; offset: number; total: number; more: number } {
  const lim = Math.min(Math.max(1, limit), PAGE.maxLimit);
  const off = Math.min(Math.max(0, offset), items.length);
  const out = items.slice(off, off + lim);
  return { items: out, offset: off, total: items.length, more: Math.max(0, items.length - off - out.length) };
}

/**
 * An agent tool's list: what is still active in full, finished items as a count plus the most recent few
 * (`recent`, newest first as given). `more` says how many finished ones were left out and how to get them.
 */
export type Bounded<T> = { items: T[]; done: { total: number; shown: number; more: number; hint: string | null } };
export function boundDone<T>(items: readonly T[], isDone: (item: T) => boolean, { recent = PAGE.recentDone, newestFirst, hint }: { recent?: number; newestFirst: (a: T, b: T) => number; hint: string }): Bounded<T> {
  const active = items.filter(x => !isDone(x));
  const done = items.filter(isDone).sort(newestFirst);
  const kept = done.slice(0, Math.max(0, recent));
  const keep = new Set<T>([...active, ...kept]);
  return { items: items.filter(x => keep.has(x)), done: { total: done.length, shown: kept.length, more: done.length - kept.length, hint: done.length > kept.length ? hint : null } };
}
