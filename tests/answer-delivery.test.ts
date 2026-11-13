import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { turnEnded } from "../server/turn-events";
import { answerRecipients, developerAnswer } from "../server/questions";
import { needsYou } from "../shared/attention";
import { answerMessage, questionSchema, signedOffAnswers, type Question } from "../shared/questions";
import { INVARIANTS } from "../shared/status-invariants";
import { flagHeadline } from "../shared/headline";
import { ACTIVE_SCOPE_MIGRATION } from "../shared/settings";
import { clock, workspace } from "./fixtures";

/**
 * Invariant an-answer-leaves-needs-you-only-when-delivered (shared/questions.ts awaitingSend). 2026-11-13: Copy recorded
 * the developer's answer and the question left Needs you at once, though nothing had been sent; Put in chat (Paseo 0.16)
 * would have done the same. Root cause: Needs you listed only open questions (`!q.answer`), and a copied answer counted
 * as an answer.
 */
const question = (patch: Partial<Question> = {}): Question => questionSchema.parse({
  id: "Q1", title: "Retry declined cards?", question: "Should charges that fail with card_declined retry?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop", options: [{ letter: "A", label: "Retry once after 24 hours" }, { letter: "B", label: "Only network failures" }], ...patch,
});
const waiting = (w: ReturnType<typeof workspace>) => needsYou(w, clock).filter(i => i.kind === "answer" && i.waiting).map(i => i.key);

for (const action of ["copy", "chat"] as const) {
  test(`an answer the developer ${action === "copy" ? "copied" : "put in the agent's chat"} stays in Needs you until it is sent`, () => {
    const w = workspace({ questions: [question()] });
    developerAnswer(w, "Q1", "A", undefined, action, clock);
    assert.deepEqual(waiting(w), ["answer:Q1"], "waiting to be sent, not gone");
    const invariant = INVARIANTS.find(i => i.id === "an-answer-leaves-needs-you-only-when-delivered")!;
    assert.equal(invariant.check(w, clock), null);
  });
}

async function storeWith(t: { after: (fn: () => unknown) => void }, action: "copy" | "chat") {
  const root = await mkdtemp(join(tmpdir(), "follow-answer-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(s => {
    s.migrations = [ACTIVE_SCOPE_MIGRATION];
    const w = workspace({ id: "w1", questions: [question()] });
    developerAnswer(w, "Q1", "A", "Only soft declines.", action, clock);
    s.workspaces.push(w);
  });
  const q = (await store.snapshot()).workspaces[0].questions[0];
  return { store, sentText: answerMessage(q, "A", "Only soft declines."), w: async () => (await store.snapshot()).workspaces[0] };
}
const tail = (...texts: string[]) => [...texts.map(text => ({ type: "user_message", text })), { type: "assistant_message", text: "On it." }];

test("the developer sends the answer from the composer (edited or not): the turn's tail shows the marker and it leaves Needs you as sent", async t => {
  const s = await storeWith(t, "chat");
  const edited = s.sentText.replace("Only soft declines.", "Only soft declines, and log the rest.");
  await turnEnded(s.store, "main-agent", { kind: "completed" }, "t1", tail(edited), { interruption: null, guarded: false });
  const w = await s.w();
  assert.equal(w.questions[0].answer?.delivery.state, "sent");
  assert.equal(w.questions[0].answer?.delivery.to, "main-agent");
  assert.deepEqual(waiting(w), []);
});

test("a turn without the marker, or no tail at all, leaves a copied answer waiting", async t => {
  const s = await storeWith(t, "copy");
  await turnEnded(s.store, "main-agent", { kind: "completed" }, "t1", tail("Can you also bump the retry cap?"), { interruption: null, guarded: false });
  await turnEnded(s.store, "main-agent", { kind: "completed" }, "t2", null, { interruption: null, guarded: false });
  const w = await s.w();
  assert.equal(w.questions[0].answer?.delivery.state, "copied");
  assert.deepEqual(waiting(w), ["answer:Q1"]);
});

test("the marker edited away: signing the agent's row off settles it", () => {
  const w = workspace({ questions: [question()] });
  developerAnswer(w, "Q1", "A", undefined, "chat", clock);
  assert.deepEqual(signedOffAnswers(w.questions, q => answerRecipients(w, q), "another-agent", "2026-01-01T10:05:00Z"), [], "only that agent's answers");
  assert.deepEqual(signedOffAnswers(w.questions, q => answerRecipients(w, q), "main-agent", "2026-01-01T10:05:00Z"), ["Q1"]);
  assert.equal(w.questions[0].answer?.delivery.state, "signed-off");
  assert.deepEqual(waiting(w), []);
});

test("Send from here still works on a waiting answer", () => {
  const w = workspace({ questions: [question()] });
  developerAnswer(w, "Q1", "A", undefined, "chat", clock);
  developerAnswer(w, "Q1", "A", undefined, "send", clock);
  assert.equal(w.questions[0].answer?.delivery.state, "sending");
  assert.deepEqual(waiting(w), []);
});

test("a finished agent with an answer waiting to be sent headlines Send answer, not Finished · No ask stated", () => {
  const w = workspace({ questions: [question()] });
  developerAnswer(w, "Q1", "A", undefined, "copy", clock);
  const at = new Date(clock).toISOString();
  const row = { needs: { since: at, reasons: [{ reason: "finished" as const, detail: "", at }] }, snooze: null, brief: null };
  const h = flagHeadline(row as Parameters<typeof flagHeadline>[0], clock, needsYou(w, clock));
  assert.equal(h?.label, "Send answer");
  assert.equal(h?.line, "Your Q1 answer isn't sent yet");
});
