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
  for (const flag of ["--rss-budget 300", "--idle-rss-budget 240", "--cpu-budget 3", "--request-budget 2"]) {
    assert.ok(gate.includes(flag), `test:scale keeps ${flag}`);
    assert.ok(live.includes(flag), `test:scale:live reports ${flag}`);
  }
  assert.ok(live.includes("--live-sized") && live.includes("--busy 180"), "test:scale:live is the live-sized busy window");
  assert.match(await readFile(".github/workflows/ci.yml", "utf8"), /^\s+- run: npm run test:scale:live$/m);
});
