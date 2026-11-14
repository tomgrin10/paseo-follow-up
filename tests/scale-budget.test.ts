import test from "node:test";
import assert from "node:assert/strict";
import { ACK_READ_MS, idleVerdict, median, PR_READ_MS, SEND_ROUNDS, SEND_SETTLE_MS, settleBoundMs, settleState } from "../scripts/scale-budget.mjs";
import { NO_PROGRESS_CAP, SETTLE_MS } from "../shared/send-decision";
import { POLL_IDLE_MS } from "../shared/poll";

/**
 * scale-budgets-judge-the-typical-cost (2026-11-13): #152 failed CI on "Worker idle RSS peaked at 279 MB, over 240 MB"
 * while four local A/B runs of main and the branch sat at 212–234 idle; main alone swung 17 MB between runs. The idle
 * budget reads the window's median; the peak is reported; only the lifetime cap (VmHWM) is judged on one sample.
 */
const BUDGET = 240;
// 90 s at one sample per 500 ms, like the check's idle window.
const flat = (mb: number, n = 181) => Array.from({ length: n }, () => mb);

test("scale budget: one GC sawtooth spike over the idle budget passes on a median under it", () => {
  const series = flat(216); series[40] = 279; series[41] = 262;
  const v = idleVerdict(series, BUDGET);
  assert.equal(v.peakMb, 279);
  assert.equal(v.medianMb, 216);
  assert.equal(v.over, false);
});

test("scale budget: sustained growth over the idle budget fails", () => {
  // Climbs from 200 to 290 MB across the window: most of it sits over 240.
  const series = Array.from({ length: 181 }, (_, i) => 200 + i / 2);
  const v = idleVerdict(series, BUDGET);
  assert.ok(v.medianMb > BUDGET, `median ${v.medianMb}`);
  assert.equal(v.over, true);
  assert.equal(idleVerdict(flat(246), BUDGET).over, true);
});

test("scale budget: no budget judges nothing; the median of an even count is the middle pair's mean", () => {
  assert.equal(idleVerdict(flat(400), 0).over, false);
  assert.equal(median([1, 4, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

/** Polls 5 s apart from `fromS` to `toS` (seconds after the worker loaded the seed), open until `quietFromS`. */
const polls = (fromS: number, toS: number, quietFromS = Infinity) =>
  Array.from({ length: Math.floor((toS - fromS) / 5) + 1 }, (_, i) => fromS + i * 5).map(s => ({ atMs: s * 1000, open: s >= quietFromS ? 0 : 2 }));

test("scale settle: the bound is the seed's send schedule plus a margin, from the worker's own constants", () => {
  // The script can't import TypeScript, so it keeps copies; they must match the worker's.
  assert.equal(SEND_SETTLE_MS, SETTLE_MS);
  assert.equal(PR_READ_MS, POLL_IDLE_MS);
  assert.equal(SEND_ROUNDS, NO_PROGRESS_CAP);
  assert.equal(ACK_READ_MS, 2 * POLL_IDLE_MS);
  // 2 rounds × (read 120 s + settle 60 s) + a last read 120 s + margin 60 s.
  assert.equal(settleBoundMs(), 540_000);
});

test("scale settle: a run that settles at 301 s, inside its schedule, passes; one that never settles fails", () => {
  // 2026-11-13's runs: second sends at 141–218 s, the last acknowledged condition read at ~294 s, quiet polls at 296
  // and 301 s. The old literal 300 s bound failed the run whose second quiet poll landed at 301 s.
  const run = polls(56, 400, 296);
  const v = settleState(run, settleBoundMs());
  assert.equal(v.settled, true);
  assert.equal(v.atMs, 301_000);
  assert.equal(settleState(run, 300_000).settled, false, "the old 300 s bound fails this run");
  // A send loop that never settles still fails, at the bound rather than never.
  const never = settleState(polls(55, 700), settleBoundMs());
  assert.deepEqual(never, { settled: false, expired: true });
  // One quiet poll between busy ones isn't settled.
  assert.equal(settleState([{ atMs: 60_000, open: 0 }, { atMs: 65_000, open: 1 }, { atMs: 70_000, open: 0 }], settleBoundMs()).settled, false);
});

test("the busy window is judged on growth: last fifth's median over the first fifth's, one spike decides nothing", async () => {
  const { busyVerdict, BUSY_GROWTH_BUDGET_MB } = await import("../scripts/scale-budget.mjs");
  const flat = Array.from({ length: 360 }, (_, i) => 220 + (i % 7) + (i === 200 ? 80 : 0));
  assert.equal(busyVerdict(flat, BUSY_GROWTH_BUDGET_MB).over, false, "a sawtooth with a spike isn't growth");
  // 2026-11-13, beta.4 on a live-sized load: 259 → 311 MB over the window.
  const climbing = Array.from({ length: 360 }, (_, i) => 259 + Math.round(i * 52 / 360));
  const v = busyVerdict(climbing, BUSY_GROWTH_BUDGET_MB);
  assert.ok(v.over && v.growthMb > BUSY_GROWTH_BUDGET_MB, `a steady climb fails (grew ${v.growthMb} MB)`);
});

/**
 * scale-gate-never-reports-only (2026-11-13): the live-sized busy window (`test:scale:live`) reports its budgets until
 * their derived values land, so the memory fix could merge. The gate in `verify` keeps failing on every budget, and
 * the report-only run still runs in PR CI, so its numbers stay visible.
 */
test("scale gate: test:scale fails on its budgets; test:scale:live reports them and runs in PR CI", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  const gate = pkg.scripts["test:scale"]!, live = pkg.scripts["test:scale:live"]!;
  assert.ok(pkg.scripts.verify!.includes("npm run test:scale &&"), "verify runs the gate");
  assert.ok(!gate.includes("--budgets-report-only"), "the gate fails on its budgets");
  for (const flag of ["--rss-budget 300", "--cpu-budget 3", "--request-budget 2"]) {
    assert.ok(gate.includes(flag), `test:scale keeps ${flag}`);
    assert.ok(live.includes(flag), `test:scale:live reports ${flag}`);
  }
  assert.ok(gate.includes("--idle-rss-budget realistic"), "test:scale's idle budget is the derived REALISTIC_IDLE_BUDGET_MB, not a typed-in number");
  assert.ok(live.includes("--live-sized") && live.includes("--busy 180"), "test:scale:live is the live-sized busy window");
  assert.match(await readFile(".github/workflows/ci.yml", "utf8"), /^\s+- run: npm run test:scale:live$/m);
});

/**
 * realistic-idle-budget-matches-ci (2026-11-13): test:scale's idle budget is CI's median plus SPREAD_SDS standard
 * deviations of CI's own readings. #174 read 243 over the old 240 on a PR that changed no product code: the budget sat
 * inside the runner's noise. The constants must match the readings they came from (tests/fixtures/ci-idle-rss.txt).
 */
test("scale budget: the realistic idle budget is computed from its named terms, which match CI's readings", async () => {
  const { readFile } = await import("node:fs/promises");
  const b = await import("../scripts/scale-budget.mjs");
  assert.equal(b.REALISTIC_IDLE_BUDGET_MB, b.CI_IDLE_P50_MB + b.SPREAD_SDS * b.CI_IDLE_SD_MB, "the total is the sum of its terms");
  assert.match(await readFile("scripts/scale-budget.mjs", "utf8"), /REALISTIC_IDLE_BUDGET_MB = CI_IDLE_P50_MB \+ SPREAD_SDS \* CI_IDLE_SD_MB;/, "computed, not typed in");
  assert.equal(b.idleBudgetMb("realistic"), b.REALISTIC_IDLE_BUDGET_MB);
  const xs = (await readFile("tests/fixtures/ci-idle-rss.txt", "utf8")).split("\n").filter(Boolean).map(Number).sort((x, y) => x - y);
  assert.ok(xs.length >= 5 && xs.every(Number.isFinite), "at least five CI readings, numbers only");
  const mean = xs.reduce((n, x) => n + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((n, x) => n + (x - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(median(xs) - b.CI_IDLE_P50_MB) <= 1, `CI_IDLE_P50_MB ${b.CI_IDLE_P50_MB} vs the readings' median ${median(xs)}`);
  assert.ok(Math.abs(sd - b.CI_IDLE_SD_MB) <= 1, `CI_IDLE_SD_MB ${b.CI_IDLE_SD_MB} vs the readings' ${sd.toFixed(2)}`);
  assert.ok(xs.every(x => x <= b.REALISTIC_IDLE_BUDGET_MB), "every reading it came from passes, #174's 243 included");
  assert.ok(Math.min(...xs) + 45 > b.REALISTIC_IDLE_BUDGET_MB, "a +45 MB regression fails every run");
});

test("the idle window starts drained: no awake agent running and no timeline read for a tick plus a margin", async () => {
  const { DRAIN_BOUND_MS, DRAIN_QUIET_MS, drainState, ENGINE_TICK_MS } = await import("../scripts/scale-budget.mjs");
  const { TICK_MS } = await import("../shared/poll");
  assert.equal(ENGINE_TICK_MS, TICK_MS, "the script's copy of the engine tick");
  assert.ok(DRAIN_QUIET_MS > TICK_MS, "a whole tick's rescan fits in the quiet span");
  const at = (s: number, running: number, reads: number) => ({ atMs: s * 1000, running, reads });
  // 2026-11-14: turns still running and their reads landing in the idle window scattered CI's idle rate 5.3–8.7/min.
  assert.deepEqual(drainState([at(2, 2, 10), at(4, 1, 12), at(6, 0, 13)]), { settled: false, expired: false }, "reads just moved");
  const quiet = [at(2, 0, 13), at(10, 0, 13), at(20, 0, 14), at(30, 0, 14), at(40, 0, 14)];
  assert.deepEqual(drainState(quiet), { settled: true, expired: false, atMs: 40_000 }, "quiet from the last read at 20 s");
  assert.equal(drainState([at(2, 1, 1), at(30, 1, 1)]).settled, false, "a running agent is never drained, however quiet");
  assert.deepEqual(drainState([at(2, 1, 1), at(DRAIN_BOUND_MS / 1000 + 2, 1, 1)]), { settled: false, expired: true, atMs: DRAIN_BOUND_MS + 2_000 }, "bounded");
  // The busy window's dirty directory re-read (6 requests, 4 a minute in a 90 s window) lands before the idle window.
  const relist = (s: number, relisted: boolean) => ({ ...at(s, 0, 13), relisted });
  assert.equal(drainState([relist(2, false), relist(30, false), relist(50, false)]).settled, false, "quiet, but the due re-read hasn't happened");
  assert.deepEqual(drainState([relist(2, false), relist(30, false), relist(62, true)]), { settled: true, expired: false, atMs: 62_000 });
});
