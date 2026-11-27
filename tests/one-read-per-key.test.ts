import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { bundleStores, fakeHost, settle } from "./client-stores";
import { queueMoved } from "../shared/linear-queue";

/**
 * Invariant 142, one-read-per-key-at-mount (client/shared-read.ts). 2026-11-27, the broad perf check (Home's first
 * open, live-sized seed): `settings.display.read` went out three times in the same millisecond (the Display store, the
 * search shortcut, Home's order), `follow.usage` twice within 3 s (the open read, then the meters' poll starting at
 * once), and `follow.linear-queue` three times (the brief pane's read, then again when the home feed's first queue
 * revision arrived). The real client stores open on a fake host, the feeds push their first values, and each read
 * goes out at most once.
 */
async function mountReads(withFeeds: boolean) {
  const stores = await bundleStores(); stores.resetSharedReads();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-27T12:00:00Z") });
  const host = fakeHost(withFeeds, { "follow.usage": { available: true, source: "rpc", accounts: [] } });
  const live = stores.createLiveStore(host.client as never);
  const inbox = stores.createInboxStore(host.client as never);
  const extras = stores.createHomeExtras(host.client as never);
  const display = stores.contributeDisplay(host.client as never, {} as never);
  try {
    for (let ms = 0; ms < 1_000; ms += 250) { mock.timers.tick(250); await settle(); }
    // The worker's first pushes: the Display document, and Home's extras saying Smart Session can't be watched, so the
    // meters poll (the case that read usage twice).
    host.push("follow.display-feed", { status: "ready", revision: "r1", values: { home_sort: "attention" } });
    host.push("follow.home-feed", { priorities: [], rank: { running: false }, overseer: null, usage: null, usageLive: false, queue: { needs: [], timeZone: "UTC", revision: "q1" } });
    for (let ms = 0; ms < 4_000; ms += 250) { mock.timers.tick(250); await settle(); }
  } finally { live.stop(); inbox.stop(); await extras.stop(); display(); mock.timers.reset(); }
  const byName = new Map<string, number>(); for (const c of host.calls) byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
  const subscribed = new Map<string, number>(); for (const name of host.subscriptions) subscribed.set(name, (subscribed.get(name) ?? 0) + 1);
  return Object.assign(byName, { subscribed });
}

test("one-read-per-key-at-mount: on Paseo 0.16 the stores read each thing at most once at open, and the feeds' documents aren't read again", { timeout: 60_000 }, async () => {
  const reads = await mountReads(true);
  const twice = [...reads].filter(([, n]) => n > 1).map(([name, n]) => `${name} ×${n}`);
  assert.deepEqual(twice, [], "a read the stores share goes out once (client/shared-read.ts)");
  assert.equal(reads.get("settings.display.read") ?? 0, 0, "the Display feed's first event is the document: no read of it");
  assert.equal(reads.get("follow.usage"), 1, "the meters' poll reuses the open read");
  // 2026-11-27, live beta.4's first Home open: follow.display-feed subscribed twice (the Display store and Home's order).
  const feeds = [...reads.subscribed].filter(([, n]) => n > 1).map(([name, n]) => `${name} ×${n}`);
  assert.deepEqual(feeds, [], "each feed is subscribed once: Home's order follows the Display store's feed (followDisplayDoc)");
  assert.equal(reads.subscribed.get("follow.display-feed"), 1);
});

test("one-read-per-key-at-mount: on Paseo 0.15 the Display store and Home's order share one read", { timeout: 60_000 }, async () => {
  const reads = await mountReads(false);
  assert.equal(reads.get("settings.display.read"), 1, `Display read ${reads.get("settings.display.read")} times at open`);
});

test("one-read-per-key-at-mount: the brief pane re-reads the queue only when its revision moves, not when the feed's first one arrives", () => {
  assert.equal(queueMoved("", "q1"), false, "the feed's first revision after the pane's own read");
  assert.equal(queueMoved("q1", "q1"), false);
  assert.equal(queueMoved("q1", "q2"), true, "a sweep ended or a dismissal: read again");
});

test("one-read-per-key-at-mount: Home's order follows the Display store's one feed, whichever store starts first", { timeout: 60_000 }, async () => {
  for (const displayFirst of [true, false]) {
    const stores = await bundleStores(); stores.resetSharedReads();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-27T12:00:00Z") });
    const host = fakeHost(true);
    let display = displayFirst ? stores.contributeDisplay(host.client as never, {} as never) : null;
    const extras = stores.createHomeExtras(host.client as never);
    try {
      for (let ms = 0; ms < 500; ms += 250) { mock.timers.tick(250); await settle(); }
      // The document arrives before Home's store follows it (display first) or after (Home first): both take it.
      host.push("follow.display-feed", { status: "ready", revision: "r1", values: { home_sort: "recent" } });
      display ??= stores.contributeDisplay(host.client as never, {} as never);
      if (!displayFirst) host.push("follow.display-feed", { status: "ready", revision: "r1", values: { home_sort: "recent" } });
      for (let ms = 0; ms < 1_000; ms += 250) { mock.timers.tick(250); await settle(); }
      assert.equal(extras.sort(), "recent", `Home's order takes the pushed document (${displayFirst ? "Display store first" : "Home first"})`);
      host.push("follow.display-feed", { status: "ready", revision: "r2", values: { home_sort: "name" } });
      for (let ms = 0; ms < 500; ms += 250) { mock.timers.tick(250); await settle(); }
      assert.equal(extras.sort(), "name", "and every later push");
      assert.equal(host.subscriptions.filter(n => n === "follow.display-feed").length, 1, "through one subscription");
    } finally { await extras.stop(); display?.(); mock.timers.reset(); }
  }
});
