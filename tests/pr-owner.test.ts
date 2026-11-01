import test from "node:test";
import assert from "node:assert/strict";
import { prOwner } from "../server/pr-owner";
import { stateSchema } from "../shared/model";
import { pr, workspace } from "./fixtures";

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
