import test from "node:test";
import assert from "node:assert/strict";
import { coverNote, developerAnswer, needsYouQuestions, syncTaskQuestions } from "../server/questions";
import { updateObligation } from "../server/obligations";
import { needsYou } from "../shared/attention";
import { needsYouBlock } from "../shared/needs-block";
import { answerMessage, isDoneOnly, isOpen, TASK_DONE, taskNeed } from "../shared/questions";
import type { Workspace } from "../shared/model";
import { violations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * 2026-11-22, the developer, on 2.4.0-beta.0: one ask showed twice in Needs you. The agent's turn-end Action brief
 * ("Still needed: alice's pick on the decision page …", Done) and the card its blocked task made ("Share the decision
 * page with alice and tell me when they've picked"), which read "No options were given. Write the decision for the
 * agent." though nothing was to be decided. Invariant one-ask-one-item.
 */
const MAIN = "main-agent";
const ACTION = "Share the decision page with alice and tell me when they've picked; I read the choice from it.";
const empty = () => workspace({ prs: [], obligations: [] });
const blocked = (w: Workspace, ask = ACTION, need?: "decision" | "action") => {
  const o = updateObligation(w, { title: "Pick the export layout", status: "blocked", evidence: "Both layouts are built.", ask, caller: MAIN, ...(need ? { need } : {}) });
  syncTaskQuestions(w, clock);
  return o;
};
const card = (w: Workspace) => w.questions.find(q => q.via === "task" && isOpen(q))!;
const items = (w: Workspace, brief: { questionIds: string[]; kind: string } | null) => {
  const block = needsYouBlock(needsYou(w, clock), brief, w.questions);
  return { asks: block.cards.length, cards: block.cards };
};
const holds = (w: Workspace) => assert.deepEqual(violations(w, clock).filter(v => v.id === "one-ask-one-item"), []);

test("one-ask-one-item: a task that asks the developer to do something gets a Done card, never 'write the decision'", () => {
  const w = empty();
  const o = blocked(w);
  const q = card(w);
  assert.equal(q.need, "action");
  assert.deepEqual(q.options, [{ ...TASK_DONE }], "one Done option, so the card never says 'No options were given. Write the decision'");
  assert.equal(coverNote(w, o.id), null, "zero words to the agent: the card is Follow-up's, and its brief folds in on the server");
  developerAnswer(w, q.id, "A", "alice picked the wide layout", "send", clock);
  assert.match(answerMessage(q, "A", "alice picked the wide layout"), /: A — Done[\s\S]*The developer added: alice picked the wide layout[\s\S]*The developer did it: continue the blocked task/);
  holds(w);
});

test("one-ask-one-item: what a task asks for is read from the ask unless the agent says (need)", () => {
  assert.equal(taskNeed(ACTION), "action");
  assert.equal(taskNeed("Approve the vendor contract in the portal"), "action", "something to do, no question");
  assert.equal(taskNeed("Can the migration run during Thursday's 22:00 window?"), "decision");
  assert.equal(taskNeed("Which region should the replica live in?"), "decision");
  assert.equal(taskNeed("Share the deck with the board?"), "decision", "a question about doing something is still a question");
  assert.equal(taskNeed(ACTION, "decision"), "decision", "the agent's need wins");
  const w = empty();
  blocked(w, "Can the migration run during Thursday's 22:00 window?");
  assert.deepEqual(card(w).options, [], "a decision keeps its free answer");
  assert.equal(card(w).need, undefined);
  const x = empty();
  blocked(x, "Pick a name for the export", "action");
  assert.equal(card(x).need, "action");
  holds(w); holds(x);
});

test("one-ask-one-item: the reported sequence: a brief reporting the task blocked this turn folds into its card, one item", () => {
  const w = empty();
  blocked(w);
  const q = card(w);
  // The brief alone would add a second item beside the card.
  assert.equal(items(w, { questionIds: [], kind: "action" }).asks, 2, "before: the brief and the card both ask");
  const linked = needsYouQuestions(w, MAIN, { kind: "action", ask: "Still needed: alice's pick on the decision page, and your approval of #12" }, "work-around", clock, null, clock - 60_000);
  assert.deepEqual(linked.questionIds, [q.id], "a card made in this turn is what the turn's brief reports");
  assert.deepEqual(linked.createdIds, []);
  const after = items(w, { questionIds: linked.questionIds, kind: "action" });
  assert.equal(after.asks, 1, "one item: the card, carrying the brief's context");
  assert.deepEqual(after.cards, [{ kind: "question", questionId: q.id, brief: true, expanded: true }]);
  holds(w);
});

test("one-ask-one-item: a brief is never hidden by a card it isn't about, even one made in the same turn", () => {
  // A first draft of the fix (in review): every card made in the turn folded the brief in, so an unrelated ask vanished.
  const w = empty();
  blocked(w);
  const q = card(w);
  const unrelated = needsYouQuestions(w, MAIN, { kind: "action", ask: "Merge #5 when its checks pass" }, "work-around", clock, null, clock - 60_000);
  assert.deepEqual(unrelated.questionIds, [], "the merge ask isn't about the layout card");
  const shown = items(w, { questionIds: unrelated.questionIds, kind: "action" });
  assert.equal(shown.asks, 2, "both show: the merge brief and the task's card");
  assert.deepEqual(shown.cards, [{ kind: "brief" }, { kind: "question", questionId: q.id, brief: false, expanded: true }]);
  // The same turn's brief that reports the card in other words still folds (the lower same-turn bar).
  const x = empty();
  blocked(x);
  assert.deepEqual(needsYouQuestions(x, MAIN, { kind: "action", ask: "Waiting on alice's pick from the decision page" }, "work-around", clock, null, clock - 60_000).questionIds, [card(x).id]);
  holds(w); holds(x);
});

test("one-ask-one-item: a card from an earlier turn joins the brief only when the brief names or restates it", () => {
  const earlier = clock + 3_600_000;
  const run = (ask: string, context?: string) => {
    const w = empty();
    blocked(w);
    return { w, ids: needsYouQuestions(w, MAIN, { kind: "action", ask, ...(context ? { context } : {}) }, "work-around", clock, null, earlier).questionIds };
  };
  assert.deepEqual(run("Merge #12 when checks pass").ids, [], "an unrelated action keeps its own item");
  assert.deepEqual(run("Still waiting on you", "Q1 is still open: share the page with alice.").ids, ["Q1"], "named in its context");
  assert.deepEqual(run("Share the decision page with alice and tell me what they picked").ids, ["Q1"], "restated");
  const done = empty();
  blocked(done);
  assert.deepEqual(needsYouQuestions(done, MAIN, { kind: "done", ask: "Nothing needed. Shared the decision page with alice." }, "work-around", clock, null, clock - 1).questionIds, [], "a done brief asks nothing, so it points at nothing");
});

test("one-ask-one-item: a live card that framed an action as a decision gets its Done in place, keeping its id", () => {
  const w = empty();
  const o = updateObligation(w, { title: "Pick the export layout", status: "blocked", evidence: "Both layouts are built.", ask: ACTION, caller: MAIN });
  // What 2.4.0-beta.0 made: no options, no need.
  w.questions.push({ id: "Q1", title: o.title, question: ACTION, options: [], recommend: null, big: null, background: null, links: [], prKey: null,
    taskId: o.id, taskRevision: o.revision, askedBy: MAIN, askedAt: new Date(clock).toISOString(), mode: "work-around", answer: null, closed: null, via: "task" });
  assert.ok(violations(w, clock).some(v => v.id === "one-ask-one-item"), "the live shape is a violation");
  assert.equal(syncTaskQuestions(w, clock), true);
  assert.equal(w.questions.length, 1, "no second card");
  assert.equal(w.questions[0].id, "Q1");
  assert.deepEqual(w.questions[0].options, [{ ...TASK_DONE }]);
  assert.equal(syncTaskQuestions(w, clock), false, "a second sync changes nothing");
  holds(w);
  // need=decision from the agent turns it back.
  updateObligation(w, { id: o.id, title: o.title, status: "blocked", ask: ACTION, need: "decision", caller: MAIN });
  syncTaskQuestions(w, clock);
  assert.deepEqual(card(w).options, []);
  holds(w);
});

test("one-done-button: an action card is answered by one Done button, a decision never is", () => {
  const w = empty();
  blocked(w);
  assert.equal(isDoneOnly(card(w)), true, "the action card: Done, no option to pick and send");
  const d = empty();
  blocked(d, "Can the migration run during Thursday's 22:00 window?");
  assert.equal(isDoneOnly(card(d)), false, "a decision keeps its own answer");
  assert.equal(isDoneOnly({ options: [{ letter: "A", label: "Done" }] }), false, "a decision whose option happens to read Done is still picked and sent");
  assert.equal(isDoneOnly({ need: "action", options: [{ letter: "A", label: "Done" }, { letter: "B", label: "Later" }] }), false);
});

test("one-done-button: the panel and the chat card draw one Done, and a brief's Done answers the card", async () => {
  const { readFile } = await import("node:fs/promises");
  const panel = await readFile(new URL("../client/questions.tsx", import.meta.url), "utf8");
  const chat = await readFile(new URL("../client/brief.tsx", import.meta.url), "utf8");
  assert.match(panel, /const doneOnly = open && isDoneOnly\(q\) && !other;/);
  assert.match(panel, /!!q\.options\.length && !doneOnly && <View accessibilityRole="radiogroup"/, "no option to pick on an action card");
  assert.match(panel, /open && !doneOnly && <Button shortcut[^\n]*title="Send to agent"/, "no Send beside Done");
  assert.match(panel, /doneOnly && <Button shortcut=\{rowWidth >= DONE_HINT_MIN_WIDTH\}[^\n]*title="Done"/, "Done keeps its Ctrl ⏎ hint only where the row fits it beside Add note and Reply instead");
  assert.match(chat, /!done && d\.options\.map\(o => <OptionRow/, "the chat card draws no 'A Done' row beside its Done button");
  assert.match(chat, /doneMove \? \(\) => press\(doneMove\) : null/, "Ctrl+Enter sends Done on the chat card too");
  assert.match(chat, /shortcut=\{m === doneMove\}/, "the chat card's Done carries the Ctrl ⏎ hint");
  assert.match(chat, /const card = doneQ && workspace \? \{ wid: workspace\.id, qid: doneQ\.id \} : null;[\s\S]*card \? answerQuestion\(\{ workspaceId: card\.wid, questionId: card\.qid, choice: TASK_DONE\.letter/, "Done answers the card, never a second message");
});

test("one-ask-one-item: a card from before the fix closes on the next sync when the agent asked the same task itself", () => {
  // The live shape from 2.4.0-beta.0: the task's own card (no options) made first, then the agent's ask_question with
  // task set to the same task. Open or already answered, the agent's question covers the task and the card goes.
  for (const answered of [false, true]) {
    const w = empty();
    const o = updateObligation(w, { title: "Pick the export layout", status: "blocked", evidence: "Both layouts are built.", ask: "Which export layout ships?", caller: MAIN });
    const at = (ms: number) => new Date(clock + ms).toISOString();
    const base = { recommend: null, big: null, background: null, links: [], prKey: null, askedBy: MAIN, mode: "work-around" as const, closed: null };
    w.questions = [
      { ...base, id: "Q1", title: o.title, question: "Which export layout ships?", options: [], taskId: o.id, taskRevision: o.revision, askedAt: at(0), answer: null, via: "task" },
      { ...base, id: "Q2", title: "Export layout", question: "Wide or compact export layout?", options: [{ letter: "A", label: "Wide" }, { letter: "B", label: "Compact" }], taskId: o.id, taskRevision: null, askedAt: at(1000), via: "ask",
        answer: answered ? { choice: "A", at: at(2000), by: "developer", delivery: { state: "sent", to: null, messageId: "m1", at: at(2000), reason: null } } : null },
    ] as Workspace["questions"];
    const openBefore = w.questions.filter(isOpen).length;
    syncTaskQuestions(w, clock + 5000);
    assert.equal(openBefore, answered ? 1 : 2);
    assert.deepEqual(w.questions.filter(isOpen).map(q => q.id), answered ? [] : ["Q2"], "one open ask per task, and it is the agent's");
    assert.equal(w.questions[0].closed?.reason, `Already ${answered ? "answered" : "asked"} as Q2.`);
    holds(w);
  }
});
