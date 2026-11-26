import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueEngine } from "./support/queue";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { ScheduledTasks, NOT_SENT, scheduledItemId, type ScheduledAgent } from "../server/scheduled-tasks";
import { updateObligation } from "../server/obligations";
import { tasksFor } from "../server/tasks";
import { atLabel, clockLabel, storedTrigger, taskTriggerInputSchema, SCHEDULED_HEADER } from "../shared/task-trigger";
import { taskDue } from "../shared/task-due";
import { taskViewRow } from "../shared/task-view";
import { liveLine } from "../shared/attention";
import { QUEUE_KINDS } from "../shared/queue";
import type { Obligation, Workspace } from "../shared/model";
import { clock, workspace } from "./fixtures";

// a-scheduled-task-arrives-once-at-its-time (invariant 121). Agents that wanted to hear back at a time ("recheck the
// registry PR at 12:15") used a separate defer plugin other Follow-up users don't have, or a sleep loop. A task's
// trigger can now be a time: it goes to the main agent once, at that time, Auto-send on or off.

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const timed = (at: number, patch: Partial<Obligation> = {}): Obligation => ({ id: "registry", title: "Recheck the registry publish", status: "waiting", afterPrs: [], evidence: "Published 1.4.0; the CDN lags.", enable_follow_up: true, revision: 0, trigger: { event: "at", delayDays: 0, at: iso(at) }, ...patch });

async function fixture(t: { after: (f: () => Promise<void>) => void }, w: Workspace, o: { agent?: (id: string) => ScheduledAgent; now?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "follow-scheduled-"));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = o.now ?? clock; let agent = o.agent ?? (() => ({ status: "idle", archived: false, workspaceId: w.id }));
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const sends: string[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }), observe: async () => runtime, send: async (_w, _b, text) => { sends.push(text); }, label: async () => undefined };
  const github = { observe: async (prs: { key: string }[]) => new Map(prs.map(p => [p.key, { snapshot: { ...w.prs.find(x => x.key === p.key)!.snapshot!, observedAt: iso(now) }, error: null }])) };
  const build = () => {
    const engine = new Engine(store, github as never, gateway, () => now);
    const scheduled = new ScheduledTasks({ snapshot: () => store.snapshot(), mutateWorkspace: (id, work) => store.mutateWorkspace(id, work), agent: async id => agent(id), now: () => now });
    engine.scheduledTasks = scheduled;
    return { engine, scheduled };
  };
  let { engine, scheduled } = build();
  const q = await queueEngine(engine, gateway, root);
  scheduled.attachQueue(q.queue);
  // What was enqueued, as enqueued (a sent item keeps only its record in the queue's short tail, without its text).
  const enqueued: ReturnType<typeof q.queue.enqueue>[] = [];
  const enqueue = q.queue.enqueue.bind(q.queue);
  q.queue.enqueue = input => { const item = enqueue(input); if (item.kind === "scheduled" && !enqueued.some(i => i.id === item.id)) enqueued.push({ ...item }); return item; };
  const items = () => enqueued;
  return {
    store, sends, items, get engine() { return engine; }, get scheduled() { return scheduled; },
    get: async () => (await store.snapshot()).workspaces[0],
    advance: (ms: number) => { now += ms; }, at: () => now,
    setAgent: (f: (id: string) => ScheduledAgent) => { agent = f; },
    /** A worker restart: a new engine and evaluator on the same store and queue. */
    restart: async () => { ({ engine, scheduled } = build()); engine.attachQueue(q.queue); scheduled.attachQueue(q.queue); },
  };
}

test("a time trigger is stored in UTC from an ISO time with its offset or inMinutes, and refused when it would guess", () => {
  const now = clock;
  assert.deepEqual(storedTrigger({ event: "at", delayDays: 0, inMinutes: 30 }, undefined, now), { event: "at", delayDays: 0, at: iso(now + 30 * MIN) });
  assert.equal(storedTrigger({ event: "at", delayDays: 0, at: "2026-01-01T14:15:00+02:00" }, undefined, now)!.at, "2026-01-01T12:15:00.000Z");
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0, at: "2026-01-01T12:15:00" }, undefined, now), /offset/, "no offset: the zone would be a guess");
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0, at: "12:15" }, undefined, now), /offset/);
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0 }, undefined, now), /at .*or inMinutes/);
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0, at: iso(now + 10 * MIN), inMinutes: 5 }, undefined, now), /not both/);
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0, at: iso(now - MIN) }, undefined, now), /already here or past/);
  assert.throws(() => storedTrigger({ event: "at", delayDays: 0, at: iso(now + 31 * 86_400_000) }, undefined, now), /at most 30 days/);
  assert.throws(() => storedTrigger({ event: "at", delayDays: 2, inMinutes: 5 }, undefined, now), /no delayDays/);
  assert.throws(() => storedTrigger({ event: "merge", delayDays: 0, inMinutes: 5 }, undefined, now), /go with event "at"/);
  assert.equal(taskTriggerInputSchema.strict().safeParse({ event: "at", sentAt: iso(now) }).success, false, "sentAt is Follow-up's, never an input");
  // Passing the same time back (an update that keeps its trigger) keeps whether it went out, even once it's past.
  const sent = { event: "at" as const, delayDays: 0, at: iso(now - MIN), queuedAt: iso(now - MIN), sentAt: iso(now - MIN) };
  assert.equal(storedTrigger({ event: "at", delayDays: 0, at: sent.at }, sent, now), sent);
});

test("update_obligation takes a time trigger with no PRs, and an ordinary update keeps it", () => {
  const w = workspace({ prs: [] });
  const o = updateObligation(w, { title: "Recheck the registry publish", status: "waiting", trigger: { event: "at", delayDays: 0, inMinutes: 45 }, now: clock });
  assert.equal(o.enable_follow_up, true); assert.equal(o.trigger?.at, iso(clock + 45 * MIN));
  o.trigger!.queuedAt = iso(clock + 45 * MIN);
  updateObligation(w, { id: o.id, title: o.title, status: "waiting", evidence: "Still lagging", now: clock + 50 * MIN });
  assert.equal(o.trigger?.queuedAt, iso(clock + 45 * MIN), "an update that leaves the trigger out never re-arms it");
  updateObligation(w, { id: o.id, title: o.title, status: "waiting", trigger: { event: "at", delayDays: 0, inMinutes: 30 }, now: clock + 50 * MIN });
  assert.deepEqual(o.trigger, { event: "at", delayDays: 0, at: iso(clock + 80 * MIN) }, "a new time is a new send");
});

test("a time trigger fires once at its time, never before, as one scheduled message to the main agent", async t => {
  const f = await fixture(t, workspace({ obligations: [timed(clock + 5 * MIN)] }));
  await f.engine.tick(); assert.equal(f.items().length, 0);
  f.advance(5 * MIN - 1_000); await f.engine.tick();
  assert.equal(f.items().length, 0, "a second early is early");
  assert.equal(tasksFor(await f.get(), f.at()).length, 0, "never a batch: it isn't a repair or a now/merge/deploy task");
  f.advance(1_000); await f.engine.tick();
  assert.equal(f.items().length, 1);
  const item = f.items()[0];
  assert.equal(item.id, scheduledItemId("workspace", "registry", iso(clock + 5 * MIN)));
  assert.equal(item.ref.agentId, "main-agent");
  assert.equal(item.text.split("\n")[0], `${SCHEDULED_HEADER} registry, set for ${iso(clock + 5 * MIN)}: Recheck the registry publish`, "the agent reads the time as ISO with its offset");
  assert.match(item.text, /Where it stood: Published 1\.4\.0/);
  assert.equal((await f.get()).obligations[0].trigger?.queuedAt, iso(clock + 5 * MIN));
  f.advance(MIN); await f.engine.tick(); f.advance(MIN); await f.engine.tick();
  assert.equal(f.items().length, 1, "once");
  assert.equal(f.scheduled.fired.length, 1);
  assert.ok(QUEUE_KINDS.includes("scheduled"));
});

test("Auto-send off still delivers a time trigger, and still holds now, merge and deploy for the developer's Send", async t => {
  const now: Obligation = { id: "now", title: "Post the progress note", status: "pending", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "now", delayDays: 0 } };
  const f = await fixture(t, workspace({ enable_auto_sends: false, prs: [], obligations: [timed(clock + MIN), now] }));
  f.advance(MIN); await f.engine.tick(); f.advance(61_000); await f.engine.tick();
  assert.equal(f.items().length, 1, "the time trigger went to the queue");
  const w = await f.get();
  assert.deepEqual(w.batches.map(b => [b.state, b.tasks.map(t => t.target)]), [["pending", ["now"]]], "the now task waits as a batch for Send");
  assert.equal(f.sends.length, 0, "and nothing auto-sent it");
});

test("a closed or archived agent gets nothing, and the task row says why", async t => {
  for (const [agent, why] of [[{ status: "closed", archived: false }, NOT_SENT.closed], [{ status: "idle", archived: true }, NOT_SENT.archived], [null, NOT_SENT.archived]] as const) {
    const f = await fixture(t, workspace({ obligations: [timed(clock + MIN)] }), { agent: () => agent && { ...agent, workspaceId: "workspace" } });
    f.advance(MIN); await f.engine.tick();
    assert.equal(f.items().length, 0, JSON.stringify(agent));
    const w = await f.get();
    assert.equal(w.obligations[0].trigger?.notSent, why);
    assert.equal(taskViewRow(w.obligations[0], w, {}, f.at()).meta, `Didn't go out · ${why}`);
    f.advance(MIN); await f.engine.tick(); assert.equal(f.items().length, 0, "and never later");
  }
});

test("at send time the channel waits for a running turn, cancels for a closed agent, and the row mirrors the message", async t => {
  const f = await fixture(t, workspace({ obligations: [timed(clock + MIN)] }));
  f.advance(MIN); await f.engine.tick();
  const item = f.items()[0];
  const channel = (f.scheduled as unknown as { queue: { channels: Map<string, { resolve: (i: unknown) => Promise<unknown>; project: (i: unknown) => Promise<void> }> } }).queue.channels.get("scheduled")!;
  f.setAgent(() => ({ status: "running", archived: false, workspaceId: "workspace" }));
  assert.deepEqual(await channel.resolve({ ...item, state: "queued" }), { defer: "waits for the agent's turn to end" });
  f.setAgent(() => ({ status: "idle", archived: false, workspaceId: "workspace" }));
  assert.deepEqual(await channel.resolve({ ...item, state: "queued" }), { target: { workspaceId: "workspace", recipients: ["main-agent"] } }, "idle, loaded or not: it asked for this message");
  f.setAgent(() => ({ status: "closed", archived: false, workspaceId: "workspace" }));
  assert.deepEqual(await channel.resolve({ ...item, state: "queued" }), { cancel: NOT_SENT.closed });
  await channel.project({ ...item, state: "sent", envelope: { messageId: item.messageId, to: "main-agent", at: iso(clock + MIN + 2_000) } });
  let w = await f.get();
  assert.equal(w.obligations[0].trigger?.sentAt, iso(clock + MIN + 2_000));
  assert.equal(atLabel(w.obligations[0].trigger!, clock + MIN, "UTC"), "Sent 10:01");
  await channel.project({ ...item, state: "cancelled", reason: NOT_SENT.closed });
  w = await f.get(); assert.equal(w.obligations[0].trigger?.notSent, NOT_SENT.closed);
});

test("a worker down at the time fires once, late, on its first pass, and a second restart sends nothing more", async t => {
  const f = await fixture(t, workspace({ obligations: [timed(clock + MIN)] }));
  f.advance(25 * MIN); await f.restart(); await f.engine.tick();
  assert.equal(f.items().length, 1);
  assert.match(f.items()[0].text, new RegExp(`set for ${iso(clock + MIN)} \\(late: it went out at ${iso(clock + 25 * MIN)}`));
  await f.restart(); await f.engine.tick(); f.advance(MIN); await f.engine.tick();
  assert.equal(f.items().length, 1, "once across restarts");
});

test("the row, the live line and due by fact read a time trigger in the developer's words", () => {
  const at = Date.parse("2026-01-01T12:15:00Z");
  assert.equal(clockLabel(iso(at), clock, "UTC"), "12:15");
  assert.equal(clockLabel(iso(at + 86_400_000), clock, "UTC"), "tomorrow 12:15");
  assert.equal(clockLabel(iso(at + 3 * 86_400_000), clock, "UTC"), "Jan 4, 12:15");
  assert.equal(clockLabel(iso(at), clock, "Asia/Tokyo"), "21:15", "the developer's zone, not the host's");
  const o = timed(at);
  assert.equal(atLabel(o.trigger!, clock, "UTC"), "Sends 12:15");
  const w = workspace({ prs: [], obligations: [o, { ...timed(at + 3_600_000), id: "later", title: "Later one" }] });
  assert.equal(taskDue(o, w, clock), null, "a pending time trigger is its own clock: no due-by-fact nudge");
  assert.match(taskViewRow(o, w, {}, clock).meta, /^Sends /);
  assert.equal(liveLine(w, clock).text, `Recheck the registry publish · checks back ${clockLabel(iso(at), clock)}`, "the soonest wait names its time");
  const sent = { ...o, trigger: { ...o.trigger!, queuedAt: iso(at), sentAt: iso(at) }, recheckAt: iso(at + 3 * 86_400_000) };
  assert.ok(taskDue(sent, workspace({ prs: [], obligations: [sent] }), at + MIN), "once it went out, due by fact holds the task again");
});

test("the sheet's typed time: a date and time, or just a clock time (today, else tomorrow); its example is never past", async () => {
  const { parseLocalTime, atProblem, localTimeText, atChoices } = await import("../shared/task-trigger");
  const now = new Date(2026, 0, 1, 10, 0).getTime();
  assert.equal(parseLocalTime("2026-01-01 12:15", now), new Date(2026, 0, 1, 12, 15).getTime());
  assert.equal(parseLocalTime("14:30", now), new Date(2026, 0, 1, 14, 30).getTime());
  assert.equal(parseLocalTime("09:30", now), new Date(2026, 0, 2, 9, 30).getTime(), "a time already past today is tomorrow's");
  for (const bad of ["25:00", "2026-02-30 10:00", "next tuesday"]) assert.equal(parseLocalTime(bad, now), null, bad);
  const example = /like (\d{4}-\d\d-\d\d \d\d:\d\d)\./.exec(atProblem(null, now)!)![1];
  assert.equal(atProblem(parseLocalTime(example, now), now), null, "the format example is itself a valid time");
  assert.equal(example, localTimeText(atChoices(now)[2].at));
});
