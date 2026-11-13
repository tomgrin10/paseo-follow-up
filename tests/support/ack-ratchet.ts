import { setTimeout as sleep } from "node:timers/promises";
import { settleTime } from "./hanging-host";

/**
 * Times one RPC for tests/rpc-ack.test.ts and says whether that timing proves anything.
 *
 * A reply within the budget proves the handler doesn't wait on the slow side only if nothing slow settled meanwhile.
 * The hanging host's waits end now and then (the daemon client's 10 s connect timeout, a killed CLI), and a handler
 * that shares one of them with an earlier call (`selfInstall()`'s memo) then "replies" at once with that failure.
 * Judged by the clock alone, an exempt RPC passed or failed the ratchet depending on how long the RPCs before it took
 * (2026-11-13: `follow.retry-move`, "exempt RPCs now reply in time", on a run where nothing had changed).
 *
 * So a reply counts as `fast` only when no give-up happened from the call's start until `GRACE_MS` after it settled
 * (the black hole sees the worker's close a moment after the worker acts on it). Otherwise the call is run again,
 * up to `tries` times: by then the shared wait has been dropped and a waiting handler starts a fresh one and hangs.
 * A call that is never clean is `tainted`: it neither fails the budget nor proves an exemption stale.
 */
export const GRACE_MS = 100;

export type AckTiming =
  | { verdict: "late" }
  | { verdict: "fast"; ms: number; error: string | null }
  | { verdict: "tainted"; ms: number; error: string | null };

export async function timeAck(call: () => unknown, budgetMs: number, giveUps: () => number, tries = 3): Promise<AckTiming & { runs: number }> {
  let last: AckTiming = { verdict: "late" };
  for (let run = 1; run <= tries; run++) {
    const before = giveUps();
    const r = await settleTime(call, budgetMs);
    if (r.ms === null) return { verdict: "late", runs: run };
    await sleep(GRACE_MS);
    if (giveUps() === before) return { verdict: "fast", ms: r.ms, error: r.error, runs: run };
    last = { verdict: "tainted", ms: r.ms, error: r.error };
  }
  return { ...last, runs: tries };
}
