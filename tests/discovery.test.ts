import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDiscovery, applyHistory, extractHistory } from "../server/discovery";
import { MAIN_CLOSED_HANDOVER_MS, chooseMainAgent, successorMainAgent, type Agent } from "../server/daemon";
import { Engine, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import { tasksFor, batchPrompt } from "../server/tasks";
import { completionBlockers, type State } from "../shared/model";
import { clock, workspace, pr, snapshot } from "./fixtures";

test("recovers GitHub and Graphite references without treating mentions as ownership", () => {
  const history = extractHistory([
    { type: "user_message", text: "Follow-up batch fixture-batch\n\n1. Use /fix-pr for example/system#10 (1 open thread)" },
    { type: "user_message", text: "Follow-up recovery fixture-recovery\nEvidence file: /fixture/recovery.json" },
    { type: "user_message", text: "Ship the rollout and verify deployment" },
    { type: "assistant_message", text: "Created https://github.com/example/app/pull/1. Also https://app.graphite.dev/github/pr/example/app/2," },
    { type: "user_message", text: "Reference https://github.com/example/unrelated/pull/7" },
    { type: "reasoning", text: "https://github.com/example/secret/pull/9" },
    { type: "user_message", text: "Workspace Follow-up batch inventory\nhttps://github.com/example/system/pull/10" },
  ]);
  assert.equal(history.goal, "Ship the rollout and verify deployment");
  assert.deepEqual(history.candidates, ["example/app#1", "example/app#2", "example/unrelated#7"]);
  const state: State = { version: 1, workspaces: [] };
  applyDiscovery(state, [{ id: "workspace", title: "Rollout", mainAgentId: "main-agent", messageAt: "first", history }], clock);
  assert.equal(state.workspaces[0].prs.length, 0);
  assert.ok(!completionBlockers(state.workspaces[0], clock).includes("Recover workspace PRs and remaining work"));
});

test("chooses the oldest root deterministically and never substitutes an existing owner", () => {
  const agent = (id: string, createdAt: string) => ({ id, createdAt } as Agent);
  const roots = [agent("secondary", "2026-01-02"), agent("main", "2026-01-01")];
  assert.equal(chooseMainAgent(roots)?.id, "main");
  assert.equal(chooseMainAgent(roots, "secondary")?.id, "secondary");
  assert.equal(chooseMainAgent(roots, "unavailable"), undefined);
});

test("installation and reload are inert; activation and every send require separate clicks", async t => {
  const directory = await mkdtemp(join(tmpdir(), "follow-discovery-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); let now = clock; const messages: string[] = [];
  const gateway: Gateway = {
    prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }),
    discover: async () => [{ id: "workspace", title: "Rollout", mainAgentId: "main-agent", messageAt: null, history: extractHistory([]) }],
    observe: async () => ({ busy: false, reason: null, archived: false }),
    send: async (_w, _b, text) => { messages.push(text); }, label: async () => {},
  };
  const github = { observe: async () => new Map() };
  const engine = new Engine(store, github, gateway, () => now);
  await engine.tick(); assert.equal((await store.snapshot()).workspaces.length, 0); const first = await engine.activate("workspace");
  assert.equal(first.mainAgentId, "main-agent"); assert.equal(first.enable_tracking, true); assert.equal(first.batches.length, 0);
  now += 61_000; await engine.tick(); assert.equal(messages.length, 0); await engine.startRecovery("workspace");
  for (let i = 0; messages.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.length, 1); assert.match(messages[0], /separate inventory agent/);
  await engine.acknowledge("recovery-agent", (await store.snapshot()).workspaces[0].batches[0].id, "completed", "Reconciled conversation, no PRs produced yet");
  const restarted = new Engine(new Store(directory), github, gateway, () => now); await restarted.recover(); await restarted.tick();
  assert.equal(messages.length, 1); assert.equal((await store.snapshot()).workspaces.length, 1);
});

test("new candidates remain unowned while recovery is optional", () => {
  const state: State = { version: 1, workspaces: [] };
  applyDiscovery(state, [{ id: "workspace", title: "Rollout", mainAgentId: "main-agent", messageAt: "first", history: extractHistory([]) }], clock);
  const w = state.workspaces[0]; const dispatchedRevision = w.inventory!.revision;
  applyHistory(w, extractHistory([{ type: "assistant_message", text: "https://github.com/example/app/pull/2" }]), "second");
  w.inventory!.syncedRevision = dispatchedRevision;
  assert.ok(w.inventory!.revision > w.inventory!.syncedRevision);
  assert.deepEqual(tasksFor(w), []);
  assert.equal(w.prs.length, 0);
  const batch = { id: "batch", tasks: [{ kind: "inventory", title: "Recover workspace PR stacks and remaining work" }] } as any;
  assert.match(batchPrompt(w, batch), /not proof of ownership/);
});

test("settled PRs trigger completion verification rather than Done or a human prompt", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], inventory: { revision: 1, syncedRevision: 1, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } });
  assert.deepEqual(tasksFor(w).map(t => t.kind), ["completion"]); assert.equal(w.completion, null);
  w.runtimeBusy = true; assert.equal(tasksFor(w).length, 0, "let the active owner declare Done directly");
  w.runtimeBusy = false; w.obligations.push({ id: "deploy", title: "Verify deployed revision", status: "waiting", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0 });
  assert.equal(tasksFor(w).length, 0, "unfinished deployment work still blocks completion");
});


test("Track returns after persistence while unrelated global observation is still pending", async t => {
  const directory = await mkdtemp(join(tmpdir(), "follow-track-latency-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gateway: Gateway = {
    discover: async () => [{ id: "workspace", title: "Independent task", mainAgentId: "main-agent", messageAt: null }],
    observe: async () => { entered(); await pending; return { busy: false, reason: null, archived: false }; },
    send: async () => { throw new Error("Track must not send a message"); }, label: async () => {},
    prepareRecovery: async () => { throw new Error("Track must not start recovery"); },
  };
  const engine = new Engine(store, { observe: async () => new Map() }, gateway);
  const activation = engine.activate("workspace");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    const w = await Promise.race([activation, new Promise<never>((_ok, reject) => { timer = setTimeout(() => reject(new Error("Track waited for the global refresh")), 500); })]);
    assert.equal(w.enable_tracking, true); assert.equal(w.enable_auto_sends, true, "first tracking sends repairs to the agent on its own");
    assert.equal((await store.snapshot()).workspaces[0].mainAgentId, "main-agent");
  } finally { if (timer) clearTimeout(timer); release(); await activation; await engine.tick(); }
});

test("a long-closed or gone main agent hands over to the workspace's live root; a live or briefly closed main is never replaced", () => {
  const agent = (id: string, status: string, createdAt: string, lastUserMessageAt: string | null = null) => ({ id, status, createdAt, lastUserMessageAt } as Agent);
  const closedMain = agent("old-main", "closed", "2026-09-22");
  const live = agent("live", "idle", "2026-10-01", "2026-11-08T15:00:00Z");
  const quiet = agent("quiet", "idle", "2026-10-05");
  const now = Date.parse("2026-11-09T22:00:00Z");
  const longAgo = new Date(now - MAIN_CLOSED_HANDOVER_MS).toISOString(); const lately = new Date(now - MAIN_CLOSED_HANDOVER_MS + 1).toISOString();
  assert.equal(successorMainAgent([closedMain, live], "old-main", longAgo, now)?.id, "live");
  assert.equal(successorMainAgent([closedMain, live], "old-main", lately, now), undefined, "closed for less than the handover time");
  assert.equal(successorMainAgent([closedMain, live], "old-main", undefined, now), undefined, "a close discovery hasn't timed yet");
  assert.equal(successorMainAgent([live], "old-main", undefined, now)?.id, "live", "a main missing from the index (archived or gone) hands over at once");
  assert.equal(successorMainAgent([closedMain, quiet, live], "old-main", longAgo, now)?.id, "live", "the one the developer wrote to last wins");
  assert.equal(successorMainAgent([agent("old-main", "idle", "2026-09-22"), live], "old-main", longAgo, now), undefined, "a live main keeps the workspace");
  assert.equal(successorMainAgent([closedMain], "old-main", longAgo, now), undefined, "no live root, no handover");
  assert.equal(successorMainAgent([live], undefined), undefined);
});

test("applyDiscovery adopts a live successor only for the main agent it replaces", () => {
  const clock = Date.parse("2026-11-08T15:00:00Z");
  const state = { version: 1, workspaces: [] } as unknown as Parameters<typeof applyDiscovery>[0];
  applyDiscovery(state, [{ id: "w", title: "W", mainAgentId: "old-main", messageAt: null }], clock);
  const w = state.workspaces[0]; w.runtimeReason = "Main agent is unavailable or moved to another workspace";
  applyDiscovery(state, [{ id: "w", title: "W", mainAgentId: "live", messageAt: null, replacesMainAgentId: "someone-else" }], clock);
  assert.equal(w.mainAgentId, "old-main", "a successor for a different owner is ignored");
  applyDiscovery(state, [{ id: "w", title: "W", mainAgentId: "live", messageAt: null, replacesMainAgentId: "old-main" }], clock);
  assert.equal(w.mainAgentId, "live"); assert.equal(w.runtimeReason, null);
});
