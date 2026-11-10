import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchArchive, pruneUnsent } from "../server/batch-archive";
import { Engine, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { batchSchema, type Batch } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

const batch = (id: string, patch: Partial<Batch> = {}) => batchSchema.parse({ id, messageId: `m-${id}`, tasks: [], state: "cancelled", createdAt: new Date(clock).toISOString(), sentAt: null, settledAt: null, attempts: 1, result: "Conditions resolved before delivery", ...patch });

test("never-sent cancelled batches beyond the newest three move to the archive; delivered history stays", async t => {
  const w = workspace({ batches: [batch("sent", { sentAt: "x", settledAt: "y" }), ...Array.from({ length: 6 }, (_, i) => batch(`u${i}`)), batch("done", { state: "completed", sentAt: "x", settledAt: "y" }), batch("pending", { state: "pending" })] });
  const dropped = pruneUnsent(w);
  assert.deepEqual(dropped.map(b => b.id), ["u0", "u1", "u2"]);
  assert.deepEqual(w.batches.map(b => b.id), ["sent", "u3", "u4", "u5", "done", "pending"]);
  const dir = await mkdtemp(join(tmpdir(), "follow-archive-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await batchArchive(dir)("workspace", dropped);
  assert.equal((await readFile(join(dir, "archive", "workspace.jsonl"), "utf8")).trim().split("\n").length, 3);
});

test("a completion check survives the agent's turns instead of being cancelled and recreated", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-churn-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] })); });
  let now = clock; let runtime: Runtime = { busy: false, reason: null, archived: false };
  const archived: string[] = [];
  const engine = new Engine(store, { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(now).toISOString() }, error: null }])) }, { observe: async () => runtime, send: async () => {}, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), label: async () => {} }, () => now);
  engine.archive = async (_id, batches) => { archived.push(...batches.map(b => b.id)); };
  for (let i = 0; i < 40; i++) { runtime = { busy: i % 2 === 1, reason: null, archived: false }; now += 15_000; await engine.tick(); }
  const w = (await store.snapshot()).workspaces[0];
  // Hysteresis: the agent's own turns don't cancel and recreate the Done check.
  assert.deepEqual(w.batches.map(b => b.state), ["pending"], "one Done check, never cancelled and recreated");
  assert.equal(archived.length, 0);
});
