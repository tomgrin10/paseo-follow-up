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
