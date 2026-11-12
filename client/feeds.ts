import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginSubscriptionContract } from "@getpaseo/plugin";
import type { z } from "zod";

/**
 * Subscribes to one of the worker's feeds when the host can (Paseo 0.16 `client.subscribe`); returns null on a 0.15
 * host, and the caller keeps polling the matching RPC. The 0.16 SDK isn't assumed: `subscribe` is feature-detected on
 * the client the host handed over (invariant idle-client-makes-at-most-one-rpc-a-minute, docs/client.md#feeds).
 * `onClosed` runs when the host gives the subscription up (the plugin stopped, or the feed refused): the caller goes
 * back to polling until it subscribes again.
 */
export function subscribeFeed<I extends z.ZodType, E extends z.ZodType>(
  client: PluginClientContext, contract: PluginSubscriptionContract<I, E>, input: z.input<I>,
  onEvent: (event: z.output<E>) => void, onClosed: () => void,
): (() => void) | null {
  const subscribe = (client as { subscribe?: unknown }).subscribe;
  if (typeof subscribe !== "function") return null;
  try {
    let released = false;
    const handle = (subscribe as PluginClientContext["subscribe"]).call(client, contract, input as never, onEvent as (event: unknown) => void, { onClosed: () => { if (!released) onClosed(); } });
    handle.ready?.catch(() => { if (!released) { released = true; onClosed(); } });
    return () => { released = true; handle(); };
  } catch { return null; }
}

/** True when this host serves feeds: stores skip their polls. */
export const hasFeeds = (client: PluginClientContext) => typeof (client as { subscribe?: unknown }).subscribe === "function";
