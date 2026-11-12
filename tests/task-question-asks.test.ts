import test from "node:test";
import assert from "node:assert/strict";
import { syncTaskQuestions } from "../server/questions";
import { updateObligation } from "../server/obligations";
import { needsYou } from "../shared/attention";
import { summary } from "../shared/model";
import { taskStatus } from "../shared/task-status";
import { violations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

/**
 * 2026-11-12 Q48: an agent set a task to blocked with plain evidence ("Fix #131 is conflicting after #129; another agent
 * is merging main"). Follow-up turned it into Q48: via "task", mode work-around, the evidence as the question, no
 * options, no recommendation, in the developer's Needs you. The developer answered "sure, what's the question to me?".
 * The task waited on a PR and another agent, not on them. Invariant a-question-always-asks-the-developer-something.
 */
const EVIDENCE = "Nothing needed from the developer. Fix #131 is conflicting after #129, and another agent is merging main. Then beta.2.";
const blockedOnPr = () => { const w = workspace({ prs: [], obligations: [] }); updateObligation(w, { title: "After 2.0.1-beta.2 installs: no PR shows Unknown", status: "blocked", evidence: EVIDENCE, caller: "main-agent" }); return w; };
const q48 = () => ({ id: "Q48", title: "After 2.0.1-beta.2 installs: no PR shows Unknown", question: EVIDENCE, options: [], recommend: null, big: null, background: null, links: [], prKey: null, askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around" as const, answer: null, closed: null, via: "task" as const });

test("a-question-always-asks-the-developer-something: a task blocked on a PR or an agent asks the developer nothing", () => {
  const w = blockedOnPr();
  syncTaskQuestions(w, clock);
  assert.deepEqual(w.questions, [], "no question from evidence text");
  assert.deepEqual(needsYou(w, clock).filter(i => i.kind === "decision" || i.kind === "question"), [], "nothing in Needs you");
  assert.notEqual(summary(w, clock).status, "needs-you");
  assert.equal(taskStatus(w.obligations[0], w).text, "Blocked · fix #131 is conflicting after #129, and another agent…", "it shows as Blocked in Tasks, with what it waits on");
  assert.deepEqual(violations(w, clock).filter(v => v.id === "a-question-always-asks-the-developer-something"), []);
});

test("a-question-always-asks-the-developer-something: the live Q48 shape is a violation, and the next sync withdraws it", () => {
  const w = blockedOnPr();
  w.questions.push({ ...q48(), taskId: w.obligations[0].id, taskRevision: w.obligations[0].revision });
  assert.ok(violations(w, clock).some(v => v.id === "a-question-always-asks-the-developer-something"));
  assert.equal(syncTaskQuestions(w, clock), true);
  assert.match(w.questions[0].closed!.reason, /something other than you/);
  assert.deepEqual(violations(w, clock).filter(v => v.id === "a-question-always-asks-the-developer-something"), []);
});

test("a-question-always-asks-the-developer-something: a task blocked on the developer asks its own question, which closes when it leaves blocked", () => {
  const w = workspace({ prs: [], obligations: [] });
  const o = updateObligation(w, { title: "Pick the staging window", status: "blocked", evidence: "Ops froze deploys until Friday.", ask: "Can the migration run during Thursday's 22:00 window?", caller: "main-agent" });
  syncTaskQuestions(w, clock);
  assert.equal(w.questions.length, 1);
  assert.equal(w.questions[0].question, "Can the migration run during Thursday's 22:00 window?", "the ask, never the evidence");
  assert.equal(needsYou(w, clock).filter(i => i.kind === "question").length, 1);
  // A blocked update that leaves ask out keeps it: the same question stays open.
  updateObligation(w, { id: o.id, title: o.title, status: "blocked", evidence: "Still frozen.", caller: "main-agent" });
  syncTaskQuestions(w, clock);
  assert.equal(w.questions.filter(q => !q.closed && !q.answer).length, 1);
  for (const status of ["waiting", "done"] as const) {
    const t = workspace({ prs: [], obligations: [] });
    const task = updateObligation(t, { title: "Pick the staging window", status: "blocked", ask: "Thursday 22:00?", caller: "main-agent" });
    syncTaskQuestions(t, clock);
    updateObligation(t, { id: task.id, title: task.title, status, evidence: "Agreed in chat.", caller: "main-agent" });
    syncTaskQuestions(t, clock);
    assert.ok(t.questions[0].closed, `${status} closes the derived question`);
    assert.equal(t.obligations[0].ask, undefined, `${status} drops the ask`);
  }
});
