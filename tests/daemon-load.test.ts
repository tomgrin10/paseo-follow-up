import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { DaemonDirectory, DIRTY_REFRESH_MS, BACKSTOP_REFRESH_MS } from "../server/directory";
import { daemonDirectory } from "../server/inbox-directory";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// 1.4.0-beta.1: every fetch_workspaces makes the daemon read each workspace's paseo.json through a two-wide pool.
// Follow-up listed workspaces on every 15 s tick and on every Home/panel RPC, which slowed the app for everyone.
// These tests count every request a fake daemon receives.

const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, workspaceId: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: iso(clock - DAY), status: "idle", activeTurn: null, labels: {}, lastUserMessageAt: iso(clock - 60_000), pendingPermissions: [], ...patch } as Agent);
const DAY = 86_400_000;

function daemon(agents: Agent[], workspaces: { id: string; name: string; projectId: string }[]) {
  const requests: Record<string, number> = {}; const reads: string[] = [];
  const hit = (type: string) => { requests[type] = (requests[type] ?? 0) + 1; };
  const client = {
    fetchAgents: async () => { hit("fetch_agents"); return { entries: agents.map(a => ({ agent: structuredClone(a) })), pageInfo: { hasMore: false, nextCursor: null } }; },
    fetchWorkspaces: async () => { hit("fetch_workspaces"); return { entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } }; },
    listProjects: async () => { hit("project.list"); return { projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }; },
    fetchAgent: async (id: string) => { hit("fetch_agent"); const a = agents.find(a => a.id === id); return a ? { agent: structuredClone(a) } : null; },
    fetchAgentTimeline: async (id: string) => { hit("fetch_agent_timeline"); reads.push(id); return { entries: [{ seqStart: 0, item: { type: "user_message", text: "Ship it" } }], startCursor: null, endCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false }; },
    listProviderSubagents: async () => { hit("provider_subagents"); return { subagents: [] }; },
    setWorkspaceLabel: async () => { hit("set_workspace_label"); },
  } as unknown as Daemon;
  let connections = 0;
  const total = () => Object.values(requests).reduce((s, n) => s + n, 0);
  return { client, requests, reads, total, connections: () => connections, connect: (async work => { connections++; return work(client); }) as typeof withDaemon };
}

async function fixture(t: any, size = 120, awake = 5) {
  const dir = await mkdtemp(join(tmpdir(), "follow-load-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspaces = Array.from({ length: size }, (_, i) => ({ id: `w${i}`, name: `Workspace ${i}`, projectId: "project" }));
  // A few loaded, recently used agents (the active scope); the rest dormant and unloaded.
  const agents = workspaces.map((w, i) => i < awake ? agent(`a${i}`, w.id) : agent(`a${i}`, w.id, { activeTurn: undefined, lastUserMessageAt: iso(clock - 30 * DAY) }));
  const d = daemon(agents, workspaces);
  let now = clock;
  const gateway = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, HistoryCache.at(dir), () => now);
  const state: State = { version: 1, workspaces: workspaces.map((w, i) => workspace({ id: w.id, mainAgentId: `a${i}`, enable_tracking: true, dormant: i >= awake })) };
  return { d, agents, gateway, state, advance: (ms: number) => { now += ms; }, now: () => now };
}

/** One engine tick as the worker runs it: discovery, then each active workspace's runtime. */
async function tick(f: Awaited<ReturnType<typeof fixture>>) {
  await f.gateway.discover(f.state);
  for (const w of f.state.workspaces.filter(w => !w.dormant)) await f.gateway.observe(w);
}

test("discovery and runtime observation don't list workspaces on every tick", async t => {
  const f = await fixture(t);
  await tick(f);
  const first = { ...f.d.requests };
  assert.equal(first.fetch_workspaces, 1, "one listing at start");
  for (let i = 0; i < 3; i++) { f.advance(15_000); await tick(f); }
  assert.equal(f.d.requests.fetch_workspaces, 1, "no listing per tick while nothing changed");
  assert.equal(f.d.requests.fetch_agents, 1);
  assert.equal(f.d.requests["project.list"], 1);
});

test("an event marks the directory dirty: re-read at most once a minute, plus a ten-minute backstop", async t => {
  const f = await fixture(t);
  await tick(f);
  f.gateway.directory.turnEnded({ id: "a1", workspaceId: "w1", provider: "claude", cwd: "/", title: null }, { kind: "completed" });
  f.advance(15_000); await tick(f);
  f.advance(15_000); await tick(f);
  assert.equal(f.d.requests.fetch_workspaces, 1, "dirty, but the last read is under a minute old");
  f.advance(DIRTY_REFRESH_MS); await tick(f);
  assert.equal(f.d.requests.fetch_workspaces, 2, "dirty and a minute old: one re-read");
  f.advance(DIRTY_REFRESH_MS); await tick(f);
  assert.equal(f.d.requests.fetch_workspaces, 2, "clean again: no re-read");
  f.advance(BACKSTOP_REFRESH_MS); await tick(f);
  assert.equal(f.d.requests.fetch_workspaces, 3, "the backstop re-reads a clean directory every ten minutes");
});

test("events patch the directory in place: a turn makes the workspace busy without a re-read", async t => {
  const f = await fixture(t);
  await tick(f);
  const w = f.state.workspaces[1];
  f.gateway.directory.turnStarted({ id: "a1", workspaceId: "w1", provider: "claude", cwd: "/", title: null }, "turn");
  assert.equal((await f.gateway.observe(w)).busy, true);
  f.gateway.directory.turnEnded({ id: "a1", workspaceId: "w1", provider: "claude", cwd: "/", title: null }, { kind: "completed" });
  assert.equal((await f.gateway.observe(w)).busy, false);
  f.gateway.directory.permissionRequested("a1", { id: "p1" });
  assert.match((await f.gateway.observe(w)).reason ?? "", /permission/);
  f.gateway.directory.permissionResolved("a1", "p1");
  assert.equal((await f.gateway.observe(w)).reason, null);
  f.gateway.directory.workspaceArchived("w1");
  assert.equal((await f.gateway.observe(w)).archived, true);
  assert.equal(f.d.requests.fetch_workspaces, 1); assert.equal(f.d.requests.fetch_agents, 1);
});

test("idle request budget: under 2 daemon requests a minute with 120 workspaces", async t => {
  const f = await fixture(t);
  // Warm up: the first discovery reads each awake agent's history once.
  await tick(f); f.advance(15_000); await tick(f);
  const before = f.d.total(); const connectionsBefore = f.d.connections();
  // Ten idle minutes at the worker's 15 s cadence, with the inbox and the Overseer reading the same directory.
  const inbox = daemonDirectory(f.gateway.directory, f.d.connect);
  for (let i = 0; i < 40; i++) { f.advance(15_000); await tick(f); await inbox.agents(); await inbox.workspaces(); }
  const perMinute = (f.d.total() - before) / 10;
  assert.ok(perMinute < 2, `${perMinute} requests/min: ${JSON.stringify(f.d.requests)}`);
  assert.ok((f.d.connections() - connectionsBefore) / 10 < 2, "and under 2 connections a minute");
});

test("Home and the panel read the shared directory: inbox reads cost no daemon request", async t => {
  const f = await fixture(t);
  await tick(f);
  const before = f.d.total();
  const inbox = daemonDirectory(f.gateway.directory, f.d.connect);
  for (let i = 0; i < 50; i++) { await inbox.agents(); await inbox.workspaces(); await inbox.agent("a3"); }
  assert.equal(f.d.total(), before);
});

test("the Done label is sent when it changes, not on every tick", async t => {
  const f = await fixture(t);
  const w = f.state.workspaces[0];
  for (let i = 0; i < 5; i++) await f.gateway.label(w, true);
  assert.equal(f.d.requests.set_workspace_label, 1);
  await f.gateway.label(w, false);
  assert.equal(f.d.requests.set_workspace_label, 2);
});

test("a cached 'loaded' snapshot is confirmed before any read that would wake the agent", async t => {
  const f = await fixture(t, 3, 1);
  await tick(f);
  assert.deepEqual(f.d.reads, ["a0"]);
  // The daemon unloaded the idle agent after an hour (no event); a new user message makes discovery want its history.
  const a0 = f.agents[0]; delete (a0 as { activeTurn?: unknown }).activeTurn;
  const cached = f.gateway.directory.cached("a0")!; cached.lastUserMessageAt = iso(f.now());
  f.advance(15_000); await tick(f);
  assert.deepEqual(f.d.reads, ["a0"], "the confirmed snapshot says unloaded, so the timeline isn't read");
  // Subagents are only asked about when a send depends on them, and only for a confirmed live agent.
  assert.equal(f.d.requests.provider_subagents ?? 0, 0);
});

test("a fresh observation before a send re-reads agents, never the workspace list", async t => {
  const f = await fixture(t);
  await tick(f);
  f.agents[2].status = "running";
  assert.equal((await f.gateway.observe(f.state.workspaces[2], true)).busy, true);
  assert.equal(f.d.requests.fetch_agents, 2); assert.equal(f.d.requests.fetch_workspaces, 1);
});

test("single-workspace discovery (Track, session start) uses the directory and re-reads only for an unknown workspace", async t => {
  const f = await fixture(t);
  await tick(f);
  await f.gateway.discover(f.state, "w3");
  assert.equal(f.d.requests.fetch_workspaces, 1);
  await f.gateway.discover(f.state, "brand-new");
  assert.equal(f.d.requests.fetch_workspaces, 2, "a workspace the directory hasn't seen forces one re-read");
});

test("concurrent readers share one in-flight read", async () => {
  const d = daemon([agent("a", "w")], [{ id: "w", name: "w", projectId: "project" }]);
  const directory = new DaemonDirectory(d.connect);
  await Promise.all(Array.from({ length: 10 }, () => directory.read()));
  assert.equal(d.requests.fetch_workspaces, 1);
});

test("the inbox list answers 'unchanged' in a few bytes when the client already holds it", async () => {
  const { inboxAnswer } = await import("../server/etag");
  const answer = { enabled: true, rows: Array.from({ length: 120 }, (_, i) => ({ agentId: `a${i}`, title: `Agent ${i}` })), unsorted: null, firstRun: false, batchUndo: null, signOffs: 0, error: null, overseer: null };
  const first = inboxAnswer(answer, undefined);
  assert.equal(first.rows.length, 120); assert.ok(first.etag);
  const again = inboxAnswer(answer, first.etag);
  assert.equal(again.unchanged, true); assert.equal(again.rows.length, 0);
  assert.ok(JSON.stringify(again).length < 300, "a few bytes, not the list");
  const changed = inboxAnswer({ ...answer, signOffs: 1 }, first.etag);
  assert.equal(changed.unchanged, undefined); assert.equal(changed.rows.length, 120);
});

test("Track right after an agent is created re-reads agents once when the directory has none for the workspace", async t => {
  const f = await fixture(t, 3, 1);
  await tick(f);
  f.agents.push(agent("fresh", "w-new"));
  // The workspace is known (its event arrived), the agent's event hasn't been applied yet.
  f.gateway.directory.workspaceCreated({ id: "w-new", projectId: "project", name: "New" });
  const rows = await f.gateway.discover(f.state, "w-new");
  assert.equal(rows[0]?.mainAgentId, "fresh");
  assert.equal(f.d.requests.fetch_agents, 2); assert.equal(f.d.requests.fetch_workspaces, 1);
});

test("a closed or archived agent's card and task line cost no daemon request: never a timeline read or fetch_agent", async () => {
  const { createdItems } = await import("../server/created-items");
  const { taskStatus } = await import("../shared/task-status");
  const closed = agent("closed-1", "w", { status: "closed", title: "Backfill pass", activeTurn: undefined, lastUserMessageAt: iso(clock - 30 * DAY) } as Partial<Agent>);
  const archived = agent("arch-1", "w", { status: "idle", title: "Docs pass", archivedAt: iso(clock - DAY) } as Partial<Agent>);
  const d = daemon([closed, archived], [{ id: "w", name: "w", projectId: "project" }]);
  const directory = new DaemonDirectory(d.connect);
  await directory.read();
  const before = d.total();
  // What follow.created-items does: the engine's snapshot as it stands.
  const live = createdItems({ agentIds: ["closed-1", "arch-1"], workspaceIds: ["w"] }, directory.snapshot(), []);
  assert.equal(live.agents["closed-1"]!.state, "closed");
  assert.equal(live.agents["arch-1"]!.state, "archived");
  // The task line reads the states the engine stored on the workspace; nothing else.
  const w = workspace({ id: "w", taskAgents: { "closed-1": { title: "Backfill pass", state: "closed" } },
    obligations: [{ id: "t", title: "Backfill", status: "working", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, workingAgentId: "closed-1" }] });
  assert.equal(taskStatus(w.obligations[0]!, w).link, "Open chat");
  assert.equal(d.total(), before, "no request at all");
  assert.equal(d.requests.fetch_agent_timeline, undefined, "never a timeline read");
  assert.equal(d.requests.fetch_agent, undefined, "never fetch_agent");
});

test("archived agents: remembered across re-reads, and a named agent the directory lacks is looked up once, never loaded", async () => {
  const { createdItems } = await import("../server/created-items");
  const { ARCHIVED_MEMO_MAX } = await import("../server/directory");
  const live = agent("live-1", "w", { title: "Reader fix" });
  const seen = agent("seen-1", "w", { title: "Docs pass", activeTurn: undefined });
  const before = agent("before-1", "w", { title: "Backfill pass", activeTurn: undefined, archivedAt: iso(clock - DAY) } as Partial<Agent>);
  const all = [live, seen, before];
  const d = daemon(all, [{ id: "w", name: "w", projectId: "project" }]);
  // Like Paseo: fetch_agents leaves archived agents out; fetch_agent still answers for them (metadata only).
  (d.client as { fetchAgents: unknown }).fetchAgents = async () => { d.requests.fetch_agents = (d.requests.fetch_agents ?? 0) + 1; return { entries: all.filter(a => !a.archivedAt).map(a => ({ agent: structuredClone(a) })), pageInfo: { hasMore: false, nextCursor: null } }; };
  let now = clock;
  const directory = new DaemonDirectory(d.connect, () => now);
  const flush = () => new Promise(r => setImmediate(r));
  const ids = ["seen-1", "before-1", "gone-1"];
  const read = () => createdItems({ agentIds: ids, workspaceIds: [] }, directory.snapshotFor(ids), []).agents;
  await directory.read();

  // Archived while the worker watched: the event feeds the memo, which survives the re-read that drops the row.
  seen.archivedAt = iso(clock); directory.agentArchived("seen-1", iso(clock));
  now += BACKSTOP_REFRESH_MS; await directory.read();
  assert.equal(directory.snapshot()!.agents.some(r => r.agent.id === "seen-1"), false, "Paseo's list dropped it");
  assert.equal(read()["seen-1"]?.state, "archived", "still archived, from the memo");

  // Archived before the worker started, and an id Paseo never had: one fetch_agent each, on demand.
  assert.equal(read()["before-1"], undefined, "unknown until looked up");
  const requests = d.total();
  directory.lookup(ids); await flush(); await flush();
  assert.equal(d.requests.fetch_agent, 2, "one fetch_agent per missing id; seen-1 was remembered");
  assert.equal(read()["before-1"]?.state, "archived");
  assert.equal(read()["gone-1"], undefined, "gone stays unknown: words only");
  // At most once per id for the worker's life, gone ids included; re-reads and further lookups never repeat it.
  for (let i = 0; i < 5; i++) { directory.lookup(ids); now += BACKSTOP_REFRESH_MS; await directory.read(); await flush(); }
  assert.equal(d.requests.fetch_agent, 2, "never again, whatever the cadence");
  assert.equal(read()["before-1"]?.state, "archived", "survives re-reads");
  assert.equal(d.requests.fetch_agent_timeline, undefined, "a lookup never reads a timeline (that would load the agent)");
  assert.equal(d.requests.provider_subagents, undefined, "nor provider subagents");
  assert.deepEqual(Object.keys(d.requests).sort(), ["fetch_agent", "fetch_agents", "fetch_workspaces", "project.list"], "only the lookups and the list re-reads");
  assert.ok(d.total() > requests);

  // The task line: the engine's observation looks up and reads the same memo.
  const w = workspace({ id: "w", mainAgentId: "live-1", obligations: [{ id: "t", title: "Docs", status: "working", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, workingAgentId: "before-1" }] });
  const gateway = new PaseoGateway(d.connect, new SessionGuard(await mkdtemp(join(tmpdir(), "follow-arch-"))), async () => false, new HistoryCache(null), () => now, directory);
  const runtime = await gateway.observe(w);
  assert.equal(runtime.taskAgents?.["before-1"]?.state, "archived");
  assert.equal(d.requests.fetch_agent_timeline, undefined);

  // Bounded: the memo keeps the most recent ARCHIVED_MEMO_MAX.
  for (let i = 0; i <= ARCHIVED_MEMO_MAX; i++) { all.push(agent(`old-${i}`, "w", { activeTurn: undefined })); }
  now += BACKSTOP_REFRESH_MS; await directory.read();
  for (let i = 0; i <= ARCHIVED_MEMO_MAX; i++) directory.agentArchived(`old-${i}`, iso(clock));
  assert.equal(directory.withArchived(["old-0"], []).length, 0, "the oldest fell out");
  assert.equal(directory.withArchived([`old-${ARCHIVED_MEMO_MAX}`], []).length, 1);
});
