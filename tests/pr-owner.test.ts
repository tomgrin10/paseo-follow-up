import test from "node:test";
import assert from "node:assert/strict";
import { browserRepositories, browserWorkspaces, browserWorkspaceState, prClaims, prOwner } from "../server/pr-owner";
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
  assert.deepEqual(view.workspaces.map(w => [w.workspaceId, w.agentId, w.group, w.state]), [
    ["needs", "a-needs", "needs", "Needs you · Merge ready"],
    ["quiet", "a-quiet", "waiting", "Waiting on others · Waiting on review and merges"],
  ]);
  const many = Array.from({ length: 5 }, (_, i) => ({ workspace: workspace({ id: `w${i}` }), agent: idle }));
  assert.deepEqual([browserWorkspaces(many, clock).workspaces.length, browserWorkspaces(many, clock).more], [3, 2]);
});

test("PR workspaces drop claims whose main agent is gone", () => {
  assert.deepEqual(browserWorkspaces([{ workspace: workspace(), agent: null }], clock), { workspaces: [], more: 0 });
});

test("the one-line state follows Follow-up's groups and the main agent's live attention", () => {
  const w = workspace();
  const state = (patch: Partial<Workspace>, agent: object = idle) => browserWorkspaceState({ ...w, ...patch }, { ...idle, ...agent }, clock).state;
  assert.equal(state({}), "Waiting on others · Waiting on review and merges");
  assert.equal(state({}, { status: "running" }), "Running");
  assert.equal(state({}, { pendingPermissions: [{}] }), "Needs you · Permission");
  assert.equal(state({}, { status: "error" }), "Needs you · Error");
  assert.equal(state({}, { requiresAttention: true, attentionReason: "finished" }), "Needs you · Finished");
  const threads = pr({ snapshot: snapshot({ threads: [{ id: "t1", updatedAt: "x" }, { id: "t2", updatedAt: "x" }, { id: "t3", updatedAt: "x" }] }) });
  const batch = { id: "b1", state: "sent", tasks: [{ id: "t", title: "Fix threads" }], attempts: 1, createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString() };
  assert.equal(state({ prs: [threads], batches: [batch as never] }), "Follow-up is fixing · 3 threads");
  assert.equal(state({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], completion: { summary: "Shipped", declaredAt: new Date(clock).toISOString() } as never }), "Done · ready to archive");
});
