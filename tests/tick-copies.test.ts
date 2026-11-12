import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { ACTIVE_SCOPE_MIGRATION } from "../shared/settings";
import { clock, pr, workspace } from "./fixtures";

/**
 * 2026-11-12, live 2.0.1-beta.2: the worker sat at ~450 MB RSS against a 240 MB budget. Its V8 heap held 85 MB but
 * had grown to 225 MB: a transient spike, not a leak. The realistic scale check (140 workspaces, 1.7 MB state)
 * reproduced it on the first tick: Engine.run wrote each workspace's sendWait (and recovery, done-label) with a
 * whole-state store.mutate, so one tick copied and compared the full state 140 times (~1.4 GB of garbage in 4 s,
 * RSS 169 → 327 MB), ran onChanged (scopes.json, inbox) 140 times and saved once a second while it lasted.
 * Invariant a-tick-copies-the-state-at-most-once.
 */
const N = 140;

test("a-tick-copies-the-state-at-most-once: a 140-workspace tick where every sendWait flips copies, derives and saves once", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-tick-")); t.after(() => rm(root, { recursive: true, force: true }));
  // Write-through (writeMs 0) so every save the tick causes is counted, not hidden behind the worker's debounce.
  const store = new Store(root);
  await store.mutate(s => {
    s.migrations = [ACTIVE_SCOPE_MIGRATION];
    for (let i = 0; i < N; i++) s.workspaces.push(workspace({ id: `w${i}`, mainAgentId: `a${i}`, managedDoneLabel: i % 10 === 0, prs: [pr({ key: `example/app#${i + 1}`, number: i + 1 })] }));
  });
  const writesBefore = store.writes;
  let mutates = 0; let changed = 0;
  const mutate = store.mutate.bind(store);
  store.mutate = (work => { mutates++; return mutate(work); }) as typeof store.mutate;
  store.onChanged = async () => { changed++; };
  // Every main agent is unloaded, so sendWait goes null -> "unloaded" on all 140; a tenth also drop the Done label.
  const runtime: Runtime = { busy: false, reason: null, archived: false, mainLoaded: false };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async () => runtime, send: async () => {}, label: async () => {} };
  const github = { observe: async (prs: { key: string; snapshot: unknown }[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: null }])) };
  const engine = new Engine(store, github as never, gateway, () => clock);
  await engine.tick();
  const state = await store.snapshot();
  assert.equal(state.workspaces.filter(w => w.sendWait === "unloaded").length, N, "every sendWait flipped");
  assert.equal(state.workspaces.filter(w => w.managedDoneLabel).length, 0, "every Done label dropped");
  assert.ok(mutates <= 1, `whole-state store.mutate calls in one tick: ${mutates} (each copies the whole state)`);
  assert.ok(store.writes - writesBefore <= 1, `state.json saves in one tick: ${store.writes - writesBefore}`);
  assert.ok(changed <= 1, `onChanged (scopes.json, inbox) runs in one tick: ${changed}`);
});
