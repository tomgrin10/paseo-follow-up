import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueEngine } from "./support/queue";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { ScheduledTasks } from "../server/scheduled-tasks";
import { ACTIVE_SCOPE_MIGRATION } from "../shared/settings";
import { DEFAULT_MAX_AUTO_SENDS, LIMIT_REASON, STALE_REASON, sendDecision } from "../shared/send-decision";
import type { Obligation, Workspace } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

// Q177: whether Paseo has an agent loaded is Paseo's detail, never Follow-up's gate. Auto-send goes to any main agent
// the developer used within the active window (activeWindowDays), loaded or not, and at most maxAutoSends of the turns
// Follow-up starts run at once, machine-wide (invariant 133). 2026-11-27: Paseo unloads after 60 idle minutes, so 106
// of 118 main agents read unloaded and Auto-send almost never sent.

const iso = (ms: number) => new Date(ms).toISOString();
const conflicted = (id: string, patch: Partial<Workspace> = {}) => workspace({ id, title: `acme ${id}`, mainAgentId: `${id}-main`, enable_auto_sends: true,
  prs: [pr({ key: `acme/app#${id}`, number: 1, snapshot: snapshot({ conflict: true }) })], ...patch });

/**
 * Engine + queue over several workspaces. Each main agent's runtime is idle unless its turn is running: a send starts
 * one (the agent works on it) until `end(id)`. `loaded` and `recent` say what Paseo reports for it.
 */
async function fixture(t: { after: (f: () => Promise<void>) => void }, ws: Workspace[], o: { loaded?: boolean; recent?: boolean | ((id: string) => boolean); max?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "follow-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = testStore(Store, root);
  await store.mutate(s => { s.workspaces.push(...ws); s.migrations = [ACTIVE_SCOPE_MIGRATION]; if (o.max !== undefined) s.maxAutoSends = o.max; });
  let now = clock; const sends: string[] = []; const running = new Set<string>();
  const recent = (id: string) => typeof o.recent === "function" ? o.recent(id) : o.recent ?? true;
  const gateway: Gateway = {
    prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }),
    observe: async (w): Promise<Runtime> => ({ busy: running.has(w.id), mainBusy: running.has(w.id) ? "turn" : null, reason: null, archived: false, mainLoaded: o.loaded ?? false, mainRecent: recent(w.id) }),
    send: async w => { sends.push(w.id); running.add(w.id); },
    label: async () => {},
  };
  const github = { observe: async (prs: { key: string; snapshot: unknown }[]) => new Map(prs.map(p => [p.key, { snapshot: { ...(p.snapshot as object), observedAt: iso(now) }, error: null }])) };
  const engine = new Engine(store, github as never, gateway, () => now);
  const scheduled = new ScheduledTasks({ snapshot: () => store.snapshot(), mutateWorkspace: (id, work) => store.mutateWorkspace(id, work), agent: async id => ({ status: "idle", archived: false, workspaceId: id.replace(/-main$/, "") }), now: () => now });
  engine.scheduledTasks = scheduled;
  const q = await queueEngine(engine, gateway, root, { deliver: async target => { running.add(target.workspaceId!); sends.push(`requested:${target.workspaceId}`); return target.recipients[0]!; } });
  scheduled.attachQueue(q.queue);
  /** Two ticks a settle window apart: new batches form, then go out. */
  const pass = async () => { await engine.tick(); now += 61_000; await engine.tick(); };
  return {
    store, engine, sends, pass,
    tick: () => engine.tick(), advance: (ms: number) => { now += ms; }, at: () => now,
    end: (id: string) => { running.delete(id); },
    get: async (id: string) => (await store.snapshot()).workspaces.find(w => w.id === id)!,
  };
}

test("an unloaded main agent the developer used within the active window gets its repair (Q177: load state never gates Auto-send)", async t => {
  const f = await fixture(t, [conflicted("w1")], { loaded: false, recent: true });
  await f.pass();
  assert.deepEqual(f.sends, ["w1"], "the send resumes the unloaded agent");
  const w = await f.get("w1");
  assert.equal(w.batches[0].state, "sent");
  assert.equal(w.sendWait ?? null, null);
});

test("a main agent not used within the active window waits for the developer's Send, in plain words", async t => {
  const f = await fixture(t, [conflicted("w1")], { loaded: true, recent: false });
  await f.pass();
  assert.deepEqual(f.sends, [], "loaded or not, past the window nothing goes out on its own");
  const w = await f.get("w1");
  assert.equal(w.batches[0].state, "pending");
  assert.equal(w.sendWait, "stale");
  const d = sendDecision(w, f.at());
  assert.equal(d.send, false);
  assert.equal(d.waitingOn, "you");
  assert.equal(d.reason, STALE_REASON);
  assert.equal(d.canSendNow, true, "the developer's Send still goes");
  await f.engine.sendPending("w1", w.batches[0].id);
  assert.deepEqual(f.sends, ["w1"]);
});

test("invariant 133: a third concurrent Auto-send waits for a free turn, then goes as one ends (oldest first)", async t => {
  assert.equal(DEFAULT_MAX_AUTO_SENDS, 2);
  const f = await fixture(t, [conflicted("w1"), conflicted("w2"), conflicted("w3")]);
  await f.pass();
  assert.deepEqual(f.sends, ["w1", "w2"], "two at once by default");
  let w3 = await f.get("w3");
  assert.equal(w3.batches[0].state, "pending");
  assert.equal(w3.sendWait, "limit");
  const d = sendDecision(w3, f.at());
  assert.deepEqual([d.send, d.waitingOn, d.reason], [false, "follow-up", LIMIT_REASON]);
  assert.equal(d.canSendNow, true, "the limit never holds the developer's Send");

  // Still running a minute later: w3 keeps waiting.
  f.advance(61_000); await f.tick();
  assert.deepEqual(f.sends, ["w1", "w2"]);
  // w1's turn ends without an acknowledgment yet: the turn no longer counts, so w3 goes.
  f.end("w1"); f.advance(61_000); await f.tick();
  assert.deepEqual(f.sends, ["w1", "w2", "w3"]);
  w3 = await f.get("w3");
  assert.equal(w3.batches[0].state, "sent");
  assert.equal(w3.sendWait ?? null, null);
});

test("invariant 133: the limit is the developer's setting (1-10)", async t => {
  const one = await fixture(t, [conflicted("w1"), conflicted("w2")], { max: 1 });
  await one.pass();
  assert.deepEqual(one.sends, ["w1"]);
  assert.equal((await one.get("w2")).sendWait, "limit");
  const three = await fixture(t, [conflicted("w1"), conflicted("w2"), conflicted("w3")], { max: 3 });
  await three.pass();
  assert.deepEqual(three.sends, ["w1", "w2", "w3"]);
});

test("invariant 133: the developer's Send and messages an agent asked for are never held by the limit and never count", async t => {
  const f = await fixture(t, [conflicted("w1"), conflicted("w2"), conflicted("w3")]);
  await f.pass();
  assert.deepEqual(f.sends, ["w1", "w2"]);
  // Both turns taken: the developer's Send on w3 goes at once.
  const w3 = await f.get("w3");
  await f.engine.sendPending("w3", w3.batches[0].id);
  assert.deepEqual(f.sends, ["w1", "w2", "w3"]);

  // A time trigger the agent asked for goes out while every turn is taken.
  const g = await fixture(t, [conflicted("w1"), conflicted("w2"), workspace({ id: "w4", mainAgentId: "w4-main", prs: [],
    obligations: [{ id: "recheck", title: "Recheck the registry", status: "waiting", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "at", delayDays: 0, at: iso(clock + 30_000) } } as Obligation] })]);
  await g.pass();
  assert.deepEqual(g.sends.sort(), ["requested:w4", "w1", "w2"], "the requested message went while both Auto-send turns ran");

  // Turns the developer or an agent started don't take a turn from Auto-send: with w1 running on a developer Send and
  // w2 on a requested message, two Auto-sends still go.
  const h = await fixture(t, [conflicted("a1", { enable_auto_sends: false }), conflicted("a2"), conflicted("a3"), workspace({ id: "w4", mainAgentId: "w4-main", prs: [],
    obligations: [{ id: "recheck", title: "Recheck the registry", status: "waiting", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "at", delayDays: 0, at: iso(clock + 30_000) } } as Obligation] })]);
  await h.tick();
  const a1 = await h.get("a1");
  await h.engine.sendPending("a1", a1.batches[0].id);
  h.advance(61_000); await h.tick();
  assert.deepEqual(h.sends.sort(), ["a1", "a2", "a3", "requested:w4"]);
});

test("invariant 133: a batch that waits on the developer never holds a turn (two failed Auto-sends, a third still sends)", async t => {
  const f = await fixture(t, [conflicted("w1"), conflicted("w2"), conflicted("w3", { enable_auto_sends: false })]);
  await f.pass();
  assert.deepEqual(f.sends, ["w1", "w2"]);
  // Both sends fail the way the queue reports a failure: "check the agent's chat, then retry" waits on the developer.
  // The record still says Auto-send dispatched them (an older release left the flag), and their turns ended.
  await f.store.mutate(s => { for (const w of s.workspaces.filter(w => w.id !== "w3")) Object.assign(w.batches[0], { state: "uncertain", automatic: true, result: "Follow-up couldn't confirm the agent got it. Check the agent's chat, then retry." }); });
  f.end("w1"); f.end("w2");
  await f.store.mutateWorkspace("w3", w => { w.enable_auto_sends = true; });
  await f.pass();
  assert.deepEqual(f.sends, ["w1", "w2", "w3"], "the queue no longer moves them, so they hold no turn");
  assert.equal((await f.get("w3")).sendWait ?? null, null);

  // The failure itself hands the batch to the developer: Batch.automatic goes with it.
  const w1 = await f.get("w1");
  await f.store.mutateWorkspace("w1", w => { w.batches[0].state = "pending"; w.batches[0].automatic = true; });
  await (f.engine as unknown as { projectRepair(item: unknown): Promise<void> }).projectRepair({ state: "failed", gone: null, reason: null, ref: { workspaceId: "w1", batchId: w1.batches[0].id } });
  const failed = (await f.get("w1")).batches[0];
  assert.equal(failed.state, "uncertain");
  assert.equal(failed.automatic, undefined);
});
