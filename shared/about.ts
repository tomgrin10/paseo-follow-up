import { z } from "zod";
import { modelName } from "./agent-settings";

/**
 * Summary: one short sentence under the workspace's title saying what the workspace is for, a reminder for a developer
 * switching between many (Tom, 2026-11-10). Not a status report. Until 1.4.0 it was a longer
 * overview with a Linked list; those records stay on disk but are never shown (`form` marks the new ones).
 * Links are still extracted from the workspace's own text and kept in the record for the Linked items feature; no UI
 * shows them for now.
 */

export const LINK_KINDS = ["linear", "pr", "slack", "artifact", "doc", "link"] as const;
export type LinkKind = typeof LINK_KINDS[number];
export const SOURCE_LABEL: Record<LinkKind, string> = { linear: "Linear", pr: "GitHub", slack: "Slack", artifact: "Claude", doc: "Doc", link: "Link" };

export const aboutLinkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  /** Stable identity for dedupe: HER-1312, owner/repo#12, slack:C1/1700000000.000100, or the URL. */
  key: z.string().max(300),
  url: z.string().max(2000).nullable(),
  /** Linear title, PR title, Slack channel or a page title. Null when the source wasn't read: the row shows the bare link. */
  title: z.string().max(300).nullable(),
  state: z.string().max(60).nullable(),
  priority: z.string().max(40).nullable(),
  due: z.string().max(40).nullable(),
  who: z.string().max(120).nullable(),
  excerpt: z.string().max(300).nullable(),
});
export type AboutLink = z.infer<typeof aboutLinkSchema>;

export const aboutRecordSchema = z.object({
  workspaceId: z.string(),
  inputsHash: z.string(),
  generatedAt: z.string(),
  gist: z.string().max(160),
  overview: z.string().max(900),
  links: z.array(aboutLinkSchema).max(40),
  /** What the overview was built from, for the footer: "from the chat, 2 PRs, HER-1312". */
  basis: z.object({ chat: z.boolean(), source: z.enum(["live", "transcript", "none"]).default("live"), prs: z.number().int().nonnegative(), issues: z.array(z.string().max(40)).max(20) }),
  /** Sources that couldn't be read ("Linear", "Slack", "GitHub"); their rows show the bare link. */
  failed: z.array(z.string().max(40)).max(6),
  costUsd: z.number().nonnegative().nullable(),
  /** "sentence": the one-line Summary (`gist`). Missing on the older long overviews, which are treated as none. */
  form: z.literal("sentence").optional(),
  /** Which agent wrote it (Settings → Agents): "Summarized by Haiku". Older records have none. */
  by: z.object({ provider: z.string().max(60), model: z.string().max(120) }).nullable().optional(),
});
export type AboutRecord = z.infer<typeof aboutRecordSchema>;

export const ABOUT_STATUS = ["idle", "pending", "ready", "failed"] as const;
export const aboutViewSchema = z.object({
  status: z.enum(ABOUT_STATUS),
  /** The cached overview, also while a newer one is being written. */
  record: aboutRecordSchema.nullable(),
  /** The workspace's first user message, shown muted while the overview is being written. */
  firstMessage: z.string().max(400).nullable(),
  /** Links found so far, before any overview exists. */
  links: z.array(aboutLinkSchema).max(40),
  error: z.string().max(300).nullable(),
});
export type AboutView = z.infer<typeof aboutViewSchema>;

/** The Summary's hard cap. About 20 words; anything longer is rejected, never cut. */
export const SUMMARY_MAX_CHARS = 140;
/**
 * What the model returns: one sentence on one line. Anything else (too long, two lines, extra fields) is rejected and
 * the job counts as failed, so the previous sentence stays. No retry at higher effort.
 */
export const summaryOutputSchema = z.strictObject({
  sentence: z.string().trim().min(10).max(SUMMARY_MAX_CHARS).refine(v => !/[\r\n]/.test(v), "One line only"),
});
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

/** A record the Summary may show: written as one sentence. Older long overviews count as none. */
export const currentSummary = <T extends Pick<AboutRecord, "form">>(r: T | null | undefined): T | null => r?.form === "sentence" ? r : null;

// ---------- link extraction ----------

/** Things shaped like Linear keys that never are. */
const NOT_ISSUES = new Set(["UTF", "ISO", "SHA", "GPT", "RFC", "HTTP", "TLS", "SSL", "MD", "AES", "RSA", "ES", "PEP", "CVE", "CWE", "COVID", "ECMA", "IPV", "X", "MP", "H", "W", "UTC", "GMT", "LTS", "V", "API", "PR", "ID"]);
const LINEAR_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

const trimUrl = (url: string) => url.replace(/[.,;:!?*]+$/, "");

/** Classifies one URL. Unknown hosts are kept only when they look like a shared doc. */
export function classifyUrl(raw: string): AboutLink | null {
  const url = trimUrl(raw);
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const base = { url, title: null, state: null, priority: null, due: null, who: null, excerpt: null };
  const linear = host === "linear.app" ? /^\/[^/]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/.exec(u.pathname) : null;
  if (linear) return { ...base, kind: "linear", key: linear[1] };
  const pr = host === "github.com" ? /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(u.pathname)
    : /^app\.graphite\.(com|dev)$/.test(host) ? /^\/github\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+)/.exec(u.pathname) : null;
  if (pr) return { ...base, kind: "pr", key: `${pr[1]}/${pr[2]}#${Number(pr[3])}`, url: `https://github.com/${pr[1]}/${pr[2]}/pull/${Number(pr[3])}` };
  if (/(^|\.)slack\.com$/.test(host)) {
    const m = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(u.pathname);
    if (!m) return null;
    // A reply link carries its thread's parent in thread_ts; the thread is the unit.
    const thread = u.searchParams.get("thread_ts");
    const ts = thread && /^\d{10}\.\d{6}$/.test(thread) ? thread : `${m[2]}.${m[3]}`;
    return { ...base, kind: "slack", key: `slack:${m[1]}/${ts}` };
  }
  if (host === "claude.ai" && /^\/(code\/)?(artifact|public\/artifacts)\//.test(u.pathname)) return { ...base, kind: "artifact", key: url.split(/[?#]/)[0] };
  if (/^(docs|drive)\.google\.com$/.test(host) || /(^|\.)notion\.(so|site)$/.test(host) || host === "www.notion.so") return { ...base, kind: "doc", key: url.split("#")[0] };
  return null;
}

/** Linear keys, PR/Slack/Linear/claude.ai/doc links from the workspace's own text. Deduped, in first-seen order. */
export function extractLinks(texts: readonly (string | null | undefined)[], limit = 30): AboutLink[] {
  const found = new Map<string, AboutLink>();
  const add = (link: AboutLink | null) => {
    if (!link || found.size >= limit) return;
    const prior = found.get(link.key);
    // A Linear key seen bare first gains its URL when a link to it shows up later.
    if (prior) { if (!prior.url && link.url) prior.url = link.url; return; }
    found.set(link.key, link);
  };
  for (const text of texts) {
    if (!text) continue;
    const hits: { at: number; link: AboutLink | null }[] = [];
    for (const m of text.matchAll(URL_RE)) hits.push({ at: m.index ?? 0, link: classifyUrl(m[0]) });
    // Keys inside URLs (branch names, Linear slugs) count once through the URL; blank them before the bare scan.
    const bare = text.replace(URL_RE, url => " ".repeat(url.length));
    for (const m of bare.matchAll(LINEAR_KEY)) {
      if (NOT_ISSUES.has(m[1]) || Number(m[2]) === 0) continue;
      hits.push({ at: m.index ?? 0, link: { kind: "linear", key: `${m[1]}-${Number(m[2])}`, url: null, title: null, state: null, priority: null, due: null, who: null, excerpt: null } });
    }
    for (const h of hits.sort((a, b) => a.at - b.at)) add(h.link);
  }
  return [...found.values()];
}

/** Branch names carry keys in lower case ("tom/her-1312-vendor-fix"). */
export function keysFromBranch(branch: string | null | undefined): string[] {
  if (!branch) return [];
  return [...branch.matchAll(/(?:^|[/_-])([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[/_-])/gi)].map(m => `${m[1].toUpperCase()}-${Number(m[2])}`).filter(k => !NOT_ISSUES.has(k.split("-")[0]));
}

// ---------- cache ----------

export const ABOUT_TTL_MS = 3_600_000;
/** A failed attempt is retried no sooner than this, unless the developer presses Refresh. */
export const ABOUT_RETRY_MS = 10 * 60_000;

/**
 * Whether to write a new overview. Refresh always does. Otherwise only when there is none, or the inputs changed
 * and the cached one is older than an hour (so a busy agent doesn't buy a new overview per turn).
 */
export function needsOverview(cached: Pick<AboutRecord, "inputsHash" | "generatedAt"> | null, hash: string, now: number, opts: { refresh?: boolean; failedAt?: number | null } = {}): boolean {
  if (opts.refresh) return true;
  if (opts.failedAt && now - opts.failedAt < ABOUT_RETRY_MS) return false;
  if (!cached) return true;
  if (cached.inputsHash === hash) return false;
  const at = Date.parse(cached.generatedAt);
  return !Number.isFinite(at) || now - at >= ABOUT_TTL_MS;
}

/** Stable text for hashing: key order and whitespace don't change the hash. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value ?? null);
}

/** The daily background budget: a counter that resets with the local date. */
export function dailyBudget(state: { date: string; count: number } | null, now: number, cap: number): { allowed: boolean; next: { date: string; count: number } } {
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const count = state?.date === date ? state.count : 0;
  return count >= cap ? { allowed: false, next: { date, count } } : { allowed: true, next: { date, count: count + 1 } };
}

/** Background generation stops when any Claude account window is above this. */
export const USAGE_CEILING_PCT = 85;
export function usageAllows(accounts: readonly { family: string; windows: readonly { pct: number }[] }[]): boolean {
  return !accounts.some(a => a.family === "claude" && a.windows.some(w => w.pct > USAGE_CEILING_PCT));
}

// ---------- what the Summary line says ----------

function ageWords(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "Summarized by Haiku · 2h ago from the chat, 2 PRs, HER-1312". Sources that failed follow: "Linear unavailable". */
export function footerText(r: Pick<AboutRecord, "generatedAt" | "basis" | "failed" | "by">, now: number): string {
  const chat = r.basis.source === "transcript" ? "the saved transcript" : r.basis.source === "none" ? "the goal" : "the chat";
  const parts = [r.basis.chat || r.basis.source === "none" ? chat : "", r.basis.prs ? `${r.basis.prs} PR${r.basis.prs === 1 ? "" : "s"}` : "", ...r.basis.issues.slice(0, 3), r.basis.issues.length > 3 ? `${r.basis.issues.length - 3} more issues` : ""].filter(Boolean);
  const from = parts.length ? ` from ${parts.join(", ")}` : "";
  return r.by?.model ? `Summarized by ${modelName(r.by.model)} · ${ageWords(r.generatedAt, now)}${from}` : `Summarized ${ageWords(r.generatedAt, now)}${from}`;
}
/** Phones' one meta line: "Summarized by Haiku · 2m ago from the chat, 2 PRs" → "Haiku · 2m ago". */
export const shortFooter = (footer: string | null): string => (footer ?? "").split(" from ")[0].replace(/^Summarized (by )?/, "");
/**
 * What the line under the title and the panel's Summary row show. Never invents: only a sentence-form record is shown
 * (older long overviews count as none), and nothing stands in for a sentence that doesn't exist.
 */
export function summaryDisplay(view: AboutView | null | undefined, now: number): { sentence: string | null; pending: boolean; failed: boolean; error: string | null; footer: string | null } {
  const r = currentSummary(view?.record);
  return {
    sentence: r?.gist ?? null, pending: view?.status === "pending", failed: !r && view?.status === "failed",
    error: view?.error ?? null, footer: r ? footerText(r, now) : null,
  };
}

/**
 * While the Summary view is pending (its inputs or its sentence still on the way), how long the client waits before
 * asking again after the `pending`-th pending reply in a row: 500 ms, then 1 s, 2 s, and 3 s from then on.
 */
export function pendingPollMs(pending: number): number {
  return Math.min(3_000, 500 * 2 ** Math.max(0, pending - 1));
}

/** Under the title: the sentence, else the goal when it says more than the title, else "Writing a summary…" while one is being written. */
export function summaryLine(d: Pick<ReturnType<typeof summaryDisplay>, "sentence" | "pending">, w: { title: string; goal: string }): { text: string; kind: "summary" | "goal" | "writing" } | null {
  if (d.sentence) return { text: d.sentence, kind: "summary" };
  const goal = w.goal?.trim();
  if (goal && goal.toLowerCase() !== w.title.trim().toLowerCase()) return { text: goal, kind: "goal" };
  return d.pending ? { text: "Writing a summary…", kind: "writing" } : null;
}

/** One row's text: "HER-1312 · Vendor service accounts… · In Progress · High · due Nov 12". */
export function linkLine(l: AboutLink): { lead: string; title: string | null; meta: string[] } {
  const lead = l.kind === "linear" ? l.key : l.kind === "pr" ? `#${l.key.split("#")[1]}` : l.kind === "slack" ? (l.title ?? "Slack thread") : l.title ?? hostOf(l.url);
  const title = l.kind === "slack" ? l.excerpt : l.kind === "linear" || l.kind === "pr" ? l.title : null;
  const meta = [l.state, l.priority, l.due ? `due ${l.due}` : null, l.kind === "slack" ? l.who : null].filter((x): x is string => !!x);
  return { lead, title, meta };
}
function hostOf(url: string | null): string {
  if (!url) return "Link";
  try { const u = new URL(url); return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.slice(0, 32) : ""); } catch { return url.slice(0, 40); }
}
