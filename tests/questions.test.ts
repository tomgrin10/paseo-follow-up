import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { DeliveryDeferred } from "../server/delivery";
import { Store } from "../server/store";
import { askQuestion, developerAnswer, recordAnswer, syncTaskQuestions, withdrawQuestion, answerRecipients } from "../server/questions";
import { answerMessage, parseAnswerMessage, questionState, replyText, nextQuestionId } from "../shared/questions";
import { completionBlockers, stateSchema, summary, type Obligation } from "../shared/model";
import { clock, workspace, pr } from "./fixtures";

const options = [{ letter: "A", label: "Retry for an hour", consequence: "Slower failures" }, { letter: "B", label: "Retry for a day" }];
const ask = (w = workspace(), patch: Record<string, unknown> = {}, mode: "stop" | "work-around" | "keep-building" = "work-around", agent = "main-agent") =>
  askQuestion(w, agent, { title: "Retry window", question: "How long should failed invoices retry?", options, recommend: "A", ...patch }, mode, clock);
const task = (patch: Partial<Obligation> = {}): Obligation => ({ id: "rollout", title: "Choose the rollout cohort", status: "waiting", afterPrs: [], enable_follow_up: true, evidence: "Needs a product call", revision: 0, ...patch });

test("saved states from before questions parse with none, and old workspaces stay valid", () => {
  const legacy = JSON.parse(JSON.stringify({ version: 1, workspaces: [workspace()] }));
  delete legacy.workspaces[0].questions;
  const parsed = stateSchema.parse(legacy);
  assert.deepEqual(parsed.workspaces[0].questions, []);
  assert.equal(parsed.workspaces[0].goal, "Ship and verify migrations");
});

test("only the main agent asks; options are lettered in order with one recommendation", () => {
  const w = workspace({ contributorAgentIds: ["helper"] });
  assert.throws(() => ask(w, {}, "work-around", "helper"), /main agent/);
  assert.throws(() => ask(w, { options: [options[1], options[0]] }), /in order/);
  assert.throws(() => ask(w, { recommend: undefined }), /Recommend one option/);
  assert.throws(() => ask(w, { recommend: "C" }), /one of A, B/);
  assert.throws(() => ask(w, { task: "missing" }), /No task/);
  assert.throws(() => ask(w, { pr: "#99" }), /No registered PR/);
  assert.throws(() => ask(w, { links: [{ url: "https://example.com", path: "docs/plan.md" }] }), /url or a path/);
  assert.equal(w.questions.length, 0, "rejected questions are not recorded");
  const { question } = ask(w, { pr: "#1", links: [{ path: "docs/retries.md", label: "Retry notes" }] });
  assert.equal(question.id, "Q1"); assert.equal(question.prKey, "example/app#1"); assert.equal(question.askedBy, "main-agent"); assert.equal(question.mode, "work-around");
  const open = ask(w, { options: [], recommend: undefined, title: "Anything else?" }).question;
  assert.equal(open.id, "Q2"); assert.equal(open.recommend, null);
});

test("refs stay unique for the life of the workspace, even after questions close", () => {
  const w = workspace();
  // Distinct questions: asking the same open one again returns it (question dedupe).
  const other = (title: string, question: string) => ({ title, question, options: [{ letter: "A", label: `${title} now` }, { letter: "B", label: `${title} later` }] });
  ask(w); const second = ask(w, other("Cohort size", "Which cohort gets the rollout first?")).question;
  assert.equal(second.id, "Q2");
  withdrawQuestion(w, "main-agent", second.id, "Settled in review", clock);
  assert.equal(ask(w, other("Alert channel", "Where do failed-retry alerts go?")).question.id, "Q3");
  assert.equal(nextQuestionId([{ id: "Q9" }, { id: "Q10" }]), "Q11");
});

test("the reply tells the agent exactly what to do in each question mode", () => {
  assert.match(ask(workspace(), {}, "stop").instruction, /Question mode: Stop\. .*stop all work until the answer arrives/);
  assert.match(ask(workspace(), {}, "work-around").instruction, /Question mode: Work around\. Build no option before the answer, not even your recommendation/);
  assert.match(ask(workspace(), {}, "keep-building").instruction, /Question mode: Keep building\. Build option A now/);
  assert.match(ask(workspace(), { big: "Sends email to customers" }, "keep-building").instruction, /This question waits like Work around/);
  assert.match(ask(workspace()).instruction, /arrives in this chat as "Follow-up answer Q1/);
  assert.equal(questionState(ask(workspace(), {}, "keep-building").question), "building");
  assert.equal(questionState(ask(workspace(), { big: "Public API" }, "keep-building").question), "waiting");
  assert.equal(questionState(ask(workspace(), {}, "stop").question), "stopped");
});

test("agents record chat answers and withdraw questions; the main agent owns them", () => {
  const w = workspace({ contributorAgentIds: ["helper"] });
  const { question } = ask(w);
  assert.throws(() => recordAnswer(w, "helper", question.id, "B", undefined, clock), /Only the main agent/);
  recordAnswer(w, "main-agent", question.id, "B", "  a day is fine  ", clock);
  assert.deepEqual({ choice: question.answer!.choice, words: question.answer!.words, by: question.answer!.by, state: question.answer!.delivery.state }, { choice: "B", words: "a day is fine", by: "agent", state: "recorded" });
  assert.throws(() => recordAnswer(w, "main-agent", question.id, "A", undefined, clock), /already answered/);
  assert.throws(() => withdrawQuestion(w, "main-agent", question.id, "moot", clock), /already answered/);
  assert.throws(() => withdrawQuestion(w, "main-agent", "Q7", "moot", clock), /No question Q7/);
});

test("developer answers: copy records it, send may follow a copy, resend only retries unsent answers", () => {
  const w = workspace();
  const { question } = ask(w);
  assert.throws(() => developerAnswer(w, question.id, "C", undefined, "send", clock), /Pick one of A, B/);
  assert.throws(() => developerAnswer(w, question.id, "A", undefined, "resend", clock), /nothing waiting/);
  developerAnswer(w, question.id, "B", "Use a day", "copy", clock);
  assert.equal(question.answer!.delivery.state, "copied");
  developerAnswer(w, question.id, "B", "Use a day", "send", clock);
  assert.equal(question.answer!.delivery.state, "sending"); assert.ok(question.answer!.delivery.messageId);
  assert.throws(() => developerAnswer(w, question.id, "A", undefined, "send", clock), /already answered/);
  question.answer!.delivery.state = "queued";
  const messageId = question.answer!.delivery.messageId;
  developerAnswer(w, question.id, "B", undefined, "resend", clock);
  assert.equal(question.answer!.delivery.state, "sending"); assert.equal(question.answer!.delivery.messageId, messageId, "a resend keeps the message id so Paseo can deduplicate it");
  const withdrawn = ask(w).question; withdrawQuestion(w, "main-agent", withdrawn.id, "No longer needed", clock);
  assert.throws(() => developerAnswer(w, withdrawn.id, "A", undefined, "send", clock), /withdrawn: No longer needed/);
  const open = ask(w, { options: [], recommend: undefined }).question;
  assert.throws(() => developerAnswer(w, open.id, "  ", undefined, "send", clock), /Write an answer/);
});

test("answer messages name the question, carry the developer's words and undo a recommendation built ahead", () => {
  const w = workspace();
  const keep = ask(w, {}, "keep-building").question;
  const text = answerMessage(keep, "B", "One day, then alert");
  assert.equal(text, "Follow-up answer Q1 (Retry window): B — Retry for a day\nThe developer added: One day, then alert\nYou were building A. Undo the work built on it and build B first.");
  assert.deepEqual(parseAnswerMessage(text), { id: "Q1", title: "Retry window", choice: "B", label: "Retry for a day", words: "One day, then alert" });
  assert.match(answerMessage(keep, "A"), /already recorded/);
  assert.deepEqual(parseAnswerMessage(answerMessage(keep, "A")), { id: "Q1", title: "Retry window", choice: "A", label: "Retry for an hour", words: null });
  assert.equal(parseAnswerMessage("Follow-up batch b1\n\n1. Fix"), null);
  assert.equal(replyText(keep, "B", "One day"), "Q1 (Retry window): B — Retry for a day\nOne day");
  assert.deepEqual(answerRecipients({ ...w, mainAgentId: "main-agent" }, { ...keep, askedBy: null }), ["main-agent"]);
});

test("open questions show as needs-you and block Done until answered or withdrawn", () => {
  const w = workspace({ prs: [], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } });
  const { question } = ask(w);
  assert.deepEqual(summary(w, clock), { status: "needs-you", label: "Needs you", reason: "Q1: Retry window" });
  assert.ok(completionBlockers(w, clock).includes("Answer or withdraw Q1 (Retry window)"));
  developerAnswer(w, question.id, "A", undefined, "copy", clock);
  assert.ok(!completionBlockers(w, clock).some(b => b.includes("Q1")));
});

test("blocked tasks become questions without losing the task; unblocking closes them; re-blocking asks again", () => {
  // Blocked on the developer: blocked with an ask (a-question-always-asks-the-developer-something).
  const w = workspace({ obligations: [task({ status: "blocked", ask: "Needs a product call", revision: 2 })] });
  assert.equal(syncTaskQuestions(w, clock), true);
  assert.equal(w.questions.length, 1);
  const [mirrored] = w.questions;
  assert.deepEqual({ id: mirrored.id, title: mirrored.title, question: mirrored.question, taskId: mirrored.taskId, taskRevision: mirrored.taskRevision, options: mirrored.options }, { id: "Q1", title: "Choose the rollout cohort", question: "Needs a product call", taskId: "rollout", taskRevision: 2, options: [] });
  assert.equal(syncTaskQuestions(w, clock), false, "syncing again changes nothing");
  assert.equal(w.obligations[0].status, "blocked", "the task itself is untouched");
  assert.match(answerMessage(mirrored, "Start with internal users"), /Continue the blocked task/);
  w.obligations[0] = { ...w.obligations[0], status: "working", revision: 3 };
  assert.equal(syncTaskQuestions(w, clock), true);
  assert.equal(mirrored.closed?.reason, "The task is no longer blocked.");
  w.obligations[0] = { ...w.obligations[0], status: "blocked", revision: 4 };
  syncTaskQuestions(w, clock);
  assert.equal(w.questions.length, 2); assert.equal(w.questions[1].id, "Q2"); assert.equal(w.questions[1].taskRevision, 4);
  developerAnswer(w, "Q2", "Internal users first", undefined, "copy", clock);
  assert.equal(syncTaskQuestions(w, clock), false, "an answered question is not asked again for the same revision");
  w.obligations[0] = { ...w.obligations[0], status: "done", revision: 5 };
  assert.equal(syncTaskQuestions(w, clock), false, "answered questions stay answered when the task finishes");
  const lifecycle = workspace({ obligations: [task({ id: "merge", title: "Merge #1", afterPrs: ["example/app#1"], status: "blocked", category: "pr_lifecycle" })] });
  assert.equal(syncTaskQuestions(lifecycle, clock), false, "PR lifecycle tasks are not developer questions");
});

async function fixture(t: any, deliver: Gateway["deliver"]) {
  const root = await mkdtemp(join(tmpdir(), "follow-questions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const w = workspace({ prs: [pr()] }); ask(w);
  await store.mutate(s => { s.workspaces.push(w); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), deliver };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(clock).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => clock);
  return { store, engine, question: async () => (await store.snapshot()).workspaces[0].questions[0] };
}

test("Send delivers the answer to the asking agent with steer semantics and records who got it", async t => {
  const sent: { recipients: string[]; text: string; messageId: string }[] = [];
  const f = await fixture(t, async (_w, recipients, text, messageId) => { sent.push({ recipients, text, messageId }); return recipients[0]; });
  const { question: recorded } = await f.engine.answer("workspace", "Q1", "B", "A day", "send");
  assert.equal(recorded.answer!.delivery.state, "sending", "the RPC replies once the answer is recorded; the send runs after");
  await f.engine.idle();
  const question = await f.question();
  assert.equal(question.answer!.delivery.state, "sent"); assert.equal(question.answer!.delivery.to, "main-agent");
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].recipients, ["main-agent"]); assert.equal(sent[0].messageId, question.answer!.delivery.messageId);
  assert.match(sent[0].text, /^Follow-up answer Q1 \(Retry window\): B — Retry for a day\nThe developer added: A day/);
  await f.engine.tick(); assert.equal(sent.length, 1, "a sent answer is never sent again");
});

test("an answer the agent can't take yet is queued and goes out on a later check", async t => {
  let ready = false; let sends = 0;
  const f = await fixture(t, async (_w, recipients) => { if (!ready) throw new DeliveryDeferred("Waiting for Session Guard to resume the agent."); sends++; return recipients[0]; });
  await f.engine.answer("workspace", "Q1", "A", undefined, "send"); await f.engine.idle();
  assert.deepEqual({ state: (await f.question()).answer!.delivery.state, reason: (await f.question()).answer!.delivery.reason }, { state: "queued", reason: "Waiting for Session Guard to resume the agent." });
  await f.engine.tick(); assert.equal(sends, 0);
  ready = true; await f.engine.tick();
  assert.equal((await f.question()).answer!.delivery.state, "sent"); assert.equal(sends, 1);
});

test("an unconfirmed send is never retried automatically; Copy never sends; reloads mark interrupted sends unconfirmed", async t => {
  let sends = 0;
  const f = await fixture(t, async () => { sends++; throw new Error("socket closed"); });
  await f.engine.answer("workspace", "Q1", "A", undefined, "send"); await f.engine.idle();
  assert.equal((await f.question()).answer!.delivery.state, "unconfirmed");
  await f.engine.tick(); assert.equal(sends, 1, "ambiguous sends wait for an explicit Resend");
  await f.engine.answer("workspace", "Q1", "A", undefined, "resend"); await f.engine.idle(); assert.equal(sends, 2);

  const copy = await fixture(t, async () => { throw new Error("must not send"); });
  const copied = await copy.engine.answer("workspace", "Q1", "B", undefined, "copy");
  assert.equal(copied.question.answer!.delivery.state, "copied");

  const reload = await fixture(t, async () => "main-agent");
  await reload.store.mutate(s => { developerAnswer(s.workspaces[0], "Q1", "A", undefined, "send", clock); });
  await reload.engine.recover();
  assert.equal((await reload.question()).answer!.delivery.state, "unconfirmed");
});
