import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { briefStep, pickBrief, shownBrief, type Brief, type NeedsYouCall } from "../shared/brief";
import { isMoot, STALE_BRIEF } from "../shared/errors";
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
  recommend: "A", big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "a1", askedAt: T0, mode: "hold",
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
  assert.equal(replaced.brief.outcome, "Replaced by a newer update");
  assert.equal(shownBrief(row, { brief: null }, []).brief.state, "superseded", "the agent has no brief at all now");
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
