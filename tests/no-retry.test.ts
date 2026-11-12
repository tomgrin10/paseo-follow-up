import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Runtime, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import type { Snapshot, Workspace } from "../shared/model";
import { needsYou } from "../shared/attention";
import { violations } from "../shared/status-invariants";
import { pruneUnsent } from "../server/batch-archive";
import { clock, workspace, pr, snapshot } from "./fixtures";

// Q50, 2026-11-12: no routine Retry. A turn that ends without acknowledge_batch is settled from GitHub; still-open
// tasks ride the next message; the same unchanged condition stops after two sends and asks the developer.

async function fixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-noretry-"));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; const state: Runtime = { busy: false, reason: null, archived: false }; let arrived: boolean | null = null;
  const observations = new Map(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: { messageId: string; text: string }[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery", contextPath: "/fixture/recovery.json" }), observe: async () => state,
    send: async (_w, b, text) => { sends.push({ messageId: b.messageId, text }); }, label: async () => {}, arrived: async () => arrived,
    recoveryRuntime: async () => ({ busy: false, reason: null }) };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...observations.get(p.key)!, observedAt: new Date(now).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  const get = async () => (await store.snapshot()).workspaces[0];
  return { engine, sends, get, store, now: () => now, advance: (ms: number) => { now += ms; }, observe: (key: string, s: Snapshot) => observations.set(key, s), arrived: (a: boolean | null) => { arrived = a; } };
}
const conflicted = () => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] });
/** Queue, settle and auto-send one batch, then let the agent sit idle past the acknowledgment window. */
async function sendAndGoQuiet(f: Awaited<ReturnType<typeof fixture>>) {
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  f.advance(121_000); await f.engine.tick();
}

test("a turn that ends without an acknowledgment, with GitHub cleared, closes as done", async t => {
  const f = await fixture(t, conflicted());
  await f.engine.tick(); f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 1);
  f.observe("example/app#1", snapshot()); f.advance(121_000); await f.engine.tick();
  const w = await f.get();
  assert.equal(w.batches[0].state, "completed"); assert.equal(w.batches[0].unacknowledged, true);
  assert.match(w.batches[0].result, /GitHub no longer shows these/);
  assert.equal(w.batches.filter(b => b.state === "pending").length, 0);
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "retry"), "no Retry");
});

test("still open: rides the next message; after two sends that one task waits for you and the queue keeps moving (Q49)", async t => {
  const f = await fixture(t, conflicted());
  await sendAndGoQuiet(f);
  let w = await f.get();
  assert.equal(w.batches[0].state, "completed"); assert.match(w.batches[0].result, /1 still open goes in the next message/);
  assert.ok(!needsYou(w, f.now()).some(i => i.kind === "capped" || i.kind === "retry"), "nothing asks you after the first quiet turn");
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 2, "re-queued and sent on its own");
  assert.notEqual(f.sends[1].messageId, f.sends[0].messageId);
  f.advance(121_000); await f.engine.tick();
  w = await f.get();
  assert.equal(w.batches.filter(b => b.state === "blocked").length, 0, "no batch blocks: the cap is per task");
  assert.deepEqual(w.heldTasks?.map(h => [h.task.key, h.held]), [["conflict:example/app#1", "capped"]]);
  const capped = needsYou(w, f.now()).find(i => i.kind === "capped");
  assert.equal(capped?.title, "Conflicts on #1 are still there after 2 messages");
  assert.deepEqual(violations(w, f.now()), []);
  f.advance(600_000); await f.engine.tick(); assert.equal(f.sends.length, 2, "no third send of that task on its own");
  // A new condition on another PR still goes out: the capped task doesn't hold the queue.
  await f.store.mutate(s => { s.workspaces[0].prs.push(pr({ key: "example/app#2", number: 2, snapshot: snapshot({ threads: [{ id: "r", updatedAt: "t" }] }) })); });
  f.observe("example/app#2", snapshot({ threads: [{ id: "r", updatedAt: "t" }] }));
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 3); assert.match(f.sends[2].text, /example\/app#2/); assert.doesNotMatch(f.sends[2].text, /conflicts on example\/app#1/);
  // Retry re-arms that one task: it rides the next message.
  await f.engine.acknowledge("main-agent", (await f.get()).batches.find(b => b.state === "sent")!.id, "completed", "Fixed the review thread");
  const { controlWorkspace } = await import("../server/agent-actions");
  await f.store.mutate(s => { controlWorkspace(s, { workspaceId: "workspace", retryTask: "conflict:example/app#1" }, f.now()); });
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 4); assert.match(f.sends[3].text, /Resolve merge conflicts on example\/app#1/);
});

test("a new fingerprint is progress: it resets the count", async t => {
  const f = await fixture(t, conflicted());
  await sendAndGoQuiet(f);
  f.observe("example/app#1", snapshot({ conflict: true, head: "second-head" }));
  await f.engine.tick(); f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 2);
  f.advance(121_000); await f.engine.tick();
  assert.equal((await f.get()).batches.filter(b => b.state === "blocked").length, 0, "a changed condition isn't a repeat");
});

test("reload mid-send: the chat decides, and it resends only if the message never arrived", async t => {
  for (const [arrived, expected] of [[true, "sent"], [false, "resent"], [null, "uncertain"]] as const) {
    const f = await fixture(t, conflicted());
    await f.engine.tick();
    await f.store.mutate(s => { const b = s.workspaces[0].batches[0]; b.state = "sending"; b.recipientAgentId = "main-agent"; });
    await f.engine.recover();
    assert.equal((await f.get()).batches[0].state, "uncertain");
    f.arrived(arrived); f.advance(61_000); await f.engine.tick();
    const w = await f.get(), b = w.batches[0];
    if (expected === "sent") { assert.equal(b.state, "sent"); assert.equal(f.sends.length, 0); }
    if (expected === "resent") { assert.equal(f.sends.length, 1); assert.equal(f.sends[0].messageId, b.messageId, "same messageId"); assert.equal(b.state, "sent"); }
    if (expected === "uncertain") { assert.equal(b.state, "uncertain"); assert.equal(f.sends.length, 0); assert.ok(needsYou(w, f.now()).some(i => i.kind === "retry")); }
  }
});

test("a recovery that ends without an acknowledgment but caught the PR list up is done", async t => {
  const f = await fixture(t, workspace({ inventory: { revision: 2, syncedRevision: 1, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } }));
  await f.engine.startRecovery("workspace");
  for (let i = 0; i < 20 && (await f.get()).batches[0].state !== "sent"; i++) await new Promise(r => setTimeout(r, 5));
  await f.store.mutate(s => { s.workspaces[0].inventory!.syncedRevision = 2; });
  f.advance(121_000); await f.engine.tick();
  const b = (await f.get()).batches[0];
  assert.equal(b.state, "completed"); assert.equal(b.unacknowledged, true);
});

test("a-capped-task-never-holds-the-queue catches a batch blocked for a missing acknowledgment", () => {
  const b = { id: "b1", messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], state: "blocked" as const, unacknowledged: true, createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), settledAt: new Date(clock).toISOString(),
    tasks: [{ key: "conflict:example/app#1", kind: "conflict" as const, target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint: "f" }] };
  assert.deepEqual(violations(workspace({ batches: [b] }), clock).map(v => v.id), ["a-capped-task-never-holds-the-queue"]);
  assert.deepEqual(violations(workspace({ batches: [{ ...b, state: "completed" }] }), clock).map(v => v.id), []);
  assert.deepEqual(violations(workspace({ batches: [{ ...b, state: "completed" }], heldTasks: [{ task: b.tasks[0], held: "capped" }] }), clock).map(v => v.id), ["a-capped-task-never-holds-the-queue"], "held as capped after one send");
});

test("the cap survives pruning: send, settle, prune, send, settle, and it caps", async t => {
  const f = await fixture(t, conflicted());
  await sendAndGoQuiet(f);
  // Pile up never-sent cancelled batches around it, then prune as hard as possible.
  await f.store.mutate(s => {
    const w = s.workspaces[0];
    for (let i = 0; i < 10; i++) w.batches.unshift({ ...w.batches[0], id: `noise-${i}`, messageId: `noise-${i}`, state: "cancelled", sentAt: null, settledAt: null, unacknowledged: undefined, result: "Conditions resolved before delivery" });
    assert.equal(pruneUnsent(w, 0).length, 10, "only never-sent batches go");
  });
  assert.ok((await f.get()).batches.some(b => b.unacknowledged), "the unacknowledged send is kept");
  f.advance(61_000); await f.engine.tick(); assert.equal(f.sends.length, 2);
  f.advance(121_000); await f.engine.tick();
  assert.equal((await f.get()).heldTasks?.filter(h => h.held === "capped").length, 1, "capped after the second quiet send");
  f.advance(600_000); await f.engine.tick(); assert.equal(f.sends.length, 2);
});
