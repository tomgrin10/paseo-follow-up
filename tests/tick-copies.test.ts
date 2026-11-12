import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { statusCheck } from "../server/status-check";
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

async function fleet(t: { after: (fn: () => unknown) => void }, n: number, writeMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "follow-tick-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root, writeMs);
  await store.mutate(s => { s.migrations = [ACTIVE_SCOPE_MIGRATION]; for (let i = 0; i < n; i++) s.workspaces.push(workspace({ id: `w${i}`, mainAgentId: `a${i}`, prs: [pr({ key: `example/app#${i + 1}`, number: i + 1 })] })); });
  return store;
}

test("a-tick-copies-the-state-at-most-once: an untouched workspace isn't copied; a changed runtime or the full pass is", async t => {
  const store = await fleet(t, 20);
  let now = clock; const runtimes = new Map<string, Runtime>();
  const runtime = (id: string): Runtime => runtimes.get(id) ?? { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async w => runtime(w.id), send: async () => {}, label: async () => {} };
  // A stand-in observation: the stored read itself (no new read, no new error), as Github returns for a PR it skipped.
  const github = { observe: async (prs: { key: string; snapshot: unknown; error: string | null }[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: p.error }])) };
  const engine = new Engine(store, github as never, gateway, () => now);
  await engine.tick(); await engine.tick();
  const settled = engine.observationWrites;
  let clones = 0; const workspaceMutate = store.mutateWorkspace.bind(store);
  store.mutateWorkspace = ((id, work) => { clones++; return workspaceMutate(id, work); }) as typeof store.mutateWorkspace;
  now += 15_000; await engine.tick();
  assert.equal(engine.observationWrites - settled, 0, "a quiet tick runs no observation write");
  assert.equal(clones, 0, "and copies no workspace");
  runtimes.set("w3", { busy: true, reason: null, archived: false, mainLoaded: true, mainRecent: true });
  now += 15_000; await engine.tick();
  assert.equal(engine.observationWrites - settled, 1, "only the workspace whose runtime changed is observed");
  assert.equal((await store.snapshot()).workspaces.find(w => w.id === "w3")!.runtimeBusy, true);
  now += 61_000; await engine.tick();
  assert.equal(engine.observationWrites - settled, 21, "after OBSERVE_FULL_MS every workspace gets its full pass");
});

test("a-tick-copies-the-state-at-most-once: a save validates only changed workspaces, keeps the rest by identity, and never writes a corrupt one", async t => {
  const store = await fleet(t, 5);
  const before = await store.snapshot();
  await store.mutateWorkspace("w2", w => { w.title = "Renamed"; });
  const after = await store.snapshot();
  assert.ok(after.workspaces.every((w, i) => i === 2 ? w !== before.workspaces[i] : w === before.workspaces[i]), "only w2 is a new object");
  const { readFile } = await import("node:fs/promises");
  const onDisk = await readFile(join(store.directory, "state.json"), "utf8");
  await assert.rejects(store.mutateWorkspace("w4", w => { (w as { mainAgentId: unknown }).mainAgentId = 42; }));
  assert.equal(await readFile(join(store.directory, "state.json"), "utf8"), onDisk, "the corrupt workspace was never written");
});

test("a-tick-copies-the-state-at-most-once: when only an agent row changes, the invariant that reads it still fires", async t => {
  const store = await fleet(t, 3);
  await store.mutateWorkspace("w1", w => { w.obligations = [{ id: "t1", title: "Fix the flaky export test", status: "working", workingAgentId: "helper", afterPrs: [], evidence: "", revision: 1 } as never]; });
  let now = clock; let helper = "working";
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), send: async () => {}, label: async () => {},
    observe: async w => ({ busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true, taskAgents: (w.id === "w1" ? { helper: { title: "Helper", state: helper } } : {}) as Runtime["taskAgents"] }) };
  const github = { observe: async (prs: { key: string; snapshot: unknown; error: string | null }[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: p.error }])) };
  const engine = new Engine(store, github as never, gateway, () => now);
  const fired: string[] = []; let runs = 0;
  // Stands in for a-task-only-says-working-when-its-agent-is: a working task whose agent row says idle.
  engine.statusCheck = statusCheck(join(store.directory, "diag.jsonl"), w => { runs++; return w.obligations.some(o => o.status === "working" && w.taskAgents?.[o.workingAgentId!]?.state === "idle") ? [{ id: "agent-idle", detail: w.id }] : []; });
  await engine.tick(); now += 15_000; await engine.tick();
  const quiet = runs; now += 15_000; await engine.tick();
  assert.equal(runs, quiet, "a quiet tick checks nothing");
  helper = "idle"; // Only the helper's agent row changes; no workspace field was touched by anyone else.
  now += 15_000; await engine.tick();
  const { readFile } = await import("node:fs/promises");
  const log = (await readFile(join(store.directory, "diag.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => [l.workspaceId, l.violations[0].id]), [["w1", "agent-idle"]], "the invariant fired on the tick the agent row changed");
});

test("a-tick-copies-the-state-at-most-once: a read that only moves observedAt waits for the full pass, except on a hot workspace", async t => {
  const store = await fleet(t, 2);
  let now = clock; let readAt = clock;
  const runtime = (id: string): Runtime => ({ busy: id === "w1", reason: null, archived: false, mainLoaded: true, mainRecent: true });
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async w => runtime(w.id), send: async () => {}, label: async () => {} };
  const github = { observe: async (prs: { key: string; snapshot: Record<string, unknown> }[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(readAt).toISOString() }, error: null }])) };
  const engine = new Engine(store, github as never, gateway, () => now);
  await engine.tick(); await engine.tick();
  const settled = engine.observationWrites;
  now += 15_000; readAt = now; await engine.tick();
  assert.equal(engine.observationWrites - settled, 1, "only the hot (busy) workspace records a read-time-only change");
  const state = await store.snapshot();
  assert.equal(state.workspaces.find(w => w.id === "w1")!.prs[0].snapshot!.observedAt, new Date(now).toISOString());
  assert.equal(state.workspaces.find(w => w.id === "w0")!.prs[0].snapshot!.observedAt, new Date(clock).toISOString(), "the quiet one keeps its last recorded read until the full pass");
  now += 61_000; readAt = now; await engine.tick();
  assert.equal((await store.snapshot()).workspaces.find(w => w.id === "w0")!.prs[0].snapshot!.observedAt, new Date(now).toISOString(), "the full pass records it");
});
