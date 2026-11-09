import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiJobs, childEnv, type RunInput } from "../server/ai-jobs";
import { canonicalArtifactUrl, ghAccounts, inputsHash, liveRankSources, parseLinearPage, PLAN_ENV, planReplySchema, rankKey, salvageArray, parseLinearIssues, parseReviewRequests, parseSlackSearch, planArgs, Ranker, RANKER_ROLE_DEFAULT, type RankSources } from "../server/ranker";
import { damped, emptyReasons, healthLine, inRankWindow, paseoReason, rankCost, rankPrompt, reasonInputs, workspaceInputs, RANK_SYSTEM, rankWorkstream, toPriorities, type RankInputs } from "../shared/ranker";
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

function fixture(t: any, opts: { sources?: Partial<RankSources>; reply?: () => string; rows?: WorkstreamRow[]; role?: Partial<typeof RANKER_ROLE_DEFAULT>; planningUrl?: string | null; log?: (line: string) => void } = {}) {
  const calls: RunInput[] = []; const reads: Record<string, number> = { linear: 0, slack: 0, github: 0, planning: 0 };
  let now = NOW;
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ranker-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const jobs = new AiJobs({ runner: async input => { calls.push(input); return { text: (opts.reply ?? reply)(), costUsd: 0.012, inputTokens: 3000, outputTokens: 400 }; } });
    const priorities = new PriorityStore(dir);
    const sources: RankSources = {
      async linear() { reads.linear++; return LINEAR; },
      async slack() { reads.slack++; return [{ where: "DM with Tom", who: "Dana Levi", text: "can you look at the SCIM PR?", at: "2026-11-10 09:00" }]; },
      async github() { reads.github++; return [{ repo: "acme/app", number: 1425, title: "Vendor risk CSV export", url: "https://github.com/acme/app/pull/1425", author: "avi" }]; },
      async planning() { reads.planning++; return { title: "Week 46", url: "https://claude.ai/artifact/abc", items: [{ level: "milestone", title: "Okta GA", keys: ["HER-1312"] }] }; },
      ...opts.sources,
    };
    let rows = opts.rows ?? ROWS;
    const ranker = new Ranker({ directory: dir, jobs, sources, priorities, workstreams: async () => rows, role: async () => ({ ...RANKER_ROLE_DEFAULT, ...opts.role }), enabled: async () => true,
      planningUrl: async () => opts.planningUrl === undefined ? "https://claude.ai/artifact/abc" : opts.planningUrl, now: () => now, log: opts.log ?? (() => {}) });
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
  const logged: string[] = [];
  const f = await fixture(t, { sources: { async slack() { throw new Error("mcpproxy down"); } }, log: l => logged.push(l) });
  const r = await f.ranker.run({ trigger: "manual" });
  assert.equal(r.ok, true); assert.equal(r.health.slack, "failed"); assert.equal(r.healthLine, "Slack unavailable");
  assert.deepEqual(logged, ["[follow-up] ranker: slack read failed: mcpproxy down"], "the daemon log says why");
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
  const { priorities } = toPriorities({ priorities: [{ workspace: "scim", score: 10, reason: "first one", sources: [] }, { workspace: "scim", score: 90, reason: "second one", sources: [] }], notStarted: [] }, inputs, new Date(NOW).toISOString());
  assert.deepEqual(priorities.map(p => [p.workspaceId, p.score, p.reason]), [["scim", 10, "first one"]]);
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

test("rank reply: reasons never repeat the source chip, and a reply without one gets the workspace's own fact", () => {
  const inputs: RankInputs = { workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null };
  const { priorities } = toPriorities({ priorities: [
    { workspace: "export", score: 80, reason: "Slack: Dana asked twice", sources: [{ kind: "slack", label: "Dana" }] },
    { workspace: "scim", score: 30, reason: "", sources: [{ kind: "paseo", label: "Activity" }] },
  ], notStarted: [] }, inputs, new Date(NOW).toISOString());
  assert.equal(priorities[0].reason, "Dana asked twice");
  assert.deepEqual([priorities[1].reason, priorities[1].sources], ["Pick A or B for nested groups", [{ kind: "paseo", label: "Paseo" }]], "never an empty line: its open ask");
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

// ---------- fix/ranker-codex ----------

test("codex fix 1: changing the ranker's provider, model or effort re-ranks even when the inputs didn't change", async t => {
  const inputs: RankInputs = { workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null };
  const sonnet = { provider: "claude", model: "sonnet", thinking: null };
  assert.equal(rankKey(inputs, sonnet), rankKey(inputs, { ...sonnet }));
  assert.notEqual(rankKey(inputs, sonnet), rankKey(inputs, { provider: "codex", model: "gpt-6.1-sol", thinking: "low" }));
  assert.notEqual(rankKey(inputs, { provider: "codex", model: "gpt-6.1-sol", thinking: "low" }), rankKey(inputs, { provider: "codex", model: "gpt-6.1-sol", thinking: "medium" }));
  let role = { provider: "claude", model: "sonnet", thinking: null as string | null };
  const f = await fixture(t, { role: { get provider() { return role.provider; }, get model() { return role.model; }, get thinking() { return role.thinking; } } });
  await f.ranker.run({ trigger: "schedule" });
  role = { provider: "codex", model: "gpt-6.1-sol", thinking: "low" };
  const again = await f.ranker.run({ trigger: "schedule" });
  assert.equal(again.skipped, null, "not 'same': a different model ranks"); assert.equal(f.calls.length, 2);
});

test("codex fix 2: empty reasons get one small follow-up for just those workspaces; still empty falls back to Paseo's fact", async t => {
  const many = [...ROWS.slice(0, 2), ...Array.from({ length: 8 }, (_, i) => ws(`w${i}`, { title: `Workspace ${i}`, prs: [{ key: `a/b#${700 + i}`, number: 700 + i, state: "OPEN", checks: i === 3 ? "failed" : "passed", threads: 0, url: null }] }))];
  let n = 0;
  const first = JSON.stringify({ priorities: many.map((w, i) => ({ workspace: w.workspaceId, score: 90 - i * 5, reason: i < 2 ? "Dana asked twice" : "", sources: [] })), notStarted: [] });
  const f = await fixture(t, { rows: many, role: { provider: "codex", model: "gpt-6.1-sol", thinking: "low" }, reply: () => n++ === 0 ? first
    : JSON.stringify({ reasons: many.slice(2, 9).map(w => ({ workspace: w.workspaceId, reason: `Fact about ${w.title}`, sources: [] })) }) });
  const r = await f.ranker.run({ trigger: "manual" });
  assert.equal(f.calls.length, 2, "one ranking call, one reasons call");
  assert.match(f.calls[0].system, /every object in "priorities" has a "reason"/, "non-Claude models get the reason rule restated");
  const retry = f.calls[1];
  assert.match(retry.system, /write the one-line reason/);
  for (const w of many.slice(0, 2)) assert.ok(!retry.prompt.includes(`${w.workspaceId} ·`), "workspaces that had a reason aren't sent again");
  for (const w of many.slice(2)) assert.ok(retry.prompt.includes(`${w.workspaceId} ·`));
  assert.ok(retry.prompt.length < f.calls[0].prompt.length);
  const by = new Map(r.priorities.map(p => [p.workspaceId, p]));
  assert.equal(by.get("w0")!.reason, "Fact about Workspace 0", "filled from the follow-up");
  assert.equal(by.get("w0")!.score, 80, "the first reply's score stands");
  assert.equal(by.get("w7")!.reason, "#707 open", "the follow-up skipped it too: Paseo's own fact");
  assert.ok(r.priorities.every(p => p.reason.length >= 3), "no ranked workspace without a reason");
  assert.equal((await f.ranker.state()).last?.retried, true);
  assert.deepEqual(emptyReasons({ priorities: [{ workspace: "scim", score: 1, reason: "n/a", sources: [] }, { workspace: "export", score: 1, reason: "-", sources: [] }], notStarted: [] }, { workstreams: ROWS.map(rankWorkstream), linear: [], slack: [], github: [], planning: null }), ["scim", "export"]);
  assert.equal(paseoReason(rankWorkstream(ws("x", { prs: [{ key: "a/b#9", number: 9, state: "OPEN", checks: "failed", threads: 0, url: null }] }))), "#9 checks failed");
  const reduced = reasonInputs({ workstreams: ROWS.map(rankWorkstream), linear: LINEAR, slack: [], github: [], planning: null }, ["export"]);
  assert.deepEqual([reduced.workstreams.map(w => w.id), reduced.linear.map(i => i.key)], [["export"], []], "only its own material");
});

test("codex fix 2: Claude replies with every reason make no second call", async t => {
  const f = await fixture(t);
  await f.ranker.run({ trigger: "manual" });
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.calls[0].system, /every object in "priorities" has a "reason"/);
});

test("codex fix 3: rank-now starts the run and returns at once; status shows it running, then its outcome", async t => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = await fixture(t, { sources: { async linear() { await gate; return LINEAR; } } });
  assert.deepEqual(f.ranker.start({ trigger: "manual", force: true }), { started: true });
  assert.deepEqual(f.ranker.start({ trigger: "manual" }), { started: false }, "joins, never doubles");
  assert.equal((await f.ranker.status()).running, true);
  release();
  for (let i = 0; i < 50 && (await f.ranker.status()).running; i++) await new Promise(r => setTimeout(r, 10));
  const st = await f.ranker.status();
  assert.equal(st.running, false); assert.equal(st.last?.ok, true); assert.equal(st.last?.top, "Vendor risk CSV export", "the new top row, for the toast");
  assert.equal(st.last?.provider, "claude");
});

test("codex fix: the header says the Codex subscription instead of a price, dollars for Claude, nothing before a model run", () => {
  assert.equal(rankCost({ costUsd: null, last: { ok: true, skipped: null, provider: "codex" } }), "last run on Codex subscription");
  assert.equal(rankCost({ costUsd: 0.0564, last: { ok: true, skipped: null, provider: "claude" } }), "last run $0.06");
  assert.equal(rankCost({ costUsd: 0.004, last: { ok: true, skipped: null, provider: "claude" } }), "last run <$0.01");
  assert.equal(rankCost({ costUsd: 0.0564, last: { ok: true, skipped: "same", provider: "claude" } }), "last run $0.06", "a skipped run keeps showing the standing ranking's cost");
  assert.equal(rankCost({ costUsd: null, last: { ok: true, skipped: "sources", provider: null } }), "", "no model run yet");
  assert.equal(rankCost(null), "");
});

test("codex fix 4: a workspace whose own inputs didn't change moves at most 10 points; one with news moves freely", async t => {
  let n = 0;
  const f = await fixture(t, { rows: [ws("a", { title: "Alpha", keys: ["HER-1"] }), ws("b", { title: "Beta", keys: ["HER-2"] })],
    reply: () => JSON.stringify({ priorities: n++ === 0 ? [{ workspace: "a", score: 85, reason: "Plan milestone this week", sources: [] }, { workspace: "b", score: 40, reason: "Quiet for days now", sources: [] }]
      : [{ workspace: "a", score: 48, reason: "Plan milestone this week", sources: [] }, { workspace: "b", score: 90, reason: "Uri asked for a review", sources: [] }], notStarted: [] }) });
  await f.ranker.run({ trigger: "manual" });
  const second = await f.ranker.run({ trigger: "manual", force: true });
  const by = new Map(second.priorities.map(p => [p.workspaceId, p.score]));
  assert.equal(by.get("a"), 75, "85 → 48 held to 75: nothing about it changed");
  assert.equal(by.get("b"), 50, "b's own inputs didn't change either: 40 → at most 50");
  assert.match(f.calls[1].prompt, /PREVIOUS RANKING \(id · score\):\na · 85\nb · 40/, "the model sees the last ranking");
  // News for b (a Slack line naming its key): it may move freely.
  const inputs: RankInputs = { workstreams: [rankWorkstream(ws("b", { keys: ["HER-2"] }))], linear: [], slack: [], github: [], planning: null };
  const withNews = { ...inputs, slack: [{ where: "DM", who: "Uri", text: "HER-2 needs your review today", at: null }] };
  assert.notEqual(workspaceInputs(inputs.workstreams[0], inputs), workspaceInputs(inputs.workstreams[0], withNews));
  assert.equal(workspaceInputs(inputs.workstreams[0], inputs), workspaceInputs(inputs.workstreams[0], { ...inputs, slack: [{ where: "DM", who: "Avi", text: "lunch?", at: null }] }), "unrelated Slack isn't news for it");
  const out = damped([{ workspaceId: "b", score: 90 }], new Map([["b", { score: 40, fp: "old" }]]), new Map([["b", "new"]]));
  assert.equal(out[0].score, 90);
});

test("codex fix 5: the prompt weighs direct asks to Tom at least as much as plan milestones", () => {
  assert.match(RANK_SYSTEM, /Direct asks to the developer weigh at least as much as this week's plan milestones/);
  assert.match(RANK_SYSTEM, /Never rank a plan item above a direct ask of similar urgency/);
});

test("sources: a Linear reply mcpproxy cut off keeps its whole issues, pages of 25 follow the cursor, and an unreadable reply fails", async () => {
  const issue = (n: number) => ({ id: `HER-${n}`, title: `Issue ${n} with a "quoted" {brace} title`, priority: { value: 2, name: "High" }, statusType: "started", url: `https://linear.app/x/issue/HER-${n}` });
  const full = JSON.stringify({ issues: [issue(1), issue(2), issue(3)], hasNextPage: false });
  const cut = full.slice(0, full.indexOf("HER-3") + 10) + "\n\n... [truncated]";
  assert.deepEqual(salvageArray(cut, "issues").map((i: any) => i.id), ["HER-1", "HER-2"]);
  assert.deepEqual(parseLinearPage(cut).issues.map(i => i.key), ["HER-1", "HER-2"], "the cut one is dropped, the whole ones kept");
  assert.equal(parseLinearPage(JSON.stringify({ issues: [issue(4)], hasNextPage: true, cursor: "c2" })).next, "c2");
  const calls: string[] = [];
  const wrap = (o: unknown) => `banner\n${JSON.stringify({ content: [{ text: `[map[text:${JSON.stringify(o)} type:text]]` }], isError: false })}`;
  const run = async (_c: string, args: string[]) => {
    const a = JSON.parse(args.find(x => x.startsWith("--json_args="))!.slice(12)); calls.push(a.cursor ?? "first");
    return wrap(a.cursor ? { issues: [issue(9)], hasNextPage: false } : { issues: [issue(8)], hasNextPage: true, cursor: "p2" });
  };
  const src = liveRankSources(new AiJobs(), { run, slackUser: null });
  assert.deepEqual((await src.linear()).map(i => i.key), ["HER-8", "HER-9"]);
  assert.deepEqual(calls, ["first", "p2"]);
  const bad = liveRankSources(new AiJobs(), { run: async () => wrap("Internal error: rate limited"), slackUser: null });
  await assert.rejects(bad.linear(), /couldn't be read/, "health says failed, not ok with nothing");
});

test("sources: review requests come from every logged-in gh account, each with its own token", async () => {
  assert.deepEqual(ghAccounts("✓ Logged in to github.com account tomgrin10 (keyring)\n  - Active account: true\n✓ Logged in to github.com account work-account (keyring)"), ["tomgrin10", "work-account"]);
  const searches: (string | undefined)[] = [];
  const run = async (_c: string, args: string[], _t: number, env?: Record<string, string>) => {
    if (args[0] === "auth" && args[1] === "status") return "Logged in to github.com account personal\nLogged in to github.com account work";
    if (args[0] === "auth" && args[1] === "token") return `token-${args.at(-1)}\n`;
    searches.push(env?.GH_TOKEN);
    return JSON.stringify(env?.GH_TOKEN === "token-work" ? [{ number: 7, title: "Review me", url: "https://github.com/w/r/pull/7", repository: { nameWithOwner: "w/r" }, author: { login: "uri" } }] : []);
  };
  const reviews = await liveRankSources(new AiJobs(), { run, slackUser: null }).github();
  assert.deepEqual(searches, ["token-personal", "token-work"]);
  assert.deepEqual(reviews.map(r => `${r.repo}#${r.number}`), ["w/r#7"], "the work account's request is found");
  // The work account is rate-limited: nothing found plus a failed account reads as failed, not as "no requests".
  const limited = async (c: string, args: string[], t: number, env?: Record<string, string>) => { if (env?.GH_TOKEN === "token-work") throw new Error("API rate limit already exceeded"); return run(c, args, t, env); };
  await assert.rejects(liveRankSources(new AiJobs(), { run: limited, slackUser: null }).github(), /couldn't search/);
});

test("sources: review requests read from REST search (items with html_url and repository_url)", () => {
  const rest = { total_count: 1, items: [{ number: 1579, title: "Pipeline health", html_url: "https://github.com/o/r/pull/1579", repository_url: "https://api.github.com/repos/o/r", user: { login: "yuval" } }] };
  assert.deepEqual(parseReviewRequests(JSON.stringify(rest)), [{ repo: "o/r", number: 1579, title: "Pipeline health", url: "https://github.com/o/r/pull/1579", author: "yuval" }]);
});

test("sources: a plan read that comes back empty counts as failed", async () => {
  const jobs = new AiJobs({ runner: async () => ({ text: JSON.stringify({ title: "Week", items: [] }), costUsd: 0.01, inputTokens: 1, outputTokens: 1 }) });
  await assert.rejects(liveRankSources(jobs, { run: async () => "", slackUser: null }).planning("https://claude.ai/artifact/x"), /came back empty/);
});
