import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { AgentActions, controlWorkspace, type AgentActionDeps } from "../server/agent-actions";
import { classify, type Ledger } from "../server/inbox-classifier";
import type { InboxAction } from "../server/inbox";
import { pillState, withoutBriefQuestions } from "../shared/headline";
import type { NeedItem } from "../shared/attention";
import type { InboxRow } from "../shared/inbox";
import { snapshot, pr, workspace, clock } from "./fixtures";
import type { Snapshot, State } from "../shared/model";

const reviewers = (patch = {}) => ({ author: "author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true, ...patch });
const row = (patch: Partial<InboxRow> & { agentId: string }): InboxRow => ({ workspaceId: "workspace", title: "Agent", workspaceTitle: "Migration rollout", multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null, lastActivityAt: null, needs: null, snooze: null, signedOffAt: null, ...patch } as InboxRow);
const READY = "READY_TO_MERGE";
const needs = { since: new Date(clock).toISOString(), reasons: [{ reason: "finished", detail: "Finished", at: new Date(clock).toISOString() }] } as any;

/** A real store and the real PrActions, with GitHub stubbed at its boundary. */
async function fixture(t: TestContext, prs = [pr({ snapshot: snapshot({ reviewers: reviewers() }) })]) {
  const directory = await mkdtemp(join(tmpdir(), "follow-agent-actions-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.mutate(s => { s.workspaces = [workspace({ prs })]; });
  const current = new Map(prs.map(p => [p.key, structuredClone(p.snapshot!)]));
  const writes: { key: string; logins: string[] }[] = [];
  const github = {
    observe: async (list: { key: string }[]) => new Map(list.map(p => [p.key, { snapshot: structuredClone(current.get(p.key)!), error: null }])),
    requestReviewers: async (p: { key: string }, logins: string[]) => { writes.push({ key: p.key, logins }); current.get(p.key)!.reviewers!.requested = logins; },
  };
  const prActions = new PrActions(store, github as any, { merge: async () => { throw Error("Unexpected merge"); }, invalidate() {} }, new BrowserBridge(), () => clock, () => [{ name: "First", login: "reviewer-a" }, { name: "Second", login: "reviewer-b" }]);
  t.after(() => prActions.close());
  const notes: { by: string; agentId: string; action: string }[] = [];
  const acts: InboxAction[] = [];
  let rows: InboxRow[] = [];
  const deps: AgentActionDeps = {
    store, prActions,
    engine: { sendPending: async () => { throw Error("unused"); }, activate: async () => { throw Error("unused"); } },
    inbox: { list: async () => ({ enabled: true, rows }), act: async input => { acts.push(input); return { results: (input.agentIds ?? []).map(agentId => ({ agentId, ok: true, cameBack: false })) }; }, noteAction: async (by, agentId, action) => { notes.push({ by, agentId, action }); } },
    reviewersFor: () => [{ name: "First", login: "reviewer-a" }, { name: "Second", login: "reviewer-b" }], now: () => clock,
  };
  return { store, prActions, writes, notes, acts, agent: new AgentActions(deps), setRows: (next: InboxRow[]) => { rows = next; }, get: async () => (await store.snapshot()).workspaces[0] };
}
const strip = (state: State) => state.workspaces.map(w => ({ ...w, updatedAt: null, prActions: w.prActions.map(({ id: _id, createdAt: _at, ...a }) => a) }));

test("list_prs reads every tracked workspace and filters what needs reviewers or is ready to merge", async t => {
  const f = await fixture(t, [
    pr({ snapshot: snapshot({ reviewers: reviewers() }) }),
    pr({ key: "example/app#2", number: 2, snapshot: snapshot({ reviewers: reviewers({ requested: ["someone"] }), reviewDecision: "APPROVED", graphiteMergeStatus: READY }) }),
    pr({ key: "example/app#3", number: 3, snapshot: snapshot({ draft: true, reviewers: reviewers() }) }),
  ]);
  await f.store.mutate(s => { s.workspaces.push(workspace({ id: "other", title: "Other", mainAgentId: "other-agent", prs: [pr({ key: "example/web#9", repo: "example/web", number: 9, snapshot: snapshot({ reviewers: reviewers() }) })] }), workspace({ id: "off", enable_tracking: false, prs: [pr({ key: "example/off#1", repo: "example/off" })] })); });
  const all = await f.agent.run("orchestrator", "list_prs", {}) as any;
  assert.deepEqual(all.prs.map((p: any) => p.key), ["example/app#1", "example/app#2", "example/app#3", "example/web#9"], "untracked workspaces stay out");
  assert.deepEqual((await f.agent.run("orchestrator", "list_prs", { needs_reviewers: true }) as any).prs.map((p: any) => p.key), ["example/app#1", "example/web#9"], "drafts and PRs with reviewers are skipped");
  assert.deepEqual((await f.agent.run("orchestrator", "list_prs", { ready_to_merge: true }) as any).prs.map((p: any) => p.key), ["example/app#2"]);
  assert.deepEqual((await f.agent.run("orchestrator", "list_prs", { workspace: "Other" }) as any).prs.map((p: any) => p.key), ["example/web#9"]);
});

test("\"assign reviewers on all\": the dry run writes nothing; confirm runs the Add reviewers button's path and state", async t => {
  const f = await fixture(t);
  const plan = await f.agent.run("orchestrator", "add_reviewers", { prs: ["example/app#1"] }) as any;
  assert.equal(plan.dryRun, true); assert.deepEqual(plan.rows[0].reviewers, ["reviewer-a", "reviewer-b"]); assert.deepEqual(plan.rows[0].blockers, []);
  assert.equal(f.writes.length, 0, "a dry run never writes to GitHub");
  const done = await f.agent.run("orchestrator", "add_reviewers", { confirm: true, planId: plan.planId }) as any;
  assert.equal(done.results[0].state, "submitted");
  assert.deepEqual(f.writes, [{ key: "example/app#1", logins: ["reviewer-a", "reviewer-b"] }]);
  assert.deepEqual(f.notes, [{ by: "agent:orchestrator", agentId: "main-agent", action: "add_reviewers" }]);
  // The developer's button on an identical workspace ends in the same state.
  const ui = await fixture(t); await ui.prActions.requestReviewers("workspace", "example/app#1");
  assert.deepEqual(strip(await f.store.snapshot()), strip(await ui.store.snapshot()));
  await assert.rejects(f.agent.run("orchestrator", "add_reviewers", { confirm: true, planId: plan.planId }), /expired or was already used/);
});

test("add_reviewers takes explicit logins, drops the author, and blocks PRs that can't take reviewers", async t => {
  const f = await fixture(t, [pr({ snapshot: snapshot({ reviewers: reviewers() }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ draft: true, reviewers: reviewers() }) })]);
  const plan = await f.agent.run("orchestrator", "add_reviewers", { prs: ["example/app#1", "example/app#2", "example/none#4"], reviewers: ["author", "carol"] }) as any;
  assert.deepEqual(plan.rows.map((r: any) => [r.pr, r.reviewers, r.blockers.length > 0]), [["example/app#1", ["carol"], false], ["example/app#2", ["carol"], true], ["example/none#4", [], true]]);
  await f.agent.run("orchestrator", "add_reviewers", { confirm: true, planId: plan.planId });
  assert.deepEqual(f.writes, [{ key: "example/app#1", logins: ["carol"] }], "blocked rows are skipped");
});

test("confirm is refused without the plan id, for another agent's plan or another tool's plan", async t => {
  const f = await fixture(t);
  const plan = await f.agent.run("orchestrator", "add_reviewers", { prs: ["example/app#1"] }) as any;
  await assert.rejects(f.agent.run("orchestrator", "add_reviewers", { confirm: true }), /needs the planId/);
  await assert.rejects(f.agent.run("someone-else", "add_reviewers", { confirm: true, planId: plan.planId }), /different tool or agent/);
  await assert.rejects(f.agent.run("orchestrator", "add_reviewers", { prs: ["not a key"] }), /owner\/repo#number/);
  assert.equal(f.writes.length, 0);
});

test("merge uses Follow-up's merge plan: blockers mean no plan id; confirm runs the confirmed plan", async t => {
  const f = await fixture(t);
  const blocked = await f.agent.run("orchestrator", "merge", { pr: "example/app#1" }) as any;
  assert.equal(blocked.planId, null); assert.ok(blocked.prs[0].blockers.includes("Awaiting approval"));
  const calls: unknown[][] = [];
  const agent = new AgentActions({ store: f.store, prActions: { prepare: async (w, key, kind) => { calls.push(["prepare", w, key, kind]); return { id: "pr-plan", workspaceId: w, target: key, kind, expiresAt: new Date(clock + 60_000).toISOString(), blockers: [], prs: [{ key, blockers: [] }] } as any; }, confirm: async (id, scope) => { calls.push(["confirm", id, scope]); return { state: "submitted", result: "Merge submitted" }; }, requestReviewers: async () => { throw Error("unused"); } },
    engine: { sendPending: async () => { throw Error(); }, activate: async () => { throw Error(); } }, inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async () => {} }, now: () => clock });
  const plan = await agent.run("orchestrator", "merge", { pr: "example/app#1" }) as any;
  assert.ok(plan.planId); assert.deepEqual(calls, [["prepare", "workspace", "example/app#1", "merge"]], "the dry run only prepares");
  await assert.rejects(agent.run("orchestrator", "enable_merge_when_ready", { confirm: true, planId: plan.planId }), /different tool/);
  assert.equal((await agent.run("orchestrator", "merge", { confirm: true, planId: plan.planId }) as any).state, "submitted");
  assert.deepEqual(calls.at(-1), ["confirm", "pr-plan", "target"]);
});

test("sign_off: an agent can't sign itself off; other agents go through the inbox's sign-off with the shown seq", async t => {
  const f = await fixture(t);
  f.setRows([row({ agentId: "a1", needs, seq: 4 } as any), row({ agentId: "a2" }), row({ agentId: "orchestrator", needs })]);
  await assert.rejects(f.agent.run("orchestrator", "sign_off", { agentIds: ["a1", "orchestrator"] }), /can't sign itself off/);
  await assert.rejects(f.agent.run("orchestrator", "snooze", { agentIds: ["orchestrator"], until: "1h" }), /other agents/);
  const plan = await f.agent.run("orchestrator", "sign_off", { agentIds: ["a1", "a2"] }) as any;
  assert.deepEqual(plan.rows.map((r: any) => r.blockers), [[], ["Nothing to sign off."]]);
  assert.equal(f.acts.length, 0, "the dry run doesn't sign anyone off");
  await f.agent.run("orchestrator", "sign_off", { confirm: true, planId: plan.planId });
  // The same input the pill's Sign off sends (client/inbox-store.ts).
  assert.deepEqual(f.acts, [{ action: "sign_off", agentIds: ["a1"], seqs: { a1: 4 } }]);
  assert.deepEqual(f.notes, [{ by: "agent:orchestrator", agentId: "a1", action: "sign_off" }]);
});

test("workspace controls share the panel's mutator and its guards", async t => {
  const f = await fixture(t);
  await f.store.mutate(s => { s.workspaces[0].hold = "Paused"; s.workspaces[0].batches = [{ id: "b1", tasks: [{ key: "k", kind: "conflict", target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint: "f" }], state: "blocked", createdAt: "2026-01-01T09:00:00Z", sentAt: "2026-01-01T09:05:00Z", settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: "main-agent", contextPath: null, activityAt: null } as any]; });
  await f.agent.run("orchestrator", "set_auto_send", { workspace: "workspace", value: true });
  await f.agent.run("orchestrator", "clear_hold", { workspace: "workspace" });
  await f.agent.run("orchestrator", "retry_batch", { workspace: "workspace", batchId: "b1" });
  const w = await f.get();
  assert.equal(w.enable_auto_sends, true); assert.equal(w.hold, null); assert.deepEqual(w.batches.map(b => [b.state, b.attempts]), [["cancelled", 1], ["pending", 2]]);
  assert.deepEqual(f.notes.map(n => n.action), ["set_auto_send", "clear_hold", "retry_batch"]);
  await f.store.mutate(s => { s.workspaces[0].enable_tracking = false; });
  await assert.rejects(f.agent.run("orchestrator", "set_auto_send", { workspace: "workspace", value: false }), /Activate this workspace/);
  assert.throws(() => controlWorkspace({ version: 1, workspaces: [] } as State, { workspaceId: "missing" }));
});

test("an agent's action in the ledger never counts as the developer writing, nor hides the developer's next message", async () => {
  const at = Date.parse("2026-01-01T10:00:00Z");
  const ledger: Ledger = [{ agentId: "a1", messageId: null, at: new Date(at).toISOString(), by: "agent:orchestrator", action: "sign_off" }];
  const sources = { ledger: async () => ledger, defer: async () => false, session: async () => false, schedule: async () => false };
  assert.equal(await classify({ text: "Looks good, ship it", messageId: "m1" } as any, "a1", at + 1_000, sources), "tom", "a nearby agent action isn't mistaken for Follow-up's message");
});

test("decision 3: the brief's own decision isn't repeated as Q1 in the popover's count", () => {
  const q1: NeedItem = { kind: "question", key: "question:Q1", questionId: "Q1", title: "Q1 · Retry policy", detail: "Which policy?", state: "waiting", big: null } as NeedItem;
  const q2: NeedItem = { ...q1, key: "question:Q2", questionId: "Q2", title: "Q2 · Other" } as NeedItem;
  const flagged = { agentId: "main-agent", needs, snooze: null, brief: { kind: "decision", source: "agent", state: "open", ask: "Pick the retry policy", questionIds: ["Q1"] } } as any;
  assert.deepEqual(withoutBriefQuestions([q1, q2], flagged).map(i => i.key), ["question:Q2"]);
  const state = pillState({ row: flagged, items: [q1], recent: null, now: clock });
  assert.equal(state?.mode, "flag"); assert.equal(state && "todo" in state ? state.todo : -1, 0, "only the brief's decision: nothing else to do");
  assert.equal(withoutBriefQuestions([q1], { ...flagged, brief: { ...flagged.brief, state: "answered" } }).length, 1, "once answered, the question is its own item again");
});

test("the bridge offers action tools to Paseo-launched root agents only, honestly annotated, through follow.agent-act", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-agent-mcp-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-through"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces: [] }));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  await writeFile(join(root, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:1" } }));
  const calls = join(root, "calls.jsonl"), client = join(root, "client.mjs");
  await writeFile(client, `import{appendFileSync}from'node:fs';export class DaemonClient{async connect(){}async close(){}async invokePluginRpc(plugin,method,input){appendFileSync(${JSON.stringify(calls)},JSON.stringify({method,input})+'\\n');return{prs:[],workspaces:[]};}}`);
  const ask = (env: Record<string, string>) => new Promise<any[]>((ok, bad) => {
    const child = spawn(process.execPath, [resolve("server/mcp.mjs")], { env: { ...process.env, PASEO_HOME: root, PASEO_AGENT_ID: "orchestrator", FOLLOW_THROUGH_CLIENT_ENTRY: client, FOLLOW_THROUGH_RECOVERY: "", FOLLOW_THROUGH_BRIEF: "", FOLLOW_THROUGH_ROOT: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim().split("\n").map(l => JSON.parse(l))));
    child.stdin.end([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_prs", arguments: { needs_reviewers: true } } }].map(r => JSON.stringify(r)).join("\n") + "\n");
  });
  const on = await ask({ FOLLOW_THROUGH_ROOT: "1" });
  const tools = on[1].result.tools;
  assert.ok(["list_prs", "add_reviewers", "merge", "sign_off", "inbox_list", "send_repairs", "track"].every(n => tools.some((x: any) => x.name === n)));
  const hint = (n: string) => tools.find((x: any) => x.name === n).annotations;
  assert.deepEqual(hint("merge"), { readOnlyHint: false, destructiveHint: true });
  assert.deepEqual(hint("list_prs"), { readOnlyHint: true, destructiveHint: false });
  assert.deepEqual(hint("add_reviewers"), { readOnlyHint: false, destructiveHint: false });
  assert.match(tools.find((x: any) => x.name === "add_reviewers").description, /Only when the developer asked/);
  assert.match(on[0].result.instructions, /assign reviewers on all/);
  assert.deepEqual(JSON.parse((await readFile(calls, "utf8")).trim()), { method: "follow.agent-act", input: { tool: "list_prs", args: { needs_reviewers: true }, agentId: "orchestrator" } });
  for (const env of [{}, { FOLLOW_THROUGH_ROOT: "1", FOLLOW_THROUGH_RECOVERY: "1" }] as Record<string, string>[]) assert.deepEqual((await ask(env))[1].result.tools, [], "no tools for a subagent, an outside session or recovery");
});
