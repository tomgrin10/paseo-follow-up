import test from "node:test";
import assert from "node:assert/strict";
import { NOW_SOURCES, milestoneInputSchema, nowOf, nowText, workOf, type AgentFacts } from "../shared/now";
import { listEntry, isArchivedEntry } from "../shared/list";
import { clock, pr, snapshot, workspace } from "./fixtures";
import type { Batch, Obligation, Snapshot } from "../shared/model";

const at = (minutesAgo: number) => new Date(clock - minutesAgo * 60_000).toISOString();
const main = (patch: Partial<AgentFacts> = {}): AgentFacts => ({ agentId: "main-agent", role: "main", status: "running", turnStartedAt: at(6), ...patch });
const stated = { "main-agent": { now: "Capping the retry gap", done: ["Reading the gateway logs"], next: ["Shipping the fix", "Verifying in staging"], at: at(10) } };
const batch = (patch: Partial<Batch> = {}): Batch => ({ id: "b1", tasks: [{ key: "checks:example/app#1", kind: "checks", target: "example/app#1", title: "lint", fingerprint: "f" }], state: "sent", createdAt: at(1), sentAt: at(1), settledAt: null, messageId: "m1", attempts: 1, result: "", recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], ...patch });
const task = (patch: Partial<Obligation> = {}): Obligation => ({ id: "t1", title: "E2E for the 60 s window", status: "working", afterPrs: [], evidence: "", enable_follow_up: false, revision: 1, workingAgentId: "helper", ...patch });

test("the-line-takes-its-first-source: Follow-up's work this turn, then the stated work, then the task, the PR, the contributor title", () => {
  assert.deepEqual([...NOW_SOURCES], ["follow-up", "stated", "task", "pr", "title"]);
  // Every source present: each one wins exactly when the ones before it are absent.
  const all = workspace({ milestones: stated, batches: [batch()], obligations: [task({ workingAgentId: "main-agent" })], taskAgents: { "main-agent": { title: null, state: "working" } } });
  assert.equal(workOf(all, main())?.source, "follow-up");
  assert.equal(workOf({ ...all, batches: [] }, main())?.source, "stated");
  assert.equal(workOf({ ...all, batches: [], milestones: {} }, main())?.source, "task");
  assert.equal(workOf({ ...all, batches: [], milestones: {}, obligations: [] }, main())?.source, "pr");
  const helper: AgentFacts = { agentId: "helper", role: "contributor", status: "running", title: "Retry tests" };
  assert.equal(workOf(workspace({ prs: [] }), helper)?.source, "title");
  // The main agent's title is the workspace's: never its work line. Nothing known: no line, never a guess.
  assert.equal(workOf(workspace({ prs: [] }), main({ title: "Migration rollout" })), null);
});

test("the stated work carries its place only from the agent's own list", () => {
  const w = workspace({ milestones: stated });
  const n = nowOf(w, main(), clock);
  assert.equal(n.work?.text, "Capping the retry gap");
  assert.deepEqual(n.work?.position, { at: 2, of: 4 });
  assert.equal(nowText(n), "Capping the retry gap 2 of 4 · Working 6m");
  assert.equal(nowText(n, true), "Capping the retry gap 2 of 4 · working 6m");
  const alone = nowOf(workspace({ milestones: { "main-agent": { ...stated["main-agent"], done: [], next: [] } } }), main(), clock);
  assert.equal(alone.work?.position, null, "no list, no count");
  assert.equal(nowText(alone), "Capping the retry gap · Working 6m");
});

test("work Follow-up sent is the line, with nothing added; its state adds nothing", () => {
  const n = nowOf(workspace({ milestones: stated, batches: [batch()] }), main(), clock);
  assert.equal(n.work?.text, "Fixing CI on #1");
  assert.equal(n.work?.position, null);
  assert.equal(n.state.text, "Working 6m", "nothing added to the state either");
  // Settled, or the agent idle: the batch no longer speaks for the turn.
  assert.equal(workOf(workspace({ milestones: stated, batches: [batch({ settledAt: at(0) })] }), main())?.source, "stated");
  assert.equal(workOf(workspace({ milestones: stated, batches: [batch()] }), main({ status: "idle" }))?.source, "stated");
  // A batch for another agent isn't this one's.
  assert.equal(workOf(workspace({ batches: [batch({ recipientAgentId: "other" })], prs: [] }), main()), null);
  assert.equal(workOf(workspace({ batches: [batch({ tasks: [{ key: "c", kind: "completion", target: "workspace", title: "Done?", fingerprint: "f" }] })] }), main())?.text, "Checking the work is finished");
  assert.equal(workOf(workspace({ batches: [batch({ tasks: [{ key: "o", kind: "obligation", target: "t1", title: "Post the rollout note", fingerprint: "f" }] })] }), main())?.text, "Post the rollout note");
});

test("a task counts only while its agent is working; a PR only when it owns exactly one", () => {
  const helper: AgentFacts = { agentId: "helper", role: "contributor", status: "idle", title: "Retry tests" };
  assert.equal(workOf(workspace({ prs: [], obligations: [task()], taskAgents: { helper: { title: "Retry tests", state: "working" } } }), helper)?.text, "E2E for the 60 s window");
  assert.equal(workOf(workspace({ prs: [], obligations: [task()], taskAgents: { helper: { title: "Retry tests", state: "idle" } } }), helper)?.source, "title");
  const two = workspace({ prs: [pr(), pr({ key: "example/app#2", number: 2 })] });
  assert.equal(workOf(two, main()), null);
  assert.equal(workOf(workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] }), main()), null);
  assert.equal(workOf(workspace(), main())?.text, "example/app#1 · In review");
  // A PR a contributor registered is its own, not the main agent's.
  assert.equal(workOf(workspace({ prs: [pr({ registeredAgentId: "helper" })] }), main()), null);
});

test("the state line: a permission, an ask, compacting, working, a background job, CI, idle, closed", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ checksPending: true }) })] });
  assert.deepEqual(nowOf(w, main({ permission: "git push --force" }), clock).state, { kind: "permission", text: "Wants your OK · git push --force", since: null });
  const q = { id: "Q2", title: "Does #1 need a migration?", question: "?", options: [], recommend: null, big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: at(1), mode: "stop" as const, answer: null, closed: null };
  const asking = nowOf(workspace({ questions: [q] }), main({ status: "idle" }), clock);
  assert.equal(asking.state.text, 'Asking you: "Does #1 need a migration?"');
  assert.equal(asking.needs, "Answer Q2");
  assert.equal(nowOf(w, main({ compacting: true }), clock).state.text, "Compacting its context");
  assert.equal(nowOf(w, main({ turnStartedAt: at(0.5) }), clock).state.text, "Working <1m");
  assert.equal(nowOf(w, main({ status: "idle", backgroundWork: 1 }), clock).state.text, "Its background job is running");
  const ci = nowOf(w, main({ status: "idle" }), clock);
  assert.equal(ci.state.text, "Waiting on CI for #1");
  assert.equal(ci.waitingOn, "CI on #1");
  assert.equal(nowOf(workspace(), main({ status: "idle", lastActivityAt: at(12) }), clock).state.text, "Idle 12m");
  assert.equal(nowOf(workspace(), main({ status: "closed" }), clock).state.text, "Closed");
  // Unknown is not off: no made-up "Idle".
  assert.equal(nowOf(workspace({ prs: [] }), main({ status: "unknown" }), clock).state.text, "");
});

test("nothing known: the state is the whole line, with no label or placeholder", () => {
  const n = nowOf(workspace({ prs: [] }), main({ turnStartedAt: at(2) }), clock);
  assert.equal(n.work, null);
  assert.equal(nowText(n), "Working 2m");
});

test("the milestone field: short, at most eight before and after, null clears", () => {
  assert.equal(milestoneInputSchema.safeParse({ now: "Releasing the beta" }).success, true);
  assert.equal(milestoneInputSchema.safeParse(null).success, true);
  assert.equal(milestoneInputSchema.safeParse({ now: "x".repeat(81) }).success, false);
  assert.equal(milestoneInputSchema.safeParse({ now: "a", next: Array(9).fill("b") }).success, false);
  assert.equal(milestoneInputSchema.safeParse({ now: "" }).success, false);
  assert.equal(milestoneInputSchema.safeParse({ now: "a", index: 2 }).success, false, "no index for the agent to get wrong");
});

// The workspace repository comes from discovery, never from the PR being described.
test("the PR fallback names its repository only outside the workspace repository", () => {
  const p = pr({ number: 77, key: "example/app#77" });
  for (const [repo, ref] of [["example/app", "#77"], ["EXAMPLE/App", "#77"], ["acme/widgets", "example/app#77"], [null, "example/app#77"]] as const) {
    const w = { ...workspace({ prs: [p] }), repo };
    assert.equal(workOf(w, main())?.text, `${ref} · In review`);
    const listed = listEntry(w);
    if (isArchivedEntry(listed)) assert.fail("Expected the active workspace list entry");
    assert.deepEqual(workOf(listed, main()), workOf(w, main()), "Home list and panel detail agree");
  }
});

test("the PR fallback uses the PR row's words for every known stage", () => {
  const stages: [Partial<Snapshot>, string][] = [
    [{ conflict: true }, "Conflicts"],
    [{ threads: [{ id: "thread", updatedAt: at(1) }] }, "1 thread"],
    [{ failedChecks: ["lint"] }, "Checks failed"],
    [{ otherFailedChecks: ["preview"] }, "Optional check failed"],
    [{ draft: true }, "Draft"],
    [{ checksPending: true }, "Checking"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "Changes requested"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "In review"],
    [{ reviewDecision: "APPROVED" }, "Approved"],
  ];
  for (const [patch, label] of stages) {
    const w = { ...workspace({ prs: [pr({ snapshot: snapshot(patch) })] }), repo: "example/app" };
    assert.equal(workOf(w, main())?.text, `#1 · ${label}`, label);
  }
  const unknown = { ...workspace({ prs: [pr({ snapshot: snapshot({ complete: false }) })] }), repo: "example/app" };
  assert.equal(workOf(unknown, main())?.text, "Shipping #1");
  assert.equal(workOf({ ...unknown, repo: "acme/widgets" }, main())?.text, "Shipping example/app#1");
  const stale = { ...workspace({ prs: [pr({ error: "Read timed out", snapshot: snapshot({ checksPending: true }) })] }), repo: "example/app" };
  assert.equal(workOf(stale, main())?.text, "#1 · Checking", "a failed read keeps the last complete status");
});
