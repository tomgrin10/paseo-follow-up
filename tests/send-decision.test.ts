import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Runtime, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import type { Snapshot, Workspace } from "../shared/model";
import { batchView } from "../shared/status";
import { violations } from "../shared/status-invariants";
import { clock, workspace, pr, snapshot } from "./fixtures";

// The send line and the send are one decision (shared/send-decision.ts, status invariant
// the-send-line-matches-the-send-decision): whatever the line says before a refresh, the refresh does.

async function fixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-send-"));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; let state: Runtime = { busy: false, reason: null, archived: false }; let fresh: Runtime | null = null; let prError: string | null = null; let errorKey: string | null = null;
  const observations = new Map(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: string[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery", contextPath: "/fixture/recovery.json" }), observe: async (_w, live?: boolean) => live && fresh ? fresh : state, send: async (_w, _b, text) => { sends.push(text); }, label: async () => {} };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, prError && (!errorKey || p.key === errorKey) ? { snapshot: null, error: prError } : { snapshot: { ...observations.get(p.key)!, observedAt: new Date(now).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  const get = async () => (await store.snapshot()).workspaces[0];
  return {
    engine, sends, get, now: () => now,
    advance: (ms: number) => { now += ms; },
    runtime: (s: Runtime) => { state = s; }, freshRuntime: (s: Runtime | null) => { fresh = s; },
    observe: (key: string, s: Snapshot) => observations.set(key, s), prError: (e: string | null, key: string | null = null) => { prError = e; errorKey = key; },
    line: async () => batchView(await get(), now)?.line ?? "",
  };
}
const says = (line: string) => /sending (now|in a moment)/.test(line);
const conflicted = () => workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] });

test("regression 2026-11-12: a PR read error with PR tasks queued never says 'sending now' while nothing sends", async t => {
  // #1 has a conflict to fix; #2, in the same workspace, can't be read. Main's line said "sending now" here.
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot() })] }));
  await f.engine.tick(); f.advance(61_000);
  f.prError("GitHub rate limit", "example/app#2");
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.sends.length, 0, "the engine waits for a clean PR read");
  const line = await f.line();
  assert.ok(!says(line), `the line doesn't promise a send: ${line}`);
  assert.match(line, /clean read of #2 \(GitHub rate limit\)/);
  f.prError(null); await f.engine.tick();
  assert.equal(f.sends.length, 1, "it goes out once the PR reads cleanly");
});

test("a tick where the agent just went busy neither sends nor says sending", async t => {
  const f = await fixture(t, conflicted());
  await f.engine.tick(); f.advance(61_000);
  f.runtime({ busy: true, reason: null, archived: false });
  await f.engine.tick();
  assert.equal(f.sends.length, 0);
  assert.match(await f.line(), /sends after the agent's current turn/);
});

test("every refresh does what the line said before it", async t => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => void][] = [
    ["idle", () => {}],
    ["busy", f => f.runtime({ busy: true, reason: null, archived: false })],
    ["background", f => f.runtime({ busy: false, backgroundBusy: true, reason: null, archived: false })],
    ["guarded", f => f.runtime({ busy: false, reason: "Waiting for Session Guard", archived: false })],
    ["unloaded", f => f.runtime({ busy: false, reason: null, archived: false, mainLoaded: false })],
    ["not recent", f => f.runtime({ busy: false, reason: null, archived: false, mainRecent: false })],
    ["pr error", f => f.prError("offline")],
  ];
  for (const [name, apply] of cases) {
    const f = await fixture(t, conflicted());
    await f.engine.tick(); f.advance(61_000); apply(f);
    await f.engine.tick();
    const line = await f.line(), sent = f.sends.length > 0;
    // Past the settle, "sending now" means this refresh sent; anything else names what it waits on.
    assert.equal(sent, name === "idle", `${name}: sent=${sent}`);
    if (!sent) assert.ok(!says(line), `${name}: "${line}" while nothing sent`);
    assert.deepEqual(violations(await f.get(), f.now()), [], name);
  }
});

test("churn: a task list that changes every refresh still sends one settle after the first task", async t => {
  const f = await fixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ threads: [{ id: "a", updatedAt: "t0" }] }) })] }));
  await f.engine.tick();
  const first = (await f.get()).batches.find(b => b.state === "pending")!;
  for (let i = 1; i <= 6; i++) {
    f.advance(10_000);
    f.observe("example/app#1", snapshot({ threads: Array.from({ length: 1 + (i % 2) }, (_, n) => ({ id: `t${n}`, updatedAt: `t${i}` })) }));
    await f.engine.tick();
  }
  f.advance(1_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, "the settle is anchored at the first queued task");
  const w = await f.get();
  assert.equal(w.batches.filter(b => b.state !== "cancelled").length, 1, "one message, updated in place");
  assert.equal(w.batches.find(b => b.state === "sent")!.id, first.id);
});

test("a refused send is the visible reason, retried once per settle window, cleared on send", async t => {
  const f = await fixture(t, conflicted());
  await f.engine.tick(); f.advance(61_000);
  // The dispatch's own fresh read finds the agent busy: the refresh's read said idle.
  f.freshRuntime({ busy: false, reason: "Agent started a turn", archived: false });
  await f.engine.tick();
  assert.equal(f.sends.length, 0);
  let w = await f.get();
  assert.equal(w.batches[0].refusal?.reason, "Agent started a turn");
  assert.match(await f.line(), /didn't send: Agent started a turn · tries again shortly/);
  assert.deepEqual(violations(w, f.now()), []);
  f.freshRuntime(null); f.advance(30_000); await f.engine.tick();
  assert.equal(f.sends.length, 0, "no retry inside the settle window");
  f.advance(31_000); await f.engine.tick();
  assert.equal(f.sends.length, 1, "retried after the window");
  w = await f.get();
  assert.equal(w.batches[0].refusal, undefined, "a send clears the refusal");
});
