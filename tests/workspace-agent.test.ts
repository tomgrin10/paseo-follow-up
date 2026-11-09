import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceRoot, type WorkspaceAgent } from "../server/workspace-agent";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { Engine } from "../server/engine";
import { Store } from "../server/store";
import { applyDiscovery } from "../server/discovery";
import type { State } from "../shared/model";

const agent = (id: string, workspaceId: string, parent?: string): Agent => ({ id, workspaceId, createdAt: "2026-01-01T00:00:00Z", status: "idle", activeTurn: null, labels: parent ? { "paseo.parent-agent-id": parent } : {}, lastUserMessageAt: null, pendingPermissions: [], provider: "fixture", cwd: "/fixture" });
test("a parent in another workspace is launch provenance; a parent in the same workspace is a child scope", async () => {
  const caller = agent("created", "new-workspace", "creator");
  const parent = agent("creator", "creator-workspace");
  assert.equal(await isWorkspaceRoot(caller, async () => parent), true);
  assert.equal(await isWorkspaceRoot(caller, async () => ({ ...parent, archivedAt: "earlier" })), true, "archiving the creator does not revoke an independent workspace");
  assert.equal(await isWorkspaceRoot(caller, async () => ({ ...parent, workspaceId: caller.workspaceId })), false);
  assert.equal(await isWorkspaceRoot({ ...caller, archivedAt: "now" }, async () => parent), false);
  assert.equal(await isWorkspaceRoot(agent("direct", "new-workspace"), async () => { throw new Error("No lookup expected"); }), true);
});
test("unknown, malformed and self parent references cannot grant root scope", async () => {
  const caller = agent("created", "new-workspace", "creator");
  for (const parent of [null, { id: "wrong", workspaceId: "other", labels: {} }, { id: "creator", labels: {} }] as (WorkspaceAgent | null)[]) assert.equal(await isWorkspaceRoot(caller, async () => parent), false);
  assert.equal(await isWorkspaceRoot(caller, async () => { throw new Error("Directory unavailable"); }), false);
  assert.equal(await isWorkspaceRoot(agent("self", "new-workspace", "self"), async () => caller), false);
});

async function fixture(t: any, enableDefault = true, parentIndexed = true) {
  const directory = await mkdtemp(join(tmpdir(), "follow-created-agent-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let timelineCalls = 0;
  const parent = agent("creator", "creator-workspace"); let agents: Agent[] = parentIndexed ? [parent] : [];
  const created = agent("created", "new-workspace", parent.id);
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "new-workspace", name: "Independent task", projectId: "project" }], pageInfo: { hasMore: false } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/hero-poc", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: id === parent.id ? parent : agents.find(a => a.id === id) }),
    fetchAgentTimeline: async () => { timelineCalls++; return { entries: [], hasOlder: false, error: null, gap: false, staleCursor: false }; },
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon);
  const store = new Store(directory);
  const state: State = { version: 1, workspaces: [], projectDefaults: { project: enableDefault } };
  await store.mutate(s => Object.assign(s, state));
  return { gateway, store, state, created, parent, timelineCalls: () => timelineCalls, populate: () => { agents.push(created, agent("same-workspace-child", created.workspaceId!, created.id)); } };
}
test("workspace-first creation automatically tracks its later cross-workspace child as the local main", async t => {
  const f = await fixture(t);
  applyDiscovery(f.state, await f.gateway.discover(f.state), Date.now()); assert.equal(f.state.workspaces.length, 0, "an empty workspace does not invent an owner");
  f.populate();
  // Paseo announces each new agent; the directory reads its snapshot instead of re-listing everything.
  for (const id of ["created", "same-workspace-child"]) await f.gateway.directory.agentCreated({ id, workspaceId: "new-workspace", provider: "fixture", cwd: "/", title: null });
  applyDiscovery(f.state, await f.gateway.discover(f.state), Date.now());
  const w = f.state.workspaces[0]; assert.equal(w.id, "new-workspace"); assert.equal(w.mainAgentId, f.created.id); assert.equal(w.enable_tracking, true); assert.equal(w.enable_auto_sends, true);
  assert.deepEqual(w.contributorAgentIds, []); assert.equal(w.batches.length, 0);
});
test("Track succeeds for an independently launched workspace and fetches a creator missing from the live directory", async t => {
  const f = await fixture(t, false, false); f.populate();
  // Only activation/discovery are exercised: runtime and messaging are inert synthetic stubs.
  f.gateway.observe = async () => ({ busy: false, reason: null, archived: false });
  f.gateway.label = async () => {};
  const engine = new Engine(f.store, { observe: async () => new Map() }, f.gateway);
  const w = await engine.activate("new-workspace");
  await engine.stop(); // Drain activation’s background refresh before fixture directory cleanup.
  assert.equal(w.mainAgentId, f.created.id); assert.equal(w.enable_tracking, true); assert.equal(w.enable_auto_sends, true);
  assert.equal(w.batches.length, 0); assert.deepEqual(w.contributorAgentIds, []);
});


test("targeted startup and Track discovery skip transcript reads; background discovery retains them", async t => {
  const f = await fixture(t); f.populate();
  const rows = await f.gateway.discover(f.state, "new-workspace");
  assert.equal(rows[0].mainAgentId, f.created.id); assert.equal(f.timelineCalls(), 0);
  assert.equal(rows[0].history, undefined);
  await f.gateway.discover(f.state); assert.equal(f.timelineCalls(), 1);
});
