import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { bundleStores, fakeHost, settle } from "./client-stores";

/**
 * Invariant idle-client-makes-at-most-one-rpc-a-minute (Paseo 0.16, plan item 6): an open Follow-up client that the
 * developer isn't touching makes at most one plugin RPC a minute. Before, every open client polled the workspace list,
 * Needs you, the Overseer (each every 15 s), priorities, the ranker, usage and the Display setting (each every 60 s):
 * about 17 a minute for an idle Home, before any panel. Now the worker pushes them (client/feeds.ts, server/feeds.ts).
 *
 * The real client stores (tests/client-stores.ts) run against a fake host for ten simulated minutes. On a 0.15 host
 * (no `client.subscribe`) the same stores must still poll, or nothing would ever update there. That they stay correct
 * (a push lands, a restarted worker is resubscribed) is tests/feed-recovery.test.ts.
 */
const MINUTES = 10;
const OPEN_MS = 5_000;

async function idleRpcsPerMinute(withFeeds: boolean) {
  const stores = await bundleStores();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-12T12:00:00Z") });
  const host = fakeHost(withFeeds);
  const started = Date.now();
  const live = stores.createLiveStore(host.client as never);
  const inbox = stores.createInboxStore(host.client as never);
  const extras = stores.createHomeExtras(host.client as never);
  const display = stores.contributeDisplay(host.client as never, {} as never);
  try {
    for (let ms = 0; ms < MINUTES * 60_000; ms += 1_000) { mock.timers.tick(1_000); await settle(); }
  } finally {
    live.stop(); inbox.stop(); await extras.stop(); display();
    mock.timers.reset();
  }
  const idle = host.calls.filter(c => c.at - started >= OPEN_MS);
  const byName = new Map<string, number>(); for (const c of idle) byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
  return { perMinute: idle.length / MINUTES, byName: [...byName].map(([n, k]) => `${n} ${k}`).join(", "), subscriptions: host.subscriptions };
}

test("invariant idle-client-makes-at-most-one-rpc-a-minute: an idle open client on Paseo 0.16 is pushed to, not polling", { timeout: 120_000 }, async () => {
  const r = await idleRpcsPerMinute(true);
  assert.ok(r.perMinute <= 1, `an idle open client made ${r.perMinute} RPCs a minute (${r.byName}); subscribe to a feed (client/feeds.ts) instead of polling`);
  for (const feed of ["follow.workspaces-feed", "follow.inbox-feed", "follow.home-feed", "follow.display-feed"]) assert.ok(r.subscriptions.includes(feed), `subscribed to ${feed}: ${r.subscriptions.join(", ")}`);
});

test("on Paseo 0.15 (no client.subscribe) the same stores still poll, so the client keeps updating", { timeout: 120_000 }, async () => {
  const r = await idleRpcsPerMinute(false);
  assert.ok(r.perMinute >= 8, `a 0.15 client polled only ${r.perMinute} times a minute (${r.byName})`);
  for (const name of ["follow.list", "follow.inbox-list", "follow.overseer-status"]) assert.match(r.byName, new RegExp(`${name.replace(".", "\\.")} \\d+`), `${name} still polls on 0.15`);
});
