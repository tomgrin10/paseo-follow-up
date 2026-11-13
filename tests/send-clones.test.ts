import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { turnStarted, turnEnded } from "../server/turn-events";
import { interruptionHold } from "../shared/status";
import { ACTIVE_SCOPE_MIGRATION } from "../shared/settings";
import type { State } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * 2026-11-13, #139 fair-seed test:scale: the worker went 227 -> 342 MB through 6 sends and stayed there (main under the
 * same sends: 205). The send window allocated 430 MB in two minutes; 93 MB of it was Store.mutate copying the whole
 * 2 MB state for each claim, recipient, sent and acknowledgment write and for the turn events around them, and 47 MB
 * was the next save re-validating all 140 workspaces, because a whole-state copy gives every workspace a new object.
 * Invariant a-send-never-clones-the-whole-state.
 */
const N = 20;

async function fleet(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "follow-send-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(s => {
    s.migrations = [ACTIVE_SCOPE_MIGRATION];
    for (let i = 0; i < N; i++) s.workspaces.push(workspace({ id: `w${i}`, mainAgentId: `a${i}`, enable_auto_sends: i === 0, prs: [pr({ key: `example/app#${i + 1}`, number: i + 1, snapshot: snapshot({ conflict: i === 0, observedAt: new Date(clock).toISOString() }) })] }));
  });
  let wholeCopies = 0;
  const mutate = store.mutate.bind(store);
  store.mutate = (work => { wholeCopies++; return mutate(work); }) as typeof store.mutate;
  return { store, copies: () => wholeCopies };
}

function engineFor(store: Store, now: () => number) {
  const sends: string[] = [];
  const runtime: Runtime = { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async () => runtime, send: async (_w, _b, text) => { sends.push(text); }, label: async () => {} };
  const github = { observe: async (prs: { key: string; snapshot: unknown }[]) => new Map(prs.map(p => [p.key, { snapshot: { ...(p.snapshot as object), observedAt: new Date(now()).toISOString() }, error: null }])) };
  return { engine: new Engine(store, github as never, gateway, now), sends };
}

test("a-send-never-clones-the-whole-state: an auto-send, its acknowledgment and the turns around it copy one workspace, never the state", async t => {
  const { store, copies } = await fleet(t);
  let now = clock;
  const { engine, sends } = engineFor(store, () => now);
  await engine.tick();
  const before = copies();
  now += 61_000; await engine.tick();
  assert.equal(sends.length, 1, "the settled repair went out on its own");
  // That tick was also every workspace's full observation pass; from here only w0's acknowledgment and turns write.
  const others = (await store.snapshot()).workspaces.slice(1);
  const batch = (await store.snapshot()).workspaces[0].batches.find(b => b.state === "sent")!;
  await turnStarted(store, { id: "a0", workspaceId: "w0" }, "turn-1");
  await engine.acknowledge("a0", batch.id, "completed", "Rebased onto main");
  await turnEnded(store, "a0", { kind: "completed" }, "turn-1", null, { interruption: null, guarded: false });
  assert.equal(copies() - before, 0, "whole-state store.mutate calls on the send path");
  const after = (await store.snapshot()).workspaces;
  assert.equal(after[0].batches.find(b => b.id === batch.id)!.state, "completed");
  assert.ok(others.every((w, i) => after[i + 1] === w), "every other workspace keeps its object (so a save doesn't re-validate it)");
});

test("a-send-never-clones-the-whole-state: a developer's Send copies one workspace, never the state", async t => {
  const { store, copies } = await fleet(t);
  await store.mutateWorkspace("w0", w => { w.enable_auto_sends = false; });
  let now = clock;
  const { engine, sends } = engineFor(store, () => now);
  await engine.tick(); now += 61_000; await engine.tick();
  const pending = (await store.snapshot()).workspaces[0].batches.find(b => b.state === "pending")!;
  const before = copies();
  await engine.sendPending("w0", pending.id);
  assert.equal(sends.length, 1);
  assert.equal(copies() - before, 0, "whole-state store.mutate calls on a developer's Send");
});

test("a-send-never-clones-the-whole-state: a turn event touches only its own workspace, never a walk over all of them", async t => {
  const { store, copies } = await fleet(t);
  // w3's main agent was stopped by the developer: an automatic hold that the agent's next turn lifts.
  await store.mutateWorkspace("w3", w => { w.hold = interruptionHold("canceled"); w.interruption = { agentId: "a3", turnId: "old", at: new Date(clock).toISOString(), kind: "canceled" }; });
  const saved = (await store.snapshot()).workspaces;
  const before = copies();
  await turnStarted(store, { id: "a3", workspaceId: "w3" }, "new");
  await turnEnded(store, "a5", { kind: "canceled", reason: "user" }, "t5", null, { interruption: { turnId: "t5", at: new Date(clock).toISOString(), kind: "canceled" }, guarded: false, newerTurn: false, compaction: false });
  assert.equal(copies() - before, 0, "whole-state store.mutate calls for turn events");
  const after = (await store.snapshot()).workspaces;
  assert.equal(after[3].hold, null, "the superseded hold lifted");
  assert.ok(after[5].hold, "the developer's Stop held w5");
  assert.ok(saved.every((w, i) => i === 3 || i === 5 || after[i] === w), "no other workspace was copied");
});

test("a whole-state mutate keeps the objects of workspaces it didn't change, so the next save validates only the changed one", async t => {
  const { store } = await fleet(t);
  const before = (await store.snapshot()).workspaces;
  await store.mutate(s => { s.workspaces[7].title = "Renamed"; });
  const after = (await store.snapshot()).workspaces;
  assert.notEqual(after[7], before[7]);
  assert.ok(before.every((w, i) => i === 7 || after[i] === w), "unchanged workspaces keep their identity");
  const state: State = await store.snapshot();
  assert.ok(Object.isFrozen(state.workspaces[7]));
});
