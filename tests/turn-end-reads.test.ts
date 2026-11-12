import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../server/engine";
import { Store } from "../server/store";
import type { Github } from "../server/github";
import { clock, pr, workspace } from "./fixtures";

/**
 * 2026-11-12: the account's GraphQL budget (5000/h, shared with gh, Graphite and every agent) ran out. Besides the
 * 15 s background ticks, every action and every agent turn end ran engine.tick() with no options: a fresh read of
 * every tracked PR in every workspace, skipping the per-PR backoff (~47 Claude turn ends an hour live). Invariant
 * a-turn-end-never-reads-other-workspaces-prs: a turn end or an action nudges only its own workspace, with backoff,
 * and a burst of nudges is one read. Only an explicit Refresh reads fresh.
 */
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "follow-nudge-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.mutate(s => { s.workspaces.push(
    workspace({ id: "w1", mainAgentId: "a1", prs: [pr({ key: "example/app#1", number: 1 })] }),
    workspace({ id: "w2", mainAgentId: "a2", prs: [pr({ key: "example/app#2", number: 2 })] }),
    workspace({ id: "w3", mainAgentId: "a3", prs: [pr({ key: "example/app#3", number: 3 })] })); });
  const reads: { keys: string[]; o: Parameters<Github["observe"]>[1] }[] = [];
  const github = { observe: async (prs: { key: string; snapshot: unknown }[], o?: Parameters<Github["observe"]>[1]) => { reads.push({ keys: prs.map(p => p.key), o }); return new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: null }])); } };
  const gateway = { observe: async () => ({ busy: false, reason: null, archived: false }), send: async () => {}, prepareRecovery: async () => ({ agentId: "r", contextPath: "c" }), label: async () => {} };
  const engine = new Engine(store, github as never, gateway as never, () => clock, 60_000, 20);
  return { engine, reads };
}

test("a-turn-end-never-reads-other-workspaces-prs: a nudge reads only its workspace's PRs, with backoff", async t => {
  const f = await fixture(t);
  await f.engine.nudge("w2");
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads[0]!.keys, ["example/app#2"], "only the nudged workspace's PRs");
  assert.equal(f.reads[0]!.o?.background, true, "with the per-PR backoff");
  assert.equal(f.reads[0]!.o?.fresh?.size ?? 0, 0, "nothing forced fresh");
});

test("a-turn-end-never-reads-other-workspaces-prs: a burst of turn ends is one read", async t => {
  const f = await fixture(t);
  await Promise.all([f.engine.nudge("w1"), f.engine.nudge("w2"), f.engine.nudge("w1"), f.engine.nudge("w2")]);
  assert.equal(f.reads.length, 1, "four nudges inside the window, one read");
  assert.deepEqual(f.reads[0]!.keys.sort(), ["example/app#1", "example/app#2"]);
  // A nudge with no workspace (a setting that affects all of them) is a background tick: backoff, every workspace.
  await f.engine.nudge();
  assert.deepEqual(f.reads[1]!.keys.sort(), ["example/app#1", "example/app#2", "example/app#3"]);
  assert.equal(f.reads[1]!.o?.background, true);
  // Only an explicit Refresh reads fresh.
  await f.engine.tick({ workspaceId: "w3" });
  assert.deepEqual([...f.reads[2]!.o!.fresh!], ["example/app#3"]);
});

test("a-turn-end-never-reads-other-workspaces-prs: the worker nudges; only the timer and Refresh tick", async () => {
  const source = await readFile("index.server.ts", "utf8");
  const ticks = [...source.matchAll(/engine\.tick\(([^)]*)\)/g)].map(m => m[1]);
  assert.deepEqual(ticks.sort(), ["{ background: true }", "{ workspaceId }"].sort(), "no other caller runs a full tick");
  const turnEnd = source.slice(source.indexOf('server.on("agent.turn_ended"'), source.indexOf('server.on("workspace.archived"'));
  assert.ok(!/engine\.nudge\(\)/.test(turnEnd), "a turn end always names its workspace");
});
