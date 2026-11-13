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
 * How far the busy window's RSS may climb, last fifth's median over first fifth's. Placeholder until measured.
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
