import type { HomeGroupId, HomeModel, PaseoWorkspaceLite } from "./home";
import type { Workspace } from "./model";

/**
 * Home's omnibox search (1.3.0-beta.2). Pure and client-side: the index is built once per model change and every
 * keystroke only walks it, so 100 workspaces and 200 agents stay instant with no RPC.
 *
 * Matching is token based and case-insensitive: every query token must match a token of the workstream, by exact
 * word, prefix, a single typo (four letters or more) or, from three characters, inside a word. "#1402", "1402",
 * "HER-1312" and "scim okta" all work. Ranking weighs the field the token matched (name above branch and PR above
 * agent, project and ask), adds a bonus when the query appears as one phrase, and a little for recency.
 */

export type SearchField = "name" | "branch" | "pr" | "agent" | "project" | "ask";
export const FIELD_WEIGHT: Record<SearchField, number> = { name: 100, branch: 70, pr: 70, agent: 55, project: 40, ask: 30 };
export const FIELD_LABEL: Record<SearchField, string> = { name: "Name", branch: "Branch", pr: "PR", agent: "Agent", project: "Project", ask: "Ask" };

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
};

const DAY = 86_400_000;
/**
 * Every workstream matching all the query's tokens, best first. Archived ones come last, after every live one.
 * An empty query returns nothing: Home shows its groups instead.
 */
export function search(index: SearchIndex, query: string, now = Date.now(), limit = 60): SearchHit[] {
  const qs = queryTokens(query);
  if (!qs.length) return [];
  const phrase = qs.join(" ");
  const hits: SearchHit[] = [];
  for (const { doc, parts } of index.entries) {
    let score = 0;
    let ok = true;
    const matched = new Map<Part, Range[]>();
    for (const q of qs) {
      let best = 0;
      let at: { part: Part; token: Token } | null = null;
      for (const part of parts) for (const token of part.tokens) {
        const m = tokenMatch(q, token.t);
        if (!m) continue;
        const s = m * FIELD_WEIGHT[part.field];
        if (s > best) { best = s; at = { part, token }; }
        // Highlight every word the token matches in a part, not only the best one.
        const list = matched.get(part) ?? [];
        if (token.end > token.start && !list.some(r => r[0] === token.start)) list.push([token.start, token.end]);
        matched.set(part, list);
      }
      if (!at) { ok = false; break; }
      score += best;
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
    hits.push({ key: doc.key, title: doc.title, group: doc.group, score, titleRanges, via });
  }
  const live = hits.filter(h => h.group !== "archived").sort(byScore);
  const archived = hits.filter(h => h.group === "archived").sort(byScore);
  return [...live, ...archived].slice(0, limit);
}
const byScore = (a: SearchHit, b: SearchHit) => b.score - a.score || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);
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
export function excerpt(text: string, ranges: Range[], max = 80): { text: string; ranges: Range[] } {
  if (text.length <= max || !ranges.length) return { text: text.length <= max ? text : `${text.slice(0, max - 1)}…`, ranges: ranges.filter(r => r[1] <= max - 1) };
  const start = Math.max(0, Math.min(ranges[0][0] - 20, text.length - max));
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
export function workspaceProvider(index: SearchIndex, now = Date.now()): OmniboxProvider {
  return { id: "workspaces", results: query => search(index, query, now).map(hit => ({ provider: "workspaces", key: hit.key, hit })) };
}

// ---------- documents from Home's sources ----------


/** An agent as search needs it: its title and where it works. Subagents count for their workspace. */
export type AgentLite = { id: string; title: string | null; workspaceId: string | null };

/**
 * One document per Home row, plus Follow-up's archived workspaces. A workspace row carries every agent title in
 * that workspace; an agent row (one of several roots) carries its own title too.
 */
export function homeSearchDocs(input: { model: HomeModel; paseo: PaseoWorkspaceLite[]; tracked: Workspace[]; archived?: Workspace[]; agents?: AgentLite[] }): SearchDoc[] {
  const paseo = new Map(input.paseo.map(p => [p.id, p]));
  const tracked = new Map(input.tracked.map(w => [w.id, w]));
  const agentsBy = new Map<string, string[]>();
  for (const a of input.agents ?? []) if (a.workspaceId && a.title) agentsBy.set(a.workspaceId, [...agentsBy.get(a.workspaceId) ?? [], a.title]);
  const workspaceFields = (id: string | null, w: Workspace | undefined): SearchDoc["fields"] => {
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
