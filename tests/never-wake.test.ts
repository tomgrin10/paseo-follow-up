import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { daemonDirectory } from "../server/inbox-directory";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { ConversationGone } from "../server/delivery";
import { Store } from "../server/store";
import { isLoaded, workspaceActive, conversationGone, DAY_MS } from "../server/agent-load";
import { ACTIVE_SCOPE_MIGRATION, migrateActiveScope } from "../shared/settings";
import type { State, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

// 1.3.0-beta.3: reading an unloaded agent's timeline loads its runtime for an hour (fetch_agent_timeline goes
// through ensureAgentLoaded). Every test here counts the reads a real daemon would turn into wake-ups.

const iso = (ms: number) => new Date(ms).toISOString();
/** A loaded agent's snapshot carries activeTurn; a stored (unloaded) one never does and reports its last status. */
const agent = (id: string, workspaceId: string, patch: Partial<Agent> & { loaded?: boolean } = {}): Agent => {
  const { loaded = false, ...rest } = patch;
  return { id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: "2025-12-01T00:00:00Z", status: "idle", labels: {}, lastUserMessageAt: iso(clock - 30 * DAY_MS), pendingPermissions: [], ...(loaded ? { activeTurn: null } : {}), ...rest } as Agent;
};

function daemon(agents: Agent[], workspaces: { id: string; name: string; projectId: string }[]) {
  const reads: string[] = []; const subagents: string[] = [];
  const client = {
    fetchAgents: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }),
    fetchAgent: async (id: string) => { const a = agents.find(a => a.id === id); return a ? { agent: a } : null; },
    fetchAgentTimeline: async (id: string) => { reads.push(id); return { entries: [{ seqStart: 0, item: { type: "user_message", text: "Ship https://github.com/example/app/pull/7" } }], startCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false }; },
    listProviderSubagents: async (id: string) => { subagents.push(id); return { subagents: [] }; },
  } as unknown as Daemon;
  return { client, reads, subagents, connect: (async work => work(client)) as typeof withDaemon };
}

async function temp(t: any) { const dir = await mkdtemp(join(tmpdir(), "follow-wake-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("isLoaded: only a live snapshot (activeTurn present) or a live status counts", () => {
  assert.equal(isLoaded({ status: "idle" }), false, "a stored projection reports idle without activeTurn");
  assert.equal(isLoaded({ status: "closed", activeTurn: null }), false);
  assert.equal(isLoaded({ status: "idle", activeTurn: null }), true);
  assert.equal(isLoaded({ status: "running" }), true);
  assert.equal(isLoaded({ status: "idle", pendingPermissions: [{}] }), true);
  assert.equal(isLoaded(null), false);
});

test("discovery never reads the timeline of an unloaded agent, even in an active workspace", async t => {
  const dir = await temp(t);
  const agents = [
    agent("recent-unloaded", "w-recent", { lastUserMessageAt: iso(clock - DAY_MS) }),
    agent("pr-unloaded", "w-pr"),
    agent("dormant", "w-dormant"),
    agent("live", "w-live", { loaded: true }),
  ];
  const d = daemon(agents, ["w-recent", "w-pr", "w-dormant", "w-live"].map(id => ({ id, name: id, projectId: "project" })));
  const gateway = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, new HistoryCache(null), () => clock);
  const state: State = { version: 1, workspaces: [workspace({ id: "w-pr", mainAgentId: "pr-unloaded", prs: [pr()] })] };
  for (let poll = 0; poll < 3; poll++) await gateway.discover(state);
  assert.deepEqual(d.reads, ["live"], "only the loaded agent was read, once");
  for (const w of ["w-recent", "w-pr", "w-dormant", "w-live"]) await gateway.observe(workspace({ id: w, mainAgentId: agents.find(a => a.workspaceId === w)!.id }), true);
  assert.deepEqual(d.subagents, ["live"], "provider subagents are asked only of loaded agents");
});

test("active scope: a loaded agent, a recent user message or an open PR; anything else is dormant", async t => {
  const window = 3 * DAY_MS;
  assert.equal(workspaceActive([agent("a", "w", { loaded: true })], undefined, window, clock), true);
  assert.equal(workspaceActive([agent("a", "w", { lastUserMessageAt: iso(clock - 2 * DAY_MS) })], undefined, window, clock), true);
  assert.equal(workspaceActive([agent("a", "w", { lastUserMessageAt: iso(clock - 4 * DAY_MS) })], undefined, window, clock), false);
  assert.equal(workspaceActive([agent("a", "w")], { prs: [pr()] }, window, clock), true, "an open PR keeps it active");
  assert.equal(workspaceActive([agent("a", "w")], { prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] }, window, clock), false);
  assert.equal(workspaceActive([agent("a", "w", { lastUserMessageAt: iso(clock - 4 * DAY_MS) })], undefined, 7 * DAY_MS, clock), true, "the window is a setting");

  const dir = await temp(t);
  const agents = [agent("old", "w-old"), agent("new", "w-new", { lastUserMessageAt: iso(clock - DAY_MS) })];
  const d = daemon(agents, [{ id: "w-old", name: "old", projectId: "project" }, { id: "w-new", name: "new", projectId: "project" }]);
  const gateway = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, new HistoryCache(null), () => clock);
  const rows = await gateway.discover({ version: 1, workspaces: [] });
  assert.deepEqual(rows.map(r => [r.id, r.active]), [["w-old", false], ["w-new", true]], "dormant workspaces stay listed");
  const wide = await gateway.discover({ version: 1, workspaces: [], activeWindowDays: 60 });
  assert.deepEqual(wide.map(r => r.active), [true, true]);
});

test("the history cache survives a restart, so a new worker doesn't rescan", async t => {
  const dir = await temp(t);
  const live = agent("live", "w", { loaded: true, lastUserMessageAt: iso(clock - DAY_MS) });
  const d = daemon([live], [{ id: "w", name: "w", projectId: "project" }]);
  const first = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, HistoryCache.at(dir), () => clock);
  await first.discover({ version: 1, workspaces: [] });
  assert.deepEqual(d.reads, ["live"]);
  const second = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, HistoryCache.at(dir), () => clock + 60_000);
  const [row] = await second.discover({ version: 1, workspaces: [] });
  assert.deepEqual(d.reads, ["live"], "the restarted worker used the persisted history");
  assert.deepEqual(row.history?.candidates, ["example/app#7"]);
  live.lastUserMessageAt = iso(clock); await second.discover({ version: 1, workspaces: [] });
  assert.deepEqual(d.reads, ["live", "live"], "a new user message invalidates the entry");
});

test("the inbox tail never reads an unloaded agent", async () => {
  const sleeping = agent("sleeping", "w"); const awake = agent("awake", "w", { status: "running" });
  const d = daemon([sleeping, awake], [{ id: "w", name: "w", projectId: "project" }]);
  const directory = daemonDirectory(d.connect);
  assert.deepEqual(await directory.tail("sleeping", 20), []);
  assert.equal((await directory.tail("awake", 20)).length, 1);
  assert.deepEqual(d.reads, ["awake"]);
});

async function engineFixture(t: any, w: Workspace, runtime: Runtime) {
  const root = await temp(t);
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); s.migrations = [ACTIVE_SCOPE_MIGRATION]; });
  let now = clock; const sends: string[] = []; const observed: string[] = [];
  let send: (text: string) => Promise<void> = async text => { sends.push(text); };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async x => { observed.push(x.id); return runtime; }, send: async (_w, _b, text) => send(text), label: async () => {} };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: iso(now) }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  return { store, engine, sends, observed, advance: (ms: number) => { now += ms; }, get: async () => (await store.snapshot()).workspaces[0], failWith: (f: typeof send) => { send = f; } };
}

test("no auto-send to an unloaded or long-idle main agent, and completion checks never go out on their own", async t => {
  const repair = () => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] });
  for (const runtime of [{ mainLoaded: false, mainRecent: true }, { mainLoaded: true, mainRecent: false }]) {
    const f = await engineFixture(t, repair(), { busy: false, reason: null, archived: false, ...runtime });
    await f.engine.tick(); f.advance(61_000); await f.engine.tick();
    assert.equal(f.sends.length, 0, JSON.stringify(runtime));
    assert.equal((await f.get()).batches[0].state, "pending", "the batch waits for the agent's next live turn, or Tom");
  }
  const live = await engineFixture(t, repair(), { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true });
  await live.engine.tick(); live.advance(61_000); await live.engine.tick();
  assert.equal(live.sends.length, 1, "a loaded, recently used agent still gets its repairs");

  const done = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] }), { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true });
  await done.engine.tick(); done.advance(61_000); await done.engine.tick();
  assert.equal((await done.get()).batches[0].tasks[0].kind, "completion");
  assert.equal(done.sends.length, 0, "completion batches are never auto-sent");

  const dormant = await engineFixture(t, workspace({ enable_auto_sends: true, dormant: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }), { busy: false, reason: null, archived: false });
  await dormant.engine.tick(); dormant.advance(61_000); await dormant.engine.tick();
  assert.deepEqual(dormant.observed, [], "a dormant workspace isn't observed at all");
  assert.equal(dormant.sends.length, 0);
});

test("'No conversation found' marks the agent gone and stops retries", async t => {
  assert.equal(conversationGone("No conversation found with session ID 1234"), true);
  assert.equal(conversationGone(new Error("rate limited")), false);
  const f = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }), { busy: false, reason: null, archived: false, mainLoaded: true, mainRecent: true });
  let attempts = 0;
  f.failWith(async () => { attempts++; throw new ConversationGone("main-agent", "No conversation found with session ID 1234"); });
  await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(attempts, 1);
  let w = await f.get();
  assert.equal(w.goneAgent?.agentId, "main-agent");
  assert.equal(w.batches[0].state, "pending", "nothing reached the agent; the batch waits for a new one");
  for (let i = 0; i < 5; i++) { f.advance(61_000); await f.engine.tick(); }
  assert.equal(attempts, 1, "no automatic retries");
  await assert.rejects(f.engine.sendPending(w.id, w.batches[0].id), /conversation no longer exists/);
  assert.equal(attempts, 1, "and no manual send to the gone agent");
  w = await f.get(); assert.match(w.runtimeReason ?? "", /conversation no longer exists/);
  assert.equal(w.archived, false, "nothing is archived");

  const observed = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }), { busy: false, reason: "No conversation found", archived: false, gone: "No conversation found with session ID 1234" });
  await observed.engine.tick(); observed.advance(61_000); await observed.engine.tick();
  assert.equal((await observed.get()).goneAgent?.agentId, "main-agent", "observation of the failed agent marks it too");
  assert.equal(observed.sends.length, 0);
});

test("upgrade parks auto-send outside the active scope once and restores it when the workspace becomes active", async t => {
  const state = { workspaces: [
    { id: "active", archived: false, enable_tracking: true, enable_auto_sends: true },
    { id: "dormant", archived: false, enable_tracking: true, enable_auto_sends: true },
    { id: "manual", archived: false, enable_tracking: true, enable_auto_sends: false },
  ], migrations: [] as string[], autoSendsParked: undefined as string[] | undefined };
  assert.equal(migrateActiveScope(state, new Set(["active"])), 1);
  assert.deepEqual(state.workspaces.map(w => w.enable_auto_sends), [true, false, false]);
  assert.deepEqual(state.autoSendsParked, ["dormant"]);
  assert.equal(migrateActiveScope(state, new Set()), null, "runs once");

  const dir = await temp(t);
  const sleeper = agent("sleeper", "dormant");
  const d = daemon([sleeper], [{ id: "dormant", name: "dormant", projectId: "project" }]);
  const store = new Store(dir);
  await store.mutate(s => { s.workspaces.push(workspace({ id: "dormant", mainAgentId: "sleeper", enable_auto_sends: true, prs: [] })); });
  const gateway = new PaseoGateway(d.connect, new SessionGuard(dir), async () => false, new HistoryCache(null), () => clock);
  const github = { observe: async () => new Map() };
  const engine = new Engine(store, github, gateway, () => clock);
  await engine.tick();
  let s = await store.snapshot();
  assert.equal(s.workspaces[0].enable_auto_sends, false); assert.equal(s.workspaces[0].dormant, true); assert.deepEqual(s.autoSendsParked, ["dormant"]);
  assert.deepEqual(d.reads, []);
  sleeper.status = "running"; await engine.tick();
  s = await store.snapshot();
  assert.equal(s.workspaces[0].enable_auto_sends, true, "auto-send comes back once it's active");
  assert.equal(s.workspaces[0].dormant, undefined); assert.equal(s.autoSendsParked, undefined);
  assert.deepEqual(d.reads, ["sleeper"], "now loaded, its history is read once");
});
