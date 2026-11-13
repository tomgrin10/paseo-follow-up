import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../server/inbox";
import { newEntry, type InboxState } from "../shared/inbox";

// Invariant an-inbox-mutation-copies-one-entry. 2026-11-13 (live 2.0.1-beta.4, 153-PR workspace, 86 inbox entries):
// the worker's RSS stepped 315 → 405 MB while agents were busy, with the JS heap the size of an idle harness. Each turn
// start or end, flag, brief step and answer is an inbox mutation, and every one structuredCloned the whole inbox,
// validated it with zod and stringified it three times (text, `rest`, and `rest` again after the write): 28% of the
// worker's 4.3 MB/s under a live-like turn mix (scale-check --data-from … --live-mix, alloc-prof). Like state.json
// (a-send-never-clones-the-whole-state), a mutation copies only the entries it touches, keeps every other entry's saved
// object, validates only what changed, and serialises the inbox once per real write.

async function dir(t: { after(fn: () => unknown): void }) { const d = await mkdtemp(join(tmpdir(), "follow-inbox-copies-")); t.after(() => rm(d, { recursive: true, force: true })); return d; }

/** A live-sized inbox: 86 entries, each with a full seenKeys ring and a flag. Synthetic ids only. */
function seed(s: InboxState, n = 86) {
  s.importedAt = "2026-11-13T05:00:00.000Z"; s.primedAt = "2026-11-13T05:00:00.000Z";
  for (let i = 0; i < n; i++) {
    const e = newEntry(`agent-${i}`);
    e.seenKeys = Array.from({ length: 200 }, (_, k) => `example/app#${1000 + k}:MERGED`);
    e.needs = { reasons: [{ reason: "finished", at: "2026-11-13T05:00:00.000Z", detail: `Synthetic finish ${i}`, dedupeKey: `finish:${i}` }], since: "2026-11-13T05:00:00.000Z" };
    e.lastEventAt = "2026-11-13T05:00:00.000Z";
    s.entries[e.agentId] = e;
  }
}

/** Counts JSON.stringify calls on the whole inbox (anything with `entries` and `ledger`) while `work` runs. */
async function wholeStringifies<T>(work: () => Promise<T>): Promise<number> {
  const original = JSON.stringify; let n = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => { if (value && typeof value === "object" && "entries" in value && "ledger" in value) n++; return (original as (...a: unknown[]) => string)(value, ...rest); }) as typeof JSON.stringify;
  try { await work(); } finally { JSON.stringify = original; }
  return n;
}

test("an-inbox-mutation-copies-one-entry: a mutation of one entry keeps every other entry's saved object", async t => {
  const store = new InboxStore(await dir(t));
  await store.mutate(s => seed(s));
  const before = await store.snapshot();
  await store.mutate(s => { s.entries["agent-3"].lastEventAt = "2026-11-13T06:00:00.000Z"; });
  const after = await store.snapshot();
  assert.equal(after.entries["agent-3"].lastEventAt, "2026-11-13T06:00:00.000Z", "the change is there");
  assert.notEqual(after.entries["agent-3"], before.entries["agent-3"], "the touched entry is a new object");
  const copied = Object.keys(after.entries).filter(id => id !== "agent-3" && after.entries[id] !== before.entries[id]);
  assert.deepEqual(copied, [], "no untouched entry was copied");
  assert.ok(Object.isFrozen(after.entries["agent-3"]), "the saved entry is frozen, like the rest");
  assert.throws(() => { (after.entries["agent-0"] as { lastEventAt: string | null }).lastEventAt = "x"; }, "a snapshot can't be changed in place");
});

test("an-inbox-mutation-copies-one-entry: reading an entry inside a mutation without changing it copies and writes nothing", async t => {
  const d = await dir(t);
  const store = new InboxStore(d);
  await store.mutate(s => seed(s));
  const before = await store.snapshot(); const file = await readFile(join(d, "inbox.json"), "utf8");
  const n = await wholeStringifies(() => store.mutate(s => { for (const e of Object.values(s.entries)) void e.brief; return s.entries["agent-1"].needs?.reasons.length; }));
  const after = await store.snapshot();
  assert.equal(after, before, "the same saved state");
  assert.equal(n, 0, "no whole-inbox serialisation for a mutation that changed nothing");
  assert.equal(await readFile(join(d, "inbox.json"), "utf8"), file, "nothing written");
});

test("an-inbox-mutation-copies-one-entry: a real change serialises the inbox once (the file's text), not three times", async t => {
  const store = new InboxStore(await dir(t));
  await store.mutate(s => seed(s));
  const n = await wholeStringifies(() => store.mutate(s => { s.entries["agent-5"].needs = null; }));
  assert.equal(n, 1, "one stringify per write");
});

test("an-inbox-mutation-copies-one-entry: adds, deletes, replacements and root fields still land, and an invalid entry is refused", async t => {
  const d = await dir(t);
  const store = new InboxStore(d);
  await store.mutate(s => seed(s, 4));
  await store.mutate(s => {
    s.entries["agent-new"] = newEntry("agent-new");
    delete s.entries["agent-0"];
    s.entries["agent-1"] = { ...s.entries["agent-1"], seq: 7 };
    s.ledger = [...s.ledger, { agentId: "agent-2", messageId: "m1", at: "2026-11-13T06:00:00.000Z" }];
  });
  const after = await store.snapshot();
  assert.deepEqual(Object.keys(after.entries).sort(), ["agent-1", "agent-2", "agent-3", "agent-new"]);
  assert.equal(after.entries["agent-1"].seq, 7);
  assert.equal(after.ledger.length, 1);
  const disk = JSON.parse(await readFile(join(d, "inbox.json"), "utf8"));
  assert.deepEqual(Object.keys(disk.entries).sort(), ["agent-1", "agent-2", "agent-3", "agent-new"], "the file matches");
  await assert.rejects(store.mutate(s => { (s.entries["agent-2"] as { seq: unknown }).seq = "not a number"; }), "a changed entry is still validated");
  assert.equal((await store.snapshot()).entries["agent-2"].seq, 0, "and a refused mutation changes nothing");
});
