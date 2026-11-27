// Every list-returning agent tool answers within TOOL_BUDGET, however much history a workspace has (invariant
// pr-scale-lists-batch-not-throw, "every list pages"). 2026-11-26: in a busy workspace workspace_status detail=summary
// was ~207k characters, 98% of it 357 PRs (almost all merged), so an agent couldn't read its own status: the tool
// result went over the token limit and landed in a file. Active items stay whole; finished ones are a count plus the
// newest few, and offset/limit pages the rest (PAGE.toolPage a page by default). Synthetic data only (example/app).
import test from "node:test";
import assert from "node:assert/strict";
import { PAGE, TOOL_BUDGET } from "../shared/paged";
import { agentView } from "../shared/history";
import { compact } from "../server/mcp.mjs";
import { AgentActions } from "../server/agent-actions";
import type { InboxRow } from "../shared/inbox";
import { completionGate, settled, workspaceSchema, type Obligation, type State, type Workspace } from "../shared/model";
import { agentStatusRpc } from "../shared/contracts";
import { finishedPr, finishedTask, finishedQuestion, finishedBatch, finishedPrAction } from "../shared/finished";
import { bigHistory, closedHistory } from "./support/big-history";
import { clock, pr, snapshot } from "./fixtures";

const iso = (m: number) => new Date(clock + m * 60_000).toISOString();
const size = (value: unknown) => JSON.stringify(value).length;

/** The developer's busy workspace, 2026-11-26 shape: 360 PRs (350 merged), 200 tasks, 175 questions, 400 batches. */
function busy(): Workspace {
  const prs = Array.from({ length: 360 }, (_, i) => {
    const merged = i < 350, number = 1000 + i;
    return pr({ key: `example/app#${number}`, number, stack: `Rollout ${Math.floor(i / 6)}`, parent: i % 6 ? `example/app#${number - 1}` : null, disposition: merged ? "merged" : null,
      snapshot: snapshot({ title: `Move the invoice retries for step ${i} onto the shared queue`, url: `https://github.com/example/app/pull/${number}`, state: merged ? "MERGED" : "OPEN", head: `head-${number}`, headBranch: `step-${number}`, reviewDecision: "APPROVED", mergedAt: merged ? iso(i) : null }) });
  });
  const obligations: Obligation[] = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, title: `Verify the invoice retry step ${i} in production`, status: i < 190 ? "done" : "pending",
    afterPrs: [`example/app#${1000 + (i % 360)}`], evidence: "Checked the dashboards and the retry log; no failures in the last day. ".repeat(4), enable_follow_up: true, revision: 2, ...(i < 190 ? { finishedAt: iso(i) } : {}) }));
  return { ...bigHistory({ questions: 175, batches: 400, open: 3 }), prs, obligations };
}

/** workspace_status as the agent gets it: the handler's view, then the summary (compact) or the whole view (full). */
const status = (w: Workspace, input: Record<string, unknown> = {}) => {
  const view = agentView(w, { kind: input.history as never, offset: input.offset as number | undefined, limit: input.limit as number | undefined });
  return input.detail === "full" ? view : compact("workspace_status", input, view);
};

test("workspace_status summary and full stay under TOOL_BUDGET in the busiest workspace, active work whole", () => {
  const w = busy();
  const before = size(compact("workspace_status", {}, w));
  assert.ok(before > 3 * TOOL_BUDGET, `the unbounded summary was ${before} characters`);
  const summary = status(w) as any, full = status(w, { detail: "full" }) as any;
  assert.ok(size(summary) < TOOL_BUDGET, `summary: ${size(summary)} characters`);
  assert.ok(size(full) < TOOL_BUDGET, `full: ${size(full)} characters`);
  assert.equal(summary.prs.filter((p: any) => p.state === "OPEN").length, 10, "every open PR");
  assert.deepEqual(summary.prs.filter((p: any) => p.state === "MERGED").map((p: any) => p.key), ["example/app#1345", "example/app#1346", "example/app#1347", "example/app#1348", "example/app#1349"], "the newest merged, in stack order");
  assert.equal(summary.obligations.length, 10, "every open task");
  assert.equal(summary.completedObligations, 190);
  assert.equal(summary.openQuestions.length, 3, "every open question");
  assert.deepEqual(summary.history.prs, { total: 350, offset: 0, shown: PAGE.recentDone, more: 345, hint: "workspace_status history=prs offset/limit pages these (newest first)" });
  assert.equal(summary.history.batches.total, 400);
  assert.equal(full.batches.length, PAGE.recentDone, "full: settled batches are the newest few too");
});

test("workspace_status history=<kind> pages every finished item, newest first, each page under TOOL_BUDGET", () => {
  const w = busy();
  for (const [kind, total, key] of [["prs", 350, "prs"], ["tasks", 190, "obligations"], ["questions", 172, "questions"], ["batches", 400, "batches"]] as const) {
    const seen: string[] = [];
    for (let offset = 0; ; offset += PAGE.toolPage) {
      const page = status(w, { detail: "full", history: kind, offset }) as any;
      assert.ok(size(page) < TOOL_BUDGET, `${kind} at ${offset}: ${size(page)} characters`);
      assert.equal(page.history[kind].offset, offset);
      const doneIds = page[key].map((x: any) => x.key ?? x.id).filter((id: string) => !seen.includes(id));
      seen.push(...doneIds);
      if (!page.history[kind].more) break;
    }
    assert.ok(seen.length >= total, `${kind}: walked ${seen.length} of ${total}`);
  }
  const second = status(w, { history: "prs", offset: 5, limit: 3 }) as any;
  assert.deepEqual(second.prs.filter((p: any) => p.state === "MERGED").map((p: any) => p.key), ["example/app#1342", "example/app#1343", "example/app#1344"]);
});

function agent(state: State, o: { rows?: InboxRow[]; rpc?: Record<string, unknown> } = {}) {
  return new AgentActions({ store: { snapshot: async () => state, mutate: async (fn: (s: State) => unknown) => fn(state) }, prActions: {} as never, engine: {} as never,
    inbox: { list: async () => ({ enabled: true, rows: o.rows ?? [] }), act: async () => ({ results: [] }), noteAction: async () => {} },
    rpc: { call: async (method: string) => o.rpc?.[method], validate: async (_m: string, input: unknown) => input }, now: () => clock } as never);
}

test("list_prs include_closed: open PRs whole, merged ones the newest few and a count, offset/limit pages them", async () => {
  const state: State = { version: 1, workspaces: [busy()] } as State;
  const a = agent(state);
  const open = await a.run("orchestrator", "list_prs", {}) as any;
  assert.equal(open.prs.length, 10);
  assert.equal(open.closed, undefined, "without include_closed nothing finished is mentioned");
  const all = await a.run("orchestrator", "list_prs", { include_closed: true }) as any;
  assert.ok(size(all) < TOOL_BUDGET, `list_prs include_closed: ${size(all)} characters`);
  assert.equal(all.prs.length, 10 + PAGE.recentDone);
  assert.deepEqual({ total: all.closed.total, more: all.closed.more }, { total: 350, more: 345 });
  const page = await a.run("orchestrator", "list_prs", { include_closed: true, offset: 340, limit: 100 }) as any;
  assert.equal(page.prs.length, 10 + 10);
  assert.equal(page.closed.more, 0);
  await assert.rejects(a.run("orchestrator", "list_prs", { include_closed: true, limit: PAGE.maxLimit + 1 }));
});

test("inbox_list: flagged, running and your own rows whole; quiet rows the newest few and a count", async () => {
  const needs = { reasons: [{ kind: "decision", text: "Pick the retry policy" }], seq: 1, at: iso(0) };
  const rows = Array.from({ length: 300 }, (_, i) => ({ agentId: `a${i}`, workspaceId: null, title: `Agent ${i} on the invoice retries`, workspaceTitle: `Invoice retries ${i}`, multiRoot: false,
    status: i < 5 ? "running" : "idle", delegatedFrom: null, resumesAt: null, lastActivityAt: iso(i), needs: i >= 5 && i < 10 ? needs : null, snooze: null, signedOffAt: null, undoable: false, enable_finish_flags: true } as unknown as InboxRow));
  const a = agent({ version: 1, workspaces: [] } as State, { rows });
  const out = await a.run("a299", "inbox_list", {}) as any;
  assert.ok(size(out) < TOOL_BUDGET, `inbox_list: ${size(out)} characters`);
  assert.equal(out.rows.filter((r: any) => r.flagged).length, 5);
  assert.ok(out.rows.some((r: any) => r.self), "your own row is always there");
  assert.equal(out.quiet.total, 289);
  const page = await a.run("a299", "inbox_list", { offset: 280, limit: 50 }) as any;
  assert.equal(page.quiet.shown, 9);
});

test("context_requests and release_notes: open or new in full, settled or older the newest few and a count", async () => {
  const requests = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, workspaceId: "workspace", agentId: "main-agent", cardKey: `q:Q${i}`, card: `Q${i}: Which retry policy?`, target: "agent",
    ask: "What does each option cost us at peak load? ".repeat(10), askedOf: "main-agent", state: i < 48 ? "answered" : "asking", answer: i < 48 ? "Retrying costs one extra call per timeout. ".repeat(95) : null,
    error: null, askedAt: iso(i), settledAt: i < 48 ? iso(i + 1) : null, deliveredAt: iso(i), by: "developer" }));
  const notes = Array.from({ length: 120 }, (_, i) => ({ version: `2.${119 - i}.0`, date: "2026-11-01", sections: [{ title: "Changed", items: ["Home and the panel read the workspace's PRs a page at a time. ".repeat(8)] }] }));
  const a = agent({ version: 1, workspaces: [] } as State, { rpc: { "follow.context-list": { requests }, "follow.release-notes": { version: "2.119.0", previous: "2.117.0", notes } } });
  assert.ok(size({ requests }) > 4 * TOOL_BUDGET && size({ notes }) > TOOL_BUDGET, "both were over the budget unbounded");
  const ctx = await a.run("orchestrator", "context_requests", {}) as any;
  assert.ok(size(ctx) < TOOL_BUDGET, `context_requests: ${size(ctx)} characters`);
  assert.equal(ctx.requests.filter((r: any) => r.state === "asking").length, 2);
  assert.deepEqual({ total: ctx.settled.total, shown: ctx.settled.shown }, { total: 48, shown: PAGE.recentDone });
  const rel = await a.run("orchestrator", "release_notes", {}) as any;
  assert.ok(size(rel) < TOOL_BUDGET, `release_notes: ${size(rel)} characters`);
  assert.deepEqual(rel.notes.slice(0, 2).map((n: any) => n.version), ["2.119.0", "2.118.0"], "the notes since previous, whole");
  assert.equal(rel.older.total, 118);
  const older = await a.run("orchestrator", "release_notes", { offset: 100, limit: 50 }) as any;
  assert.equal(older.older.shown, 18);
  const plan = await a.run("orchestrator", "ask_context", { cardKey: "q:Q1", ask: "Why?" }).catch(() => null) as any;
  if (plan?.before) assert.ok(size(plan.before) < TOOL_BUDGET, "a dry run's before is bounded like the read");
});

// 2026-11-26, CI scale-live: the live-sized seed's big workspace (153 PRs, 39 tasks, 300 questions with 13 open, 400
// batches; scripts/scale-seed.ts) read 52,642 bytes from follow.agent-status, over TOOL_BUDGET, summary and full alike:
// five whole merged PRs, settled questions with every option, and the inventory's every PR key. The finished glance comes
// brief now, and the reply with what the handler adds beside it is fitted to the budget.
test("workspace_status at the scale seed's size fits the budget with what the handler adds, and a 100-row page does too", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "scale-seed-"));
  try {
    await writeFile(join(dir, "created.json"), JSON.stringify([{ workspaceId: "ws-big", agentId: "agent-big" }, { workspaceId: "ws-2", agentId: "agent-2" }]));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/scale-seed.ts", join(dir, "state.json"), join(dir, "created.json"), "3", "0", join(dir, "inbox.json"), "--live-sized"], { stdio: "ignore" });
    const w = JSON.parse(await readFile(join(dir, "state.json"), "utf8")).workspaces[0];
    assert.ok(JSON.stringify(w).length > 10 * TOOL_BUDGET, `the seeded workspace is busy (${JSON.stringify(w).length})`);
    // What follow.agent-status adds beside the workspace (dismissed items, the next message, the PR workflow): as much as CI saw.
    const extra = { nextMessageInfo: { to: "agent-big", tasks: ["checks:example/app#1"], text: "x".repeat(6_000), reason: "Waiting for the turn to end.", eta: null } };
    const view = agentView(w, {}, extra) as any;
    assert.ok(JSON.stringify(view).length <= TOOL_BUDGET, `summary: ${JSON.stringify(view).length} characters`);
    const open = w.questions.filter((q: any) => !q.answer && !q.closed).map((q: any) => q.id);
    assert.ok(open.length >= 10 && open.every((id: string) => view.questions.some((q: any) => q.id === id && q.options)), "every open question whole, options and all");
    assert.ok(view.prs.filter((p: any) => p.snapshot?.state === "OPEN").length >= 3, "the open PRs come");
    const merged = view.prs.find((p: any) => p.snapshot?.state === "MERGED");
    assert.ok(merged && !("reviewers" in merged.snapshot) && merged.snapshot.title, "a merged PR at a glance: title and state, not its review evidence");
    assert.ok(view.inventory.candidates.length < 10 && view.inventory.candidatesTotal === 153, "the inventory's keys: the live ones and a count");
    assert.equal(view.history.prs.total, 150);
    const page = agentView(w, { kind: "prs", offset: 0, limit: 100 }, extra) as any;
    assert.ok(JSON.stringify(page).length <= TOOL_BUDGET, `a 100-row page: ${JSON.stringify(page).length} characters`);
    assert.ok(page.history.prs.shown >= 1 && page.history.prs.more === 150 - page.history.prs.shown, "it shrinks to fit and says how many are left");
    assert.ok(page.prs.some((p: any) => p.snapshot?.state === "MERGED" && "reviewers" in p.snapshot), "a history page carries its PRs whole");
    // CI 2026-11-26: the glance dropped fields the contract required, so the handler threw (handler_error). The reply,
    // summary and every history page, validates with follow.agent-status's own response schema.
    const { agentStatusRpc } = await import("../shared/contracts");
    const { HISTORY_KINDS } = await import("../shared/paged");
    for (const [label, v] of [["summary", view], ...HISTORY_KINDS.map(k => [`history=${k}`, agentView(w, { kind: k }, extra)] as const), ["history=batches limit 100", agentView(w, { kind: "batches", limit: 100 }, extra)]] as const) {
      const r = agentStatusRpc.output.safeParse(v);
      assert.ok(r.success, `${label} fails the response schema: ${r.success ? "" : r.error.issues.slice(0, 4).map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    assert.ok(view.prs.some((p: any) => p.glance) && view.questions.some((q: any) => q.glance) && view.batches.some((b: any) => b.glance), "the summary's finished items are glances, marked");
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("closed unanswered questions and closed PRs cannot crowd out any kind of recent history", () => {
  const w = workspaceSchema.parse(closedHistory());
  const view = agentView(w);
  assert.ok(agentStatusRpc.output.safeParse(view).success, "the closed glances satisfy the RPC schema");
  for (const kind of ["prs", "tasks", "questions", "batches", "prActions"] as const) {
    assert.equal(view.history[kind].shown, PAGE.recentDone, `${kind}: the recent glance survives`);
    assert.equal(view.history[kind].total, kind === "questions" ? 175 : kind === "batches" ? 100 : 60);
  }
  assert.ok(size(view) <= TOOL_BUDGET, `${size(view)} characters`);
  assert.equal(view.questions.length, PAGE.recentDone, "closed questions, even referenced ones, are never live");
  const page = agentView(w, { kind: "tasks", limit: 5 });
  assert.equal(page.history.tasks.shown, 5, "a task history page does not shrink because of closed questions");
  assert.ok(size(page) <= TOOL_BUDGET);
});


test("finished lifecycle preserves every pending answer and live dependency, but closed always wins", () => {
  const q = bigHistory({ questions: 1, open: 0 }).questions[0];
  for (const state of ["copied", "in-chat", "queued", "sending", "retrying", "failed", "cancelled", "unconfirmed"] as const) {
    assert.equal(finishedQuestion({ ...q, answer: { ...q.answer!, delivery: { ...q.answer!.delivery, state } } }), false, state);
  }
  assert.equal(finishedQuestion({ ...q, answer: null }), false, "open question");
  assert.equal(finishedQuestion(q), true, "sent answer");
  assert.equal(finishedQuestion(q, new Set([q.id])), false, "a live task still reads its delivered answer");
  assert.equal(finishedQuestion({ ...q, answer: null, closed: { at: iso(1), reason: "No longer needed", by: null } }, new Set([q.id])), true);
  assert.equal(finishedQuestion({ ...q, answer: { ...q.answer!, delivery: { ...q.answer!.delivery, state: "signed-off" } } }), true);
  for (const state of ["completed", "cancelled"]) assert.equal(finishedBatch({ state, settledAt: null }), true, "terminal without a settlement timestamp");
  for (const state of ["blocked", "uncertain", "sent"]) assert.equal(finishedBatch({ state, settledAt: null, movedOn: { why: "gone" } }), true, "superseded work is history");
  for (const state of ["completed", "blocked", "cancelled"]) {
    assert.equal(finishedBatch({ state, settledAt: iso(1) }), true);
    if (state === "blocked") assert.equal(finishedBatch({ state, settledAt: null }), false, "a blocked batch without settlement still needs action");
  }
  for (const state of ["pending", "sending", "sent", "uncertain"]) assert.equal(finishedBatch({ state, settledAt: null }), false);
  for (const state of ["submitted", "failed", "uncertain"]) assert.equal(finishedPrAction({ state }), true);
  assert.equal(finishedPrAction({ state: "sending" }), false);
  for (const status of ["done", "waived"]) assert.equal(finishedTask({ status }), true);
  for (const status of ["pending", "waiting", "working", "blocked"]) assert.equal(finishedTask({ status }), false);
});

test("closed PR history agrees with list_prs while completion still requires its disposition", async () => {
  const w = workspaceSchema.parse(closedHistory());
  const p = w.prs.find(p => p.snapshot?.state === "CLOSED")!;
  assert.equal(finishedPr(p), true);
  assert.equal(settled(p), false, "closed without a disposition is not completed work");
  assert.equal(finishedPr({ snapshot: null }), false, "an unknown PR is live");
  assert.equal(finishedPr(pr()), false, "an open PR is live");
  assert.ok(completionGate(w, clock).blockers.some(b => b.text === `Settle ${p.repo}#${p.number} with a disposition`));
  const a = agent({ version: 1, workspaces: [w] } as State);
  const out = await a.run("orchestrator", "list_prs", { include_closed: true }) as any;
  assert.equal(out.closed.total, w.prs.length);
  assert.equal(out.closed.shown, PAGE.recentDone);
});
