import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CLOSED_HANDOVER_MS, PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { applyDiscovery, interruptionHold, markMainWork } from "../server/discovery";
import { controlWorkspace } from "../server/agent-actions";
import { SessionGuard } from "../server/session-guard";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// The live bug (2026-11-09): the orchestrator's Claude session read "closed" for a moment (plugin updates reopen
// sessions; the process restarts between turns), discovery handed the workspace to an idle helper Tom had written
// to last, and nothing handed it back, so the orchestrator's needs_you and questions were refused.
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "follow-handover-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = clock; t.mock.method(Date, "now", () => now);
  const base = { workspaceId: "workspace", provider: "claude", cwd: "/fixture", labels: {}, pendingPermissions: [] };
  const orchestrator = { ...base, id: "orchestrator", createdAt: "2026-11-01T00:00:00Z", status: "idle", activeTurn: null, lastUserMessageAt: "2026-11-09T10:00:00Z" } as Agent;
  const helper = { ...base, id: "helper", createdAt: "2026-11-09T17:47:00Z", status: "idle", activeTurn: null, lastUserMessageAt: "2026-11-09T21:20:00Z" } as Agent;
  const agents = [orchestrator, helper];
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { ...agent } })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "workspace", name: "Orchestration", projectId: "project" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/repo", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) }),
    fetchAgentTimeline: async () => ({ entries: [], startCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false }),
    listProviderSubagents: async () => ({ subagents: [] }),
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon, new SessionGuard(directory, () => now), async () => false);
  const state: State = { version: 1, workspaces: [workspace({ mainAgentId: "orchestrator", prs: [] })] };
  const w = () => state.workspaces[0];
  /** One discovery poll `ms` after the last, with the agent list re-read. */
  const poll = async (ms = 60_000) => { now += ms; gateway.directory.markDirty(); applyDiscovery(state, await gateway.discover(state), now); };
  const close = (a: Agent) => { a.status = "closed"; delete (a as { activeTurn?: unknown }).activeTurn; };
  const reopen = (a: Agent) => { a.status = "idle"; (a as { activeTurn?: unknown }).activeTurn = null; };
  return { state, w, poll, close, reopen, orchestrator, helper, advance: (ms: number) => { now += ms; } };
}

test("a main agent that closes and reopens keeps its workspace, even when another root agent is live", async t => {
  const f = await fixture(t);
  await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator");
  f.close(f.orchestrator);
  await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator", "a fresh close doesn't hand over");
  assert.ok(f.w().mainClosedSince, "the close is timed");
  for (let i = 0; i < 28; i++) await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator", "29 minutes closed: still the main agent");
  f.reopen(f.orchestrator);
  await f.poll();
  assert.equal(f.w().mainClosedSince, undefined, "a reopen resets the clock");
  f.close(f.orchestrator);
  for (let i = 0; i < 20; i++) await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator", "a second short close starts from zero");
  assert.deepEqual(f.w().contributorAgentIds, ["helper"]);
  assert.equal(f.w().handover, undefined);
});

test("closed for 30 minutes hands over; the original takes it back once live, unless the successor did main-agent work", async t => {
  const f = await fixture(t);
  await f.poll();
  f.close(f.orchestrator);
  await f.poll();
  await f.poll(MAIN_CLOSED_HANDOVER_MS);
  assert.equal(f.w().mainAgentId, "helper", "closed continuously for 30 minutes: the live root takes over");
  assert.equal(f.w().handover?.from, "orchestrator");
  assert.equal(f.w().handover?.worked, false);
  assert.deepEqual(f.w().contributorAgentIds, ["orchestrator"]);

  f.reopen(f.orchestrator);
  await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator", "an unused handover goes back");
  assert.equal(f.w().handover, undefined);
  assert.deepEqual(f.w().contributorAgentIds, ["helper"]);

  f.close(f.orchestrator);
  await f.poll(); await f.poll(MAIN_CLOSED_HANDOVER_MS);
  assert.equal(f.w().mainAgentId, "helper");
  assert.equal(markMainWork(f.state, "orchestrator"), false, "only the current main's work counts");
  assert.equal(markMainWork(f.state, "helper"), true);
  f.reopen(f.orchestrator);
  await f.poll();
  assert.equal(f.w().mainAgentId, "helper", "a successor that synced, asked or reported keeps the workspace");
});

test("an archived main hands over at once", async t => {
  const f = await fixture(t);
  await f.poll();
  f.orchestrator.archivedAt = "2026-11-09T22:00:00Z";
  await f.poll();
  assert.equal(f.w().mainAgentId, "helper");
});

test("a stop hold raised by another agent's turn doesn't stay with the new main", async t => {
  const f = await fixture(t);
  await f.poll();
  f.close(f.orchestrator);
  await f.poll(); await f.poll(MAIN_CLOSED_HANDOVER_MS);
  assert.equal(f.w().mainAgentId, "helper");
  // Tom stops the helper's turn while it holds the workspace: the hold names the helper.
  f.w().hold = interruptionHold("canceled"); f.w().interruption = { turnId: "foreground-turn-13", at: new Date(clock).toISOString(), kind: "canceled", agentId: "helper" };
  f.reopen(f.orchestrator);
  await f.poll();
  assert.equal(f.w().mainAgentId, "orchestrator");
  assert.equal(f.w().hold, null, "the helper's stop isn't the orchestrator's");
  assert.equal(f.w().interruption, undefined);
});

test("Make main agent: the developer picks one of the workspace's root agents; a legacy stop hold clears with it", () => {
  const state: State = { version: 1, workspaces: [workspace({ mainAgentId: "helper", contributorAgentIds: ["orchestrator"], hold: interruptionHold("canceled"), interruption: { turnId: "foreground-turn-13", at: new Date(clock).toISOString(), kind: "canceled" }, handover: { from: "x", at: new Date(clock).toISOString(), worked: true } })] };
  assert.throws(() => controlWorkspace(state, { workspaceId: "workspace", mainAgentId: "stranger" }, clock), /root agents/);
  const w = controlWorkspace(state, { workspaceId: "workspace", mainAgentId: "orchestrator" }, clock);
  assert.equal(w.mainAgentId, "orchestrator");
  assert.deepEqual(w.contributorAgentIds, ["helper"]);
  assert.equal(w.handover, undefined, "a developer choice is never handed back automatically");
  assert.equal(w.hold, null, "a stop hold from before agent-tagged holds clears on the developer's explicit choice");
  // An automatic hand-back keeps a hold that names no agent: it may be the new main's own stop.
  const legacy: State = { version: 1, workspaces: [workspace({ mainAgentId: "helper", contributorAgentIds: ["orchestrator"], hold: interruptionHold("canceled"), interruption: { turnId: "t", at: new Date(clock).toISOString(), kind: "canceled" }, handover: { from: "orchestrator", at: new Date(clock).toISOString(), worked: false } })] };
  applyDiscovery(legacy, [{ id: "workspace", title: "W", mainAgentId: "orchestrator", replacesMainAgentId: "helper", handBack: true, messageAt: null }], clock);
  assert.equal(legacy.workspaces[0].mainAgentId, "orchestrator");
  assert.equal(legacy.workspaces[0].hold, interruptionHold("canceled"));
});
