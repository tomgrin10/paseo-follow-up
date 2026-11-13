import * as sdk from "@getpaseo/plugin/client";
import type { ChatComposer } from "../shared/put-in-chat";

/** Paseo 0.16's composer controls (shared/put-in-chat.ts has the insert rule and its invariant). */
type ComposerSdk = { useComposers(selector: { agentId: string }): readonly ChatComposer[] };
const host = sdk as unknown as Partial<ComposerSdk>;

/** Paseo 0.16's client module has composer controls; 0.15's doesn't. Fixed for the app's lifetime, so hooks stay in order. */
export const hasComposers = typeof host.useComposers === "function";

/** The composer of `agentId`, on screen or not; null on 0.15, for no agent, or one the app doesn't know (archived, another host). */
export function useChatComposer(agentId: string | null): ChatComposer | null {
  if (!hasComposers) return null;
  // hasComposers never changes while the app runs, so this hook is called on every render or on none.
  const composers = host.useComposers!({ agentId: agentId ?? "" });
  return agentId ? composers[0] ?? null : null;
}
