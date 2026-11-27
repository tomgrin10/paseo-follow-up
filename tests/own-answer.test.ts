import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OTHER, OWN_ANSWER_HINT, PICK_HINT, answerDraft } from "../shared/questions";

// The developer (2026-11-17): "when answering question in the right sidebar, when wanting to give another answer,
// the user has to type in the box, and also press the "other answer" button, that's not really intuitive, i believe
// that's done better when the question is opened as a popup".
//
// Root cause: QuestionBody drew its text field on every surface but the desktop pill, and that field was an optional
// note until Something else was picked. Words typed into it with nothing picked meant nothing to Send (no choice),
// so the developer had to find Something else as well. The pill's popover hid the field until Something else (or
// Note) was pressed, so there it was one step. Invariant `one-answer-flow-for-every-question`: one rule
// (answerDraft) decides what the field means, and the field shows only once that is known, on every surface.

const q = { id: "Q1", options: [{ letter: "A", label: "The English text" }, { letter: "B", label: "The key itself" }] };
const ROOT = join(import.meta.dirname, "..");
const src = (f: string) => readFile(join(ROOT, f), "utf8");

test("words typed with nothing picked are the developer's own answer, and Send sends them as Something else", () => {
  // The reported state: the panel's field filled in, no option picked. On main Send had nothing to send.
  const d = answerDraft(q, { choice: null, words: "Retry nightly instead", noteOpen: false });
  assert.equal(d.answer, OTHER, "Send sends Something else, no second click");
  assert.equal(d.own, true, "Something else reads as picked");
  assert.equal(d.field, "answer");
  assert.equal(d.words, "Retry nightly instead", "the words are the answer Send sends, never dropped (what-you-typed-is-what-gets-sent)");
});

test("nothing picked: no field whose meaning is unknown, and nothing to send", () => {
  const d = answerDraft(q, { choice: null, words: "", noteOpen: false });
  assert.equal(d.field, null, "the field waits until Something else or Add note says what it is");
  assert.equal(d.answer, null);
  assert.equal(d.canAddNote, false, "a note needs a pick to go with");
  assert.equal(d.hint, PICK_HINT, "a disabled Send says why, and names the way to write your own");
});

test("Something else opens the field as the answer: labelled so before typing, and Send waits for words", () => {
  const empty = answerDraft(q, { choice: OTHER, words: "  ", noteOpen: false });
  assert.equal(empty.field, "answer");
  assert.equal(empty.answer, null);
  assert.equal(empty.hint, OWN_ANSWER_HINT, "a disabled Send says why");
  assert.equal(empty.placeholder, "Your answer (required)");
  assert.equal(empty.label, "Your answer to Q1, required");
  assert.equal(empty.heading, "Your answer", "a visible label that stays once typing starts");
  const typed = answerDraft(q, { choice: OTHER, words: "Retry nightly", noteOpen: false });
  assert.equal(typed.answer, OTHER);
  assert.equal(typed.words, "Retry nightly", "Send sends the typed words with Something else");
  assert.equal(typed.hint, null);
});

test("a lettered pick sends at once; Add note opens a field labelled as a note, sent with that letter", () => {
  const picked = answerDraft(q, { choice: "A", words: "", noteOpen: false });
  assert.equal(picked.answer, "A");
  assert.equal(picked.field, null);
  assert.equal(picked.canAddNote, true);
  const noting = answerDraft(q, { choice: "A", words: "", noteOpen: true });
  assert.equal(noting.field, "note");
  assert.equal(noting.canAddNote, false);
  assert.equal(noting.placeholder, "Add a note for the agent (optional)");
  assert.equal(noting.label, "Note for the agent, sent with A on Q1, optional");
  assert.equal(noting.heading, "Note, sent with A · The English text", "names the option, which may have scrolled away");
  assert.equal(noting.canRemoveNote, true);
  const noted = answerDraft(q, { choice: "A", words: "but keep the old flag", noteOpen: true });
  assert.deepEqual([noted.answer, noted.words], ["A", "but keep the old flag"]);
});

test("words written as Something else stay, as a note, when the developer picks a letter after all", () => {
  const d = answerDraft(q, { choice: "B", words: "Retry nightly", noteOpen: false });
  assert.equal(d.field, "note", "shown and labelled a note, so nothing typed is hidden or silently re-purposed");
  assert.deepEqual([d.answer, d.words], ["B", "Retry nightly"]);
});

test("a question with no options: the field is the answer", () => {
  const free = { id: "Q2", options: [] };
  assert.equal(answerDraft(free, { choice: null, words: "", noteOpen: false }).field, "answer");
  assert.equal(answerDraft(free, { choice: null, words: "", noteOpen: false }).answer, null);
  assert.equal(answerDraft(free, { choice: null, words: " Ship it ", noteOpen: false }).answer, "Ship it");
});

test("one-answer-flow-for-every-question: every question surface draws QuestionBody, and its field follows answerDraft alone", async () => {
  const questions = await src("client/questions.tsx");
  // The dialog (QuestionSheet: Home, the panel, the pill's details), the pill (QuestionStepper) and Needs you (Home
  // and the panel, desktop and phone) all answer through QuestionBody.
  for (const fn of ["QuestionSheet", "QuestionStepper"]) {
    const body = questions.slice(questions.indexOf(`export function ${fn}(`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /<QuestionBody /, `${fn} draws QuestionBody`);
  }
  const needs = await src("client/needs-you.tsx");
  const ask = needs.slice(needs.indexOf("function QuestionAsk("));
  assert.match(ask.slice(0, ask.indexOf("\n}\n")), /<QuestionBody /, "Needs you's question draws QuestionBody");
  // No other client file draws an answer field for a question: only QuestionBody and the brief card hold one.
  const dir = join(ROOT, "client");
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx") && !["questions.tsx", "brief.tsx"].includes(f))) {
    const s = await readFile(join(dir, f), "utf8");
    assert.doesNotMatch(s, /<Field[^>]*(Your answer|Note for the agent)/, `${f} draws its own answer field; use QuestionBody`);
  }
  // Inside QuestionBody the field's role, label, placeholder and visibility come from answerDraft, the same in every
  // mode (dense, inline, pinned): no surface decides on its own that the field is a note.
  const body = questions.slice(questions.indexOf("export function QuestionBody("), questions.indexOf("function hostOf("));
  assert.match(body, /const draft = answerDraft\(q, \{ choice, words, noteOpen \}\);/);
  assert.match(body, /const input = draft\.field && /, "the field exists only once its role is known");
  assert.match(body, /accessibilityLabel=\{draft\.label\} placeholder=\{draft\.placeholder\}/);
  assert.match(body, /const showInput = open && !!draft\.field;/, "the pill's pinned field follows the same rule");
  assert.doesNotMatch(body, /placeholder=\{(?!draft\.)/, "no placeholder chosen outside answerDraft");
  assert.match(body, /const answer = draft\.answer;/);
  // The brief card's decisions follow the same shape: the answer field only on Something else, a note only on Add note.
  const brief = await src("client/brief.tsx");
  assert.match(brief, /\{!readonly && isOther\(picks\[d\.id\]\) && <View (?:\{\.\.\.PRIMARY_FORM\} )?style=\{\{ gap: 8 \}\}>\s*(?:<WithImages [^>]*>)?<Field accessibilityLabel=\{`Your answer/);
  assert.match(brief, /\{!readonly && !isOther\(picks\[d\.id\]\) && \(notesOpen\[d\.id\] \? <View/);
  assert.match(brief, /\{OWN_ANSWER_HINT\}/, "one hint for a Something else without words");
});
