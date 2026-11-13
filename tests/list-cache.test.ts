import test from "node:test";
import assert from "node:assert/strict";
import { ListCache } from "../server/list-cache";
import type { State } from "../shared/model";
import { workspace } from "./fixtures";

const state = (n: number, patch: (i: number) => object = () => ({})): State => ({ version: 1, workspaces: Array.from({ length: n }, (_, i) => workspace({ id: `w${i}`, title: `Workspace ${i}`, ...patch(i) })) });

test("follow.list answers with only what changed since the client's revision", () => {
  const cache = new ListCache();
  let s = state(130);
  const first = cache.answer(s);
  assert.equal(first.full, true); assert.equal(first.workspaces.length, 130);
  const fullBytes = JSON.stringify(first).length;
  const idle = cache.answer(s, first.revision);
  assert.deepEqual([idle.full, idle.workspaces.length, idle.removed.length, idle.revision], [false, 0, 0, first.revision]);
  const idleBytes = JSON.stringify(idle).length;
  assert.ok(idleBytes < 100, `an unchanged poll is tiny (${idleBytes} B vs ${fullBytes} B)`);
  // A new state object with the same content (a store flush) is not a change.
  s = structuredClone(s); assert.equal(cache.answer(s, first.revision).workspaces.length, 0);
  s = state(130, i => i === 7 ? { title: "Renamed" } : {}); s.workspaces.splice(3, 1);
  const diff = cache.answer(s, first.revision);
  assert.deepEqual(diff.workspaces.map(w => w.id), ["w7"]); assert.deepEqual(diff.removed, ["w3"]);
  assert.ok(diff.revision > first.revision);
  assert.equal(cache.answer(s, diff.revision).workspaces.length, 0);
  assert.equal(cache.answer(s, first.revision - 2).full, true, "a token from before this worker started gets the full list");
  assert.equal(cache.answer(s, diff.revision + 5).full, true, "a token from the future (worker restarted) too");
});

// Invariant a-list-answer-serializes-only-what-changed. 2026-11-13 (run W: a copy of a live install, 20 turns and 8 RPCs
// a minute): ListCache.update stringified every tracked workspace (1.4 MB) on every state change to find the one a turn
// touched, 23 MB of garbage every 5 minutes. The store keeps an unchanged workspace's frozen object, so only a
// workspace whose object changed is serialised again.
test("a-list-answer-serializes-only-what-changed: a change to 1 of 150 workspaces stringifies one workspace", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../server/store");
  const root = await mkdtemp(join(tmpdir(), "follow-list-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(s => { for (let i = 0; i < 150; i++) s.workspaces.push(workspace({ id: `w${i}`, title: `Workspace ${i}` })); });
  const cache = new ListCache();
  const first = cache.answer(await store.snapshot());
  assert.equal(first.workspaces.length, 150);
  await store.mutateWorkspace("w7", w => { w.title = "Renamed"; });
  // A workspace, stored or in its list form (shared/list.ts): what the cache serialises per workspace.
  const ids = new Set((await store.snapshot()).workspaces.map(w => w.id));
  let stringified = 0;
  const stringify = JSON.stringify;
  JSON.stringify = function (value: unknown, ...rest: unknown[]) { if (value && typeof value === "object" && ids.has((value as { id?: string }).id as never) && "mainAgentId" in value) stringified++; return stringify.call(JSON, value, ...(rest as [])); } as typeof JSON.stringify;
  let diff;
  try { diff = cache.answer(await store.snapshot(), first.revision); } finally { JSON.stringify = stringify; }
  assert.deepEqual(diff.workspaces.map(w => w.id), ["w7"], "the change is still seen");
  assert.equal(stringified, 1, `${stringified} workspaces stringified for a change to one of 150`);
});

test("a-list-answer-serializes-only-what-changed: a workspace edited in place (not frozen) is still compared", () => {
  const cache = new ListCache();
  const s = state(3);
  const first = cache.answer(s);
  s.workspaces[1]!.title = "Edited in place";
  assert.deepEqual(cache.answer({ ...s }, first.revision).workspaces.map(w => w.id), ["w1"]);
});
