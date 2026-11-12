import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../shared/model";
import { clock, workspace } from "./fixtures";

// 2026-11-12 (traced harness + live /proc): PaseoGateway.observe ran once per workspace per tick (~96/min live) and
// each run re-read two other plugins' state files from disk (smart-session/compactions.json 276 KB, session-guard
// state.json 118 KB: ~38 MB/min of the worker's 49 MB/min reads) and opened its own daemon WebSocket (96/min).
// InboxStore re-read inbox.json (169 KB) on every mutation.

// PASEO_HOME is read when server/daemon.ts loads: point it at a temp home first.
const home = await mkdtemp(join(tmpdir(), "follow-observe-io-"));
process.env.PASEO_HOME = home;
const { PaseoGateway, sharedDaemon } = await import("../server/daemon");
const { HistoryCache } = await import("../server/history-cache");
const { InboxStore } = await import("../server/inbox");
type Daemon = import("../server/daemon").Daemon; type Agent = import("../server/daemon").Agent;
test.after(() => rm(home, { recursive: true, force: true }));

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, workspaceId: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId, provider: "claude", cwd: "/fixture", createdAt: iso(clock - DAY), status: "idle", activeTurn: null, labels: {}, lastUserMessageAt: iso(clock - 60_000), pendingPermissions: [], ...patch } as Agent);
const rchar = async () => Number(/rchar: (\d+)/.exec(await readFile("/proc/self/io", "utf8"))![1]);
/** Live-sized foreign files with a synthetic shape: N pauses / compaction items for agents that aren't ours. */
async function foreignFiles() {
  await mkdir(join(home, "plugin-data/session-guard"), { recursive: true }); await mkdir(join(home, "plugin-data/smart-session"), { recursive: true });
  const pauses = Array.from({ length: 450 }, (_, i) => ({ id: `pause-${i}`, agentId: `other-${i}`, workspaceId: `other-ws-${i}`, phase: "cancelled", turnId: `turn-${i}`, pausedAt: iso(clock - DAY), settledAt: iso(clock - DAY), suspension: { note: "x".repeat(60) } }));
  const items = Array.from({ length: 900 }, (_, i) => ({ id: `c-${i}`, agentId: `other-${i}`, state: "done", createdAt: iso(clock - DAY), reason: "y".repeat(180) }));
  const guard = JSON.stringify({ version: 1, pauses }), compactions = JSON.stringify({ version: 1, items });
  await writeFile(join(home, "plugin-data/session-guard/state.json"), guard); await writeFile(join(home, "plugin-data/smart-session/compactions.json"), compactions);
  return guard.length + compactions.length;
}
function daemon(agents: Agent[], workspaces: { id: string; name: string; projectId: string }[]) {
  const client = {
    fetchAgents: async () => ({ entries: agents.map(a => ({ agent: structuredClone(a) })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git", projectDisplayName: "app", projectRootPath: "/fixture" }] }),
    fetchAgent: async (id: string) => { const a = agents.find(a => a.id === id); return a ? { agent: structuredClone(a) } : null; },
    fetchAgentTimeline: async () => ({ entries: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false }),
    listProviderSubagents: async () => ({ subagents: [] }),
    setWorkspaceLabel: async () => {},
  } as unknown as Daemon;
  return client;
}
function fixture(size = 24) {
  const workspaces = Array.from({ length: size }, (_, i) => ({ id: `w${i}`, name: `Workspace ${i}`, projectId: "project" }));
  // Loaded agents with a pending batch: observe asks about subagents for every workspace (a daemon request each).
  const agents = workspaces.map((w, i) => agent(`a${i}`, w.id, { lastUserMessageAt: iso(clock - 60_000), loaded: true } as Partial<Agent>));
  const state: State = { version: 1, workspaces: workspaces.map((w, i) => workspace({ id: w.id, mainAgentId: `a${i}`, enable_tracking: true, batches: [{ id: `b${i}`, state: "pending", tasks: [{ kind: "conflict" }], recoveryHandoffs: [] } as never] })) };
  return { client: daemon(agents, workspaces), state };
}

test("observe-reads-shared-files-once-per-tick: a tick over 24 workspaces reads each foreign state file at most once", async () => {
  const bytes = await foreignFiles();
  const f = fixture();
  const gateway = new PaseoGateway((async (work: (c: Daemon) => Promise<unknown>) => work(f.client)) as never, undefined, undefined, new HistoryCache(null), () => clock);
  await gateway.discover(f.state);
  for (const w of f.state.workspaces) await gateway.observe(w); // warm: the first tick reads each file once
  const before = await rchar();
  for (let tick = 0; tick < 3; tick++) for (const w of f.state.workspaces) await gateway.observe(w);
  const read = await rchar() - before;
  // Unchanged files are not read again (main: 3 ticks × 24 workspaces × ~394 KB ≈ 28 MB).
  assert.ok(read < bytes, `3 ticks over 24 workspaces read ${(read / 1024).toFixed(0)} KB; the two files are ${(bytes / 1024).toFixed(0)} KB`);
  // A change is seen on the next observe: a pause for workspace w3's main agent holds it.
  const guard = JSON.parse(await readFile(join(home, "plugin-data/session-guard/state.json"), "utf8"));
  guard.pauses.push({ id: "mine", agentId: "a3", workspaceId: "w3", phase: "waiting", pausedAt: iso(clock) });
  await writeFile(join(home, "plugin-data/session-guard/state.json"), JSON.stringify(guard));
  assert.equal((await gateway.observe(f.state.workspaces[3])).guarded, true, "a rewritten file is read again");
  const queue = JSON.parse(await readFile(join(home, "plugin-data/smart-session/compactions.json"), "utf8"));
  queue.items.push({ agentId: "a5", state: "pending", createdAt: iso(clock) });
  await writeFile(join(home, "plugin-data/smart-session/compactions.json"), JSON.stringify(queue));
  assert.match((await gateway.observe(f.state.workspaces[5])).reason ?? "", /compacting/, "and so is the compaction queue");
});

test("one-daemon-connection-per-tick: a tick over 24 workspaces opens one daemon connection, however many workspaces", async () => {
  const f = fixture(); let opened = 0, closed = 0; let now = 0;
  const connect = sharedDaemon(async () => { opened++; return Object.assign(Object.create(f.client), { close: async () => { closed++; } }); }, { idleMs: 1_000, maxMs: 60_000, now: () => now });
  const gateway = new PaseoGateway(connect, undefined, async () => false, new HistoryCache(null), () => clock);
  await gateway.discover(f.state);
  for (let tick = 0; tick < 4; tick++) {
    await Promise.all(f.state.workspaces.map(w => gateway.observe(w)));
    now += 15_000; await connect.idle(); // the next tick comes 15 s later: past the idle bound
  }
  assert.ok(opened <= 4, `4 ticks over 24 workspaces opened ${opened} connections`);
  assert.equal(closed, opened, "an idle connection is closed");
  // The default gateway shares one bounded connection rather than opening one per call.
  const source = await readFile("server/daemon.ts", "utf8");
  assert.match(source, /constructor\(private connect: typeof withDaemon = sharedConnect/, "PaseoGateway's default connect is the shared one");
});

test("one-daemon-connection-per-tick: closeConnections closes the shared connection within the stop deadline", async () => {
  const { closeConnections } = await import("../server/daemon");
  let closed = 0;
  const connect = sharedDaemon(async () => ({ close: async () => { closed++; } }) as never, { idleMs: 60_000, maxMs: 60_000 });
  await connect(async () => "used");
  const started = Date.now();
  await closeConnections(500 as never);
  assert.equal(closed, 1, "the shared connection is closed on stop");
  assert.ok(Date.now() - started < 600, "within the deadline");
  await assert.rejects(connect(async () => "after stop"), /stopping/, "no new connection after stop");
});

test("InboxStore keeps its state in memory: mutations don't re-read inbox.json", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-inbox-mem-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`agent-${i}`, { agentId: `agent-${i}`, seq: 1, needs: null, snooze: null, undo: null, ledger: [], lastEventAt: iso(clock), note: "z".repeat(400) }]));
  const seed = await new InboxStore(dir).mutate(s => { Object.assign(s.entries, entries); return JSON.stringify(s).length; });
  const inbox = new InboxStore(dir);
  await inbox.snapshot();
  const before = await rchar();
  for (let i = 0; i < 30; i++) await inbox.mutate(s => { s.lastSeen = iso(clock + i * 1000); });
  const read = await rchar() - before;
  assert.ok(seed > 100_000, "a live-sized inbox");
  assert.ok(read < seed, `30 mutations read ${(read / 1024).toFixed(0)} KB of a ${(seed / 1024).toFixed(0)} KB inbox`);
  assert.equal((await inbox.snapshot()).lastSeen, iso(clock + 29_000));
});
