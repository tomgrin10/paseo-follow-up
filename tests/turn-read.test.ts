import test from "node:test";
import assert from "node:assert/strict";
import { daemonDirectory, TURN_READ_CAP } from "../server/inbox-directory";
import type { DaemonDirectory } from "../server/directory";
import type { withDaemon } from "../server/daemon";

// Invariant a-turn-end-reads-the-turn-once. 2026-11-13 (live-sized busy window: 30 timeline items of 8 KB a turn):
// every turn end read the newest 100 entries for the engine and 20 more for the inbox, ~1 MB parsed per turn, most of
// it older turns. A turn end now reads its own turn, back to the item that started it, once for both readers.

function fixture(turns: number[], start = "user_message") {
  const items: { seqStart: number; item: unknown }[] = [];
  for (const length of turns) {
    items.push({ seqStart: items.length, item: { type: start, text: "Fixture prompt" } });
    for (let i = 1; i < length; i++) items.push({ seqStart: items.length, item: { type: "tool_call", name: "shell", output: "x".repeat(8000) } });
  }
  const reads: { direction: string; limit: number; entries: number }[] = [];
  const client = {
    fetchAgent: async () => ({ agent: { id: "a", status: "running", activeTurn: null } }),
    fetchAgentTimeline: async (_id: string, o: { direction: string; cursor?: { seq: number }; limit: number }) => {
      const end = o.direction === "tail" ? items.length : o.cursor!.seq;
      const page = items.slice(Math.max(0, end - o.limit), end);
      reads.push({ direction: o.direction, limit: o.limit, entries: page.length });
      return { entries: page, startCursor: page.length ? { epoch: "e", seq: page[0]!.seqStart } : null, hasOlder: (page[0]?.seqStart ?? 0) > 0, error: null, gap: false, staleCursor: false };
    },
  };
  const connect = (async (work: (c: never) => unknown) => work(client as never)) as unknown as typeof withDaemon;
  const directory = daemonDirectory({ cached: () => undefined } as unknown as DaemonDirectory, connect);
  return { directory, reads };
}

test("a-turn-end-reads-the-turn-once: a turn end reads back to its own prompt, not a fixed page of 100", async () => {
  const { directory, reads } = fixture([30, 30, 30]);
  const items = await directory.turnItems!("a", "turn-3");
  assert.ok(items.slice(-31).some(i => (i as { type: string }).type === "user_message"), "the ended turn's prompt is in the read");
  assert.ok(items.length < 60, `${items.length} items read for a 30-item turn`);
  assert.ok(reads.reduce((n, r) => n + r.entries, 0) <= 50, "two small pages at most");
});

test("a-turn-end-reads-the-turn-once: the engine and the inbox share one read of the same turn end", async () => {
  const { directory, reads } = fixture([30, 30]);
  const [a, b] = await Promise.all([directory.turnItems!("a", "turn-2"), directory.turnItems!("a", "turn-2")]);
  assert.equal(a, b);
  const count = reads.length;
  await directory.turnItems!("a", "turn-2");
  assert.equal(reads.length, count, "a third ask of the same turn end reads nothing");
});

test("a-turn-end-reads-the-turn-once: a turn longer than TURN_READ_CAP is read only that far back, as before", async () => {
  const { directory, reads } = fixture([300]);
  const items = await directory.turnItems!("a", "turn-1");
  assert.equal(items.length, TURN_READ_CAP);
  assert.equal(reads.reduce((n, r) => n + r.entries, 0), TURN_READ_CAP);
});
