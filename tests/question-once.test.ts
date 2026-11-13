import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { needsYou } from "../shared/attention";
import { violations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * 2026-11-12: the panel drew the main agent's brief card ("Needs you · Billing retries?", with options) and, right
 * under it, the Needs you card with "Q5 · Billing retries" and its own Answer button. Home's detail pane did the same
 * unless the brief had decisions. One open question, asked twice on one surface, answered by two paths (the brief card
 * went through follow.brief-action, the row through follow.answer-question). Invariant
 * an-open-question-renders-once-per-surface: every surface builds one Needs you block (shared/needs-block.ts).
 */
const src = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

async function asked(titles: string[]) {
  const { askQuestion } = await import("../server/questions");
  const w = workspace();
  for (const title of titles) askQuestion(w, "main-agent", { title, question: `${title}?`, options: [{ letter: "A", label: "Yes" }, { letter: "B", label: "No" }], recommend: "A" }, "work-around", clock);
  return w;
}

test("an-open-question-renders-once-per-surface: the brief that points at a question becomes that question's card", async () => {
  const { needsYouBlock } = await import("../shared/needs-block");
  const w = await asked(["Billing retries", "Invoice copy"]);
  const items = needsYou(w, clock);
  // Brief + the same question: one card for Q1 carrying the brief, Q2 collapsed, no question rows.
  const same = needsYouBlock(items, { questionIds: ["Q1"] });
  assert.deepEqual(same.cards, [{ kind: "question", questionId: "Q1", brief: true, expanded: true }, { kind: "question", questionId: "Q2", brief: false, expanded: false }]);
  assert.equal(same.rows.filter(r => r.kind === "question").length, 0);
  assert.equal(same.count, 2);
  // Brief pointing at the second question: that one leads.
  assert.deepEqual(needsYouBlock(items, { questionIds: ["Q2"] }).cards.map(c => c.kind === "question" && [c.questionId, c.brief, c.expanded]), [["Q2", true, true], ["Q1", false, false]]);
  // Brief with no open question (an action ask): its own card, then the questions.
  assert.deepEqual(needsYouBlock(items, { questionIds: [] }).cards.map(c => c.kind === "brief" ? "brief" : c.questionId), ["brief", "Q1", "Q2"]);
  // No brief: the first question open, the rest collapsed.
  assert.deepEqual(needsYouBlock(items, null).cards.map(c => c.kind === "question" && c.expanded), [true, false]);
});

test("an-open-question-renders-once-per-surface: an answered question leaves every surface", async () => {
  const { needsYouBlock } = await import("../shared/needs-block");
  const { developerAnswer } = await import("../server/questions");
  const w = await asked(["Billing retries"]);
  developerAnswer(w, "Q1", "A", undefined, "send", clock);
  const block = needsYouBlock(needsYou(w, clock), { questionIds: ["Q1"] }, w.questions);
  assert.equal(block.cards.some(c => c.kind === "question"), false);
  assert.equal(block.cards.some(c => c.kind === "brief"), false, "the brief resolves with its question (briefQuestionsEvent), so its card never comes back alone");
});

test("an-open-question-renders-once-per-surface: the invariant holds on a workspace and flags a question listed twice", async () => {
  const { onceViolation } = await import("../shared/needs-block");
  const w = await asked(["Billing retries", "Invoice copy"]);
  assert.deepEqual(violations(w, clock).filter(v => v.id === "an-open-question-renders-once-per-surface"), []);
  const items = needsYou(w, clock);
  assert.match(onceViolation([...items, items[0]], [null]) ?? "", /Q1 renders 2 times/);
});

test("an-open-question-renders-once-per-surface: the panel and Home draw one Needs you block, never the brief beside it", () => {
  const panel = src("client/panel.tsx");
  assert.doesNotMatch(panel, /<NeedsYouCard\b/, "the panel's Needs you is the block");
  assert.match(panel, /<NeedsYouBlock\b/);
  assert.doesNotMatch(panel, /^\s*\{ask\}\s*$/m, "no brief card drawn apart from the block");
  const home = src("client/home.tsx");
  assert.match(home, /<NeedsYouBlock\b/);
  assert.doesNotMatch(home, /skip=/, "no per-kind skip hack: the block decides");
  const needs = src("client/needs-you.tsx");
  assert.match(needs, /needsYouBlock\(/);
  assert.doesNotMatch(needs, /\bskip\b|\bfeature\b/, "NeedsYouList draws the rows it is given; the featured question row is gone");
});

test("an-open-question-renders-once-per-surface: the chat's brief card answers a linked decision through the question", () => {
  const brief = src("client/brief.tsx");
  assert.match(brief, /answerQuestionRpc/, "one answer path: the question's own");
});

test("one-ask-one-title: a brief folded into its question is named by the question everywhere", async () => {
  const { foldedAsk } = await import("../shared/needs-block");
  const w = await asked(["Retry declined cards", "Invoice copy"]);
  assert.equal(foldedAsk("Pick whether declined cards retry", ["Q1"], w.questions), "Retry declined cards", "the brief's ask becomes the question's title");
  // say-it-once: several open questions keep the agent's ask; the first one's title would name the card and repeat as item 1.
  assert.equal(foldedAsk("Two calls on the invoice export", ["Q2", "Q1"], w.questions), "Two calls on the invoice export", "a brief over two open questions keeps its own ask");
  assert.equal(foldedAsk("Approve the staging bucket", [], w.questions), "Approve the staging bucket", "an ask with no question keeps its own words");
  w.questions[0].closed = { at: new Date(clock).toISOString(), reason: "moot", by: null };
  assert.equal(foldedAsk("Pick whether declined cards retry", ["Q1"], w.questions), "Pick whether declined cards retry", "no open question to fold into");
  assert.equal(foldedAsk("Two calls on the invoice export", ["Q2", "Q1"], w.questions), "Invoice copy", "one of the two still open: it names the card");
  const server = src("index.server.ts");
  assert.match(server, /call = \{ \.\.\.call, ask: linked\.ask \}/, "needs_you stores the folded title, so the row, pill, chat card and panel all read it");
});

test("one-ask-one-title: the chat's fallback card points at open questions instead of saying there's no ask", () => {
  const brief = src("client/brief.tsx");
  assert.match(brief, /Waiting on your answer to \$\{waitingOn\.join\(", "\)\}/);
});

test("a blocked task without an ask says what it waits on", async () => {
  const { blockedLine } = await import("../shared/task-status");
  const w = await asked(["Alert recipients"]);
  assert.equal(blockedLine({ evidence: "Needs Q1 settled before the thresholds move" }, w), "Blocked · waits for Q1");
  assert.equal(blockedLine({ evidence: "Waits for #212's review before the thresholds move to config" }, w), "Blocked · waits for #212's review before the thresholds move to…");
  assert.equal(blockedLine({ evidence: "PR #212 must merge first." }, w), "Blocked · PR #212 must merge first");
  assert.equal(blockedLine({ evidence: "" }, w), "Blocked");
});
