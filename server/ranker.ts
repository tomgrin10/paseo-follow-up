import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { atomic } from "./overseer";
import { claudeArgs, claudeRunner, type AiJobs, type RunInput } from "./ai-jobs";
import { mcpproxyText } from "./about";
import {
  healthLine, inRankWindow, jerusalem, stableInputs, rankPrompt, rankReplySchema, RANK_SYSTEM, rankWorkstream, toPriorities,
  type NotStarted, type RankInputs, type RankIssue, type RankMessage, type RankPlanning, type RankReview, type RankSource, type SourceHealth,
} from "../shared/ranker";
import type { Priority } from "../shared/priorities";
import type { WorkstreamRow } from "../shared/overseer";

const exec = promisify(execFile);

/** The inputs' fingerprint: equal means the model would see the same material. */
export const inputsHash = (inputs: RankInputs) => createHash("sha256").update(stableInputs(inputs)).digest("hex").slice(0, 32);

// ---------- role ----------

/**
 * The ranker's provider, model and limits, from the ranker role in Settings → Agents. These defaults match its
 * ROLE_DEFAULTS.ranker and fill any limit the role leaves unset. Never a hardcoded model at the call site.
 */
export type RankerRole = { provider: string; model: string | null; thinking: string | null; dailyCap: number; maxPromptChars: number | null; cadenceMinutes: number };
export const RANKER_ROLE_DEFAULT: RankerRole = { provider: "claude", model: "sonnet", thinking: null, dailyCap: 24, maxPromptChars: 60_000, cadenceMinutes: 60 };

// ---------- sources ----------

export type RankSources = {
  linear(): Promise<RankIssue[]>;
  /** DMs and mentions since `since` (ms). */
  slack(since: number): Promise<RankMessage[]>;
  github(): Promise<RankReview[]>;
  /** The CPO's plan, read once a day at most (the caller caches). Null when there's no plan to read. */
  planning(url: string): Promise<RankPlanning | null>;
};

const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;

/** `linear:list_issues` (JSON `{issues: […]}`), open ones only. */
export function parseLinearIssues(text: string): RankIssue[] {
  let j: unknown; try { j = JSON.parse(text); } catch { return []; }
  const issues = (j as { issues?: unknown[] })?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap(raw => {
    const i = raw as Record<string, unknown>;
    const key = str(i.id) ?? str(i.identifier); const title = str(i.title);
    if (!key || !title || /^(completed|canceled)$/i.test(str(i.statusType) ?? "")) return [];
    const named = (v: unknown) => typeof v === "object" && v ? str((v as { name?: unknown }).name) : str(v);
    const priority = named(i.priority);
    return [{ key, title, priority: priority === "No priority" ? null : priority, status: str(i.status) ?? named(i.state), due: str(i.dueDate), project: named(i.project), milestone: named(i.projectMilestone), url: str(i.url) }];
  });
}

/**
 * `slack_search_public_and_private` in concise form: "1. DM with Tom, Dana Levi - Dana Levi: text… 2026-11-09 18:12:18 IST".
 * The developer's own messages and bots are dropped.
 */
export function parseSlackSearch(text: string, self: string | null): RankMessage[] {
  const out: RankMessage[] = [];
  const body = (() => { try { const j = JSON.parse(text) as { results?: string }; return typeof j.results === "string" ? j.results : text; } catch { return text; } })();
  for (const m of body.matchAll(/(?:^|\n)\s*\d+\.\s+([\s\S]*?)(?=\n\s*\d+\.\s|\n*$)/g)) {
    const item = m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    const at = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [A-Z]{2,4})?)\s*$/.exec(item);
    const rest = at ? item.slice(0, at.index).trim() : item;
    const head = /^(.*?),\s*([^:]{1,80}?)\s*-\s*([^:]{1,80}?):\s*([\s\S]*)$/.exec(rest);
    const where = head ? head[1] : "Slack"; const who = head ? head[3].trim() : null; const msg = (head ? head[4] : rest).replace(/…$/, "").trim();
    if (!msg || (who && self && who.toLowerCase() === self.toLowerCase()) || /^(GitHub|Linear|Graphite|Jira|Sentry|Datadog|Slackbot)\b/i.test(who ?? "")) continue;
    out.push({ where, who, text: msg, at: at ? at[1] : null });
  }
  return out;
}

/** `gh search prs --review-requested=@me --json number,title,url,repository,author`. */
export function parseReviewRequests(stdout: string): RankReview[] {
  let j: unknown; try { j = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(j)) return [];
  return j.flatMap(raw => {
    const r = raw as { number?: unknown; title?: unknown; url?: unknown; repository?: { nameWithOwner?: unknown; name?: unknown }; author?: { login?: unknown } };
    const repo = str(r.repository?.nameWithOwner) ?? str(r.repository?.name);
    return typeof r.number === "number" && repo && str(r.title) ? [{ repo, number: r.number, title: str(r.title)!, url: str(r.url), author: str(r.author?.login) }] : [];
  });
}

export const planReplySchema = z.object({
  title: z.string().trim().max(200).nullable().catch(null).default(null),
  // Items as objects, or plain lines (models sometimes flatten them); anything else is dropped, not fatal.
  items: z.array(z.union([
    z.object({ level: z.string().trim().min(1).max(30).catch("item"), title: z.string().trim().min(1).max(300), keys: z.array(z.string().trim().max(30)).max(10).catch([]).default([]) }),
    z.string().trim().min(1).max(300).transform(title => ({ level: "item", title, keys: title.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [] })),
  ]).nullable().catch(null)).max(120).transform(items => items.filter((i): i is { level: string; title: string; keys: string[] } => !!i).slice(0, 80)),
});
export const PLAN_SYSTEM = "You read one Claude artifact with the Artifact tool, action \"read\" only, and summarise its planning content. Never call the Artifact tool with any other action (never publish, update, delete, comment or share). Reply with one JSON object only: {\"title\": string|null, \"items\": [{\"level\": \"initiative|project|milestone|issue\", \"title\": string, \"keys\": [Linear keys like HER-123]}]}. Focus on this week; at most 60 items. Never include share keys, links or raw HTML.";

/** The plan reader: one Claude turn with only the Artifact tool, which Paseo's Claude provider enables with CLAUDE_CODE_ARTIFACT=1. */
export const planArgs = (input: RunInput) => {
  const base = claudeArgs(input);
  const tools = base.indexOf("--tools");
  base.splice(tools, 2, "--tools", "Artifact", "--allowedTools", "Artifact");
  base[base.indexOf("--max-turns") + 1] = "4";
  return base;
};

/** The Artifact tool needs CLAUDE_CODE_ARTIFACT=1, and Claude Code drops it when nonessential traffic is off. */
export const PLAN_ENV = { CLAUDE_CODE_ARTIFACT: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" };

/** A claude.ai artifact link without a query string or fragment, so no share key travels. */
export function canonicalArtifactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); if (u.hostname !== "claude.ai" || !/^\/(code\/)?artifact\/[\w-]+$/.test(u.pathname)) return null; return `https://claude.ai${u.pathname}`; } catch { return null; }
}

/** The plan's link: Follow-up's own setting, else the one the morning-brief skill already verified (link only, read-only). */
export async function planningUrl(setting: string | null | undefined, registry = join(homedir(), ".codex/skills/morning-brief/references/sources.json")): Promise<string | null> {
  const own = canonicalArtifactUrl(setting);
  if (own) return own;
  try {
    const j = JSON.parse(await readFile(registry, "utf8")) as { sources?: { reader?: string; url?: string }[] };
    return canonicalArtifactUrl(j.sources?.find(s => s.reader === "claude_artifact")?.url);
  } catch { return null; }
}

type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
/** The developer's Slack user id, as the Slack tool describes it ("Current logged in user's user_id is U…"). */
export function slackUserFrom(toolsList: string): string | null { return /user_id is (U[A-Z0-9]{6,})/.exec(toolsList)?.[1] ?? null; }
const runFile: Run = async (command, args, timeout) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;

/** The live sources: read-only mcpproxy and gh calls, and one Artifact read for the plan. */
export function liveRankSources(jobs: AiJobs, opts: { run?: Run; slackSelf?: string | null; slackUser?: string | null; model?: () => Promise<string | null> } = {}): RankSources {
  const run = opts.run ?? runFile;
  let slackUser: Promise<string | null> | null = opts.slackUser !== undefined ? Promise.resolve(opts.slackUser) : null;
  const me = () => slackUser ??= run("mcpproxy", ["tools", "list", "--server=slack-user", "-o", "json", "--log-level=error"], 30_000).then(slackUserFrom).catch(() => { slackUser = null; return null; });
  const call = async (tool: string, args: unknown) => mcpproxyText(await run("mcpproxy", ["call", "tool-read", `--tool-name=${tool}`, `--json_args=${JSON.stringify(args)}`, "--reason=Follow-up: rank today's workstreams", "--log-level=error", "-o", "json"], 60_000));
  return {
    async linear() {
      return parseLinearIssues(await call("linear:list_issues", { assignee: "me", limit: 60, orderBy: "updatedAt", fields: ["id", "title", "priority", "dueDate", "status", "statusType", "project", "projectMilestone", "url"] }));
    },
    async slack(since) {
      const after = new Date(since).toISOString().slice(0, 10);
      const base = { limit: 20, response_format: "concise", sort: "timestamp", include_context: false, natural_language_query: "" };
      const dms = parseSlackSearch(await call("slack-user:slack_search_public_and_private", { ...base, filters: `is:dm after:${after}` }), opts.slackSelf ?? null);
      const user = await me();
      const mentions = user ? parseSlackSearch(await call("slack-user:slack_search_public_and_private", { ...base, keywords: [`<@${user}>`], filters: `after:${after}` }), opts.slackSelf ?? null) : [];
      const seen = new Set<string>();
      return [...mentions, ...dms].filter(m => { const k = `${m.who}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
    },
    async github() {
      return parseReviewRequests(await run("gh", ["search", "prs", "--review-requested=@me", "--state=open", "--limit=30", "--json", "number,title,url,repository,author"], 30_000));
    },
    async planning(url) {
      const model = (await opts.model?.()) ?? "sonnet";
      const r = await jobs.run({ name: "rank-plan", prompt: `Read this artifact with the Artifact tool (action "read"): ${url}\nThen reply with the JSON object.`, system: PLAN_SYSTEM, schema: planReplySchema, model,
        // Always Claude: the Artifact tool is Claude Code's.
        provider: "claude", runner: claudeRunner("claude", planArgs, PLAN_ENV), timeoutMs: 180_000, maxOutputChars: 20_000 });
      if (!r.ok) throw new Error(r.error);
      return { title: r.value.title, url, items: r.value.items.map(i => ({ level: i.level, title: i.title, keys: i.keys.filter(k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)) })) };
    },
  };
}

// ---------- state ----------

const healthSchema = z.enum(["ok", "failed", "off"]);
export const rankerStateSchema = z.object({
  version: z.literal(1),
  lastHash: z.string().nullable(), lastRunAt: z.string().nullable(), lastModelAt: z.string().nullable(),
  day: z.string().nullable(), runsToday: z.number().int(),
  health: z.record(z.string(), healthSchema), notStarted: z.array(z.object({ key: z.string(), title: z.string(), url: z.string().nullable(), reason: z.string() })),
  last: z.object({ ok: z.boolean(), trigger: z.string(), costUsd: z.number().nullable(), durationMs: z.number(), skipped: z.string().nullable(), error: z.string().nullable() }).nullable(),
  slackSince: z.number().nullable(),
  planning: z.object({ url: z.string(), at: z.string(), value: z.object({ title: z.string().nullable(), url: z.string().nullable(), items: z.array(z.object({ level: z.string(), title: z.string(), keys: z.array(z.string()) })) }) }).nullable(),
});
export type RankerState = z.infer<typeof rankerStateSchema>;
const EMPTY: RankerState = { version: 1, lastHash: null, lastRunAt: null, lastModelAt: null, day: null, runsToday: 0, health: {}, notStarted: [], last: null, slackSince: null, planning: null };

export type RankTrigger = "schedule" | "manual" | "overseer";
export type RankResult = {
  ok: boolean; trigger: RankTrigger; dryRun: boolean;
  /** Why the model wasn't called: nothing changed, the daily cap, memory, a run already going, off. */
  skipped: "same" | "cap" | "tight" | "busy" | "off" | "sources" | null;
  priorities: (Priority & { title: string })[]; notStarted: NotStarted[]; health: Partial<Record<RankSource, SourceHealth>>; healthLine: string;
  costUsd: number | null; durationMs: number; error: string | null; dropped: string[];
};

export type RankerDeps = {
  directory: string;
  jobs: AiJobs;
  sources: RankSources;
  workstreams(): Promise<WorkstreamRow[]>;
  priorities: { read(): Promise<Priority[]>; write(batch: Priority[], replace: boolean): Promise<Priority[]> };
  role(): Promise<RankerRole>;
  enabled(): Promise<boolean>;
  /** The resource governor: background runs wait while this is true. Manual runs still go. */
  tight?: () => Promise<boolean>;
  planningUrl?: () => Promise<string | null>;
  now?: () => number;
};

const SLACK_WINDOW_MS = 48 * 3_600_000;
const PLAN_EVERY_MS = 24 * 3_600_000;
/** Unchanged inputs keep the last ranking; it is re-stamped before Home's 6-hour freshness runs out. */
const RESTAMP_MS = 4 * 3_600_000;

/**
 * One ranking run at a time. Inputs are read in sequence (concurrency 1), hashed, and the model is called only
 * when they changed. State lives in ranker.json, priorities in priorities.json; neither touches state.json.
 */
export class Ranker {
  private running: Promise<RankResult> | null = null;
  constructor(private d: RankerDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private get path() { return join(this.d.directory, "ranker.json"); }
  async state(): Promise<RankerState> { try { return rankerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); } catch { return { ...EMPTY }; } }

  /** The scheduled run: in the window, at the role's cadence, only with room to spare. */
  async tick(): Promise<RankResult | null> {
    if (this.running || !inRankWindow(this.now()) || !await this.d.enabled()) return null;
    const [s, role] = await Promise.all([this.state(), this.d.role()]);
    if (s.lastRunAt && this.now() - Date.parse(s.lastRunAt) < role.cadenceMinutes * 60_000) return null;
    if (await this.d.tight?.()) return null;
    return this.run({ trigger: "schedule" });
  }

  run(opts: { trigger: RankTrigger; dryRun?: boolean; force?: boolean }): Promise<RankResult> {
    if (this.running) return this.running.then(r => ({ ...r, skipped: "busy" as const }));
    this.running = this.once(opts).finally(() => { this.running = null; });
    return this.running;
  }

  private async once({ trigger, dryRun = false, force = false }: { trigger: RankTrigger; dryRun?: boolean; force?: boolean }): Promise<RankResult> {
    const started = this.now();
    const base = (patch: Partial<RankResult>): RankResult => ({ ok: false, trigger, dryRun, skipped: null, priorities: [], notStarted: [], health: {}, healthLine: "", costUsd: null, durationMs: this.now() - started, error: null, dropped: [], ...patch });
    if (!await this.d.enabled()) return base({ skipped: "off" });
    if (trigger === "schedule" && await this.d.tight?.()) return base({ skipped: "tight" });
    const s = await this.state();
    const role = await this.d.role();
    const day = jerusalem(started).day;
    const runsToday = s.day === day ? s.runsToday : 0;

    // Inputs, one source at a time. A failing source is reported, never fatal.
    const health: Partial<Record<RankSource, SourceHealth>> = {};
    const read = async <T>(source: RankSource, fn: () => Promise<T>, fallback: T): Promise<T> => { try { const v = await fn(); health[source] = "ok"; return v; } catch { health[source] = "failed"; return fallback; } };
    const rows = await this.d.workstreams();
    const linear = await read("linear", () => this.d.sources.linear(), []);
    // The whole 48-hour window every run, so equal inputs hash equal; the last read time is kept for the log.
    const slackSince = started;
    const slack = await read("slack", () => this.d.sources.slack(started - SLACK_WINDOW_MS), []);
    const github = await read("github", () => this.d.sources.github(), []);
    const url = await this.d.planningUrl?.().catch(() => null) ?? null;
    let planning: RankPlanning | null = null; let planCache = s.planning;
    if (!url) health.planning = "off";
    else if (s.planning && s.planning.url === url && started - Date.parse(s.planning.at) < PLAN_EVERY_MS) { planning = s.planning.value; health.planning = "ok"; }
    else {
      planning = await read("planning", () => this.d.sources.planning(url), null);
      if (planning) planCache = { url, at: new Date(started).toISOString(), value: planning };
      else if (s.planning?.url === url) planning = s.planning.value; // keep yesterday's plan over none
    }
    const inputs: RankInputs = { workstreams: rows.map(rankWorkstream), linear, slack, github, planning };
    const hash = inputsHash(inputs);
    const save = async (patch: Partial<RankerState>) => dryRun ? undefined : (await mkdir(this.d.directory, { recursive: true, mode: 0o700 }), atomic(this.path, { ...s, day, runsToday, health, planning: planCache, slackSince, lastRunAt: new Date(started).toISOString(), ...patch }));

    // Nothing from outside could be read (no logins, mcpproxy down, an isolated test daemon): a ranking would have
    // nothing to go on, so don't spend a model call. The next tick tries again at the cadence.
    if (!(["linear", "slack", "github", "planning"] as const).some(k => health[k] === "ok")) {
      await save({ last: { ok: false, trigger, costUsd: null, durationMs: this.now() - started, skipped: "sources", error: "No outside source could be read." } });
      return base({ skipped: "sources", health, healthLine: healthLine(health), error: "No outside source could be read." });
    }
    // Nothing changed: keep the ranking, re-stamping it before it goes stale.
    if (!force && hash === s.lastHash) {
      const stored = (await this.d.priorities.read()).filter(p => p.by === "ranker");
      const newest = stored.reduce((m, p) => p.at > m ? p.at : m, "");
      if (!dryRun && stored.length && started - Date.parse(newest) > RESTAMP_MS) await this.d.priorities.write(stored.map(p => ({ ...p, at: new Date(started).toISOString() })), false);
      await save({ last: { ok: true, trigger, costUsd: null, durationMs: this.now() - started, skipped: "same", error: null } });
      return base({ ok: true, skipped: "same", health, healthLine: healthLine(health), notStarted: s.notStarted, priorities: this.titled(stored, inputs) });
    }
    if (runsToday >= role.dailyCap && trigger !== "manual") {
      await save({ last: { ok: false, trigger, costUsd: null, durationMs: this.now() - started, skipped: "cap", error: null } });
      return base({ skipped: "cap", health, healthLine: healthLine(health) });
    }

    const maxPromptChars = role.maxPromptChars ?? 60_000;
    const prompt = rankPrompt(inputs, day, maxPromptChars);
    const r = await this.d.jobs.run({ name: "rank", prompt, system: RANK_SYSTEM, schema: rankReplySchema, provider: role.provider, model: role.model ?? undefined, thinking: role.thinking, maxPromptChars, maxOutputChars: 40_000, timeoutMs: 240_000 });
    const durationMs = this.now() - started;
    if (!r.ok) {
      await save({ runsToday: runsToday + 1, last: { ok: false, trigger, costUsd: r.costUsd, durationMs, skipped: null, error: r.error } });
      return base({ health, healthLine: healthLine(health), costUsd: r.costUsd, error: r.error });
    }
    const at = new Date(this.now()).toISOString();
    const { priorities, notStarted, dropped } = toPriorities(r.value, inputs, at);
    // The ranker's own job: stored directly (set_priorities without the confirm step), replacing its last ranking.
    if (!dryRun && priorities.length) await this.d.priorities.write(priorities, true);
    await save({ lastHash: hash, lastModelAt: at, runsToday: runsToday + 1, notStarted, last: { ok: true, trigger, costUsd: r.costUsd, durationMs, skipped: null, error: null } });
    return base({ ok: true, priorities: this.titled(priorities, inputs), notStarted, health, healthLine: healthLine(health), costUsd: r.costUsd, durationMs, dropped });
  }

  private titled(items: Priority[], inputs: RankInputs) {
    const by = new Map(inputs.workstreams.map(w => [w.id, w.title]));
    return items.map(p => ({ ...p, title: by.get(p.workspaceId) ?? p.workspaceId }));
  }

  /** For Home's sort header: the last run and what it could read. */
  async status(): Promise<{ enabled: boolean; running: boolean; lastRunAt: string | null; healthLine: string; error: string | null; costUsd: number | null; notStarted: number }> {
    const s = await this.state();
    return { enabled: await this.d.enabled(), running: !!this.running, lastRunAt: s.lastRunAt, healthLine: healthLine(s.health as Partial<Record<RankSource, SourceHealth>>), error: s.last?.error ?? null, costUsd: s.last?.costUsd ?? null, notStarted: s.notStarted.length };
  }
}
