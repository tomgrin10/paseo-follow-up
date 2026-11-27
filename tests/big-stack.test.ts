// The surfaces that sum up a big stack (a-pr-summary-says-the-worst, a-brief-without-an-ask-never-sits-beside-needs-you,
// the stack bar and the Pull requests card's fold). Synthetic data only: example/app, made-up numbers. Sized like the
// pr-scale stress case: one 120-PR stack (the real one had 65).
import test from "node:test";
import assert from "node:assert/strict";
import { prChip } from "../shared/home";
import { liveLine } from "../shared/attention";
import { INVARIANTS } from "../shared/status-invariants";
import type { Pr, Snapshot, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

export function bigStack(n = 120, patch: (i: number) => Partial<Snapshot> = () => ({})): Workspace {
  const prs: Pr[] = Array.from({ length: n }, (_, i) => {
    const number = 1001 + i;
    return pr({ key: `example/app#${number}`, number, stack: "Ledger rewrite", parent: i ? `example/app#${number - 1}` : null,
      snapshot: snapshot({ title: `Step ${i + 1}`, url: `https://github.com/example/app/pull/${number}`, head: `h${number}`, headBranch: `b${number}`, base: i ? `b${number - 1}` : "main", ...patch(i) }) });
  });
  return workspace({ prs, updatedAt: new Date(clock).toISOString() });
}
const invariant = INVARIANTS.find(i => i.id === "a-pr-summary-says-the-worst")!;

test("a-pr-summary-says-the-worst: Home's PR chip names the worst open PR and counts the PRs failing", () => {
  // The first PRs are clear; four further up fail checks, three have open threads.
  const w = bigStack(120, i => [57, 80, 100, 115].includes(i) ? { failedChecks: [{ name: "test" }, { name: "lint" }].slice(0, i === 57 ? 2 : 1) as never } : [20, 30, 40].includes(i) ? { threads: [{ id: `t${i}` }] as never } : {});
  const chip = prChip(w)!;
  assert.equal(chip.checks?.tone, "danger", JSON.stringify(chip));
  // Counts PRs, not checks (#1058 fails two): the same 4 as the live line, and says so to a screen reader.
  assert.equal(chip.checks?.text, "✗ 4");
  assert.equal(chip.checks?.spoken, "4 PRs with failed checks");
  assert.equal(chip.label, "#1058+119", "names the first failing PR in stack order");
  assert.equal(chip.url, "https://github.com/example/app/pull/1058");
  assert.equal(invariant.check(w, clock), null);
  assert.match(liveLine(w, clock).text, /^Checks failed on 4 PRs$/);
});

test("a-pr-summary-says-the-worst: threads beat a clear stack; an unknown PR never reads ✓", () => {
  const threads = prChip(bigStack(10, i => i === 6 ? { threads: [{ id: "a" }, { id: "b" }] as never } : {}))!;
  assert.deepEqual([threads.label, threads.checks], ["#1007+9", { text: "2 threads", tone: "warning" }]);
  const unknown = prChip(bigStack(10, i => i === 3 ? { complete: false } : {}))!;
  assert.equal(unknown.checks, null);
  const clear = prChip(bigStack(10))!;
  assert.deepEqual([clear.label, clear.checks], ["#1001+9", { text: "✓", tone: "success", spoken: "checks passed" }]);
  // One open PR keeps its own words.
  assert.deepEqual(prChip(bigStack(1, () => ({ checksPending: true })))!.checks, { text: "Checking", tone: "muted" });
});

test("a-pr-summary-says-the-worst: the invariant catches the old first-PR chip and running-over-failing line", () => {
  const w = bigStack(20, i => i === 12 ? { failedChecks: [{ name: "test" }] as never } : i === 3 ? { checksPending: true } : {});
  assert.equal(invariant.check(w, clock), null);
  assert.equal(liveLine(w, clock).text, "Checks failed on #1013");
});

import { barMarks, stackBar, STACK_BAR_BUDGET } from "../shared/attention";
test("stack-bar-reads-at-any-size: one mark per PR up to the budget, then runs, then slices; failures stay visible", () => {
  const small = stackBar(bigStack(3));
  assert.deepEqual(barMarks(small.segments).map(m => m.count), [1, 1, 1], "a small stack keeps a mark per PR");
  // 120 PRs, four failing: runs (9 of them) keep the order and each failure as its own mark.
  const runs = barMarks(stackBar(bigStack(120, i => [57, 80, 100, 115].includes(i) ? { failedChecks: [{ name: "t" }] as never } : {})).segments);
  assert.ok(runs.length <= STACK_BAR_BUDGET, `${runs.length} marks`);
  assert.equal(runs.reduce((n, m) => n + m.count, 0), 120);
  assert.deepEqual(runs.filter(m => m.tone === "danger").map(m => m.number), [1058, 1081, 1101, 1116]);
  // Every other PR failing: too many runs, so equal slices, each painted its loudest PR.
  const slices = barMarks(stackBar(bigStack(120, i => i % 2 ? { failedChecks: [{ name: "t" }] as never } : {})).segments);
  assert.ok(slices.length <= STACK_BAR_BUDGET && slices.every(m => m.tone === "danger"));
  assert.equal(slices.reduce((n, m) => n + m.count, 0), 120);
  assert.deepEqual([slices[0]!.from, slices.at(-1)!.to], [1001, 1120], "in stack order");
});

import { quietFold, QUIET_FOLD_FROM } from "../shared/attention";
test("a-long-stack-shows-its-problems: a long stack folds its quiet runs; problems keep their rows in order", () => {
  const w = bigStack(120, i => [57, 80].includes(i) ? { failedChecks: [{ name: "t" }] as never } : i === 30 ? { threads: [{ id: "a" }] as never } : i < 3 ? { reviewDecision: "APPROVED" } : {});
  const items = quietFold(w.prs, () => false);
  const shown = items.flatMap(i => i.kind === "pr" ? [i.pr.number] : []);
  assert.deepEqual(shown, [1001, 1002, 1003, 1031, 1058, 1081], "approvals, the thread and both failures, in stack order");
  const folds = items.filter(i => i.kind === "quiet");
  assert.equal(folds.reduce((n, f) => n + (f.kind === "quiet" ? f.prs.length : 0), 0), 114);
  assert.ok(items.length < 12, `${items.length} rows instead of 120`);
  // Expanding one fold shows its PRs in place, under its row.
  const key = folds[0]!.kind === "quiet" ? folds[0]!.key : "";
  const open = quietFold(w.prs, k => k === key);
  const at = open.findIndex(i => i.kind === "quiet" && i.key === key);
  assert.ok(open[at + 1]?.kind === "pr");
  // A normal stack is never folded.
  assert.ok(quietFold(bigStack(QUIET_FOLD_FROM).prs, () => false).every(i => i.kind === "pr"));
});

test("a-pr-summary-says-the-worst: the invariant catches a chip that sums checks while the line counts PRs", async () => {
  const home = await import("../shared/home");
  const w = bigStack(30, i => [5, 9].includes(i) ? { failedChecks: [{ name: "a" }, { name: "b" }, { name: "c" }] as never } : {});
  assert.equal(home.prChip(w)!.checks?.text, "✗ 2");
  assert.equal(invariant.check(w, clock), null);
});

test("holdReason says the rows' words: checks failed", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../shared/attention.ts", import.meta.url), "utf8");
  assert.match(src, /return "checks failed";/);
  assert.doesNotMatch(src, /checks failing/);
});

test("stack-bar-reads-at-any-size: on a phone the bar has no per-mark press", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../client/header.tsx", import.meta.url), "utf8");
  const bars = src.match(/<StackBar [^>]*\/>/g) ?? [];
  assert.ok(bars.length >= 2, "the header draws the bar");
  for (const b of bars) assert.match(b, /onOpen=\{compact \? undefined : onOpenPr\}/, b);
});

test("a-pr-summary-says-the-worst: the chip says what its glyph counts, on every surface", async () => {
  const { prChip, prChipSpoken } = await import("../shared/home");
  const many = prChip(bigStack(30, i => [5, 9].includes(i) ? { failedChecks: [{ name: "a" }, { name: "b" }] as never } : {}))!;
  assert.equal(prChipSpoken(many), "Pull request #1006 and 29 more, 2 PRs with failed checks");
  const one = prChip(bigStack(1, () => ({ failedChecks: [{ name: "a" }, { name: "b" }] as never })))!;
  assert.equal(one.checks?.text, "✗ 2");
  assert.equal(prChipSpoken(one), "Pull request #1001, 2 failed checks");
  const fs = await import("node:fs");
  const list = fs.readFileSync(new URL("../client/home-list.tsx", import.meta.url), "utf8");
  assert.match(list, /testID="follow-up-row-chip" role="img" aria-label=\{prChipSpoken\(s\.pr\)\}/, "the detail pane's chip");
  assert.match(fs.readFileSync(new URL("../client/home.tsx", import.meta.url), "utf8"), /prChipSpoken\(s\.pr\)/, "the phone's meta line");
});
