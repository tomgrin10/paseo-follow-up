import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { daemonDirectory } from "../server/inbox-directory";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import { TurnTimeline } from "../server/turn-timeline";
import { clock } from "./fixtures";

// Invariant a-turn-s-timeline-is-read-once. Run T, 2026-11-13 (a copy of a live install, 20 turns a minute of 31
// entries of 8 KB): each turn made 3.2 timeline reads and fetched ~125 entries for its 31. The turn start read the
// newest 20, the turn end paged back 25 at a time to the prompt (2 reads), and discovery re-read the turn after the
// turn end marked the agent dirty. Every reader of a turn now shares one cursor per agent.

const TURN_ITEMS = 30;
/** Requests a steady-state turn may make: one at its start (the prompt) and one at its end (the turn). */
const READS_PER_TURN = 2;

/** Paseo's timeline store, as tests/incremental.test.ts fakes it: `after` is exclusive, oldest first. */
function timeline() {
  const epoch = "e1"; const items: { seqStart: number; item: unknown }[] = [];
  const add = (item: unknown) => items.push({ seqStart: items.length, item });
  let requests = 0; let fetched = 0;
  const fetch = async (_id: string, o: { direction: string; cursor?: { epoch: string; seq: number }; limit: number }) => {
    requests++;
    if (o.direction === "after") {
      const page = items.filter(i => i.seqStart > o.cursor!.seq).slice(0, o.limit); fetched += page.length;
      const last = page.at(-1)?.seqStart;
      return { entries: page, startCursor: page.length ? { epoch, seq: page[0]!.seqStart } : null, endCursor: last !== undefined ? { epoch, seq: last } : null, epoch, reset: false, hasOlder: true, hasNewer: last !== undefined && last < items.length - 1, error: null, gap: false, staleCursor: false };
    }
    const endSeq = o.direction === "tail" ? items.length : o.cursor!.seq;
    const page = items.slice(Math.max(0, endSeq - o.limit), endSeq); fetched += page.length;
    const first = page[0]?.seqStart ?? 0;
    return { entries: page, startCursor: page.length ? { epoch, seq: first } : null, endCursor: items.length ? { epoch, seq: items.length - 1 } : null, epoch, reset: false, hasOlder: first > 0, error: null, gap: false, staleCursor: false };
  };
  return { add, fetch, count: () => ({ requests, fetched }) };
}

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-turn-once-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = clock;
  const agent = { id: "live", workspaceId: "w", provider: "claude", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", status: "idle", activeTurn: null, labels: {}, lastUserMessageAt: new Date(clock).toISOString(), pendingPermissions: [] } as Agent;
  const tl = timeline();
  for (let i = 0; i < 40; i++) tl.add({ type: "assistant_message", text: `Earlier step ${i}` });
  const client = {
    fetchAgents: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "w", name: "w", projectId: "project" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgent: async () => ({ agent }),
    fetchAgentTimeline: tl.fetch,
  } as unknown as Daemon;
  const connect = (async (work: (c: Daemon) => unknown) => work(client)) as typeof withDaemon;
  const gateway = new PaseoGateway(connect, new SessionGuard(dir), async () => false, new HistoryCache(null), () => now);
  const turns = new TurnTimeline(() => now);
  gateway.turnTimeline = turns;
  const directory = daemonDirectory(gateway.directory, connect, turns);
  await gateway.discover({ version: 1, workspaces: [] });
  /** One turn as the worker sees it: the inbox's turn start, the engine's and inbox's turn end, then discovery. */
  const turn = async (n: number) => {
    tl.add({ type: "user_message", text: `Fixture prompt ${n}` });
    agent.status = "running"; agent.lastUserMessageAt = new Date(now).toISOString();
    const started = await (directory.turnStart?.(agent.id) ?? directory.tail(agent.id, 20));
    for (let i = 0; i < TURN_ITEMS; i++) tl.add({ type: "tool_call", name: "shell", output: "x".repeat(8000) });
    tl.add({ type: "assistant_message", text: `Opened https://github.com/example/app/pull/${n}` });
    agent.status = "idle"; now += 3_000;
    const [ended] = await Promise.all([directory.turnItems!(agent.id, `turn-${n}`), directory.turnItems!(agent.id, `turn-${n}`)]);
    gateway.markDirty(agent.id);
    const [row] = await gateway.discover({ version: 1, workspaces: [] });
    now += 15_000;
    return { started, ended, row };
  };
  return { tl, turn };
}

test("a-turn-s-timeline-is-read-once: a steady turn makes one read at its start and one at its end, each entry fetched once", async t => {
  const { tl, turn } = await setup(t);
  await turn(1); // the first turn after start-up may read back from the tail: no cursor yet
  const before = tl.count();
  const TURNS = 5;
  for (let n = 2; n < 2 + TURNS; n++) await turn(n);
  const after = tl.count();
  const perTurn = (after.requests - before.requests) / TURNS;
  const fetchedPerTurn = (after.fetched - before.fetched) / TURNS;
  assert.ok(perTurn <= READS_PER_TURN, `${perTurn} timeline reads a turn (bound ${READS_PER_TURN}: its start and its end)`);
  assert.ok(fetchedPerTurn <= TURN_ITEMS + 2, `${fetchedPerTurn} entries fetched a turn for a ${TURN_ITEMS + 2}-entry turn`);
});

test("a-turn-s-timeline-is-read-once: the turn's readers still see the prompt, the turn and its PR", async t => {
  const { turn } = await setup(t);
  await turn(1);
  const { started, ended, row } = await turn(2);
  assert.deepEqual(started.map(i => (i as { text?: string }).text).filter(Boolean).at(-1), "Fixture prompt 2", "the turn start sees its prompt");
  const texts = ended.map(i => (i as { text?: string }).text).filter(Boolean);
  assert.equal(texts[0], "Fixture prompt 2", "the turn end starts at its prompt");
  assert.equal(texts.at(-1), "Opened https://github.com/example/app/pull/2", "and ends at its reply");
  assert.equal(ended.length, TURN_ITEMS + 2);
  assert.deepEqual(row?.history?.candidates, ["example/app#1", "example/app#2"], "discovery finds the PR from the turn end's read");
});

test("a-turn-s-timeline-is-read-once: a turn that starts after the kept read makes discovery read the daemon again", async () => {
  let now = clock;
  const turns = new TurnTimeline(() => now);
  const tl = timeline();
  tl.add({ type: "user_message", text: "Fixture prompt" }); tl.add({ type: "assistant_message", text: "Done" });
  const client = { fetchAgentTimeline: tl.fetch } as unknown as Daemon;
  await turns.started(client, "a"); await turns.ended(client, "a");
  assert.ok(turns.since("a", { epoch: "e1", seq: 0 }, 25), "the turn end's read covers discovery's cursor");
  assert.deepEqual((await turns.ended(client, "a")).map(i => (i as { text: string }).text), ["Fixture prompt", "Done"], "a late second reader of the turn gets the turn, not nothing");
  tl.add({ type: "user_message", text: "Next prompt" });
  await turns.started(client, "a");
  assert.equal(turns.since("a", { epoch: "e1", seq: 0 }, 25), null, "a new turn drops the kept read");
  await turns.ended(client, "a");
  now += 130_000;
  assert.equal(turns.since("a", { epoch: "e1", seq: 1 }, 25), null, "and so does age");
});
