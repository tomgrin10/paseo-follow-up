import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEntry, reduce, stateOf, type InboxEvent } from "../shared/inbox";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { Engine, agentWorkspace, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { turnStarted } from "../server/turn-events";
import { archivedAskError, askRefusal, paseoShowsLive, reopenViolations } from "../shared/reopen";
import { queueEngine } from "./support/queue";
import { clock, workspace } from "./fixtures";

/**
 * Invariant 111, an-ask-from-a-live-agent-reaches-the-developer. 2026-11-25: a workspace declared Done was archived in
 * Paseo; the developer unarchived its main agent and gave it new scope in chat, and the agent called needs_you
 * kind=decision twice. Follow-up still read the workspace as archived (w.archived, set by workspace.archived, was
 * cleared only by enroll_workspace) and the inbox row as gone (goneAt, cleared by an unarchive nothing emitted), so no
 * card showed and the agent got no error. Paseo unarchives an agent when it is prompted and sends no event for it.
 */

const T0 = "2026-11-25T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const finished: InboxEvent = { type: "turn_end", outcome: "completed", detail: "Asked about the new scope" };

test("inbox: a reopen clears an archived row, so the agent's next finish flags again", () => {
  const gone = reduce(newEntry("main"), { type: "archive" }, at(0));
  assert.equal(stateOf(reduce(gone, finished, at(1))), "GONE", "before: an archived row swallows every flag");
  const reopened = reduce(gone, { type: "reopen" }, at(1));
  assert.equal(reopened.goneAt, null);
  assert.equal(stateOf(reduce(reopened, finished, at(2))), "NEEDS");
  // Past the 7-day keep (where a plain unarchive no longer restores): reopened too, and the stale flags go.
  const old = reduce(reduce(newEntry("main"), finished, at(0)), { type: "archive" }, at(1));
  const late = reduce(old, { type: "reopen" }, new Date(Date.parse(at(1)) + 9 * 86_400_000).toISOString());
  assert.equal(late.goneAt, null); assert.equal(late.needs, null);
  assert.equal(reduce(newEntry("main"), { type: "reopen" }, at(0)).seq, 0, "a live row: nothing changes");
});

const agent = (patch: Partial<AgentInfo> & { id: string }): AgentInfo => ({ workspaceId: "w1", parentAgentId: null, title: "Main", status: "idle", archivedAt: null, updatedAt: T0, lastUserMessageAt: null, requiresAttention: false, attentionReason: null, ...patch });
async function inboxFor(t: { after: (fn: () => unknown) => void }, agents: AgentInfo[], tail: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "archived-asks-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const directory: Directory = { agents: async () => agents, workspaces: async () => [], agent: async id => agents.find(a => a.id === id) ?? null, tail: async () => tail, clearAttention: async () => {} };
  const inbox = testStore(Inbox, dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false }, guard: async () => null, graceMs: 5, settleMs: 0, now: () => Date.parse(at(5)) });
  await inbox.store.mutate(s => { s.importedAt = T0; s.lastSeen = at(1); s.primedAt = T0; s.notifiedAt = T0; });
  return inbox;
}
const main = { id: "main", workspaceId: "w1", parentAgentId: null };

test("inbox: the developer chatting with an unarchived agent reopens its row (the reported case)", async t => {
  const agents = [agent({ id: "main" })];
  const inbox = await inboxFor(t, agents, [{ type: "user_message", text: "New scope: also export to JSON" }]);
  await inbox.store.mutate(s => { s.entries.main = reduce(s.entries.main ?? newEntry("main"), { type: "archive" }, at(2)); });
  assert.equal(stateOf((await inbox.store.snapshot()).entries.main), "GONE");
  await inbox.turnStarted(main, "t2");
  await inbox.turnEnded(main, { kind: "completed" }, "t2");
  assert.equal(stateOf((await inbox.store.snapshot()).entries.main), "NEEDS", "the turn after the unarchive reaches Needs you");
});

test("inbox: a turn end whose start was missed reopens only once Paseo shows the agent unarchived", async t => {
  const archived = [agent({ id: "main", archivedAt: at(2) })];
  const a = await inboxFor(t, archived);
  await a.store.mutate(s => { s.entries.main = reduce(newEntry("main"), { type: "archive" }, at(2)); });
  await a.turnEnded(main, { kind: "completed" }, "t2");
  assert.equal(stateOf((await a.store.snapshot()).entries.main), "GONE", "a turn the archive ended leaves it archived");
  const b = await inboxFor(t, [agent({ id: "main" })]);
  await b.store.mutate(s => { s.entries.main = reduce(newEntry("main"), { type: "archive" }, at(2)); });
  await b.turnEnded(main, { kind: "completed" }, "t2");
  assert.equal(stateOf((await b.store.snapshot()).entries.main), "NEEDS");
});

test("inbox: an ask (needs_you) reopens the row", async t => {
  const inbox = await inboxFor(t, [agent({ id: "main" })]);
  await inbox.store.mutate(s => { s.entries.main = reduce(newEntry("main"), { type: "archive" }, at(2)); });
  assert.equal(await inbox.reopen("main"), true);
  assert.equal((await inbox.store.snapshot()).entries.main.goneAt, null);
  assert.equal(await inbox.reopen("main"), false, "a live row: nothing to reopen");
});

test("paseoShowsLive: listed, or the record archived with its main agent unarchived in it", () => {
  assert.equal(paseoShowsLive("w1", { archivingAt: null }, null), true);
  assert.equal(paseoShowsLive("w1", { archivingAt: at(0) }, { archivedAt: null, workspaceId: "w1" }), false, "mid-archive");
  assert.equal(paseoShowsLive("w1", undefined, { archivedAt: null, workspaceId: "w1" }), true, "the developer prompted the agent");
  assert.equal(paseoShowsLive("w1", undefined, { archivedAt: at(0), workspaceId: "w1" }), false);
  assert.equal(paseoShowsLive("w1", undefined, { archivedAt: null, workspaceId: "w2" }), false, "moved to another workspace");
  assert.equal(paseoShowsLive("w1", undefined, undefined), false);
});

test("write tools refuse an archived workspace with why and what to call; enroll_workspace and reads still work", () => {
  const state = { version: 1, workspaces: [workspace({ id: "w1", mainAgentId: "main", archived: true })] } as never;
  assert.throws(() => agentWorkspace(state, "main", "write", "w1"), (e: Error) => e.message === archivedAskError("w1") && /needs_you kind=decision/.test(e.message) && /unarchive/.test(e.message));
  assert.equal(agentWorkspace(state, "main", "read", "w1").id, "w1");
  assert.equal(agentWorkspace(state, "main", "write", "w1", "owner", true).id, "w1");
  assert.equal(askRefusal({ id: "w1", archived: false }), null);
});

async function storeWith(t: { after: (fn: () => unknown) => void }, w: ReturnType<typeof workspace>) {
  const root = await mkdtemp(join(tmpdir(), "archived-asks-store-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(w); });
  return { store, root };
}

test("turn start: the main agent's turn reopens its archived workspace and ends its Done; another agent's doesn't", async t => {
  const done = { summary: "Shipped", declaredAt: new Date(clock).toISOString() };
  const { store } = await storeWith(t, workspace({ id: "w1", mainAgentId: "main", archived: true, completion: done, contributorAgentIds: ["helper"] }));
  const other = await turnStarted(store, { id: "helper", workspaceId: "w1" }, "h1");
  assert.equal(other.reopened, null); assert.equal((await store.snapshot()).workspaces[0].archived, true);
  const r = await turnStarted(store, { id: "main", workspaceId: "w1" }, "t2");
  const w = (await store.snapshot()).workspaces[0];
  assert.equal(r.reopened, "w1"); assert.equal(w.archived, false); assert.equal(w.completion, null, "a Done workspace is working again");
});

test("engine: a tick reopens an archived workspace Paseo shows live again, and its Needs-you row", async t => {
  const { store, root } = await storeWith(t, workspace({ id: "w1", mainAgentId: "main", archived: true }));
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  let live: string[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async () => runtime, send: async () => {}, label: async () => {}, reopenable: async ws => ws.filter(w => live.includes(w.id)).map(w => w.id) };
  const engine = new Engine(store, { observe: async () => new Map() } as never, gateway, () => clock);
  await queueEngine(engine, gateway, root);
  const reopened: string[] = []; engine.reopened = ids => reopened.push(...ids);
  await engine.tick();
  assert.equal((await store.snapshot()).workspaces[0].archived, true, "still archived in Paseo: stays archived");
  live = ["w1"];
  await engine.tick();
  assert.equal((await store.snapshot()).workspaces[0].archived, false);
  assert.deepEqual(reopened, ["main"]);
});

test("invariant fixture (2026-11-25): a live agent's workspace read as archived, or its row gone, is the bug", () => {
  const row = { workspaceId: "w1", mainAgentId: "main", paseoLive: true };
  assert.deepEqual(reopenViolations([{ ...row, archived: true, inboxGone: true }]).map(v => v.id), ["an-ask-from-a-live-agent-reaches-the-developer"]);
  assert.equal(reopenViolations([{ ...row, archived: false, inboxGone: true }]).length, 1);
  assert.equal(reopenViolations([{ ...row, archived: false, inboxGone: false }]).length, 0);
  assert.equal(reopenViolations([{ ...row, paseoLive: false, archived: true, inboxGone: true }]).length, 0, "archived in Paseo: archived here is true");
});
