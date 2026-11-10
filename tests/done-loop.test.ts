/**
 * Regression: wks_4b27f268b5dc2fc6 (2026-11-10). Three hero-poc PRs merged and deployed, both tasks done, yet the
 * workspace sat in "Follow-up is fixing": the deploy probe failed now and then, declare_done refused twice on a
 * blocker the agent couldn't fix, the chat drew two "Workspace done" cards anyway, and the Done check was created and
 * cancelled every time the probe flapped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, doneGuidance, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { completionGate, summary, type Deployment, type Snapshot, type Workspace } from "../shared/model";
import { deployState } from "../shared/follow-up";
import { toolRow } from "../shared/chat";
import { clock, pr, snapshot, workspace } from "./fixtures";
import type { Obligation } from "../shared/model";

const obligation = (patch: Partial<Obligation> = {}): Obligation => ({ id: "task", title: "Verify behavior", status: "pending", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0, ...patch });

type Probe = Deployment["state"] | "none";
async function fixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-done-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  let now = clock; let probe: Probe = "deployed"; let runtime: Runtime = { busy: false, reason: null, archived: false };
  const deployment = (): Deployment | null => probe === "none" ? null : { state: probe, environment: "production", commits: ["serving"], evidence: probe === "unknown" ? "Could not verify serving production revisions." : "Serving revisions", observedAt: new Date(now).toISOString() };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(now).toISOString(), deployment: deployment() } as Snapshot, error: null }])) };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), observe: async () => runtime, send: async () => {}, label: async () => {} };
  const engine = new Engine(store, github, gateway, () => now);
  return { engine, get: async () => (await store.snapshot()).workspaces[0], advance: (ms: number) => { now += ms; }, probe: (p: Probe) => { probe = p; }, runtime: (r: Runtime) => { runtime = r; }, now: () => now };
}
const shipped = () => workspace({
  prs: ["#1", "#2", "#3"].map((n, i) => pr({ key: `herosecurity/hero-poc${n}`, repo: "herosecurity/hero-poc", number: i + 1, snapshot: snapshot({ state: "MERGED", mergeCommit: `merge-${i}` }) })),
  obligations: [obligation({ id: "verify", title: "Verify on prod", status: "done", afterPrs: ["herosecurity/hero-poc#1"] })],
});

test("a deploy Follow-up never confirmed doesn't block Done: it is accepted with a note", async t => {
  const f = await fixture(t, shipped()); f.probe("unknown");
  await f.engine.tick();
  const result = await f.engine.declareDone("main-agent", "Verified on prod via read-only checks");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.unconfirmed.length, 3);
  assert.deepEqual((await f.get()).completion?.unconfirmed?.length, 3);
  assert.match(result.next, /Deploy not confirmed by Follow-up/);
  assert.equal(summary(await f.get(), f.now()).status, "done");
});

test("once seen serving, a deploy stays latched through probe errors and old observations", async t => {
  const f = await fixture(t, shipped());
  await f.engine.tick();
  const w = await f.get();
  assert.ok(w.prs.every(p => deployState(p, f.now()) === "deployed"));
  f.probe("unknown"); f.advance(10 * 60_000); await f.engine.tick();
  assert.ok((await f.get()).prs.every(p => deployState(p, f.now()) === "deployed"), "a probe error is not a rollback");
  const result = await f.engine.declareDone("main-agent", "Shipped");
  assert.deepEqual(result.blockers, []); assert.deepEqual(result.unconfirmed, [], "latched, so no 'not confirmed' note");
});

test("Done survives probe errors and a busy agent; a rollback takes it back", async t => {
  const f = await fixture(t, shipped());
  await f.engine.tick(); await f.engine.declareDone("main-agent", "Shipped");
  for (const probe of ["unknown", "deployed", "unknown"] as const) { f.probe(probe); f.advance(15_000); await f.engine.tick(); }
  f.runtime({ busy: false, reason: "Agent state unavailable; refresh will retry", archived: false }); f.advance(15_000); await f.engine.tick();
  assert.ok((await f.get()).completion, "observation gaps never revoke Done");
  f.runtime({ busy: false, reason: null, archived: false }); f.probe("pending"); f.advance(15_000); await f.engine.tick();
  assert.equal((await f.get()).completion, null, "positive contrary evidence does");
});

test("declare_done is idempotent: a repeat changes nothing and says so", async t => {
  const f = await fixture(t, shipped());
  await f.engine.tick();
  const first = await f.engine.declareDone("main-agent", "Shipped");
  f.advance(60_000);
  const again = await f.engine.declareDone("main-agent", "Shipped, again");
  assert.equal(first.alreadyDone, false); assert.equal(again.alreadyDone, true);
  assert.equal((await f.get()).completion?.declaredAt, new Date(clock).toISOString());
  assert.match(again.next, /Already Done; nothing changed/);
});

test("the Done check is not created and cancelled as the probe flaps", async t => {
  const f = await fixture(t, shipped());
  for (let i = 0; i < 20; i++) { f.probe(i % 3 === 0 ? "unknown" : "deployed"); f.runtime({ busy: i % 4 === 1, reason: null, archived: false }); f.advance(15_000); await f.engine.tick(); }
  const batches = (await f.get()).batches;
  assert.deepEqual(batches.map(b => b.state), ["pending"], "one Done check for the whole run");
});

test("a blocker the agent can't fix says so, so the agent doesn't retry", () => {
  const w = shipped(); w.prs[0].snapshot!.deployment = { state: "pending", environment: "production", commits: [], evidence: "", observedAt: new Date(clock).toISOString() };
  w.questions = [];
  const gate = completionGate(w, clock);
  assert.deepEqual(gate.blockers.map(b => b.owner), ["wait"]);
  const next = doneGuidance(gate);
  assert.match(next, /Not yours to fix/); assert.match(next, /Don't call declare_done again/);
  const mine = completionGate(workspace({ obligations: [obligation({ status: "pending", title: "Verify tenant data" })] }), clock);
  assert.match(doneGuidance(mine), /Yours to fix, then call declare_done again: Verify tenant data/);
});

test("the chat only draws a Done card from a reply Follow-up wrote", () => {
  const input = { summary: "HER-1454 done" };
  assert.equal(toolRow("declare_done", "completed", input, undefined).done, null, "a missing result is not a success");
  assert.equal(toolRow("declare_done", "completed", input, "not json").done, null);
  const refused = toolRow("declare_done", "completed", input, JSON.stringify({ workspaceId: "w", completion: null, blockers: ["Verify production deployment of x#1"] }));
  assert.equal(refused.done, null); assert.equal(refused.tone, "warning");
  const accepted = toolRow("declare_done", "completed", input, JSON.stringify({ workspaceId: "w", done: true, completion: { summary: "HER-1454 done", declaredAt: "t", unconfirmed: ["x#1"] }, blockers: [] }));
  assert.deepEqual(accepted.done, { summary: "HER-1454 done", unconfirmed: ["x#1"] });
  const repeat = toolRow("declare_done", "completed", input, JSON.stringify({ workspaceId: "w", done: true, alreadyDone: true, completion: { summary: "HER-1454 done", declaredAt: "t" }, blockers: [], next: "Already Done" }));
  assert.equal(repeat.done, null, "a repeat adds no second card"); assert.match(repeat.line, /Already done/);
  const wrapped = toolRow("declare_done", "completed", input, `Result: ${JSON.stringify({ workspaceId: "w", completion: { summary: "s", declaredAt: "t" }, blockers: [] })}`);
  assert.ok(wrapped.done);
});

test("a declaration waiting only on Follow-up's own checks is kept and recorded as Done when they clear", async t => {
  const f = await fixture(t, shipped()); f.probe("pending");
  await f.engine.tick();
  const refused = await f.engine.declareDone("main-agent", "Verified on prod");
  assert.equal(refused.blockers.length, 3); assert.match(refused.next, /records Done on its own/);
  assert.equal((await f.get()).completion, null);
  f.probe("deployed"); f.advance(15_000); await f.engine.tick();
  const w = await f.get();
  assert.equal(w.completion?.summary, "Verified on prod"); assert.equal(w.declaration, null);
  assert.ok(w.batches.every(b => b.state !== "pending"), "no Done check left behind");
});

test("a declaration refused for the agent's own work is not kept", async t => {
  const w = shipped(); w.obligations[0].status = "pending";
  const f = await fixture(t, w);
  const refused = await f.engine.declareDone("main-agent", "Done?");
  assert.match(refused.next, /Yours to fix/);
  assert.equal((await f.get()).declaration, null);
});
