import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { askQuestion, developerAnswer, needsYouQuestions, answerRecipients } from "../server/questions";
import { collapseDuplicateQuestions, compareQuestions, duplicateOpenQuestions, isOpen, questionSchema, type Question } from "../shared/questions";
import { NEEDS_YOU_INSTRUCTION, NEEDS_YOU_NUDGE, validateNeedsYou } from "../shared/brief";
import { stateSchema } from "../shared/model";
import { clock, workspace } from "./fixtures";

// Questions came in two or more times (Tom, 2026-11-10). These are the live shapes, with synthetic workspaces.
const opts = (...labels: string[]) => labels.map((label, i) => ({ letter: String.fromCharCode(65 + i), label }));
const archive = { title: "Archive the 26 dormant workspaces whose PRs are all merged or closed?", question: "26 workspaces have every PR merged or closed and no activity for a week. Archive them?", options: opts("Show me the list first", "Archive all 26 now", "Don't archive"), recommend: "A" };
const linked = { title: "Linked items: build it with the six recommendations?", question: "The design is ready with six recommended choices. Build it?", options: opts("Build it as recommended", "Build it, with changes", "Rethink the design"), recommend: "A" };
const open = (w: ReturnType<typeof workspace>) => w.questions.filter(isOpen).map(q => q.id);
const decision = (question: string, labels: string[], recommend = 0) => ({ question, options: labels.map(label => ({ label })), recommend });

test("asking the same open question again returns it: one card, and the reply says so", () => {
  const w = workspace();
  const first = askQuestion(w, "main-agent", archive, "work-around", clock);
  const again = askQuestion(w, "main-agent", { ...archive, options: opts("Show me the list first", "Archive all 26 now", "Also review the 56 with no PRs", "Don't archive") }, "work-around", clock + 60_000);
  assert.equal(first.outcome, "asked");
  assert.equal(again.outcome, "duplicate"); assert.equal(again.question.id, "Q1"); assert.equal(again.of, "Q1");
  assert.match(again.instruction, /^Already open as Q1 .*not asked again/);
  assert.match(again.instruction, /questions=\["Q1"\]/, "tells the agent how to point at it");
  assert.deepEqual(open(w), ["Q1"]); assert.equal(w.questions.length, 1);
});

test("ask_question then the turn's needs_you decision: the decision links to Q18, nothing new is asked", () => {
  const w = workspace();
  for (let i = 0; i < 17; i++) w.questions.push(questionSchema.parse({ id: `Q${i + 1}`, title: `Old ${i}`, question: "Old", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around", closed: { at: new Date(clock).toISOString(), reason: "old", by: null } }));
  assert.equal(askQuestion(w, "main-agent", linked, "work-around", clock, { via: "ask" }).question.id, "Q18");
  const r = needsYouQuestions(w, "main-agent", { decisions: [decision("Build Linked items with the six recommended choices?", ["Build as recommended", "Build with changes", "Rethink the design"])] }, "work-around", clock + 11_000, null);
  assert.deepEqual(r.questionIds, ["Q18"]); assert.deepEqual(r.createdIds, []);
  assert.equal(r.decisions[0].question, linked.question, "the brief shows Q18 itself, aligned with its id");
  assert.deepEqual(open(w), ["Q18"]);
});

test("an open decision restated at every turn's end stays one question (Q1–Q7 before the fix)", () => {
  const w = workspace();
  const d = decision(archive.title, ["Show me the list first", "Archive all 26 now", "Don't archive"]);
  const ids = Array.from({ length: 7 }, (_, turn) => needsYouQuestions(w, "main-agent", { decisions: [d] }, "work-around", clock + turn * 1_800_000, null).questionIds[0]);
  assert.deepEqual([...new Set(ids)], ["Q1"]); assert.deepEqual(open(w), ["Q1"]);
});

test("needs_you questions=[Qn] points at an open question; a closed one is refused", () => {
  const w = workspace();
  askQuestion(w, "main-agent", archive, "work-around", clock);
  const r = needsYouQuestions(w, "main-agent", validateNeedsYou({ ask: "Still open: Q1", kind: "decision", questions: ["Q1", "Q1"] }, k => k), "work-around", clock, null);
  assert.deepEqual(r.questionIds, ["Q1"]); assert.equal(r.decisions.length, 1); assert.equal(r.decisions[0].options?.length, 3); assert.equal(r.decisions[0].recommend, 0);
  w.questions[0].closed = { at: new Date(clock).toISOString(), reason: "done", by: null };
  assert.throws(() => needsYouQuestions(w, "main-agent", { questions: ["Q1"] }, "work-around", clock, null), /isn't open any more/);
  assert.throws(() => validateNeedsYou({ ask: "x", kind: "action", questions: ["Q1"] }, k => k), /only for kind "decision"/);
  assert.throws(() => validateNeedsYou({ ask: "x", kind: "decision", questions: ["HER-1"] }, k => k), /open question ids/);
});

test("reworded re-ask with the same options is the same question; changed options supersede, never two open", () => {
  const w = workspace();
  const gate = opts("Memoize the gate, replies and forwards", "Accept as is (no memo)", "Cut it: prefilter or v6-first");
  askQuestion(w, "main-agent", { title: "How should the gate's added cost be handled?", question: "The gate adds a model call per email.", options: gate, recommend: "A" }, "work-around", clock);
  const reworded = askQuestion(w, "main-agent", { title: "How should PR 6's gate handle the cost increase?", question: "PR 6 adds a gate call for every email.", options: opts("A: memoize", "B: as is", "C: prefilter / v6-first"), recommend: "A" }, "work-around", clock);
  assert.equal(reworded.outcome, "duplicate"); assert.equal(reworded.question.id, "Q1");
  const changed = askQuestion(w, "main-agent", { title: "How should the gate's added cost be handled?", question: "The gate adds a model call per email.", options: opts("Batch the gate nightly", "Drop the gate"), recommend: "A" }, "work-around", clock);
  assert.equal(changed.outcome, "superseded"); assert.equal(changed.question.id, "Q2"); assert.equal(changed.of, "Q1");
  assert.equal(w.questions[0].closed?.reason, "Superseded by Q2.");
  assert.deepEqual(open(w), ["Q2"]);
  const explicit = askQuestion(w, "main-agent", { title: "Something else entirely", question: "Pick a cohort.", options: opts("Ten percent", "Everyone"), recommend: "A" }, "work-around", clock, { supersedes: "Q2" });
  assert.equal(explicit.outcome, "superseded"); assert.deepEqual(open(w), ["Q3"]);
  assert.throws(() => askQuestion(w, "main-agent", linked, "work-around", clock, { supersedes: "Q1" }), /already closed/);
});

test("different questions stay apart: generic options, one call's several decisions, another agent's question", () => {
  const w = workspace();
  const r = needsYouQuestions(w, "main-agent", { decisions: [
    decision("Archive #3, #10, #11 and #20?", ["Yes, archive the 4", "No, keep them"]),
    decision("#4 (CI merge gate, never started):", ["Archive it", "Keep as backlog"]),
    decision("The 13 Keep workspaces:", ["Send each agent its read-only check", "Leave them for now"]) ] }, "work-around", clock, null);
  assert.deepEqual(r.questionIds, ["Q1", "Q2", "Q3"]);
  assert.equal(compareQuestions({ title: "Deploy the vendor sync?", question: "Deploy it?", options: [{ label: "Yes" }, { label: "No" }] }, { title: "Archive the vendor export?", question: "Archive it?", options: [{ label: "Yes" }, { label: "No" }] }), null, "Yes/No says nothing about which question");
  // A former main agent's question in the same workspace: only a near-identical ask merges with it.
  const other = workspace({ mainAgentId: "new-main" });
  askQuestion(other, "new-main", archive, "work-around", clock);
  other.questions[0].askedBy = "old-main";
  assert.equal(askQuestion(other, "new-main", { ...archive, title: "Archive the dormant workspaces?", question: "Some workspaces look finished. Archive the ones with merged PRs?" }, "work-around", clock).outcome, "asked");
  assert.equal(askQuestion(other, "new-main", archive, "work-around", clock).outcome, "duplicate");
});

test("a retry after a reload (the first call landed, the agent saw an error) asks nothing new", () => {
  const w = workspace();
  askQuestion(w, "main-agent", archive, "work-around", clock);
  const reloaded = stateSchema.parse(JSON.parse(JSON.stringify({ version: 1, workspaces: [w] }))).workspaces[0];
  assert.equal(askQuestion(reloaded, "main-agent", archive, "work-around", clock + 5_000).outcome, "duplicate");
  assert.equal(reloaded.questions.length, 1);
});

test("a second needs_you in one turn replaces only what the first created, never a linked ask_question", () => {
  const w = workspace();
  askQuestion(w, "main-agent", linked, "work-around", clock, { via: "ask" });
  const first = needsYouQuestions(w, "main-agent", { decisions: [decision(linked.title, ["Build it as recommended", "Build it, with changes", "Rethink the design"]), decision("Ship the migration tonight?", ["Tonight, after the deploy freeze lifts", "Tomorrow morning with the team"])] }, "work-around", clock, null);
  assert.deepEqual(first.questionIds, ["Q1", "Q2"]); assert.deepEqual(first.createdIds, ["Q2"]);
  const second = needsYouQuestions(w, "main-agent", { questions: ["Q1"] }, "work-around", clock, first);
  assert.deepEqual(second.questionIds, ["Q1"]);
  assert.deepEqual(open(w), ["Q1"], "Q2 (created by the first call) closes; Q1 (asked with ask_question) stays");
  // Records from before the fix carry only questionIds; an ask_question question in them still never closes.
  const legacy = workspace(); askQuestion(legacy, "main-agent", linked, "work-around", clock, { via: "ask" });
  needsYouQuestions(legacy, "main-agent", {}, "work-around", clock, { questionIds: ["Q1"] });
  assert.deepEqual(open(legacy), ["Q1"]);
});

test("after a merge the answer reaches the agent once, on the surviving question", () => {
  const w = workspace();
  askQuestion(w, "main-agent", archive, "work-around", clock);
  needsYouQuestions(w, "main-agent", { decisions: [decision(archive.title, ["Show me the list first", "Archive all 26 now", "Don't archive"])] }, "work-around", clock, null);
  const q = developerAnswer(w, "Q1", "A", undefined, "send", clock);
  assert.equal(q.answer?.delivery.state, "sending"); assert.deepEqual(answerRecipients(w, q), ["main-agent"]);
  assert.equal(w.questions.filter(q => q.answer).length, 1);
  assert.throws(() => developerAnswer(w, "Q1", "B", undefined, "send", clock), /already answered/);
});

test("migration: open duplicates collapse to the oldest; answered ones are untouched; a second run does nothing", () => {
  const at = (m: number) => new Date(clock + m * 60_000).toISOString();
  const q = (id: string, title: string, labels: string[], m: number, patch: Partial<Question> = {}): Question => questionSchema.parse({ id, title, question: title, options: opts(...labels), recommend: "A", askedBy: "main-agent", askedAt: at(m), mode: "work-around", ...patch });
  const n1 = ["Yes (recommended)", "No"], gate = ["Memoize the gate, replies", "Accept as is (no memo)", "Cut it: prefilter or v6-first"], gate2 = ["A: memoize", "B: as is", "C: prefilter / v6-first"];
  const vendor = [q("Q1", "N1: does a manual VendorScope N also retract the vendor status record?", n1, 0), q("Q3", "N1: does a manual VendorScope N also retract the vendor status record?", n1, 5, { closed: { at: at(6), reason: "Replaced", by: null } }), q("Q5", "N1: does a manual VendorScope N also retract the vendor status record?", n1, 6)];
  const email = [q("Q1", "How should the gate's added cost be handled?", gate, 0), q("Q3", "How should PR 6's gate handle the cost increase?", gate2, 14), q("Q4", "How should PR 6's gate handle the cost increase?", gate2, 38)];
  const answered = [q("Q7", archive.title, ["Show me the list first", "Archive all 26 now", "Don't archive"], 0, { answer: { choice: "A", at: at(1), by: "developer", delivery: { state: "sent", to: "main-agent", messageId: null, at: at(1), reason: null } } }), q("Q8", archive.title, ["Show me the list first", "Archive all 26 now", "Don't archive"], 2)];
  assert.deepEqual(collapseDuplicateQuestions(vendor, clock), [{ closed: "Q5", of: "Q1" }]);
  assert.deepEqual(collapseDuplicateQuestions(email, clock), [{ closed: "Q3", of: "Q1" }, { closed: "Q4", of: "Q1" }]);
  assert.equal(email[1].closed?.reason, "Duplicate of Q1.");
  assert.deepEqual(collapseDuplicateQuestions(answered, clock), [], "an answered question is never a duplicate's survivor or victim");
  assert.equal(answered[0].answer?.choice, "A");
  for (const list of [vendor, email, answered]) assert.deepEqual(collapseDuplicateQuestions(list, clock), [], "idempotent");
  for (const list of [vendor, email]) assert.deepEqual(duplicateOpenQuestions(list), []);
});

test("the agent-facing texts say to point at an open question instead of restating it", async () => {
  assert.match(NEEDS_YOU_INSTRUCTION, /questions=\[\\?"Q18\\?"\]/); assert.match(NEEDS_YOU_NUDGE, /questions=\[/);
  const [mcp, hook] = await Promise.all([readFile("server/mcp.mjs", "utf8"), readFile("server/agent-hook.mjs", "utf8")]);
  assert.match(mcp, /Already open as Q18/); assert.match(mcp, /supersedes/); assert.match(mcp, /questions: \{ type: "array", maxItems: 3/);
  assert.match(hook, /Ask each decision once/);
});
