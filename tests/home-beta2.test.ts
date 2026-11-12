import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHome, homeCounts, type PaseoWorkspaceLite } from "../shared/home";
import type { InboxRow, Reason } from "../shared/inbox";
import type { State, Workspace } from "../shared/model";
import { followsByDefault, migrateFollowEvery, FOLLOW_EVERY_MIGRATION } from "../shared/settings";
import { applyDiscovery } from "../server/discovery";
import { homeSearchDocs, indexDocs, omniboxResults, search, tokenMatch, withinOneEdit, workspaceProvider, type OmniboxProvider } from "../shared/search";
import { SORT_MODES, type SortMode } from "../shared/sort";
import { freshPriorities, mergePriorities, priorityNote, PRIORITY_FRESH_MS, type Priority } from "../shared/priorities";
import { fromAccountRows, fromBudget, fromSubscriptions, meters, meterText, toneOf, type Usage } from "../shared/usage";
import { UsageReader } from "../server/usage";
import { AgentActions } from "../server/agent-actions";
import { pr, snapshot, workspace } from "./fixtures";

const NOW = Date.parse("2026-11-09T09:50:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (agentId: string, patch: Partial<InboxRow> = {}): InboxRow => ({
  agentId, workspaceId: `w-${agentId}`, title: "Main", workspaceTitle: `Workspace ${agentId}`, multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: at(5), needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, brief: null, ...patch,
});
const flagged = (agentId: string, reason: Reason, minutesAgo: number, patch: Partial<InboxRow> = {}) =>
  row(agentId, { needs: { reasons: [{ reason, at: at(minutesAgo), detail: `${reason} detail`, dedupeKey: reason }], since: at(minutesAgo) }, ...patch });
const ws = (id: string, patch: Partial<Workspace> = {}) => workspace({ id, title: `Tracked ${id}`, mainAgentId: `agent-${id}`, updatedAt: at(60), prs: [], ...patch });
const lite = (id: string, patch: Partial<PaseoWorkspaceLite> = {}): PaseoWorkspaceLite => ({ id, name: id, project: "atlas", activityAt: at(300), ...patch });

// ---------- tracking becomes invisible ----------

test("first load follows every known workspace with auto-send on, once, leaving archived and opted-out ones alone", () => {
  const state: State = { version: 1, workspaces: [
    ws("a", { enable_tracking: false, enable_auto_sends: false }),
    ws("b", { enable_tracking: true, enable_auto_sends: false }),
    ws("c", { enable_tracking: true, enable_auto_sends: true }),
    ws("old", { archived: true, enable_tracking: false }),
    ws("out", { enable_tracking: false }),
  ], workspaceOptOuts: ["out"] };
  assert.deepEqual(migrateFollowEvery(state), { tracked: 1, autoSends: 2 });
  const by = (id: string) => state.workspaces.find(w => w.id === id)!;
  assert.ok(["a", "b", "c"].every(id => by(id).enable_tracking && by(id).enable_auto_sends));
  assert.equal(by("old").enable_tracking, false); assert.equal(by("out").enable_tracking, false);
  assert.deepEqual(state.migrations, [FOLLOW_EVERY_MIGRATION]);
  // A second start changes nothing, even after the developer turned one off.
  by("b").enable_auto_sends = false;
  assert.equal(migrateFollowEvery(state), null); assert.equal(by("b").enable_auto_sends, false);
});

test("Follow every workspace is on by default: discovery follows any project's new workspace with auto-send, except opt-outs", () => {
  const state: State = { version: 1, workspaces: [] };
  const row = (id: string) => ({ id, title: id, mainAgentId: `${id}-main`, projectId: "notes", messageAt: null, enable_default_tracking: true });
  assert.equal(followsByDefault(state, row("x")), true);
  applyDiscovery(state, [row("new")], NOW);
  assert.equal(state.workspaces[0].enable_tracking, true); assert.equal(state.workspaces[0].enable_auto_sends, true);
  state.workspaceOptOuts = ["skip"];
  assert.equal(followsByDefault(state, row("skip")), false);
  applyDiscovery(state, [row("skip")], NOW);
  assert.equal(state.workspaces.find(w => w.id === "skip")!.enable_tracking, false);
  state.projectDefaults = { notes: false };
  assert.equal(followsByDefault(state, row("y")), false, "a project opt-out still wins");
  // "Send repairs automatically" off: newly followed workspaces wait for a click.
  const quiet: State = { version: 1, workspaces: [], enable_auto_sends_default: false };
  applyDiscovery(quiet, [row("q")], NOW);
  assert.equal(quiet.workspaces[0].enable_tracking, true); assert.equal(quiet.workspaces[0].enable_auto_sends, false);
});

// ---------- search ----------

function fixture() {
  const tracked = [
    ws("okta", { title: "Okta SCIM sync", prs: [pr({ key: "hero/app#1402", number: 1402, stack: "feat/okta-scim", snapshot: snapshot({ title: "Add SCIM provisioning for Okta" }) })] }),
    ws("vanta", { title: "Fix HER-1312 Vanta custom status approvals", updatedAt: at(10) }),
    ws("billing", { title: "Billing cleanup", goal: "Ask finance about okta invoices" }),
  ];
  const paseo = [lite("okta", { name: "Okta SCIM sync", branch: "feat/okta-scim" }), lite("vanta", { name: "Fix HER-1312 Vanta custom status approvals", branch: "tom/her-1312-vanta" }),
    lite("billing", { name: "Billing cleanup", branch: "chore/billing" }), lite("ramp", { name: "Ramp export", branch: "feat/okta-adjacent", project: "ledger" })];
  const model = buildHome({ rows: [], tracked, paseo, now: NOW });
  const archived = [ws("gone", { title: "Okta legacy connector", archived: true })];
  const docs = homeSearchDocs({ model, paseo, tracked, archived, agents: [{ id: "sub", title: "Write the SAML adapter", workspaceId: "billing" }] });
  return { index: indexDocs(docs), model };
}
const keys = (q: string) => { const { index } = fixture(); return search(index, q, NOW).map(h => h.key); };

test("search matches name, branch, PR number and title, Linear keys, agents and project, token-based and case-insensitive", () => {
  assert.equal(keys("scim okta")[0], "ws:okta", "tokens in any order");
  assert.equal(keys("#1402")[0], "ws:okta"); assert.equal(keys("1402")[0], "ws:okta");
  assert.equal(keys("provisioning")[0], "ws:okta", "PR title");
  assert.equal(keys("HER-1312")[0], "ws:vanta"); assert.equal(keys("her 1312")[0], "ws:vanta");
  assert.equal(keys("chore/billing")[0], "ws:billing", "branch");
  assert.equal(keys("saml adapter")[0], "ws:billing", "a subagent's title");
  assert.deepEqual(keys("ledger"), ["ws:ramp"], "project");
  assert.deepEqual(keys("vant"), ["ws:vanta"], "prefix");
  assert.deepEqual(keys("zzz"), []);
  assert.deepEqual(keys("   "), []);
});

test("search ranks the name above branch and PR above the ask, keeps archived last, and forgives one typo", () => {
  const order = keys("okta");
  assert.equal(order[0], "ws:okta", "name match first");
  assert.ok(order.indexOf("ws:ramp") < order.indexOf("ws:billing"), "branch beats the goal");
  assert.equal(order.at(-1), "ws:gone", "archived at the bottom");
  assert.equal(keys("otka scim")[0], "ws:okta", "swapped letters");
  assert.equal(keys("vamta")[0], "ws:vanta", "one substitution");
  assert.equal(withinOneEdit("okta", "otka"), true); assert.equal(withinOneEdit("okta", "orca"), false);
  assert.equal(tokenMatch("ok", "okta") > tokenMatch("okt", "lookta"), true);
});

test("results highlight the title or say where they matched, and providers list in order", () => {
  const { index } = fixture();
  const [hit] = search(index, "scim", NOW);
  assert.deepEqual(hit.titleRanges, [[5, 9]]); assert.equal(hit.via, null);
  const [branch] = search(index, "chore", NOW);
  assert.equal(branch.via?.field, "branch"); assert.deepEqual(branch.via?.ranges, [[0, 5]]);
  const overseer: OmniboxProvider = { id: "overseer", results: q => [{ provider: "overseer", key: `ask:${q}`, hit: { key: "ask", title: `Ask: ${q}`, group: "needs", score: 0, titleRanges: [], via: null } }] };
  const rows = omniboxResults([workspaceProvider(index, NOW), overseer], "1402");
  assert.equal(rows[0].key, "ws:okta"); assert.equal(rows.at(-1)!.provider, "overseer");
});

test("searching 100 workspaces and 200 agents stays fast", () => {
  const tracked = Array.from({ length: 100 }, (_, i) => ws(`w${i}`, { title: `Workspace ${i} HER-${1000 + i}`, prs: [pr({ key: `hero/app#${i}`, number: 2000 + i, snapshot: snapshot({ title: `Change ${i}` }) })] }));
  const paseo = tracked.map(w => lite(w.id, { name: w.title, branch: `feat/branch-${w.id}` }));
  const model = buildHome({ rows: [], tracked, paseo, now: NOW });
  const agents = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, title: `Agent ${i} reviewing`, workspaceId: `w${i % 100}` }));
  const index = indexDocs(homeSearchDocs({ model, paseo, tracked, agents }));
  const start = performance.now();
  for (const q of ["work", "her-1050", "2077", "branch w9", "agnet", "reviewing 42"]) search(index, q, NOW);
  assert.ok(performance.now() - start < 200, `six queries took ${performance.now() - start}ms`);
});

// ---------- sort ----------

function sortFixture(sort: SortMode, priorities: Priority[] = []) {
  return buildHome({ now: NOW, sort, priorities,
    rows: [flagged("perm", "permission", 5), flagged("old", "finished", 120), flagged("new", "finished", 3, { workspaceTitle: "Alpha" }), flagged("mid", "finished", 60, { workspaceTitle: "Zulu", lastActivityAt: at(1) })],
    tracked: [], paseo: [lite("w-old", { project: "b" }), lite("w-new", { project: "a", name: "Alpha" }), lite("w-mid", { project: "a", name: "Zulu" }), lite("w-perm", { project: "c" }), lite("idle", { project: "c" })] });
}
const needsOrder = (m: ReturnType<typeof buildHome>) => m.groups.find(g => g.id === "needs")!.items.map(s => s.agentId);

test("each sort reorders inside the group and the group order stays", () => {
  assert.deepEqual(needsOrder(sortFixture("priority")), ["perm", "old", "mid", "new"], "blocking first, then the oldest ask");
  assert.deepEqual(needsOrder(sortFixture("recent")), ["mid", "new", "old", "perm"], "latest activity, the ask or anything after it");
  assert.deepEqual(needsOrder(sortFixture("oldest")), ["old", "mid", "perm", "new"]);
  assert.deepEqual(needsOrder(sortFixture("name")), ["new", "old", "perm", "mid"]);
  assert.deepEqual(needsOrder(sortFixture("project")), ["mid", "new", "old", "perm"], "project, then priority inside it");
  for (const mode of SORT_MODES) assert.deepEqual(sortFixture(mode).groups.map(g => g.id), ["needs", "quiet"]);
});

// ---------- priorities ----------

const prio = (workspaceId: string, score: number, minutesAgo: number, reason = `Reason ${workspaceId}`): Priority =>
  ({ workspaceId, score, reason, sources: [{ kind: "linear", label: "HER-1" }], at: at(minutesAgo) });

test("fresh priorities rank Needs you but never above a blocking ask; stale ones fall back to urgency", () => {
  const ranked = sortFixture("priority", [prio("w-new", 90, 12), prio("w-old", 10, 12), prio("w-perm", 5, 12)]);
  assert.deepEqual(needsOrder(ranked), ["perm", "new", "old", "mid"]);
  assert.equal(ranked.rankedAt, at(12)); assert.equal(priorityNote(ranked.rankedAt, NOW), "Ranked 12m ago");
  const row = ranked.byKey.get("agent:new")!;
  assert.deepEqual(row.priority, { score: 90, reason: "Reason w-new", source: { kind: "linear", label: "HER-1" } });
  const stale = sortFixture("priority", [prio("w-new", 90, PRIORITY_FRESH_MS / 60_000 + 1)]);
  assert.deepEqual(needsOrder(stale), ["perm", "old", "mid", "new"]);
  assert.equal(stale.rankedAt, null); assert.equal(priorityNote(stale.rankedAt, NOW), "By urgency");
  assert.equal(stale.byKey.get("agent:new")!.priority, null, "no stale reason shown");
  assert.equal(freshPriorities([prio("x", 1, 1)], NOW).byWorkspace.size, 1);
  assert.deepEqual(mergePriorities([prio("a", 1, 5), prio("b", 2, 5)], [prio("a", 9, 1)], false).map(p => [p.workspaceId, p.score]), [["a", 9], ["b", 2]]);
  assert.deepEqual(mergePriorities([prio("a", 1, 5), prio("b", 2, 5)], [prio("a", 9, 1)], true).map(p => p.workspaceId), ["a"]);
});

test("set_priorities plans first, then stores what it showed", async () => {
  const state: State = { version: 1, workspaces: [ws("okta", { title: "Okta SCIM sync" })] };
  const stored: Priority[][] = [];
  const actions = new AgentActions({ store: { snapshot: async () => state, mutate: async fn => fn(state) }, prActions: {} as never, engine: {} as never,
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async () => {} },
    priorities: { write: async (batch, replace) => { stored.push(batch); assert.equal(replace, false); return batch; } }, now: () => NOW });
  const plan = await actions.run("ranker", "set_priorities", { priorities: [
    { workspace: "Okta SCIM sync", score: 80, reason: "Blocks the Okta launch", sources: [{ kind: "linear", label: "HER-1402" }] },
    { workspace: "nope", score: 10, reason: "x" },
  ] }) as { planId: string; rows: { workspaceId: string | null; blockers: string[] }[] };
  assert.equal(plan.rows[0].workspaceId, "okta"); assert.equal(plan.rows[1].blockers.length, 1); assert.equal(stored.length, 0);
  await assert.rejects(actions.run("ranker", "set_priorities", { priorities: [{ workspace: "okta", score: 101, reason: "x" }] }));
  await assert.rejects(actions.run("ranker", "set_priorities", { priorities: [{ workspace: "okta", score: 1, reason: "two\nlines" }] }));
  const done = await actions.run("ranker", "set_priorities", { confirm: true, planId: plan.planId }) as { stored: number };
  assert.equal(done.stored, 1); assert.equal(stored[0][0].workspaceId, "okta"); assert.equal(stored[0][0].by, "agent:ranker");
});

// ---------- status at a glance ----------

test("one set of counts for the strip, the badge and the brief", () => {
  const model = sortFixture("priority");
  const counts = homeCounts(model);
  assert.equal(counts.needs, 4); assert.equal(counts.quiet, 1); assert.equal(counts.fixing, 0); assert.equal(counts.archivable, 0);
  assert.equal(counts.needs, model.needs);
});

// ---------- provider limits ----------

test("usage parses Smart Session's RPCs and file, with amber from 80% and red at the limit", () => {
  assert.equal(toneOf(79), "ok"); assert.equal(toneOf(80), "warning"); assert.equal(toneOf(100), "danger");
  const subs = fromSubscriptions({ zerosub: true, accounts: [
    { id: "c1", family: "claude", name: "Main", isDefault: true, signedIn: true, disabled: false, readAt: at(2), windows: [{ id: "five_hour", pct: 62.4, resetsAt: "2026-11-09T14:10:00.000Z" }, { id: "seven_day", pct: 41, resetsAt: null }] },
    { id: "c2", family: "claude", name: "Account 2", isDefault: false, signedIn: true, disabled: false, readAt: at(2), windows: [{ id: "five_hour", pct: 90, resetsAt: null }] },
    { id: "off", family: "claude", name: "Off", isDefault: false, signedIn: true, disabled: true, readAt: null, windows: [{ id: "five_hour", pct: 1, resetsAt: null }] },
    { id: "x1", family: "codex", name: "Codex", isDefault: true, signedIn: true, disabled: false, readAt: at(30), windows: [{ id: "seven_day", pct: 4, resetsAt: null }] },
  ] });
  assert.deepEqual(subs.map(a => a.id), ["c1", "c2", "x1"]);
  assert.deepEqual(fromSubscriptions({ zerosub: false, accounts: [] }), []);
  const usage: Usage = { available: true, source: "rpc", accounts: subs };
  const [claude, codex] = meters(usage, NOW);
  assert.equal(claude.windows.map(w => `${w.label} ${w.pct}`).join(","), "5h 62,7d 41");
  assert.equal(claude.tone, "ok"); assert.equal(claude.accounts.length, 2);
  assert.match(meterText(claude, NOW), /^Claude 5h 62% · 7d 41% · resets \d\d:\d\d$/);
  assert.equal(codex.stale, true); assert.match(meterText(codex, NOW), /Codex 7d 4% · 30m old/);
  assert.deepEqual(meters({ available: false, source: null, accounts: [] }, NOW), []);
  assert.deepEqual(fromBudget({ windows: [{ id: "five_hour", pct: 100, resetsAt: null }] }).map(a => a.windows[0].pct), [100]);
  const file = [
    JSON.stringify({ accountId: "claude-a", family: "claude", fetchedAt: at(9), windows: { five_hour: { pct: 10, resetsAt: null } } }),
    "not json",
    JSON.stringify({ accountId: "claude-a", family: "claude", fetchedAt: at(1), windows: { five_hour: { pct: 85, resetsAt: null }, seven_day: { pct: 20, resetsAt: null } } }),
    JSON.stringify({ accountId: "codex-main", family: "codex", fetchedAt: at(1), windows: { seven_day: { pct: 4, resetsAt: null } } }),
  ].join("\n");
  const rows = fromAccountRows(file);
  assert.equal(rows.find(a => a.id === "claude-a")!.windows[0].pct, 85, "newest row per account");
  assert.equal(meters({ available: true, source: "file", accounts: rows }, NOW)[0].tone, "warning");
});

test("usage prefers Smart Session's RPC, falls back to its file, and hides without it", async t => {
  const home = await mkdtemp(join(tmpdir(), "follow-usage-")); t.after(() => rm(home, { recursive: true, force: true }));
  const now = () => NOW;
  let calls = 0;
  const viaRpc = new UsageReader(home, async (_p, method) => { calls++; return method === "smart-session.subscriptions" ? { zerosub: false, accounts: [] } : { windows: [{ id: "five_hour", pct: 50, resetsAt: null }] }; }, now);
  assert.equal((await viaRpc.read()).source, "rpc"); await viaRpc.read();
  assert.equal(calls, 2, "cached for a minute");
  const missing = new UsageReader(home, async () => { throw new Error("Unknown plugin smart-session"); }, now);
  assert.deepEqual(await missing.read(), { available: false, source: null, accounts: [] });
  await mkdir(join(home, "plugin-data", "smart-session"), { recursive: true });
  await writeFile(join(home, "plugin-data", "smart-session", "accounts-2026-11.jsonl"), JSON.stringify({ accountId: "codex-main", family: "codex", fetchedAt: at(1), windows: { seven_day: { pct: 4, resetsAt: null } } }) + "\n");
  const file = new UsageReader(home, async () => { throw new Error("Unknown plugin smart-session"); }, now);
  const usage = await file.read();
  assert.equal(usage.source, "file"); assert.equal(usage.accounts[0].family, "codex");
});
