import type { Snapshot } from "./model";

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

export type Cadence = "tick" | "idle";
/** Why a PR must be read every tick, or null when it may back off. */
export function movingReason(s: Snapshot | null | undefined, error: string | null | undefined): string | null {
  if (!s) return "not observed yet";
  if (error) return "last read failed";
  if (!s.complete) return "incomplete read";
  if (s.state !== "OPEN") return null;
  if (s.checksPending || s.checksRunning) return "checks running";
  if (s.inMergeQueue) return "in the merge queue";
  if (s.mergeWhenReady === "on") return "merge when ready is on";
  if (s.graphiteMergeStatus && GRAPHITE_IN_FLIGHT.test(s.graphiteMergeStatus)) return "Graphite is merging it";
  if (s.mergeStateStatus === "UNKNOWN") return "mergeability unknown";
  return null;
}
export function cadence(s: Snapshot | null | undefined, error: string | null | undefined, changedAt: number | null, now: number): Cadence {
  if (movingReason(s, error)) return "tick";
  return changedAt !== null && now - changedAt < RECENT_CHANGE_MS ? "tick" : "idle";
}
