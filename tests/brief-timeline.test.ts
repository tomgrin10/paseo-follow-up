import test from "node:test";
import assert from "node:assert/strict";
import { BriefTimeline } from "../server/brief-timeline";
import { briefSchema, type Brief } from "../shared/brief";
import type { LoadSignals } from "../shared/agent-load";

const card = (id: string) => briefSchema.parse({ id, kind: "action", source: "agent", ask: "Review this", at: "2026-01-01T00:00:00Z", sourceLine: "Agent" });
const fixture = () => {
  let agent: LoadSignals | null = { status: "idle" };
  let current: Brief | null = card("brief:one");
  let fail = false;
  const sent: Brief[] = [];
  const delivery = new BriefTimeline({ loaded: async () => agent, current: async () => current, append: async (_id, b) => { if (fail) throw Error("Unknown agent"); sent.push(b); } });
  return { delivery, sent, get current() { return current; }, set current(b) { current = b; }, set agent(a: LoadSignals | null) { agent = a; }, set fail(b: boolean) { fail = b; } };
};

test("a brief waits while the agent is unloaded, closed or mid-resume, then arrives once", async () => {
  for (const agent of [null, { status: "idle" }, { status: "closed" }, { status: "idle", activeTurn: undefined }]) {
    const f = fixture(); f.agent = agent;
    await f.delivery.sink("main", f.current!);
    await f.delivery.changed();
    assert.equal(f.sent.length, 0, "no timeline request before the agent is loaded");
    f.agent = { status: "idle", activeTurn: null };
    await f.delivery.changed(); await f.delivery.changed();
    assert.deepEqual(f.sent, [f.current]);
  }
});

test("a newer brief drops the deferred old card and same-id edits use the current state", async () => {
  const f = fixture(); await f.delivery.sink("main", f.current!);
  f.current = card("brief:two");
  f.agent = { status: "idle", activeTurn: null };
  await f.delivery.changed(); assert.deepEqual(f.sent, []);
  f.agent = { status: "closed" }; await f.delivery.sink("main", f.current!);
  f.current = { ...f.current!, state: "answered" };
  f.agent = { status: "running" }; await f.delivery.changed();
  assert.deepEqual(f.sent, [f.current]);
});

test("an unload race or missing session retains the card until the next discovery signal", async () => {
  const f = fixture(); f.agent = { status: "running" }; f.fail = true;
  await f.delivery.sink("main", f.current!);
  assert.equal(f.sent.length, 0);
  f.fail = false; await f.delivery.changed();
  assert.deepEqual(f.sent, [f.current]);
});

test("discovery list updates retry a card without a turn, timeline read or resume", async () => {
  const { DaemonDirectory } = await import("../server/directory");
  const { isLoaded } = await import("../shared/agent-load");
  let agent = { id: "main", status: "idle", labels: {}, pendingPermissions: [] };
  let metadataReads = 0;
  const client = {
    fetchAgents: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    listProjects: async () => ({ projects: [] }),
    fetchAgent: async () => { metadataReads++; return { agent }; },
  };
  const directory = new DaemonDirectory(async work => work(client as never));
  const sent: Brief[] = [];
  const current = card("brief:waiting");
  const delivery = new BriefTimeline({
    loaded: async id => isLoaded(directory.cached(id)) ? (await client.fetchAgent()).agent : null,
    current: async () => current,
    append: async (_id, b) => { sent.push(b); },
  });
  let update: Promise<void> = Promise.resolve();
  directory.onAgentsChanged = () => { update = delivery.changed(); };
  await directory.read();
  await delivery.sink("main", current);
  await directory.read({ fresh: "agents" }); await update;
  assert.equal(metadataReads, 0, "dormant agents add no metadata polling");
  assert.deepEqual(sent, []);
  agent = { ...agent, activeTurn: null } as typeof agent;
  await directory.read({ fresh: "agents" }); await update;
  assert.deepEqual(sent, [current]);
  assert.equal(metadataReads, 1, "only confirm once discovery reports loaded");
});

test("concurrent signals share an append and a later edit follows it", async () => {
  const f = fixture(); f.agent = { status: "running" };
  await Promise.all([f.delivery.sink("main", f.current!), f.delivery.changed(), f.delivery.changed()]);
  assert.deepEqual(f.sent, [f.current]);
  f.current = { ...f.current!, state: "answered" };
  await f.delivery.sink("main", f.current!);
  assert.deepEqual(f.sent.map(b => b.state), ["open", "answered"]);
});


test("a loaded agent's previous card still receives its collapsed update", async () => {
  const f = fixture(); f.agent = { status: "running" };
  const old = f.current!;
  await f.delivery.sink("main", old);
  f.current = card("brief:next");
  await f.delivery.sink("main", { ...old, state: "superseded" });
  await f.delivery.sink("main", f.current);
  assert.deepEqual(f.sent.map(b => [b.id, b.state]), [[old.id, "open"], [old.id, "superseded"], ["brief:next", "open"]]);
});
