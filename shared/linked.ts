import { z } from "zod";
import { classifyUrl } from "./about";

/**
 * Linked items (1.4.0-beta.28): the verified things a workspace's work is about (Linear issues, Slack threads, Claude
 * artifacts, docs, GitHub issues, other links), tracked per workspace like PRs. Kept in linked.json beside state.json,
 * never in state.json's hot path. Pure: identity, dedupe, the cap, exclusions and the Linear check queue are all here.
 *
 * Precision over recall: a Linear key extracted from text is only a *candidate* until Linear confirms it, and only if
 * its team prefix is a known Linear team; candidates never render. A key Linear says doesn't exist is remembered and
 * never checked again. PRs are not linked items (they have their own card).
 */

export const LINKED_KINDS = ["linear", "slack", "artifact", "doc", "issue", "link"] as const;
export type LinkedKind = typeof LINKED_KINDS[number];
export const LINKED_ORIGINS = ["registered", "manual", "spec", "published", "extracted"] as const;
export type LinkedOrigin = typeof LINKED_ORIGINS[number];
/** Who may overwrite whom when the same key arrives again: a later, more trusted origin upgrades the record. */
const TRUST: Record<LinkedOrigin, number> = { manual: 4, registered: 3, spec: 2, published: 2, extracted: 1 };
export const STATUS_TONES = ["done", "active", "todo", "cancelled"] as const;

export const LIMITS = { items: 50, excluded: 200, candidates: 40, rejected: 2000, checksPerDrain: 6, dailyChecks: 120 } as const;
/** A candidate whose check failed (Linear unreachable) waits 1h, 6h, then 24h, then is dropped. */
export const RETRY_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
export const TEAMS_TTL_MS = 24 * 3_600_000;

const short = (n: number) => z.string().max(n);
export const linkedItemSchema = z.object({
  key: short(300),
  kind: z.enum(LINKED_KINDS),
  url: short(2000).nullable(),
  title: short(200).nullable(),
  status: short(60).nullable().default(null),
  statusTone: z.enum(STATUS_TONES).nullable().default(null),
  origin: z.enum(LINKED_ORIGINS),
  by: short(120).nullable().default(null),
  why: short(140).nullable().default(null),
  firstSeen: z.string(),
  lastSeen: z.string(),
  checkedAt: z.string().nullable().default(null),
});
export type LinkedItem = z.infer<typeof linkedItemSchema>;
/** `item`: what was removed, so Undo brings it back as it was. */
const exclusionSchema = z.object({ key: short(300), at: z.string(), by: short(120), reason: short(200).nullable().default(null), item: linkedItemSchema.nullable().default(null) });
/**
 * `strong`: seen in a tool receipt, the developer's words, the goal or a PR. A key only an agent's prose mentions is
 * weak and waits for a second sighting (`seen` ≥ 2) before Linear is asked.
 */
const candidateSchema = z.object({ key: short(40), seen: z.number().int().min(1), firstSeen: z.string(), retryAt: z.string().nullable().default(null), failures: z.number().int().min(0).default(0), strong: z.boolean().default(true) });
export const workspaceLinksSchema = z.object({
  items: z.array(linkedItemSchema).default([]),
  excluded: z.array(exclusionSchema).default([]),
  candidates: z.array(candidateSchema).default([]),
});
export type WorkspaceLinks = z.infer<typeof workspaceLinksSchema>;
export const linkedFileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), workspaceLinksSchema).default({}),
  /** Keys Linear said don't exist, with when: never checked again (oldest dropped past the cap). */
  rejected: z.record(z.string(), z.string()).default({}),
  /** Known Linear team prefixes ("HER"), read at most once a day. Null until read: candidates wait. */
  teams: z.object({ keys: z.array(z.string()), at: z.string() }).nullable().default(null),
  daily: z.object({ date: z.string(), count: z.number().int() }).nullable().default(null),
  migrations: z.array(z.string()).default([]),
});
export type LinkedFile = z.infer<typeof linkedFileSchema>;
export const emptyLinkedFile = (): LinkedFile => ({ version: 1, workspaces: {}, rejected: {}, teams: null, daily: null, migrations: [] });
export const emptyWorkspaceLinks = (): WorkspaceLinks => ({ items: [], excluded: [], candidates: [] });

// ---------- identity ----------

const LINEAR_KEY = /^([A-Z][A-Z0-9]{1,9})-(\d{1,6})$/;
/** "her-1312" → "HER-1312"; null when it isn't key-shaped. */
export function linearKey(raw: string): string | null {
  const m = LINEAR_KEY.exec(raw.trim().toUpperCase());
  return m && Number(m[2]) > 0 ? `${m[1]}-${Number(m[2])}` : null;
}
export const teamOf = (key: string) => key.split("-")[0];

export type Classified = { kind: LinkedKind; key: string; url: string | null } | { kind: "pr"; key: string; url: string };
/**
 * What a pasted or registered reference is. Linear keys and URLs, Slack threads (a reply collapses to its thread),
 * claude.ai artifacts, Google and Notion docs, GitHub issues, a PR (refused by the caller), and, only when `explicit`
 * (an agent or the developer linked it on purpose), any other http(s) URL.
 */
export function classifyLink(raw: string, explicit = false): Classified | null {
  const text = raw.trim();
  const key = linearKey(text);
  if (key) return { kind: "linear", key, url: null };
  if (!/^https?:\/\//i.test(text)) return null;
  const known = classifyUrl(text);
  if (known?.kind === "pr") return { kind: "pr", key: known.key, url: known.url! };
  if (known) return { kind: known.kind === "linear" ? "linear" : known.kind as LinkedKind, key: known.key, url: known.url };
  let u: URL;
  try { u = new URL(text.replace(/[.,;:!?*]+$/, "")); } catch { return null; }
  const issue = u.hostname.toLowerCase() === "github.com" ? /^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/.exec(u.pathname) : null;
  if (issue) return { kind: "issue", key: `${issue[1]}/${issue[2]}#${Number(issue[3])}`, url: `https://github.com/${issue[1]}/${issue[2]}/issues/${Number(issue[3])}` };
  if (!explicit) return null;
  u.hash = "";
  return { kind: "link", key: u.toString(), url: u.toString() };
}

// ---------- upsert, exclusion, the cap ----------

export type ItemInput = Pick<LinkedItem, "key" | "kind" | "url"> & Partial<Pick<LinkedItem, "title" | "status" | "statusTone" | "by" | "why" | "checkedAt">> & { origin: LinkedOrigin };
export type UpsertResult = { ok: true; item: LinkedItem; created: boolean } | { ok: false; reason: "excluded" | "cap" };

/**
 * Adds or refreshes one item. The same key from another origin merges into one record: fields fill in, and a more
 * trusted origin (manual > registered > spec/published > extracted) takes over. An excluded key is refused unless the
 * developer adds it by hand, which clears the exclusion. Past the cap the oldest extracted item makes room; registered,
 * manual and derived items are never evicted silently, so adding past the cap with none to evict is refused.
 */
export function upsertItem(ws: WorkspaceLinks, input: ItemInput, now: number): UpsertResult {
  const at = new Date(now).toISOString();
  const excluded = ws.excluded.findIndex(e => e.key === input.key);
  if (excluded >= 0) {
    if (input.origin !== "manual") return { ok: false, reason: "excluded" };
    ws.excluded.splice(excluded, 1);
  }
  const prior = ws.items.find(i => i.key === input.key);
  if (prior) {
    const upgrade = TRUST[input.origin] > TRUST[prior.origin];
    prior.url = input.url ?? prior.url;
    prior.title = input.title ?? prior.title;
    if (input.status !== undefined) { prior.status = input.status; prior.statusTone = input.statusTone ?? null; }
    if (input.checkedAt !== undefined) prior.checkedAt = input.checkedAt;
    if (upgrade) { prior.origin = input.origin; prior.by = input.by ?? prior.by; prior.why = input.why ?? prior.why; }
    else { prior.why ??= input.why ?? null; prior.by ??= input.by ?? null; }
    prior.lastSeen = at;
    return { ok: true, item: prior, created: false };
  }
  if (ws.items.length >= LIMITS.items) {
    const evictable = ws.items.filter(i => i.origin === "extracted").sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
    if (!evictable) return { ok: false, reason: "cap" };
    ws.items.splice(ws.items.indexOf(evictable), 1);
  }
  const item: LinkedItem = linkedItemSchema.parse({
    key: input.key, kind: input.kind, url: input.url, title: input.title?.slice(0, 200) ?? null, status: input.status ?? null, statusTone: input.statusTone ?? null,
    origin: input.origin, by: input.by ?? null, why: input.why?.slice(0, 140) ?? null, firstSeen: at, lastSeen: at, checkedAt: input.checkedAt ?? null,
  });
  ws.items.push(item);
  ws.candidates = ws.candidates.filter(c => c.key !== input.key);
  return { ok: true, item, created: true };
}

/** Removes an item (developer or agent) and remembers it, so no origin brings it back. Returns the removed item. */
export function excludeItem(ws: WorkspaceLinks, key: string, by: string, reason: string | null, now: number): LinkedItem | null {
  const at = new Date(now).toISOString();
  const i = ws.items.findIndex(x => x.key === key);
  const removed = i >= 0 ? ws.items.splice(i, 1)[0] : null;
  ws.candidates = ws.candidates.filter(c => c.key !== key);
  if (!ws.excluded.some(e => e.key === key)) ws.excluded.push({ key, at, by, reason: reason?.slice(0, 200) ?? null, item: removed });
  if (ws.excluded.length > LIMITS.excluded) ws.excluded.splice(0, ws.excluded.length - LIMITS.excluded);
  return removed;
}
/** Undo: the exclusion goes, and the removed item (when given) comes back as it was. */
export function unexcludeItem(ws: WorkspaceLinks, key: string, restore: LinkedItem | null = ws.excluded.find(e => e.key === key)?.item ?? null): void {
  ws.excluded = ws.excluded.filter(e => e.key !== key);
  if (restore && !ws.items.some(i => i.key === key)) ws.items.push(restore);
}

// ---------- Linear candidates and the check queue ----------

/**
 * An extracted Linear-shaped key. Known items refresh their lastSeen; excluded and rejected keys, and keys whose team
 * prefix isn't a known Linear team, are dropped on the spot. Returns whether it is (now) a candidate.
 */
export function noteCandidate(file: LinkedFile, workspaceId: string, raw: string, now: number, strong = true): boolean {
  const key = linearKey(raw);
  if (!key || file.rejected[key]) return false;
  const ws = file.workspaces[workspaceId] ??= emptyWorkspaceLinks();
  if (ws.excluded.some(e => e.key === key)) return false;
  const item = ws.items.find(i => i.key === key);
  if (item) { item.lastSeen = new Date(now).toISOString(); return false; }
  if (file.teams && !file.teams.keys.includes(teamOf(key))) return false;
  const c = ws.candidates.find(c => c.key === key);
  if (c) { c.seen++; c.strong ||= strong; return true; }
  ws.candidates.push({ key, seen: 1, firstSeen: new Date(now).toISOString(), retryAt: null, failures: 0, strong });
  if (ws.candidates.length > LIMITS.candidates) ws.candidates.splice(0, ws.candidates.length - LIMITS.candidates);
  return true;
}

/** The team list arrived: candidates whose prefix isn't a Linear team ("STATUS-1025", "REVISION-2026") go for good. */
export function setTeams(file: LinkedFile, keys: string[], now: number): void {
  file.teams = { keys: [...new Set(keys)].sort(), at: new Date(now).toISOString() };
  for (const ws of Object.values(file.workspaces)) ws.candidates = ws.candidates.filter(c => keys.includes(teamOf(c.key)));
}

/** Up to `max` candidates due for a Linear check, oldest first. Nothing while the team list is unknown; weak ones wait for a second sighting. */
export function dueChecks(file: LinkedFile, now: number, max: number = LIMITS.checksPerDrain): { workspaceId: string; key: string }[] {
  if (!file.teams) return [];
  const due: { workspaceId: string; key: string; firstSeen: string }[] = [];
  const seen = new Set<string>();
  for (const [workspaceId, ws] of Object.entries(file.workspaces)) for (const c of ws.candidates) {
    if (c.retryAt && Date.parse(c.retryAt) > now) continue;
    if (!c.strong && c.seen < 2) continue;
    if (!file.teams.keys.includes(teamOf(c.key))) continue;
    due.push({ workspaceId, key: c.key, firstSeen: c.firstSeen });
  }
  return due.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)).filter(d => !seen.has(d.key) && seen.add(d.key)).slice(0, max).map(({ workspaceId, key }) => ({ workspaceId, key }));
}

export type LinearIssueFacts = { title: string; state: string | null; url: string | null };
/** "In Progress" → active; "Done"/"Merged" → done; "Canceled"/"Duplicate" → cancelled; else todo. */
export function toneOf(state: string | null): LinkedItem["statusTone"] {
  if (!state) return null;
  const s = state.toLowerCase();
  if (/cancel|duplicate|won.?t/.test(s)) return "cancelled";
  if (/done|complete|merged|released|closed/.test(s)) return "done";
  if (/progress|review|started|doing|active|testing/.test(s)) return "active";
  return "todo";
}

/**
 * One check's result, for every workspace holding the key as a candidate. Found: it becomes an extracted item with
 * Linear's title, state and URL. Not found: rejected for good. A failure: retried with back-off, then dropped.
 */
export function applyCheck(file: LinkedFile, key: string, result: { found: LinearIssueFacts | null } | { error: string }, now: number): void {
  const at = new Date(now).toISOString();
  if ("found" in result && !result.found) {
    file.rejected[key] = at;
    const keys = Object.keys(file.rejected);
    if (keys.length > LIMITS.rejected) for (const k of keys.sort((a, b) => file.rejected[a].localeCompare(file.rejected[b])).slice(0, keys.length - LIMITS.rejected)) delete file.rejected[k];
  }
  for (const ws of Object.values(file.workspaces)) {
    const c = ws.candidates.find(c => c.key === key);
    if (!c) continue;
    if ("error" in result) {
      c.failures++;
      if (c.failures > RETRY_MS.length) ws.candidates = ws.candidates.filter(x => x !== c);
      else c.retryAt = new Date(now + RETRY_MS[c.failures - 1]).toISOString();
      continue;
    }
    ws.candidates = ws.candidates.filter(x => x !== c);
    if (result.found) upsertItem(ws, { key, kind: "linear", url: result.found.url, title: result.found.title, status: result.found.state, statusTone: toneOf(result.found.state), origin: "extracted", checkedAt: at }, now);
  }
}

/** The daily check budget, shared by every workspace. */
export function takeBudget(file: LinkedFile, now: number, cap: number = LIMITS.dailyChecks): boolean {
  const date = new Date(now).toISOString().slice(0, 10);
  const count = file.daily?.date === date ? file.daily.count : 0;
  if (count >= cap) return false;
  file.daily = { date, count: count + 1 };
  return true;
}

// ---------- what the panel shows ----------

/** Per-kind counts for the chip: verified items only, without the spec (its own chip sits beside it). */
export function linkedCounts(ws: WorkspaceLinks | undefined, specUrl: string | null = null): Partial<Record<LinkedKind, number>> {
  const counts: Partial<Record<LinkedKind, number>> = {};
  for (const i of ws?.items ?? []) {
    if (i.origin === "spec" || specUrl && i.url === specUrl) continue;
    counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------- migration from Summary links ----------

export const ABOUT_MIGRATION = "about-links-1";
type AboutLinkLike = { kind: string; key: string; url: string | null; title: string | null; state?: string | null };
/**
 * One-time: carries over only what was verified. A Linear link with a title was confirmed by Linear; Slack threads with
 * a channel, artifacts and docs are URL-shaped. Bare Linear keys (today's "couldn't be read" rows) become candidates
 * and go through the normal check queue; PRs and generic links are dropped.
 */
export function migrateAboutLinks(file: LinkedFile, about: Record<string, { links: AboutLinkLike[] }>, now: number): { items: number; candidates: number } {
  let items = 0, candidates = 0;
  if (file.migrations.includes(ABOUT_MIGRATION)) return { items, candidates };
  for (const [workspaceId, record] of Object.entries(about)) {
    for (const l of record.links ?? []) {
      const ws = file.workspaces[workspaceId] ??= emptyWorkspaceLinks();
      if (l.kind === "linear") {
        const key = linearKey(l.key);
        if (!key) continue;
        if (l.title) { if (upsertItem(ws, { key, kind: "linear", url: l.url, title: l.title, status: l.state ?? null, statusTone: toneOf(l.state ?? null), origin: "extracted" }, now).ok) items++; }
        else if (noteCandidate(file, workspaceId, key, now)) candidates++;
      } else if (l.kind === "slack" && l.title || l.kind === "artifact" || l.kind === "doc") {
        if (upsertItem(ws, { key: l.key, kind: l.kind as LinkedKind, url: l.url, title: l.title, origin: "extracted" }, now).ok) items++;
      }
    }
  }
  file.migrations.push(ABOUT_MIGRATION);
  return { items, candidates };
}

// ---------- extraction: what passive sources saw ----------

/** One reference seen in text Follow-up already reads. `strong`: a tool receipt, the developer's words, the goal or a PR. */
export type LinkRef = { raw: string; strong: boolean; title?: string | null };

/**
 * Passive sightings into the file. Linear keys become candidates (weak ones need a second sighting); Slack threads,
 * artifacts, docs and GitHub issues are URL-shaped and kept as extracted items. PRs and generic URLs never get in
 * this way, and exclusions hold. Returns how many items and candidates were added.
 */
export function noteRefs(file: LinkedFile, workspaceId: string, refs: readonly LinkRef[], now: number): { items: number; candidates: number } {
  let items = 0, candidates = 0;
  for (const ref of refs) {
    const c = classifyLink(ref.raw, false);
    if (!c || c.kind === "pr" || c.kind === "link") continue;
    if (c.kind === "linear") { if (noteCandidate(file, workspaceId, c.key, now, ref.strong)) candidates++; continue; }
    const ws = file.workspaces[workspaceId] ??= emptyWorkspaceLinks();
    const r = upsertItem(ws, { key: c.key, kind: c.kind, url: c.url, title: ref.title ?? null, origin: "extracted" }, now);
    if (r.ok && r.created) items++;
  }
  return { items, candidates };
}

// ---------- the view: stored items plus the spec and published artifacts ----------

export type LinkedViewItem = LinkedItem & { spec: boolean };
export type LinkedView = { workspaceId: string; items: LinkedViewItem[]; excluded: { key: string; at: string; by: string; reason: string | null }[]; counts: Partial<Record<LinkedKind, number>>; pending: number };

/**
 * What the panel and link_items show. The spec (origin spec) and published artifacts (origin published) are derived
 * from what Follow-up already stores, never copied into linked.json; an excluded one stays out.
 */
export function linkedView(workspaceId: string, ws: WorkspaceLinks | undefined, derived: { spec: { url: string; title: string | null } | null; artifacts: readonly { url: string; title: string | null; firstAt: string | null; lastAt: string | null; by: string | null }[] }): LinkedView {
  const stored = ws ?? emptyWorkspaceLinks();
  const excluded = new Set(stored.excluded.map(e => e.key));
  const items: LinkedViewItem[] = stored.items.map(i => ({ ...i, spec: false }));
  const add = (url: string, title: string | null, origin: "spec" | "published", at: string | null, by: string | null) => {
    const c = classifyLink(url, true);
    if (!c || c.kind === "pr" || excluded.has(c.key)) return;
    const prior = items.find(i => i.key === c.key);
    if (prior) { prior.title ??= title; if (origin === "spec") prior.spec = true; return; }
    const when = at ?? new Date(0).toISOString();
    items.push({ ...linkedItemSchema.parse({ key: c.key, kind: c.kind, url: c.url ?? url, title, origin, by, firstSeen: when, lastSeen: when }), spec: origin === "spec" });
  };
  if (derived.spec?.url) add(derived.spec.url, derived.spec.title, "spec", null, null);
  for (const a of derived.artifacts) add(a.url, a.title, "published", a.lastAt ?? a.firstAt, a.by);
  const counts: Partial<Record<LinkedKind, number>> = {};
  for (const i of items) if (!i.spec) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { workspaceId, items, excluded: stored.excluded.map(({ key, at, by, reason }) => ({ key, at, by, reason })), counts, pending: stored.candidates.length };
}

// ---------- Home search ----------

/**
 * Home's search index for linked items (`follow.linked-index`): every workspace's stored items as key, kind and title.
 * Built from one read of linked.json, only while the developer is typing a search, never on the list's poll.
 */
export function linkedSearchIndex(file: LinkedFile): Record<string, { key: string; kind: LinkedKind; title: string | null }[]> {
  const out: Record<string, { key: string; kind: LinkedKind; title: string | null }[]> = {};
  for (const [workspaceId, ws] of Object.entries(file.workspaces)) {
    if (ws.items.length) out[workspaceId] = ws.items.map(i => ({ key: i.key, kind: i.kind, title: i.title }));
  }
  return out;
}
