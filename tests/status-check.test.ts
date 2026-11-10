import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCheck } from "../server/status-check";
import { clock, workspace } from "./fixtures";

test("the runtime self-check logs a contradiction once per change, with the workspace id", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-status-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "status-diagnostics.jsonl");
  let found = [{ id: "on-it-means-sent", detail: "Main agent is on it" }];
  const check = statusCheck(file, () => found);
  const w = workspace({ id: "wks_contradiction" });
  await check(w, clock); await check(w, clock + 15_000);
  found = []; await check(w, clock + 30_000);
  found = [{ id: "fixing-means-acting", detail: "fixing with no batch" }]; await check(w, clock + 45_000);
  const lines = (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.workspaceId, l.violations[0].id]), [["wks_contradiction", "on-it-means-sent"], ["wks_contradiction", "fixing-means-acting"]]);
});

test("a consistent workspace writes nothing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-status-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "status-diagnostics.jsonl");
  await statusCheck(file)(workspace(), clock);
  await assert.rejects(readFile(file, "utf8"));
});
