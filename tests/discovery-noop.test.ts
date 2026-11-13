import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { applyDiscovery, type DiscoveredWorkspace } from "../server/discovery";
import { pr, workspace } from "./fixtures";

// Invariant a-mutation-copies-only-what-it-changes: a write that changes nothing isn't a write. 2026-11-13 (branch
// profile, CI-shaped busy run): every engine tick's applyDiscovery set each followed workspace's title, dormant flag,
// contributors and inventory to the values they already had, so the draft copied every workspace each tick, then the
// store stringified and zod-validated them: 49 MB copied + 49 MB written per 2 min. A tick in which nothing was
// discovered as changed now leaves every workspace's saved object as it was, and writes nothing.

const N = 60;
const rows = (): DiscoveredWorkspace[] => Array.from({ length: N }, (_, i) => ({
  id: `ws-${i}`, title: `Workspace ${i}`, mainAgentId: `agent-${i}`, mainClosed: false, messageAt: "2026-11-13T05:00:00.000Z", active: true,
  contributorAgentIds: [`helper-${i}`],
  history: { candidates: [`example/app#${i + 1}`], goal: null, complete: true, error: null },
  submissions: [{ repo: "example/app", number: i + 1, agentId: `agent-${i}`, branch: `feat/${i}` }] as never,
}));

test("a-mutation-copies-only-what-it-changes: a discovery tick that finds nothing new leaves every workspace object as it was and writes nothing", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-discovery-noop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(s => { s.workspaces = Array.from({ length: N }, (_, i) => workspace({ id: `ws-${i}`, title: `Workspace ${i}`, mainAgentId: `agent-${i}`, enable_tracking: true, prs: [pr({ key: `example/app#${i + 1}`, number: i + 1 })] })); });
  const now = Date.parse("2026-11-13T06:00:00.000Z");
  await store.mutate(s => applyDiscovery(s, rows(), now));
  const before = (await store.snapshot()).workspaces;
  const file = join(root, "state.json");
  const written = (await stat(file)).mtimeMs;
  await new Promise(r => setTimeout(r, 20));
  // Counts what the tick copies: structuredClone of anything holding a workspace (the whole state or one workspace).
  const original = structuredClone; let copies = 0;
  globalThis.structuredClone = ((v: unknown, o?: Parameters<typeof structuredClone>[1]) => {
    if (v && typeof v === "object" && ("workspaces" in v || "mainAgentId" in v)) copies++;
    return original(v, o);
  }) as typeof structuredClone;
  try { await store.mutate(s => applyDiscovery(s, rows(), now + 15_000)); } finally { globalThis.structuredClone = original; }
  assert.equal(copies, 0, `the tick copied ${copies} workspaces (or the whole state) to change nothing`);
  const after = (await store.snapshot()).workspaces;
  const copied = after.filter((w, i) => w !== before[i]).map(w => w.id);
  assert.deepEqual(copied, [], "every workspace keeps its saved object");
  assert.equal((await stat(file)).mtimeMs, written, "and the store doesn't flush");
});
