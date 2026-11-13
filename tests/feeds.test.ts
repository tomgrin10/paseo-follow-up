import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValueFeed, WorkspacesFeed } from "../server/feeds";
import { ListCache } from "../server/list-cache";
import { UsageReader } from "../server/usage";
import { usageKey, type Usage } from "../shared/usage";
import { workspace } from "./fixtures";
import type { State } from "../shared/model";

/**
 * The worker's side of invariant idle-client-makes-at-most-one-rpc-a-minute (server/feeds.ts): one shared serve per
 * topic, fed by changes to state the worker already holds. A change reads the value once for every subscriber, an
 * unchanged change pushes nothing, and nothing runs while nobody subscribes.
 */
const sub = () => { const c = new AbortController(); const got: unknown[] = []; return { signal: c.signal, abort: () => c.abort(), got, push: async (e: unknown) => { got.push(e); } }; };
const settle = () => new Promise(r => setImmediate(r));

test("a value feed reads once per change for every subscriber and pushes only a value that changed", async () => {
  let value = 1; let reads = 0;
  const feed = new ValueFeed({ read: async () => { reads++; return { n: value }; } });
  await feed.changed(); assert.equal(reads, 0, "no subscriber: nothing is read");
  const a = sub(), b = sub();
  feed.serve(a.push, a.signal); feed.serve(b.push, b.signal); await settle();
  assert.deepEqual([a.got, b.got], [[{ n: 1 }], [{ n: 1 }]], "each subscriber gets the current value first");
  reads = 0; await feed.changed();
  assert.equal(reads, 1, "one read for both"); assert.equal(a.got.length, 1, "an unchanged value pushes nothing");
  value = 2; await feed.changed();
  assert.deepEqual(a.got.at(-1), { n: 2 }); assert.deepEqual(b.got.at(-1), { n: 2 });
  a.abort(); value = 3; await feed.changed();
  assert.equal(a.got.length, 2, "a released subscriber gets nothing more"); assert.deepEqual(b.got.at(-1), { n: 3 });
});

test("a value feed's watcher runs only while someone subscribes", async () => {
  const events: string[] = [];
  const feed = new ValueFeed({ read: async () => 1, onFirst: () => events.push("first"), onLast: () => events.push("last") });
  const a = sub(), b = sub();
  feed.serve(a.push, a.signal); feed.serve(b.push, b.signal);
  a.abort(); assert.deepEqual(events, ["first"]);
  b.abort(); assert.deepEqual(events, ["first", "last"]);
});

test("the workspaces feed sends the full list first, then only what changed, and nothing for an unchanged save", async () => {
  const one = workspace({ id: "w1", title: "One" }), two = workspace({ id: "w2", title: "Two" });
  let state = { workspaces: [one, two] } as unknown as State;
  let error: string | null = null;
  const feed = new WorkspacesFeed(new ListCache(), async () => state, () => error);
  const a = sub();
  feed.serve(undefined, a.push, a.signal); await settle();
  const first = a.got[0] as { full: boolean; workspaces: { id: string }[] };
  assert.equal(first.full, true); assert.deepEqual(first.workspaces.map(w => w.id), ["w1", "w2"]);
  state = { ...state } as State; await feed.changed();
  assert.equal(a.got.length, 1, "a save that changed no workspace pushes nothing");
  state = { workspaces: [{ ...one, title: "One, renamed" }, two] } as unknown as State; await feed.changed();
  const diff = a.got[1] as { full: boolean; workspaces: { id: string; title: string }[]; removed: string[] };
  assert.equal(diff.full, false); assert.deepEqual(diff.workspaces.map(w => w.title), ["One, renamed"]);
  state = { workspaces: [{ ...one, title: "One, renamed" }] } as unknown as State; await feed.changed();
  assert.deepEqual((a.got[2] as { removed: string[] }).removed, ["w2"]);
  error = "GitHub is unreachable"; await feed.changed();
  assert.equal((a.got[3] as { error: string | null }).error, "GitHub is unreachable", "the worker's error rides along");
});

test("usage: the key is what the meters show, so a reading with the same rounded numbers pushes nothing", () => {
  const at = (pct: number, readAt = "2026-11-12T12:00:10Z"): Usage => ({ available: true, source: "rpc", accounts: [{ id: "a", name: "A", family: "claude", isDefault: true, readAt, windows: [{ id: "five_hour", label: "5h", pct, resetsAt: null }] }] });
  assert.equal(usageKey(at(41.2)), usageKey(at(40.8, "2026-11-12T12:01:10Z")), "41 % either way, read a minute later");
  assert.notEqual(usageKey(at(41.2)), usageKey(at(42.1)));
  assert.notEqual(usageKey(at(41.2)), usageKey(at(41.2, "2026-11-12T12:20:00Z")), "a reading 20 minutes on changes the age tag");
});

test("usage: Smart Session's directory is watched (a new month's file counts), debounced; no directory, no watcher", async t => {
  const home = await mkdtemp(join(tmpdir(), "follow-feeds-")); t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(new UsageReader(home, async () => { throw new Error("none"); }).watch(() => undefined, 10), null, "no Smart Session: the client reads usage itself");
  const dir = join(home, "plugin-data", "smart-session"); await mkdir(dir, { recursive: true });
  let reads = 0; let changes = 0;
  const reader = new UsageReader(home, async () => { reads++; return { windows: [{ id: "five_hour", pct: 10, resetsAt: null }] }; });
  const watch = reader.watch(() => { changes++; }, 50)!;
  t.after(() => watch.close());
  await writeFile(join(dir, "accounts-2026-11.jsonl"), "{}\n"); await writeFile(join(dir, "accounts-2026-11.jsonl"), "{}\n{}\n");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(changes, 1, "two writes inside the debounce are one change"); assert.ok(reads >= 1, "the change reads usage once more");
  await writeFile(join(dir, "accounts-2026-12.jsonl"), "{}\n");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(changes, 2, "the next month's file is seen too");
  await writeFile(join(dir, "other.json"), "{}");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(changes, 2, "other files in the directory are ignored");
});
