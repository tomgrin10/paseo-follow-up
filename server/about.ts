import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ABOUT_RETRY_MS, ABOUT_TTL_MS, aboutRecordSchema, currentSummary, dailyBudget, extractLinks, keysFromBranch, needsOverview, summaryOutputSchema, stableJson, usageAllows, SUMMARY_MAX_CHARS,
  type AboutLink, type AboutRecord, type AboutView, type SummaryOutput,
} from "../shared/about";
import type { Workspace } from "../shared/model";
import { messageSender, senderLabel, workItems } from "../shared/message-sender";
import type { AiJobs } from "./ai-jobs";
import { githubApi, type GithubApi } from "./github-api";
import { isLoaded, type LoadSignals } from "../shared/agent-load";

const exec = promisify(execFile);

/** Bounds on what goes into one overview prompt. */
export const LIMITS = { tailItems: 30, itemChars: 600, tailChars: 12_000, firstChars: 1200, prBodyChars: 1500, prs: 30, prBodies: 6, issues: 5, issueChars: 1200, threads: 4, subagents: 12, promptChars: 40_000 };
export const DAILY_BACKGROUND_CAP = 60;

// ---------- sources ----------

export type LinearIssue = { title: string; state: string | null; priority: string | null; due: string | null; url: string | null; description: string };
export type SlackThread = { channel: string | null; who: string | null; excerpt: string | null };
export type PrDetail = { title: string; state: string; body: string };
/** Daemon-side reads. `null` means "not found" (dropped, never invented); a throw means the source failed. */
export type AboutSources = {
  linear(key: string): Promise<LinearIssue | null>;
  slack(channel: string, ts: string): Promise<SlackThread | null>;
  pr(repo: string, number: number): Promise<PrDetail | null>;
};

/** mcpproxy prints a banner, then `{"content":[{"text":"[map[text:<json> type:text]]"}]}`. Returns the inner text. */
export function mcpproxyText(stdout: string): string {
  const at = stdout.search(/\{\s*"content"\s*:/);
  if (at < 0) throw new Error("mcpproxy returned no result");
  const data = JSON.parse(stdout.slice(at)) as { content?: { text?: string }[]; isError?: boolean };
  const text = (data.content ?? []).map(b => b.text ?? "").join("\n");
  if (data.isError) throw new Error(text.slice(0, 200) || "mcpproxy tool error");
  const wrapped = /^\[map\[text:([\s\S]*) type:text\]\]$/.exec(text.trim());
  return wrapped ? wrapped[1] : text;
}

type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>;
const runFile: Run = async (command, args, timeout) => (await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;

export function parseLinearIssue(text: string): LinearIssue | null {
  let j: { title?: unknown; status?: unknown; priority?: { name?: unknown } | null; dueDate?: unknown; url?: unknown; description?: unknown };
  try { j = JSON.parse(text); } catch { if (/not found|no issue|could not find/i.test(text)) return null; throw new Error("Linear returned an unreadable issue"); }
  if (!j || typeof j.title !== "string") return null;
  const priority = typeof j.priority?.name === "string" && j.priority.name !== "No priority" ? j.priority.name : null;
  return { title: j.title.slice(0, 300), state: typeof j.status === "string" ? j.status.slice(0, 60) : null, priority, due: typeof j.dueDate === "string" ? j.dueDate.slice(0, 10) : null, url: typeof j.url === "string" ? j.url : null, description: typeof j.description === "string" ? j.description.slice(0, LIMITS.issueChars) : "" };
}

/** The thread's parent: channel, who wrote it and a one-line excerpt. Accepts JSON or the tool's text rendering. */
export function parseSlackThread(text: string): SlackThread | null {
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* text form */ }
  const line = (s: string) => s.replace(/<[^>|]+\|([^>]+)>/g, "$1").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const obj = j as { messages?: { user_name?: string; user?: string; real_name?: string; text?: string }[]; channel_name?: string; channel?: string } | null;
  if (obj && Array.isArray(obj.messages)) {
    const m = obj.messages[0];
    if (!m) return null;
    return { channel: obj.channel_name ?? null, who: m.real_name ?? m.user_name ?? null, excerpt: m.text ? line(m.text) : null };
  }
  if (!text.trim() || /thread_not_found|channel_not_found|not_in_channel/.test(text)) return null;
  // Text rendering: "=== Message from Jane Doe (U123) at … ===\n<text>" or "Jane Doe: text".
  const header = /Message from ([^(\n]+?)\s*\(/.exec(text) ?? /^\s*\**([A-Z][\w.' -]{1,40}?)\**\s*[:(]/m.exec(text);
  const who = header ? header[1].trim() : null;
  const body = text.split("\n").map(s => s.trim()).filter(s => s && !/^(===|---|Message from|Thread|Channel|Replies|#)/i.test(s) && !/^\w+:\s*$/.test(s));
  const channel = /(?:channel|in)\s*[:#]\s*#?([\w-]{2,80})/i.exec(text)?.[1] ?? null;
  return { channel, who, excerpt: body[0] ? line(body[0].replace(/^[^:]{1,40}:\s*/, "")) : null };
}

/** mcpproxy for Linear and Slack; the PR read goes through `api`, in process (worker-reads-github-in-process). */
export function liveSources(run: Run = runFile, api: Pick<GithubApi, "rest"> = githubApi()): AboutSources {
  const call = async (tool: string, args: unknown) => mcpproxyText(await run("mcpproxy", ["call", "tool-read", `--tool-name=${tool}`, `--json_args=${JSON.stringify(args)}`, "--reason=Follow-up: what a workspace is about", "--log-level=error", "-o", "json"], 45_000));
  return {
    async linear(key) { return parseLinearIssue(await call("linear:get_issue", { id: key })); },
    async slack(channel, ts) { return parseSlackThread(await call("slack-user:slack_read_thread", { channel_id: channel, message_ts: ts, limit: 1 })); },
    async pr(repo, number) {
      const j = await api.rest(repo, `repos/${repo}/pulls/${number}`) as { title?: string; state?: string; merged_at?: string | null; body?: string | null } | null;
      // REST says open/closed plus merged_at; the prompt keeps gh's OPEN/CLOSED/MERGED.
      const state = j?.merged_at ? "MERGED" : (j?.state ?? "").toUpperCase();
      return typeof j?.title === "string" ? { title: j.title, state, body: (j.body ?? "").slice(0, LIMITS.prBodyChars) } : null;
    },
  };
}

// ---------- inputs ----------

type TimelineItem = { type?: string; text?: string; name?: string; title?: string; status?: string; [k: string]: unknown };
export type HistorySource = "live" | "transcript" | "none";
export type AboutContext = {
  /**
   * The root agent's first developer messages and last items (oldest first). Live timeline only when the agent is
   * loaded; otherwise its provider transcript on disk; otherwise nothing (the goal and PR titles stand in).
   */
  history(agentId: string, limit: number): Promise<{ first: string[]; items: readonly unknown[]; source: HistorySource }>;
  /** Titles of agents the root agent launched. */
  subagents(agentId: string): Promise<string[]>;
};
/**
 * Picks where the root agent's history comes from. The live timeline only when the agent is loaded (reading an
 * unloaded one resumes it); else its transcript on disk; else nothing.
 */
export async function rootHistory(snapshot: LoadSignals | null | undefined, timeline: () => Promise<readonly unknown[]>, disk: () => Promise<{ first: string[]; items: readonly unknown[] } | null>): Promise<{ first: string[]; items: readonly unknown[]; source: HistorySource }> {
  if (isLoaded(snapshot)) return { first: [], items: await timeline(), source: "live" };
  const saved = await disk().catch(() => null);
  return saved ? { ...saved, source: "transcript" } : { first: [], items: [], source: "none" };
}

export type AboutInputs = {
  workspaceId: string; title: string; goal: string; branches: string[]; source: HistorySource;
  firstMessages: string[]; tail: string[]; subagents: string[];
  prs: { key: string; title: string; state: string }[];
  linkTexts: string[];
};

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function tailLines(items: readonly unknown[]): { lines: string[]; users: string[]; raw: string[] } {
  const lines: string[] = [], users: string[] = [], raw: string[] = [];
  // Follow-up's hook feedback and the agent's bookkeeping reply to it never reach the Summary model.
  for (const item of workItems(items)) {
    if (!item || typeof item !== "object") continue;
    const v = item as TimelineItem;
    if (v.type === "reasoning" || v.type === "plugin") continue;
    const text = typeof v.text === "string" ? v.text : "";
    if (v.type === "user_message") {
      // Only the developer is "Developer"; Follow-up's own messages and system text aren't the work's story.
      const s = messageSender(text);
      if (s.kind === "developer" && s.text) { users.push(s.text); raw.push(s.text); lines.push(`Developer: ${clip(s.text, LIMITS.itemChars)}`); }
      else if (s.kind === "overseer-forward" && s.text) { users.push(s.text); raw.push(s.text); lines.push(`Developer (via Overseer): ${clip(s.text, LIMITS.itemChars)}`); }
      else if (s.kind === "agent" && s.text) lines.push(`${senderLabel(s)}: ${clip(s.text, LIMITS.itemChars)}`);
    } else if (v.type === "assistant_message") {
      if (!text.trim()) continue;
      raw.push(text); lines.push(`Agent: ${clip(text, LIMITS.itemChars)}`);
    } else if (v.type === "tool_call") {
      // Tool output is where links land ("gh pr create" prints the URL); only the name goes to the model.
      raw.push(JSON.stringify(item).slice(0, 4000));
      if (typeof v.name === "string") lines.push(`(tool: ${clip(v.name, 60)})`);
    }
  }
  // Keep the newest within the character budget.
  let total = 0; const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) { total += lines[i].length; if (total > LIMITS.tailChars) break; kept.unshift(lines[i]); }
  return { lines: kept, users, raw };
}

export async function collectInputs(w: Workspace, ctx: AboutContext): Promise<AboutInputs> {
  const [history, subagents] = await Promise.all([
    ctx.history(w.mainAgentId, LIMITS.tailItems).catch(() => ({ first: [] as string[], items: [] as unknown[], source: "none" as const })),
    ctx.subagents(w.mainAgentId).catch(() => [] as string[]),
  ]);
  const tail = tailLines(history.items);
  const live = w.prs.filter(p => p.snapshot);
  const branches = [...new Set(live.map(p => p.snapshot!.headBranch).filter(Boolean))];
  const firstMessages = [w.goal, ...history.first.slice(0, 2), ...tail.users.slice(0, 1)].filter((x, i, a) => x && a.indexOf(x) === i).map(x => clip(x, LIMITS.firstChars));
  return {
    workspaceId: w.id, title: w.title, goal: w.goal, branches, firstMessages, source: history.source,
    tail: tail.lines, subagents: subagents.slice(0, LIMITS.subagents).map(s => clip(s, 120)),
    prs: w.prs.slice(0, LIMITS.prs).map(p => ({ key: p.key, title: p.snapshot?.title ?? "", state: p.snapshot?.state ?? "" })),
    linkTexts: [w.title, w.goal, ...branches, ...w.prs.map(p => p.snapshot?.title ?? ""), ...tail.raw, w.spec?.url ?? ""],
  };
}

/**
 * The cheap identity of what the Summary is written from: purpose only (name, goal, first asks, PR titles). The chat's
 * latest turns, PR states and subagents don't change what a workspace is for, so they don't buy a new sentence.
 */
export function inputsHash(inputs: AboutInputs): string {
  return createHash("sha256").update(stableJson({ v: 2, title: inputs.title, goal: inputs.goal, first: inputs.firstMessages, prs: inputs.prs.map(p => p.title) })).digest("hex").slice(0, 32);
}

/** Extraction plus the workspace's own PRs, which are linked by definition. */
export function workspaceLinks(inputs: AboutInputs): AboutLink[] {
  const branchKeys = inputs.branches.flatMap(keysFromBranch).join(" ");
  const found = extractLinks([branchKeys, ...inputs.linkTexts], 40);
  const cased = (state: string) => state ? state.charAt(0) + state.slice(1).toLowerCase() : null;
  // Extracted links to the workspace's own PRs take its snapshot's title and state.
  for (const l of found) { const p = inputs.prs.find(p => p.key === l.key); if (p) { l.title ??= p.title || null; l.state ??= cased(p.state); } }
  for (const p of inputs.prs) if (!found.some(l => l.key === p.key)) {
    const [repo, n] = p.key.split("#");
    found.push({ kind: "pr", key: p.key, url: `https://github.com/${repo}/pull/${n}`, title: p.title || null, state: p.state ? p.state.charAt(0) + p.state.slice(1).toLowerCase() : null, priority: null, due: null, who: null, excerpt: null });
  }
  return found.slice(0, 40);
}

/** Reads each linked item's details. Not found drops a Linear key (it may not be an issue); a failure keeps the bare link. */
export async function enrichLinks(links: AboutLink[], sources: AboutSources): Promise<{ links: AboutLink[]; failed: string[]; issues: { key: string; title: string; description: string }[]; prBodies: { key: string; title: string; body: string }[] }> {
  const failed = new Set<string>();
  const issues: { key: string; title: string; description: string }[] = [];
  const prBodies: { key: string; title: string; body: string }[] = [];
  let linear = 0, slack = 0, prs = 0;
  const out = await Promise.all(links.map(async (l): Promise<AboutLink | null> => {
    try {
      if (l.kind === "linear" && linear++ < LIMITS.issues + 3) {
        const issue = await sources.linear(l.key);
        if (!issue) return l.url ? l : null;
        if (issues.length < LIMITS.issues) issues.push({ key: l.key, title: issue.title, description: issue.description });
        return { ...l, url: issue.url ?? l.url, title: issue.title, state: issue.state, priority: issue.priority, due: issue.due };
      }
      if (l.kind === "slack" && slack++ < LIMITS.threads) {
        const [channel, ts] = l.key.slice(6).split("/");
        const thread = await sources.slack(channel, ts);
        return thread ? { ...l, title: thread.channel ? `#${thread.channel.replace(/^#/, "")}` : null, who: thread.who, excerpt: thread.excerpt } : l;
      }
      if (l.kind === "pr" && prs++ < LIMITS.prBodies) {
        const [repo, n] = l.key.split("#");
        const pr = await sources.pr(repo, Number(n));
        if (!pr) return l;
        prBodies.push({ key: l.key, title: pr.title, body: pr.body });
        return { ...l, title: pr.title.slice(0, 300), state: pr.state ? pr.state.charAt(0) + pr.state.slice(1).toLowerCase() : l.state };
      }
    } catch {
      failed.add(l.kind === "linear" ? "Linear" : l.kind === "slack" ? "Slack" : "GitHub");
    }
    return l;
  }));
  return { links: out.filter((l): l is AboutLink => !!l), failed: [...failed], issues, prBodies };
}

/**
 * The Summary prompt: one sentence of purpose, from the workspace's name, goal, the developer's first asks and its PR
 * titles. Nothing else is sent (no chat tail, PR bodies, issues or threads), which also keeps the call small.
 */
export function summaryPrompt(inputs: AboutInputs, cap: number = LIMITS.promptChars): string {
  const section = (title: string, lines: string[]) => lines.length ? `## ${title}\n${lines.join("\n")}\n` : "";
  const prompt = [
    "You write a one-sentence reminder of what a workspace is for. It shows under the workspace's name in a developer's agent dashboard, for when they have switched between many workspaces and forgotten what this one is.",
    "Return JSON: {\"sentence\": string}.",
    `- One plain sentence on one line, about 20 words and at most ${SUMMARY_MAX_CHARS} characters, ending with a period.`,
    "- Say what the work is for: the goal or the problem it solves, in the developer's terms. Not where it stands.",
    "- No PR or issue numbers, no counts, no people's names, no status words (merged, waiting, blocked, done), no questions, no markdown.",
    "- Use only what's below. If the purpose isn't clear, describe the change being made.",
    "",
    section("Workspace", [`Name: ${inputs.title}`, ...(inputs.branches.length ? [`Branches: ${inputs.branches.join(", ")}`] : [])]),
    section("What the developer asked first", inputs.firstMessages.map(m => `> ${m}`)),
    section("Pull request titles", inputs.prs.filter(p => p.title).map(p => `- ${p.title}`)),
  ].join("\n");
  return prompt.length > cap ? prompt.slice(0, cap) : prompt;
}

// ---------- the store and the service ----------

const fileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), aboutRecordSchema),
  failures: z.record(z.string(), z.object({ at: z.number(), error: z.string() })).default({}),
  daily: z.object({ date: z.string(), count: z.number().int() }).nullable().default(null),
});
type AboutFile = z.infer<typeof fileSchema>;

/** Its own file (about.json) beside state.json; a corrupt or missing file is an empty cache. */
export class AboutStore extends JsonFileStore<AboutFile> {
  constructor(directory: string) {
    super({ path: join(directory, "about.json"), schema: fileSchema as never, empty: () => ({ version: 1, entries: {}, failures: {}, daily: null }), collections: { entries: { kind: "record", item: aboutRecordSchema } } });
  }
}

export type AboutDeps = {
  store: AboutStore;
  jobs: AiJobs;
  sources: AboutSources;
  workspace(id: string): Promise<Workspace | null>;
  context(): AboutContext | null;
  usage(): Promise<{ accounts: { family: string; windows: { pct: number }[] }[] }>;
  /** The root agent's first user message, from discovery's persisted history cache (never a timeline read). */
  firstMessage?(agentId: string): Promise<string | null>;
  /** Background work only while the VM has room (the resource governor's background threshold). */
  roomForBackground?(): Promise<boolean>;
  /** Writing on open or Refresh only below the governor's higher threshold; above it, the cache is served. */
  roomOnDemand?(): Promise<boolean>;
  /** The "about" role from Settings → Agents: provider, model, effort, daily cap and prompt cap. Default: Claude Haiku, 60 a day. */
  role?(): Promise<{ provider: string; model: string | null; thinking: string | null; dailyCap: number | null; maxPromptChars: number | null }>;
  now?: () => number;
};

export class AboutService {
  private inflight = new Map<string, Promise<void>>();
  /** Reading a workspace's inputs (history, subagents) for an open or a Rewrite: after the reply, one per workspace. */
  private collecting = new Map<string, Promise<void>>();
  /** What the last read of inputs found, for the replies while no sentence exists yet. */
  private found = new Map<string, { links: AboutLink[]; firstMessage: string | null }>();
  /** How long an open's reply waits for the inputs before it says pending (the ack budget leaves room for the rest). */
  collectWaitMs = 300;
  constructor(private deps: AboutDeps) {}
  private now() { return (this.deps.now ?? Date.now)(); }

  /**
   * The section's view. `open` lets it write an overview when needed; collapsed reads only the cache.
   * Writing happens in the background: the view comes back at once as pending and the client polls.
   */
  async view(workspaceId: string, opts: { open?: boolean; refresh?: boolean; wait?: boolean } = {}): Promise<AboutView> {
    const w = await this.deps.workspace(workspaceId);
    const file = await this.deps.store.read();
    const cached = currentSummary(file.entries[workspaceId]);
    if (!w) return { status: cached ? "ready" : "idle", record: cached, firstMessage: null, links: [], error: cached ? null : "Follow-up isn't following this workspace." };
    let firstMessage = await this.firstMessage(w);
    if ((opts.open || opts.refresh) && this.deps.roomOnDemand && !await this.deps.roomOnDemand().catch(() => true)) opts = { ...opts, open: false, refresh: false };
    if (!opts.open && !opts.refresh) {
      const running = this.inflight.has(workspaceId);
      return { status: running ? "pending" : cached ? "ready" : "idle", record: cached, firstMessage, links: cached ? [] : this.found.get(workspaceId)?.links ?? [], error: null };
    }
    // Reading the inputs waits on the history cache and Paseo's subagents. The reply waits for it up to
    // `collectWaitMs`, so a fast read answers in full as before; past that the view says pending and the client asks
    // again soon (tests/rpc-cached.test.ts). Only an agent's `wait` waits for the whole read.
    const fresh = !!cached && this.now() - Date.parse(cached.generatedAt) < ABOUT_TTL_MS;
    // A read already under way (the previous ask's) is waited on the same way, so a poll lands as it finishes.
    const collected = this.collecting.get(workspaceId) ?? (!this.inflight.has(workspaceId) && (opts.refresh || !fresh) ? this.collect(w, !!opts.refresh) : null);
    if (collected) {
      if (opts.wait) await collected;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([collected, new Promise<void>(resolve => { timer = setTimeout(resolve, this.collectWaitMs); timer.unref?.(); })]);
        clearTimeout(timer);
      }
    }
    const running = this.inflight.get(workspaceId);
    if (running && opts.wait) await running;
    const after = await this.deps.store.read();
    const failure = after.failures[workspaceId];
    // Inside a failure's back-off a read of inputs only refreshes links, so it isn't "pending".
    const mayWrite = opts.refresh || !(failure && this.now() - failure.at < ABOUT_RETRY_MS);
    const pending = this.inflight.has(workspaceId) || (this.collecting.has(workspaceId) && !!mayWrite);
    const record = currentSummary(after.entries[workspaceId]);
    const found = this.found.get(workspaceId);
    firstMessage ??= found?.firstMessage ?? null;
    return { status: pending ? "pending" : record ? "ready" : failure ? "failed" : "idle", record, firstMessage, links: record ? [] : found?.links ?? [], error: !pending && failure && (!record || failure.at > Date.parse(record.generatedAt)) ? failure.error : null };
  }

  /** Reads a workspace's inputs once (a second open joins the first) and starts a write when they call for one. */
  private collect(w: Workspace, refresh: boolean): Promise<void> {
    const prior = this.collecting.get(w.id);
    if (prior) return prior;
    const work = (async () => {
      const ctx = this.deps.context();
      if (!ctx) return;
      const inputs = await collectInputs(w, ctx);
      this.found.set(w.id, { links: workspaceLinks(inputs), firstMessage: inputs.firstMessages.find(m => m.trim().toLowerCase() !== w.title.trim().toLowerCase()) ?? null });
      const file = await this.deps.store.read();
      const cached = currentSummary(file.entries[w.id]);
      const failure = file.failures[w.id];
      if (!this.inflight.has(w.id) && needsOverview(cached, inputsHash(inputs), this.now(), { refresh, failedAt: failure?.at ?? null })) void this.start(w, inputs, inputsHash(inputs));
    })().catch(() => undefined).finally(() => { this.collecting.delete(w.id); });
    this.collecting.set(w.id, work);
    return work;
  }

  /** The developer's first words: the history cache's goal, else the workspace goal unless it only repeats the title. */
  private async firstMessage(w: Workspace): Promise<string | null> {
    const cached = await this.deps.firstMessage?.(w.mainAgentId).catch(() => null);
    const text = cached || (w.goal && w.goal.trim().toLowerCase() !== w.title.trim().toLowerCase() ? w.goal : null);
    return text ? clip(text, 400) : null;
  }

  /** Pre-writes overviews for workspaces in Needs you: under the daily cap, and only while usage is below the ceiling. */
  async background(workspaceIds: string[]): Promise<{ started: number; skipped: string | null }> {
    if (!workspaceIds.length) return { started: 0, skipped: null };
    if (this.deps.roomForBackground && !await this.deps.roomForBackground().catch(() => true)) return { started: 0, skipped: "memory" };
    const usage = await this.deps.usage().catch(() => ({ accounts: [] }));
    if (!usageAllows(usage.accounts)) return { started: 0, skipped: "usage" };
    const ctx = this.deps.context();
    if (!ctx) return { started: 0, skipped: "no-session" };
    const cap = (await this.role()).dailyCap ?? DAILY_BACKGROUND_CAP;
    let started = 0;
    for (const id of workspaceIds) {
      if (this.inflight.has(id)) continue;
      const w = await this.deps.workspace(id);
      if (!w) continue;
      const file = await this.deps.store.read();
      const prior = currentSummary(file.entries[id]);
      if (prior && this.now() - Date.parse(prior.generatedAt) < ABOUT_TTL_MS) continue;
      const inputs = await collectInputs(w, ctx);
      const hash = inputsHash(inputs);
      if (!needsOverview(prior, hash, this.now(), { failedAt: file.failures[id]?.at ?? null })) continue;
      const budget = await this.deps.store.mutate(f => { const b = dailyBudget(f.daily, this.now(), cap); if (b.allowed) f.daily = b.next; return b.allowed; });
      if (!budget) return { started, skipped: "daily-cap" };
      // One at a time: the job runner's concurrency is shared with whatever the developer opens.
      await this.start(w, inputs, hash);
      started++;
    }
    return { started, skipped: null };
  }

  private async role() {
    const fallback = { provider: "claude", model: "haiku", thinking: null, dailyCap: DAILY_BACKGROUND_CAP, maxPromptChars: LIMITS.promptChars };
    return this.deps.role ? await this.deps.role().catch(() => fallback) : fallback;
  }

  private start(w: Workspace, inputs: AboutInputs, hash: string): Promise<void> {
    const work = (async () => {
      const role = await this.role();
      const result = await this.deps.jobs.run<SummaryOutput>({ name: "about", provider: role.provider, ...(role.model ? { model: role.model } : {}), thinking: role.thinking,
        prompt: summaryPrompt(inputs, role.maxPromptChars ?? LIMITS.promptChars), maxPromptChars: Math.max(role.maxPromptChars ?? LIMITS.promptChars, LIMITS.promptChars), schema: summaryOutputSchema, maxOutputChars: 600, timeoutMs: 90_000 });
      const at = this.now();
      // A reply that isn't one short sentence fails the job; the previous sentence (if any) stays.
      if (!result.ok) { await this.deps.store.mutate(f => { f.failures[w.id] = { at, error: result.error }; }); return; }
      const record: AboutRecord = {
        workspaceId: w.id, inputsHash: hash, generatedAt: new Date(at).toISOString(), form: "sentence",
        gist: result.value.sentence, overview: "",
        // Kept for the Linked items feature: extracted from the workspace's own text, not read from Linear or Slack.
        links: workspaceLinks(inputs),
        basis: { chat: inputs.firstMessages.length > 0, source: inputs.source, prs: inputs.prs.length, issues: [] },
        failed: [], costUsd: result.costUsd,
        by: { provider: role.provider, model: role.model ?? role.provider },
      };
      await this.deps.store.mutate(f => { f.entries[w.id] = record; delete f.failures[w.id]; });
    })().catch(async error => { await this.deps.store.mutate(f => { f.failures[w.id] = { at: this.now(), error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }; }).catch(() => undefined); })
      .finally(() => { this.inflight.delete(w.id); });
    this.inflight.set(w.id, work);
    return work;
  }
}
