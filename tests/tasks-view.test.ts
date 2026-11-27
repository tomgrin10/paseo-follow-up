import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskViewRows, taskSummary, summaryParts, finishedLine, owedTask } from "../shared/task-view";
import { taskStatus } from "../shared/task-status";
import { activity } from "../shared/activity";
import { liveLine } from "../shared/attention";
import { INVARIANTS } from "../shared/status-invariants";
import { questionSchema } from "../shared/questions";
import type { Obligation } from "../shared/model";
import { clock, pr, workspace } from "./fixtures";

/**
 * tasks-are-the-agent-s. 2026-11-22, two critiques of the Tasks card: it read as the developer's to-do list. It
 * mirrored Needs you ("Q1 · waiting on your answer", a question id the action card never shows), sorted the one due
 * task last, kept the send queue and repairs in it, showed every finished task, and the header's live line named a
 * waiting task while the due one went unmentioned. The card is now the agent's list, folded to one line.
 */
const DAY = 86_400_000;
const NOW = clock;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (id: string, patch: Partial<Obligation> = {}): Obligation => ({ id, title: `Task ${id}`, status: "pending", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, ...patch });
const question = (patch = {}) => questionSchema.parse({ id: "Q1", title: "Get alice's pick", question: "Share the preview with alice and tell me when they've picked.", askedBy: "main-agent", askedAt: iso(NOW - DAY), mode: "keep-building", taskId: "ask", taskRevision: 0, need: "action", ...patch });

const fixture = () => workspace({
  prs: [pr()],
  questions: [question()],
  obligations: [
    task("ask", { status: "blocked", ask: "Share the preview with alice and tell me when they've picked." }),
    task("after", { status: "waiting", afterPrs: ["example/app#1"], title: "Check alert emails in staging" }),
    task("later", { recheckAt: iso(NOW + 3 * DAY) }),
    task("due", { recheckAt: iso(NOW - DAY), evidence: "Run the backfill once billing confirms." }),
    task("stale", { recheckAt: iso(NOW - 5 * DAY), revision: 1, nudged: { key: `recheck:${iso(NOW - 5 * DAY)}`, count: 2, at: iso(NOW - DAY), revision: 1 } }),
    task("blocked", { status: "blocked", evidence: "Waits for #1's review before the thresholds move to config and the alert copy is final" }),
    task("done", { status: "done", evidence: "Shipped.", finishedAt: iso(NOW - 2 * DAY) }),
    task("old", { status: "waived", evidence: "Superseded.", finishedAt: iso(NOW - 20 * DAY) }),
  ],
});

test("tasks-are-the-agent-s: stale and due first, Needs you's last, each row says what moves it", () => {
  const rows = taskViewRows(fixture(), {}, NOW);
  assert.deepEqual(rows.map(r => [r.o.id, r.kind]), [["stale", "stale"], ["due", "due"], ["blocked", "blocked"], ["after", "after-pr"], ["later", "recheck"], ["ask", "needs-you"]]);
  const meta = Object.fromEntries(rows.map(r => [r.o.id, r.meta]));
  assert.match(meta.stale, /^Stale · due since [A-Z][a-z]{2} \d+(, \d{4})? · nudged twice, no answer$/, "the developer's date, never the agent's re-check 2026-01-01");
  assert.match(meta.due, /^Due since /);
  assert.equal(meta.ask, "In Needs you", "no question id: the action card in Needs you shows none");
  assert.ok(meta.blocked.length <= 45, `one line for a blocked task: "${meta.blocked}"`);
  assert.equal(meta.after, "After #1 deploys");
  assert.equal(rows.find(r => r.o.id === "due")!.note, "Run the backfill once billing confirms.", "a due row carries the agent's note");
  assert.equal(rows.find(r => r.o.id === "after")!.note, null, "a waiting row doesn't");
});

test("tasks-are-the-agent-s: the folded line counts, due stays neutral, stale stands apart; finished tasks go to Activity", () => {
  const w = fixture();
  const s = taskSummary(w, NOW);
  assert.deepEqual(summaryParts(s), { neutral: "6 open · 2 due", stale: "1 stale" }, "due counts the stale one: it is a due task nobody answered");
  assert.equal(finishedLine(s), "1 finished this week · in Activity");
  assert.deepEqual(summaryParts({ open: 2, due: 0, stale: 0, waiting: 0, finished: 0, finishedThisWeek: 0 }), { neutral: "2 open", stale: null });
  assert.deepEqual(summaryParts({ open: 1, due: 0, stale: 0, waiting: 1, finished: 0, finishedThisWeek: 0 }), { neutral: "1 open · in Needs you", stale: null });
  const log = activity(w);
  assert.ok(log.some(r => r.key === "task:done" && r.text === "Task done · Task done" && r.detail === "Shipped."), "finished tasks are in Activity");
  assert.ok(log.some(r => r.key === "task:old" && r.text.startsWith("Task waived")));
  assert.ok(log.some(r => r.key === "asked:Q1" && r.text === "Action · Get alice's pick" && r.detail === "Requested" && r.icon === "Hand"), "an action reads as an action, never Q1");
});

test("tasks-are-the-agent-s: a task waiting on a question points at Needs you; answered, it is the agent's", () => {
  const w = fixture();
  const ask = w.obligations.find(o => o.id === "ask")!;
  assert.equal(taskStatus(ask, w, {}, NOW).text, "In Needs you");
  const answered = workspace({ ...w, questions: [question({ answer: { choice: "A", at: iso(NOW - 3600_000), by: "developer", delivery: { state: "sent", to: "main-agent", messageId: null, at: iso(NOW - 3600_000) } } })] });
  assert.equal(taskStatus(ask, answered, {}, NOW).text, "Answered · waits on the agent");
});

test("tasks-are-the-agent-s: the live line names the task the agent owes, and a waiting one says what moves it", () => {
  assert.deepEqual(liveLine(fixture(), NOW), { icon: "waiting", text: "Stale: Task stale", since: null });
  const waiting = workspace({ prs: [pr()], obligations: [task("after", { status: "waiting", afterPrs: ["example/app#1"], title: "Check alert emails in staging" })] });
  assert.equal(liveLine(waiting, NOW).text, "Check alert emails in staging · after #1 deploys");
  const inv = INVARIANTS.find(i => i.id === "tasks-are-the-agent-s")!;
  assert.equal(inv.check(fixture(), NOW), null);
  assert.equal(inv.check(waiting, NOW), null);
});

test("tasks-are-the-agent-s: the live line reads only what's due, never the whole card (scale: liveLine runs per workspace per Home build)", async () => {
  for (const w of [fixture(), workspace({ prs: [pr()], obligations: [task("due", { recheckAt: iso(NOW - DAY) }), task("older", { recheckAt: iso(NOW - 2 * DAY) })] })]) {
    const first = taskViewRows(w, {}, NOW).find(r => r.kind === "stale" || r.kind === "due")!;
    const owed = owedTask(w, NOW)!;
    assert.deepEqual([owed.o.id, owed.stale], [first.o.id, first.kind === "stale"], "the same task the card puts first");
  }
  assert.equal(owedTask(workspace({ prs: [pr()], obligations: [task("later", { recheckAt: iso(NOW + DAY) })] }), NOW), null);
  const attention = await readFile(join(import.meta.dirname, "..", "shared/attention.ts"), "utf8");
  assert.doesNotMatch(attention, /taskViewRows?\(/, "2026-11-23: building every row in liveLine grew the idle worker's heap ~14 MB at 140 workspaces");
});

test("tasks-are-the-agent-s: the card folds by default, has no search, and the send queue is its own card", async () => {
  const src = (f: string) => readFile(join(import.meta.dirname, "..", f), "utf8");
  const tasks = await src("client/tasks.tsx");
  assert.match(tasks, /title="Agent's tasks" fold=\{\{ id: "tasks", defaultOpen: false/, "collapsed unless the developer opened it");
  assert.doesNotMatch(tasks, /useSectionSearch|StripRow|RepairTaskRow|label="Auto-send"/, "no search, no send queue, no repairs, no per-task Auto-send switch");
  const messages = await src("client/messages.tsx");
  assert.match(messages, /export function MessagesCard/);
  assert.match(await src("client/panel.tsx"), /<MessagesCard /);
});
