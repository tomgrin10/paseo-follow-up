import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiJobs, childEnv, type RunInput } from "../server/ai-jobs";
import { canonicalArtifactUrl, inputsHash, PLAN_ENV, planReplySchema, parseLinearIssues, parseReviewRequests, parseSlackSearch, planArgs, Ranker, RANKER_ROLE_DEFAULT, type RankSources } from "../server/ranker";
import { healthLine, inRankWindow, rankPrompt, rankWorkstream, toPriorities, type RankInputs } from "../shared/ranker";
import { PriorityStore } from "../server/priorities";
import type { WorkstreamRow } from "../shared/overseer";

const NOW = Date.parse("2026-11-10T07:30:00.000Z"); // Tuesday 09:30 in Jerusalem
const ws = (id: string, patch: Partial<WorkstreamRow> = {}): WorkstreamRow => ({
  workspaceId: id, title: `Workspace ${id}`, project: "atlas", branch: `tom/${id}`, group: "running", agentId: `a-${id}`, agentStatus: "idle", prs: [], ask: null, askKind: null,
  activity: null, activityAt: new Date(NOW).toISOString(), priority: null, keys: [], dormant: false, ...patch,
});
const ROWS = [
  ws("scim", { title: "Okta SCIM sync", keys: ["HER-1312"], group: "needs", ask: "Pick A or B for nested groups" }),
  ws("export", { title: "Vendor risk CSV export", keys: ["HER-1425"] }),
  ws("old", { title: "Old spike", dormant: true, group: "quiet" }),
];
const LINEAR = [
  { key: "HER-1312", title: "SCIM nested groups", priority: "Urgent", status: "In Progress", due: "2026-11-10", project: "Identity", milestone: "Okta GA", url: "https://linear.app/x/issue/HER-1312" },
  { key: "HER-1500", title: "Audit log retention", priority: "High", status: "Todo", due: null, project: null, milestone: null, url: "https://linear.app/x/issue/HER-1500" },
];
const reply = (over: object = {}) => JSON.stringify({
  priorities: [
    { workspace: "export", score: 60, reason: "Review requested by Avi", sources: [{ kind: "github", label: "#1425", url: "https://evil.example/x" }] },
    { workspace: "scim", score: 40, reason: "HER-1312 · Urgent · due today\nsecond line", sources: [{ kind: "linear", label: "HER-1312", url: "https://linear.app/x/issue/HER-1312" }] },
    { workspace: "ghost", score: 99, reason: "made up", sources: [] },
  ],
  notStarted: [{ key: "HER-1500", title: "Audit log retention", reason: "High, no workspace yet" }, { key: "HER-1312", title: "dup", reason: "covered" }, { key: "HER-9999", title: "invented", reason: "x" }],
  ...over,
});

function fixture(t: any, opts: { sources?: Partial<RankSources>; reply?: () => string; rows?: WorkstreamRow[]; role?: Partial<typeof RANKER_ROLE_DEFAULT>; planningUrl?: string | null } = {}) {
  const calls: RunInput[] = []; const reads: Record<string, number> = { linear: 0, slack: 0, github: 0, planning: 0 };
  let now = NOW;
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ranker-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const jobs = new AiJobs({ runner: async input => { calls.push(input); return { text: (opts.reply ?? reply)(), costUsd: 0.012, inputTokens: 3000, outputTokens: 400 }; } });
    const priorities = new PriorityStore(dir);
    const sources: RankSources = {
      async linear() { reads.linear++; return LINEAR; },
      async slack() { reads.slack++; return [{ where: "DM with Tom", who: "Dana Levi", text: "can you look at the SCIM PR?", at: "2026-11-10 09:00" }]; },
      async github() { reads.github++; return [{ repo: "hero/app", number: 1425, title: "Vendor risk CSV export", url: "https://github.com/hero/app/pull/1425", author: "avi" }]; },
      async planning() { reads.planning++; return { title: "Week 46", url: "https://claude.ai/artifact/abc", items: [{ level: "milestone", title: "Okta GA", keys: ["HER-1312"] }] }; },
      ...opts.sources,
    };
    let rows = opts.rows ?? ROWS;
    const ranker = new Ranker({ directory: dir, jobs, sources, priorities, workstreams: async () => rows, role: async () => ({ ...RANKER_ROLE_DEFAULT, ...opts.role }), enabled: async () => true,
      planningUrl: async () => opts.planningUrl === undefined ? "https://claude.ai/artifact/abc" : opts.planningUrl, now: () => now });
    return { dir, ranker, priorities, calls, reads, setNow: (n: number) => { now = n; }, setRows: (r: WorkstreamRow[]) => { rows = r; } };
  })();
}

test("ranker: set_priorities from the ranker stores its ranking, replacing the last one, with sources it can vouch for", async t => {
  const f = await fixture(t);
  await f.priorities.write([{ workspaceId: "stale", score: 5, reason: "old", sources: [], at: new Date(NOW - 3_600_000).toISOString(), by: "ranker" }], false);
  const r = await f.ranker.run({ trigger: "manual" });
  assert.equal(r.ok, true); assert.equal(r.skipped, null); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, "sonnet", "the model comes from the ranker role, not the call site");
  const stored = await f.priorities.read();
  assert.deepEqual(stored.map(p => [p.workspaceId, p.score]), [["export", 60], ["scim", 40]], "the model's scores as given; unknown workspace and the stale one gone");
  const scim = stored.find(p => p.workspaceId === "scim")!;
  assert.equal(scim.reason, "HER-1312 · Urgent · due today", "one line");
  assert.equal(scim.by, "ranker");
  assert.equal(stored.find(p => p.workspaceId === "export")!.sources[0].url, undefined, "a url the material didn't have is dropped");
  assert.equal(scim.sources[0].url, "https://linear.app/x/issue/HER-1312");
  assert.deepEqual(r.notStarted.map(n => n.key), ["HER-1500"], "only real, uncovered Linear issues");
  assert.deepEqual(r.dropped, ["ghost"]);
  assert.equal(r.priorities.find(p => p.workspaceId === "scim")!.title, "Okta SCIM sync");
  assert.equal(r.costUsd, 0.012);
});

test("ranker: a dry run reads and ranks but writes nothing", async t => {
  const f = await fixture(t);
  const r = await f.ranker.run({ trigger: "manual", dryRun: true });
  assert.equal(r.ok, true); assert.equal(r.priorities.length, 2);
  await assert.rejects(stat(join(f.dir, "priorities.json")), "no priorities written");
  await assert.rejects(stat(join(f.dir, "ranker.json")), "no ranker state written");
});

test("ranker: unchanged inputs skip the model; a change calls it again", async t => {
  const f = await fixture(t);
  await f.ranker.run({ trigger: "schedule" });
  f.setNow(NOW + 3_600_000);
  const again = await f.ranker.run({ trigger: "schedule" });
  assert.equal(again.skipped, "same"); assert.equal(f.calls.length, 1, "no second model call");
  assert.equal(again.priorities.length, 2, "it still reports the standing ranking");
  // Activity time and Follow-up's own priority don't count as a change.
  f.setRows(ROWS.map(r => ({ ...r, activityAt: new Date(NOW + 999).toISOString(), priority: { score: 1, reason: "x" } })));
  assert.equal((await f.ranker.run({ trigger: "schedule" })).skipped, "same");
  f.setRows([...ROWS, ws("new", { title: "Brand new" })]);
  assert.equal((await f.ranker.run({ trigger: "schedule" })).skipped, null); assert.equal(f.calls.length, 2);
  // A forced run (Re-rank now with force) calls it even when nothing changed.
  await f.ranker.run({ trigger: "manual", force: true }); assert.equal(f.calls.length, 3);
});

test("ranker: unchanged rankings are re-stamped before Home's 6-hour freshness runs out", async t => {
  const f = await fixture(t);
  await f.ranker.run({ trigger: "schedule" });
  const first = (await f.priorities.read())[0].at;
  f.setNow(NOW + 5 * 3_600_000);
  assert.equal((await f.ranker.run({ trigger: "schedule" })).skipped, "same");
  assert.ok((await f.priorities.read())[0].at > first); assert.equal(f.calls.length, 1);
});

test("ranker: the daily cap and the cadence bound scheduled runs; Re-rank now still runs", async t => {
  let n = 0;
  const f = await fixture(t, { role: { dailyCap: 1, cadenceMinutes: 60 }, sources: { async linear() { n++; return [{ ...LINEAR[0], title: `changed ${n}` }]; } } });
  assert.equal((await f.ranker.tick())?.skipped, null);
  f.setNow(NOW + 30 * 60_000); assert.equal(await f.ranker.tick(), null, "within the cadence");
  f.setNow(NOW + 61 * 60_000); assert.equal((await f.ranker.tick())?.skipped, "cap");
  assert.equal(f.calls.length, 1);
  assert.equal((await f.ranker.run({ trigger: "manual" })).skipped, null, "the developer's click isn't capped"); assert.equal(f.calls.length, 2);
  f.setNow(Date.parse("2026-11-13T09:00:00.000Z")); assert.equal(await f.ranker.tick(), null, "Friday: no automatic run");
});

test("ranker: a failing source is reported, not fatal; the plan is read once a day", async t => {
  const f = await fixture(t, { sources: { async slack() { throw new Error("mcpproxy down"); } } });
  const r = await f.ranker.run({ trigger: "manual" });
  assert.equal(r.ok, true); assert.equal(r.health.slack, "failed"); assert.equal(r.healthLine, "Slack unavailable");
  assert.match(f.calls[0].prompt, /SLACK[^\n]*:\n\(none\)/);
  assert.match(f.calls[0].prompt, /milestone · Okta GA · HER-1312/);
  f.setNow(NOW + 2 * 3_600_000); await f.ranker.run({ trigger: "manual", force: true });
  assert.equal(f.reads.planning, 1, "cached for a day");
  assert.equal((await f.ranker.status()).healthLine, "Slack unavailable");
  const off = await fixture(t, { planningUrl: null });
  assert.equal((await off.ranker.run({ trigger: "manual" })).healthLine, "Plan off");
  assert.equal(off.reads.planning, 0);
});

test("ranker: one run at a time; a second call joins the first", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.ranker.run({ trigger: "manual" }), f.ranker.run({ trigger: "overseer" })]);
  assert.equal(a.skipped, null); assert.equal(b.skipped, "busy"); assert.equal(f.calls.length, 1);
});

test("rank inputs: the hash ignores order, the prompt stays inside its cap and drops resting workstreams first", () => {
  const inputs: RankInputs = { workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null };
  assert.equal(inputsHash(inputs), inputsHash({ ...inputs, workstreams: [...inputs.workstreams].reverse(), linear: [...LINEAR].reverse() }));
  assert.notEqual(inputsHash(inputs), inputsHash({ ...inputs, linear: [{ ...LINEAR[0], priority: "Low" }, LINEAR[1]] }));
  const big: RankInputs = { ...inputs, workstreams: Array.from({ length: 150 }, (_, i) => rankWorkstream(ws(`w${i}`, { title: `HER-${i} ${"long title ".repeat(8)}`, dormant: i >= 40 }))) };
  const full = rankPrompt(big, "2026-11-10", 1_000_000);
  const capped = rankPrompt(big, "2026-11-10", 8000);
  assert.ok(full.length > 8000); assert.ok(capped.length <= 8000, `${capped.length}`);
  assert.ok(capped.includes("w0 ·") && !capped.includes("· resting ·"), "resting ones go first");
});

test("rank reply: unknown workspaces, duplicates and invented keys never reach Home", () => {
  const inputs: RankInputs = { workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null };
  const { priorities } = toPriorities({ priorities: [{ workspace: "scim", score: 10, reason: "a", sources: [] }, { workspace: "scim", score: 90, reason: "b", sources: [] }], notStarted: [] }, inputs, new Date(NOW).toISOString());
  assert.deepEqual(priorities.map(p => [p.workspaceId, p.score, p.reason]), [["scim", 10, "a"]]);
});

test("rank window: Sunday to Thursday, 08:00–20:00 Jerusalem time", () => {
  assert.equal(inRankWindow(Date.parse("2026-11-08T06:30:00Z")), true, "Sunday 08:30");
  assert.equal(inRankWindow(Date.parse("2026-11-08T05:30:00Z")), false, "Sunday 07:30");
  assert.equal(inRankWindow(Date.parse("2026-11-12T18:30:00Z")), false, "Thursday 20:30");
  assert.equal(inRankWindow(Date.parse("2026-11-14T09:00:00Z")), false, "Saturday");
  assert.equal(healthLine({ linear: "ok", slack: "ok", github: "ok", planning: "ok" }), "");
});

test("sources: Linear, Slack and GitHub parse tolerantly; the plan reader may only use the Artifact tool", () => {
  const lin = parseLinearIssues(JSON.stringify({ issues: [
    { id: "HER-1", title: "One", priority: { value: 1, name: "Urgent" }, dueDate: "2026-11-10", status: "In Progress", statusType: "started", project: { name: "Identity" }, url: "https://linear.app/i/HER-1" },
    { id: "HER-2", title: "Done one", statusType: "completed" }, { title: "no id" }, { id: "HER-3", title: "Three", priority: { value: 0, name: "No priority" } },
  ] }));
  assert.deepEqual(lin.map(i => [i.key, i.priority, i.project]), [["HER-1", "Urgent", "Identity"], ["HER-3", null, null]]);
  assert.deepEqual(parseLinearIssues("not json"), []);
  const slack = parseSlackSearch(JSON.stringify({ results: "1. DM with Tom, Dana Levi - Dana Levi: can you look at the SCIM PR?… 2026-11-09 18:12:18 IST\n2. DM with Tom, GitHub - GitHub: Review completed. 2026-11-09 18:12:16 IST\n3. #dev, Tom Gringauz - Tom Gringauz: on it 2026-11-09 18:00:00 IST\n" }), "Tom Gringauz");
  assert.deepEqual(slack, [{ where: "DM with Tom", who: "Dana Levi", text: "can you look at the SCIM PR?", at: "2026-11-09 18:12:18 IST" }], "bots and Tom's own messages dropped");
  assert.deepEqual(parseReviewRequests(JSON.stringify([{ number: 7, title: "Fix", url: "https://github.com/a/b/pull/7", repository: { nameWithOwner: "a/b" }, author: { login: "dana" } }, { title: "no number" }])).map(r => `${r.repo}#${r.number}`), ["a/b#7"]);
  assert.equal(canonicalArtifactUrl("https://claude.ai/artifact/Piy123?share=SECRET#x"), "https://claude.ai/artifact/Piy123", "no share key travels");
  assert.equal(canonicalArtifactUrl("https://evil.example/artifact/x"), null);
  const args = planArgs({ prompt: "", system: "s", provider: "claude", model: "sonnet", thinking: null, timeoutMs: 1, signal: new AbortController().signal });
  assert.equal(args[args.indexOf("--tools") + 1], "Artifact"); assert.equal(args[args.indexOf("--allowedTools") + 1], "Artifact");
  assert.ok(args.includes("--strict-mcp-config"), "no MCP servers");
});

test("plan reader: the Artifact tool's env survives the no-nonessential-traffic default, and flattened replies still parse", () => {
  const env = childEnv(PLAN_ENV);
  assert.equal(env.CLAUDE_CODE_ARTIFACT, "1");
  assert.equal("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in env, false, "Claude Code drops the Artifact tool when nonessential traffic is off");
  assert.equal(childEnv().CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "other jobs keep it off");
  const parsed = planReplySchema.parse({ title: "Week 46", items: ["HER-1312 Okta SCIM GA this week", { level: "milestone", title: "Compliance exports", keys: ["HER-1431"] }, 42] });
  assert.deepEqual(parsed.items, [{ level: "item", title: "HER-1312 Okta SCIM GA this week", keys: ["HER-1312"] }, { level: "milestone", title: "Compliance exports", keys: ["HER-1431"] }]);
});

test("rank reply: reasons never repeat the source chip, and no outside signal means no line", () => {
  const inputs: RankInputs = { workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null };
  const { priorities } = toPriorities({ priorities: [
    { workspace: "export", score: 80, reason: "Slack: Dana asked twice", sources: [{ kind: "slack", label: "Dana" }] },
    { workspace: "scim", score: 30, reason: "", sources: [{ kind: "paseo", label: "Activity" }] },
  ], notStarted: [] }, inputs, new Date(NOW).toISOString());
  assert.equal(priorities[0].reason, "Dana asked twice");
  assert.deepEqual([priorities[1].reason, priorities[1].sources], ["", []], "scored, but nothing to show");
});

test("ranker: the ranker role picks the provider, model and effort (Settings → Agents)", async t => {
  const f = await fixture(t, { role: { provider: "codex", model: "gpt-5.5", thinking: "high" } });
  await f.ranker.run({ trigger: "manual" });
  assert.deepEqual([f.calls[0].provider, f.calls[0].model, f.calls[0].thinking], ["codex", "gpt-5.5", "high"]);
});

test("ranker: with no outside source readable it skips the model (no logins, an isolated daemon)", async t => {
  const fail = async () => { throw new Error("not logged in"); };
  const f = await fixture(t, { sources: { linear: fail, slack: fail, github: fail, planning: fail } });
  const r = await f.ranker.run({ trigger: "schedule" });
  assert.equal(r.skipped, "sources"); assert.equal(f.calls.length, 0);
  assert.equal(r.healthLine, "Linear unavailable · Slack unavailable · GitHub unavailable · Plan unavailable");
  assert.equal(await f.ranker.tick(), null, "and waits for the cadence before trying again");
});
