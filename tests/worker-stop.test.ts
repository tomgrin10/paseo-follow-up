import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import * as teardown from "../server/teardown";
import { clock, workspace } from "./fixtures";

/**
 * Invariant worker-stop-never-waits-on-a-stuck-pass (2026-11-11, tests/rpc-ack.test.ts aborting under load with
 * "Promise resolution is still pending but the event loop has already resolved"): stopping the worker clears its
 * timers, then waited with no bound on work in flight. A sync pass stuck on a daemon that never answers kept stop
 * pending forever, and a plugin reload would wait on the old worker the same way. Every wait in the worker's teardown
 * is bounded, and work that finishes after stop writes nothing.
 *
 * Deterministic: the stuck work is a promise that never settles, not a slow one. The only timers are the bounds.
 */
const never = <T>() => new Promise<T>(() => undefined);
/** Resolves true when `work` settles within `ms`, false otherwise; the bound's timer keeps the loop alive meanwhile. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([work.then(() => true, () => true), capped]); } finally { clearTimeout(timer); }
}
const BOUND_MS = 3_000;
/** The teardown wait the tests give the code under test; far below BOUND_MS, so a pass/fail never depends on timing. */
const STOP_WAIT_MS = 50;

const directory = async (t: { after(fn: () => Promise<void>): void }) => {
  const d = await mkdtemp(join(tmpdir(), "follow-stop-")); t.after(() => rm(d, { recursive: true, force: true })); return d;
};
const row = { id: "workspace", title: "Rollout", mainAgentId: "main-agent", messageAt: null, enable_default_tracking: true };
const gatewayWith = (discover: Gateway["discover"]): Gateway => ({
  discover, observe: async () => ({ busy: false, reason: null, archived: false }), send: async () => {}, label: async () => {},
  prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }),
});
const engineFor = (store: Store, gateway: Gateway) => {
  const engine = new Engine(store, { observe: async () => new Map() }, gateway, () => clock);
  (engine as unknown as { stopWaitMs: number }).stopWaitMs = STOP_WAIT_MS;
  return engine;
};

test("worker stop: Engine.stop resolves while a sync pass is stuck on a daemon that never answers", async t => {
  let entered!: () => void; const stuck = new Promise<void>(resolve => { entered = resolve; });
  const engine = engineFor(new Store(await directory(t)), gatewayWith(() => { entered(); return never(); }));
  void engine.tick();
  await stuck; // the pass is inside discover, waiting on the daemon: only then is it truly in flight
  assert.ok(await settlesWithin(engine.stop(), BOUND_MS), "Engine.stop waited on the stuck pass with no bound");
});

test("worker stop: a pass that finishes after stop writes nothing", async t => {
  const dir = await directory(t);
  // Control: the same late answer without a stop does record the workspace, so the assertion below means something.
  { const store = new Store(await directory(t)); let answer!: (rows: typeof row[]) => void; let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const engine = engineFor(store, gatewayWith(() => new Promise(resolve => { answer = resolve; entered(); })));
    const pass = engine.tick(); await inside; answer([row]); await pass;
    assert.equal((await store.snapshot()).workspaces.length, 1, "control: a late discovery is recorded when nothing stopped"); }
  const store = new Store(dir); let answer!: (rows: typeof row[]) => void; let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const engine = engineFor(store, gatewayWith(() => new Promise(resolve => { answer = resolve; entered(); })));
  const pass = engine.tick(); await inside;
  assert.ok(await settlesWithin(engine.stop(), BOUND_MS), "Engine.stop waited on the pass with no bound");
  const close = (store as unknown as { close?: (ms: number) => Promise<void> }).close;
  assert.ok(close, "Store has no close(): nothing stops a late pass from writing");
  assert.ok(await settlesWithin(close.call(store, STOP_WAIT_MS), BOUND_MS), "Store.close waited with no bound");
  answer([row]);
  await settlesWithin(pass, BOUND_MS);
  assert.equal(store.writes, 0, "the pass wrote state.json after stop");
  assert.deepEqual((await readdir(dir)).filter(f => f.startsWith("state")), [], "nothing was written to the state directory");
});

test("worker stop: Store.close is bounded by a stuck mutation, which then never commits; later mutations are refused", async t => {
  const store = new Store(await directory(t));
  let release!: () => void;
  const stuck = store.mutate(async state => { await new Promise<void>(resolve => { release = resolve; }); state.workspaces = []; (state as { version: number }).version = 1; return "late"; });
  await new Promise(r => setImmediate(r));
  const close = (store as unknown as { close?: (ms: number) => Promise<void> }).close;
  assert.ok(close, "Store has no close()");
  assert.ok(await settlesWithin(close.call(store, STOP_WAIT_MS), BOUND_MS), "Store.close waited on the stuck mutation with no bound");
  release();
  await assert.rejects(stuck, /stopping/, "the stuck mutation committed after close");
  await assert.rejects(store.mutate(() => "after"), /stopping/, "a mutation after close was accepted");
  assert.equal(store.writes, 0);
});

test("worker stop: PrActions.close is bounded by a PR action whose gh/gt call never returns", async t => {
  const store = new Store(await directory(t));
  const actions = new PrActions(store, { observe: async () => new Map() } as never, { invalidate() {}, merge: async () => never() }, new BrowserBridge());
  (actions as unknown as { stopWaitMs: number }).stopWaitMs = STOP_WAIT_MS;
  (actions as unknown as { running: Set<Promise<unknown>> }).running.add(never());
  assert.ok(await settlesWithin(actions.close(), BOUND_MS), "PrActions.close waited on the stuck action with no bound");
});

test("worker stop: the worker's teardown routes every wait through one deadline", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
  const stop = source.slice(source.lastIndexOf("  return async () => {"));
  const awaits = [...stop.slice(0, stop.indexOf("\n  };")).matchAll(/await ([^;]+);/g)].map(m => m[1]!.trim());
  assert.ok(awaits.length > 0, "found the worker's stop function");
  assert.ok(awaits.some(a => a.startsWith("stopWorker(")), "the worker's stop doesn't go through stopWorker: each wait gets its own bound, one after another");
  for (const a of awaits) assert.match(a, /^stopWorker\(|^settleWithin\(|^(engine\.stop|actions\.close|closeConnections|store\.close)\(|^unlock\?\.\(\)$/, `unbounded wait in the worker's stop: await ${a}`);
});

/**
 * One deadline for the whole stop (2026-11-11 review of #120): each wait had its own 5 s bound and they ran one after
 * another, so a stop with everything stuck took about 45 s, and a plugin reload waited on all of it. The deadline
 * starts when stop starts; every wait gets what is left of it.
 *
 * No wall-clock races (2026-11-12, the in-time save flaked on a busy CI runner: its 60 ms share of a 300 ms deadline
 * ran out before state.json was written). The deadlines here are either already over, so a wait with a bound of its
 * own (5 s by default) would show up against BOUND_MS, or set by the test; work finishes "inside" a deadline by
 * ordering (before the deadline's timer can run), never by racing it.
 */
type StopWorker = (parts: Record<string, unknown>, ms: number) => Promise<void>;
/** A deadline the test sets: `left` ms from each call (0: already over), counting how many waits consulted it. */
const fakeDeadline = (left: number) => {
  const d = { at: 0, consulted: 0, left: () => { d.consulted++; return left; }, expired: () => left <= 0 };
  return d;
};

test("worker stop: the whole stop shares one deadline; once it is over, nothing stuck is waited on", async t => {
  const stopWorker = (teardown as unknown as { stopWorker?: StopWorker }).stopWorker;
  assert.ok(stopWorker, "the worker's stop has no single deadline: each wait gets its own bound, one after another");
  const store = new Store(await directory(t), 1_000);
  let entered!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; });
  // Stop bounds of their own left at the 5 s default: a step that used one instead of the shared deadline would
  // hold the stop past BOUND_MS.
  const engine = new Engine(store, { observe: async () => new Map() }, gatewayWith(() => { entered(); return never(); }), () => clock);
  void engine.tick(); await inside;
  const actions = new PrActions(store, { observe: async () => new Map() } as never, { invalidate() {}, merge: async () => never() }, new BrowserBridge());
  (actions as unknown as { running: Set<Promise<unknown>> }).running.add(never());
  const late = store.mutate(async state => { await never(); state.workspaces.push(workspace({ id: "late" })); });
  late.catch(() => undefined);
  let unlocked = false;
  const stop = stopWorker({ ready: never(), hooks: () => never(), actions, closeConnections: () => never(), engine, store, unlock: async () => { unlocked = true; } }, 0);
  assert.ok(await settlesWithin(stop, BOUND_MS), "stop waited on stuck work after its deadline was over");
  assert.ok(unlocked, "the lock is released once the store is closed");
  assert.equal(store.writes, 0, "stuck work wrote nothing");
});

test("worker stop: Store.close bounds the queue, a flush and the last write by the one deadline it is given", async t => {
  const store = new Store(await directory(t), 1_000);
  await store.mutate(state => { state.workspaces.push(workspace({ id: "first" })); });
  (store as unknown as { write: () => Promise<never> }).write = () => never();
  void store.flush(); // a flush whose write never returns
  await new Promise(r => setImmediate(r));
  await store.mutate(state => { state.workspaces.push(workspace({ id: "second" })); }); // pending: the last write is due
  store.mutate(() => never()).catch(() => undefined); // the queue is stuck
  const over = fakeDeadline(0);
  assert.ok(await settlesWithin(store.close(over, over), BOUND_MS), "Store.close waited past its deadline: a wait has a bound of its own");
  assert.equal(over.consulted, 3, "the queue, the flush in flight and the last write each wait on the given deadline");
});

test("worker stop: a save that finishes inside the deadline is kept; one that finishes after it is dropped", async t => {
  const dir = await directory(t);
  const store = new Store(dir, 1_000); // batched, as in the worker
  let entered!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const answered = new Promise<void>(resolve => { finish = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  // A user's answer RPC in flight when a reload starts.
  const kept = store.mutate(async state => { entered(); await answered; state.workspaces.push(workspace({ id: "kept" })); return "kept"; });
  // Queued behind it, stuck until after the deadline.
  const dropped = store.mutate(async state => { await released; state.workspaces.push(workspace({ id: "dropped" })); return "dropped"; });
  dropped.catch(() => undefined);
  await inside; // the answer is mid-mutation: its state is loaded and it waits on nothing but `answered`
  // The queue's wait ends on a timer; saving what finished gets as long as it takes, so the write is never cut short.
  const close = store.close(fakeDeadline(100), fakeDeadline(60_000));
  // The answer finishes after close began and before the queue's deadline: it commits in this turn's microtasks,
  // which always run before any timer.
  finish();
  await assert.rejects(store.mutate(() => "new"), /stopping/, "a mutation started after close began was accepted");
  assert.ok(await settlesWithin(close, BOUND_MS * 10), "Store.close never finished");
  assert.equal(await kept.catch(error => (error as Error).message), "kept", "a save that finished inside the deadline was dropped");
  release(); // after close: the deadline is over
  await assert.rejects(dropped, /stopping/, "a save that finished after the deadline committed");
  const saved = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { workspaces: { id: string }[] };
  assert.deepEqual(saved.workspaces.map(w => w.id), ["kept"], "state.json holds the in-time save and nothing after the deadline");
});
