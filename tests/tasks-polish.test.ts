import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activityQuestions } from "../shared/activity";
import { answerDraft } from "../shared/questions";
import { finishedParts } from "../shared/task-view";

/**
 * 2026-11-23, the Agent's tasks critique's leftovers (tasks-are-the-agent-s, one-answer-flow-for-every-question):
 * light-mode stale read brown, an option-less question said "No options were given. Write the decision for the
 * agent." above its own field, "in Activity" looked like a link and wasn't, Activity's Questions tab counted action
 * asks the design shows without a question id, and the phone's Older explainer started left of the rows it explains.
 */
const src = (f: string) => readFile(join(import.meta.dirname, "..", f), "utf8");
const summary = { open: 1, due: 0, stale: 0, waiting: 0, finished: 3, finishedThisWeek: 2 };

test("stale is neutral: amber belongs to Needs you alone (invariant 89), so tasks mark stale with weight and size, not hue", async () => {
  const tasks = await src("client/tasks.tsx");
  assert.doesNotMatch(tasks, /staleColor|STALE_LIGHT/);
  assert.equal((tasks.match(/c\.statusWarning/g) ?? []).length, 1, "only the schedule sheet's \"Register a PR\" warning");
});

test("an option-less question's field says what to write; no line above it says options are missing", async () => {
  const d = answerDraft({ id: "Q1", options: [] }, { choice: null, words: "", noteOpen: false });
  assert.equal(d.placeholder, "Write your answer for the agent…");
  assert.equal(d.field, "answer", "the same answer flow (one-answer-flow-for-every-question)");
  assert.doesNotMatch(await src("client/questions.tsx"), /No options were given/);
});

test("the tasks footer's \"in Activity\" is a link to the Activity card", async () => {
  assert.deepEqual(finishedParts(summary), { count: "2 finished this week", place: "in Activity", text: "2 finished this week · in Activity" });
  assert.equal(finishedParts({ ...summary, finished: 0, finishedThisWeek: 0 }), null);
  const tasks = await src("client/tasks.tsx");
  assert.match(tasks, /<Pressable accessibilityRole="link" accessibilityLabel=\{`\$\{footer\.count\}\. Show finished tasks in Activity`\} onPress=\{onShowActivity\}/, "the whole row is the link, named for a screen reader");
  assert.match(tasks, /minHeight: compact \? 44 : undefined/, "a 44pt target on touch");
  const panel = await src("client/panel.tsx");
  assert.match(panel, /onShowActivity=\{showActivity\}/);
  assert.match(panel, /<View ref=\{logRef\}/, "it scrolls to the Activity card, in either column");
});

test("Activity's Questions tab lists and counts decisions; an action ask is in the Timeline only", async () => {
  const qs = [{ id: "Q1", need: "decision" }, { id: "Q2", need: "action" }, { id: "Q3" }];
  assert.deepEqual(activityQuestions(qs).map(q => q.id), ["Q1", "Q3"]);
  // The card's rows and counts come from one page builder on the worker (shared/history.ts activityPage).
  assert.match(await src("shared/history.ts"), /const qs = activityQuestions\(w\.questions/, "one rule for the list and its count");
});

test("the phone's Older explainer starts where the rows' text does", async () => {
  const list = await src("client/home-list.tsx");
  assert.match(list, /export const TOUCH_ROW_TEXT = 14 \+ 18 \+ 10;/);
  assert.match(list, /item\.key === "l:older" && touch \? \{ paddingLeft: TOUCH_ROW_TEXT \}/);
  assert.match(list, /paddingLeft: touch \? 14 : dense \? 8 : 16/, "the row's padding the constant adds up");
  assert.match(list, /width: touch \? 18 : 16/, "the row's glyph width");
});
