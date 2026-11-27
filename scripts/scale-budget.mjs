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
 * The allocator env test:scale runs the daemon with: the live host's (Paseo's env file, ~/.config/paseo/env, which every
 * plugin process inherits since 2026-11-15). Without it glibc gives each allocating thread its own arena (up to 8 per
 * core), and how many the worker's ~2 s cold-start tick opens is a race: 2026-11-23, ten CI runners each ran test:scale
 * both ways, back to back. Plain: 9-12 arenas, peak 312-335 MB (8 of 10 over the budget), idle median 234-253. With
 * these: 1-6 arenas, peak 299-312, idle 213-227, on the same runners (AMD EPYC 7763 and 9V74, Intel 8573C alike). The
 * heap was the same both ways; the difference was anonymous native memory. Local runs always had it (agent shells
 * inherit Paseo's env) and CI never did, so the two disagreed. scale-runner-facts: scale-check prints the runner, the
 * worker's arenas and the peak's anonymous/file split on its scale-diag line.
 */
export const LIVE_MALLOC_ENV = Object.freeze({ MALLOC_ARENA_MAX: "2", MALLOC_MMAP_THRESHOLD_: "131072", MALLOC_TRIM_THRESHOLD_: "131072" });

/**
 * test:scale's idle budget (realistic seed), derived from CI's own distribution: test:scale runs on CI's runner, so its
 * budget comes from what that runner reads, not from harness terms. 2026-11-25: main's 36 CI readings of test:scale's
 * idle median under LIVE_MALLOC_ENV from 2026-11-23 08:28 to 2026-11-25 12:26 (tests/fixtures/ci-idle-rss.txt, every
 * runner: AMD EPYC 7763/9V74/9V45, Intel 8573C, 8370C, 6973P and 6975P). The 2026-11-23 fixture (26 readings, median
 * 215.5, SD 3.7) understated CI's spread: SD 4.6 on main, 5.3 over all 125 PR and main runs since. The fixture holds at
 * least MIN_READINGS. The one before (2026-11-13, median 220, SD 7.5) was read without the allocator env.
 *   CI_IDLE_P50_MB: the median of those readings. CI_IDLE_SD_MB: their standard deviation.
 *   SPREAD_SDS: how many standard deviations of run-to-run noise the budget absorbs (4 × 4.6 ≈ 18 MB).
 * What it catches: a regression that adds 18 MB puts the median at the budget and fails about half the runs; one that
 * adds 25 MB fails all but the lowest readings (the median would read 242; the lowest, 199, is an outlier). A synthetic
 * 20 MB retained from the start (scale-check --retain-mb 20) read 236 and 241 on CI. tests/scale-budget.test.ts checks these constants against the
 * fixture (drift over 1 MB fails).
 */
export const CI_IDLE_P50_MB = 217;
export const CI_IDLE_SD_MB = 4.6;
export const SPREAD_SDS = 4;
/** The fewest CI readings a budget is derived from: a standard deviation from a couple of dozen understates the tail. */
export const MIN_READINGS = 30;
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
 * test:scale's worker peak budget (lifetime VmHWM, realistic seed), derived from CI's own distribution the same way.
 * 2026-11-25: main's 36 readings under LIVE_MALLOC_ENV (tests/fixtures/ci-peak-rss.txt, the same runs as the idle
 * fixture). The 2026-11-23 fixture (26 readings, median 302.5, SD 3.7, budget 317.3) understated CI's spread: the same
 * commit read 307 and 318 on two runs (76740d3e), 297 and 307 on another (23c209c3), with no runner or arena pattern;
 * 3 of ~127 runs failed on noise (318, 322, and #322's). SD 4.7 on main, 5.5 over all 125 runs.
 * The earlier fixture (2026-11-16, median 278, SD 10.8, budget 321.2) was read without the allocator env, and on
 * 2026-11-23 main's plain peak sat at 312-335 on most runners: the arena race, not the code (scale-runner-facts).
 * The peak is the ~2 s cold-start tick (the scale-diag line's peakSplit), anonymous memory.
 *   CI_PEAK_P50_MB: the median of those readings. CI_PEAK_SD_MB: their standard deviation. SPREAD_SDS as above.
 * What it catches: a regression that adds 15 MB puts the median at the budget and fails about half the runs; one that
 * adds 28 MB fails every run (even the lowest reading, 295, would read 323). --retain-mb 20 read 321 and 325 on CI;
 * #283's pre-fix head (28881bc4), the last real regression, read 412-413. tests/scale-budget.test.ts checks these
 * constants against the fixture (drift over 1 MB fails).
 */
export const CI_PEAK_P50_MB = 304;
export const CI_PEAK_SD_MB = 4.7;
export const REALISTIC_PEAK_BUDGET_MB = CI_PEAK_P50_MB + SPREAD_SDS * CI_PEAK_SD_MB;
/** A named budget for scale-check's --rss-budget: `realistic` (test:scale) or a number of MB. */
export const PEAK_BUDGETS = { realistic: REALISTIC_PEAK_BUDGET_MB };
export function peakBudgetMb(value) {
  if (value === undefined || value === null || value === "" || value === "0") return 0;
  if (Object.hasOwn(PEAK_BUDGETS, value)) return PEAK_BUDGETS[value];
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Unknown peak budget "${value}": a number of MB or one of ${Object.keys(PEAK_BUDGETS).join(", ")}`);
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

/**
 * Memory returns after a burst (memory-returns-after-a-burst, server/memory.ts): test:scale:live's --cycles end each
 * burst (agent turns, an open app's reads, PR and check updates, an ask) with a gap, and the last gap must come back
 * to where this run's worker stood before the bursts. Enforced even with --budgets-report-only: derived, not pending.
 *
 * Judged relative to the run's own baseline, never an absolute level (`burst-return-is-judged-against-the-run`): the
 * baseline is the worker's settled RSS before the first burst (the last settle `after` its heartbeat reports, the
 * HeapSettler's own floor), and the gap is read at its lower quartile (`floorMb`), the level it settles to: about a
 * third of a gap is the minute before the settle, so its median moved with when the settle landed. 74 CI runs of
 * scale-live (2026-11-23 to 27, tests/fixtures/ci-burst-return.txt, every runner CPU): the last gap's median read
 * 219-271 MB on the same server code and failed a client-only PR at 270 against the old absolute 260; the floor over
 * the baseline read 26-58 MB (mean 37.7, sd 5.9). Harness 2026-11-16: 2.1.0-beta.2 without the settler held its gaps
 * at 320-369 MB over a ~190 MB settled floor, +130 or more. BURST_RETURN_GROWTH_MB sits between them: 17 MB over the
 * worst CI run (~3 sd) and 55 under the bug. Without a baseline (no settle reported before the bursts) the floor is
 * judged against BURST_RETURN_BUDGET_MB, the old level, now read at the floor (CI's floors: 214-257).
 */
export const BURST_RETURN_GROWTH_MB = 75;
export const BURST_RETURN_BUDGET_MB = 260;
const quantile = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(p * (a.length - 1))] : 0; };
/** The pre-burst baseline: the last settle before the first burst (`s` < 0, seconds from the first burst). */
export function burstBaselineMb(settles) {
  const before = (settles ?? []).filter(x => x.s < 0 && Number.isFinite(x.after)).sort((a, b) => a.s - b.s);
  return before.length ? before[before.length - 1].after : null;
}
/**
 * The burst-return verdict: each gap's median (reported) and the last gap's floor (its lower quartile), judged as growth
 * over `baselineMb` when there is one, else against the absolute `budgetMb`. `opts` may be a number (the old absolute
 * budget, kept for --burst-return-budget).
 */
export function burstReturnVerdict(gapsMb, opts = {}) {
  const { baselineMb = null, growthBudgetMb = BURST_RETURN_GROWTH_MB, budgetMb = BURST_RETURN_BUDGET_MB } = typeof opts === "number" ? { budgetMb: opts } : opts;
  const medians = gapsMb.map(g => Math.round(median(g)));
  const last = gapsMb.length ? gapsMb[gapsMb.length - 1] : [];
  const lastMb = medians.length ? medians[medians.length - 1] : 0;
  const floorMb = Math.round(quantile(last, 0.25));
  const returnMb = baselineMb === null ? null : floorMb - baselineMb;
  const judged = last.length > 0 && (returnMb !== null ? !!growthBudgetMb : !!budgetMb);
  const over = judged && (returnMb !== null ? returnMb > growthBudgetMb : floorMb > budgetMb);
  return { gapMediansMb: medians, lastMb, floorMb, baselineMb, returnMb, growthBudgetMb, budgetMb, over };
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
/**
 * Drained: no awake agent running, the worker read no timeline for a whole tick plus this margin, and the directory
 * re-read the busy window's events made it due (`DIRTY_REFRESH_MS`, a minute after its last read) has happened: in a
 * 90 s idle window that one re-read (6 requests on the live-sized seed) is 4 requests a minute, there or not by chance.
 */
export const DRAIN_QUIET_MS = ENGINE_TICK_MS + 5_000;
/** The longest the check waits to drain (a dirty re-read is due within a minute); past it the idle window starts anyway and the report says so. */
export const DRAIN_BOUND_MS = 120_000;

/**
 * Where the drain stands, from polls since the phase before the idle window ended (`atMs`, `running` agents, `reads`:
 * the worker's cumulative timeline reads, `lists`: its cumulative directory re-reads, `relisted`: it has listed
 * workspaces since the phase ended): settled once nothing runs and neither `reads` nor `lists` has moved for `quietMs`
 * (and, with `awaitRelist`, the directory has re-read); expired past the bound.
 */
export function drainState(polls, { quietMs = DRAIN_QUIET_MS, boundMs = DRAIN_BOUND_MS, awaitRelist = true } = {}) {
  let since = 0;
  for (let i = 0; i < polls.length; i++) {
    const p = polls[i];
    if (p.running > 0 || (i > 0 && (p.reads !== polls[i - 1].reads || p.lists !== polls[i - 1].lists))) since = p.atMs;
    if (p.running === 0 && (!awaitRelist || p.relisted !== false) && p.atMs - since >= quietMs) return { settled: true, expired: false, atMs: p.atMs };
    if (p.atMs > boundMs) return { settled: false, expired: true, atMs: p.atMs };
  }
  return { settled: false, expired: false };
}

/** DIRTY_REFRESH_MS (server/directory.ts): a dirty directory re-reads at most once a minute. tests/scale-budget.test.ts checks this copy. */
export const DIRTY_REFRESH_MS = 60_000;
/**
 * Plain test:scale's send phase ends when Follow-up's batches settle, not when the agents it sent to do: 2026-11-16
 * (#211, local) a late 7th send's turn, its turn-end reads and the directory re-read after them landed in the idle
 * window (5.3 requests a minute against 2). Nothing marks when that re-read is due, so the quiet span outlasts one: a
 * dirty directory re-reads within DIRTY_REFRESH_MS of its last read, on the next engine tick.
 */
export const SEND_DRAIN_QUIET_MS = DIRTY_REFRESH_MS + ENGINE_TICK_MS + 5_000;
/** The drain before the idle window: after a busy window, its known re-read plus a tick of quiet; after the send phase alone, a re-read's whole wait. */
export const drainPlan = ({ busyMs }) => busyMs > 0 ? { quietMs: DRAIN_QUIET_MS, awaitRelist: true } : { quietMs: SEND_DRAIN_QUIET_MS, awaitRelist: false };

/**
 * Every list pages (invariant pr-scale-lists-batch-not-throw): on the live-sized seed's big workspace (BIG_QUESTIONS
 * questions, BIG_BATCHES sent batches, BIG_PRS PRs) one read the panel makes stays under these bytes, however much
 * history it holds. follow.get carries live history plus the newest HISTORY_KEPT settled items of each kind
 * (shared/history.ts); follow.activity one PAGE.size page. Measured 2026-11-26 before paging: follow.get ~680 KB for
 * 175 questions and 400 batches. Enforced even with --budgets-report-only: a reply size isn't noise.
 */
// follow.agent-status is workspace_status: an agent tool's answer stays under TOOL_BUDGET (shared/paged.ts, 40,000).
export const PAGED_REPLY_BUDGET_BYTES = Object.freeze({ "follow.get": 400_000, "follow.activity": 60_000, "follow.agent-status": 40_000 });
export function pagedReplyVerdict(replies, budgets = PAGED_REPLY_BUDGET_BYTES) {
  const over = replies.filter(r => budgets[r.method] !== undefined && r.bytes > budgets[r.method]).map(r => `${r.method} ${r.label}: ${r.bytes} bytes, over ${budgets[r.method]}`);
  return { replies, over };
}

/**
 * Read stamps never count (invariant 140, read-stamps-never-count): while nothing a reader sees changes, the
 * workspaces feed sends an open client only read stamps, at most once per READS_PUSH_MS. Before the fix every GitHub
 * probe moved `observedAt` and the feed resent whole workspaces: 2026-11-27, live-sized seed, 342 KB every ~15 s and
 * 2 MB about once a minute (~3.4 MB a minute). A stamps-only push of the live-sized seed is ~40 KB (140 workspaces'
 * PRs), so the budget passes one a minute with room and fails at any whole-workspace churn. Enforced even with
 * --budgets-report-only: a byte count isn't noise. `events`: the feed's pushes in the idle window after its first
 * (full) answer, as { bytes, full }.
 */
export const FEED_IDLE_BUDGET_KB = 120;
/**
 * One answer of the client's follow.list poll (Paseo 0.15, no plugin subscriptions), as a feedIdleVerdict event: judged
 * on the entries it resends and the ids it removes; its stamps ride every poll by design, so they're counted apart.
 */
export function listPollEvent(out) {
  return { bytes: JSON.stringify([out?.workspaces ?? [], out?.removed ?? []]).length, readsBytes: JSON.stringify(out?.reads ?? {}).length, full: out?.full !== false };
}
/** `events`: every answer in the window, the first (full) one included; full answers count as answered, not as churn. */
export function feedIdleVerdict(events, windowMs, budgetKb = FEED_IDLE_BUDGET_KB) {
  const diffs = events.filter(e => !e.full);
  const kb = diffs.reduce((a, e) => a + e.bytes, 0) / 1024;
  const kbPerMin = Math.round(kb / Math.max(windowMs, 1) * 60_000 * 10) / 10;
  return { pushes: diffs.length, fullPushes: events.length - diffs.length, kbPerMin, maxPushKb: Math.round(Math.max(0, ...diffs.map(e => e.bytes)) / 1024), budgetKb, over: kbPerMin > budgetKb };
}
