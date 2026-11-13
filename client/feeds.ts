import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginSubscriptionContract } from "@getpaseo/plugin";
import type { z } from "zod";

/**
 * One of the worker's feeds, kept open (Paseo 0.16 `client.subscribe`; invariant idle-client-makes-at-most-one-rpc-a-minute,
 * docs/client.md#feeds). `live` says whether pushes are arriving: while it is false the store polls its RPC.
 *
 * A subscription ends when the worker restarts (a plugin reload or a crash closes every one), and the host refuses one
 * for a topic the worker doesn't know (an older worker during a rolling reload). Either way the feed calls `down()`,
 * so the store reads at once and keeps polling, and subscribes again: every second for the first 15 tries (a restarted
 * worker is back within a few seconds), then backing off to every 30 s. When a subscription is acknowledged the feed
 * calls `up()`, the store stops polling, and the worker's first event brings it up to date. A websocket reconnect is
 * the host's: it replays open subscriptions itself.
 */
export type Feed = { readonly live: boolean; stop(): void };

export const FEED_RETRY_FAST = 15;
export const feedRetryMs = (attempt: number) => attempt < FEED_RETRY_FAST ? 1_000 : Math.min(30_000, 1_000 * 2 ** (attempt - FEED_RETRY_FAST + 1));

/** Null on a 0.15 host (no `client.subscribe`): the store polls, as it always did. */
export function openFeed<I extends z.ZodType, E extends z.ZodType>(
  client: PluginClientContext, contract: PluginSubscriptionContract<I, E>, input: z.input<I>,
  o: { event: (event: z.output<E>) => void; down: () => void; up?: () => void },
): Feed | null {
  const subscribe = (client as { subscribe?: unknown }).subscribe;
  if (typeof subscribe !== "function") return null;
  let live = true; let stopped = false; let attempt = 0;
  let handle: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const start = () => {
    retry = null;
    const mine = ++generation;
    const closed = () => {
      if (stopped || mine !== generation) return;
      generation++; // later callbacks from this subscription are stale
      const old = handle; handle = null;
      try { old?.(); } catch { /* already gone */ }
      const wasLive = live; live = false;
      retry = setTimeout(start, feedRetryMs(attempt++));
      if (wasLive) o.down();
    };
    try {
      const h = (subscribe as PluginClientContext["subscribe"]).call(client, contract, input as never,
        (event: unknown) => { if (!stopped && mine === generation) o.event(event as z.output<E>); },
        { onClosed: closed });
      handle = h;
      Promise.resolve(h.ready).then(() => {
        if (stopped || mine !== generation) return;
        attempt = 0;
        if (!live) { live = true; o.up?.(); }
      }, closed);
    } catch { closed(); }
  };
  start();
  return {
    get live() { return live; },
    stop() { stopped = true; if (retry) clearTimeout(retry); try { handle?.(); } catch { /* already gone */ } handle = null; },
  };
}

/** True when this host serves feeds. */
export const hasFeeds = (client: PluginClientContext) => typeof (client as { subscribe?: unknown }).subscribe === "function";
