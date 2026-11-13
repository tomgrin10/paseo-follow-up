import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { HistoryCache } from "../server/history-cache";
import { SessionGuard } from "../server/session-guard";
import { clock } from "./fixtures";

// 1.3.0-beta.4: a live agent's history is re-read every 15 s; only the newest entries should be fetched.
function timeline() {
  let epoch = "e1"; const items: { seqStart: number; item: unknown }[] = [];
  const add = (text: string) => items.push({ seqStart: items.length, item: { type: "assistant_message", text } });
  for (let i = 0; i < 1200; i++) add(i === 3 ? "Opened https://github.com/example/app/pull/1" : `step ${i}`);
  const calls: { direction: string; limit: number; entries?: number }[] = [];
  const fetch = async (_id: string, o: { direction: string; cursor?: { epoch: string; seq: number }; limit: number }) => {
    if (o.direction === "after") {
      // Paseo's timeline store: rows after the cursor's seq, oldest first; another epoch's cursor is stale.
      const stale = o.cursor!.epoch !== epoch;
      const page = stale ? [] : items.filter(i => i.seqStart > o.cursor!.seq).slice(0, o.limit);
      calls.push({ direction: o.direction, limit: o.limit, entries: page.length });
      const last = page.at(-1)?.seqStart;
      return { entries: page, startCursor: page.length ? { epoch, seq: page[0]!.seqStart } : null, endCursor: last !== undefined ? { epoch, seq: last } : null, epoch, reset: stale, hasOlder: true, hasNewer: last !== undefined && last < items.length - 1, error: null, gap: false, staleCursor: stale };
    }
    calls.push({ direction: o.direction, limit: o.limit });
    const endSeq = o.direction === "tail" ? items.length : o.cursor!.seq;
    const page = items.slice(Math.max(0, endSeq - o.limit), endSeq);
    const first = page[0]?.seqStart ?? 0;
    return { entries: page, startCursor: page.length ? { epoch, seq: first } : null, endCursor: items.length ? { epoch, seq: items.length - 1 } : null, epoch, reset: false, hasOlder: first > 0, error: null, gap: false, staleCursor: false };
  };
  return { add, calls, fetch, newEpoch: () => { epoch = "e2"; } };
}

test("a live agent's rescans fetch only the newest entries and keep what was found before", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-incr-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = clock;
  const agent = { id: "live", workspaceId: "w", provider: "claude", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", status: "running", activeTurn: null, labels: {}, lastUserMessageAt: new Date(clock).toISOString(), pendingPermissions: [] } as Agent;
  const tl = timeline();
  const client = {
    fetchAgents: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "w", name: "w", projectId: "project" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgent: async () => ({ agent }),
    fetchAgentTimeline: tl.fetch,
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon, new SessionGuard(dir), async () => false, new HistoryCache(null), () => now);
  await gateway.discover({ version: 1, workspaces: [] });
  assert.deepEqual(tl.calls.map(c => c.limit), [500, 500, 500], "the first read pages through everything");
  tl.calls.length = 0;
  tl.add("Opened https://github.com/example/app/pull/2");
  now += 15_000;
  const [row] = await gateway.discover({ version: 1, workspaces: [] });
  assert.deepEqual(tl.calls, [{ direction: "after", limit: 100, entries: 26 }], "one read forward from the cursor: the new entry and the overlap, not a fixed page of 100");
  assert.equal(gateway.incrementalReads, 1);
  assert.deepEqual(row.history?.candidates, ["example/app#1", "example/app#2"], "old and new candidates are kept");
  tl.calls.length = 0; tl.newEpoch(); now += 15_000;
  await gateway.discover({ version: 1, workspaces: [] });
  assert.equal(tl.calls.length, 4, "a new epoch falls back to a full read (one probe, then three pages)");
});
