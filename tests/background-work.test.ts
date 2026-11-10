import test from "node:test";
import assert from "node:assert/strict";
import { backgroundCount, isLive, isLoaded, liveStatus } from "../shared/agent-load";
import { daemonDirectory } from "../server/inbox-directory";
import { checkMainClaim, type MainAgentInfo } from "../server/discovery";
import { browserWorkspaceState } from "../server/pr-owner";
import { reduce, newEntry, liveFlag } from "../shared/inbox";
import { rowViolations } from "../shared/status-invariants";
import { clock, workspace } from "./fixtures";

// Paseo 0.16: an agent that started a shell or task and ended its turn reports backgroundWork.count > 0. For Follow-up
// that agent is still running: no repairs into it, no Done, no "finished" on Home or the browser line (0.16 plan §1 #1).

test("backgroundCount/isLive/liveStatus: positive counts only; absent (0.15) and garbage read as no work", () => {
  for (const bad of [undefined, null, {}, { count: 0 }, { count: -1 }, { count: "2" }, { count: Number.NaN }]) {
    const a = { status: "idle", backgroundWork: bad as never };
    assert.equal(backgroundCount(a), 0); assert.equal(isLive(a), false); assert.equal(liveStatus(a), "idle");
  }
  const working = { status: "idle", activeTurn: null, backgroundWork: { count: 2 } };
  assert.equal(backgroundCount(working), 2); assert.equal(isLive(working), true); assert.equal(liveStatus(working), "running");
  assert.equal(isLoaded({ status: "idle", backgroundWork: { count: 1 } }), true, "live work means a loaded runtime");
  assert.equal(liveStatus({ status: "error", backgroundWork: { count: 1 } }), "running");
  assert.equal(liveStatus({ status: "closed" }), "closed");
});

test("the inbox's directory reads an idle agent with live background work as running, with its count", async () => {
  const agent = { id: "a1", workspaceId: "w1", status: "idle", activeTurn: null, labels: {}, pendingPermissions: [], lastUserMessageAt: null, createdAt: "x", provider: "claude", cwd: "/x", backgroundWork: { count: 1 } };
  const shared = { read: async () => ({ agents: [{ agent }], workspaces: [{ id: "w1", name: "W" }], projects: [] }), cached: () => agent, live: async () => agent };
  const [info] = await daemonDirectory(shared as never).agents();
  assert.equal(info.status, "running"); assert.equal(info.backgroundWork, 1);
  agent.backgroundWork = { count: 0 };
  const [after] = await daemonDirectory(shared as never).agents();
  assert.equal(after.status, "idle"); assert.equal(after.backgroundWork, undefined, "0.15 rows stay as they were");
});

test("a row with live background work never reads finished; its other news still shows (invariant background-work-is-running)", () => {
  const iso = (m: number) => new Date(clock + m * 60_000).toISOString();
  const finished = reduce(newEntry("a1"), { type: "turn_end", outcome: "completed", detail: "Done" }, iso(0));
  const withCi = reduce(finished, { type: "ci", dedupeKey: "ci:1", detail: "Checks failing" }, iso(1));
  for (const e of [finished, withCi]) {
    const shown = liveFlag("running", e.needs, null, null, true);
    assert.ok(!shown.needs?.reasons.some(r => r.reason === "finished"));
    assert.deepEqual(rowViolations({ agentId: "a1", status: "running", snooze: null, brief: null, backgroundWork: 1, needs: shown.needs }, clock), []);
  }
  assert.equal(liveFlag("running", withCi.needs, null, null, true).needs?.reasons[0]?.reason, "ci", "an outside fact stays");
  // Unfiltered, the same row is the bug the invariant names; so is a background job on a row that reads idle.
  assert.equal(rowViolations({ agentId: "a1", status: "running", snooze: null, brief: null, backgroundWork: 1, needs: finished.needs }, clock)[0]?.id, "background-work-is-running");
  assert.equal(rowViolations({ agentId: "a1", status: "idle", snooze: null, brief: null, backgroundWork: 1, needs: null }, clock)[0]?.id, "background-work-is-running");
});

test("Make main agent waits while the main agent's background work runs", () => {
  const w = workspace({ mainAgentId: "main", contributorAgentIds: ["helper"] });
  const idle: MainAgentInfo = { status: "idle", activeTurn: null, pendingPermissions: [] };
  assert.deepEqual(checkMainClaim(w, "helper", "developer", idle, clock).blockers, []);
  assert.match(checkMainClaim(w, "helper", "developer", { ...idle, backgroundWork: { count: 1 } }, clock).blockers.join(), /background work running/);
});

test("the browser line reads Running, not Finished, while background work runs", () => {
  const idle = { status: "idle", pendingPermissions: [], requiresAttention: true, attentionReason: "finished" };
  assert.equal(browserWorkspaceState(workspace(), idle, clock).state, "Needs you · Finished");
  assert.equal(browserWorkspaceState(workspace(), { ...idle, backgroundWork: { count: 1 } }, clock).state, "Running");
});
