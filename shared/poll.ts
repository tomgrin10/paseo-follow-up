import type { ListSnapshot as Snapshot } from "./list";

/**
 * PR polling cadence. The engine ticks every TICK_MS. A repository whose PRs are all settled is read at most every
 * POLL_IDLE_MS (server/github.ts); everything else is read every tick.
 *
 * The backoff covers every field a snapshot feeds: a PR is settled only when nothing on it can move without also
 * changing what the last read saw. Finishing CI checks do NOT bump a PR's updatedAt, so any running check (required or not: a non-required one can
 * still fail and show), a merge
 * queue, merge-when-ready (GitHub auto-merge or Graphite) and unknown mergeability all keep the every-tick cadence.
 * A settled PR's next change is seen at most POLL_IDLE_MS + TICK_MS late, inside the completion gate's freshness
 * (OBSERVATION_FRESH_MS, shared/model.ts), so backoff never turns a settled PR into "Refresh status".
 */
export const TICK_MS = 15_000;
export const POLL_IDLE_MS = 60_000;
/** A PR whose observed content changed this recently keeps the every-tick cadence. */
export const RECENT_CHANGE_MS = 5 * 60_000;
/** How old an open PR's snapshot may be before the completion gate asks for a refresh (shared/model.ts). */
export const OBSERVATION_FRESH_MS = 120_000;
const GRAPHITE_IN_FLIGHT = /QUEUED_TO_MERGE|WAITING_TO_MERGE|REBASING|HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE/;

export type Cadence = "tick" | "checks" | "idle";
/** A PR whose only movement is running checks is read this often. */
export const RUNNING_POLL_MS = 30_000;
/**
 * Checks still running LONG_CHECKS_MS after the PR's last change (or since Follow-up first saw it) are read every
 * LONG_RUNNING_POLL_MS: a result 2 minutes late beats spending the shared budget on checks that run for hours.
 * 2026-11-12 live: 25 stacked PRs in one workspace had checks running for hours, ~3000 GraphQL points an hour at 30 s.
 */
export const LONG_CHECKS_MS = 10 * 60_000;
export const LONG_RUNNING_POLL_MS = 120_000;
/** Why a PR must be read every tick, or null when it may back off. */
export function movingReason(s: Snapshot | null | undefined, error: string | null | undefined): string | null {
  return movingReasons(s, error)[0] ?? null;
}
const CHECKS = "checks running";
function movingReasons(s: Snapshot | null | undefined, error: string | null | undefined): string[] {
  if (!s) return ["not observed yet"];
  if (error) return ["last read failed"];
  if (!s.complete) return ["incomplete read"];
  if (s.state !== "OPEN") return [];
  const out: string[] = [];
  if (s.inMergeQueue) out.push("in the merge queue");
  if (s.mergeWhenReady === "on") out.push("merge when ready is on");
  if (s.graphiteMergeStatus && GRAPHITE_IN_FLIGHT.test(s.graphiteMergeStatus)) out.push("Graphite is merging it");
  if (s.mergeStateStatus === "UNKNOWN") out.push("mergeability unknown");
  // checksRunning: a context actually in progress. A required check that never reported isn't running, so it
  // alone doesn't keep a PR hot forever (a push that would start it changes the head, which is a recent change).
  if (s.checksRunning ?? s.checksPending) out.push(CHECKS);
  return out;
}
/**
 * `tick`: read every tick. `checks`: only checks are running, read every RUNNING_POLL_MS (a result showing 15 s later
 * costs nothing that matters; the budget is shared by every agent). `idle`: settled.
 */
export function cadence(s: Snapshot | null | undefined, error: string | null | undefined, changedAt: number | null, now: number): Cadence {
  const reasons = movingReasons(s, error);
  if (reasons.some(r => r !== CHECKS) || (changedAt !== null && now - changedAt < RECENT_CHANGE_MS)) return "tick";
  return reasons.length ? "checks" : "idle";
}

/** A merged PR is final: nothing on it feeds repairs, and its deploy state is probed separately every tick. */
export const MERGED_POLL_MS = 30 * 60_000;
/**
 * GitHub's GraphQL budget (5000 points an hour per account, shared with every agent). A read costs about one point
 * per PR. Under LOW_BUDGET points left, settled PRs wait LOW_IDLE_MS (and only in repositories with something
 * moving), merged PRs wait for the reset; under CRITICAL_BUDGET nothing is read until the reset.
 */
export const LOW_BUDGET = 500;
export const CRITICAL_BUDGET = 100;
export const LOW_IDLE_MS = 5 * 60_000;
export type Budget = { remaining: number; resetAt: number };
export type Tier = "normal" | "low" | "critical";
export function budgetTier(b: Budget | null | undefined, now: number): Tier {
  if (!b || now >= b.resetAt) return "normal";
  return b.remaining < CRITICAL_BUDGET ? "critical" : b.remaining < LOW_BUDGET ? "low" : "normal";
}
/**
 * Whether a background tick reads this already-observed PR. Moving PRs: every tick, or every RUNNING_POLL_MS when
 * only checks are running (unless the budget is critical).
 * Settled open or closed PRs: every POLL_IDLE_MS. Merged: every MERGED_POLL_MS.
 */
export function dueForRead(i: { snapshot: Snapshot | null | undefined; error: string | null | undefined; changedAt: number | null; readAt: number; now: number; tier: Tier; repoUrgent: boolean; since?: number | null }): boolean {
  if (i.tier === "critical") return false;
  const c = cadence(i.snapshot, i.error, i.changedAt, i.now);
  if (c === "tick") return true;
  const age = i.now - i.readAt;
  // Half a tick of slack: ticks drift a little, and 29.9 s must not wait for the next tick.
  if (c === "checks") {
    const long = i.since != null && i.now - i.since >= LONG_CHECKS_MS;
    return age >= (long ? LONG_RUNNING_POLL_MS : RUNNING_POLL_MS) - TICK_MS / 2;
  }
  if (i.tier === "low") return i.snapshot?.state !== "MERGED" && i.repoUrgent && age >= LOW_IDLE_MS;
  return age >= (i.snapshot?.state === "MERGED" ? MERGED_POLL_MS : POLL_IDLE_MS);
}
