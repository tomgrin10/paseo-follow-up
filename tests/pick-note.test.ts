import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askQuestion, developerAnswer } from "../server/questions";
import { answerMessage, parseAnswerMessage, parseAnswersMessage } from "../shared/questions";
import { briefStep, type Brief, type BriefContent } from "../shared/brief";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { pickNoteViolations, violations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * Task 32deeb27: "A, but make sure to…". A note on a lettered pick reaches the agent and the record, on a question
 * and on a brief card, sent alone or together. On main, brief-action (the card and the brief_action tool) accepted the
 * note and dropped it: the reducer kept words only for Something else, and briefAnswer(s) never wrote them.
 * Invariant a-pick-note-reaches-the-agent.
 */
const NOW = "2026-11-12T10:00:00.000Z";
const two: BriefContent = {
  source: "agent", kind: "decision", ask: "Two calls on the export job", slim: false, flagged: true, sourceLine: "From the agent's needs_you",
  context: null, mono: null, facts: [], links: [], moves: [], also: null,
  decisions: [
    { id: "D1", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8", consequence: null }, { letter: "B", label: "Latin-1", consequence: null }], recommend: "A", chosen: null, words: null },
    { id: "D2", question: "Where to write it?", options: [{ letter: "A", label: "Bucket", consequence: null }, { letter: "B", label: "Local disk", consequence: null }], recommend: "A", chosen: null, words: null },
  ],
} as unknown as BriefContent;
const open = (content: BriefContent = two): Brief => briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content, flagged: true, seq: 1, questionIds: [] }, NOW).brief!;
const one = { ...two, decisions: two.decisions.slice(0, 1) } as BriefContent;

async function inbox(brief: Brief) {
  const dir = await mkdtemp(join(tmpdir(), "follow-pick-note-"));
  const agent: AgentInfo = { id: "main", workspaceId: "w", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
  const directory = { agents: async () => [agent], workspaces: async () => [{ id: "w", name: "W" }], agent: async () => agent, tail: async () => [], clearAttention: async () => {} } as unknown as Directory;
  const box = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never, guard: async () => null, graceMs: 5, now: () => Date.parse(NOW), briefs: { sink: async () => {}, call: async () => null, pr: async () => null } } as never);
  await box.store.mutate(s => { s.entries.main = { ...(s.entries.main ?? {}), agentId: "main", brief } as never; });
  return { box, done: () => rm(dir, { recursive: true, force: true }) };
}

test("a-pick-note-reaches-the-agent: brief_action with a letter and a note sends and records the note", async () => {
  const { box, done } = await inbox(open(one));
  try {
    const sent: string[] = [];
    const after = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", words: "but keep the BOM off" }, async t => { sent.push(t); });
    await box.idle();
    assert.equal(parseAnswerMessage(sent[0])?.words, "but keep the BOM off", "the agent's message carries the note");
    assert.equal(after.decisions[0].words, "but keep the BOM off", "the card's record keeps it");
    assert.equal(parseAnswerMessage(sent[0])?.choice, "A");
  } finally { await done(); }
});

test("a-pick-note-reaches-the-agent: several picks sent together keep each note on its own decision", async () => {
  const { box, done } = await inbox(open());
  try {
    const sent: string[] = [];
    const after = await box.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "D1", choice: "A", words: "but keep the BOM off" }, { decisionId: "D2", choice: "B" }] }, async t => { sent.push(t); });
    await box.idle();
    assert.deepEqual(parseAnswersMessage(sent[0])?.answers.map(a => [a.id, a.choice, a.words]), [["D1", "A", "but keep the BOM off"], ["D2", "B", null]]);
    assert.deepEqual(after.decisions.map(d => [d.chosen, d.words]), [["A", "but keep the BOM off"], ["B", null]]);
  } finally { await done(); }
});

test("a-pick-note-reaches-the-agent: a question answered with a letter and a note", () => {
  const w = workspace();
  const q = askQuestion(w, "main-agent", { title: "Encoding", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8" }, { letter: "B", label: "Latin-1" }], recommend: "A" }, "work-around", clock).question;
  developerAnswer(w, q.id, "A", "but keep the BOM off", "send", clock);
  assert.equal(parseAnswerMessage(answerMessage(q, "A", q.answer!.words))?.words, "but keep the BOM off");
  assert.deepEqual(violations(w, clock).filter(v => v.id === "a-pick-note-reaches-the-agent"), []);
});

test("a-pick-note-reaches-the-agent: holds over single and multi, one or many lines, with and without Something else", () => {
  const notes = ["but keep the BOM off", "two lines:\nfirst this,\nthen that", "  padded  "];
  const failures: string[] = [];
  for (const note of notes) {
    for (const v of pickNoteViolations(open(one), [{ decisionId: "D1", choice: "B", words: note }], NOW)) failures.push(`single · ${v.detail}`);
    for (const v of pickNoteViolations(open(), [{ decisionId: "D1", choice: "A", words: note }, { decisionId: "D2", choice: "B", words: note }], NOW)) failures.push(`multi · ${v.detail}`);
    for (const v of pickNoteViolations(open(), [{ decisionId: "D1", choice: "other", words: "Neither" }, { decisionId: "D2", choice: "A", words: note }], NOW)) failures.push(`multi+other · ${v.detail}`);
  }
  assert.deepEqual(failures, []);
});
