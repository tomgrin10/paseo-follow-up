import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  aboutDisplay, classifyUrl, dailyBudget, extractLinks, footerText, keysFromBranch, linkLine, needsOverview, NO_LINKS, stableJson, usageAllows,
  ABOUT_TTL_MS, ABOUT_RETRY_MS, type AboutRecord, type AboutView,
} from "../shared/about";
import { AiJobs, claudeArgs, parseClaudeEnvelope, parseJsonReply, type Runner } from "../server/ai-jobs";
import {
  AboutService, AboutStore, collectInputs, enrichLinks, inputsHash, mcpproxyText, overviewPrompt, parseLinearIssue, parseSlackThread, tailLines, workspaceLinks,
  DAILY_BACKGROUND_CAP, LIMITS, type AboutContext, type AboutSources,
} from "../server/about";
import { AgentActions, READ_ONLY_TOOLS } from "../server/agent-actions";
import { rootHistory } from "../server/about";
import { readTranscript, parseLine } from "../server/transcript";
import { claudeRunner, MAX_STDOUT } from "../server/ai-jobs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { pr, snapshot, workspace } from "./fixtures";

const NOW = Date.parse("2026-11-09T09:50:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

// ---------- link extraction ----------

test("extracts Linear keys, Slack, GitHub, Linear, claude.ai and doc links, deduped in first-seen order", () => {
  const links = extractLinks([
    "Fixing HER-1312 and her-9 (lower case isn't a key). See HER-1312 again.",
    "Thread: https://herosecurity.slack.com/archives/C07ABCDEF/p1731140000123456 and the same https://herosecurity.slack.com/archives/C07ABCDEF/p1731140000123456.",
    "Reply link https://herosecurity.slack.com/archives/C07ABCDEF/p1731149999000001?thread_ts=1731140000.123456&cid=C07ABCDEF",
    "PR https://github.com/tomgrin10/paseo-follow-up/pull/24, graphite https://app.graphite.com/github/pr/tomgrin10/paseo-follow-up/24/title",
    "Issue https://linear.app/herosecurity/issue/HER-1312/vendor-service-accounts and plan https://claude.ai/artifact/abc-123 and https://docs.google.com/document/d/xyz/edit#heading=1",
    "UTF-8, ISO-8601, SHA-256 and GPT-4 are not issues; HER-0 isn't either. https://example.com/page is ignored.",
  ]);
  assert.deepEqual(links.map(l => l.key), [
    "HER-1312",
    "slack:C07ABCDEF/1731140000.123456",
    "tomgrin10/paseo-follow-up#24",
    "https://claude.ai/artifact/abc-123",
    "https://docs.google.com/document/d/xyz/edit",
  ]);
  // The bare key gained the Linear URL seen later; the reply link folded into its thread.
  assert.equal(links[0].url, "https://linear.app/herosecurity/issue/HER-1312/vendor-service-accounts");
  assert.equal(links[2].url, "https://github.com/tomgrin10/paseo-follow-up/pull/24");
  assert.ok(links.every(l => l.title === null), "extraction never writes titles");
});

test("URL classification trims trailing punctuation and rejects non-thread Slack links", () => {
  assert.equal(classifyUrl("https://github.com/a/b/pull/7).")?.key, "a/b#7");
  assert.equal(classifyUrl("https://acme.slack.com/archives/C1"), null);
  assert.equal(classifyUrl("not a url"), null);
  assert.equal(classifyUrl("https://www.notion.so/team/Plan-123")?.kind, "doc");
});

test("Linear keys come from branch names", () => {
  assert.deepEqual(keysFromBranch("tom/her-1312-vendor-fix"), ["HER-1312"]);
  assert.deepEqual(keysFromBranch("feature/utf-8-cleanup"), []);
  assert.deepEqual(keysFromBranch(null), []);
});

test("workspace links include the workspace's own PRs and keys from its branches", () => {
  const w = workspace({ title: "Investigate and plan database query fix", goal: "Look into the vendor activity query (HER-1290)", prs: [pr({ key: "acme/api#1352", repo: "acme/api", number: 1352, snapshot: snapshot({ title: "Speed up vendor activity", headBranch: "tom/her-1312-index", state: "MERGED" }) })] });
  const links = workspaceLinks({ workspaceId: w.id, source: "live", title: w.title, goal: w.goal, branches: ["tom/her-1312-index"], firstMessages: [w.goal], tail: [], subagents: [], prs: [{ key: "acme/api#1352", title: "Speed up vendor activity", state: "MERGED" }], linkTexts: [w.title, w.goal] });
  assert.deepEqual(links.map(l => l.key), ["HER-1312", "HER-1290", "acme/api#1352"]);
  assert.equal(links[2].title, "Speed up vendor activity");
});

// ---------- cache keys and staleness ----------

test("cache keys ignore key order and whitespace but change with the inputs", () => {
  assert.equal(stableJson({ b: 1, a: "x  y" }), stableJson({ a: "x y", b: 1 }));
  const base = { workspaceId: "w", source: "live" as const, title: "T", goal: "G", branches: [], firstMessages: ["G"], tail: ["Agent: done"], subagents: [], prs: [], linkTexts: ["unused"] };
  assert.equal(inputsHash(base), inputsHash({ ...base, linkTexts: ["different raw tool output"] }), "raw link text doesn't change the hash");
  assert.notEqual(inputsHash(base), inputsHash({ ...base, tail: ["Agent: done", "Developer: and the tests?"] }));
  assert.notEqual(inputsHash(base), inputsHash({ ...base, prs: [{ key: "a/b#1", title: "x", state: "MERGED" }] }));
});

test("staleness: none → write; same inputs → keep; changed inputs only after an hour; refresh always; failures back off", () => {
  const cached = { inputsHash: "h1", generatedAt: iso(30) };
  assert.equal(needsOverview(null, "h1", NOW), true);
  assert.equal(needsOverview(cached, "h1", NOW), false);
  assert.equal(needsOverview(cached, "h2", NOW), false, "changed but younger than an hour");
  assert.equal(needsOverview({ ...cached, generatedAt: new Date(NOW - ABOUT_TTL_MS).toISOString() }, "h2", NOW), true);
  assert.equal(needsOverview({ ...cached, generatedAt: iso(600) }, "h1", NOW), false, "old but unchanged");
  assert.equal(needsOverview(cached, "h1", NOW, { refresh: true }), true);
  assert.equal(needsOverview(null, "h1", NOW, { failedAt: NOW - 60_000 }), false);
  assert.equal(needsOverview(null, "h1", NOW, { failedAt: NOW - ABOUT_RETRY_MS }), true);
});

test("the daily background cap resets with the date; usage above 85% stops background work", () => {
  let state: { date: string; count: number } | null = null;
  for (let i = 0; i < 3; i++) { const b = dailyBudget(state, NOW, 3); assert.ok(b.allowed); state = b.next; }
  assert.equal(dailyBudget(state, NOW, 3).allowed, false);
  assert.equal(dailyBudget(state, NOW + 86_400_000, 3).allowed, true);
  assert.equal(usageAllows([{ family: "claude", windows: [{ pct: 85 }, { pct: 40 }] }]), true);
  assert.equal(usageAllows([{ family: "claude", windows: [{ pct: 86 }] }]), false);
  assert.equal(usageAllows([{ family: "codex", windows: [{ pct: 99 }] }]), true);
});

// ---------- the job runner ----------

const schema = z.strictObject({ gist: z.string(), overview: z.string() });
const reply = (text: string, costUsd = 0.001): Runner => async () => ({ text, costUsd, inputTokens: 900, outputTokens: 60 });

test("jobs return validated JSON, fenced or bare, and log duration and cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-jobs-"));
  try {
    const log = join(dir, "jobs.jsonl");
    const jobs = new AiJobs({ runner: reply("```json\n{\"gist\":\"g\",\"overview\":\"o\"}\n```"), logPath: log });
    const r = await jobs.run({ name: "about", prompt: "p", schema });
    assert.deepEqual(r.ok && r.value, { gist: "g", overview: "o" });
    assert.equal(r.costUsd, 0.001);
    const line = JSON.parse((await readFile(log, "utf8")).trim());
    assert.equal(line.name, "about"); assert.equal(line.ok, true); assert.equal(line.costUsd, 0.001); assert.equal(typeof line.durationMs, "number"); assert.equal(line.inputTokens, 900);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("jobs refuse invalid JSON, the wrong shape and over-long replies", async () => {
  const bad = await new AiJobs({ runner: reply("Sure! Here's a summary.") }).run({ name: "t", prompt: "p", schema });
  assert.equal(!bad.ok && bad.reason, "invalid-json");
  const shape = await new AiJobs({ runner: reply("{\"gist\":\"g\"}") }).run({ name: "t", prompt: "p", schema });
  assert.equal(!shape.ok && shape.reason, "invalid-shape");
  const extra = await new AiJobs({ runner: reply("{\"gist\":\"g\",\"overview\":\"o\",\"links\":[\"made up\"]}") }).run({ name: "t", prompt: "p", schema });
  assert.equal(!extra.ok && extra.reason, "invalid-shape", "extra keys (invented links) are refused");
  const long = await new AiJobs({ runner: reply(JSON.stringify({ gist: "g", overview: "x".repeat(500) })) }).run({ name: "t", prompt: "p", schema, maxOutputChars: 100 });
  assert.equal(!long.ok && long.reason, "too-large");
});

test("jobs enforce the prompt cap before running", async () => {
  let ran = false;
  const r = await new AiJobs({ runner: async () => { ran = true; return { text: "{}", costUsd: 0, inputTokens: 0, outputTokens: 0 }; } }).run({ name: "t", prompt: "x".repeat(101), schema, maxPromptChars: 100 });
  assert.equal(!r.ok && r.reason, "too-large"); assert.equal(ran, false);
});

test("jobs time out and abort the runner", async () => {
  let aborted = false;
  const runner: Runner = input => new Promise(() => { input.signal.addEventListener("abort", () => { aborted = true; }); });
  const r = await new AiJobs({ runner }).run({ name: "t", prompt: "p", schema, timeoutMs: 30 });
  assert.equal(!r.ok && r.reason, "timeout"); assert.equal(aborted, true);
});

test("jobs run at most `concurrency` at a time", async () => {
  let running = 0, peak = 0;
  const runner: Runner = async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 10)); running--; return { text: "{\"gist\":\"g\",\"overview\":\"o\"}", costUsd: 0, inputTokens: 0, outputTokens: 0 }; };
  const one = new AiJobs({ runner, concurrency: 1 });
  await Promise.all([1, 2, 3].map(() => one.run({ name: "t", prompt: "p", schema })));
  assert.equal(peak, 1);
  peak = 0;
  const many = new AiJobs({ runner, concurrency: 5 });
  await Promise.all([1, 2, 3, 4].map(() => many.run({ name: "t", prompt: "p", schema })));
  assert.equal(peak, 2, "capped at two");
});

test("the claude call strips tools, MCP, settings and sessions; the envelope gives text and cost", () => {
  const args = claudeArgs({ model: "haiku", system: "S" });
  for (const flag of ["-p", "--tools", "--strict-mcp-config", "--setting-sources", "--no-session-persistence", "--disable-slash-commands", "--max-turns"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  const out = parseClaudeEnvelope(JSON.stringify({ result: "{\"a\":1}", total_cost_usd: 0.0004, usage: { input_tokens: 2, cache_creation_input_tokens: 800, output_tokens: 30 } }));
  assert.deepEqual(out, { text: "{\"a\":1}", costUsd: 0.0004, inputTokens: 802, outputTokens: 30 });
  assert.throws(() => parseClaudeEnvelope(JSON.stringify({ is_error: true, subtype: "error_max_turns" })), /error_max_turns/);
  assert.equal(parseJsonReply("no json here"), undefined);
  assert.deepEqual(parseJsonReply("Here: {\"a\":1} done"), { a: 1 });
});

// ---------- sources ----------

test("mcpproxy output: banner skipped, the map wrapper unwrapped, tool errors thrown", () => {
  const inner = JSON.stringify({ id: "HER-1", title: "Synthetic issue", status: "In Progress", priority: { value: 2, name: "High" }, dueDate: "2026-11-12", url: "https://linear.app/x/issue/HER-1/s", description: "d" });
  const stdout = `🚀 Tool Call\n━━━━\n${JSON.stringify({ content: [{ type: "text", text: `[map[text:${inner} type:text]]` }], isError: false })}`;
  const issue = parseLinearIssue(mcpproxyText(stdout));
  assert.deepEqual(issue, { title: "Synthetic issue", state: "In Progress", priority: "High", due: "2026-11-12", url: "https://linear.app/x/issue/HER-1/s", description: "d" });
  assert.throws(() => mcpproxyText(JSON.stringify({ content: [{ text: "boom" }], isError: true })), /boom/);
  assert.throws(() => mcpproxyText("Error: daemon not running"), /no result/);
  assert.equal(parseLinearIssue("Issue not found"), null);
});

test("Slack thread parsing reads JSON or the text rendering", () => {
  assert.deepEqual(parseSlackThread(JSON.stringify({ channel_name: "eng", messages: [{ real_name: "Dana Synthetic", text: "Can you look at <https://x|this>?\nmore" }] })), { channel: "eng", who: "Dana Synthetic", excerpt: "Can you look at this? more" });
  const t = parseSlackThread("=== Message from Dana Synthetic (U1) at 2026-11-09 ===\nThe query is slow again\n");
  assert.equal(t?.who, "Dana Synthetic"); assert.equal(t?.excerpt, "The query is slow again");
  assert.equal(parseSlackThread("thread_not_found"), null);
});

const fakeSources = (over: Partial<AboutSources> = {}): AboutSources => ({
  async linear(key) { return key === "HER-404" ? null : { title: `Issue ${key}`, state: "Todo", priority: "High", due: null, url: `https://linear.app/x/issue/${key}/s`, description: "desc" }; },
  async slack() { return { channel: "eng", who: "Dana Synthetic", excerpt: "ping" }; },
  async pr(repo, n) { return { title: `PR ${n}`, state: "OPEN", body: "body" }; },
  ...over,
});

test("never invent: unknown Linear keys drop, a failed source keeps the bare link and is named", async () => {
  const links = extractLinks(["HER-1 HER-404 https://acme.slack.com/archives/C1/p1731140000123456 https://github.com/a/b/pull/2"]);
  const ok = await enrichLinks(links, fakeSources());
  assert.deepEqual(ok.links.map(l => l.key), ["HER-1", "slack:C1/1731140000.123456", "a/b#2"]);
  assert.equal(ok.links[0].title, "Issue HER-1"); assert.equal(ok.links[1].who, "Dana Synthetic"); assert.deepEqual(ok.failed, []);
  const down = await enrichLinks(links, fakeSources({ async slack() { throw new Error("mcpproxy down"); }, async linear() { throw new Error("mcpproxy down"); } }));
  assert.deepEqual(down.failed.sort(), ["Linear", "Slack"]);
  const slack = down.links.find(l => l.kind === "slack")!;
  assert.equal(slack.title, null); assert.equal(slack.excerpt, null); assert.ok(slack.url);
  assert.ok(down.links.some(l => l.key === "HER-404"), "unread keys stay bare rather than dropped");
});

test("never invent: the section's fallbacks", () => {
  const empty: AboutView = { status: "idle", record: null, firstMessage: null, links: [], error: null };
  assert.equal(aboutDisplay(null, NOW).gist, null);
  assert.equal(aboutDisplay(empty, NOW).body, "none");
  assert.equal(aboutDisplay(empty, NOW).empty, NO_LINKS);
  const pending = aboutDisplay({ ...empty, status: "pending", firstMessage: "Look into the slow query" }, NOW);
  assert.equal(pending.body, "summarizing"); assert.equal(pending.excerpt, "Look into the slow query");
  const record: AboutRecord = { workspaceId: "w", inputsHash: "h", generatedAt: iso(120), gist: "Fix slow query", overview: "o", links: [], basis: { chat: true, source: "live", prs: 2, issues: ["HER-1312"] }, failed: ["Linear"], costUsd: 0.001 };
  const ready = aboutDisplay({ ...empty, status: "ready", record }, NOW);
  assert.equal(ready.gist, "Fix slow query"); assert.equal(ready.empty, NO_LINKS);
  assert.equal(ready.footer, "Summarized 2h ago from the chat, 2 PRs, HER-1312");
  assert.match(ready.failed ?? "", /^Linear couldn't be read/);
  assert.equal(aboutDisplay({ ...empty, status: "pending", record }, NOW).refreshing, true);
  assert.equal(footerText({ ...record, basis: { chat: false, source: "live", prs: 0, issues: [] } }, NOW), "Summarized 2h ago");
  assert.deepEqual(linkLine({ kind: "linear", key: "HER-1", url: null, title: "T", state: "Todo", priority: "High", due: "2026-11-12", who: null, excerpt: null }), { lead: "HER-1", title: "T", meta: ["Todo", "High", "due 2026-11-12"] });
});

// ---------- inputs and the service ----------

const items = [
  { type: "user_message", text: "Investigate why the vendor activity query is slow (HER-1312)" },
  { type: "reasoning", text: "secret thoughts" },
  { type: "tool_call", name: "Bash", status: "completed", detail: { output: "https://github.com/acme/api/pull/1352" } },
  { type: "assistant_message", text: "Opened PR #1352 with the index. Waiting on Hadar to review." },
  { type: "user_message", text: "Workspace follow-through batch 1: fix the CI" },
];

test("timeline lines keep the developer and agent words, drop reasoning and Follow-up's own messages, and keep tool output for links only", () => {
  const t = tailLines(items);
  assert.deepEqual(t.lines, ["Developer: Investigate why the vendor activity query is slow (HER-1312)", "(tool: Bash)", "Agent: Opened PR #1352 with the index. Waiting on Hadar to review."]);
  assert.ok(t.raw.some(r => r.includes("acme/api/pull/1352")));
  assert.ok(!t.lines.join("\n").includes("secret"));
});

const ctx = (over: Partial<AboutContext> = {}): AboutContext => ({ async history() { return { first: [], items, source: "live" as const }; }, async subagents() { return ["Benchmark the index"]; }, ...over });

test("the prompt is bounded and carries the inputs", async () => {
  const w = workspace({ title: "Investigate and plan database query fix", goal: "Investigate why the vendor activity query is slow (HER-1312)" });
  const inputs = await collectInputs(w, ctx({ async history() { return { first: [], items: Array.from({ length: 200 }, (_, i) => ({ type: "assistant_message", text: `step ${i} ${"x".repeat(900)}` })), source: "live" as const }; } }));
  assert.ok(inputs.tail.join("\n").length <= LIMITS.tailChars);
  assert.ok(inputs.tail.every(l => l.length <= LIMITS.itemChars + 8));
  const prompt = overviewPrompt(inputs, { issues: [{ key: "HER-1312", title: "Slow query", description: "y".repeat(5000) }], prBodies: [] });
  assert.ok(prompt.length <= LIMITS.promptChars);
  assert.match(prompt, /Investigate and plan database query fix/); assert.match(prompt, /HER-1312: Slow query/); assert.match(prompt, /Benchmark the index/);
});

async function service(over: { runner?: Runner; sources?: AboutSources; usage?: number; room?: boolean; ws?: ReturnType<typeof workspace>[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "about-"));
  let now = NOW;
  const all = over.ws ?? [workspace({ id: "w1", title: "Investigate and plan database query fix", goal: "Investigate why the vendor activity query is slow (HER-1312)", mainAgentId: "a1", prs: [] })];
  let calls = 0;
  const runner: Runner = over.runner ?? (async () => { calls++; return { text: JSON.stringify({ gist: "Fix slow vendor-activity query; PR #1352 open, waiting on Hadar.", overview: "Speeds up the vendor activity query. PR #1352 adds an index. It waits on Hadar's review." }), costUsd: 0.0012, inputTokens: 1500, outputTokens: 80 }; });
  const s = new AboutService({
    store: new AboutStore(dir), jobs: new AiJobs({ runner }), sources: over.sources ?? fakeSources(),
    workspace: async id => all.find(w => w.id === id) ?? null, context: () => ctx(),
    usage: async () => ({ accounts: [{ family: "claude", windows: [{ pct: over.usage ?? 10 }] }] }), roomForBackground: async () => over.room ?? true, now: () => now,
  });
  return { s, dir, advance: (ms: number) => { now += ms; }, calls: () => calls };
}

test("the service: collapsed reads only the cache; open writes once; unchanged inputs reuse it; refresh writes again", async () => {
  const { s, dir, calls } = await service();
  try {
    const collapsed = await s.view("w1");
    assert.equal(collapsed.status, "idle"); assert.equal(calls(), 0, "collapsed never starts a job");
    assert.equal((await s.view("w1")).firstMessage, "Investigate why the vendor activity query is slow (HER-1312)");
    const first = await s.view("w1", { open: true });
    assert.equal(first.status, "pending"); assert.equal(first.firstMessage, "Investigate why the vendor activity query is slow (HER-1312)");
    assert.ok(first.links.some(l => l.key === "HER-1312"));
    const done = await s.view("w1", { open: true, wait: true });
    assert.equal(done.status, "ready"); assert.equal(done.record?.gist, "Fix slow vendor-activity query; PR #1352 open, waiting on Hadar");
    assert.equal(done.record?.costUsd, 0.0012);
    assert.deepEqual(done.record?.links.map(l => l.key), ["HER-1312", "acme/api#1352"]);
    assert.deepEqual(done.record?.basis.issues, ["HER-1312"]);
    assert.equal(calls(), 1);
    await s.view("w1", { open: true, wait: true });
    assert.equal(calls(), 1, "same inputs, no new job");
    await s.view("w1", { open: true, refresh: true, wait: true });
    assert.equal(calls(), 2);
    assert.equal((await s.view("w1")).record?.gist, done.record?.gist, "collapsed shows the cached gist");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the service: a failed job is reported, never filled in, and retried only after the back-off", async () => {
  const { s, dir, advance } = await service({ runner: reply("I can't do that") });
  try {
    const v = await s.view("w1", { open: true, wait: true });
    assert.equal(v.status, "failed"); assert.equal(v.record, null); assert.match(v.error ?? "", /JSON/);
    assert.equal((await s.view("w1", { open: true })).status, "failed", "no retry inside the back-off");
    advance(ABOUT_RETRY_MS);
    assert.equal((await s.view("w1", { open: true })).status, "pending");
    await s.view("w1", { open: true, wait: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("background: under the daily cap, skipped above 85% usage", async () => {
  const many = Array.from({ length: DAILY_BACKGROUND_CAP + 2 }, (_, i) => workspace({ id: `w${i}`, title: `W${i}`, goal: `Goal ${i}`, mainAgentId: `a${i}` }));
  const { s, dir, calls } = await service({ ws: many });
  try {
    const r = await s.background(many.map(w => w.id));
    assert.equal(r.started, DAILY_BACKGROUND_CAP); assert.equal(r.skipped, "daily-cap"); assert.equal(calls(), DAILY_BACKGROUND_CAP);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const hot = await service({ usage: 90 });
  try {
    assert.deepEqual(await hot.s.background(["w1"]), { started: 0, skipped: "usage" }); assert.equal(hot.calls(), 0);
  } finally { await rm(hot.dir, { recursive: true, force: true }); }
  const full = await service({ room: false });
  try {
    assert.deepEqual(await full.s.background(["w1"]), { started: 0, skipped: "memory" }); assert.equal(full.calls(), 0);
  } finally { await rm(full.dir, { recursive: true, force: true }); }
});

test("workspace_about is a read-only agent tool returning the overview and links", async () => {
  const { s, dir } = await service();
  try {
    const w = workspace({ id: "w1", title: "Investigate and plan database query fix", goal: "Investigate why the vendor activity query is slow (HER-1312)", mainAgentId: "a1" });
    const actions = new AgentActions({ store: { snapshot: async () => ({ workspaces: [w] }) as never, mutate: async () => { throw new Error("read-only"); } }, prActions: {} as never, engine: {} as never, inbox: {} as never, about: s });
    assert.ok(READ_ONLY_TOOLS.includes("workspace_about"));
    const out = await actions.run("caller", "workspace_about", { workspaceId: "Investigate and plan database query fix" }) as { status: string; gist: string; links: { key: string }[] };
    assert.equal(out.status, "ready"); assert.match(out.gist, /vendor-activity/);
    assert.ok(out.links.some(l => l.key === "HER-1312"));
    await assert.rejects(actions.run("caller", "workspace_about", { workspaceId: "nope" }), /No tracked workspace/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- resources: never wake an agent, read transcripts from disk, mind memory ----------

test("an unloaded root agent's timeline is never read: its transcript on disk is, else nothing", async () => {
  let reads = 0;
  const timeline = async () => { reads++; return items; };
  const unloaded = { status: "idle" };
  const viaDisk = await rootHistory(unloaded, timeline, async () => ({ first: ["Goal"], items: [{ type: "assistant_message", text: "saved" }] }));
  assert.equal(viaDisk.source, "transcript"); assert.equal(reads, 0);
  const nothing = await rootHistory(undefined, timeline, async () => null);
  assert.equal(nothing.source, "none"); assert.equal(reads, 0);
  const broken = await rootHistory({ status: "closed", activeTurn: null }, timeline, async () => { throw new Error("EACCES"); });
  assert.equal(broken.source, "none"); assert.equal(reads, 0);
  const live = await rootHistory({ status: "idle", activeTurn: null }, timeline, async () => null);
  assert.equal(live.source, "live"); assert.equal(reads, 1);
});

test("transcripts: Claude and Codex files are found from the agent record, injected text and bad lines skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "about-tx-"));
  try {
    const roots = { paseoHome: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex") };
    const cwd = join(root, "repo"); await mkdir(cwd);
    await mkdir(join(roots.paseoHome, "agents", "proj"), { recursive: true });
    await writeFile(join(roots.paseoHome, "agents", "proj", "agent-c.json"), JSON.stringify({ id: "agent-c", provider: "claude", cwd, createdAt: "2026-11-08T10:00:00Z", persistence: { sessionId: "sess-1" } }));
    const dir = join(roots.claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sess-1.jsonl"), [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix the slow vendor query (HER-1312)" } }),
      "{not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Opened the PR." }, { type: "tool_use", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "https://github.com/acme/api/pull/7" }] } }),
      JSON.stringify({ type: "summary", whatever: true }),
    ].join("\n"));
    const claude = await readTranscript(roots.paseoHome, "agent-c", 30, roots);
    assert.deepEqual(claude?.first.map(i => i.text), ["Fix the slow vendor query (HER-1312)"]);
    assert.deepEqual(claude?.tail.map(i => i.type), ["user_message", "assistant_message", "tool_call", "tool_call"]);
    assert.match(JSON.stringify(claude?.tail), /pull\/7/);

    await writeFile(join(roots.paseoHome, "agents", "proj", "agent-x.json"), JSON.stringify({ id: "agent-x", provider: "codex", cwd, createdAt: "2026-11-08T23:59:00Z", persistence: { nativeHandle: "thread-9" } }));
    const day = join(roots.codex, "sessions", "2026", "11", "09"); await mkdir(day, { recursive: true });
    await writeFile(join(day, "rollout-2026-11-09T00-00-01-thread-9.jsonl"), [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Merge the Galway vendor domains" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Merged 3 domains." }] } }),
    ].join("\n"));
    const codex = await readTranscript(roots.paseoHome, "agent-x", 2, roots);
    assert.deepEqual(codex?.first.map(i => i.text), ["Merge the Galway vendor domains"]);
    assert.deepEqual(codex?.tail.map(i => i.type), ["tool_call", "assistant_message"], "the last `limit` items");
    assert.equal(await readTranscript(roots.paseoHome, "missing", 30, roots), null);
    assert.deepEqual(parseLine("garbage"), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("above the governor's on-demand threshold, opening serves the cache and starts nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "about-gov-"));
  try {
    let calls = 0;
    const w = workspace({ id: "w1", title: "T", goal: "G", mainAgentId: "a1", prs: [] });
    const s = new AboutService({ store: new AboutStore(dir), jobs: new AiJobs({ runner: async () => { calls++; return { text: "{}", costUsd: 0, inputTokens: 0, outputTokens: 0 }; } }), sources: fakeSources(),
      workspace: async () => w, context: () => ctx(), usage: async () => ({ accounts: [] }), roomOnDemand: async () => false });
    const v = await s.view("w1", { open: true, refresh: true, wait: true });
    assert.equal(v.status, "idle"); assert.equal(calls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the claude runner kills its whole process tree on timeout and caps stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "about-runner-"));
  try {
    const pidFile = join(dir, "child.pid");
    const hang = join(dir, "hang.sh");
    await writeFile(hang, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`); await chmod(hang, 0o755);
    const r = await new AiJobs({ runner: claudeRunner(hang) }).run({ name: "t", prompt: "p", schema, timeoutMs: 400 });
    assert.equal(!r.ok && r.reason, "timeout");
    await new Promise(res => setTimeout(res, 150));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.throws(() => process.kill(pid, 0), "the grandchild is gone too");
    const loud = join(dir, "loud.sh");
    await writeFile(loud, `#!/bin/sh\nhead -c ${MAX_STDOUT * 2} /dev/zero | tr '\\0' x\n`); await chmod(loud, 0o755);
    const big = await new AiJobs({ runner: claudeRunner(loud) }).run({ name: "t", prompt: "p", schema, timeoutMs: 10_000 });
    assert.equal(!big.ok && big.reason, "failed"); assert.match(!big.ok ? big.error : "", /output cap/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the footer names where the history came from", () => {
  const r = { generatedAt: iso(5), failed: [], basis: { chat: true, source: "transcript" as const, prs: 1, issues: [] } };
  assert.equal(footerText(r, NOW), "Summarized 5m ago from the saved transcript, 1 PR");
  assert.equal(footerText({ ...r, basis: { chat: false, source: "none" as const, prs: 0, issues: ["HER-1"] } }, NOW), "Summarized 5m ago from the goal, HER-1");
  assert.equal(footerText({ ...r, basis: { ...r.basis, source: "live" as const } }, NOW), "Summarized 5m ago from the chat, 1 PR");
});

test("an overview younger than an hour is served without reading the agent's history again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "about-fresh-"));
  try {
    let reads = 0;
    let now = NOW;
    const w = workspace({ id: "w1", title: "T", goal: "G", mainAgentId: "a1", prs: [] });
    const s = new AboutService({ store: new AboutStore(dir), jobs: new AiJobs({ runner: reply(JSON.stringify({ gist: "g line", overview: "An overview." })) }), sources: fakeSources(),
      workspace: async () => w, context: () => ctx({ async history() { reads++; return { first: [], items, source: "live" as const }; } }), usage: async () => ({ accounts: [] }), now: () => now });
    await s.view("w1", { open: true, wait: true });
    assert.equal(reads, 1);
    for (let i = 0; i < 5; i++) await s.view("w1", { open: true });
    assert.equal(reads, 1, "opening again reads nothing");
    assert.deepEqual(await s.background(["w1"]), { started: 0, skipped: null }); assert.equal(reads, 1);
    now += ABOUT_TTL_MS;
    await s.view("w1", { open: true, wait: true });
    assert.equal(reads, 2, "after the TTL it checks for changes once");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the excerpt is the developer's first message, never the workspace title repeated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "about-first-"));
  try {
    const w = workspace({ id: "w1", title: "Asset inventory filters", goal: "Asset inventory filters", mainAgentId: "a1", prs: [] });
    const make = (first: string | null) => new AboutService({ store: new AboutStore(dir), jobs: new AiJobs({ runner: reply("{}") }), sources: fakeSources(), workspace: async () => w, context: () => null, usage: async () => ({ accounts: [] }), firstMessage: async () => first });
    assert.equal((await make(null).view("w1")).firstMessage, null);
    assert.equal((await make("Add saved filters to the asset inventory.").view("w1")).firstMessage, "Add saved filters to the asset inventory.");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
