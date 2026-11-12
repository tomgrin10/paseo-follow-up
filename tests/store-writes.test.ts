import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { InboxStore } from "../server/inbox";
import { pr, workspace } from "./fixtures";

// Invariant store-writes-only-real-changes. 2026-11-12 (live read-only diff, 10 min): 17 of 19 state.json writes
// (1.3 MB each) changed nothing but PR read timestamps (snapshot.observedAt, deployment.observedAt), and 10 of 14
// inbox.json writes changed only lastSeen; 4 more were byte-identical. Read timestamps are volatile: they reach disk
// with the next real change, every VOLATILE_WRITE_MS, or on close.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Waits until `done` (polling), so a slow CI runner can't fail a "was written" check; "wasn't written" checks use sleep. */
async function until(done: () => boolean, label: string, ms = 5000) { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) assert.fail(label); await sleep(10); } }
async function dir(t: { after(fn: () => unknown): void }) { const d = await mkdtemp(join(tmpdir(), "follow-store-")); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const stamp = (at: string) => (s: any) => { for (const p of s.workspaces[0].prs) { p.snapshot.observedAt = at; if (p.snapshot.deployment) p.snapshot.deployment.observedAt = at; } };
const deployment = (at: string) => ({ state: "deployed", environment: "production", commits: ["b".repeat(40)], evidence: "fixture", observedAt: at });

test("store-writes-only-real-changes: a tick that only refreshes read timestamps writes nothing; a real change still writes within writeMs", async t => {
  const d = await dir(t);
  const store = new Store(d, 20, 60_000);
  await store.mutate(s => { s.workspaces.push(workspace({ prs: [pr({ snapshot: { ...pr().snapshot!, deployment: deployment("2026-01-01T10:00:00Z") } as any })] })); });
  await until(() => store.writes === 1, "the first real change is written"); const base = store.writes;
  // A fresh observation is a new object whose keys come in parsePr's order, not the saved (schema) order.
  await store.mutateWorkspace("workspace", w => { const { observedAt, ...rest } = w.prs[0].snapshot as any; w.prs[0].snapshot = { observedAt: "2026-01-01T10:00:30Z", ...Object.fromEntries(Object.entries(rest).reverse()) } as any; });
  for (let i = 1; i <= 5; i++) { await store.mutate(stamp(`2026-01-01T10:0${i}:00Z`)); await store.mutateWorkspace("workspace", w => { w.prs[0].snapshot!.observedAt = `2026-01-01T10:0${i}:30Z`; }); }
  await sleep(60);
  assert.equal(store.writes, base, "read timestamps alone are not written");
  assert.equal((await store.snapshot()).workspaces[0].prs[0].snapshot!.observedAt, "2026-01-01T10:05:30Z", "they are current in memory");
  await store.mutateWorkspace("workspace", w => { w.goal = "Changed for real"; });
  await until(() => store.writes === base + 1, "a real change writes");
  const disk = JSON.parse(await readFile(join(d, "state.json"), "utf8"));
  assert.equal(disk.workspaces[0].prs[0].snapshot.observedAt, "2026-01-01T10:05:30Z", "and carries the newest read timestamps with it");
  await store.close(1000);
});

test("store-writes-only-real-changes: pending read timestamps are written every VOLATILE_WRITE_MS and on close", async t => {
  const d = await dir(t);
  const store = new Store(d, 10, 80);
  await store.mutate(s => { s.workspaces.push(workspace({ prs: [pr()] })); });
  await until(() => store.writes === 1, "the first real change is written"); const base = store.writes;
  await store.mutate(stamp("2026-01-01T11:00:00Z"));
  await sleep(30); assert.equal(store.writes, base, "not before the volatile interval");
  await until(() => store.writes === base + 1, "written once the volatile interval passes");
  const closing = new Store(d, 10, 60_000);
  await closing.mutate(stamp("2026-01-01T12:00:00Z"));
  await closing.close(1000);
  assert.equal(JSON.parse(await readFile(join(d, "state.json"), "utf8")).workspaces[0].prs[0].snapshot.observedAt, "2026-01-01T12:00:00Z", "close writes pending read timestamps");
});

test("store-writes-only-real-changes: the inbox writes real changes only, lastSeen at most every LAST_SEEN_WRITE_MS, compact JSON", async t => {
  const d = await dir(t); let now = Date.parse("2026-01-01T10:00:00Z");
  const inbox = new InboxStore(d, () => now);
  const mtime = async () => (await stat(join(d, "inbox.json"))).mtimeMs;
  await inbox.mutate(s => { s.lastSeen = new Date(now).toISOString(); s.importedAt = "2026-01-01T09:00:00Z"; });
  const text = await readFile(join(d, "inbox.json"), "utf8");
  assert.ok(!text.includes("\n  "), "compact JSON, no pretty-print");
  const first = await mtime(); await sleep(15);
  await inbox.mutate(() => undefined);
  assert.equal(await mtime(), first, "an unchanged mutation writes nothing");
  now += 60_000; await inbox.mutate(s => { s.lastSeen = new Date(now).toISOString(); });
  assert.equal(await mtime(), first, "lastSeen alone waits");
  assert.equal((await inbox.snapshot()).lastSeen, new Date(now).toISOString(), "but reads see it");
  now += 300_000; await inbox.mutate(s => { s.lastSeen = new Date(now).toISOString(); });
  assert.notEqual(await mtime(), first, "written once LAST_SEEN_WRITE_MS has passed");
  const second = await mtime(); await sleep(15);
  now += 1000; await inbox.mutate(s => { s.lastSeen = new Date(now).toISOString(); s.unsorted = ["agent-1"]; });
  assert.notEqual(await mtime(), second, "a real change writes at once, lastSeen with it");
  now += 1000; await inbox.mutate(s => { s.lastSeen = new Date(now).toISOString(); });
  await inbox.flush();
  assert.equal(JSON.parse(await readFile(join(d, "inbox.json"), "utf8")).lastSeen, new Date(now).toISOString(), "flush (on stop) writes the pending lastSeen");
});

test("store-writes-only-real-changes: the worker's stop flushes the inbox's held lastSeen before the lock goes", async () => {
  const { stopWorker } = await import("../server/teardown");
  const order: string[] = [];
  await stopWorker({ ready: Promise.resolve(), actions: { close: async () => {} }, closeConnections: async () => {}, engine: { stop: async () => {} },
    store: { close: async () => { order.push("store"); } }, inbox: { flush: async () => { order.push("inbox"); } }, unlock: async () => { order.push("unlock"); } }, 2000);
  assert.deepEqual(order, ["store", "inbox", "unlock"]);
});
