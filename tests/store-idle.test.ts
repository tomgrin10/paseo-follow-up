import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store, sameJson } from "../server/store";
import { compactHeap } from "../server/memory";
import { clock, pr, snapshot, workspace } from "./fixtures";

// 1.4.0-beta.23: the idle worker's garbage was no-op mutations. Each engine tick copied the whole state once per
// active workspace, then re-validated all of it at the next write and rebuilt scopes.json, with nothing changed.
async function store(t: { after: (fn: () => Promise<void>) => void }, writeMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "follow-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s = new Store(root, writeMs);
  await s.mutate(state => { state.workspaces.push(workspace(), workspace({ id: "w2", title: "Second" })); });
  await s.flush();
  let changed = 0; s.onChanged = async () => { changed++; };
  return { s, changed: () => changed };
}

for (const writeMs of [0, 1000]) test(`a mutation that changes nothing writes nothing, derives nothing and keeps the snapshot (writeMs ${writeMs})`, async t => {
  const f = await store(t, writeMs);
  const before = await f.s.snapshot(); const writes = f.s.writes;
  assert.equal(await f.s.mutate(state => { state.workspaces[0].title = "Migration rollout"; return "read"; }), "read");
  assert.equal(await f.s.mutateWorkspace("w2", w => { w.title = "Second"; return 2; }), 2);
  await f.s.flush();
  assert.equal(await f.s.snapshot(), before, "the same frozen snapshot, not a copy");
  assert.equal(f.s.writes, writes); assert.equal(f.changed(), 0);
});

test("mutateWorkspace copies only that workspace, writes it and derives files once", async t => {
  const f = await store(t);
  const before = await f.s.snapshot();
  await f.s.mutateWorkspace("w2", w => { w.title = "Renamed"; });
  const after = await f.s.snapshot();
  assert.equal(after.workspaces[1].title, "Renamed");
  assert.equal(after.workspaces[0].title, before.workspaces[0].title);
  assert.equal(f.changed(), 1);
  assert.equal((await new Store(f.s.directory).snapshot()).workspaces[1].title, "Renamed", "persisted");
  await assert.rejects(f.s.mutateWorkspace("missing", () => undefined), /initializing/);
  assert.equal((await f.s.snapshot()).workspaces.length, 2, "a failed mutation leaves the state as it was");
});

test("an idle engine tick with nothing new writes no state and rebuilds no derived files", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s = new Store(root);
  await s.mutate(state => { state.workspaces.push(workspace({ prs: [pr({ snapshot: snapshot() })] })); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/fixture/r.json" }), observe: async () => runtime, send: async () => undefined, label: async () => undefined };
  const github = { observe: async (prs: { key: string }[]) => new Map(prs.map(p => [p.key, { snapshot: { ...snapshot(), observedAt: new Date(clock).toISOString() }, error: null }])) };
  const engine = new Engine(s, github, gateway, () => clock);
  await engine.tick(); await engine.tick();
  let changed = 0; s.onChanged = async () => { changed++; };
  const writes = s.writes;
  for (let i = 0; i < 3; i++) await engine.tick();
  assert.equal(s.writes, writes); assert.equal(changed, 0);
});

test("compactHeap runs one full collection without leaving a gc global", () => {
  const had = typeof (globalThis as { gc?: unknown }).gc;
  assert.equal(compactHeap(), true);
  assert.equal(typeof (globalThis as { gc?: unknown }).gc, had);
});

test("sameJson: key order and undefined properties don't count; values and shapes do", () => {
  assert.ok(sameJson({ a: 1, b: { c: [1, "x"] } }, { b: { c: [1, "x"] }, a: 1 }));
  assert.ok(sameJson({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameJson({ a: 1 }, { a: 1, b: null }));
  assert.ok(!sameJson([1, 2], [2, 1]));
  assert.ok(!sameJson({ a: [] }, { a: {} }));
  assert.ok(!sameJson({ at: new Date(0) }, { at: new Date(0).toISOString() }), "non-JSON values are never equal to their JSON");
});
