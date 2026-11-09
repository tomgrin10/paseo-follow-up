import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefStep, hasOriginal, pastRows, selectsFirst, sendBar, type Brief, type BriefContent } from "../shared/brief";
import { briefAnswers, Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { parseAnswersMessage } from "../shared/questions";
import { answerLine } from "../shared/overseer";

// 1.4.0-beta.7, Tom on his phone: a card with three decisions sent the first tap straight away (only Q1 went out), and
// once answered the card no longer showed what had been asked.

const NOW = "2026-11-09T22:44:00.000Z";
const three: BriefContent = {
  source: "agent", kind: "decision", ask: "Clean up the stale workspaces?", slim: false, flagged: true, sourceLine: "From the agent's needs_you",
  context: "13 workspaces have had no activity for 30 days.", mono: null, facts: [], links: [], moves: [], also: null,
  decisions: [
    { id: "D1", question: "Archive the 4 merged ones?", options: [{ letter: "A", label: "Yes, archive the 4", consequence: "They leave the sidebar" }, { letter: "B", label: "Keep them", consequence: null }], recommend: "A", chosen: null },
    { id: "D2", question: "What about #4?", options: [{ letter: "A", label: "Archive it", consequence: null }, { letter: "B", label: "Keep as backlog", consequence: null }], recommend: null, chosen: null },
    { id: "D3", question: "And the 13 idle workspaces?", options: [{ letter: "A", label: "Send each agent its read-only checks", consequence: null }, { letter: "B", label: "Leave them", consequence: null }], recommend: "A", chosen: null },
  ],
} as unknown as BriefContent;
const open = (content: BriefContent = three, questionIds = ["Q9", "Q10", "Q11"]): Brief => briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content, flagged: true, seq: 1, questionIds }, NOW).brief!;

test("several decisions: a tap selects, it doesn't send; Send answers appears once every decision has a pick", () => {
  const b = open();
  assert.equal(selectsFirst(b), true, "three decisions: tapping selects");
  assert.equal(selectsFirst({ decisions: [b.decisions[0]] }), false, "one decision keeps one-tap send");
  assert.deepEqual(sendBar(b, {}), { label: "Send answers", skipped: null, ready: false, partial: false });
  assert.deepEqual(sendBar(b, { Q9: "A", Q10: "B", Q11: "A" }), { label: "Send answers", skipped: null, ready: true, partial: false });
});

test("a partial send is explicit and names the skipped decisions", () => {
  const b = open();
  const one = sendBar(b, { Q9: "A" });
  assert.equal(one.label, "Send 1 of 3"); assert.equal(one.partial, true);
  assert.equal(one.skipped, "Questions 2 and 3 stay open; the agent is told so.");
  assert.equal(sendBar(b, { Q9: "A", Q11: "A" }).skipped, "Question 2 stays open; the agent is told so.");
  const text = briefAnswers(b.ask, b.decisions, { Q9: "A" });
  assert.match(text, /^Follow-up answer Q9, Q10, Q11 \(Clean up the stale workspaces\?\): 1\. A — Yes, archive the 4 · 2\. skipped · 3\. skipped\n/);
  assert.match(text, /\nQ10 \(What about #4\?\): skipped — not answered yet; ask again if it still matters\.\n/);
  assert.match(text, /Q10 and Q11 are still open\./);
});

test("send all: one message with every decision, which parses back per decision", () => {
  const b = open();
  const text = briefAnswers(b.ask, b.decisions, { Q9: "A", Q10: "B", Q11: "A" });
  assert.equal(text.split("\n")[0], "Follow-up answer Q9, Q10, Q11 (Clean up the stale workspaces?): 1. A — Yes, archive the 4 · 2. B — Keep as backlog · 3. A — Send each agent its read-only checks");
  assert.deepEqual(parseAnswersMessage(text)?.answers, [
    { id: "Q9", question: "Archive the 4 merged ones?", choice: "A", label: "Yes, archive the 4" },
    { id: "Q10", question: "What about #4?", choice: "B", label: "Keep as backlog" },
    { id: "Q11", question: "And the 13 idle workspaces?", choice: "A", label: "Send each agent its read-only checks" },
  ]);
  assert.equal(parseAnswersMessage(briefAnswers(b.ask, b.decisions, { Q10: "A" }))?.answers[0].choice, null, "a skipped decision parses as skipped");
  assert.equal(answerLine(text), "Answered: 1. A · Yes, archive the 4; 2. B · Keep as backlog; 3. A · Send each agent its read-only checks");
});

test("the lifecycle records every pick at once; the answered card keeps the original question", () => {
  const b = open();
  const { brief: answered } = briefStep(b, { type: "options", picks: [{ decisionId: "Q9", choice: "A" }, { decisionId: "Q11", choice: "A" }] }, "2026-11-09T22:45:00.000Z");
  assert.equal(answered!.state, "answered");
  assert.deepEqual(answered!.decisions.map(d => d.chosen), ["A", null, "A"]);
  assert.equal(answered!.outcome, "You picked 1. A · 2. skipped · 3. A");
  assert.deepEqual(pastRows(answered!), [
    { id: "Q9", question: "1. Archive the 4 merged ones?", answer: "A · Yes, archive the 4" },
    { id: "Q10", question: "2. What about #4?", answer: null },
    { id: "Q11", question: "3. And the 13 idle workspaces?", answer: "A · Send each agent its read-only checks" },
  ]);
  // "Show full question" renders from the same stored item: options, consequences and context are all still there.
  assert.equal(hasOriginal(answered!), true);
  assert.equal(answered!.decisions[0].options[0].consequence, "They leave the sidebar"); assert.equal(answered!.context, "13 workspaces have had no activity for 30 days.");
  assert.equal(briefStep(b, { type: "options", picks: [{ decisionId: "Q9", choice: "Z" }] }, NOW).brief, b, "an unknown option changes nothing");
});

test("a superseded card keeps its previous version to show behind Show original", () => {
  const b = open();
  const next = briefStep(b, { type: "create", id: "brief:t2", turnId: "t2", content: { ...three, ask: "Newer ask", decisions: [] } as BriefContent, flagged: true, seq: 2 }, NOW);
  const previous = next.appends[0];
  assert.equal(previous.state, "superseded"); assert.equal(previous.id, "brief:t1");
  assert.equal(hasOriginal(previous), true);
  assert.deepEqual(previous.decisions.map(d => d.question), three.decisions.map(d => d.question));
  assert.equal(previous.context, three.context);
});

test("the server sends every pick in one message and records them all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "follow-card-"));
  try {
    const agent: AgentInfo = { id: "main", workspaceId: "w", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
    const appended: Brief[] = [];
    const directory = { agents: async () => [agent], workspaces: async () => [{ id: "w", name: "W" }], agent: async () => agent, tail: async () => [], clearAttention: async () => {} } as unknown as Directory;
    const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never, guard: async () => null, graceMs: 5, now: () => Date.parse(NOW), briefs: { sink: async (_a: string, b: Brief) => { appended.push(b); }, call: async () => null, pr: async () => null } } as never);
    await inbox.store.mutate(s => { s.entries.main = { ...(s.entries.main ?? {}), agentId: "main", brief: open() } as never; });
    const sent: string[] = [];
    const after = await inbox.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "Q9", choice: "A" }, { decisionId: "Q10", choice: "B" }, { decisionId: "Q11", choice: "A" }] }, async text => { sent.push(text); });
    assert.equal(sent.length, 1, "one message, not one per decision");
    assert.match(sent[0], /^Follow-up answer Q9, Q10, Q11 /);
    assert.deepEqual(after.decisions.map(d => d.chosen), ["A", "B", "A"]);
    assert.equal(appended.at(-1)?.state, "answered", "the timeline row is replaced by the answered card, which keeps the question");
    await assert.rejects(inbox.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "Q9", choice: "B" }] }, async () => {}), /already answered/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
