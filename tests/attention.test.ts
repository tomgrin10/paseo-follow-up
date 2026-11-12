import test from "node:test";
import assert from "node:assert/strict";
import { workspaceHeadline } from "../shared/headline";
import { ago, headline, liveLine, mergeReady, needsYou, overviewStatus, prTone, stackBar, stackOrder } from "../shared/attention";
import { clock, pr, snapshot, workspace } from "./fixtures";
import type { Batch } from "../shared/model";

const batch = (patch: Partial<Batch> = {}): Batch => ({ id: "b1", tasks: [{ key: "conflict:example/app#2", kind: "conflict", target: "example/app#2", title: "Resolve merge conflicts on example/app#2", fingerprint: "f" }], state: "pending", createdAt: new Date(clock - 60_000).toISOString(), sentAt: null, settledAt: null, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], ...patch });
const stack = () => [
  pr({ key: "example/app#1", number: 1, snapshot: snapshot({ state: "MERGED" }) }),
  pr({ key: "example/app#2", number: 2, parent: "example/app#1", snapshot: snapshot({ conflict: true }) }),
  pr({ key: "example/app#3", number: 3, parent: "example/app#2", snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) }),
  pr({ key: "example/app#4", number: 4, parent: "example/app#3", snapshot: snapshot({ draft: true }) }),
];

test("PR tones keep merged, approved, repairs and pending work apart", () => {
  assert.equal(prTone(pr({ snapshot: snapshot({ state: "MERGED" }) })), "merged");
  assert.equal(prTone(pr({ snapshot: snapshot({ reviewDecision: "APPROVED" }) })), "approved");
  assert.equal(prTone(pr({ snapshot: snapshot({ reviewDecision: "APPROVED", failedChecks: ["test"] }) })), "danger", "failed required checks never look approved");
  assert.equal(prTone(pr({ snapshot: snapshot({ conflict: true }) })), "danger");
  assert.equal(prTone(pr({ snapshot: snapshot({ threads: [{ id: "t", updatedAt: "x" }] }) })), "warning");
  assert.equal(prTone(pr({ snapshot: snapshot({ otherFailedChecks: ["preview"] }) })), "warning", "optional failures warn without counting as broken");
  assert.equal(prTone(pr({ snapshot: snapshot({ draft: true }) })), "draft");
  assert.equal(prTone(pr({ snapshot: null, error: "unavailable" })), "unknown");
  assert.equal(prTone(pr({ error: "unavailable" })), "pending", "a failed read never blanks a known status (a-github-limit-never-blanks-a-known-pr)");
  assert.equal(prTone(pr()), "pending");
});

test("the stack bar follows merge order and drops settled stacks while work is active", () => {
  const shipped = pr({ key: "example/app#9", number: 9, stack: "Old", snapshot: snapshot({ state: "MERGED" }) });
  const prs = [stack()[3], stack()[1], stack()[0], stack()[2], shipped];
  assert.deepEqual(stackOrder(prs.slice(0, 4)).map(p => p.number), [1, 2, 3, 4]);
  const bar = stackBar(workspace({ prs }));
  assert.deepEqual(bar.segments.map(s => [s.number, s.tone]), [[1, "merged"], [2, "danger"], [3, "approved"], [4, "draft"]]);
  assert.equal(bar.merged, 1); assert.equal(bar.total, 4);
  assert.deepEqual(stackBar(workspace({ prs: [shipped] })).segments.map(s => s.number), [9], "an all-settled workspace still shows its history");
});

test("needs-you lists one action per decision and respects Auto and send guards", () => {
  const w = workspace({ prs: stack(), batches: [batch()], obligations: [{ id: "d", title: "Pick a migration strategy", status: "blocked", afterPrs: [], evidence: "Two options", ask: "Expand-contract or a maintenance window?", enable_follow_up: false, revision: 0 }] });
  const items = needsYou(w, clock);
  assert.deepEqual(items.map(i => i.kind), ["decision", "send", "merge"]);
  const send = items.find(i => i.kind === "send");
  assert.equal(send?.kind === "send" && send.blocker, null);
  assert.deepEqual(needsYou({ ...w, enable_auto_sends: true }, clock).map(i => i.kind), ["decision", "merge"], "Auto sends without asking");
  const busy = needsYou({ ...w, runtimeBusy: true }, clock).find(i => i.kind === "send");
  assert.equal(busy?.kind === "send" && busy.blocker, "Sends after the agent's current turn");
  const held = needsYou({ ...w, hold: "You stopped the main agent. Resume follow-up when ready." }, clock);
  assert.equal(held[0].kind, "hold");
  assert.equal(needsYou({ ...w, archived: true }, clock).length, 0);
  assert.equal(needsYou({ ...w, enable_tracking: false }, clock).length, 0);
  const unknownGraphite = { ...w, prs: w.prs.map(p => p.number === 3 ? { ...p, snapshot: { ...p.snapshot!, graphiteMergeStatus: null } } : p) };
  assert.ok(!needsYou(unknownGraphite, clock).some(i => i.kind === "merge"), "Merge is offered only when Graphite reports the PR ready");
});

test("blocked and uncertain work surfaces as retry or check, and exhausted retries point to the agent", () => {
  const w = workspace({ batches: [batch({ state: "blocked", result: "Needs credentials", attempts: 3 })], prActions: [{ id: "a", kind: "merge", prs: ["example/app#1"], heads: {}, createdAt: new Date(clock).toISOString(), state: "uncertain", result: "Graphite did not confirm" }] });
  const items = needsYou(w, clock);
  assert.deepEqual(items.map(i => i.kind), ["retry", "check"]);
  assert.equal(items[0].kind === "retry" && items[0].exhausted, true);
  assert.equal(workspaceHeadline(needsYou(w, clock))?.key, "blocked");
});

test("merge readiness matches the PR controls and waits for queued or recent merges", () => {
  const ready = pr({ snapshot: snapshot({ reviewDecision: "APPROVED" }) });
  assert.equal(mergeReady(ready, workspace(), clock), true);
  assert.equal(mergeReady({ ...ready, snapshot: { ...ready.snapshot!, checksPending: true } }, workspace(), clock), false);
  assert.equal(mergeReady({ ...ready, snapshot: { ...ready.snapshot!, graphiteMergeStatus: "QUEUED_TO_MERGE" } }, workspace(), clock), false);
  const submitted = workspace({ prActions: [{ id: "a", kind: "merge", prs: [ready.key], heads: { [ready.key]: ready.snapshot!.head }, createdAt: new Date(clock - 5_000).toISOString(), state: "submitted", result: "ok" }] });
  assert.equal(mergeReady(ready, submitted, clock), false);
  assert.equal(mergeReady(ready, submitted, clock + 60_000), true);
});

test("headline, live line and pill read the same state", () => {
  const w = workspace({ prs: stack(), batches: [batch()] });
  assert.deepEqual(headline(w, clock).map(p => p.text), ["1 of 4 PRs merged", "2 need you", "1 to fix"]);
  assert.equal(workspaceHeadline(needsYou(w, clock))?.label, "Send 1 fix", "the pill names the top item, never \"N need you\"");
  assert.equal(workspaceHeadline(needsYou(workspace({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE_AS_STACK" }) })] }), clock))?.label, "Merge #1");
  assert.equal(workspaceHeadline(needsYou(workspace({ prs: [pr()] }), clock)), null, "no pill unless something needs you");
  const sent = { ...w, batches: [batch({ state: "sent", sentAt: new Date(clock - 120_000).toISOString() })] };
  assert.equal(liveLine(sent, clock).icon, "spinner");
  assert.match(liveLine(sent, clock).text, /Main agent is working on 1 repair/);
  // The line says why repairs wait, never "sends when the agent is idle" while it is idle.
  assert.equal(liveLine({ ...w, enable_auto_sends: true }, clock).text, "1 repair queued · sending now");
  assert.equal(liveLine({ ...w, enable_auto_sends: true, runtimeBusy: true }, clock).text, "1 repair queued · sends after the agent's current turn");
  assert.equal(liveLine({ ...w, enable_auto_sends: true, sendWait: "unloaded" }, clock).text, "1 repair queued · the agent is idle and Follow-up doesn't wake it · send it now");
});

test("done workspaces read as shipped and sort into Done", () => {
  const merged = pr({ snapshot: snapshot({ state: "MERGED" }) });
  const w = workspace({ prs: [merged], completion: { summary: "Shipped the migration", declaredAt: new Date(clock).toISOString() } });
  assert.deepEqual(headline(w, clock), [{ text: "Done · 1 PR shipped", tone: "success" }]);
  assert.equal(liveLine(w, clock).text, "Ready to archive");
  assert.equal(overviewStatus(w, clock), "done");
  assert.equal(overviewStatus(workspace({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })], runtimeBusy: true }), clock), "needs-you", "a developer action wins over agent activity");
});

test("relative times stay short", () => {
  assert.equal(ago(new Date(clock - 10_000).toISOString(), clock), "just now");
  assert.equal(ago(new Date(clock - 5 * 60_000).toISOString(), clock), "5m ago");
  assert.equal(ago(new Date(clock - 90 * 60_000).toISOString(), clock), "1h 30m ago");
  assert.equal(ago(new Date(clock - 26 * 3600_000).toISOString(), clock), "1d ago");
  assert.equal(ago(null, clock), "");
});

test("Graphite blockers say why and what to do", async () => {
  const { graphiteBlocker, mergeBlockers } = await import("../shared/pr-actions");
  assert.match(graphiteBlocker(null), /Graphite CLI sign-in/);
  assert.equal(graphiteBlocker("NEEDS_RESTACK__BASE_BRANCH_MERGED"), "Graphite says: needs restack: base branch merged");
  const approved = pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) });
  assert.deepEqual(mergeBlockers(approved), []);
});

test("RPC errors show only the reason", async () => {
  const { errorText } = await import("../shared/errors");
  assert.equal(errorText(new Error("Request failed: Tasks changed during refresh. Review the updated batch before sending. requestType=plugin.rpc.invoke.request code=handler_error")), "Tasks changed during refresh. Review the updated batch before sending.");
  assert.equal(errorText(new Error("Plain message")), "Plain message");
  assert.equal(errorText(new Error("")), "Something went wrong. Try again.");
});

test("questions join Needs you: stop-mode first, blocked tasks fold into their question, unconfirmed answers ask for a check", async () => {
  const { askQuestion, syncTaskQuestions, developerAnswer } = await import("../server/questions");
  const w = workspace({ prs: [], obligations: [{ id: "cohort", title: "Choose the rollout cohort", status: "blocked", afterPrs: [], enable_follow_up: true, evidence: "Needs a product call", ask: "Which cohort goes first?", revision: 1 }] });
  assert.deepEqual(needsYou(w, clock).map(i => i.kind), ["decision"], "before the server mirrors it, a blocked task is a decision");
  syncTaskQuestions(w, clock);
  askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" }, "work-around", clock);
  askQuestion(w, "main-agent", { title: "Public API name", question: "Which name?", options: [{ letter: "A", label: "retries" }], recommend: "A" }, "stop", clock);
  const items = needsYou(w, clock);
  assert.deepEqual(items.map(i => i.kind === "question" ? i.questionId : i.kind), ["Q3", "Q1", "Q2"]);
  w.hold = "You stopped the main agent. Resume follow-up when ready.";
  assert.deepEqual(needsYou(w, clock).slice(0, 2).map(i => i.kind === "question" ? i.questionId : i.kind), ["Q3", "hold"], "a question that stopped the agent outranks a pause");
  w.hold = null;
  assert.equal(items[0].title, "Q3 · Public API name");
  assert.equal(workspaceHeadline(needsYou(w, clock))?.label, "3 questions");
  assert.equal(liveLine(w, clock).text, "Main agent stopped until you answer Q3");
  developerAnswer(w, "Q3", "A", undefined, "send", clock);
  w.questions[2].answer!.delivery.state = "unconfirmed";
  developerAnswer(w, "Q2", "A", undefined, "copy", clock);
  developerAnswer(w, "Q1", "Internal users first", undefined, "copy", clock);
  assert.deepEqual(needsYou(w, clock).map(i => i.kind), ["answer"]);
  assert.equal(workspaceHeadline(needsYou(w, clock))?.label, "Check answer");
  w.questions[2].answer!.delivery.state = "sent";
  assert.deepEqual(needsYou(w, clock), [], "an answered blocked-task question doesn't ask again while the agent catches up");
});
