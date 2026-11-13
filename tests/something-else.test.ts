import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askQuestion, developerAnswer, recordAnswer } from "../server/questions";
import { answerLabel, answerMessage, parseAnswerMessage, parseAnswersMessage, replyText } from "../shared/questions";
import { activity } from "../shared/activity";
import { briefStep, pastRows, type Brief, type BriefContent } from "../shared/brief";
import { briefAnswer, briefAnswers, Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { AgentActions, type AgentActionDeps } from "../server/agent-actions";
import { toolList, actionTools } from "../server/mcp.mjs";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// Tom (2026-11-10): "for all questions, give an option to give another answer, sometimes the answer is not A nor B,
// it's a different custom one". Every question with options ends with a built-in Something else, recorded as
// choice "other" with the developer's words as the answer.

const options = [{ letter: "A", label: "Retry for an hour" }, { letter: "B", label: "Retry for a day" }];
const asked = (patch: Record<string, unknown> = {}) => { const w = workspace(); const q = askQuestion(w, "main-agent", { title: "Retry window", question: "How long should failed invoices retry?", options, recommend: "A", ...patch }, "work-around", clock).question; return { w, q }; };

test("Something else is delivered as the developer's own answer, in quotes", () => {
  const { w, q } = asked();
  developerAnswer(w, q.id, "other", "Retry until the customer's next billing date", "send", clock);
  assert.equal(q.answer?.choice, "other");
  assert.equal(q.answer?.words, "Retry until the customer's next billing date");
  const message = answerMessage(q, q.answer!.choice, q.answer!.words);
  assert.match(message, /^Follow-up answer Q1 \(Retry window\): Something else — "Retry until the customer's next billing date"\n/);
  assert.doesNotMatch(message, /The developer added/, "the words are the answer, not a note");
  assert.deepEqual(parseAnswerMessage(message), { id: "Q1", title: "Retry window", choice: "Something else", label: null, words: "Retry until the customer's next billing date" });
  assert.equal(replyText(q, "other", "Use a cron"), `Q1 (Retry window): Something else — "Use a cron"`);
  assert.equal(answerLabel(q, "other", "Use a cron"), `Something else · "Use a cron"`);
  assert.equal(answerLabel(q, "B"), "B · Retry for a day");
  // A row clamps the label: multi-line words must not cut it off at the first line break (critique, 2026-11-10).
  assert.equal(answerLabel(q, "other", "Link it from the spec:\n  https://x.dev/a"), `Something else · "Link it from the spec: https://x.dev/a"`);
});

test("Something else keeps several lines and still parses back for the chat card", () => {
  const { w, q } = asked();
  developerAnswer(w, q.id, "other", "Neither.\nRetry with backoff, capped at 3 days.", "send", clock);
  const parsed = parseAnswerMessage(answerMessage(q, "other", q.answer!.words));
  assert.equal(parsed?.words, "Neither.\nRetry with backoff, capped at 3 days.");
});

test("keep-building: Something else undoes the recommendation like any other pick", () => {
  const w = workspace();
  const q = askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options, recommend: "A" }, "keep-building", clock).question;
  developerAnswer(w, q.id, "other", "Don't retry at all", "send", clock);
  assert.match(answerMessage(q, "other", "Don't retry at all"), /You were building A\. Undo the work built on it and do what the developer described first\./);
});

test("validation: Something else without words is refused everywhere, and needs options to be other than", () => {
  const { w, q } = asked();
  assert.throws(() => developerAnswer(w, q.id, "other", undefined, "send", clock), /Something else needs your answer in words/);
  assert.throws(() => developerAnswer(w, q.id, "other", "   ", "send", clock), /Something else needs your answer in words/);
  assert.throws(() => recordAnswer(w, "main-agent", q.id, "other", undefined, clock), /words/);
  assert.equal(w.questions.filter(x => x.answer).length, 0, "nothing recorded by a refused answer");
  // An agent recording "Something else" by its label lands on the same answer.
  recordAnswer(w, "main-agent", q.id, "Something else", "Ask finance", clock);
  assert.equal(q.answer?.choice, "other");
  const free = asked({ title: "Rollout cohort", question: "Which cohort first?", options: [], recommend: undefined });
  assert.throws(() => developerAnswer(free.w, free.q.id, "other", "Internal users", "send", clock), /no options/);
});

test("every view shows a Something else answer with the words: Activity and the answer label", () => {
  const { w, q } = asked();
  developerAnswer(w, q.id, "other", "Ask finance", "send", clock);
  // Until Paseo confirms it, Activity says it's on its way (answerStatus); then Answered, words and all.
  assert.equal(activity(w).find(r => r.key === `answered:${q.id}`)?.detail, `Sending…: Something else · "Ask finance"`);
  w.questions.find(x => x.id === q.id)!.answer!.delivery.state = "sent";
  assert.equal(activity(w).find(r => r.key === `answered:${q.id}`)?.detail, `Answered: Something else · "Ask finance"`);
});

// ---------- the brief card: single and multi-decision ----------

const NOW = "2026-11-09T22:44:00.000Z";
const two: BriefContent = {
  source: "agent", kind: "decision", ask: "Two calls on the retry work", slim: false, flagged: true, sourceLine: "From the agent's needs_you",
  context: null, mono: null, facts: [], links: [], moves: [], also: null,
  decisions: [
    { id: "D1", question: "Retry window?", options: [{ letter: "A", label: "An hour", consequence: null }, { letter: "B", label: "A day", consequence: null }], recommend: "A", chosen: null, words: null },
    { id: "D2", question: "Alert on failure?", options: [{ letter: "A", label: "Slack", consequence: null }, { letter: "B", label: "Email", consequence: null }], recommend: "A", chosen: null, words: null },
  ],
} as unknown as BriefContent;
const open = (content: BriefContent = two, questionIds = ["Q9", "Q10"]): Brief => briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content, flagged: true, seq: 1, questionIds }, NOW).brief!;

test("multi-decision delivery: one line per decision, Something else with its words", () => {
  const text = briefAnswers("Two calls on the retry work", open().decisions, { Q9: "other", Q10: "B" }, { Q9: "Until the next\nbilling date" });
  const lines = text.split("\n");
  assert.equal(lines[0], "Follow-up answer Q9, Q10 (Two calls on the retry work): 1. Something else · 2. B — Email");
  assert.equal(lines[1], `Q9 (Retry window?): Something else — "Until the next billing date"`);
  assert.equal(lines[2], "Q10 (Alert on failure?): B — Email");
  assert.deepEqual(parseAnswersMessage(text)?.answers.map(a => [a.choice, a.label]), [["Something else", `"Until the next billing date"`], ["B", "Email"]]);
});

test("single-decision delivery from a brief keeps the Q<n> message format", () => {
  assert.equal(briefAnswer("Q9", "Retry window?", "other", "", "Until the next billing date"),
    `Follow-up answer Q9 (Retry window?): Something else — "Until the next billing date"\nNone of your options: the developer's own answer is in the quotes.`);
});

test("the server refuses Something else without words, then records it with the words on the card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "follow-other-"));
  try {
    const agent: AgentInfo = { id: "main", workspaceId: "w", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
    const directory = { agents: async () => [agent], workspaces: async () => [{ id: "w", name: "W" }], agent: async () => agent, tail: async () => [], clearAttention: async () => {} } as unknown as Directory;
    const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never, guard: async () => null, graceMs: 5, now: () => Date.parse(NOW), briefs: { sink: async () => {}, call: async () => null, pr: async () => null } } as never);
    await inbox.store.mutate(s => { s.entries.main = { ...(s.entries.main ?? {}), agentId: "main", brief: open() } as never; });
    const sent: string[] = [];
    await assert.rejects(inbox.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "Q9", choice: "other" }] }, async t => { sent.push(t); }), /Something else needs your answer in words/);
    await assert.rejects(inbox.briefAction("main", { briefId: "brief:t1", decisionId: "Q9", choice: "other", words: " " }, async t => { sent.push(t); }), /Something else needs your answer in words/);
    assert.equal(sent.length, 0, "nothing sent");
    const after = await inbox.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "Q9", choice: "other", words: "Until the next billing date" }, { decisionId: "Q10", choice: "A" }] }, async t => { sent.push(t); });
    await inbox.idle();
    assert.equal(sent.length, 1);
    assert.deepEqual(after.decisions.map(d => [d.chosen, d.words]), [["other", "Until the next billing date"], ["A", null]]);
    assert.equal(after.outcome, "You picked 1. Something else · 2. A");
    assert.deepEqual(pastRows(after).map(r => r.answer), [`Something else · "Until the next billing date"`, "A · Slack"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- agent parity ----------

function parity() {
  const calls: { method: string; input: unknown }[] = [];
  const state = { version: 1, workspaces: [] } as unknown as State;
  const deps = {
    store: { snapshot: async () => state, mutate: async <T>(fn: (s: State) => T) => fn(state) },
    prActions: {} as AgentActionDeps["prActions"], engine: {} as AgentActionDeps["engine"],
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async () => {} },
    rpc: { async validate(_m: string, input: unknown) { return input; }, async call(method: string, input: unknown) { calls.push({ method, input }); return { method }; } },
    display: { read: async () => ({ revision: "r1", values: {} }), write: async () => ({ status: "saved" }) },
  } as unknown as AgentActionDeps;
  return { agent: new AgentActions(deps), calls };
}

test("parity: answer_question and brief_action take choice \"other\" with words, like the card", async () => {
  const f = parity();
  const plan = await f.agent.run("a", "answer_question", { workspaceId: "w", questionId: "Q1", choice: "other", words: "Ask finance" }) as { planId: string };
  await f.agent.run("a", "answer_question", { confirm: true, planId: plan.planId });
  assert.deepEqual(f.calls.at(-1), { method: "follow.answer-question", input: { workspaceId: "w", questionId: "Q1", choice: "other", words: "Ask finance", action: "send" } });
  await f.agent.run("a", "brief_action", { agentId: "other-agent", briefId: "b", choices: [{ decisionId: "Q9", choice: "other", words: "Until billing" }] });
  await f.agent.run("a", "brief_action", { agentId: "other-agent", briefId: "b", decisionId: "Q9", choice: "other", words: "Until billing" });
  await assert.rejects(f.agent.run("a", "brief_action", { agentId: "other-agent", briefId: "b", decisionId: "Q9", choice: "maybe" }));
});

test("the tool descriptions tell agents about Something else and clickable links", () => {
  const tools = [...toolList(false, false, true, false, true), ...actionTools] as unknown as [string, string][];
  const describe = (name: string) => tools.find(t => t[0] === name)?.[1] ?? "";
  assert.match(describe("ask_question"), /Something else/);
  assert.match(describe("ask_question"), /don't add an \\?"Other\\?" option/);
  assert.match(describe("ask_question"), /clickable/);
  assert.match(describe("record_answer"), /"other"/);
  assert.match(describe("answer_question"), /"other"/);
  assert.match(describe("brief_action"), /"other"/);
});

// ---------- rendering of the built-in choice ----------

test("the question card and the brief card render Something else after the agent's options", async () => {
  const question = await readFile("client/questions.tsx", "utf8");
  const options = question.indexOf("q.options.map(o => <OptionCard");
  const other = question.indexOf("label={OTHER_LABEL}", options);
  assert.ok(options > 0 && other > options, "QuestionBody renders Something else after the options");
  assert.match(question, /\(open \|\| isOther\(q\.answer\?\.choice\)\) && <OptionCard/, "shown while open, and on an answered card only when it was the answer");
  assert.match(question, /const answer = free \? words\.trim\(\) : other && !words\.trim\(\) \? null : choice;/, "Send waits for words");
  const brief = await readFile("client/brief.tsx", "utf8");
  const rows = brief.indexOf("d.options.map(o => <OptionRow");
  assert.ok(rows > 0 && brief.indexOf("<OptionRow other option={{ letter: \"\", label: OTHER_LABEL", rows) > rows, "every brief decision ends with Something else");
});
