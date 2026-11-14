// The scale check's verdicts, kept pure so tests can feed them synthetic runs (tests/scale-budget.test.ts).
//
// Budgets judge the typical cost; one sample decides nothing except the lifetime cap. The idle window's RSS is a GC
// sawtooth (main alone swung 17 MB between runs, and CI once peaked at 279 MB on an idle median near 215), so the idle
// budget reads the window's median. Growth that lasts moves the median and still fails. The idle peak is reported.

/** The middle of a sample series (the mean of the middle two for an even count). */
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * test:scale's idle budget (realistic seed), derived from CI's own distribution: test:scale runs on CI's runner, so its
 * budget comes from what that runner reads, not from harness terms. 2026-11-13: 49 CI readings of test:scale's idle
 * median (tests/fixtures/ci-idle-rss.txt, the last 60 CI runs without three failing outliers, plus #174's 243, which
 * read over the old 240 on a PR that changed no product code and passed on rerun).
 *   CI_IDLE_P50_MB: the median of those readings. CI_IDLE_SD_MB: their standard deviation.
 *   SPREAD_SDS: how many standard deviations of run-to-run noise the budget absorbs (4 × 7.5 = 30 MB; #174's 243 is
 *   23 over the median, so it passes).
 * What it catches: a regression that adds 30 MB puts the median at the budget and fails about half the runs; one that
 * adds 45 MB fails every run (even the lowest reading, 206, would read 251). tests/scale-budget.test.ts checks these
 * constants against the fixture (drift over 1 MB fails).
 */
export const CI_IDLE_P50_MB = 220;
export const CI_IDLE_SD_MB = 7.5;
export const SPREAD_SDS = 4;
export const REALISTIC_IDLE_BUDGET_MB = CI_IDLE_P50_MB + SPREAD_SDS * CI_IDLE_SD_MB;
/**
 * A named budget for scale-check's --idle-rss-budget: `realistic` (test:scale) or a number of MB. Names keep the
 * derived values in this file, so package.json never carries a typed-in total.
 */
export const IDLE_BUDGETS = { realistic: REALISTIC_IDLE_BUDGET_MB };
export function idleBudgetMb(value) {
  if (value === undefined || value === null || value === "" || value === "0") return 0;
  if (Object.hasOwn(IDLE_BUDGETS, value)) return IDLE_BUDGETS[value];
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Unknown idle budget "${value}": a number of MB or one of ${Object.keys(IDLE_BUDGETS).join(", ")}`);
  return n;
}

/**
 * The busy window (test:scale --busy <s>): live's load while agents work, before the idle window. 2026-11-13 live
 * (2.0.1-beta.4, 153-PR workspace): RSS stepped 315 → 405 MB while agents were busy and never came back, with an idle
 * check passing. Each awake agent ends BUSY_TURNS_PER_MIN turns a minute between them, each with BUSY_TURN_ITEMS
 * timeline items of BUSY_ITEM_BYTES (a real turn's tool output), so the worker's turn hooks, inbox mutations and tail
 * reads run at live's rate.
 */
export const BUSY_TURNS_PER_MIN = 20;
export const BUSY_TURN_ITEMS = 30;
export const BUSY_ITEM_BYTES = 8000;
/**
 * How far the busy window's RSS may climb, last fifth's median over first fifth's. Not derived yet: test:scale:live
 * reports it (--budgets-report-only). Measured 2026-11-13 on the harness: beta.4 39, main 51, the memory fix 28–42 MB.
 * The budget PR sets it to the final build's observed growth plus the run-to-run spread, named here.
 */
export const BUSY_GROWTH_BUDGET_MB = 25;
/** The busy verdict: growth across the window (medians of its first and last fifths, so one GC spike decides nothing). */
export function busyVerdict(samplesMb, budgetMb) {
  const n = Math.max(1, Math.floor(samplesMb.length / 5));
  const firstMb = Math.round(median(samplesMb.slice(0, n))); const lastMb = Math.round(median(samplesMb.slice(-n)));
  const growthMb = lastMb - firstMb; const peakMb = Math.round(samplesMb.length ? Math.max(...samplesMb) : 0);
  return { firstMb, lastMb, growthMb, peakMb, over: !!budgetMb && growthMb > budgetMb };
}

/** The idle verdict: the window's median against the budget. The peak is reported, never judged. */
export function idleVerdict(samplesMb, budgetMb) {
  const medianMb = Math.round(median(samplesMb)); const peakMb = Math.round(samplesMb.length ? Math.max(...samplesMb) : 0);
  return { medianMb, peakMb, over: !!budgetMb && medianMb > budgetMb };
}

// The send phase's schedule, from the worker's own constants (tests/scale-budget.test.ts checks these copies against
// shared/send-decision.ts and shared/poll.ts, which this plain-node script can't import).
/** SETTLE_MS: a new message waits this long before it goes out on its own. */
export const SEND_SETTLE_MS = 60_000;
/** POLL_IDLE_MS: the worker reads an open PR at least once in this long. */
export const PR_READ_MS = 60_000;
/** NO_PROGRESS_CAP: a condition goes out at most this many times unchanged, then caps. */
export const SEND_ROUNDS = 2;
/** The check waits this long after an acknowledgment for the PR read that decides a resend: two read intervals. */
export const ACK_READ_MS = 2 * PR_READ_MS;
/** Slack over the worst-case schedule, for a loaded CI box. */
export const SETTLE_MARGIN_MS = 60_000;
/** Consecutive quiet polls (5 s apart) that count as settled. */
export const QUIET_POLLS = 2;

/**
 * The longest the realistic seed's sends can take, from the worker loading the seed: each round waits for a read that
 * sees the condition (≤ ACK_READ_MS), then the settle window, then goes out and the fixture acknowledges it at once;
 * after the last round, one more read finds nothing new. 2 × (120 + 60) + 120 = 480 s, plus the margin: 540 s.
 * The old bound was a literal 300 s from install, the length of a normal send phase, so a run passed or failed on
 * whether its second quiet poll landed before 300 s (2026-11-13: 4 of 4 local runs ended at 301 s).
 */
export const settleBoundMs = ({ rounds = SEND_ROUNDS, readMs = ACK_READ_MS, settleMs = SEND_SETTLE_MS, marginMs = SETTLE_MARGIN_MS } = {}) =>
  rounds * (readMs + settleMs) + readMs + marginMs;

/**
 * Where the send phase stands, from the polls so far (`atMs` since the worker loaded the seed, `open` conditions):
 * settled after QUIET_POLLS quiet polls in a row inside the bound; expired once a poll lands past the bound unsettled.
 */
export function settleState(polls, boundMs) {
  let quiet = 0;
  for (const p of polls) {
    if (p.atMs > boundMs) return { settled: false, expired: true };
    quiet = p.open ? 0 : quiet + 1;
    if (quiet >= QUIET_POLLS) return { settled: true, expired: false, atMs: p.atMs };
  }
  return { settled: false, expired: false };
}

// The busy window's tail. 2026-11-14: CI's idle requests scattered 5.3–8.7 a minute run to run (timeline 1.3–4), not
// from a change but from how much of the busy window ended inside the 90 s idle window: turns still running, their
// turn-end reads (TurnTimeline.after) and the next tick's discovery rescan. The idle window now starts drained.
/** TICK_MS (shared/poll.ts): the engine's timer tick. tests/scale-budget.test.ts checks this copy. */
export const ENGINE_TICK_MS = 15_000;
/** Drained: no awake agent running, and the worker read no timeline for a whole tick plus this margin. */
export const DRAIN_QUIET_MS = ENGINE_TICK_MS + 5_000;
/** The longest the check waits to drain; past it the idle window starts anyway and the report says so. */
export const DRAIN_BOUND_MS = 120_000;

/**
 * Where the drain stands, from polls since the busy window ended (`atMs`, `running` awake agents, `reads`: the worker's
 * cumulative timeline reads): settled once nothing runs and `reads` hasn't moved for `quietMs`; expired past the bound.
 */
export function drainState(polls, { quietMs = DRAIN_QUIET_MS, boundMs = DRAIN_BOUND_MS } = {}) {
  let since = 0;
  for (let i = 0; i < polls.length; i++) {
    const p = polls[i];
    if (p.running > 0 || (i > 0 && p.reads !== polls[i - 1].reads)) since = p.atMs;
    if (p.running === 0 && p.atMs - since >= quietMs) return { settled: true, expired: false, atMs: p.atMs };
    if (p.atMs > boundMs) return { settled: false, expired: true, atMs: p.atMs };
  }
  return { settled: false, expired: false };
}
