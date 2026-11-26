import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRequests, CONTEXT_FILE } from "../server/context-requests";
import { CONTEXT_MAX, type ContextRequest } from "../shared/catch-up";
import { agentQuestionPrompt, capturedAnswer, migrateContext, questionCounts, questionHistory, questionOutcome, questionsByWorkspace, questionTask, unreadAnswer } from "../shared/your-questions";
import { rm, trackPersistence } from "./support/store-temp-dir";

const free = { workspaceId: "w1", agentId: "a1", cardKey: null, card: "", target: "agent" as const, ask: "Why does the retry use a fixed 30 s gap?", via: "field" as const };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "your-questions-"));
  let now = Date.parse("2026-11-26T10:00:00.000Z");
  const clock = () => now;
  const store = trackPersistence(directory, new ContextRequests(directory, clock));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store, clock, tick: (ms: number) => { now += ms; } };
}
const turn = (id: string, ...after: { type: string; text: string }[]) => [
  { type: "user_message", text: "Earlier work" }, { type: "assistant_message", text: "Unrelated reply" },
  { type: "user_message", text: `Your question (${id})\nThe developer asks: "…"` }, ...after,
];

test("a free question has no card, is always new, and is asked of the agent named", async t => {
  const { store } = await fixture(t);
  const a = await store.ask(free, "developer", "a1");
  const b = await store.ask(free, "developer", "a1");
  assert.ok(a.fresh && b.fresh, "two free questions are two questions, never deduped by a card");
  assert.equal(a.request.cardKey, null);
  assert.equal(a.request.via, "field");
  assert.equal(a.request.askedOf, "a1");
});

test("turn-end capture: the last assistant message after the question is the answer, from its chat", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask(free, "developer", "a1");
  await store.delivered(request.id, "2026-11-26T10:00:00.000Z");
  await store.turnEnded("a1", turn(request.id, { type: "assistant_message", text: "Looking." }, { type: "tool_call", text: "" } as never, { type: "assistant_message", text: "**Because** the gateway retries for 60 s." }));
  const r = (await store.get(request.id))!;
  assert.equal(r.state, "chat");
  assert.equal(r.answer, "Because the gateway retries for 60 s.", "the last message, Markdown emphasis dropped");
  assert.equal(questionOutcome(r), "Answered · from its chat");
  assert.ok(unreadAnswer(r));
});

test("no items (the turn couldn't be read), or nothing said after the question: answered in its chat, no answer", async t => {
  const { store } = await fixture(t);
  const a = (await store.ask(free, "developer", "a1")).request;
  const b = (await store.ask({ ...free, agentId: "a2" }, "developer", "a2")).request;
  await store.delivered(a.id, "2026-11-26T10:00:00.000Z");
  await store.delivered(b.id, "2026-11-26T10:00:00.000Z");
  await store.turnEnded("a1", null);
  await store.turnEnded("a2", turn(b.id));
  for (const id of [a.id, b.id]) {
    const r = (await store.get(id))!;
    assert.equal(r.state, "chat");
    assert.equal(r.answer, null);
    assert.equal(questionOutcome(r), "Answered in its chat");
  }
});

test("capturedAnswer never takes a reply from before the question, and skips Follow-up's hook bookkeeping", () => {
  assert.equal(capturedAnswer([{ type: "assistant_message", text: "Before" }], "ctx-1"), null);
  assert.equal(capturedAnswer(turn("ctx-1", { type: "assistant_message", text: "The answer." }), "ctx-1"), "The answer.");
});

test("context_reply wins over capture: an answered question isn't overwritten at turn end", async t => {
  const { store } = await fixture(t);
  const { request } = await store.ask(free, "developer", "a1");
  await store.delivered(request.id, "2026-11-26T10:00:00.000Z");
  await store.reply(request.id, "a1", "The explicit answer.");
  await store.turnEnded("a1", turn(request.id, { type: "assistant_message", text: "Done, answered." }));
  const r = (await store.get(request.id))!;
  assert.equal(r.state, "answered");
  assert.equal(r.answer, "The explicit answer.");
});

test("Done by the developer reads it; an agent's Done closes it but never reads it for the developer", async t => {
  const { store } = await fixture(t);
  const a = (await store.ask(free, "developer", "a1")).request;
  const b = (await store.ask(free, "developer", "a1")).request;
  await assert.rejects(store.done(a.id, "developer"), /still asking/);
  await store.reply(a.id, "a1", "A.");
  await store.reply(b.id, "a1", "B.");
  const mine = await store.done(a.id, "developer");
  assert.equal(mine.done?.by, "developer");
  assert.ok(mine.readAt);
  assert.ok(!unreadAnswer(mine));
  const agents = await store.done(b.id, "agent:a9");
  assert.equal(agents.done?.by, "agent:a9");
  assert.equal(agents.readAt, null, "only-developer-acts-as-developer");
  assert.ok(unreadAnswer(agents), "still in Needs you until the developer reads it");
});

test("Make a task records the task once; Withdraw only while asking", async t => {
  const { store } = await fixture(t);
  const a = (await store.ask(free, "developer", "a1")).request;
  await assert.rejects(store.tasked(a.id, "T1", "developer"), /answer first/);
  const w = await store.withdraw(a.id, "developer");
  assert.equal(w.state, "withdrawn");
  assert.ok(!unreadAnswer(w), "a withdrawn question has nothing to read");
  await assert.rejects(store.withdraw(a.id, "developer"), /still asking/);
  const b = (await store.ask(free, "developer", "a1")).request;
  await store.reply(b.id, "a1", "Because of the idempotency window.");
  const tasked = await store.tasked(b.id, "T7", "agent:a3");
  assert.equal(tasked.task?.id, "T7");
  assert.equal(tasked.readAt, null, "an agent's task doesn't read it for the developer");
  assert.equal((await store.tasked(b.id, "T8", "developer")).task?.id, "T7", "once");
  assert.equal(questionOutcome(tasked), "Made a task");
  assert.deepEqual(questionTask(tasked), { title: free.ask, note: `Q: ${free.ask}\nA: Because of the idempotency window.` });
});

test("v1 → v2: settled asks become history already read, an open one stays open, and the file is rewritten", async t => {
  const { directory, clock } = await fixture(t);
  const at = "2026-11-26T09:00:00.000Z";
  const v1 = (id: string, state: string) => ({ id, workspaceId: "w1", agentId: "a1", cardKey: `agent:a1|Q${id.length}`, card: "Q1", target: "agent", ask: "I don't get it",
    askedOf: "a1", state, answer: state === "answered" ? "It retries." : null, error: null, askedAt: at, settledAt: state === "asking" ? null : at, deliveredAt: at, by: "developer" });
  await writeFile(join(directory, CONTEXT_FILE), JSON.stringify({ requests: [v1("a", "answered"), v1("bb", "asking")] }));
  const store = trackPersistence(directory, new ContextRequests(directory, clock));
  const [a, b] = await store.list();
  assert.equal(a.readAt, at);
  assert.equal(a.via, "more");
  assert.equal(b.readAt, null);
  assert.equal(b.state, "asking");
  await store.flush();
  const saved = JSON.parse(await readFile(join(directory, CONTEXT_FILE), "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(migrateContext(saved).migrated, false, "migrated once");
});

test("at most CONTEXT_MAX questions per workspace: the oldest of that workspace go, other workspaces keep theirs", async t => {
  const { store } = await fixture(t);
  await store.ask({ ...free, workspaceId: "w2" }, "developer", "a2");
  for (let i = 0; i < CONTEXT_MAX + 3; i++) await store.ask({ ...free, ask: `q${i}` }, "developer", "a1");
  const list = await store.list();
  assert.equal(list.filter(r => r.workspaceId === "w1").length, CONTEXT_MAX);
  assert.equal(list.filter(r => r.workspaceId === "w1")[0].ask, "q3");
  assert.equal(list.filter(r => r.workspaceId === "w2").length, 1);
});

test("per-workspace view, counts and history", async t => {
  const { store } = await fixture(t);
  const a = (await store.ask(free, "developer", "a1")).request;
  await store.ask({ ...free, ask: "Does #412 need a migration?" }, "developer", "a1");
  await store.reply(a.id, "a1", "The gateway retries for 60 s.");
  const list = await store.list();
  const q = questionsByWorkspace(list).get("w1")!;
  assert.equal(q.unread.length, 1);
  assert.equal(q.asking.length, 1);
  assert.equal(questionCounts(q), "1 answer · 1 asking");
  assert.deepEqual(questionHistory(list, { query: "gateway" }).map(r => r.id), [a.id], "searches answers too");
  assert.equal(questionHistory(list, { filter: "open" }).length, 2);
  assert.equal(questionHistory(list, { filter: "tasks" }).length, 0);
});

test("a free question's prompt carries its id and asks for context_reply; a reply carries its thread", () => {
  const r = { id: "ctx-9", ask: "Which timezone?", by: "developer", parentId: null } as Pick<ContextRequest, "id" | "ask" | "by" | "parentId">;
  const p = agentQuestionPrompt(r);
  assert.match(p, /^Your question \(ctx-9\)/);
  assert.match(p, /context_reply/);
  assert.match(p, /requestId "ctx-9"/);
  assert.match(agentQuestionPrompt({ ...r, parentId: "ctx-1" }, { ask: "Why?", answer: "Because." }), /Following up their earlier question "Why\?" and your answer "Because\."/);
  assert.match(agentQuestionPrompt({ ...r, by: "agent:a7" }), /Agent a7, for the developer, asks/);
});
