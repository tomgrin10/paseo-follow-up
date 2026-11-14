import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Daemon, withDaemon } from "../server/daemon";
import { BACKSTOP_REFRESH_MS, DaemonDirectory, DIRTY_REFRESH_MS } from "../server/directory";
import { PrWorkflowStore } from "../server/pr-workflow";
import { clock } from "./fixtures";

// Invariant concurrent-readers-share-one-request. 2026-11-14 (2.0.2-beta.0 live check): project.list came in bursts of
// ~19 back to back every 10 minutes. Each repository's PR-workflow detection (its 10-minute cache expiring) read the
// checkout map, which read the project list through directory.projects(60_000); that judged the whole directory's age,
// which a project re-read never refreshed, so every repository re-listed, and refreshProjects joined no read in flight.

function fake() {
  const requests: Record<string, number> = {};
  const hit = (type: string) => { requests[type] = (requests[type] ?? 0) + 1; };
  const tickle = () => new Promise(r => setImmediate(r));
  const client = {
    fetchAgents: async () => { hit("fetch_agents"); await tickle(); return { entries: [], pageInfo: { hasMore: false, nextCursor: null } }; },
    fetchWorkspaces: async () => { hit("fetch_workspaces"); await tickle(); return { entries: [], pageInfo: { hasMore: false, nextCursor: null } }; },
    listProjects: async () => { hit("project.list"); await tickle(); return { projects: Array.from({ length: 20 }, (_, i) => ({ projectId: `p${i}`, projectKey: `remote:github.com/example/app-${i}`, projectKind: "git", projectDisplayName: `app-${i}`, projectRootPath: `/work/app-${i}` })) }; },
  } as unknown as Daemon;
  return { requests, connect: (async work => work(client)) as typeof withDaemon };
}
const REPOS = Array.from({ length: 19 }, (_, i) => `example/app-${i}`);

test("concurrent-readers-share-one-request: N concurrent project reads of a stale list make one project.list", async () => {
  const d = fake(); let now = clock;
  const directory = new DaemonDirectory(d.connect, () => now);
  await directory.read(); assert.equal(d.requests["project.list"], 1);
  now += DIRTY_REFRESH_MS + 1;
  const lists = await Promise.all(Array.from({ length: 19 }, () => directory.projects(60_000)));
  assert.equal(d.requests["project.list"], 2, "19 concurrent readers, one request");
  assert.ok(lists.every(l => l.length === 20));
  // A minute later, sequential readers: the re-read itself made the list fresh, so only the first one asks again.
  now += 60_000;
  for (let i = 0; i < 19; i++) await directory.projects(60_000);
  assert.equal(d.requests["project.list"], 3, "the project list's own age decides, not the directory's");
});

test("concurrent-readers-share-one-request: a PR-workflow detect pass over N repositories reads the project list once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-detect-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const d = fake(); let now = clock;
  const directory = new DaemonDirectory(d.connect, () => now);
  // A detection cache shorter than the directory's 10-minute backstop, so the pass meets a directory that is over a
  // minute old but not due for a full re-read (live: repositories detected at different times expire in between).
  const ttl = 120_000;
  const store = new PrWorkflowStore(dir, { gtInstalled: async () => true, signedIn: async () => true, initialised: async () => false }, () => now, ttl);
  // As the server wires it (index.server.ts): the checkout map comes from the directory's project list.
  store.paths = async () => new Map((await directory.projects(60_000)).map(p => [p.projectKey.replace("remote:github.com/", ""), [p.projectRootPath!]]));
  await directory.read(); const before = d.requests["project.list"];
  // The detection cache expires for every repository at once, and the directory's project list is over a minute old.
  for (const pass of ["sequential", "concurrent"] as const) {
    now += ttl + 1; const start = d.requests["project.list"];
    if (pass === "sequential") { for (const repo of REPOS) await store.workflow(repo); } // github.ts's observe loop
    else await Promise.all(REPOS.map(repo => store.detect(repo)));
    assert.equal(d.requests["project.list"] - start, 1, `a ${pass} pass over ${REPOS.length} repositories reads the project list once`);
  }
  assert.ok(2 * (ttl + 1) < BACKSTOP_REFRESH_MS, "neither pass is a backstop re-read"); assert.ok(d.requests["project.list"] > before);
});

test("concurrent-readers-share-one-request: concurrent fresh agent reads share one fetch_agents; force still lists anew", async () => {
  const d = fake(); const directory = new DaemonDirectory(d.connect);
  await directory.read(); const base = d.requests.fetch_agents;
  await Promise.all(Array.from({ length: 5 }, () => directory.read({ fresh: "agents" })));
  assert.equal(d.requests.fetch_agents - base, 1, "five concurrent readers, one fetch_agents");
  const pending = directory.read({ fresh: "agents" }); const forced = directory.read({ fresh: "agents", force: true });
  await Promise.all([pending, forced]);
  assert.equal(d.requests.fetch_agents - base, 3, "force needs a list started after it asked, so it doesn't join");
});
