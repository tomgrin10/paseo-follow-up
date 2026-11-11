import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefStep, type Brief, type BriefContent } from "../shared/brief";
import { Inbox, type AgentInfo, type Directory, type Send } from "../server/inbox";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { askQuestion } from "../server/questions";
import { clock, pr, workspace } from "./fixtures";
import { settleTime } from "./support/hanging-host";
import { FakeTimers } from "./support/fake-timers";
import { readFile } from "node:fs/promises";

/**
 * Bug (2026-11-11): "Your answer wasn't sent. Plugin RPC timed out: follow-up.invoke" on a question card.
 *
 * follow.brief-action awaited the message to the agent before replying. For a dormant agent Paseo first resumes it and
 * then waits for its run to start (up to 60 s): 86 s that morning, while a plugin RPC gets 30 s. The answer did arrive,
 * 88 s later, but the card said it hadn't, and Retry sent it again under a new messageId (the agent got Q4 twice).
 *
 * The rule these tests hold: an answer RPC replies once the answer is recorded, within ACK_MS, whatever Paseo does;
 * the send runs after, under one messageId per answer, and a retry or a double click never sends twice.
 *
 * Retry delays and attempt deadlines run on FakeTimers: a test fires them in order and awaits idle(), never the wall
 * clock (the last test below holds that for this file and tests/rpc-ack.test.ts).
 */
const ACK_MS = 500;
const NOW = "2026-11-11T08:52:42.000Z";
const never: Send = () => new Promise(() => undefined);

const content: BriefContent = { source: "agent", kind: "decision", ask: "Which encoding?", sourceLine: "From the agent",
  decisions: [{ id: "D1", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8", consequence: null }, { letter: "B", label: "UTF-8 with BOM", consequence: null }], recommend: null }] } as never;
const open = (): Brief => briefStep(null, { type: "create", id: "brief:t1", turnId: "t1", content, flagged: true, seq: 1, questionIds: [] }, NOW).brief!;

async function inbox(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-answer-ack-"));
  const agent: AgentInfo = { id: "main", workspaceId: "w", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
  const directory = { agents: async () => [agent], workspaces: async () => [{ id: "w", name: "W" }], agent: async () => agent, tail: async () => [], clearAttention: async () => {} } as unknown as Directory;
  const rows: Brief[] = [];
  const box = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never,
    guard: async () => null, graceMs: 5, now: () => Date.parse(NOW), briefs: { sink: async (_a: string, b: Brief) => { rows.push(b); }, call: async () => null, pr: async () => null } } as never);
  const timers = new FakeTimers();
  box.deliveryRetryMs = [15_000, 60_000]; box.deliveryAttemptMs = 120_000; box.timers = timers;
  await box.store.mutate(s => { s.entries.main = { ...(s.entries.main ?? {}), agentId: "main", brief: open() } as never; });
  t.after(async () => { box.stop(); await rm(dir, { recursive: true, force: true }); });
  return { box, rows, timers, brief: async () => (await box.store.snapshot()).entries.main!.brief!, outbox: async () => (await box.store.snapshot()).outbox };
}

test("brief-action replies within ACK_MS while Paseo is still resuming the agent, and the answer is recorded", async t => {
  const { box, brief, outbox } = await inbox(t);
  const r = await settleTime(() => box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0001" }, never), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `brief-action took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with the send still pending; the card's RPC must not wait for delivery`);
  assert.equal(r.error, null);
  const b = await brief();
  assert.equal(b.state, "answered"); assert.equal(b.answerId, "answer-0001"); assert.deepEqual(b.delivery, { state: "sending", error: null });
  assert.equal((await outbox()).length, 1, "the answer waits in the outbox until Paseo confirms it");
});

test("Retry and double clicks: the same answerId never sends twice, and every attempt uses one messageId", async t => {
  const { box, brief, outbox } = await inbox(t);
  const sent: string[] = [];
  let release!: () => void;
  const slow: Send = async (_text, messageId) => { sent.push(messageId); await new Promise<void>(r => { release = r; }); };
  const first = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0002" }, slow);
  // The client's Retry after a lost reply, and a second click, both carry the same answerId.
  const again = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0002" }, slow);
  const third = await box.briefAction("main", { briefId: "brief:t1", choices: [{ decisionId: "D1", choice: "A" }], answerId: "answer-0002" }, slow);
  assert.deepEqual([again.id, third.id], [first.id, first.id]);
  release(); await box.idle();
  assert.equal(sent.length, 1, "one send for one answer");
  assert.equal((await outbox()).length, 0); assert.equal((await brief()).delivery, null, "delivered: nothing pending on the card");
  // A different answer to the same card is still refused: the card was answered.
  await assert.rejects(box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "B", answerId: "answer-0003" }, slow), /already answered/);
});

test("a send that fails is retried under the same messageId, then the card says it failed, and Retry resends it", async t => {
  const { box, brief, outbox, rows, timers } = await inbox(t);
  const ids: string[] = [];
  let ok = false;
  const flaky: Send = async (_text, messageId) => { ids.push(messageId); if (!ok) throw new Error("Agent is busy loading"); };
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0004" }, flaky);
  await box.idle();
  assert.deepEqual(timers.pending, [15_000], "the first attempt failed; one retry waits");
  assert.equal(await timers.fire(), 15_000); await box.idle();
  assert.equal(await timers.fire(), 60_000); await box.idle();
  assert.deepEqual(timers.pending, [], "no retry after the last one");
  assert.equal(ids.length, 3, "the first attempt and two retries");
  assert.equal(new Set(ids).size, 1, "every attempt reuses the answer's messageId, so Paseo's receipts dedupe");
  assert.deepEqual((await brief()).delivery, { state: "failed", error: "Agent is busy loading" });
  assert.equal(rows.at(-1)?.delivery?.state, "failed", "the chat card is updated to say so");
  assert.equal((await outbox())[0].state, "failed", "the answer is kept, not dropped");
  ok = true;
  const retried = await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0004" }, flaky);
  assert.equal(retried.delivery?.state, "sending");
  await box.idle();
  assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 1);
  assert.equal((await brief()).delivery, null); assert.equal((await outbox()).length, 0);
});

test("a hung send is capped: it counts as a failed attempt, never `sending` forever", async t => {
  const { box, brief, timers } = await inbox(t);
  box.deliveryRetryMs = [];
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0005" }, never);
  assert.equal(await timers.fire(), 120_000, "the attempt's deadline"); await box.idle();
  assert.deepEqual((await brief()).delivery, { state: "failed", error: "Paseo didn't confirm the answer in time" });
});

test("an answer recorded before a reload goes out at the next worker start, under the same messageId", async t => {
  const { box, outbox, timers } = await inbox(t);
  await box.briefAction("main", { briefId: "brief:t1", decisionId: "D1", choice: "A", answerId: "answer-0006" }, never);
  const [pending] = await outbox();
  box.stop();
  // Each Inbox's store queues only its own writes: a stopped worker that still wrote could lose the next one's update
  // (beta.67's publish run: the old attempt's deadline fired mid-way and put the delivered answer back, 1 !== 0).
  let writesAfterStop = 0;
  const mutate = box.store.mutate.bind(box.store);
  box.store.mutate = (work => { writesAfterStop++; return mutate(work); }) as typeof box.store.mutate;
  // The worker reloads: a fresh Inbox over the same directory.
  const next = new Inbox(box.store.directory, box["o"]);
  next.timers = new FakeTimers();
  const sent: { agentId: string; messageId: string }[] = [];
  await next.resumeAnswers(agentId => async (_text, messageId) => { sent.push({ agentId, messageId }); });
  await next.idle();
  assert.deepEqual(sent, [{ agentId: "main", messageId: pending.messageId }]);
  assert.equal((await next.store.snapshot()).outbox.length, 0);
  // The stopped worker's attempt gives up afterwards: it must not write its stale outbox back over the new one's.
  assert.equal(await timers.fire(), 120_000); await box.idle();
  assert.equal(writesAfterStop, 0, "a stopped worker writes nothing");
  assert.deepEqual(timers.pending, [], "a stopped worker schedules no retry");
  assert.equal((await next.store.snapshot()).outbox.length, 0);
});

test("answer-question replies within ACK_MS while delivery hangs; the question reads sending until it lands", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-answer-ack-q-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const w = workspace({ prs: [pr()] });
  askQuestion(w, "main-agent", { title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }, { letter: "B", label: "A day" }], recommend: "A" } as never, "work-around", clock);
  await store.mutate(s => { s.workspaces.push(w); });
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  let release!: (to: string) => void;
  const gateway: Gateway = { observe: async () => runtime, send: async () => undefined, label: async () => undefined, prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }),
    deliver: () => new Promise<string>(r => { release = r; }) };
  const engine = new Engine(store, { observe: async () => new Map() } as never, gateway, () => clock);
  const r = await settleTime(() => engine.answer(w.id, "Q1", "A", undefined, "send"), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `answer-question took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with delivery pending`);
  assert.equal((await store.snapshot()).workspaces[0].questions[0].answer!.delivery.state, "sending");
  release("main-agent"); await engine.idle();
  assert.equal((await store.snapshot()).workspaces[0].questions[0].answer!.delivery.state, "sent");
});

test("the card's answer ids pass the RPC's schema, and an undelivered reason reads as one sentence", async () => {
  const { briefActionRpc } = await import("../shared/contracts");
  const { newAnswerId, undeliveredReason } = await import("../shared/brief");
  const ids = new Set(Array.from({ length: 200 }, () => newAnswerId()));
  assert.equal(ids.size, 200, "one per Send, never reused across answers");
  for (const answerId of ids) assert.ok(briefActionRpc.input.safeParse({ agentId: "main", briefId: "brief:t1", answerId }).success, answerId);
  assert.equal(undeliveredReason("Agent is busy loading"), "Agent is busy loading.");
  assert.equal(undeliveredReason(null), "Paseo didn't confirm it.");
});

test("invariant: answer-ack and rpc-ack never wait on the wall clock for retries or deadlines", async () => {
  // settleTime's cap (tests/support/hanging-host.ts) bounds an ACK and is the only timer allowed; retries use FakeTimers.
  for (const file of ["answer-ack.test.ts", "rpc-ack.test.ts"]) {
    const source = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const name = "invariant: answer-ack and rpc-ack never wait";
    const own = file === "answer-ack.test.ts" ? source.slice(0, source.indexOf(name)) : source;
    assert.doesNotMatch(own, /setTimeout|setInterval|\bsleep\(|timers\/promises|deliveryRetryMs = \[\s*\d{1,3}\b/, `${file} waits on real time: fire FakeTimers instead`);
  }
});
