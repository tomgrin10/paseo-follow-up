import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, INBOX_WRITE_MS, InboxStore, type AgentInfo, type Directory } from "../server/inbox";
import type { Sources } from "../server/inbox-classifier";

// Invariant the-inbox-writes-at-most-once-per-window. 2026-11-13 (run W: a copy of a live install under 20 turns a
// minute): every inbox mutation stringified the whole inbox (133 KB) and wrote it, about twice a turn, 54 MB of
// garbage every 5 minutes. A real change now waits in memory (where every reader in the worker reads it) and one write
// per INBOX_WRITE_MS carries the window's changes; stop flushes it.

const TURNS = 5;
const at = Date.parse("2026-11-10T00:01:00.000Z");

async function fixture(t: { after(fn: () => unknown): void }, writeMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "follow-inbox-window-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { workspaceId: "w1", parentAgentId: null, title: "Agent", status: "idle", archivedAt: null, updatedAt: "2026-11-10T00:00:00.000Z", lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
  const agents: AgentInfo[] = [{ ...base, id: "main" }];
  const directory: Directory = {
    async agents() { return agents; }, async workspaces() { return [{ id: "w1", name: "w1" }]; },
    async agent(id) { return agents.find(a => a.id === id) ?? null; },
    async tail() { return [{ type: "user_message", text: "Fixture prompt" }, { type: "assistant_message", text: "Fixture reply" }]; }, async clearAttention() {},
  };
  const none: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };
  const inbox = new Inbox(dir, { writeMs, enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: none, guard: async () => null, graceMs: 5, now: () => at } as never);
  await inbox.store.mutate(s => { s.importedAt = "2026-11-10T00:00:00.000Z"; s.lastSeen = "2026-11-10T00:00:30.000Z"; s.primedAt = "2026-11-10T00:00:00.000Z"; s.notifiedAt = "2026-11-10T00:00:00.000Z"; });
  await inbox.store.flush();
  return { dir, inbox };
}

test("the-inbox-writes-at-most-once-per-window: a burst of turns inside one window writes the inbox once", async t => {
  const { dir, inbox } = await fixture(t, INBOX_WRITE_MS);
  const before = inbox.store.writes;
  for (let n = 1; n <= TURNS; n++) {
    await inbox.turnStarted({ id: "main", workspaceId: "w1" }, `t${n}`);
    await inbox.turnEnded({ id: "main", workspaceId: "w1" }, { kind: "completed" }, `t${n}`);
  }
  const during = inbox.store.writes - before;
  assert.equal(during, 0, `${during} inbox writes inside the window for ${TURNS} turns (main writes on every mutation)`);
  assert.ok((await inbox.store.snapshot()).entries.main, "the worker's own readers see the change at once");
  await inbox.store.flush();
  assert.equal(inbox.store.writes - before, 1, "stop's flush writes the window's changes once");
  assert.ok(JSON.parse(await readFile(join(dir, "inbox.json"), "utf8")).entries.main, "and the file holds them");
});

test("the-inbox-writes-at-most-once-per-window: a held change reaches the file within the window, without a flush", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-inbox-window-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new InboxStore(dir, Date.now, 20);
  await store.mutate(s => { s.unsorted = ["agent-1"]; });
  await store.mutate(s => { s.unsorted = ["agent-1", "agent-2"]; });
  assert.equal(store.writes, 0, "held for the window");
  const deadline = Date.now() + 2_000;
  while (store.writes === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(store.writes, 1, "one write for both changes");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "inbox.json"), "utf8")).unsorted, ["agent-1", "agent-2"]);
});

test("the-inbox-writes-at-most-once-per-window: the worker passes the window and its stop flushes the inbox", async () => {
  const source = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(source, /new Inbox\(directory, \{\s*writeMs: INBOX_WRITE_MS,/, "the worker's inbox batches its writes");
  assert.match(source, /stopWorker\(\{[^}]*inbox: inbox\.store/, "stop flushes the inbox store");
});
