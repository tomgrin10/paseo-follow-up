import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRequests, CONTEXT_FILE } from "../server/context-requests";
import { rm, trackPersistence } from "./support/store-temp-dir";

const input = { workspaceId: "w1", agentId: "a1", cardKey: "agent:a1|Q1", card: "Q1: Which retry policy?", target: "agent" as const, ask: "I don't get it" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "context-requests-"));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const clock = () => now;
  const store = trackPersistence(directory, new ContextRequests(directory, clock));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A reopened store keeps the fixture's clock (a-pinned-clock-reaches-every-instance): on the real one, the pinned
  // ask is older than CONTEXT_KEEP_MS from 2026-11-18T10:00Z on, and the reopened list() prunes it.
  return { directory, store, clock, tick: (ms: number) => { now += ms; } };
}

test("an ask is recorded at once, pushes the feed, and saves behind the reply", async t => {
  const { directory, store, clock } = await fixture(t);
  let pushes = 0;
  store.onChange = () => { pushes++; };
  const { request, fresh } = await store.ask(input, "developer", "a1");
  assert.ok(fresh);
  assert.equal(request.state, "asking");
  assert.equal(pushes, 1);
  await store.flush();
  const saved = JSON.parse(await readFile(join(directory, CONTEXT_FILE), "utf8"));
  assert.equal(saved.requests[0].id, request.id);
  // Reopened: the ask survives a worker restart.
  const again = trackPersistence(directory, new ContextRequests(directory, clock));
  assert.equal((await again.list())[0].id, request.id);
});

test("one open ask per card: asking again returns the open one", async t => {
  const { store } = await fixture(t);
  const first = await store.ask(input, "developer", "a1");
  const second = await store.ask({ ...input, ask: "Why does it matter?" }, "developer", "a1");
  assert.equal(second.fresh, false);
  assert.equal(second.request.id, first.request.id);
  assert.equal((await store.list()).length, 1);
});

test("only the asked agent answers, and the answer settles the ask", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask(input, "developer", "a1");
  await assert.rejects(store.reply(request.id, "someone-else", "No."), /another agent/);
  await assert.rejects(store.reply("ctx-missing", "a1", "No."), /No open context request/);
  const answered = await store.reply(request.id, "a1", "  It picks how often a failed charge retries.  ");
  assert.equal(answered.state, "answered");
  assert.equal(answered.answer, "It picks how often a failed charge retries.");
  assert.ok(answered.settledAt);
});

test("the first turn end after delivery without context_reply settles the ask as chat; one before delivery doesn't", async t => {
  const { store, tick } = await fixture(t);
  const { request } = await store.ask(input, "developer", "a1");
  await store.turnEnded("a1");
  assert.equal((await store.list())[0].state, "asking", "not delivered yet (queued behind a running turn): that turn's end isn't the reply");
  tick(1000);
  await store.delivered(request.id, new Date(Date.parse("2026-11-17T10:00:01.000Z")).toISOString());
  tick(5000);
  await store.turnEnded("someone-else");
  assert.equal((await store.list())[0].state, "asking");
  await store.turnEnded("a1");
  const r = (await store.list()).find(x => x.id === request.id)!;
  assert.equal(r.state, "chat");
});

test("a prompt steered into a turn already running counts: no turn start needed, only the delivery", async t => {
  const { store, tick } = await fixture(t);
  const { request } = await store.ask(input, "developer", "a1");
  await store.delivered(request.id, "2026-11-17T10:00:00.000Z"); // steered into the running turn at once
  tick(30_000);
  await store.turnEnded("a1"); // the running turn ends: there was never a turn_started after the ask
  assert.equal((await store.list())[0].state, "chat");
});

test("after a restart an open ask is re-derived: delivered to an idle agent settles as chat, a failed send fails, a busy one waits", async t => {
  const { directory, store } = await fixture(t);
  const a = (await store.ask(input, "developer", "a1")).request;
  // Four cards: one workspace's question is one card wherever it's asked from (sameCard), so these are other questions.
  const b = (await store.ask({ ...input, cardKey: "agent:a2|Q2", agentId: "a2" }, "developer", "a2")).request;
  const c = (await store.ask({ ...input, cardKey: "agent:a3|Q3", agentId: "a3" }, "developer", "a3")).request;
  const d = (await store.ask({ ...input, cardKey: "agent:a4|Q4", agentId: "a4" }, "developer", "a4")).request;
  await store.flush();
  // A new worker: nothing in memory but the file.
  const again = trackPersistence(directory, new ContextRequests(directory, () => Date.parse("2026-11-17T10:05:00.000Z")));
  await again.reconcile(r => r.id === a.id ? { sent: "2026-11-17T10:00:02.000Z", failed: null, idle: true }
    : r.id === b.id ? { sent: null, failed: "The agent was archived, so the message wasn't sent.", idle: true }
    : r.id === c.id ? { sent: "2026-11-17T10:00:02.000Z", failed: null, idle: false }
    : { sent: null, failed: null, idle: true });
  const by = new Map((await again.list()).map(r => [r.id, r]));
  assert.equal(by.get(a.id)!.state, "chat", "its turn ended while the worker was down");
  assert.equal(by.get(b.id)!.state, "failed");
  assert.match(by.get(b.id)!.error!, /archived/);
  assert.equal(by.get(c.id)!.state, "asking", "still in its turn: its turn end settles it");
  assert.equal(by.get(c.id)!.deliveredAt, "2026-11-17T10:00:02.000Z");
  assert.equal(by.get(d.id)!.state, "asking", "not delivered yet: the queue still owns it");
  await again.turnEnded("a3");
  assert.equal((await again.list()).find(r => r.id === c.id)!.state, "chat");
});

test("context asks ride the queue under the asker's own label, and the queue's settle is their delivery", async () => {
  const source = await readFile("index.server.ts", "utf8");
  assert.match(source, /enqueueMessage\(to\.agentId, out\.request\.cardKey \? agentContextPrompt\(out\.request\) : agentQuestionPrompt\(out\.request, parent\), out\.request\.id, by, refs\)/, "an agent's ask_context isn't labelled the developer");
  assert.match(source, /askAgent\(ask, actorBy\(actor\)/);
  // Turn-end capture rides the worker's one turn read (a-turn-s-timeline-is-read-once), on any provider.
  assert.match(source, /const items = await inboxDirectory\.turnItems![\s\S]{0,3000}turnEnd\.turnEnded\(event\.agent, event\.outcome, event\.turnId \?\? null, items\)[\s\S]{0,300}contextRequests\.turnEnded\(event\.agent\.id, items\)/);
  assert.doesNotMatch(source, /server\.on\("agent\.turn_ended", async event => contextRequests\.turnEnded/, "no second turn-end handler that settles without the items");
  assert.match(source, /item\.messageId\?\.startsWith\("ctx-"\)[\s\S]{0,200}contextRequests\.delivered\(item\.messageId/);
  assert.match(source, /contextRequests\.reconcile\(/);
  assert.doesNotMatch(source, /contextRequests\.turnStarted/);
});

test("a failed send settles the ask as failed with the reason", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask(input, "developer", "a1");
  await store.fail(request.id, "The agent was archived.");
  const r = (await store.list())[0];
  assert.equal(r.state, "failed");
  assert.equal(r.error, "The agent was archived.");
});

test("questions are kept 30 days, then expire", async t => {
  const { store, tick } = await fixture(t);
  await store.ask(input, "developer", "a1");
  tick(29 * 24 * 3_600_000);
  assert.equal((await store.list()).length, 1, "kept as history past the old 24 h");
  tick(2 * 24 * 3_600_000);
  assert.deepEqual(await store.list(), []);
});

test("an Overseer ask left open by 2.2.0-beta.3 settles as chat on load, so nothing hangs in asking", async t => {
  const { directory } = await fixture(t);
  const at = "2026-11-17T09:00:00.000Z";
  const row = (id: string, target: "overseer" | "agent", state: string) => ({ id, workspaceId: "w1", agentId: "a1", cardKey: `k-${id}`, card: "Q1", target, ask: "I don't get it",
    askedOf: target === "overseer" ? "overseer-1" : "a1", state, answer: null, error: null, askedAt: at, settledAt: null, deliveredAt: at, by: "developer" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(directory, CONTEXT_FILE), JSON.stringify({ requests: [row("o1", "overseer", "asking"), row("a1", "agent", "asking")] }));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const store = trackPersistence(directory, new ContextRequests(directory, () => now));
  const list = await store.list();
  assert.equal(list.find(r => r.id === "o1")!.state, "chat", "the Overseer never had context_reply: its answer is in its chat");
  assert.equal(list.find(r => r.id === "o1")!.askedOf, "overseer-1", "the card can open the Overseer's chat");
  assert.equal(list.find(r => r.id === "a1")!.state, "asking", "an ask of the card's agent is untouched");
  await store.flush();
  assert.equal(JSON.parse(await readFile(join(directory, CONTEXT_FILE), "utf8")).requests[0].state, "chat", "and it is saved");
  now += 1;
});
