import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { bundleStores, fakeHost, settle, type SubscribeMode } from "./client-stores";
import { feedRetryMs, FEED_RETRY_FAST } from "../client/feeds";

/**
 * Invariant idle-client-makes-at-most-one-rpc-a-minute keeps the client quiet; these keep it correct. A feed that never
 * pushes, or that dies with the worker and never comes back, would be just as quiet, and on Paseo 0.16 nothing polls to
 * cover for it. The real client stores (tests/client-stores.ts) run on fake timers against a fake host whose worker
 * pushes, exits, comes back, or doesn't know a topic. The harness covers the same cases end to end
 * (`scripts/check-feeds.mjs`, `npm run test:feeds`).
 */
const FEEDS = ["follow.workspaces-feed", "follow.inbox-feed", "follow.home-feed", "follow.display-feed"];

async function open(modeAtStart: (name: string) => SubscribeMode = () => "serve") {
  const stores = await bundleStores();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-12T12:00:00Z") });
  const host = fakeHost(true);
  host.setMode(modeAtStart);
  const live = stores.createLiveStore(host.client as never);
  const inbox = stores.createInboxStore(host.client as never);
  const extras = stores.createHomeExtras(host.client as never);
  const display = stores.contributeDisplay(host.client as never, {} as never);
  const tick = async (ms: number) => { for (let t = 0; t < ms; t += 250) { mock.timers.tick(250); await settle(); } };
  const close = async () => { live.stop(); inbox.stop(); await extras.stop(); display(); mock.timers.reset(); };
  await tick(1_000);
  return { host, live, extras, tick, close, callsSince: (at: number, name?: string) => host.calls.filter(c => c.at >= at && (!name || c.name === name)).length };
}

const workspace = (id: string, title: string) => ({ id, title, archived: false, prs: [], agents: [] });

test("a pushed change reaches the store with no RPC: the list and Home's priorities", { timeout: 60_000 }, async () => {
  const c = await open();
  try {
    const at = Date.now();
    c.host.push("follow.workspaces-feed", { revision: 2, full: false, workspaces: [workspace("w9", "Pushed")], removed: [], error: null });
    c.host.push("follow.home-feed", { priorities: [{ id: "p1", title: "Pushed priority", source: "linear", rank: 1 }], rank: { running: false }, overseer: null, usage: null, usageLive: true });
    await c.tick(500);
    assert.deepEqual(c.live.all().map(w => w.title), ["Pushed"], "the workspaces feed's event is applied");
    assert.deepEqual(c.extras.priorities().map(p => p.id), ["p1"], "the home feed's event is applied");
    assert.equal(c.callsSince(at), 0, "no RPC was needed");
  } finally { await c.close(); }
});

test("the worker restarts: every store reads at once, polls while it's gone, resubscribes within 5 s of it coming back, and goes quiet", { timeout: 120_000 }, async () => {
  const c = await open();
  try {
    await c.tick(60_000);
    const before = Object.fromEntries(FEEDS.map(name => [name, c.host.live(name)]));
    for (const name of FEEDS) assert.ok(before[name] >= 1, `${name} is open before the restart`);
    const down = Date.now();
    c.host.setMode(() => "refuse"); // a stopped worker: Paseo refuses the subscribe
    c.host.closeAll();
    await c.tick(1_000);
    for (const name of ["follow.list", "follow.inbox-list", "follow.overseer-status", "follow.priorities"]) assert.ok(c.callsSince(down, name) >= 1, `${name} is read as soon as its feed goes down`);
    await c.tick(19_000); // a slow restart: 20 s
    assert.ok(c.callsSince(down, "follow.list") >= 2, "the list keeps polling while the worker is gone");
    const back = Date.now();
    c.host.setMode(() => "serve");
    await c.tick(5_000);
    for (const name of FEEDS) assert.equal(c.host.live(name), before[name], `${name} is subscribed again within 5 s of the worker coming back`);
    c.host.push("follow.workspaces-feed", { revision: 1, full: true, workspaces: [workspace("w1", "After the restart")], removed: [], error: null });
    await c.tick(500);
    assert.deepEqual(c.live.all().map(w => w.title), ["After the restart"], "the resubscribed feed's events land");
    const quiet = Date.now();
    await c.tick(5 * 60_000);
    const rpm = c.callsSince(quiet) / 5;
    assert.ok(rpm <= 1, `back to at most one RPC a minute after the restart (${rpm}); polls must stop when the feed is back (${back - down} ms down)`);
  } finally { await c.close(); }
});

for (const mode of ["refuse", "throw"] as const) {
  test(`a feed the worker won't serve (subscribe ${mode === "refuse" ? "rejects" : "throws"}): only that store falls back to its poll`, { timeout: 120_000 }, async () => {
    const c = await open(name => name === "follow.inbox-feed" ? mode : "serve");
    try {
      const at = Date.now();
      await c.tick(2 * 60_000);
      assert.ok(c.callsSince(at, "follow.inbox-list") >= 6, `Needs you polls its list (${c.callsSince(at, "follow.inbox-list")} in 2 min)`);
      for (const name of ["follow.list", "follow.overseer-status", "follow.priorities"]) assert.equal(c.callsSince(at, name), 0, `${name} stays on its feed`);
      assert.equal(c.host.live("follow.inbox-feed"), 0);
      // An older worker during a rolling reload: once the new one serves the topic, the store moves onto the feed.
      c.host.setMode(() => "serve");
      await c.tick(31_000);
      assert.equal(c.host.live("follow.inbox-feed"), 1, "subscribed once the worker serves it");
      const quiet = Date.now();
      await c.tick(60_000);
      assert.equal(c.callsSince(quiet, "follow.inbox-list"), 0, "and stops polling");
    } finally { await c.close(); }
  });
}

test("resubscribe: every second for the first tries, then backing off to 30 s", () => {
  assert.equal(feedRetryMs(0), 1_000); assert.equal(feedRetryMs(FEED_RETRY_FAST - 1), 1_000);
  assert.equal(feedRetryMs(FEED_RETRY_FAST), 2_000); assert.equal(feedRetryMs(100), 30_000);
});
