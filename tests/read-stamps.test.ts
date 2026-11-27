import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { ListCache } from "../server/list-cache";
import { WorkspacesFeed } from "../server/feeds";
import { listEntry, READS_PUSH_MS, splitReadStamps, withReadStamps } from "../shared/list";
import type { State, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";
import { bundleStores, fakeHost, settle } from "./client-stores";

/**
 * Invariant 140, read-stamps-never-count (shared/list.ts splitReadStamps). 2026-11-27, live-sized seed: every GitHub
 * probe moved `snapshot.observedAt`, the list entry carried it, so the workspaces feed resent whole workspaces for a
 * change nobody could see: 342 KB every ~15 s and 2 MB about once a minute, and every client rebuilt Home and
 * re-rendered its panel each time. A read-time stamp is not a change: entries are diffed and sent without them, the
 * stamps ride beside (`reads`), stamps-only at most once per READS_PUSH_MS, and the client store puts them back.
 */
const at = (ms: number) => new Date(clock + ms).toISOString();
const merged = (observed: string, deployObserved: string) => snapshot({ state: "MERGED", mergeCommit: "m1", observedAt: observed, deployment: { state: "pending", observedAt: deployObserved } as never });
/** The heavy workspace of the live-sized seed: 153 PRs. */
const big = (observed: string, patch: Partial<Workspace> = {}) => workspace({ id: "w0", title: "Big", prs: Array.from({ length: 153 }, (_, i) => pr({ key: `example/app#${i + 1}`, number: i + 1, snapshot: snapshot({ title: `Change ${i + 1}`, observedAt: observed }) })), ...patch });
const small = (id: string, observed: string) => workspace({ id, title: id, prs: [pr({ snapshot: merged(observed, observed) })] });
const state = (...workspaces: Workspace[]): State => ({ version: 1, workspaces } as State);

test("read-stamps-never-count: an entry splits into a bare entry and its stamps, and fills back to the same list form", () => {
  const w = small("w1", at(5_000));
  const entry = listEntry(w);
  const { bare, stamps } = splitReadStamps(entry);
  assert.ok(!JSON.stringify(bare).includes("observedAt"), "the bare entry carries no read stamp");
  assert.deepEqual(stamps, { "example/app#1": [at(5_000), at(5_000)] });
  assert.deepEqual(withReadStamps(bare, stamps), entry, "filled back, it is the list form readers had before");
  assert.equal(withReadStamps(bare, null), bare, "no stamps: the same object");
  const unread = workspace({ id: "w2", prs: [pr({ snapshot: null })] });
  assert.equal(splitReadStamps(listEntry(unread)).stamps, null, "a PR never read has no stamps");
});

test("read-stamps-never-count: a probe that moved only read stamps sends no workspace, just the stamps", () => {
  const cache = new ListCache();
  const first = cache.answer(state(big(at(0)), small("w1", at(0))));
  assert.equal(first.full, true);
  assert.equal(Object.keys(first.reads).length, 2, "a full answer carries every workspace's stamps");
  assert.ok(!JSON.stringify(first.workspaces).includes("observedAt"), "entries go out bare");
  // Every PR of the 153-PR workspace re-read 15 s later: nothing a reader sees changed.
  const probe = cache.answer(state(big(at(15_000)), small("w1", at(0))), first.revision);
  assert.deepEqual([probe.full, probe.workspaces.length, probe.removed.length, probe.stampsOnly], [false, 0, 0, true]);
  assert.deepEqual(Object.keys(probe.reads), ["w0"], "only the workspace whose stamps moved");
  const bytes = JSON.stringify(probe).length, whole = JSON.stringify(first.workspaces[0]).length;
  assert.ok(bytes < whole / 3, `stamps of 153 PRs are ${bytes} B, the workspace they used to resend ${whole} B`);
  // A real change: the entry goes out, with its stamps, so the client never holds it bare.
  const renamed = cache.answer(state(big(at(15_000), { title: "Big, renamed" }), small("w1", at(0))), probe.revision);
  assert.deepEqual(renamed.workspaces.map(w => w.id), ["w0"]); assert.deepEqual(Object.keys(renamed.reads), ["w0"]);
  assert.equal(renamed.stampsOnly, false);
  // A client behind both gets the change and the stamps that moved since its revision.
  const behind = cache.answer(state(big(at(15_000), { title: "Big, renamed" }), small("w1", at(30_000))), first.revision);
  assert.deepEqual(behind.workspaces.map(w => w.id), ["w0"]); assert.deepEqual(Object.keys(behind.reads).sort(), ["w0", "w1"]);
});

test("read-stamps-never-count: the feed holds stamps-only pushes for READS_PUSH_MS, keeps them, and sends a real change at once", async () => {
  let now = clock; let s = state(big(at(0)), small("w1", at(0)));
  const feed = new WorkspacesFeed(new ListCache(), async () => s, () => null, () => now);
  const got: { full: boolean; workspaces: { id: string; title: string }[]; reads: Record<string, unknown> }[] = [];
  const c = new AbortController();
  feed.serve(undefined, async e => { got.push(e as never); }, c.signal); await settle();
  assert.equal(got.length, 1);
  // Probes every 15 s for most of a minute: nothing goes out.
  for (let t = 15_000; t < READS_PUSH_MS; t += 15_000) { now = clock + t; s = state(big(at(t)), small("w1", at(t))); await feed.changed(); }
  assert.equal(got.length, 1, "stamps alone wait out the window");
  // A real change inside the window goes out at once, carrying the held stamps too.
  s = state(big(at(45_000)), { ...small("w1", at(45_000)), title: "w1, renamed" }); await feed.changed();
  assert.equal(got.length, 2); assert.deepEqual(got[1]!.workspaces.map(w => w.id), ["w1"]);
  assert.deepEqual(Object.keys(got[1]!.reads).sort(), ["w0", "w1"], "held stamps ride with the next push");
  // Stamps alone again: held until a minute after that push, then sent with no workspace.
  now = clock + 60_000; s = state(big(at(60_000)), { ...small("w1", at(60_000)), title: "w1, renamed" }); await feed.changed();
  assert.equal(got.length, 2);
  now = clock + 45_000 + READS_PUSH_MS; s = state(big(at(105_000)), { ...small("w1", at(105_000)), title: "w1, renamed" }); await feed.changed();
  assert.equal(got.length, 3); assert.deepEqual(got[2]!.workspaces, []); assert.deepEqual(Object.keys(got[2]!.reads).sort(), ["w0", "w1"]);
  assert.ok(!("stampsOnly" in got[2]!), "the hold flag stays in the worker");
  c.abort();
});

test("read-stamps-never-count: the client store fills stamps back in, and a stamps-only push touches only its workspace", { timeout: 60_000 }, async () => {
  const stores = await bundleStores();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: clock });
  const host = fakeHost(true);
  const live = stores.createLiveStore(host.client as never);
  try {
    for (let i = 0; i < 4; i++) { mock.timers.tick(250); await settle(); }
    const cache = new ListCache();
    const first = cache.answer(state(small("w1", at(0)), small("w2", at(0))));
    host.push("follow.workspaces-feed", { ...first, stampsOnly: undefined, error: null });
    await settle();
    const snap = (id: string) => (live.get(id) as Workspace).prs[0]!.snapshot as { observedAt?: string; deployment?: { observedAt?: string } };
    assert.equal(snap("w1").observedAt, at(0), "a full answer's entries are filled"); assert.equal(snap("w1").deployment?.observedAt, at(0));
    const w2 = live.get("w2");
    const probe = cache.answer(state(small("w1", at(15_000)), small("w2", at(0))), first.revision);
    assert.deepEqual(probe.workspaces, []);
    host.push("follow.workspaces-feed", { ...probe, error: null });
    await settle();
    assert.equal(snap("w1").observedAt, at(15_000), "the held entry takes its new stamps"); assert.equal(snap("w1").deployment?.observedAt, at(15_000));
    assert.equal(live.get("w2"), w2, "a workspace whose stamps didn't move keeps its object (no re-render)");
    // A changed entry arrives bare with its stamps; a later bare entry keeps the stamps the store holds.
    const renamed = cache.answer(state({ ...small("w1", at(15_000)), title: "Renamed", updatedAt: at(20_000) }, small("w2", at(0))), probe.revision);
    host.push("follow.workspaces-feed", { ...renamed, error: null });
    await settle();
    assert.equal((live.get("w1") as Workspace).title, "Renamed"); assert.equal(snap("w1").observedAt, at(15_000));
  } finally { live.stop(); mock.timers.reset(); }
});
