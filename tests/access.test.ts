import test from "node:test";
import assert from "node:assert/strict";
import { agentWorkspace, ownedWorkspace } from "../server/engine";
import { stateSchema } from "../shared/model";
import { workspace } from "./fixtures";

test("recorded main-agent reads remain available when tracking is inactive", () => {
  const w = workspace({ enable_tracking: false, runtimeBusy: true });
  const state = { version: 1 as const, workspaces: [w] };
  assert.equal(agentWorkspace(state, "main-agent", "read", w.id), w);
  assert.throws(() => agentWorkspace(state, "main-agent", "write", w.id), error => {
    assert.match((error as Error).message, /Tracking is inactive/);
    assert.match((error as Error).message, /expected main agent main-agent, received agent main-agent/);
    return true;
  });
  assert.throws(() => ownedWorkspace(state, "main-agent", w.id), /Tracking is inactive/);
  assert.equal(w.enable_tracking, false);
});

test("read and write rejections identify the actual workspace owner and caller", () => {
  const w = workspace({ runtimeBusy: true });
  const state = { version: 1 as const, workspaces: [w, workspace({ id: "other", mainAgentId: "other-main" })] };
  for (const access of ["read", "write"] as const) {
    assert.throws(() => agentWorkspace(state, "secondary", access, w.id), error => {
      assert.match((error as Error).message, new RegExp(`Cannot ${access}`));
      assert.match((error as Error).message, /expected main agent main-agent, received agent secondary/);
      return true;
    });
    assert.equal(agentWorkspace(state, "main-agent", access, w.id), w);
  }
  assert.throws(() => agentWorkspace(state, "main-agent", "read", "other"), /expected main agent other-main, received agent main-agent/);
});

test("legacy flag migration preserves ownership and readable history without activating tracking", () => {
  const legacy: any = workspace(); delete legacy.enable_tracking; delete legacy.enable_auto_sends;
  legacy.enable_auto_follow_up = true;
  const state = stateSchema.parse({ version: 1, workspaces: [legacy] });
  const read = agentWorkspace(state, "main-agent", "read", "workspace");
  assert.equal(read.mainAgentId, legacy.mainAgentId); assert.deepEqual(read.prs, legacy.prs);
  assert.equal(read.enable_tracking, false); assert.equal(read.enable_auto_sends, false);
  assert.throws(() => agentWorkspace(state, "main-agent", "write", "workspace"), /Tracking is inactive/);
});
