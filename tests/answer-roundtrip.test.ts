import test from "node:test";
import assert from "node:assert/strict";
import { answerMessage, parseAnswerMessage, parseAnswersMessage, OTHER_LABEL, type Question } from "../shared/questions";
import { briefAnswer, briefAnswers } from "../server/inbox";
import { onBehalfLine } from "../shared/actor";

// Invariant: every answer text Follow-up sends parses back, through the chat card's parsers, to exactly what the developer
// picked. The text is built in two places (answerMessage for questions, briefAnswer(s) for brief cards) and read in
// another (the chat card, the Overseer's preview), so nothing kept them in step. Before this test, a multi-line note or free
// answer showed only its first line, a question title with "): " split into title and choice, and a card with one decision
// sent with the multi-decision form showed the choice as "1. A".

const question = (o: Partial<Question> = {}): Question => ({ id: "Q7", title: "Ship the export fix now?", question: "Ship it?", options: [{ letter: "A", label: "Now" }, { letter: "B", label: "Wait for CI" }], recommend: "A", big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: "2026-11-04T08:00:00Z", mode: "work-around", answer: null, closed: null, ...o } as Question);
const byline = onBehalfLine({ kind: "agent", agentId: "agent-captain", title: "Release captain" })!;
const tails = [{ name: "developer", add: (t: string) => t }, { name: "agent", add: (t: string) => `${t}\n${byline}` }];

type One = { id: string; title: string; choice: string; label: string | null; words: string | null };
const single: { name: string; text: string; want: One }[] = [
  { name: "a letter", text: answerMessage(question(), "B"), want: { id: "Q7", title: "Ship the export fix now?", choice: "B", label: "Wait for CI", words: null } },
  { name: "a letter and a note", text: answerMessage(question(), "B", "ping me"), want: { id: "Q7", title: "Ship the export fix now?", choice: "B", label: "Wait for CI", words: "ping me" } },
  { name: "a letter and a multi-line note", text: answerMessage(question(), "B", "ping me\nthen ship"), want: { id: "Q7", title: "Ship the export fix now?", choice: "B", label: "Wait for CI", words: "ping me\nthen ship" } },
  { name: "Something else", text: answerMessage(question(), "other", "use a cron\nand log it"), want: { id: "Q7", title: "Ship the export fix now?", choice: OTHER_LABEL, label: null, words: "use a cron\nand log it" } },
  { name: "a free answer", text: answerMessage(question({ options: [] }), "Use the staging bucket"), want: { id: "Q7", title: "Ship the export fix now?", choice: "Use the staging bucket", label: null, words: null } },
  { name: "a multi-line free answer", text: answerMessage(question({ options: [] }), "Use staging first\nthen prod"), want: { id: "Q7", title: "Ship the export fix now?", choice: "Use staging first\nthen prod", label: null, words: null } },
  { name: "a title with parentheses", text: answerMessage(question({ title: "Ship (v2): now?" }), "A"), want: { id: "Q7", title: "Ship v2: now?", choice: "A", label: "Now", words: null } },
  { name: "keep-building, a different pick", text: answerMessage(question({ mode: "keep-building" }), "B"), want: { id: "Q7", title: "Ship the export fix now?", choice: "B", label: "Wait for CI", words: null } },
  { name: "a task's question", text: answerMessage(question({ taskId: "t1" }), "A", "note"), want: { id: "Q7", title: "Ship the export fix now?", choice: "A", label: "Now", words: "note" } },
  { name: "a brief letter", text: briefAnswer("D1", "Which encoding?", "B", "UTF-8 with BOM"), want: { id: "D1", title: "Which encoding?", choice: "B", label: "UTF-8 with BOM", words: null } },
  { name: "a brief Something else", text: briefAnswer("D1", "Which (encoding)?", "other", "", "latin-1\nplease"), want: { id: "D1", title: "Which encoding?", choice: OTHER_LABEL, label: null, words: "latin-1\nplease" } },
];

for (const c of single) for (const tail of tails) test(`answer round trip: ${c.name} (${tail.name})`, () => {
  const text = tail.add(c.text);
  assert.equal(parseAnswersMessage(text), null, "one decision is not a multi-decision answer");
  assert.deepEqual(parseAnswerMessage(text), c.want);
});

const decisions = [
  { id: "Q3", question: "Measure (first)?", options: [{ letter: "A", label: "Measure" }] },
  { id: "Q4", question: "Subject sort?", options: [{ letter: "A", label: "Disable" }, { letter: "B", label: "Keep" }] },
];
const several: { name: string; text: string; want: { title: string; answers: { id: string; question: string; choice: string | null; label: string | null }[] } }[] = [
  { name: "every decision", text: briefAnswers("Two calls", decisions, { Q3: "A", Q4: "B" }), want: { title: "Two calls", answers: [{ id: "Q3", question: "Measure first?", choice: "A", label: "Measure" }, { id: "Q4", question: "Subject sort?", choice: "B", label: "Keep" }] } },
  { name: "one skipped", text: briefAnswers("Two calls", decisions, { Q4: "A" }), want: { title: "Two calls", answers: [{ id: "Q3", question: "Measure first?", choice: null, label: null }, { id: "Q4", question: "Subject sort?", choice: "A", label: "Disable" }] } },
  { name: "a card with one decision", text: briefAnswers("One call (today)", decisions.slice(1), { Q4: "B" }), want: { title: "One call today", answers: [{ id: "Q4", question: "Subject sort?", choice: "B", label: "Keep" }] } },
];

for (const c of several) for (const tail of tails) test(`answers round trip: ${c.name} (${tail.name})`, () => {
  assert.deepEqual(parseAnswersMessage(tail.add(c.text)), c.want);
});

test("a single answer whose free text looks like a summary line is still a single answer", () => {
  const text = answerMessage(question({ options: [] }), "1. Measure first");
  assert.equal(parseAnswersMessage(text), null);
  assert.equal(parseAnswerMessage(text)?.choice, "1. Measure first");
});
