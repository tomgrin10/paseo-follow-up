import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCheck, STATUS_SWEEP_MS } from "../server/status-check";
import { clock, workspace } from "./fixtures";

test("the runtime self-check logs a contradiction once per change, with the workspace id", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-status-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "status-diagnostics.jsonl");
  let found = [{ id: "on-it-means-sent", detail: "Main agent is on it" }];
  const check = statusCheck(file, () => found);
  const w = workspace({ id: "wks_contradiction" });
  // Each tick that changes something hands over a new workspace object (the store's frozen state).
  await check(w, clock); await check({ ...w }, clock + 15_000);
  found = []; await check({ ...w }, clock + 30_000);
  found = [{ id: "sending-never-waits-on-you", detail: "sending with no batch" }]; await check({ ...w }, clock + 45_000);
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.workspaceId, l.violations[0].id]), [["wks_contradiction", "on-it-means-sent"], ["wks_contradiction", "sending-never-waits-on-you"]]);
});

test("a consistent workspace writes nothing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-status-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "status-diagnostics.jsonl");
  await statusCheck(file)(workspace(), clock);
  await assert.rejects(readFile(file, "utf8"));
});

test("a-tick-copies-the-state-at-most-once: an unchanged workspace with unchanged inputs isn't re-checked until the sweep", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-status-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let runs = 0;
  const check = statusCheck(join(dir, "status-diagnostics.jsonl"), () => { runs++; return []; });
  const w = workspace();
  await check(w, clock, "runtime-1"); await check(w, clock + 15_000, "runtime-1");
  assert.equal(runs, 1, "same object, same inputs: skipped");
  await check(w, clock + 30_000, "runtime-2");
  assert.equal(runs, 2, "an input outside the workspace (an agent row, via the runtime) changed: checked");
  await check({ ...w }, clock + 45_000, "runtime-2");
  assert.equal(runs, 3, "a new workspace object: checked");
  await check({ ...w }, clock + 45_000 + STATUS_SWEEP_MS, "runtime-2");
  assert.equal(runs, 4);
  const same = { ...w }; await check(same, clock + 50_000 + STATUS_SWEEP_MS, "runtime-2"); await check(same, clock + 50_000 + 2 * STATUS_SWEEP_MS, "runtime-2");
  assert.equal(runs, 6, "the sweep re-checks an unchanged workspace (clock-based invariants)");
});
