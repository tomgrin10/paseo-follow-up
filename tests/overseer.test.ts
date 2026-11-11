import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approvesNewWorkspace, branchFor, digestFile, digestLine, forwardedSender, overseerRowState, OVERSEER_LABEL, pageRows, routeDecision, scoreCandidates,
  workspaceTitleFor, workstreams, type WorkstreamRow,
} from "../shared/overseer";
import { buildHome } from "../shared/home";
import { ASK_KEY, defaultActive, indexDocs, omniboxResults, overseerProvider, workspaceProvider, type OmniboxProvider } from "../shared/search";
import type { InboxRow } from "../shared/inbox";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { classify, type Ledger, type Sources } from "../server/inbox-classifier";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { Overseer, type OverseerPaseo } from "../server/overseer";
import type { State } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

const NOW = Date.parse("2026-11-09T09:50:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ws = (id: string, patch: Partial<WorkstreamRow> = {}): WorkstreamRow => ({
  workspaceId: id, title: `Workspace ${id}`, project: "atlas", branch: null, group: "quiet", agentId: `agent-${id}`, agentStatus: "idle", prs: [], ask: null, askKind: null,
  activity: null, activityAt: at(600), priority: null, keys: [], dormant: false, ...patch,
});
const row = (agentId: string, patch: Partial<InboxRow> = {}): InboxRow => ({
  agentId, workspaceId: `w-${agentId}`, title: "Main", workspaceTitle: `Workspace ${agentId}`, multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: at(5), needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, brief: null, ...patch,
});

// ---------- routing ----------

const fleet = [
  ws("scim", { title: "Fix HER-1282 SCIM group sync", branch: "tom/her-1282-scim-groups", keys: ["HER-1282"], prs: [{ key: "hero/app#1402", number: 1402, state: "OPEN", checks: "passed", threads: 0, url: null }] }),
  ws("vanta", { title: "Vanta custom status approvals", branch: "tom/vanta-status", prs: [{ key: "hero/app#1425", number: 1425, state: "OPEN", checks: "failed", threads: 2, url: null }] }),
  ws("export", { title: "Export findings to CSV", branch: "tom/csv-export", activityAt: at(10) }),
  ws("export2", { title: "Export audit log", branch: "tom/audit-export" }),
];

test("routing: a Linear key or PR number is decisive", () => {
  const byKey = scoreCandidates("tell the HER-1282 agent to use option B", fleet, NOW);
  assert.equal(byKey[0].workspaceId, "scim"); assert.match(byKey[0].reasons.join(), /key HER-1282/);
  assert.equal(routeDecision(byKey).confident, true);
  const byPr = scoreCandidates("rebase #1425 on main", fleet, NOW);
  assert.equal(byPr[0].workspaceId, "vanta"); assert.match(byPr[0].reasons.join(), /PR #1425/);
  assert.equal(routeDecision(byPr).confident, true);
});
test("routing: the branch name and the workspace's name count", () => {
  const byBranch = scoreCandidates("check tom/csv-export, the tests are flaky", fleet, NOW);
  assert.equal(byBranch[0].workspaceId, "export"); assert.match(byBranch[0].reasons.join(), /branch tom\/csv-export/);
  assert.equal(routeDecision(byBranch).confident, true);
  const byName = scoreCandidates("how are the vanta approvals going", fleet, NOW);
  assert.equal(byName[0].workspaceId, "vanta"); assert.match(byName[0].reasons.join(), /name vanta approvals/);
});
test("routing: an ambiguous ask is not confident and returns the top candidates", () => {
  const vague = scoreCandidates("the export is broken", fleet, NOW);
  assert.deepEqual(vague.slice(0, 2).map(c => c.workspaceId).sort(), ["export", "export2"]);
  const d = routeDecision(vague);
  assert.equal(d.confident, false); assert.ok(d.top.length >= 2 && d.top.length <= 3);
  assert.deepEqual(scoreCandidates("what's for lunch", fleet, NOW), [], "no match, no candidates");
});
test("routing: a new workspace gets its name and branch from the task and key", () => {
  assert.equal(workspaceTitleFor("HER-1400 add Okta SCIM deprovisioning"), "HER-1400 Add Okta SCIM deprovisioning");
  assert.equal(branchFor("HER-1400 Add Okta SCIM deprovisioning"), "her-1400-add-okta-scim-deprovisioning");
  assert.equal(approvesNewWorkspace("start a new workspace for it"), true);
  assert.equal(approvesNewWorkspace("Follow-up answer D1 (Which agent should take it?): C — New workspace\nContinue with this choice."), true);
  assert.equal(approvesNewWorkspace("yes, go ahead"), true);
  assert.equal(approvesNewWorkspace("tell the export agent to fix it"), false);
  assert.equal(approvesNewWorkspace(null), false);
});

// ---------- digest size and paging ----------

const hundred = Array.from({ length: 100 }, (_, i) => ws(`w${i}`, {
  title: `HER-${1200 + i} A realistic workspace title about feature ${i}`, branch: `tom/her-${1200 + i}-feature-${i}`,
  group: i < 8 ? "needs" : i < 20 ? "running" : i < 35 ? "waiting" : "quiet",
  ask: i < 8 ? `Decision: pick the migration strategy for tenant ${i} before staging deploy` : null,
  activity: i >= 8 ? `Pushed a41f0c${i % 10} · Bash pnpm test --filter feature-${i}` : null,
  prs: [{ key: `hero/app#${1300 + i}`, number: 1300 + i, state: "OPEN", checks: i % 3 ? "passed" : "failed", threads: i % 4, url: null }],
  priority: i < 30 ? { score: 90 - i, reason: `HER-${1200 + i} · Urgent · due today` } : null,
}));
const hook = async () => { process.env.FOLLOW_UP_HOOK_IMPORT = "1";
  // @ts-expect-error plain JS hook, generated into hook-source.ts
  return import("../server/agent-hook.mjs") as Promise<{ overseerDigest: (file: unknown, seen: unknown, now?: number) => { text: string; seen: { rows: Record<string, string> } } }>; };

test("digest: 100 workspaces stay within about 3k tokens, and only changes repeat", async () => {
  const { overseerDigest } = await hook();
  const file = digestFile("ov", hundred, NOW);
  assert.equal(file.total, 100); assert.equal(file.needs, 8);
  assert.ok(file.rows.every(r => digestLine(hundred.find(h => h.workspaceId === r.id)!) === r.line));
  const first = overseerDigest(file, null, NOW + 5_000);
  assert.ok(first.text.length <= 12_000, `first digest ${first.text.length} chars`);
  assert.match(first.text, /100 workspaces, 8 need the developer/); assert.match(first.text, /First turn\. Running now \(12\)/);
  // Next turn: nothing changed, so only the needs list and a "no changes" line.
  const quiet = overseerDigest(file, first.seen, NOW + 60_000);
  assert.match(quiet.text, /No other changes since your last turn/);
  assert.ok(quiet.text.length < first.text.length);
  // Two workspaces change, one disappears: exactly those are reported.
  const moved = digestFile("ov", hundred.filter(h => h.workspaceId !== "w99").map(h => h.workspaceId === "w40" ? { ...h, group: "running" as const, activity: "Bash pnpm build" } : h.workspaceId === "w41" ? { ...h, prs: [{ ...h.prs[0], checks: "failed" as const }] } : h), NOW + 120_000);
  const next = overseerDigest(moved, first.seen, NOW + 125_000);
  assert.match(next.text, /Changed since your last turn \(3\)/); assert.match(next.text, /\[running\] .*w40/); assert.match(next.text, /1 workspace archived or removed: w99/);
  // A huge change set pages instead of growing.
  const all = digestFile("ov", hundred.map(h => ({ ...h, activity: `${h.activity} again` })), NOW);
  const flood = overseerDigest(all, first.seen, NOW);
  assert.ok(flood.text.length <= 12_000); assert.match(flood.text, /more changed: workstreams\(\)/);
});
test("workstreams pages, filters by group and query, and orders what needs Tom first", () => {
  const p1 = pageRows(hundred, { page: 1 });
  assert.equal(p1.total, 100); assert.equal(p1.pages, 3); assert.equal(p1.rows.length, 40);
  assert.ok(p1.rows.slice(0, 8).every(r => "group" in r && r.group === "needs"));
  assert.equal(pageRows(hundred, { page: 3 }).rows.length, 20);
  assert.equal(pageRows(hundred, { page: 9 }).page, 3, "past the end clamps to the last page");
  assert.equal(pageRows(hundred, { group: "running" }).total, 12);
  assert.deepEqual(pageRows(hundred, { query: "her-1205" }).rows.map(r => r.workspaceId), ["w5"]);
  assert.deepEqual(pageRows(hundred, { query: "#1342" }).rows.map(r => r.workspaceId), ["w42"]);
  assert.ok(JSON.stringify(p1).length < 24_000, "one page of the tool stays a few thousand tokens");
});

// ---------- the Overseer stays out of Needs you and tracking ----------

test("workstreams and Home leave the Overseer's own workspace out", () => {
  const rows = [row("ov", { workspaceId: "w-ov", needs: { reasons: [{ reason: "finished", at: at(3), detail: "Done", dedupeKey: "f" }], since: at(3) } }), row("a1", { status: "running" })];
  const paseo = [{ id: "w-ov", name: "Overseer", project: null, activityAt: at(1) }, { id: "w-a1", name: "SCIM", project: "atlas", activityAt: at(2), branch: "tom/scim" }];
  const list = workstreams({ rows, tracked: [], paseo, now: NOW, exclude: { agentId: "ov", workspaceId: "w-ov" } });
  assert.deepEqual(list.map(r => r.workspaceId), ["w-a1"]); assert.equal(list[0].branch, "tom/scim");
  const home = buildHome({ rows, tracked: [], paseo, now: NOW, hidden: ["w-ov"] });
  assert.equal(home.needs, 0); assert.ok(![...home.byKey.values()].some(s => s.workspaceId === "w-ov"));
  assert.equal(buildHome({ rows, tracked: [], paseo, now: NOW }).needs, 1, "without hiding, it would count");
});

test("the inbox keeps the Overseer out of rows and counts and returns its row apart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "overseer-inbox-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const info = (id: string, workspaceId: string): AgentInfo => ({ id, workspaceId, parentAgentId: null, title: id === "ov" ? "Overseer" : "Main", status: "idle", archivedAt: null, updatedAt: at(1), lastUserMessageAt: null, requiresAttention: false, attentionReason: null });
  const agents = [info("ov", "w-ov"), info("a1", "w1")];
  const directory: Directory = { async agents() { return agents; }, async workspaces() { return [{ id: "w-ov", name: "Overseer" }, { id: "w1", name: "SCIM" }]; }, async agent(id) { return agents.find(a => a.id === id) ?? null; }, async tail() { return []; }, async clearAttention() {} };
  const none: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };
  const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: none, guard: async () => null, graceMs: 5, settleMs: 1, settleStepMs: 1, now: () => NOW, overseer: async () => "ov" });
  await inbox.store.mutate(s => { s.importedAt = at(60); s.lastSeen = at(1); s.primedAt = at(60); });
  await inbox.turnEnded({ id: "ov", workspaceId: "w-ov" }, { kind: "completed" }, "t1");
  await inbox.turnEnded({ id: "a1", workspaceId: "w1" }, { kind: "completed" }, "t2");
  const list = await inbox.list();
  assert.deepEqual(list.rows.map(r => r.agentId), ["a1"]);
  assert.equal(list.overseer?.agentId, "ov");
  assert.ok(list.overseer?.needs, "its own state is still kept for its pinned row and decision card");
});

test("discovery never tracks the Overseer's workspace", async () => {
  const mk = (id: string, workspaceId: string, labels: Record<string, string> = {}): Agent => ({ id, workspaceId, createdAt: at(100), status: "idle", labels, lastUserMessageAt: null, pendingPermissions: [], provider: "claude", cwd: "/fixture" });
  const agents = [mk("ov", "w-ov", { [OVERSEER_LABEL]: "1" }), mk("a1", "w1")];
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "w-ov", name: "Overseer", projectId: "p" }, { id: "w1", name: "SCIM", projectId: "p" }], pageInfo: { hasMore: false } }),
    listProjects: async () => ({ projects: [{ projectId: "p", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) }),
    fetchAgentTimeline: async () => ({ entries: [], hasOlder: false, error: null, gap: false, staleCursor: false }),
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon);
  const state: State = { version: 1, workspaces: [], projectDefaults: { p: true } };
  assert.deepEqual((await gateway.discover(state)).map(r => r.id), ["w1"]);
  assert.deepEqual((await gateway.discover(state, "w-ov")).map(r => r.id), [], "not even a targeted Track");
});

// ---------- the forwarded-message rule ----------

test("forwarded-message rule: Tom's words clear the target's flag only when they answer its open ask", () => {
  assert.equal(forwardedSender({ replyToAsk: true, targetFlagged: true }), "developer");
  assert.equal(forwardedSender({ replyToAsk: false, targetFlagged: true }), "follow-up", "a new task leaves an unrelated ask standing");
  assert.equal(forwardedSender({ replyToAsk: true, targetFlagged: false }), "follow-up", "nothing open to answer");
});

/** Agents are loaded unless `loaded: false` (a loaded snapshot carries activeTurn; see shared/agent-load.ts). */
function fakePaseo(agents: Record<string, { workspaceId: string; status?: string; archivedAt?: string | null; loaded?: boolean }>, tails: Record<string, unknown[]> = {}) {
  const sent: { agentId: string; text: string; messageId?: string }[] = [];
  const timelineReads: string[] = [];
  const created: Record<string, unknown>[] = [];
  let n = 0;
  const paseo: OverseerPaseo = {
    workspaces: {
      async create(options) { const id = `w-new-${++n}`; created.push({ kind: "workspace", id, ...options }); return { id, agents: { async create(o) { const aid = `a-new-${n}`; created.push({ kind: "agent", id: aid, workspaceId: id, ...o }); agents[aid] = { workspaceId: id }; return { id: aid }; } } }; },
      ref: () => ({ refresh: async () => ({ archivedAt: null }) }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => agents[id] ? { agent: { id, workspaceId: agents[id].workspaceId, status: agents[id].status ?? "idle", archivedAt: agents[id].archivedAt ?? null, title: "Main", ...(agents[id].loaded === false ? {} : { activeTurn: null }) } } : null,
        send: async (text: string, options?: Record<string, unknown>) => { sent.push({ agentId: id, text, messageId: options?.messageId as string | undefined }); },
        timeline: { refetch: async () => { timelineReads.push(id); return { entries: (tails[id] ?? []).map((item, i) => ({ seqStart: i, item })) }; } },
      }),
    },
    projects: { list: async () => ({ entries: [{ projectId: "p", projectName: "hero-app" }] }) },
  };
  return { paseo, sent, created, agents, timelineReads };
}

async function overseerFixture(t: any, rows: InboxRow[], tails: Record<string, unknown[]> = {}, extra: { paseoHome?: string; tight?: () => Promise<boolean>; start?: boolean; enabled?: () => Promise<boolean> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "overseer-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger: Ledger = [];
  const inbox = {
    async list() { return { rows }; }, async brief() { return null; },
    async noteDelivery(agentId: string, messageId: string | null, by?: "developer") { ledger.push({ agentId, messageId, at: new Date(NOW).toISOString(), ...(by ? { by } : {}) }); },
  };
  const state: State = { version: 1, workspaces: [workspace({ id: "w1", title: "SCIM", mainAgentId: "a1", prs: [pr({ key: "hero/app#1402", repo: "hero/app", number: 1402, snapshot: snapshot({ title: "HER-1282 SCIM sync" }) })] })] };
  const overseer = new Overseer({ directory: dir, store: { snapshot: async () => state }, inbox, sources: sources(ledger), priorities: { read: async () => [] }, enabled: extra.enabled ?? (async () => true), provider: "demo/claude-opus-5-5", now: () => NOW,
    tight: extra.tight ?? (async () => false), paseoHome: extra.paseoHome,
    workspaces: async () => [{ id: "w1", name: "SCIM", project: "hero-app", projectId: "p", activityAt: at(5), branch: "tom/her-1282-scim" }, { id: "w2", name: "Export", project: "hero-app", projectId: "p", activityAt: at(9), branch: "tom/export" }] });
  const fake = fakePaseo({ a1: { workspaceId: "w1" }, a2: { workspaceId: "w2" } }, tails);
  if (extra.start !== false) await overseer.start(fake.paseo);
  const ov = (await overseer.state()).agentId!;
  return { dir, overseer, ledger, ...fake, ov };
}
const sources = (ledger: Ledger): Sources => ({ ledger: async () => ledger, defer: async () => false, session: async () => false, schedule: async () => false });

test("forwarded-message rule end to end: a reply to the open ask reads as Tom, a new task as Follow-up", async t => {
  const flaggedRow = row("a1", { workspaceId: "w1", needs: { reasons: [{ reason: "finished", at: at(9), detail: "Pick A or B", dedupeKey: "d" }], since: at(9) } });
  const f = await overseerFixture(t, [flaggedRow, row("a2", { workspaceId: "w2" })]);
  const reply = await f.overseer.act(f.paseo, f.ov, "send_to_agent", { agentId: "a1", text: "use option B", reply_to_ask: true }) as { clearsNeedsYou: boolean; workspace: string };
  assert.equal(reply.clearsNeedsYou, true); assert.equal(reply.workspace, "SCIM");
  assert.equal(f.sent[0].text, "From the developer via Overseer: use option B");
  assert.equal(await classify({ text: f.sent[0].text, messageId: f.sent[0].messageId }, "a1", NOW, sources(f.ledger)), "tom", "the inbox clears a1's flag");
  const task = await f.overseer.act(f.paseo, f.ov, "send_to_agent", { agentId: "a1", text: "also bump the timeout", reply_to_ask: false }) as { clearsNeedsYou: boolean };
  assert.equal(task.clearsNeedsYou, false);
  assert.equal(await classify({ text: f.sent[1].text, messageId: f.sent[1].messageId }, "a1", NOW, sources(f.ledger)), "follow-up", "a new task doesn't answer the open ask");
  await assert.rejects(f.overseer.act(f.paseo, "a2", "send_to_agent", { agentId: "a1", text: "x" }), /Overseer only/, "only the Overseer may forward");
  await assert.rejects(f.overseer.act(f.paseo, f.ov, "send_to_agent", { agentId: f.ov, text: "x" }), /That's you/);
});

test("the Overseer is created once in its own labelled workspace, its digest is written, and an archived one comes back with a handoff", async t => {
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1", status: "running" })], {});
  const agent = f.created.find(c => c.kind === "agent")!;
  assert.deepEqual(agent.labels, { [OVERSEER_LABEL]: "1" });
  assert.equal((agent.config as { systemPrompt: string }).systemPrompt.includes("Route, don't do the work"), true);
  assert.equal((await f.overseer.start(f.paseo)).generation, 1, "a second click reuses the running Overseer");
  assert.equal(f.created.filter(c => c.kind === "workspace").length, 1);
  assert.equal(await f.overseer.writeDigest(), "same", "start wrote it; unchanged content is not rewritten");
  const digest = JSON.parse(await readFile(join(f.dir, "overseer-digest.json"), "utf8"));
  assert.equal(digest.agentId, f.ov); assert.deepEqual(digest.rows.map((r: { id: string }) => r.id), ["w1", "w2"]);
  f.agents[f.ov].archivedAt = at(0);
  assert.equal(await f.overseer.ensure(f.paseo), "recreated");
  const next = await f.overseer.state();
  assert.notEqual(next.agentId, f.ov); assert.equal(next.generation, 2);
  assert.match(String(f.created.filter(c => c.kind === "agent").at(-1)!.prompt), /^Handoff from the previous Overseer/);
});

test("route_candidates, workstreams and agent_digest answer from Follow-up's state", async t => {
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1", needs: { reasons: [{ reason: "finished", at: at(3), detail: "Ready for review", dedupeKey: "f" }], since: at(3) } }), row("a2", { workspaceId: "w2" })],
    { a1: [{ type: "user_message", text: "fix the sync" }, { type: "tool_call", name: "Bash", detail: { command: "pnpm test" } }, { type: "assistant_message", text: "Fixed and pushed." }] });
  const route = await f.overseer.act(f.paseo, f.ov, "route_candidates", { ask: "merge plan for HER-1282?" }) as { confident: boolean; candidates: { workspaceId: string }[] };
  assert.equal(route.confident, true); assert.equal(route.candidates[0].workspaceId, "w1");
  const page = await f.overseer.act(f.paseo, f.ov, "workstreams", { group: "needs" }) as { total: number; rows: WorkstreamRow[] };
  assert.equal(page.total, 1); assert.equal(page.rows[0].branch, "tom/her-1282-scim"); assert.deepEqual(page.rows[0].keys, ["HER-1282"]);
  const d = await f.overseer.act(f.paseo, f.ov, "agent_digest", { agentId: "a1" }) as { steps: { kind: string; text: string }[]; openAsks: string[]; workspace: string };
  assert.deepEqual(d.steps.map(s => s.kind), ["you", "tool", "agent"]); assert.equal(d.workspace, "SCIM"); assert.equal(d.openAsks.length, 1);
});

test("a new workspace waits for the developer's approval", async t => {
  const f = await overseerFixture(t, [], {});
  // The fake's ref() builds a new handle per call, so swap the Overseer's tail through a map.
  const tails: Record<string, unknown[]> = {};
  const original = f.paseo.agents.ref;
  f.paseo.agents.ref = (id: string) => { const h = original(id); h.timeline.refetch = async () => ({ entries: (tails[id] ?? []).map((item, i) => ({ seqStart: i, item })) }); return h; };
  tails[f.ov] = [{ type: "user_message", text: "the export is broken, someone should look" }];
  const blocked = await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: "HER-1400 fix the CSV export" }) as { planId: string | null; blockers: string[]; plan: { title: string; branch: string; project: string } };
  assert.equal(blocked.planId, null); assert.match(blocked.blockers.join(), /hasn't asked for or approved/);
  assert.equal(f.created.filter(c => c.kind === "workspace").length, 1, "nothing but the Overseer's own workspace");
  // The answer is the developer's click on the Overseer's card: the brief action records it in the ledger first.
  f.ledger.push({ agentId: f.ov, messageId: "answer-1", at: new Date(NOW).toISOString(), by: "developer" });
  tails[f.ov] = [{ type: "user_message", text: "Follow-up answer D1 (Which agent?): C — New workspace\nContinue with this choice.", messageId: "answer-1" }];
  const plan = await f.overseer.act(f.paseo, f.ov, "start_workspace", { task: "HER-1400 fix the CSV export" }) as { planId: string; plan: { title: string; branch: string; project: string } };
  assert.ok(plan.planId); assert.deepEqual(plan.plan, { ...plan.plan, title: "HER-1400 Fix the CSV export", branch: "her-1400-fix-the-csv-export", project: "hero-app" });
  const done = await f.overseer.act(f.paseo, f.ov, "start_workspace", { confirm: true, planId: plan.planId }) as { started: boolean };
  assert.equal(done.started, true);
  const w = f.created.filter(c => c.kind === "workspace").at(-1)!;
  assert.deepEqual(w.source, { kind: "worktree", projectId: "p", action: "branch-off", baseBranch: "main", branchName: "her-1400-fix-the-csv-export" });
  await assert.rejects(f.overseer.act(f.paseo, f.ov, "start_workspace", { confirm: true, planId: plan.planId }), /expired or was used/);
});

test("the pinned row: start once, then idle, working, or asking", () => {
  assert.equal(overseerRowState({ enabled: false, agentId: null, error: null }, null), null);
  assert.equal(overseerRowState({ enabled: true, agentId: null, error: null }, null)?.state, "start");
  assert.equal(overseerRowState({ enabled: true, agentId: "ov", error: null }, row("ov", { status: "running" }))?.state, "running");
  const asks = overseerRowState({ enabled: true, agentId: "ov", error: null }, row("ov", { needs: { reasons: [{ reason: "finished", at: at(1), detail: "x", dedupeKey: "d" }], since: at(1) }, brief: { kind: "decision", source: "agent", state: "open", ask: "Which agent takes the CSV fix?" } }));
  assert.deepEqual(asks, { state: "asks", line: "Asks you · Which agent takes the CSV fix?" });
  assert.equal(overseerRowState({ enabled: true, agentId: "ov", error: null }, row("ov"))?.state, "idle");
});

test("the Overseer's session skips the Stop-hook nudge and gets the digest instead", async t => {
  const dir = await mkdtemp(join(tmpdir(), "overseer-hook-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const { spawn } = await import("node:child_process");
  const { mkdir, copyFile } = await import("node:fs/promises");
  await copyFile(new URL("../server/agent-hook.mjs", import.meta.url), join(dir, "agent-hook.mjs"));
  await writeFile(join(dir, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/x" }));
  await writeFile(join(dir, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  await writeFile(join(dir, "overseer-digest.json"), JSON.stringify(digestFile("ov", fleet.map(r => r.workspaceId === "scim" ? { ...r, group: "needs" as const, ask: "Decision: A or B" } : r), Date.now())));
  await mkdir(join(dir, "hook-state"), { recursive: true });
  const run = (event: object) => new Promise<string>(resolve => {
    const p = spawn(process.execPath, [join(dir, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: "ov", FOLLOW_UP_OVERSEER: "1", FOLLOW_UP_BRIEF: "claude" } });
    let out = ""; p.stdout.on("data", d => { out += d; }); p.on("close", () => resolve(out)); p.stdin.end(JSON.stringify(event));
  });
  const submitted = JSON.parse(await run({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "what needs me?" }));
  assert.match(submitted.hookSpecificOutput.additionalContext, /^Follow-up digest \(last change/);
  assert.match(submitted.hookSpecificOutput.additionalContext, /Fix HER-1282 SCIM group sync/);
  assert.equal(await run({ hook_event_name: "Stop", session_id: "s" }), "", "no needs_you nudge and no sidebar bookkeeping");
});

// ---------- resources: never wake an agent, write only on change, back off under memory pressure ----------

import { encodeProjectDir, transcriptSteps, transcriptTail } from "../server/transcript";
import { mkdir } from "node:fs/promises";

/** A Paseo home with one stored agent record and its Claude transcript, plus a Codex one. Synthetic only. */
async function transcriptHome(t: any) {
  const root = await mkdtemp(join(tmpdir(), "overseer-transcripts-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "paseo"), claude = join(root, "claude"), codex = join(root, "codex");
  const cwd = join(root, "work", "export");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(home, "agents", "work-export"), { recursive: true });
  await writeFile(join(home, "agents", "work-export", "a2.json"), JSON.stringify({ id: "a2", provider: "claude", cwd, persistence: { sessionId: "sess-a2", metadata: { secret: "x" } } }));
  await writeFile(join(home, "agents", "work-export", "a3.json"), JSON.stringify({ id: "a3", provider: "codex", cwd, persistence: { sessionId: "thread-a3" } }));
  const { realpath } = await import("node:fs/promises");
  await mkdir(join(claude, "projects", encodeProjectDir(await realpath(cwd))), { recursive: true });
  await writeFile(join(claude, "projects", encodeProjectDir(await realpath(cwd)), "sess-a2.jsonl"), [
    JSON.stringify({ type: "user", message: { role: "user", content: "the CSV export drops the last row" } }),
    "{ not json",
    JSON.stringify({ type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the writer." }, { type: "tool_use", name: "mcp__follow-up__workspace_status", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "some-future-type", payload: 1 }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed the off-by-one; PR #1431 is up." }] } }),
  ].join("\n") + "\n");
  await mkdir(join(codex, "sessions", "2026", "11", "08"), { recursive: true });
  await writeFile(join(codex, "sessions", "2026", "11", "08", "rollout-2026-11-08T10-00-00-thread-a3.jsonl"), [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "bump the timeout" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
  ].join("\n"));
  const prior = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claude; process.env.CODEX_HOME = codex;
  t.after(() => { for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return { home };
}

test("transcripts: Claude and Codex steps from disk, tolerant of junk lines and harness wrappers", async t => {
  const { home } = await transcriptHome(t);
  assert.deepEqual(await transcriptTail(home, "a2", 10), [
    { kind: "you", text: "the CSV export drops the last row" },
    { kind: "agent", text: "Looking at the writer." },
    { kind: "tool", text: "workspace_status" },
    { kind: "agent", text: "Fixed the off-by-one; PR #1431 is up." },
  ]);
  assert.deepEqual((await transcriptTail(home, "a3", 2))!.map(s => s.text), ["shell", "Done."]);
  assert.equal(await transcriptTail(home, "nobody", 5), null);
  assert.equal(await transcriptTail(home, "../etc", 5), null, "ids never become paths");
  assert.deepEqual(transcriptSteps(["", "null", "[]", JSON.stringify({ type: "assistant", message: { content: 7 } })]), []);
});

test("agent_digest never reads an unloaded agent's timeline: transcript first, then Follow-up's cache", async t => {
  const { home } = await transcriptHome(t);
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1" }), row("a2", { workspaceId: "w2" })], {}, { paseoHome: home });
  f.agents.a2.loaded = false; f.agents.a1.loaded = false;
  f.timelineReads.length = 0;
  const d = await f.overseer.act(f.paseo, f.ov, "agent_digest", { agentId: "a2" }) as { source: string; loaded: boolean; note: string; steps: { text: string }[] };
  assert.equal(d.source, "transcript"); assert.equal(d.loaded, false); assert.match(d.note, /transcript on disk/);
  assert.equal(d.steps.at(-1)!.text, "Fixed the off-by-one; PR #1431 is up.");
  const cached = await f.overseer.act(f.paseo, f.ov, "agent_digest", { agentId: "a1" }) as { source: string; goal: string | null; prs: string[] };
  assert.equal(cached.source, "cache"); assert.deepEqual(cached.prs, ["#1402 HER-1282 SCIM sync"]);
  assert.deepEqual(f.timelineReads, [], "no timeline read for an unloaded agent");
  f.agents.a2.loaded = true;
  assert.equal((await f.overseer.act(f.paseo, f.ov, "agent_digest", { agentId: "a2" }) as { source: string }).source, "timeline");
});

test("routing to an unloaded agent is Tom's ask: it may wake it, and the reply says so", async t => {
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1" }), row("a2", { workspaceId: "w2" })]);
  f.agents.a2.loaded = false;
  const r = await f.overseer.act(f.paseo, f.ov, "send_to_agent", { agentId: "a2", text: "look at the export" }) as { woke: boolean; next: string };
  assert.equal(r.woke, true); assert.match(r.next, /\(woke Main\)/);
  const live = await f.overseer.act(f.paseo, f.ov, "send_to_agent", { agentId: "a1", text: "and the sync" }) as { woke: boolean; next: string };
  assert.equal(live.woke, false); assert.doesNotMatch(live.next, /woke/);
});

test("an archived Overseer's handoff comes from its transcript, never its timeline", async t => {
  const f = await overseerFixture(t, []);
  const ov = f.ov;
  f.agents[ov].archivedAt = at(0); f.agents[ov].loaded = false;
  f.timelineReads.length = 0;
  assert.equal(await f.overseer.ensure(f.paseo), "recreated");
  assert.deepEqual(f.timelineReads, []);
  assert.equal(await f.overseer.ensure(f.paseo, { periodic: true }), "alive", "the periodic backstop runs on its first tick");
  assert.equal(await f.overseer.ensure(f.paseo, { periodic: true }), "later", "then at most every 10 minutes");
});

test("the digest is written only when it changes, and not at all while memory is tight", async t => {
  let tight = false;
  const rows = [row("a1", { workspaceId: "w1" })];
  const f = await overseerFixture(t, rows, {}, { tight: async () => tight });
  const path = join(f.dir, "overseer-digest.json");
  const before = await readFile(path, "utf8");
  assert.equal(await f.overseer.writeDigest(), "same");
  rows.push(row("a2", { workspaceId: "w2", status: "running" }));
  tight = true;
  assert.equal(await f.overseer.writeDigest(), "skipped");
  assert.equal(await readFile(path, "utf8"), before);
  tight = false;
  assert.equal(await f.overseer.writeDigest(), "written");
  assert.notEqual(JSON.parse(await readFile(path, "utf8")).hash, JSON.parse(before).hash);
});

test("resting workspaces: last and compact in workstreams, one line in the digest, small at 100 workspaces", async () => {
  const fleet100 = Array.from({ length: 100 }, (_, i) => ws(`w${i}`, { title: `Workspace number ${i} with a fairly long descriptive title`, branch: `tom/feature-${i}`, dormant: i >= 30,
    group: i < 5 ? "needs" as const : i < 15 ? "running" as const : "quiet" as const, ask: i < 5 ? "Decision: which approach for the migration" : null, activity: i >= 5 ? "Ran the test suite and pushed a fix" : null,
    prs: i < 30 ? [{ key: `hero/app#${1300 + i}`, number: 1300 + i, state: "OPEN", checks: "passed" as const, threads: 1, url: null }] : [] }));
  const page = pageRows(fleet100, { size: 100 });
  assert.equal(page.resting, 70);
  assert.deepEqual(page.rows.at(-1), { workspaceId: page.rows.at(-1)!.workspaceId, title: page.rows.at(-1)!.title, agentId: page.rows.at(-1)!.agentId, dormant: true });
  assert.ok(page.rows.slice(0, 30).every(r => !("dormant" in r && r.dormant)), "active rows first");
  const file = digestFile("ov", fleet100, NOW);
  assert.equal(file.rows.filter(r => r.resting).length, 70);
  const { overseerDigest } = await hook();
  const first = overseerDigest(file, null, NOW);
  assert.match(first.text, /Resting \(70; agents likely unloaded, sending wakes them\)/);
  assert.ok(first.text.length < 12_000, `first-turn digest is ${first.text.length} chars`);
  const again = overseerDigest(file, first.seen, NOW);
  assert.match(again.text, /No other changes since your last turn/);
  assert.equal(digestFile("ov", fleet100, NOW + 60_000).hash, file.hash, "time alone never changes the hash");
});


test("an answer Tom clicked reads as an answer in the Overseer's pane", async () => {
  const { answerLine } = await import("../shared/overseer");
  assert.equal(answerLine("Follow-up answer D1 (Which agent should take it?): C — New workspace\nContinue with this choice."), "Answered: C · New workspace");
  assert.equal(answerLine("Follow-up answer Q3: B - Keep the old API"), "Answered: B · Keep the old API");
  assert.equal(answerLine("tell the SCIM agent to use option A"), null);
});

// ---------- the omnibox and ⌘K (slice 2) ----------

test("omnibox: \"Ask the Overseer\" is the last row, as typed, and only while the Overseer is on", () => {
  const index = indexDocs([{ key: "ws:scim", title: "Fix HER-1282 SCIM group sync", group: "needs", at: at(5), fields: [{ field: "name", text: "Fix HER-1282 SCIM group sync" }] }]);
  const ask = overseerProvider(true);
  const extra: OmniboxProvider = { id: "extra", results: () => [] };
  // Listed first on purpose: the ask still closes the list.
  const rows = omniboxResults([ask, workspaceProvider(index, NOW), extra], "  scim   group ");
  assert.deepEqual(rows.map(r => r.key), ["ws:scim", ASK_KEY]);
  assert.equal(rows.at(-1)!.ask, "scim group", "trimmed, spaces collapsed");
  assert.deepEqual(omniboxResults([workspaceProvider(index, NOW), ask], "what's for lunch").map(r => r.key), [ASK_KEY], "no match: the ask is the only row, so Enter sends it");
  assert.deepEqual(omniboxResults([workspaceProvider(index, NOW), overseerProvider(false)], "scim").map(r => r.key), ["ws:scim"], "off: no ask row");
  assert.deepEqual(overseerProvider(true).results("   "), [], "blank: nothing to ask");
  assert.deepEqual(overseerProvider(true).results("x".repeat(2001)), [], "too long for the omnibox");
});

test("asking from the omnibox starts the Overseer on first use and sends Tom's words unchanged", async t => {
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1" })], {}, { start: false });
  assert.equal((await f.overseer.state()).agentId, null);
  const s = await f.overseer.ask(f.paseo, "  the PRs look good, assign reviewers on all ");
  assert.ok(s.agentId); assert.equal(s.generation, 1);
  assert.equal(f.created.filter(c => c.kind === "agent").length, 1, "created once");
  assert.deepEqual(f.sent, [{ agentId: s.agentId, text: "the PRs look good, assign reviewers on all", messageId: undefined }], "no \"via Overseer\" prefix: these are Tom's own words to it");
  await f.overseer.ask(f.paseo, "and rebase #1425");
  assert.equal(f.created.filter(c => c.kind === "agent").length, 1, "a second ask reuses it");
  assert.equal(f.sent.at(-1)!.agentId, s.agentId);
});

test("asking brings an archived Overseer back first, and refuses while it's off", async t => {
  const f = await overseerFixture(t, [row("a1", { workspaceId: "w1" })]);
  f.agents[f.ov].archivedAt = at(0);
  const s = await f.overseer.ask(f.paseo, "what needs me?");
  assert.notEqual(s.agentId, f.ov); assert.equal(s.generation, 2);
  assert.equal(f.sent.at(-1)!.agentId, s.agentId, "sent to the new one, never the archived one");
  let on = true;
  const g = await overseerFixture(t, [], {}, { enabled: async () => on });
  on = false;
  await assert.rejects(g.overseer.ask(g.paseo, "hello"), /The Overseer is off/);
  await assert.rejects(g.overseer.ask(g.paseo, "   "), /Type what you want/);
  assert.equal(g.sent.length, 0);
});

test("omnibox: Enter never sends a one-word miss to the Overseer; a sentence or a real match is picked as before", () => {
  const index = indexDocs([{ key: "ws:scim", title: "Fix HER-1282 SCIM group sync", group: "needs", at: at(5), fields: [{ field: "name", text: "Fix HER-1282 SCIM group sync" }] }]);
  const rows = (q: string) => omniboxResults([workspaceProvider(index, NOW), overseerProvider(true)], q);
  assert.equal(defaultActive(rows("kubernetes")), -1, "a one-word miss: nothing is active");
  assert.equal(defaultActive(rows("what needs me before standup")), 0, "a sentence: Enter sends it");
  assert.equal(defaultActive(rows("scim")), 0, "a match: Enter opens it");
  assert.equal(defaultActive(null), 0);
});
