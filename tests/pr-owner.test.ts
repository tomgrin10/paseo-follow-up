import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_TONES, browserRepositories, browserWorkspaces, browserWorkspaceState, prClaims, prOwner } from "../server/pr-owner";
import { prWorkspacesRpc } from "../shared/contracts";
import { stateSchema, type Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

test("PR lookup selects the registering agent and compares repository identity without case", () => {
  const state = stateSchema.parse({ version: 1, workspaces: [workspace({ prs: [pr({ registeredAgentId: "registering-agent" })] })] });
  assert.deepEqual(prOwner(state, "Example/App", 1), { workspaceId: "workspace", agentId: "registering-agent" });
  assert.equal(prOwner(state, "other/app", 1), null);
  assert.equal(prOwner(state, "example/app", 2), null);
});
test("legacy registrations preserve their workspace owner; inactive and duplicate claims do not route", () => {
  const w = workspace();
  assert.deepEqual(prOwner({ version: 1, workspaces: [w] }, "example/app", 1), { workspaceId: "workspace", agentId: "main-agent" });
  for (const patch of [{ archived: true }, { enable_tracking: false }]) assert.equal(prOwner({ version: 1, workspaces: [{ ...w, ...patch }] }, "example/app", 1), null);
  assert.equal(prOwner({ version: 1, workspaces: [w, { ...w, id: "second" }] }, "example/app", 1), null);
});

test("browser discovery advertises bounded repository identities from active tracking only", () => {
  const state = stateSchema.parse({ version: 1, workspaces: [
    workspace({ prs: [pr({ repo: "Example/App" }), pr({ repo: "example/app" }), pr({ repo: "other/repo" })] }),
    workspace({ id: "archived", archived: true, prs: [pr({ repo: "private/archived" })] }),
    workspace({ id: "disabled", enable_tracking: false, prs: [pr({ repo: "private/disabled" })] }),
  ] });
  assert.deepEqual(browserRepositories(state), ["example/app", "other/repo"]);
  state.workspaces[0]!.prs = Array.from({ length: 110 }, (_, i) => pr({ repo: `example/repo-${i}` }));
  assert.equal(browserRepositories(state).length, 100);
});

const idle = { status: "idle", pendingPermissions: [] };
test("PR workspaces list every active claim, most urgent first, capped at three with a count of the rest", () => {
  const approved = pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) });
  const state = stateSchema.parse({ version: 1, workspaces: [
    workspace({ id: "quiet", title: "Quiet one", mainAgentId: "a-quiet" }),
    workspace({ id: "needs", title: "Merge me", mainAgentId: "a-needs", prs: [approved] }),
    workspace({ id: "other-pr", prs: [pr({ number: 2, key: "example/app#2" })] }),
    workspace({ id: "archived", archived: true }),
    workspace({ id: "untracked", enable_tracking: false }),
  ] });
  assert.deepEqual(prClaims(state, "Example/App", 1).map(w => w.id), ["quiet", "needs"]);
  const view = browserWorkspaces(prClaims(state, "example/app", 1).map(w => ({ workspace: w, agent: idle })), clock);
  assert.deepEqual(view.workspaces.map(w => [w.workspaceId, w.agentId, w.group, w.state, w.tone]), [
    ["needs", "a-needs", "needs", "Needs you · Merge ready", "success"],
    ["quiet", "a-quiet", "waiting", "Waiting on others · Waiting on review and merges", "muted"],
  ]);
  const many = Array.from({ length: 5 }, (_, i) => ({ workspace: workspace({ id: `w${i}` }), agent: idle }));
  assert.deepEqual([browserWorkspaces(many, clock).workspaces.length, browserWorkspaces(many, clock).more], [3, 2]);
});

test("a claim whose main agent is closed stays, as needs-you Agent closed, ahead of a quiet one", () => {
  const view = browserWorkspaces([{ workspace: workspace({ id: "open" }), agent: idle }, { workspace: workspace({ id: "closed", mainAgentId: "gone" }), agent: null }], clock);
  assert.deepEqual(view.workspaces.map(w => [w.workspaceId, w.agentId, w.agentStatus, w.group, w.state, w.tone]), [
    ["closed", "gone", "closed", "needs", "Needs you · Agent closed", "attention"],
    ["open", "main-agent", "idle", "waiting", "Waiting on others · Waiting on review and merges", "muted"],
  ]);
  // Done work with its agent closed has nothing left to do.
  const done = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } as never });
  assert.deepEqual(browserWorkspaceState(done, null, clock), { group: "quiet", state: "Done · ready to archive", tone: "success" });
  // The contract carries the closed row and its tone.
  assert.doesNotThrow(() => prWorkspacesRpc.output.parse({ tracked: true, more: 0, workspaces: view.workspaces }));
});

test("every row carries the tone Home paints it with, so the browser never parses the English", () => {
  const w = workspace();
  const view = (patch: Partial<Workspace>, agent: object = idle) => { const v = browserWorkspaceState({ ...w, ...patch }, { ...idle, ...agent }, clock); return [v.state, v.tone]; };
  assert.deepEqual(view({}), ["Waiting on others · Waiting on review and merges", "muted"]);
  assert.deepEqual(view({}, { status: "running" }), ["Working", "accent"]);
  assert.deepEqual(view({}, { pendingPermissions: [{}] }), ["Needs you · Permission", "attention"]);
  assert.deepEqual(view({}, { status: "error" }), ["Needs you · Error", "danger"]);
  assert.deepEqual(view({}, { requiresAttention: true, attentionReason: "finished" }), ["Needs you · Finished", "accent"]);
  assert.deepEqual(view({ prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })] }), ["Needs you · Merge ready", "success"]);
  const threads = pr({ snapshot: snapshot({ threads: [{ id: "t1", updatedAt: "x" }] }) });
  const batch = { id: "b1", state: "sent", tasks: [{ id: "t", title: "Fix threads" }], attempts: 1, createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString() };
  assert.deepEqual(view({ prs: [threads], batches: [batch as never] }), ["Sending · 1 thread", "accent"]);
  assert.deepEqual(view({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } as never }), ["Done · ready to archive", "success"]);
  // The contract's enum is the server's list; an older extension ignores the field.
  assert.deepEqual(prWorkspacesRpc.output.shape.workspaces.element.shape.tone.options, [...BROWSER_TONES]);
});

test("the one-line state follows Follow-up's groups and the main agent's live attention", () => {
  const w = workspace();
  const state = (patch: Partial<Workspace>, agent: object = idle) => browserWorkspaceState({ ...w, ...patch }, { ...idle, ...agent }, clock).state;
  assert.equal(state({}), "Waiting on others · Waiting on review and merges");
  assert.equal(state({}, { status: "running" }), "Working");
  assert.equal(state({}, { pendingPermissions: [{}] }), "Needs you · Permission");
  assert.equal(state({}, { status: "error" }), "Needs you · Error");
  assert.equal(state({}, { requiresAttention: true, attentionReason: "finished" }), "Needs you · Finished");
  // 2026-11-10: Paseo's attention reason outlives the failed turn; a running agent reads Working, a stopped one Error.
  assert.equal(state({}, { status: "running", requiresAttention: true, attentionReason: "error" }), "Working");
  assert.equal(state({}, { requiresAttention: true, attentionReason: "error" }), "Needs you · Error");
  const threads = pr({ snapshot: snapshot({ threads: [{ id: "t1", updatedAt: "x" }, { id: "t2", updatedAt: "x" }, { id: "t3", updatedAt: "x" }] }) });
  const batch = { id: "b1", state: "sent", tasks: [{ id: "t", title: "Fix threads" }], attempts: 1, createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString() };
  assert.equal(state({ prs: [threads], batches: [batch as never] }), "Sending · 3 threads");
  assert.equal(state({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } as never }), "Done · ready to archive");
});
