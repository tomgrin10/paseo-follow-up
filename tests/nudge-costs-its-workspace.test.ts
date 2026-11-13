import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../server/engine";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { daemonDirectory } from "../server/inbox-directory";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import { Store } from "../server/store";
import { TurnTimeline } from "../server/turn-timeline";
import { ACTIVE_SCOPE_MIGRATION } from "../shared/settings";
import { clock, pr, workspace } from "./fixtures";

// Invariant a-nudge-costs-its-workspace. Run Y, 2026-11-13 (the CI live shape: 140 workspaces, turns ending every few
// seconds): every turn end's nudge ran the whole tick, discovery over all 140 workspaces and a whole-state copy included,
// and the burst grew V8's committed pages from 87 to 165 MB. A nudge now discovers only its workspace's dirty agents,
// from the turn read already in hand, and observes only its workspace; the timer's tick still covers everything.

const N = 140;
const NUDGES = 20;

/** Paseo's timeline store per agent, as tests/turn-read-once.test.ts fakes it: `after` is exclusive, oldest first. */
function timelines() {
  const epoch = "e1"; const all = new Map<string, { seqStart: number; item: unknown }[]>();
  let requests = 0;
  const items = (id: string) => all.get(id) ?? (all.set(id, []), all.get(id)!);
  const add = (id: string, item: unknown) => { const list = items(id); list.push({ seqStart: list.length, item }); };
  const fetch = async (id: string, o: { direction: string; cursor?: { epoch: string; seq: number }; limit: number }) => {
    requests++; const list = items(id);
    if (o.direction === "after") {
      const page = list.filter(i => i.seqStart > o.cursor!.seq).slice(0, o.limit);
      const last = page.at(-1)?.seqStart;
      return { entries: page, startCursor: page.length ? { epoch, seq: page[0]!.seqStart } : null, endCursor: last !== undefined ? { epoch, seq: last } : null, epoch, reset: false, hasOlder: true, hasNewer: last !== undefined && last < list.length - 1, error: null, gap: false, staleCursor: false };
    }
    const endSeq = o.direction === "tail" ? list.length : o.cursor!.seq;
    const page = list.slice(Math.max(0, endSeq - o.limit), endSeq);
    const first = page[0]?.seqStart ?? 0;
    return { entries: page, startCursor: page.length ? { epoch, seq: first } : null, endCursor: list.length ? { epoch, seq: list.length - 1 } : null, epoch, reset: false, hasOlder: first > 0, error: null, gap: false, staleCursor: false };
  };
  return { add, fetch, requests: () => requests };
}

/** 140 followed workspaces, one main agent each; `live` agents are loaded (their histories are read), the rest closed. */
async function setup(t: { after: (fn: () => Promise<void>) => void }, live: number[]) {
  const dir = await mkdtemp(join(tmpdir(), "follow-nudge-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = clock;
  const agents: Agent[] = Array.from({ length: N }, (_, i) => ({ id: `a${i}`, workspaceId: `w${i}`, provider: "claude", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", status: live.includes(i) ? "idle" : "closed", ...(live.includes(i) ? { activeTurn: null } : {}), labels: {}, lastUserMessageAt: new Date(clock).toISOString(), pendingPermissions: [] }) as unknown as Agent);
  const tl = timelines();
  for (const i of live) for (let n = 0; n < 10; n++) tl.add(`a${i}`, { type: "assistant_message", text: `Earlier step ${n}` });
  const client = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: agents.map(a => ({ id: a.workspaceId, name: `Workspace ${a.workspaceId}`, projectId: "project" })), pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgent: async (id: string) => ({ agent: agents.find(a => a.id === id) ?? null }),
    fetchAgentTimeline: tl.fetch,
  } as unknown as Daemon;
  const connect = (async (work: (c: Daemon) => unknown) => work(client)) as typeof withDaemon;
  const gateway = new PaseoGateway(connect, new SessionGuard(join(dir, "guard")), async () => false, new HistoryCache(null), () => now);
  const turns = new TurnTimeline(() => now);
  gateway.turnTimeline = turns;
  const directory = daemonDirectory(gateway.directory, connect, turns);
  const store = new Store(join(dir, "state"));
  await store.mutate(s => {
    s.migrations = [ACTIVE_SCOPE_MIGRATION];
    for (let i = 0; i < N; i++) s.workspaces.push(workspace({ id: `w${i}`, title: `Workspace w${i}`, mainAgentId: `a${i}`, prs: [pr({ key: `example/app#${1000 + i}`, number: 1000 + i })] }));
  });
  const github = { observe: async (prs: { key: string; snapshot: unknown; error: string | null }[]) => new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: p.error }])) };
  const engine = new Engine(store, github as never, gateway, () => now, 60_000, 1);
  // What the engine's discovery cost: full passes (no workspace, no scope) and whole-state copies.
  let full = 0; let copies = 0;
  const discover = gateway.discover.bind(gateway);
  gateway.discover = ((state, workspaceId, scope) => { if (!workspaceId && !scope) full++; return discover(state, workspaceId, scope); }) as typeof gateway.discover;
  const mutate = store.mutate.bind(store);
  store.mutate = (work => { copies++; return mutate(work); }) as typeof store.mutate;
  /** One turn as the worker sees it (index.server.ts): its start's read, its end's read, then the agent marked dirty. */
  const turn = async (i: number, number: number) => {
    const agent = agents[i]!;
    tl.add(agent.id, { type: "user_message", text: `Fixture prompt ${number}` });
    agent.status = "running"; agent.lastUserMessageAt = new Date(now).toISOString();
    await directory.turnStart!(agent.id);
    tl.add(agent.id, { type: "tool_call", status: "completed", detail: { type: "shell", command: "gh pr create --fill", output: `https://github.com/example/app/pull/${number}` } });
    tl.add(agent.id, { type: "assistant_message", text: `Opened PR ${number}` });
    agent.status = "idle"; now += 3_000;
    await directory.turnItems!(agent.id, `turn-${number}`);
    gateway.markDirty(agent.id);
  };
  const prs = async (id: string) => (await store.snapshot()).workspaces.find(w => w.id === id)!.prs.map(p => p.key);
  const counts = () => ({ full, copies, requests: tl.requests() });
  return { engine, turn, prs, counts, advance: (ms: number) => { now += ms; } };
}

test("a-nudge-costs-its-workspace: 20 turn-end nudges of 1 of 140 workspaces run no full discovery and copy no whole state", async t => {
  const { engine, turn, prs, counts, advance } = await setup(t, [0]);
  await engine.tick({ background: true }); // start-up: the full discovery reads w0's history and keeps its cursor
  await turn(0, 1); await engine.nudge("w0"); // the first turn after start-up has no turn cursor yet
  const before = counts();
  for (let n = 2; n < 2 + NUDGES; n++) { await turn(0, n); await engine.nudge("w0"); advance(5_000); }
  const after = counts();
  assert.equal(after.full - before.full, 0, `${after.full - before.full} full discoveries for ${NUDGES} nudges (main: one each)`);
  assert.equal(after.copies - before.copies, 0, `${after.copies - before.copies} whole-state copies for ${NUDGES} nudges (main: one each)`);
  assert.ok(after.requests - before.requests <= 2 * NUDGES, `${after.requests - before.requests} timeline reads for ${NUDGES} turns: the nudges added none to the turns' own`);
  const keys = await prs("w0");
  for (let n = 2; n < 2 + NUDGES; n++) assert.ok(keys.includes(`example/app#${n}`), `PR ${n} shows after its nudge`);
});

test("a-nudge-costs-its-workspace: a turn that opens a PR shows it after the nudge, with no regular tick in between", async t => {
  const { engine, turn, prs, counts } = await setup(t, [0]);
  await engine.tick({ background: true });
  await turn(0, 1); await engine.nudge("w0");
  const before = counts();
  await turn(0, 2);
  assert.ok(!(await prs("w0")).includes("example/app#2"), "not before the nudge");
  await engine.nudge("w0");
  assert.ok((await prs("w0")).includes("example/app#2"), "the PR the turn opened shows after its nudge");
  const after = counts();
  assert.equal(after.full - before.full, 0, "no regular tick ran");
  assert.ok(after.requests - before.requests <= 2, "and the nudge read no timeline past the turn's own two reads");
});

test("a-nudge-costs-its-workspace: the regular tick still discovers everything, including what a nudge left", async t => {
  const { engine, turn, prs, counts, advance } = await setup(t, [0, 7]);
  await engine.tick({ background: true });
  await turn(0, 1); await turn(7, 101); await engine.tick({ background: true }); // turn cursors for both
  await turn(7, 102); // a turn in w7, never nudged
  await turn(0, 2); await engine.nudge("w0");
  assert.ok((await prs("w0")).includes("example/app#2"), "the nudged workspace shows its PR");
  assert.ok(!(await prs("w7")).includes("example/app#102"), "a nudge of w0 never discovers w7");
  // A turn whose kept read expired: the nudge reads nothing and leaves the agent dirty for the full discovery.
  await turn(0, 3); advance(130_000);
  const before = counts();
  await engine.nudge("w0");
  assert.equal(counts().requests - before.requests, 0, "a nudge never reads the daemon's timeline");
  assert.ok(!(await prs("w0")).includes("example/app#3"));
  await engine.tick({ background: true });
  assert.equal(counts().full - before.full, 1, "the regular tick runs the full discovery");
  assert.ok((await prs("w7")).includes("example/app#102"), "and discovers the un-nudged workspace's PR");
  assert.ok((await prs("w0")).includes("example/app#3"), "and the PR whose kept read had expired");
});
