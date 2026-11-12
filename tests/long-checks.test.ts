import test from "node:test";
import assert from "node:assert/strict";
import { dueForRead, LONG_CHECKS_MS, LONG_RUNNING_POLL_MS, RUNNING_POLL_MS } from "../shared/poll";
import { clock, snapshot } from "./fixtures";

/**
 * Invariant long-running-checks-read-every-2-min. 2026-11-12 live: 25 stacked PRs in one workspace had checks running
 * for hours; read every 30 s they cost ~3000 GraphQL points an hour of the account's shared 5000. Checks still running
 * LONG_CHECKS_MS after the PR's last change (or since Follow-up first saw it) are read every LONG_RUNNING_POLL_MS; a
 * PR that changed recently keeps the 30 s reads.
 */
test("long-running-checks-read-every-2-min: checks running for more than 10 minutes are read every 2 minutes; fresh ones every 30 s", () => {
  const s = snapshot({ state: "OPEN", checksPending: true, checksRunning: true } as never);
  const base = { snapshot: s, error: null, changedAt: null, tier: "normal" as const, repoUrgent: false };
  const now = clock + 3_600_000;
  assert.equal(dueForRead({ ...base, readAt: now - RUNNING_POLL_MS, now, since: now - 60_000 }), true, "a minute in: every 30 s");
  assert.equal(dueForRead({ ...base, readAt: now - RUNNING_POLL_MS, now, since: now - LONG_CHECKS_MS }), false, "10 minutes in: not after 30 s");
  assert.equal(dueForRead({ ...base, readAt: now - LONG_RUNNING_POLL_MS, now, since: now - LONG_CHECKS_MS }), true, "but after 2 minutes");
});
