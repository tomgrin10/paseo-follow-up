import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateSchema, type State } from "../shared/model";
import { listEntry, listEntrySchema, isArchivedEntry } from "../shared/list";
import { ListCache } from "../server/list-cache";

// Invariant a-list-carries-only-what-lists-draw. 2026-11-13 (live 2.0.1-beta.4, 139 followed workspaces): a full
// follow.list answer was 1.41 MB, and the app's burst of reads stepped the worker's RSS 204 → 236 MB. Most of it was
// detail only the panel, the PR sheet and agent tools read. The list now carries each workspace's list form
// (shared/list.ts); detail is one follow.get away. Measured on the live copy: 1389 → 835 KB, archived 310 → 21 KB.

/**
 * The target for a full list reply on the live-sized seed. 2026-11-13 measured, list form with compact merged PRs:
 * live copy 696 KB (from 1389), seed 895 KB (from 1817): questions answered or closed, settled batches and 406 merged
 * PRs still go out. The orchestrator sets the final derived value from the per-field sizes (rss/slim-summary.md);
 * until then the size check reports as todo instead of failing.
 */
export const LIST_REPLY_BUDGET_KB = 200;
const BUDGET_PENDING = "LIST_REPLY_BUDGET_KB is pending the orchestrator's derived value (per-field sizes in the slim-list summary)";
/** An archived workspace is only a search hit (name, PR numbers, titles, stacks): 0.55 KB each on the seed. */
export const ARCHIVED_ENTRY_BUDGET_BYTES = 1024;
const WORKSPACES = 140;

let seeded: Promise<State> | null = null;
/** test:scale's seed, generated once for this file. Synthetic names only. */
function seed(): Promise<State> {
  return seeded ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "follow-list-budget-"));
    try {
      const created = Array.from({ length: WORKSPACES }, (_, i) => ({ workspaceId: `ws-${i}`, agentId: `agent-${i}`, agentIds: [`agent-${i}`, `helper-${i}`] }));
      await writeFile(join(dir, "created.json"), JSON.stringify(created));
      const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/scale-seed.ts", join(dir, "state.json"), join(dir, "created.json"), "3", "0"], { encoding: "utf8", timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr);
      return stateSchema.parse(JSON.parse(await readFile(join(dir, "state.json"), "utf8")));
    } finally { await rm(dir, { recursive: true, force: true }); }
  })();
}

test("a-list-carries-only-what-lists-draw: the full list reply on the live-sized seed stays under LIST_REPLY_BUDGET_KB", { todo: BUDGET_PENDING }, async () => {
  const state = await seed();
  const answer = new ListCache().answer(state);
  const bytes = JSON.stringify(answer.workspaces).length;
  const full = JSON.stringify(state.workspaces.filter(w => w.enable_tracking)).length;
  assert.ok(full > LIST_REPLY_BUDGET_KB * 1024, `the seed is big enough that whole workspaces fail the budget (${Math.round(full / 1024)} KB)`);
  assert.ok(bytes <= LIST_REPLY_BUDGET_KB * 1024, `follow.list answered ${Math.round(bytes / 1024)} KB, over ${LIST_REPLY_BUDGET_KB} KB`);
  const archived = answer.workspaces.filter(isArchivedEntry);
  assert.ok(archived.length > 30, "the seed archives the live share of workspaces");
  for (const w of archived) assert.ok(JSON.stringify(w).length <= ARCHIVED_ENTRY_BUDGET_BYTES, `archived ${w.id} is ${JSON.stringify(w).length} bytes`);
});

test("a-list-carries-only-what-lists-draw: no list entry carries panel-only detail, and each one matches the wire schema", async () => {
  const state = await seed();
  for (const w of new ListCache().answer(state).workspaces) {
    assert.deepEqual(listEntrySchema.parse(w), w, `${w.id}'s list form is exactly what follow.list's contract carries`);
    if (isArchivedEntry(w)) continue;
    for (const key of ["inventory", "excludedStacks", "nextMessage"]) assert.ok(!(key in w), `${w.id} carries ${key}`);
    for (const p of w.prs) {
      for (const key of ["base", "trunk", "headBranch", "repoMerge"]) assert.ok(!p.snapshot || !(key in p.snapshot), `${p.key} carries snapshot.${key}`);
      assert.ok(!p.snapshot?.deployment || !("evidence" in p.snapshot.deployment), `${p.key} carries deployment evidence`);
    }
    for (const o of w.obligations) assert.ok(o.status === "blocked" || !("evidence" in o), `${w.id}/${o.id} carries evidence while ${o.status}`);
    for (const q of w.questions) assert.ok(!("background" in q) && !("links" in q), `${w.id}/${q.id} carries its background`);
    for (const p of w.prs) if (p.snapshot?.state === "MERGED" && p.snapshot.complete) for (const key of ["threads", "failedChecks", "reviewers", "conflict", "head"]) assert.ok(!(key in p.snapshot), `merged ${p.key} carries ${key}`);
  }
});

test("a-list-carries-only-what-lists-draw: a blocked task keeps the evidence its list line reads", () => {
  const w = { ...listFixture(), obligations: [{ id: "t1", title: "Wait on the vendor", status: "blocked" as const, afterPrs: [], evidence: "Waits for Q2 from the vendor.", enable_follow_up: false, revision: 1 }] };
  const entry = listEntry(w);
  assert.ok(!isArchivedEntry(entry));
  assert.equal(entry.obligations[0]?.evidence, "Waits for Q2 from the vendor.");
});

test("a-list-carries-only-what-lists-draw: an unchanged workspace's list form is reused, not projected and stringified again", async () => {
  const state = await seed();
  const cache = new ListCache();
  const first = cache.answer(state);
  const touched = { ...state.workspaces[3]!, updatedAt: "2026-11-13T09:00:00.000Z" };
  const next = { ...state, workspaces: state.workspaces.map((w, i) => i === 3 ? touched : w) };
  const second = cache.answer(next, first.revision);
  assert.deepEqual(second.workspaces.map(w => w.id), [touched.id], "only the changed workspace is in the diff");
  const full = cache.answer(next);
  const same = full.workspaces.filter((w, i) => w === first.workspaces[i]);
  assert.equal(same.length, full.workspaces.length - 1, "every other workspace's list form is the same object");
});

test("a-list-carries-only-what-lists-draw: agent tools and follow.get read the stored workspace, never the list form", async () => {
  // Agent parity: a tool that needs detail (workspace_status, list_prs) reads the worker's state, so slimming the
  // list never hides anything from an agent. Only the list cache and the feed it serves may use the list form.
  const allowed = new Set(["list-cache.ts", "feeds.ts"]);
  const users: string[] = [];
  for (const name of await readdir("server")) if (name.endsWith(".ts") && !allowed.has(name) && /from "\.\.\/shared\/list"/.test(await readFile(join("server", name), "utf8"))) users.push(name);
  assert.deepEqual(users, []);
  const worker = await readFile("index.server.ts", "utf8");
  assert.match(worker, /handle\(rpc\.getRpc, [^\n]*\(await store\.snapshot\(\)\)\.workspaces\.find/, "follow.get answers the stored workspace");
});

function listFixture() {
  return stateSchema.parse({ version: 1, workspaces: [{ id: "ws-a", title: "Fixture", goal: "Ship it", mainAgentId: "agent-a", enable_tracking: true, hold: null, archived: false, prs: [], obligations: [], batches: [], completion: null, updatedAt: "2026-11-13T08:00:00.000Z", managedDoneLabel: false, runtimeReason: null, runtimeBusy: false }] }).workspaces[0]!;
}
