import { layoutQueries } from "./layout-swap";
import type { HomeGroupId, HomeModel, PaseoWorkspaceLite } from "./home";
import type { ArchivedListWorkspace, ListWorkspace as Workspace } from "./list";
import { linkedSearchText, type LinkedSearchItem } from "./linked-display";

/**
 * Home's omnibox search (1.3.0-beta.2). Pure and client-side: the index is built once per model change and every
 * keystroke only walks it, so 100 workspaces and 200 agents stay instant with no RPC.
 *
 * Matching is token based and case-insensitive: every query token must match a token of the workstream, by exact
 * word, prefix, a single typo (four letters or more) or, from three characters, inside a word. "#1402", "1402",
 * "ACME-1312" and "scim okta" all work. Ranking weighs the field the token matched (name above branch and PR above
 * agent, project and ask), adds a bonus when the query appears as one phrase, and a little for recency.
 *
 * Every search over workspaces orders by one rank first (`rankOf`, `byRank`; invariant
 * one-ranking-for-every-workspace-search): a title match, then linked items, branch and PR, then the rest of the row.
 * Home's search breaks a tie by score; the sidebar filter by the list's own order.
 */

export type SearchField = "name" | "branch" | "pr" | "linked" | "agent" | "project" | "ask";
/** `linked`: a linked item's key and title (Linear, Slack, docs), so "ACME-1312" finds the workspace that links it. */
export const FIELD_WEIGHT: Record<SearchField, number> = { name: 100, branch: 70, pr: 70, linked: 60, agent: 55, project: 40, ask: 30 };
/** The rank tier a field's match puts a workspace in: 0 the title, 1 linked items, branch and PR, 2 the rest. */
export const FIELD_TIER: Record<SearchField, 0 | 1 | 2> = { name: 0, branch: 1, pr: 1, linked: 1, agent: 2, project: 2, ask: 2 };
export const FIELD_LABEL: Record<SearchField, string> = { name: "Name", branch: "Branch", pr: "PR", linked: "Linked", agent: "Agent", project: "Project", ask: "Ask" };

export type SearchDoc = {
  /** The Home row key the result selects. */
  key: string;
  title: string;
  /** "archived" only shows while searching, under its own header at the bottom. */
  group: HomeGroupId | "archived";
  at: string | null;
  fields: { field: SearchField; text: string }[];
};
export type Range = [start: number, end: number];

type Token = { t: string; start: number; end: number };
type Part = { field: SearchField; text: string; tokens: Token[]; joined: string };
type Entry = { doc: SearchDoc; parts: Part[] };
export type SearchIndex = { entries: Entry[] };

const WORD = /[\p{L}\p{N}]+/gu;
function tokenize(text: string): Token[] {
  const lower = text.toLowerCase();
  // toLowerCase keeps offsets for the scripts we see here; when it doesn't, fall back to unhighlighted tokens.
  const same = lower.length === text.length;
  const out: Token[] = [];
  for (const m of lower.matchAll(WORD)) out.push({ t: m[0], start: same ? m.index! : 0, end: same ? m.index! + m[0].length : 0 });
  return out;
}
export const queryTokens = (query: string): string[] => [...new Set(tokenize(query).map(t => t.t))];

export function indexDocs(docs: SearchDoc[]): SearchIndex {
  return { entries: docs.map(doc => ({ doc, parts: doc.fields.filter(f => f.text.trim()).map(f => {
    const tokens = tokenize(f.text);
    return { field: f.field, text: f.text, tokens, joined: tokens.map(t => t.t).join(" ") };
  }) })) };
}

/** True when a and b differ by at most one edit (insert, delete, substitute or swap of neighbours). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** How well one query token matches one word, 0 for no match. */
export function tokenMatch(q: string, t: string): number {
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.85;
  // Numbers are identities (ACME-1312, PR #1402): 1352 isn't a typo of 1312. Exact or a prefix while typing, nothing fuzzy.
  if (/^\d+$/.test(q)) return 0;
  if (q.length >= 4) {
    if (withinOneEdit(q, t)) return 0.55;
    // A typo while still typing: compare against the word's start.
    if (t.length > q.length && withinOneEdit(q, t.slice(0, q.length))) return 0.45;
  }
  if (q.length >= 3 && t.includes(q)) return 0.4;
  return 0;
}

export type SearchHit = {
  key: string;
  title: string;
  group: SearchDoc["group"];
  score: number;
  /** Matched words inside the title. */
  titleRanges: Range[];
  /** Where it matched when that's not the title: the field and its text with the matched words. */
  via: { field: SearchField; text: string; ranges: Range[] } | null;
  /**
   * How it ranks against other hits (`byRank`): `tier` is the worst tier any query token needed (0 every token in the
   * title, 1 linked items, branch or PR, 2 the rest); in the title tier, `strength` 2 is a whole word or a word start,
   * 1 a typo, 0 inside a word (the weakest token decides). Optional only for rows built outside `search`.
   */
  rank?: Rank;
  /** Query reconstructed from another keyboard layout; absent on direct hits. */
  layoutQuery?: string;
};
export type Rank = { tier: 0 | 1 | 2; strength: 0 | 1 | 2 };
const strengthOf = (m: number): 0 | 1 | 2 => m >= 0.85 ? 2 : m >= 0.45 ? 1 : 0;
const LAST: Rank = { tier: 2, strength: 0 };
/**
 * The one ranking for every search over workspaces (one-ranking-for-every-workspace-search): a lower tier first, then
 * a stronger title match. Equal ranks are a tie each caller breaks its own way (score, or the list's order).
 */
export function byRank(a: Pick<SearchHit, "rank" | "layoutQuery"> | undefined, b: Pick<SearchHit, "rank" | "layoutQuery"> | undefined): number {
  const x = a?.rank ?? LAST, y = b?.rank ?? LAST;
  return Number(!!a?.layoutQuery) - Number(!!b?.layoutQuery) || x.tier - y.tier || y.strength - x.strength;
}

const DAY = 86_400_000;
/**
 * Every workstream matching all the query's tokens, best first. Archived ones come last, after every live one.
 * An empty query returns nothing: Home shows its groups instead.
 */
export function search(index: SearchIndex, query: string, now = Date.now(), limit = 60, physical?: string | null): SearchHit[] {
  if (!queryTokens(query).length) return [];
  const direct = searchTyped(index, query, now, Infinity);
  const seen = new Set(direct.map(h => h.key));
  const converted: SearchHit[] = [];
  for (const variant of layoutQueries(query, physical)) for (const hit of searchTyped(index, variant, now, Infinity)) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key); converted.push({ ...hit, layoutQuery: variant });
  }
  // Keep archived rows under their own heading at the bottom. Inside each group, direct matches come first.
  return [...direct, ...converted].sort((a, b) => Number(a.group === "archived") - Number(b.group === "archived") || byScore(a, b)).slice(0, limit);
}

/** Quiet explanation only when a converted query finds more rows than the typed query. */
export function layoutHint(hits: readonly SearchHit[]): string | null {
  const direct = hits.filter(h => !h.layoutQuery).length;
  const counts = new Map<string, number>();
  for (const h of hits) if (h.layoutQuery) counts.set(h.layoutQuery, (counts.get(h.layoutQuery) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > direct ? best[0] : null;
}

/** Reuse the workspace matcher for agent-tool filters too. */
export function searchRows<T>(rows: readonly T[], fields: (row: T) => SearchDoc["fields"], query: string, now = Date.now()): T[] {
  if (!query.trim()) return [...rows];
  const index = indexDocs(rows.map((r, i) => ({ key: String(i), title: "", group: "quiet", at: null, fields: fields(r) })));
  return search(index, query, now, Infinity).map(h => rows[Number(h.key)]);
}

function searchTyped(index: SearchIndex, query: string, now: number, limit: number): SearchHit[] {
  const qs = queryTokens(query);
  if (!qs.length) return [];
  const phrase = qs.join(" ");
  const hits: SearchHit[] = [];
  for (const { doc, parts } of index.entries) {
    let score = 0;
    let ok = true;
    const matched = new Map<Part, Range[]>();
    const rank: Rank = { tier: 0, strength: 2 };
    for (const q of qs) {
      let best = 0;
      let at: { part: Part; token: Token } | null = null;
      // This token's best tier, and its best title strength.
      let tier: 0 | 1 | 2 = 2, strength: 0 | 1 | 2 = 0;
      for (const part of parts) for (const token of part.tokens) {
        const m = tokenMatch(q, token.t);
        if (!m) continue;
        tier = Math.min(tier, FIELD_TIER[part.field]) as 0 | 1 | 2;
        if (part.field === "name") strength = Math.max(strength, strengthOf(m)) as 0 | 1 | 2;
        const s = m * FIELD_WEIGHT[part.field];
        if (s > best) { best = s; at = { part, token }; }
        // Highlight every word the token matches in a part, not only the best one.
        const list = matched.get(part) ?? [];
        if (token.end > token.start && !list.some(r => r[0] === token.start)) list.push([token.start, token.end]);
        matched.set(part, list);
      }
      if (!at) { ok = false; break; }
      score += best;
      rank.tier = Math.max(rank.tier, tier) as 0 | 1 | 2;
      rank.strength = Math.min(rank.strength, strength) as 0 | 1 | 2;
    }
    if (!ok) continue;
    const phraseIn = parts.filter(p => p.joined.includes(phrase)).map(p => FIELD_WEIGHT[p.field]);
    if (qs.length > 1 && phraseIn.length) score += Math.max(...phraseIn) * 0.3;
    // A name that starts with the query beats one that only contains it.
    if (parts.some(p => p.field === "name" && p.joined.startsWith(phrase))) score += 15;
    const t = doc.at ? Date.parse(doc.at) : NaN;
    if (Number.isFinite(t)) score += 8 * Math.exp(-Math.max(0, now - t) / (7 * DAY));
    const name = parts.find(p => p.field === "name");
    const titleRanges = name ? merge(matched.get(name) ?? []) : [];
    const others = parts.filter(p => p.field !== "name" && matched.has(p))
      .sort((a, b) => (matched.get(b)!.length - matched.get(a)!.length) || FIELD_WEIGHT[b.field] - FIELD_WEIGHT[a.field]);
    // Show "via" only when the title alone doesn't explain the match.
    const coveredByTitle = qs.every(q => name?.tokens.some(tk => tokenMatch(q, tk.t) > 0));
    const via = !coveredByTitle && others[0] ? { field: others[0].field, text: others[0].text, ranges: merge(matched.get(others[0])!) } : null;
    hits.push({ key: doc.key, title: doc.title, group: doc.group, score, titleRanges, via, rank: rank.tier ? { tier: rank.tier, strength: 0 } : rank });
  }
  const live = hits.filter(h => h.group !== "archived").sort(byScore);
  const archived = hits.filter(h => h.group === "archived").sort(byScore);
  return [...live, ...archived].slice(0, limit);
}
const byScore = (a: SearchHit, b: SearchHit) => byRank(a, b) || b.score - a.score || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);
function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) { const last = out.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r] as Range); }
  return out;
}

/** Splits text into plain and highlighted runs for rendering. */
export function highlightRuns(text: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  for (const [s, e] of ranges) {
    if (s > i) out.push({ text: text.slice(i, s), hit: false });
    if (e > s) out.push({ text: text.slice(s, e), hit: true });
    i = Math.max(i, e);
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

/** A long field (an ask, a PR title list) cut around its first match so the highlight stays visible. */
export function excerpt(text: string, ranges: Range[], max = 80, lead = 20): { text: string; ranges: Range[] } {
  if (text.length <= max || !ranges.length) return { text: text.length <= max ? text : `${text.slice(0, max - 1)}…`, ranges: ranges.filter(r => r[1] <= max - 1) };
  // `lead`: the words kept before the match; a narrow row (a panel section) keeps fewer so the match stays on screen.
  let start = Math.max(0, Math.min(ranges[0][0] - lead, text.length - max));
  // Never cut into an id ("#143", "APP-139"): from the start when the match already fits, else at a word boundary.
  // (A one-line row shows roughly the first 60% of `max` beside its badges, so "fits" means it ends inside that.)
  if (ranges[0][1] <= Math.floor(max * 0.6)) start = 0;
  else if (start > 0 && /\S/.test(text[start - 1])) { const next = text.indexOf(" ", start); if (next >= 0 && next < ranges[0][0]) start = next + 1; }
  const end = Math.min(text.length, start + max);
  const pre = start > 0 ? "…" : "";
  const shift = pre.length - start;
  return { text: `${pre}${text.slice(start, end)}${end < text.length ? "…" : ""}`, ranges: ranges.filter(r => r[0] >= start && r[1] <= end).map(r => [r[0] + shift, r[1] + shift] as Range) };
}

// ---------- the omnibox seam ----------

/**
 * One row of the omnibox. Home's own provider returns workstreams; the Overseer's provider adds one
 * "Ask the Overseer: <query>" row (1.4.0-beta.0), always listed last.
 */
export type WorkspaceItem = { provider: string; key: string; hit: SearchHit; ask?: undefined };
export type AskItem = { provider: "overseer"; key: typeof ASK_KEY; ask: string; hit?: undefined };
export type OmniboxItem = WorkspaceItem | AskItem;
export type OmniboxProvider = { id: string; results(query: string): OmniboxItem[] };
export const ASK_KEY = "ask:overseer";
/** The longest ask the omnibox sends; anything longer belongs in the Overseer's reply box. */
export const ASK_MAX = 2000;
/** Results of every provider, in provider order; each provider ranks its own. An ask row always goes last. */
export function omniboxResults(providers: readonly OmniboxProvider[], query: string): OmniboxItem[] {
  const all = providers.flatMap(p => p.results(query));
  return [...all.filter(i => !i.ask), ...all.filter(i => i.ask)];
}
/** The Overseer's row: the query as it was typed, trimmed. Nothing while the Overseer is off or the query is blank. */
export function overseerProvider(enabled: boolean): OmniboxProvider {
  return { id: "overseer", results: query => {
    const ask = query.trim().replace(/\s+/g, " ");
    return enabled && ask && ask.length <= ASK_MAX ? [{ provider: "overseer", key: ASK_KEY, ask }] : [];
  } };
}
/**
 * The row Enter picks before any arrow key: the first one, except a lone one-word ask. That is usually a typo or
 * a search that missed, and Enter must not send it to an agent; ↓ or a tap still picks it.
 */
export function defaultActive(results: readonly OmniboxItem[] | null): number {
  return results?.length === 1 && results[0].ask !== undefined && !/\s/.test(results[0].ask) ? -1 : 0;
}
export function workspaceProvider(index: SearchIndex, now = Date.now(), physical?: string | null): OmniboxProvider {
  return { id: "workspaces", results: query => search(index, query, now, 60, physical).map(hit => ({ provider: "workspaces", key: hit.key, hit })) };
}

// ---------- documents from Home's sources ----------


/** An agent as search needs it: its title and where it works. Subagents count for their workspace. */
export type AgentLite = { id: string; title: string | null; workspaceId: string | null };

/**
 * One document per Home row, plus Follow-up's archived workspaces. A workspace row carries every agent title in
 * that workspace; an agent row (one of several roots) carries its own title too.
 */
export function homeSearchDocs(input: { model: HomeModel; paseo: PaseoWorkspaceLite[]; tracked: Workspace[]; archived?: ArchivedListWorkspace[]; agents?: AgentLite[]; linked?: Record<string, readonly LinkedSearchItem[]> }): SearchDoc[] {
  const paseo = new Map(input.paseo.map(p => [p.id, p]));
  const tracked = new Map(input.tracked.map(w => [w.id, w]));
  const agentsBy = new Map<string, string[]>();
  for (const a of input.agents ?? []) if (a.workspaceId && a.title) agentsBy.set(a.workspaceId, [...agentsBy.get(a.workspaceId) ?? [], a.title]);
  const workspaceFields = (id: string | null, w: Pick<Workspace | ArchivedListWorkspace, "prs"> | undefined): SearchDoc["fields"] => {
    if (!id) return [];
    const p = paseo.get(id);
    const out: SearchDoc["fields"] = [];
    if (p?.branch) out.push({ field: "branch", text: p.branch });
    const prs = new Map<string, string>();
    if (p?.pr) prs.set(String(p.pr.number ?? p.pr.title), `${p.pr.number ? `#${p.pr.number} ` : ""}${p.pr.title}`);
    for (const pr of w?.prs ?? []) prs.set(String(pr.number), `#${pr.number}${pr.snapshot?.title ? ` ${pr.snapshot.title}` : ""}`);
    for (const text of prs.values()) out.push({ field: "pr", text });
    // Stack names are usually the branch.
    for (const stack of new Set((w?.prs ?? []).map(pr => pr.stack))) if (stack && stack !== p?.branch && !stack.startsWith("PR #")) out.push({ field: "branch", text: stack });
    for (const title of new Set(agentsBy.get(id) ?? [])) out.push({ field: "agent", text: title });
    for (const text of new Set((input.linked?.[id] ?? []).map(linkedSearchText))) if (text) out.push({ field: "linked", text });
    return out;
  };
  const docs: SearchDoc[] = [];
  for (const g of input.model.groups) for (const s of g.items) {
    const w = s.workspaceId ? tracked.get(s.workspaceId) : undefined;
    docs.push({ key: s.key, title: s.agent ? `${s.title} › ${s.agent}` : s.title, group: g.id, at: s.activityAt ?? s.at, fields: [
      { field: "name", text: s.agent ? `${s.title} › ${s.agent}` : s.title },
      ...(w && w.title !== s.title ? [{ field: "name" as const, text: w.title }] : []),
      ...workspaceFields(s.workspaceId, w),
      ...(s.project ? [{ field: "project" as const, text: s.project }] : []),
      ...(s.line ? [{ field: "ask" as const, text: s.line }] : []),
      ...(w?.goal && w.goal !== w.title ? [{ field: "ask" as const, text: w.goal }] : []),
    ] });
  }
  for (const w of input.archived ?? []) {
    if (input.model.byKey.has(`ws:${w.id}`)) continue;
    docs.push({ key: `ws:${w.id}`, title: w.title, group: "archived", at: w.updatedAt, fields: [{ field: "name", text: w.title }, ...workspaceFields(w.id, w)] });
  }
  return docs;
}

// ---------- item lists inside a workspace (section search) ----------

/**
 * One searchable field of a list item. `shown`: the row already draws this text, so a match there is highlighted in
 * place; a match only in a hidden field (a task's evidence, a PR's branch or check) becomes line 2, "<label> · excerpt".
 */
export type ItemField = { label: string; text: string; shown: boolean };
export type ItemHit = {
  /** Matched words per field, in the order `fields` gave them (empty when that field didn't match). */
  ranges: Range[][];
  /** The hidden field to show as line 2 when the shown fields don't explain the match. */
  via: { label: string; text: string; ranges: Range[] } | null;
};
/**
 * The workspace panel's section search: the same matcher as every workspace search (`tokenMatch`, invariant
 * one-ranking-for-every-workspace-search), applied as a filter. Every query token must match a word of some field.
 * It never re-ranks: an item list keeps its own order. An empty query returns null (not searching).
 */
export function filterItems<T>(items: readonly T[], fieldsOf: (item: T) => readonly ItemField[], query: string): { item: T; hit: ItemHit }[] | null {
  const qs = queryTokens(query);
  if (!qs.length) return null;
  const out: { item: T; hit: ItemHit }[] = [];
  for (const item of items) {
    const fields = fieldsOf(item);
    const parts = fields.map(f => ({ f, tokens: tokenize(f.text) }));
    const ranges: Range[][] = parts.map(() => []);
    // Per query token, the fields it matched in.
    const where: Set<number>[] = [];
    let ok = true;
    for (const q of qs) {
      const at = new Set<number>();
      parts.forEach((p, i) => { for (const token of p.tokens) if (tokenMatch(q, token.t)) { at.add(i); if (token.end > token.start) ranges[i].push([token.start, token.end]); } });
      if (!at.size) { ok = false; break; }
      where.push(at);
    }
    if (!ok) continue;
    const merged = ranges.map(merge);
    const coveredByShown = where.every(at => [...at].some(i => fields[i].shown));
    const hidden = coveredByShown ? -1 : fields.findIndex((f, i) => !f.shown && merged[i].length > 0);
    out.push({ item, hit: { ranges: merged, via: hidden >= 0 ? { label: fields[hidden].label, text: fields[hidden].text, ranges: merged[hidden] } : null } });
  }
  return out;
}

// ---------- hits on list rows ----------

/**
 * What a search hit shows on the list's own Row (search-row-is-the-list-row): the matched words highlighted in place
 * in the title (and "› agent") and in the ask line, or, when the match is in a field the row doesn't show (PR, branch,
 * linked item, agent, project, goal), that field as line 2: "<Field> · excerpt".
 */
export type RowHit = { titleRanges: Range[]; agentRanges: Range[]; lineRanges: Range[] | null; via: SearchHit["via"] };
export function rowHit(hit: SearchHit, row: { title: string; agent?: string | null; line?: string }): RowHit {
  const cut = row.title.length;
  const titleRanges = hit.titleRanges.filter(r => r[0] < cut).map(r => [r[0], Math.min(r[1], cut)] as Range);
  const agentAt = cut + " › ".length;
  const agentRanges = row.agent ? hit.titleRanges.filter(r => r[0] >= agentAt).map(r => [r[0] - agentAt, r[1] - agentAt] as Range) : [];
  // The ask the row already shows: highlight it there instead of repeating it under a label.
  if (hit.via?.field === "ask" && row.line && hit.via.text === row.line) return { titleRanges, agentRanges, lineRanges: hit.via.ranges, via: null };
  return { titleRanges, agentRanges, lineRanges: null, via: hit.via };
}

const sameRanges = (a: Range[] | null | undefined, b: Range[] | null | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1]));
/**
 * typing-never-redraws-unchanged-rows (invariant 148): two hits draw the same row when their highlights and their
 * "<Field> · excerpt" line are equal. Each key builds new hit objects, so Row compares them by this, not by identity.
 */
export function sameHit(a: RowHit | null | undefined, b: RowHit | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return sameRanges(a.titleRanges, b.titleRanges) && sameRanges(a.agentRanges, b.agentRanges) && sameRanges(a.lineRanges, b.lineRanges)
    && (a.via === b.via || (!!a.via && !!b.via && a.via.field === b.via.field && a.via.text === b.via.text && sameRanges(a.via.ranges, b.via.ranges)));
}

/**
 * The sidebar view's filter (2.1): the same matcher and the same rank as Home's search, applied in place. Groups keep
 * their order; inside each, rows rank as Home's search ranks them (`byRank`: title matches first) and an equal rank
 * keeps the chosen sort. Only matching rows stay, groups left empty drop out, and archived workspaces aren't listed
 * (Home's search finds those). An empty query returns the model unchanged.
 */
export function filterHome(model: HomeModel, index: SearchIndex, query: string, now = Date.now(), physical?: string | null): { model: HomeModel; hits: Map<string, SearchHit> | null } {
  if (!queryTokens(query).length) return { model, hits: null };
  const hits = new Map(search(index, query, now, Infinity, physical).filter(h => h.group !== "archived").map(h => [h.key, h]));
  // Array sort is stable: an equal rank keeps the list's own order.
  const groups = model.groups.map(g => ({ ...g, items: g.items.filter(s => hits.has(s.key)).sort((a, b) => byRank(hits.get(a.key), hits.get(b.key))) }))
    .filter(g => g.items.length);
  return { model: { ...model, groups, needs: groups.find(g => g.id === "needs")?.items.length ?? 0 }, hits };
}
