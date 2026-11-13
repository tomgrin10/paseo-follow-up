import test from "node:test";
import assert from "node:assert/strict";
import { activity } from "../shared/activity";
import { needsYou } from "../shared/attention";
import { workspaceHeadline } from "../shared/headline";
import { answerHeading, answerStatus, briefAnswerStatus, questionSchema, type Question } from "../shared/questions";
import { INVARIANTS } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * an-answer-leaves-needs-you-only-when-delivered, on every surface (shared/questions.ts answerStatus). 2026-11-13: after
 * Put in chat the chat's card read "Answered 12:00 PM" with a check while the answer sat unsent in the message box, and
 * Needs you said "Your Q1 answer isn't sent yet".
 */
type State = NonNullable<Question["answer"]>["delivery"]["state"];
const STATES: State[] = ["sending", "sent", "queued", "unconfirmed", "copied", "in-chat", "signed-off", "recorded"];
const answered = (state: State) => questionSchema.parse({
  id: "Q1", title: "Retry declined cards?", question: "Retry card_declined?", askedBy: "main-agent", askedAt: new Date(clock - 60_000).toISOString(), mode: "stop",
  options: [{ letter: "A", label: "Only network failures" }, { letter: "B", label: "Retry once after 24 hours" }],
  answer: { choice: "B", at: new Date(clock).toISOString(), by: state === "recorded" ? "agent" : "developer", delivery: { state, to: "main-agent", messageId: null, at: new Date(clock).toISOString() } },
});

for (const state of STATES) test(`delivery ${state}: every surface tells the same story`, () => {
  const q = answered(state);
  const s = answerStatus(q)!;
  const w = workspace({ questions: [q] });
  const items = needsYou(w, clock).filter(i => i.kind === "answer" && i.questionId === "Q1");
  const waiting = s.waiting !== null;
  assert.equal(waiting, state === "copied" || state === "in-chat");
  // Needs you and the Home row (its headline comes from the same items).
  assert.equal(items.some(i => i.kind === "answer" && !!i.waiting), waiting, "Needs you lists it as waiting to be sent exactly when it is");
  if (waiting) assert.equal(workspaceHeadline(needsYou(w, clock))?.label, "Send answer");
  // The question dialog's answer block.
  const heading = answerHeading(q)!;
  assert.equal(heading.waiting, waiting);
  assert.equal(heading.text.startsWith("Your answer, not sent yet"), waiting);
  // The chat's brief card over this question.
  const card = briefAnswerStatus(["Q1"], [q])!;
  assert.equal(card.label === "Answered", s.delivered, "the card says Answered only once it was delivered");
  assert.equal(card.label, s.label);
  // The panel's Activity timeline.
  const row = activity(w).find(r => r.key === "answered:Q1")!;
  assert.equal(/^Answered/.test(row.detail ?? ""), s.delivered);
  assert.equal(row.tone === "success", s.delivered);
  assert.equal(INVARIANTS.find(i => i.id === "an-answer-leaves-needs-you-only-when-delivered")!.check(w, clock), null);
});

test("a card over several questions reads the least delivered: one still in the message box keeps it 'not sent yet'", () => {
  const sent = { ...answered("sent"), id: "Q1" }, inChat = { ...answered("in-chat"), id: "Q2" };
  assert.equal(briefAnswerStatus(["Q1", "Q2"], [sent, inChat])?.label, "In your message box · not sent yet");
  assert.equal(briefAnswerStatus(["Q1"], [sent, inChat])?.label, "Answered");
});
