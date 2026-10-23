import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, agentWorkspace, interruptionHold, type Runtime, type Gateway } from "../server/engine";
import { DeliveryDeferred } from "../server/delivery";
import { Store } from "../server/store";
import { summary, type Workspace, type Snapshot } from "../shared/model";
import { batchPrompt, tasksFor } from "../server/tasks";
import { clock, workspace, pr, snapshot } from "./fixtures";

async function fixture(t: any, w = workspace()) {
  const root = await mkdtemp(join(tmpdir(), "follow-test-"));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; let state: Runtime = { busy: false, reason: null, archived: false }; let failSend = false; let failGithub = false;
  const observations = new Map(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: string[] = []; const labels: boolean[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }), observe: async () => state, send: async (_w, _b, text) => { sends.push(text); if (failSend) throw new Error("lost ack"); }, label: async (_w, assigned) => { labels.push(assigned); } };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, failGithub ? { snapshot: null, error: "offline" } : { snapshot: { ...observations.get(p.key)!, observedAt: new Date(now).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  return { store, engine, sends, labels, gateway, github, root, send: async () => { const w = (await store.snapshot()).workspaces[0]; const b = w.batches.find(b => b.state === "pending"); if (!b) throw new Error("No pending batch"); return engine.sendPending(w.id, b.id); }, get: async () => (await store.snapshot()).workspaces[0], advance: (ms: number) => { now += ms; }, runtime: (s: Runtime) => { state = s; }, observe: (key: string, s: Snapshot) => observations.set(key, s), failSend: () => { failSend = true; }, offline: () => { failGithub = true; } };
}
test("batches several stacks and sends only after an explicit click", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) }), pr({ key: "example/app#2", number: 2, stack: "CLI access", snapshot: snapshot({ threads: [{ id: "thread", updatedAt: "fixed-time" }] }) })] }));
  await f.engine.tick(); assert.equal(f.sends.length, 0); assert.equal((await f.get()).batches[0].tasks.length, 2);
  f.advance(61_000); await Promise.all([f.engine.tick(), f.engine.tick()]); assert.equal(f.sends.length, 0); await f.send(); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0], `Follow-through batch ${(await f.get()).batches[0].id}\n\n1. Resolve merge conflicts on example/app#1\n2. Use /fix-pr for example/app#2 (1 open thread)`);
  await f.engine.tick(); assert.equal(f.sends.length, 1);
});
test("single-PR repairs omit historical context and retain an acknowledgeable batch identity", async t => {
  const f = await fixture(t, workspace({ goal: "Historical goal with several previous stacks. ".repeat(40), prs: [pr({ snapshot: snapshot({ threads: [{ id: "review", updatedAt: "time" }] }) })] }));
  await f.engine.tick(); await f.send(); const delivered = (await f.get()).batches[0];
  assert.equal(f.sends[0], `Follow-through batch ${delivered.id}\n\n1. Use /fix-pr for example/app#1 (1 open thread)`);
  const batchId = /^Follow-through batch ([^\n]+)/.exec(f.sends[0])![1];
  await f.engine.acknowledge("main-agent", batchId, "completed", "Validated feedback and resolved the thread");
  assert.equal((await f.get()).batches[0].state, "completed");
  await f.engine.tick(); assert.equal(f.sends.length, 1, "format changes must not bypass delivery deduplication");
});
test("review tasks explain singular, plural and changes-requested feedback", () => {
  const title = (s: Partial<Snapshot>) => tasksFor(workspace({ prs: [pr({ snapshot: snapshot(s) })] }), clock).find(t => t.kind === "review")!.title;
  assert.equal(title({ threads: [{ id: "first", updatedAt: "time" }] }), "Use /fix-pr for example/app#1 (1 open thread)");
  assert.equal(title({ threads: [{ id: "first", updatedAt: "time" }, { id: "second", updatedAt: "time" }] }), "Use /fix-pr for example/app#1 (2 open threads)");
  assert.equal(title({ reviewDecision: "CHANGES_REQUESTED" }), "Use /fix-pr for example/app#1 (changes requested)");
});
test("busy agents, pauses, and background work keep batches queued", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000);
  f.runtime({ busy: true, reason: null, archived: false, backgroundBusy: true }); await f.engine.tick();
  f.runtime({ busy: false, reason: "Session Guard paused", archived: false }); await f.engine.tick(); assert.equal(f.sends.length, 0);
  await assert.rejects(f.send(), /paused/); f.runtime({ busy: false, reason: null, archived: false }); await f.engine.tick(); assert.equal(f.sends.length, 0); await f.send(); assert.equal(f.sends.length, 1);
});
test("Auto waits through Session Guard pause and resumed work, then sends the same batch once", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  f.runtime({ busy: false, reason: "Waiting for Session Guard to resume this workspace", guarded: true, archived: false });
  await f.engine.tick(); const original = (await f.get()).batches[0]; f.advance(3_600_000); await f.engine.tick();
  assert.equal((await f.get()).batches[0].state, "pending"); assert.equal(f.sends.length, 0);
  f.runtime({ busy: true, reason: null, archived: false }); await f.engine.tick(); assert.equal(f.sends.length, 0);
  f.runtime({ busy: false, reason: null, archived: false }); await f.engine.tick(); await f.engine.tick();
  const delivered = (await f.get()).batches[0]; assert.equal(delivered.id, original.id); assert.equal(delivered.messageId, original.messageId); assert.equal(delivered.state, "sent"); assert.equal(f.sends.length, 1);
});
test("a definite preflight deferral stays pending across restart without enabling Auto", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); const original = (await f.get()).batches[0];
  f.gateway.send = async () => { throw new DeliveryDeferred("Waiting for Session Guard to resume this workspace"); };
  await f.send(); assert.equal((await f.get()).batches[0].state, "pending"); assert.equal((await f.get()).batches[0].sentAt, null);
  f.gateway.send = async (_w, _b, text) => { f.sends.push(text); };
  const restarted = new Engine(f.store, f.github, f.gateway, () => clock + 61_000); await restarted.recover(); await restarted.tick();
  assert.equal(f.sends.length, 0); assert.equal((await f.get()).enable_auto_sends, false);
  await restarted.sendPending("workspace", original.id); assert.equal(f.sends.length, 1); assert.equal((await f.get()).batches[0].messageId, original.messageId);
});
test("a long guard pause preserves delivered receipts and grants a fresh acknowledgment interval after resume", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); await f.send(); const original = (await f.get()).batches[0];
  f.runtime({ busy: false, reason: "Waiting for Session Guard to resume this workspace", guarded: true, archived: false });
  f.advance(14_400_000); await f.engine.tick(); assert.equal((await f.get()).batches[0].state, "sent");
  f.runtime({ busy: false, reason: null, archived: false }); await f.engine.tick();
  f.advance(119_000); await f.engine.tick(); assert.equal((await f.get()).batches[0].state, "sent");
  f.advance(2_000); await f.engine.tick(); assert.equal((await f.get()).batches[0].state, "blocked");
  assert.equal((await f.get()).batches[0].sentAt, original.sentAt); assert.equal(f.sends.length, 1);
});
test("only an evidenced Guard interruption clears its generated hold; unproven and explicit holds survive", async t => {
  const f = await fixture(t, workspace({ hold: interruptionHold("failed"), interruption: { turnId: "turn", at: new Date(clock).toISOString(), kind: "failed" }, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  f.runtime({ busy: false, reason: "Waiting for Session Guard to resume this workspace", guarded: true, guardedInterruptionId: "matching-pause", archived: false });
  await f.engine.tick(); assert.equal((await f.get()).hold, null); assert.equal((await f.get()).interruption!.guardPauseId, "matching-pause"); assert.equal(f.sends.length, 0);
  await f.store.mutate(s => { s.workspaces[0].hold = "You explicitly stopped follow-up"; }); await f.engine.tick(); assert.equal((await f.get()).hold, "You explicitly stopped follow-up");
  await f.store.mutate(s => { s.workspaces[0].hold = interruptionHold("failed"); delete s.workspaces[0].interruption; }); await f.engine.tick(); assert.equal((await f.get()).hold, interruptionHold("failed"));
});
test("rescinds conditions resolved before delivery", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000); f.observe("example/app#1", snapshot()); await f.engine.tick();
  assert.equal(f.sends.length, 0); assert.equal((await f.get()).batches[0].state, "cancelled");
});
test("new feedback during a repair forms the next batch without a concurrent send", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000); await f.send();
  f.observe("example/app#1", snapshot({ conflict: true, threads: [{ id: "new", updatedAt: "fixed-time" }] })); await f.engine.tick();
  assert.equal(f.sends.length, 1); assert.equal((await f.get()).batches.filter(b => b.state === "pending").length, 1);
  await f.engine.acknowledge("main-agent", (await f.get()).batches[0].id, "completed", "Conflict resolved");
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1); await f.send(); assert.equal(f.sends.length, 2);
});
test("uncertain delivery and restart never resend automatically", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000); f.failSend(); await f.send();
  assert.equal((await f.get()).batches[0].state, "uncertain"); await f.engine.tick(); assert.equal(f.sends.length, 1);
  await f.store.mutate(s => { s.workspaces[0].batches[0].state = "sending"; });
  const restarted = new Engine(f.store, f.github, f.gateway, () => clock + 62_000); await restarted.recover(); await restarted.tick();
  assert.equal(f.sends.length, 1); assert.equal(summary(await f.get(), clock + 62_000).status, "needs-you");
});
test("merged PRs retain history and cannot complete outstanding deployment work", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], obligations: [{ id: "deploy", title: "Verify deployed revision", status: "waiting", afterPrs: ["example/app#1"], evidence: "", enable_follow_up: false, revision: 0 }] }));
  const result = await f.engine.declareDone("main-agent", "Finished"); assert.deepEqual(result.blockers, ["Verify deployed revision"]); assert.equal(result.workspace.prs.length, 1); assert.equal(result.workspace.completion, null);
});
test("dependency settlement queues a deploy check but requires a click to send", async t => {
  const f = await fixture(t, workspace({ obligations: [{ id: "deploy", title: "Verify deployed revision", status: "waiting", afterPrs: ["example/app#1"], evidence: "", trigger: { event: "merge", delayDays: 0 }, enable_follow_up: true, dependencyStage: "merged", revision: 0 }] }));
  await f.engine.tick(); assert.equal((await f.get()).batches.length, 0);
  f.observe("example/app#1", snapshot({ state: "MERGED" })); await f.engine.tick(); f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 0); await f.send(); assert.equal(f.sends.length, 1); assert.match(f.sends[0], /Verify deployed revision/);
  assert.equal(f.sends[0], `Follow-through batch ${(await f.get()).batches[0].id}\n\n1. Verify deployed revision`);
});
test("Done requires agent declaration and settles only after foreground work ends", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] }));
  await f.engine.tick(); assert.equal(f.labels.length, 0);
  f.runtime({ busy: true, reason: null, archived: false }); const result = await f.engine.declareDone("main-agent", "Shipped and verified"); assert.equal(result.blockers.length, 0); await f.engine.tick(); assert.equal(f.labels.length, 0);
  f.runtime({ busy: false, reason: null, archived: false }); await f.engine.tick(); assert.equal(f.labels.at(-1), true); assert.equal(summary(await f.get(), clock).status, "done");
  await f.store.mutate(s => { s.workspaces[0].completion = null; }); await f.engine.tick(); assert.equal(f.labels.at(-1), false);
});
test("Auto queues once after actual deployment, never merely after merge", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, obligations: [{ id: "verify", title: "Verify the production fix", status: "waiting", afterPrs: ["example/app#1"], dependencyStage: "deployed", trigger: { event: "deploy", delayDays: 0 }, enable_follow_up: true, revision: 0, evidence: "" }] }));
  await f.engine.tick(); assert.equal((await f.get()).batches.length, 0);
  f.observe("example/app#1", snapshot({ state: "MERGED" })); await f.engine.tick(); assert.equal((await f.get()).batches.length, 0);
  f.observe("example/app#1", snapshot({ state: "MERGED", deployment: { state: "deployed", environment: "production", commits: ["serving-commit"], evidence: "All serving images contain the merge", observedAt: new Date(clock).toISOString() } }));
  await f.engine.tick(); assert.equal((await f.get()).batches[0].tasks[0].kind, "obligation"); assert.equal(f.sends.length, 0);
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1); await f.engine.tick(); assert.equal(f.sends.length, 1);
});
test("a rollback before delivery cancels the post-deploy batch", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, obligations: [{ id: "verify", title: "Verify the production fix", status: "waiting", afterPrs: ["example/app#1"], dependencyStage: "deployed", trigger: { event: "deploy", delayDays: 0 }, enable_follow_up: true, revision: 0, evidence: "" }] }));
  f.observe("example/app#1", snapshot({ state: "MERGED", deployment: { state: "deployed", environment: "production", commits: ["serving-commit"], evidence: "Serving", observedAt: new Date(clock).toISOString() } })); await f.engine.tick();
  f.observe("example/app#1", snapshot({ state: "MERGED", deployment: { state: "pending", environment: "production", commits: ["older-commit"], evidence: "Rolled back", observedAt: new Date(clock).toISOString() } })); f.advance(61_000); await f.engine.tick();
  assert.equal((await f.get()).batches[0].state, "cancelled"); assert.equal(f.sends.length, 0);
});
test("background work, unknown PR state, and closed PR without disposition block Done", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ state: "CLOSED" }) })] }));
  f.runtime({ busy: true, reason: null, archived: false, backgroundBusy: true });
  const result = await f.engine.declareDone("main-agent", "Finished"); assert.ok(result.blockers.some(b => b.includes("disposition"))); assert.ok(result.blockers.some(b => b.includes("background")));
  f.offline(); const offline = await f.engine.declareDone("main-agent", "Finished"); assert.ok(offline.blockers.some(b => b.includes("Refresh")));
});
test("explicit stop and archived workspaces reject clicked sends", async t => {
  const f = await fixture(t, workspace({ hold: "You stopped the agent", prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 0); await assert.rejects(f.send(), /stopped/);
  await f.store.mutate(s => { s.workspaces[0].hold = null; s.workspaces[0].archived = true; }); await f.engine.tick(); assert.equal(f.sends.length, 0);
});
test("the main agent must own acknowledgments and completion", async t => {
  const f = await fixture(t); await assert.rejects(f.engine.declareDone("other-agent", "Finished"), /main agent/); await assert.rejects(f.engine.acknowledge("other-agent", "batch", "completed", "Fixed"), /main agent/);
});
test("manually registered review feedback queues without recovery, including unresolved historical candidates", async t => {
  const f = await fixture(t, workspace({ inventory: { revision: 2, syncedRevision: 0, candidates: ["example/app#1", "example/unrelated#7"], historyComplete: true, historyError: null, scannedMessageAt: null }, prs: [pr(), pr({ key: "example/app#2", number: 2, parent: "example/app#1", snapshot: snapshot({ threads: [{ id: "review", updatedAt: "time" }] }) })] }));
  await f.engine.tick(); const w = await f.get(); assert.deepEqual(w.batches[0].tasks.map(t => [t.kind, t.target]), [["review", "example/app#2"]]);
  assert.equal(w.prs.length, 2); assert.equal(w.inventory!.syncedRevision, 0); assert.equal(f.sends.length, 0);
});
test("main-agent Done does not require a recovery acknowledgment", async t => {
  const f = await fixture(t, workspace({ inventory: { revision: 2, syncedRevision: 0, candidates: ["example/unrelated#7"], historyComplete: true, historyError: null, scannedMessageAt: null }, prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] }));
  const result = await f.engine.declareDone("main-agent", "All owned work verified manually"); assert.equal(result.blockers.length, 0); assert.ok(result.workspace.completion);
});
test("recovery is click-only, repeatable and independent of main-agent busy state and hold", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, hold: "You stopped the main agent", prs: [pr()] }));
  f.runtime({ busy: true, reason: "Main agent paused", archived: false }); await f.engine.tick(); assert.equal(f.sends.length, 0);
  await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  const first = (await f.get()).batches.find(b => b.tasks.every(t => t.kind === "inventory"))!;
  assert.equal(first.state, "sent"); assert.equal(f.sends.length, 1); await assert.rejects(f.engine.startRecovery("workspace"), /existing recovery/);
  await f.engine.acknowledge("recovery-agent", first.id, "completed", "Inventory checked"); await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length < 2 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sends.length, 2); assert.equal((await f.get()).hold, "You stopped the main agent"); assert.equal((await f.get()).mainAgentId, "main-agent");
});
test("an optional recovery failure does not block a clicked repair", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ threads: [{ id: "review", updatedAt: "time" }] }) })] }));
  f.gateway.prepareRecovery = async () => { throw Error("Read-only inventory unavailable"); }; await f.engine.startRecovery("workspace");
  for (let i = 0; !(await f.get()).batches.some(b => b.state === "blocked") && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  await f.engine.tick(); await f.send(); assert.equal(f.sends.length, 1); assert.match(f.sends[0], /fix-pr/); assert.equal((await f.get()).hold, null);
});
test("old queued recovery migrates to history without reviving Auto or losing ownership", async t => {
  const f = await fixture(t); await f.engine.startRecovery("workspace");
  for (let i = 0; (await f.get()).batches[0].state !== "sent" && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  await f.store.mutate(s => { s.workspaces[0].batches[0].state = "pending"; delete s.workspaces[0].batches[0].enable_manual_recovery; s.workspaces[0].batches[0].sentAt = null; s.workspaces[0].hold = "Recovery stopped or failed. Check the recovery agent before retrying."; });
  await f.engine.recover(); const w = await f.get(); assert.equal(w.batches[0].state, "cancelled"); assert.equal(w.hold, null); assert.equal(w.mainAgentId, "main-agent"); assert.equal(w.enable_auto_sends, false);
});
test("an active recovery does not time out or block independent Auto repairs", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  f.gateway.recoveryRuntime = async () => ({ busy: true, reason: null }); await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  await f.engine.tick(); f.advance(181_000); await f.engine.tick(); const w = await f.get();
  assert.equal(f.sends.length, 2); assert.equal(w.batches.find(b => b.tasks[0].kind === "inventory")!.state, "sent"); assert.equal(w.batches.find(b => b.tasks[0].kind === "conflict")!.state, "sent");
});
test("serialized atomic writes preserve concurrent updates and survive reconstruction", async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 20 }, (_, i) => f.store.mutate(s => { s.workspaces[0].obligations.push({ id: `task-${i}`, title: `Task ${i}`, status: "pending", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0 }); })));
  const reloaded = new Store(f.root); assert.equal((await reloaded.snapshot()).workspaces[0].obligations.length, 20); assert.equal(JSON.parse(await readFile(join(f.root, "state.json"), "utf8")).version, 1);
});
test("dependency prompts process the parent before the child", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ key: "example/app#2", number: 2, parent: "example/app#1", snapshot: snapshot({ conflict: true }) }), pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); const w = await f.get(); const text = batchPrompt(w, w.batches[0]); assert.ok(text.indexOf("1. Resolve merge conflicts on example/app#1") < text.indexOf("2. Resolve merge conflicts on example/app#2"));
});

test("an agent can acknowledge and declare Done while delivery waits for its turn", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], inventory: { revision: 1, syncedRevision: 1, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  f.gateway.send = async (_w, batch, text) => {
    assert.equal(text, `Follow-through batch ${batch.id}\n\n1. Verify the workspace is finished and declare Done`);
    f.runtime({ busy: true, reason: null, archived: false });
    await f.engine.acknowledge("main-agent", batch.id, "completed", "Recovered and verified all historical work");
    const result = await f.engine.declareDone("main-agent", "Shipped and verified");
    assert.deepEqual(result.blockers, []);
    f.runtime({ busy: false, reason: null, archived: false });
  };
  await f.engine.tick(); f.advance(61_000);
  await Promise.race([f.send(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Completion deadlocked delivery")), 2000); timer.unref(); })]);
  assert.ok((await f.get()).completion); await f.engine.tick(); assert.equal(f.labels.at(-1), true);
});

test("legacy automatic flags never activate tracking or dispatch on load", async t => {
  const legacy: any = workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] });
  delete legacy.enable_tracking; legacy.enable_auto_follow_up = true;
  const f = await fixture(t, legacy); let discovered = 0;
  f.gateway.discover = async () => { discovered++; return []; };
  await f.engine.recover(); await f.engine.tick(); f.advance(3_600_000); await f.engine.tick();
  assert.equal((await f.get()).enable_tracking, false); assert.equal(discovered, 2, "read-only project discovery must not restore legacy enrollment"); assert.equal(f.sends.length, 0); assert.equal(f.labels.length, 0);
});

test("two simultaneous clicks cannot deliver the same batch twice", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); const outcomes = await Promise.allSettled([f.send(), f.send()]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.sends.length, 1);
});

test("Auto sends after quiet only in the explicitly enabled workspace", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.store.mutate(s => {
    s.workspaces.push(workspace({ id: "manual-workspace", mainAgentId: "manual-agent", enable_auto_sends: false, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
    s.workspaces.push(workspace({ id: "inactive-workspace", mainAgentId: "inactive-agent", enable_tracking: false, enable_auto_sends: true }));
  });
  await f.engine.tick(); f.advance(30_000); await f.engine.tick(); assert.equal(f.sends.length, 0);
  f.advance(31_000); await f.engine.tick(); assert.equal(f.sends.length, 1);
  const rows = (await f.store.snapshot()).workspaces;
  assert.equal(rows[0].batches[0].state, "sent"); assert.equal(rows[1].batches[0].state, "pending"); assert.equal(rows[2].batches.length, 0);
  await f.engine.tick(); assert.equal(f.sends.length, 1);
});

test("turning Auto off during the final runtime check prevents delivery", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick(); f.advance(61_000);
  f.gateway.observe = async (_w, fresh) => {
    if (fresh) await f.store.mutate(s => { s.workspaces[0].enable_auto_sends = false; });
    return { busy: false, reason: null, archived: false };
  };
  await f.engine.tick(); assert.equal(f.sends.length, 0); assert.equal((await f.get()).batches[0].state, "pending");
});

test("recovery is isolated, scoped to metadata, and never transfers the main agent's ownership", async t => {
  const f = await fixture(t, workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })], inventory: { revision: 1, syncedRevision: 0, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  await f.engine.tick(); assert.deepEqual((await f.get()).batches[0].tasks.map(t => t.kind), ["conflict"]);
  await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  const recovery = (await f.get()).batches.find(b => b.tasks.every(t => t.kind === "inventory"))!;
  assert.equal(recovery.recipientAgentId, "recovery-agent"); assert.equal((await f.get()).mainAgentId, "main-agent");
  assert.match(f.sends[0], /Read-only inventory/); assert.doesNotMatch(f.sends[0], /\/fix-pr/);
  assert.equal(agentWorkspace(await f.store.snapshot(), "recovery-agent").id, "workspace");
  await assert.rejects(f.engine.declareDone("recovery-agent", "Done"), /main agent/);
  await assert.rejects(f.engine.acknowledge("main-agent", recovery.id, "completed", "Recovered"), /assigned agent/);
  await f.engine.acknowledge("recovery-agent", recovery.id, "completed", "Owned stacks and deploy work recovered");
  assert.throws(() => agentWorkspace({ version: 1, workspaces: [recoveryWorkspace()] }, "recovery-agent"));
  function recoveryWorkspace(): Workspace { return workspace({ batches: [{ ...recovery, state: "completed" }] }); }
  await f.engine.tick(); await f.send(); const repair = (await f.get()).batches.find(b => b.tasks.some(t => t.kind === "conflict"))!;
  assert.equal(repair.recipientAgentId, "main-agent"); assert.equal(f.sends.at(-1)!, `Follow-through batch ${repair.id}\n\n1. Resolve merge conflicts on example/app#1`);
  await assert.rejects(f.engine.acknowledge("recovery-agent", repair.id, "completed", "Fixed"), /assigned agent/);
});

test("recovery preparation failures surface without claiming a message was delivered", async t => {
  const f = await fixture(t, workspace({ inventory: { revision: 1, syncedRevision: 0, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  f.gateway.prepareRecovery = async () => { throw new Error("Provider unavailable"); };
  await f.engine.tick(); await f.engine.startRecovery("workspace");
  for (let i = 0; !(await f.get()).batches.some(b => b.state === "blocked") && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sends.length, 0);
  assert.equal((await f.get()).batches[0].state, "blocked");
  assert.match((await f.get()).batches[0].result, /Provider unavailable/);
});

test("recovered research with no PRs still requires the main agent to verify completion", async t => {
  const f = await fixture(t, workspace({ prs: [], inventory: { revision: 1, syncedRevision: 0, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  await f.engine.tick(); await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  const inventory = (await f.get()).batches[0];
  await f.engine.acknowledge("recovery-agent", inventory.id, "completed", "Research requirements recovered; no workspace-owned PRs");
  await f.engine.tick(); assert.equal((await f.get()).completion, null);
  const pending = (await f.get()).batches.find(b => b.state === "pending")!;
  assert.deepEqual(pending.tasks.map(t => t.kind), ["completion"]);
  await f.send(); assert.equal((await f.get()).batches.at(-1)!.recipientAgentId, "main-agent");
});

test("a recovery timeout does not revoke unfinished bookkeeping, but an acknowledged block does", async t => {
  const f = await fixture(t, workspace({ inventory: { revision: 1, syncedRevision: 0, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  await f.engine.tick(); await f.engine.startRecovery("workspace");
  for (let i = 0; f.sends.length === 0 && i < 40; i++) await new Promise(r => setTimeout(r, 10));
  await f.store.mutate(s => { s.workspaces[0].batches[0].state = "blocked"; });
  assert.equal(agentWorkspace(await f.store.snapshot(), "recovery-agent", "write").id, "workspace");
  const batch = (await f.get()).batches[0];
  await f.engine.acknowledge("recovery-agent", batch.id, "blocked", "A developer decision is required");
  const state = await f.store.snapshot();
  assert.throws(() => agentWorkspace(state, "recovery-agent", "write"));
});
test("Auto and clicked repairs exclude manual and future tasks, including stale pending tasks after reload", async t => {
  const future = { id: "later", title: "Recheck production behavior in two weeks", status: "waiting" as const, afterPrs: [], evidence: "Existing evidence", enable_follow_up: true, revision: 0 };
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ threads: [{ id: "review", updatedAt: "now" }] }) })], obligations: [future] }));
  await f.engine.tick(); const queued = (await f.get()).batches[0];
  await f.store.mutate(s => { s.workspaces[0].batches[0].tasks.push({ kind: "obligation", key: "obligation:later", target: "later", title: future.title, fingerprint: "legacy" }); });
  await f.engine.recover(); const recovered = (await f.get()).batches[0];
  assert.equal(recovered.id, queued.id); assert.deepEqual(recovered.tasks.map(t => t.kind), ["review"]);
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1); assert.doesNotMatch(f.sends[0], /two weeks/);
  const saved = await f.get(); assert.deepEqual(saved.obligations[0], future);
  await f.engine.acknowledge("main-agent", queued.id, "completed", "Review fixed; future task retained");
  await f.engine.tick(); assert.equal(f.sends.length, 1);
});
test("a fourteen-day merge trigger queues at its due time and dispatches only once across restart", async t => {
  const delay = 14 * 86_400_000;
  const f = await fixture(t, workspace({ enable_auto_sends: true, obligations: [{ id: "later", title: "Recheck behavior", status: "waiting", afterPrs: ["example/app#1"], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "merge", delayDays: 14 } }] }));
  f.observe("example/app#1", snapshot({ state: "MERGED", mergedAt: new Date(clock).toISOString() }));
  await f.engine.tick(); assert.equal((await f.get()).batches.length, 0);
  f.advance(delay - 1); await f.engine.tick(); assert.equal((await f.get()).batches.length, 0);
  f.advance(1); await f.engine.tick(); const queued = (await f.get()).batches[0]; assert.equal(queued.state, "pending");
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1);
  const restarted = new Engine(f.store, f.github, f.gateway, () => clock + delay + 61_000);
  await restarted.recover(); await restarted.tick(); assert.equal(f.sends.length, 1);
});
test("a fourteen-day deploy task keeps its clock through engine recovery and waits for current serving evidence", async t => {
  const delay = 14 * 86_400_000;
  const deployed = (at: number) => snapshot({ state: "MERGED", mergeCommit: "squash-commit", deployment: { state: "deployed", environment: "production", commits: ["serving-commit"], evidence: "Current serving images contain the merge", observedAt: new Date(at).toISOString() } });
  const f = await fixture(t, workspace({ enable_auto_sends: true, obligations: [{ id: "later", title: "Recheck production behavior", status: "waiting", afterPrs: ["example/app#1"], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "deploy", delayDays: 14 } }] }));
  f.observe("example/app#1", deployed(clock)); await f.engine.tick();
  const anchor = (await f.get()).prs[0].deploymentAnchor;
  f.advance(delay); await f.engine.recover(); await f.engine.tick();
  assert.equal((await f.get()).batches.length, 0, "stale deployment cannot release a due task");
  f.observe("example/app#1", deployed(clock + delay)); await f.engine.tick();
  assert.deepEqual((await f.get()).prs[0].deploymentAnchor, anchor);
  assert.equal((await f.get()).batches[0].state, "pending");
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1);
  await f.engine.recover(); await f.engine.tick(); assert.equal(f.sends.length, 1);
});
