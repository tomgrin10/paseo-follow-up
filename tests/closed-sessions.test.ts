import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, historyRetryDelay, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { SessionGuard } from "../server/session-guard";
import { batchSchema, type State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// Every daemon read below resumes an unloaded session's runtime, so these tests count them. The main agent
// starts loaded (a live snapshot carries activeTurn) so its transcript may be read; see never-wake.test.ts.
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "follow-closed-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = clock; t.mock.method(Date, "now", () => now);
  const main = { id: "main-agent", workspaceId: "workspace", provider: "codex", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", status: "idle", activeTurn: null, labels: {}, lastUserMessageAt: "2026-01-01T00:00:00Z", pendingPermissions: [] } as Agent;
  const recovery = { ...main, id: "recovery", status: "closed", labels: { "follow-up.recovery": "true" } };
  const agents = [main, recovery];
  let timelineReads = 0; let readable = false; const subagentLists: string[] = [];
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "workspace", name: "Closed session", projectId: "project" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/repo", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) }),
    fetchAgentTimeline: async () => { timelineReads++; return readable ? { entries: [], startCursor: null, hasOlder: false, error: null, gap: false, staleCursor: false } : { entries: [], startCursor: null, hasOlder: false, error: "Timeline unavailable", gap: false, staleCursor: false }; },
    listProviderSubagents: async (id: string) => { subagentLists.push(id); return { subagents: [{ status: "running" }] }; },
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon, new SessionGuard(directory, () => now), async () => false);
  const state: State = { version: 1, workspaces: [], projectDefaults: { project: true } };
  return { gateway, state, main, recovery, subagentLists, reads: () => timelineReads, readable: () => { readable = true; }, advance: (ms: number) => { now += ms; } };
}

test("an unreadable transcript is retried with backoff instead of on every poll", async t => {
  const f = await fixture(t);
  const [row] = await f.gateway.discover(f.state); assert.equal(f.reads(), 1);
  assert.match(row.history?.error ?? "", /History could not be read/, "the workspace still explains the unreadable history");
  const polls = async (count: number) => { for (let i = 0; i < count; i++) { f.advance(15_000); await f.gateway.discover(f.state); } };
  await polls(1); assert.equal(f.reads(), 2, "the first retry comes after 15 seconds");
  await polls(1); assert.equal(f.reads(), 2, "the second retry waits 30 seconds");
  await polls(1); assert.equal(f.reads(), 3);
  await polls(4); assert.equal(f.reads(), 4, "then 60 seconds");
  await polls(40); assert.ok(f.reads() <= 7, `a poll every 15 seconds for 10 minutes read ${f.reads()} times`);
  assert.equal(historyRetryDelay(100), 3_600_000, "backoff is capped at one hour");
});

test("a new user message or a recovered read resets the backoff", async t => {
  const f = await fixture(t);
  await f.gateway.discover(f.state); f.advance(15_000); await f.gateway.discover(f.state);
  const before = f.reads(); assert.equal(before, 2);
  f.advance(15_000); await f.gateway.discover(f.state); assert.equal(f.reads(), before, "still backing off");
  f.main.lastUserMessageAt = "2026-01-02T00:00:00Z";
  await f.gateway.discover(f.state); assert.equal(f.reads(), before + 1, "a changed lastUserMessageAt retries immediately");
  f.advance(15_000); await f.gateway.discover(f.state); assert.equal(f.reads(), before + 2, "and restarts the backoff at 15 seconds");
  f.readable(); f.advance(30_000);
  const [row] = await f.gateway.discover(f.state); assert.equal(row.history?.error, null);
  const reads = f.reads(); f.advance(3_600_000); await f.gateway.discover(f.state); assert.equal(f.reads(), reads, "a readable idle transcript is not reread");
});

test("closed and unloaded agents are not asked for provider subagents, which would resume them", async t => {
  const f = await fixture(t); const w = workspace();
  f.main.status = "closed"; assert.equal((await f.gateway.observe(w, true)).busy, false);
  // A stored (unloaded) snapshot reports its last status, usually idle, and has no activeTurn.
  f.main.status = "idle"; delete f.main.activeTurn; assert.equal((await f.gateway.observe(w, true)).busy, false);
  assert.deepEqual(f.subagentLists, []);
  f.main.activeTurn = null; assert.equal((await f.gateway.observe(w, true)).backgroundBusy, true);
  assert.deepEqual(f.subagentLists, ["main-agent"], "only the loaded agent was queried; recovery agents are out of scope");
  const batch = batchSchema.parse({ id: "batch", tasks: [], state: "sent", createdAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), settledAt: null, messageId: "message", attempts: 1, result: "", recipientAgentId: f.recovery.id });
  assert.equal((await f.gateway.recoveryRuntime(w, batch)).busy, false);
  f.recovery.status = "idle"; f.recovery.activeTurn = null; assert.equal((await f.gateway.recoveryRuntime(w, batch)).busy, true);
  assert.deepEqual(f.subagentLists, ["main-agent", "recovery"]);
});

test("0.16: the main agent's live background work holds repairs and Done without asking for subagents", async t => {
  const f = await fixture(t); const w = workspace();
  (f.main as { backgroundWork?: { count: number } }).backgroundWork = { count: 1 };
  const runtime = await f.gateway.observe(w);
  assert.equal(runtime.backgroundBusy, true); assert.equal(runtime.busy, false, "busy stays the agent's turn");
  assert.deepEqual(f.subagentLists, [], "already busy: no subagent request");
  (f.main as { backgroundWork?: { count: number } }).backgroundWork = { count: 0 };
  assert.equal((await f.gateway.observe(w)).backgroundBusy, false);
});
