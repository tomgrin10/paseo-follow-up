import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { briefStep, collapsedLine, pastAsk, pickBrief, shownBrief, type Brief, type NeedsYouCall } from "../shared/brief";
import { isMoot, mootNote, STALE_BRIEF } from "../shared/errors";
import { decisionOf } from "../server/questions";
import type { Question } from "../shared/questions";

// Tom (2026-11-11): "I answered a question and it stayed there." The agent asked Q35, pointed a decision brief at it
// (brief …-1), Tom answered B, and the agent's next needs_you made brief …-2. The chat card for …-1 still showed
// "Still open: Q35" with live A–D options; tapping one said "This brief was already answered or signed off."
// Root cause: the chat card rendered its timeline row's snapshot (item.data) and trusted its `state`. The server
// re-appends the row when the brief changes, but that write is best-effort (a failure is swallowed), and nothing
// re-checked the row against the stored brief. So a row whose brief had moved on stayed actionable forever.
// The class fix: shownBrief() decides what a card shows from the server's live brief, and a card is actionable only
// when the server says that exact brief is open. The card's text comes from the live question, never a cut copy.

const T0 = "2026-11-11T10:00:00.000Z";
const call: NeedsYouCall = { ask: "Which plugin should own the agent/workspace link card?", kind: "decision", decisions: [{ question: "Which plugin owns it?", options: [{ label: "Switcher" }, { label: "Follow-up" }] }] };
const brief = (id: string): Brief => briefStep(null, { type: "create", id, turnId: "t1", content: pickBrief({ agent: call }), flagged: true, seq: 1, questionIds: ["Q35"] }, T0).brief!;
const LONG_Q = "You asked for a fast chat item that links to an agent or workspace when an agent creates one. I wrongly sent it to Chat Polish and have pulled it back. Which of your plugins should own it? This one can't wait for 2.0 because the 0.16 work reads the same lists.";
const LONG_C = "Ships as a beta soon. Switcher already moves between agents and workspaces, and its 0.16 work reads the same live lists. It shows Paseo's status for the child, not Follow-up's.";
const q35 = (answer: string | null = null): Question => ({
  id: "Q35", title: "Link card owner", question: LONG_Q, options: [{ letter: "A", label: "Switcher, built now by the 0.16 workspace", consequence: LONG_C }, { letter: "B", label: "Follow-up, right after 2.0", consequence: null }],
  recommend: "A", big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "a1", askedAt: T0, mode: "stop",
  answer: answer ? { choice: answer, words: null, at: T0, by: "developer", delivery: { state: "sent", to: "a1", messageId: "m1", at: T0, reason: null } } as unknown as Question["answer"] : null,
  closed: null, via: "ask",
} as unknown as Question);

test("a card is actionable only when the server says that exact brief is open", () => {
  const row = brief("brief:t1-1");
  assert.equal(shownBrief(row, { brief: row }, [q35()]).actionable, true, "the live brief is this one and open");
  assert.equal(shownBrief(row, undefined, [q35()]).actionable, false, "the live brief hasn't loaded yet (a stale cache isn't proof)");
  const answered = { ...row, state: "answered" as const, outcome: "You picked B · Follow-up", outcomeAt: T0 };
  assert.equal(shownBrief(row, { brief: answered }, [q35("B")]).actionable, false, "the server's copy of this brief is answered");
  assert.equal(shownBrief(row, { brief: answered }, [q35("B")]).brief.state, "answered", "the live brief wins over the row's snapshot");
});

test("a superseded or missing brief renders resolved: answered from its questions, else replaced", () => {
  const row = brief("brief:t1-1");
  const newer = brief("brief:t1-2");
  // Tom's case: Q35 answered, then a newer brief. The old row says open; the card says what happened.
  const done = shownBrief(row, { brief: newer }, [q35("B")]);
  assert.equal(done.actionable, false);
  assert.equal(done.brief.state, "answered");
  assert.match(done.brief.outcome ?? "", /B/, "the recorded answer, not a dead end");
  assert.equal(done.brief.decisions[0].chosen, "B");
  // No answer recorded anywhere: the newer brief replaced it.
  const replaced = shownBrief(row, { brief: newer }, [q35()]);
  assert.equal(replaced.actionable, false);
  assert.equal(replaced.brief.state, "superseded");
  assert.equal(replaced.brief.outcome, "Replaced by a newer card");
  assert.equal(collapsedLine(replaced.brief), "Replaced by a newer card", "the card shows Follow-up's line, not the agent's stale ask");
  const gone = shownBrief(row, { brief: null }, []);
  assert.equal(gone.brief.state, "superseded", "the agent has no brief at all now");
  assert.equal(gone.brief.outcome, "No longer needed · the agent moved on", "nothing replaced it");
});

test("a brief whose questions are all answered isn't open, even if the stored brief still says so", () => {
  const row = brief("brief:t1-1");
  const shown = shownBrief(row, { brief: row }, [q35("B")]);
  assert.equal(shown.actionable, false);
  assert.equal(shown.brief.state, "answered");
});

test("the card shows the live question's full text, never a cut copy", () => {
  const row = { ...brief("brief:t1-1"), decisions: [{ ...brief("x").decisions[0], id: "Q35", question: LONG_Q.slice(0, 200), options: [{ letter: "A", label: "Switcher, built now by the 0.16 work", consequence: LONG_C.slice(0, 160) }, { letter: "B", label: "Follow-up, right after 2.0", consequence: null }] }] };
  const d = shownBrief(row, { brief: row }, [q35()]).brief.decisions[0];
  assert.equal(d.question, LONG_Q);
  assert.equal(d.options[0].label, "Switcher, built now by the 0.16 workspace");
  assert.equal(d.options[0].consequence, LONG_C);
});

test("decisionOf copies a question's text whole (the card clamps visually, at a word, with an ellipsis)", () => {
  const d = decisionOf(q35());
  assert.equal(d.question, LONG_Q);
  assert.equal(d.options![0].consequence, LONG_C);
  assert.equal(d.options![0].label, "Switcher, built now by the 0.16 workspace");
});

test("a moot rejection is recognisable, wrapped or not, so the surface reconciles instead of printing a dead end", () => {
  assert.ok(isMoot(new Error(STALE_BRIEF.answered)));
  assert.ok(isMoot(new Error(`Request failed: ${STALE_BRIEF.replaced} requestType=follow.brief-action code=1`)));
  assert.ok(isMoot(new Error("Q35 is already answered.")));
  assert.ok(isMoot(new Error("Q35 was withdrawn: Replaced by a newer needs_you call.")));
  assert.ok(!isMoot(new Error("Pick one of the options on the card.")));
  assert.ok(!isMoot(new Error("Q35 has nothing waiting to be resent.")));
});

test("invariant: every brief surface goes through shownBrief, and the server throws only the shared stale messages", async () => {
  const root = join(import.meta.dirname, "..");
  const card = await readFile(join(root, "client/brief.tsx"), "utf8");
  assert.match(card, /shownBrief\(/, "BriefCard decides open/resolved from the live brief");
  assert.doesNotMatch(card, /b\.state !== "open"\) return <Past/, "the row snapshot's state is never trusted on its own");
  const inbox = await readFile(join(root, "server/inbox.ts"), "utf8");
  assert.doesNotMatch(inbox, /already answered or signed off\.|replaced by a newer one\./, "stale rejections use STALE_BRIEF, so clients can recognise them");
  // Every surface that sends a brief action or a question answer reconciles a moot refusal instead of offering Retry.
  for (const f of ["client/brief.tsx", "client/questions.tsx"]) {
    const src = await readFile(join(root, f), "utf8");
    for (const call of src.matchAll(/run(?:Action|Undoable)\(/g)) {
      // The whole call: from its "(" to the matching ")".
      let depth = 0, end = call.index + call[0].length - 1;
      for (; end < src.length; end++) { if (src[end] === "(") depth++; else if (src[end] === ")" && --depth === 0) break; }
      const body = src.slice(call.index, end + 1);
      if (/act\(|answerRpc\(|work\b/.test(body)) assert.match(body, /\breconcile\b/, `${f}: a ${call[0]}…) that sends a brief action or an answer needs reconcile`);
    }
  }
  const questions = await readFile(join(root, "server/questions.ts"), "utf8");
  assert.doesNotMatch(questions.slice(questions.indexOf("export function decisionOf")), /^[^\n]*\.slice\(0, \d+\)/, "no hard cut of question text into a brief");
});

// The orchestrator's rule (2026-11-11): when every question a brief points at is answered or withdrawn, by any path,
// the brief resolves on the server and keeps the recorded answers. Harness finding: answering Q1 through the question
// card left the decision brief open on the server, so its pill and Needs-you count stayed up.
test("invariant: every answer path resolves a brief whose questions are all settled, on the server", async () => {
  const { briefQuestionsEvent } = await import("../shared/brief");
  const { developerAnswer, recordAnswer, withdrawQuestion } = await import("../server/questions");
  const { workspace } = await import("./fixtures");
  const paths: [string, (w: ReturnType<typeof workspace>) => void, "answered" | "superseded"][] = [
    ["the question card (and follow_answer_question for another agent): send", w => { developerAnswer(w, "Q35", "B", undefined, "send", Date.parse(T0)); }, "answered"],
    ["the question card: copy", w => { developerAnswer(w, "Q35", "B", undefined, "copy", Date.parse(T0)); }, "answered"],
    ["follow_record_answer (answered in chat)", w => { recordAnswer(w, "main-agent", "Q35", "B", undefined, Date.parse(T0)); }, "answered"],
    ["follow_withdraw_question", w => { withdrawQuestion(w, "main-agent", "Q35", "No longer needed", Date.parse(T0)); }, "superseded"],
  ];
  for (const [path, answer, state] of paths) {
    const w = workspace({ questions: [{ ...q35(), askedBy: "main-agent" } as Question] });
    const open = brief("brief:t1-1");
    assert.equal(briefQuestionsEvent(open, w.questions), null, `${path}: nothing settled yet, nothing to do`);
    answer(w);
    const event = briefQuestionsEvent(open, w.questions);
    assert.ok(event, `${path}: settling every question resolves the brief`);
    const next = briefStep(open, event!, T0);
    assert.equal(next.brief?.state, state, path);
    assert.deepEqual(next.appends.map(b => b.state), [state], `${path}: the chat row is re-appended resolved`);
    if (state === "answered") { assert.equal(next.brief?.decisions[0].chosen, "B", `${path}: keeps the recorded answer`); assert.match(next.brief?.outcome ?? "", /B/); }
  }
  // One of two questions answered: still open.
  const w = workspace({ questions: [{ ...q35("B"), askedBy: "main-agent" } as Question, { ...q35(), id: "Q36", askedBy: "main-agent" } as Question] });
  assert.equal(briefQuestionsEvent({ ...brief("brief:t1-1"), questionIds: ["Q35", "Q36"] }, w.questions), null);
  // Wired once for every path: each write to Follow-up's state runs the check (store.onChanged).
  const server = await readFile(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
  assert.match(server, /store\.onChanged = [\s\S]{0,400}inbox\.questionsChanged\(/, "store.onChanged resolves briefs from question state");
});

test("resolved states compose with delivery: an answered brief whose delivery failed stays answered and keeps Send again", () => {
  const row = brief("brief:t1-1");
  const failed = { ...row, state: "answered" as const, outcome: "You picked B · Follow-up", outcomeAt: T0, answerId: "a1", delivery: { state: "failed" as const, error: "Paseo didn't confirm it" } };
  const shown = shownBrief(row, { brief: failed }, [q35("B")]);
  assert.equal(shown.brief.state, "answered");
  assert.equal(shown.brief.answerId, "a1", "Send again reuses the same answerId");
  assert.equal(shown.brief.delivery?.state, "failed", "the card still says Not delivered, with Send again");
  assert.equal(shown.actionable, false);
  // The row itself already collapsed with a failed delivery, and a newer brief is live: still Send again.
  const later = shownBrief(failed, { brief: brief("brief:t2") }, [q35("B")]);
  assert.equal(later.brief.delivery?.state, "failed");
});

test("store.onChanged never awaits a write to the store it runs in (it runs inside the write queue)", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Store } = await import("../server/store");
  const dir = await mkdtemp(join(tmpdir(), "onchanged-"));
  try {
    // Why the rule exists: an awaited write from onChanged never finishes.
    const store = new Store(dir);
    let nested = false;
    store.onChanged = async () => { if (nested) return; nested = true; await store.mutate(() => undefined); };
    const outcome = await Promise.race([store.mutate(s => { s.workspaces = []; (s as { importedAt?: string }).importedAt = T0; }).then(() => "done"), new Promise(r => setTimeout(() => r("deadlock"), 1500))]);
    assert.equal(outcome, "deadlock", "an awaited nested write deadlocks the store");
  } finally { await rm(dir, { recursive: true, force: true }); }
  const server = await readFile(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
  const hook = server.slice(server.indexOf("store.onChanged = "), server.indexOf("\n", server.indexOf("store.onChanged = ")));
  assert.doesNotMatch(hook, /await inbox\.questionsChanged/, "resolving briefs can write the store (settled), so onChanged starts it without awaiting");
});

test("a resolved card never leads with the agent's stale status line", () => {
  assert.equal(pastAsk("Still open: Q35, which plugin should own the agent/workspace link card"), "Which plugin should own the agent/workspace link card");
  assert.equal(pastAsk("Needs you: rotate the key"), "Rotate the key");
  assert.equal(pastAsk("Open the PR when CI is green"), "Open the PR when CI is green", "only a status word followed by punctuation or a question id goes");
  assert.equal(pastAsk("Still open Q35: which plugin?"), "Which plugin?");
  assert.equal(pastAsk("Pick how the export API is rate-limited"), "Pick how the export API is rate-limited");
});

test("a moot answer's note is Follow-up's words: what happened and that nothing was sent", () => {
  assert.equal(mootNote(new Error("Request failed: Q35 is already answered. requestType=x")), "Already answered elsewhere. Your pick wasn't sent.");
  assert.equal(mootNote(new Error("Q35 was withdrawn: Replaced by a newer needs_you call."), true), "The agent withdrew this question. Your answer wasn't sent.");
  assert.equal(mootNote(new Error(STALE_BRIEF.replaced)), "A newer card replaced this one. Your pick wasn't sent.");
});
