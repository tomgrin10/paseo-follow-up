import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

/**
 * tracking-waits-for-a-new-agent (2026-11-13): seeding the screenshot sets failed at random with "This workspace has no
 * available main agent": the seed creates a workspace and its agent, then tracks it at once. Track's discovery asked
 * for fresh agents, but within an engine tick that already listed them the directory returned the tick's list
 * (a-send-lists-agents-at-most-once-per-tick), which predates the new agent; and under load Paseo itself can list a
 * just-created agent a moment late. Track now re-lists past the tick's memo when the list lacks the agent it needs, and
 * retries a bounded number of times before it gives up.
 */
const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, workspaceId: string): Agent => ({ id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: iso(clock), status: "idle", activeTurn: null, labels: {}, lastUserMessageAt: iso(clock), pendingPermissions: [] } as unknown as Agent);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-track-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const agents: Agent[] = [agent("a0", "w0")];
  const workspaces = [{ id: "w0", name: "Billing retries", projectId: "project" }];
  /** Agents Paseo has created but doesn't list yet: each listing lists them one listing later. */
  let late: Agent[] = [];
  const counts = { fetch_agents: 0 };
  const client = {
    fetchAgents: async () => { counts.fetch_agents++; const listed = agents.map(a => ({ agent: structuredClone(a) })); agents.push(...late); late = []; return { entries: listed, pageInfo: { hasMore: false, nextCursor: null } }; },
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }),
    fetchAgent: async (id: string) => { const a = agents.find(a => a.id === id); return a ? { agent: structuredClone(a) } : null; },
    fetchAgentTimeline: async () => ({ entries: [], startCursor: null, endCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false }),
    listProviderSubagents: async () => ({ subagents: [] }),
  } as unknown as Daemon;
  const connect = (async work => work(client)) as typeof withDaemon;
  const gateway = new PaseoGateway(connect, new SessionGuard(dir), async () => false, HistoryCache.at(dir), () => clock);
  const state: State = { version: 1, workspaces: [workspace({ id: "w0", mainAgentId: "a0", enable_tracking: true })] } as State;
  return {
    gateway, state, counts,
    /** The developer (or the screenshot seed) creates a workspace; its agent comes a moment later. */
    workspace(id: string) { workspaces.push({ id: `w-${id}`, name: id, projectId: "project" }); },
    /** `lag`: Paseo lists the new agent one listing late. */
    agent(id: string, lag = false) { (lag ? late : agents).push(agent(`a-${id}`, `w-${id}`)); },
    /** One engine tick that lists agents, as the worker's does. */
    async tick() { gateway.tickStarted(); await gateway.discover(state); },
  };
}

test("tracking-waits-for-a-new-agent: an agent created after this tick listed agents is tracked at once", async t => {
  const f = await fixture(t);
  // The workspace is created and the tick lists it (before its agent exists); then the agent comes, then Track.
  f.workspace("second");
  await f.tick();
  f.agent("second");
  const rows = await f.gateway.discover(f.state, "w-second");
  assert.deepEqual(rows.map(r => [r.id, r.mainAgentId]), [["w-second", "a-second"]], "Track finds the agent created after the tick's list");
});

test("tracking-waits-for-a-new-agent: an agent Paseo lists a moment late is found with a bounded retry; none gives up", async t => {
  const f = await fixture(t);
  f.workspace("late");
  await f.tick();
  f.agent("late", true);
  const rows = await f.gateway.discover(f.state, "w-late");
  assert.deepEqual(rows.map(r => [r.id, r.mainAgentId]), [["w-late", "a-late"]]);
  // A workspace whose agent never comes: a few listings, then no row (Track reports it), never a loop.
  f.workspace("empty");
  await f.tick();
  const before = f.counts.fetch_agents;
  assert.deepEqual(await f.gateway.discover(f.state, "w-empty"), []);
  const spent = f.counts.fetch_agents - before;
  assert.ok(spent >= 2 && spent <= 4, `agent listings for a workspace with no agent: ${spent}`);
});
