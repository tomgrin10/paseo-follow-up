import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { UsageReader } from "../server/usage";
import { AboutService, AboutStore, type AboutContext } from "../server/about";
import { pendingPollMs } from "../shared/about";
import { AiJobs } from "../server/ai-jobs";
import { RpcTiming } from "../server/rpc-timing";
import { newEntry, reduce } from "../shared/inbox";
import { settleTime } from "./support/hanging-host";
import { workspace } from "./fixtures";

/**
 * Client RPCs reply from what the worker already holds (2026-11-12, task "make every client RPC reply fast"). The
 * live `[follow-up] slow rpc` lines ranked them: follow.usage (15 slow in four hours, p90 2.5 s), follow.workspace-about
 * (2, up to 2.5 s), follow.inbox-list (1, 1.5 s); Paseo's own log showed the desktop app's plugin RPCs at p50 0.85 s,
 * mostly under the old 1 s log threshold. The rule for each: answer from the last snapshot at once, refresh after,
 * and let the client's next poll carry the refresh. Only a first read with nothing cached waits, briefly. Every test
 * here hangs the slow side (Paseo's directory, Smart Session, the history read) and fails on main.
 */
const ACK_MS = 500;
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const hang = <T>() => new Promise<T>(() => undefined);

test("slow rpc logging: a call slower than the ack budget logs, a fast one doesn't", async () => {
  const lines: string[] = [];
  const timing = new RpcTiming(undefined, line => lines.push(line));
  await timing.timed("follow.fast", async () => undefined)();
  await timing.timed("follow.slow", () => new Promise(r => setTimeout(r, ACK_MS + 50)))();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^\[follow-up\] slow rpc follow\.slow \d+ ms/);
});

test("usage answers from its last reading while Smart Session hangs, and refreshes after", async () => {
  let now = NOW; let answer: () => Promise<unknown> = async () => ({ windows: [{ id: "five_hour", pct: 40, resetsAt: null }] });
  const home = await mkdtemp(join(tmpdir(), "follow-usage-ack-"));
  try {
    await mkdir(join(home, "plugin-data", "smart-session"), { recursive: true });
    const reader = new UsageReader(home, async (_p, method) => method === "smart-session.subscriptions" ? { zerosub: false, accounts: [] } : answer(), () => now);
    assert.equal((await reader.read()).accounts[0]?.windows[0]?.pct, 40);
    answer = hang; now += 120_000;
    const r = await settleTime(() => reader.read(), 5_000);
    assert.ok(r.ms !== null && r.ms < ACK_MS, `usage took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with Smart Session hanging`);
    assert.equal((await reader.read()).accounts[0]?.windows[0]?.pct, 40, "the last reading, not nothing");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("usage's first read, with nothing cached and Smart Session silent, answers 'no usage' instead of hanging", async () => {
  const home = await mkdtemp(join(tmpdir(), "follow-usage-ack-"));
  try {
    const reader = new UsageReader(home, () => hang(), () => NOW);
    const r = await settleTime(() => reader.read(), 5_000);
    assert.ok(r.ms !== null && r.ms < ACK_MS, `first usage read took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`}`);
    assert.equal(r.error, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function aboutService(history: () => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "follow-about-ack-"));
  const w = workspace({ id: "w1", title: "Vendor query", goal: "Speed up the vendor activity query (HER-1312)", mainAgentId: "a1", prs: [] });
  const ctx = { history, subagents: async () => [] } as unknown as AboutContext;
  const s = new AboutService({
    store: new AboutStore(dir), jobs: new AiJobs({ runner: () => hang() }), sources: {} as never,
    workspace: async id => id === w.id ? w : null, context: () => ctx, usage: async () => ({ accounts: [] }), now: () => NOW,
  });
  return { s, done: () => rm(dir, { recursive: true, force: true }) };
}
const linked = (v: { links: { key: string }[] }) => v.links.some(l => l.key === "HER-1312");

test("workspace-about: a fast read of the inputs answers in full on the first reply, links included", async () => {
  const { s, done } = await aboutService(async () => ({ first: [], items: [], source: "live" }));
  try {
    const started = performance.now();
    const first = await s.view("w1", { open: true });
    assert.ok(performance.now() - started < ACK_MS);
    assert.ok(linked(first), "the links are on the first reply when the read is fast");
  } finally { await done(); }
});

test("workspace-about: a slow read replies pending within the budget, and the next poll carries the links", async () => {
  let release!: () => void; const read = new Promise<void>(r => { release = r; });
  const { s, done } = await aboutService(async () => { await read; return { first: [], items: [], source: "live" }; });
  try {
    const r = await settleTime(() => s.view("w1", { open: true }), 5_000);
    assert.ok(r.ms !== null && r.ms < ACK_MS, `workspace-about took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with the history read slow`);
    const first = await s.view("w1", { open: true });
    assert.equal(first.status, "pending"); assert.equal(linked(first), false);
    release(); await new Promise(r => setTimeout(r, 10));
    assert.ok(linked(await s.view("w1", { open: true })), "the next poll carries the links");
  } finally { await done(); }
});

test("workspace-about: while pending the client asks again after 500 ms, backing off to 3 s", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(pendingPollMs), [500, 1_000, 2_000, 3_000, 3_000]);
});

const agent = (id: string, title: string): AgentInfo => ({ id, workspaceId: "w", parentAgentId: null, title, status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null });

async function inbox(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-inbox-ack-"));
  let agents: () => Promise<AgentInfo[]> = async () => [agent("main", "Main")];
  const cleared: string[][] = [];
  let clear: (ids: string[]) => Promise<void> = async ids => { cleared.push(ids); };
  const directory = { agents: () => agents(), workspaces: async () => [{ id: "w", name: "W" }], agent: async () => null, tail: async () => [], clearAttention: (ids: string[]) => clear(ids) } as unknown as Directory;
  let now = NOW;
  const box = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false } as never,
    guard: async () => null, graceMs: 5, now: () => now } as never);
  await box.store.mutate(s => { const at = new Date(NOW).toISOString(); s.importedAt = at; s.lastSeen = at; s.primedAt = at; s.notifiedAt = at; s.entries.main = reduce(newEntry("main"), { type: "turn_end", outcome: "completed", detail: "Opened PR #815" }, at); });
  t.after(async () => { box.stop(); await rm(dir, { recursive: true, force: true }); });
  return { box, cleared, hangAgents: () => { agents = () => new Promise(() => undefined); }, setAgents: (f: () => Promise<AgentInfo[]>) => { agents = f; }, hangClear: () => { clear = () => new Promise(() => undefined); }, tick: (ms: number) => { now += ms; } };
}

test("inbox-list answers from the last directory snapshot while Paseo is slow, and the next list carries the refresh", async t => {
  const { box, hangAgents, setAgents, tick } = await inbox(t);
  assert.equal((await box.list()).rows[0]?.title, "Main");
  hangAgents(); tick(60_000);
  const r = await settleTime(() => box.list(), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `inbox-list took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with Paseo's directory hanging`);
  assert.equal(r.error, null);
  // Paseo answers again: the hung read is abandoned (deadline), the next refresh lands.
  (box as unknown as { directoryRefresh: null }).directoryRefresh = null;
  setAgents(async () => [agent("main", "Renamed")]);
  await box.refreshDirectory();
  assert.equal((await box.list()).rows[0]?.title, "Renamed", "the refreshed snapshot shows on the next list");
});

test("inbox-list's first call, with no snapshot and Paseo silent, says it's loading instead of hanging", async t => {
  const { box, hangAgents } = await inbox(t);
  hangAgents();
  const r = await settleTime(() => box.list(), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `first inbox-list took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`}`);
  assert.match(r.error ?? "", /still loading/);
});

test("inbox-act signs off within ACK_MS while Paseo's clear-attention hangs; the dot is cleared after", async t => {
  const { box, cleared, hangClear } = await inbox(t);
  await box.list();
  hangClear();
  const r = await settleTime(() => box.act({ action: "sign_off", agentIds: ["main"] }), 5_000);
  assert.ok(r.ms !== null && r.ms < ACK_MS, `inbox-act took ${r.ms === null ? "more than 5 s" : `${Math.round(r.ms)} ms`} with clear-attention hanging`);
  assert.equal(r.error, null);
  assert.equal((await box.store.snapshot()).entries.main?.needs, null, "signed off in our store before the reply");
});

test("inbox-act clears Paseo's unread dot once the reply is out", async t => {
  const { box, cleared } = await inbox(t);
  await box.act({ action: "sign_off", agentIds: ["main"] });
  await box.idle();
  assert.deepEqual(cleared, [["main"]]);
});
