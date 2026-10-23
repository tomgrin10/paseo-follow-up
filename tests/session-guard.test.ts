import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionGuard, type GuardPause } from "../server/session-guard";
import { PaseoGateway, type Agent, type Daemon, type withDaemon } from "../server/daemon";
import { DeliveryDeferred } from "../server/delivery";
import { batchSchema } from "../shared/model";
import { tasksFor } from "../server/tasks";
import { clock, workspace, pr, snapshot } from "./fixtures";

const pause = (patch: Partial<GuardPause> = {}): GuardPause => ({ id: "pause", agentId: "main-agent", workspaceId: "workspace", phase: "waiting", turnId: "turn", pausedAt: new Date(clock).toISOString(), settledAt: null, ...patch });
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "follow-guard-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = clock;
  const guard = new SessionGuard(directory, () => now);
  const save = (pauses: GuardPause[]) => writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, pauses }));
  return { guard, save, directory, advance: (ms: number) => { now += ms; } };
}
test("Session Guard phases, workspace secondary agents and legacy records gate follow-up without requiring labels", async t => {
  const f = await fixture(t); const scope = { agentIds: ["main-agent"], workspaceId: "workspace", excludedAgentIds: ["recovery"] };
  assert.equal(await f.guard.read(), null);
  for (const phase of ["pausing", "waiting", "resuming", "attention"] as const) {
    await f.save([pause({ phase, agentId: "secondary" })]); assert.equal(f.guard.waiting(await f.guard.read(), scope)?.phase, phase);
  }
  await f.save([pause({ workspaceId: undefined })]); assert.ok(f.guard.waiting(await f.guard.read(), scope));
  for (const p of [pause({ agentId: "elsewhere", workspaceId: "other" }), pause({ agentId: "recovery" }), pause({ phase: "cancelled", settledAt: new Date(clock).toISOString() })]) {
    await f.save([p]); assert.equal(f.guard.waiting(await f.guard.read(), scope), undefined);
  }
  await writeFile(join(f.directory, "state.json"), "broken"); await assert.rejects(f.guard.read(), /Session Guard state is unavailable/);
  await writeFile(join(f.directory, "state.json"), JSON.stringify({ version: 2, pauses: [] })); await assert.rejects(f.guard.read(), /wait and retry/);
});
test("confirmed resumes allow daemon state to settle; only journaled matching interruptions release generated holds", async t => {
  const f = await fixture(t); const resumed = pause({ phase: "resumed", settledAt: new Date(clock).toISOString() });
  assert.ok(f.guard.waiting([resumed], { agentIds: ["main-agent"] }));
  f.advance(5_001); assert.equal(f.guard.waiting([resumed], { agentIds: ["main-agent"] }), undefined);
  const interruption = { turnId: "turn", at: new Date(clock + 200).toISOString() };
  assert.equal(f.guard.ownsInterruption([resumed], "main-agent", interruption)?.id, resumed.id);
  for (const p of [pause({ stoppedByUser: true }), pause({ dismissed: true }), pause({ phase: "cancelled" }), pause({ turnId: "different" }), pause({ pausedAt: new Date(clock - 61_000).toISOString() })]) assert.equal(f.guard.ownsInterruption([p], "main-agent", interruption), undefined);
  assert.equal(f.guard.ownsInterruption([resumed], "main-agent", { ...interruption, turnId: null }), undefined);
  assert.equal(f.guard.ownsInterruption([pause({ suspension: { rootPid: 123 } })], "main-agent", { ...interruption, kind: "canceled" }), undefined, "native suspension does not cancel the turn; stopping it is a developer action");
  assert.equal(f.guard.ownsInterruption([resumed], "main-agent", { ...interruption, kind: "canceled" }), undefined, "a stop after resume is not the earlier Guard interruption");
});
async function gatewayFixture(t: any) {
  const f = await fixture(t); const w = workspace({ prs: [pr({ snapshot: snapshot({ conflict: true }) })] });
  const main = { id: w.mainAgentId, workspaceId: w.id, labels: {}, status: "idle", pendingPermissions: [] } as unknown as Agent;
  const secondary = { ...main, id: "secondary" };
  const recovery = { ...main, id: "recovery", labels: { "follow-through.recovery": "true" } };
  const agents = [main, secondary, recovery]; const sends: string[] = [];
  let beforeFetch: (() => Promise<void>) | null = null; let rejectSend = false;
  const client = {
    fetchAgent: async (id: string) => { await beforeFetch?.(); return { agent: agents.find(a => a.id === id) }; },
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    fetchWorkspaces: async () => ({ entries: [{ id: w.id, labels: ["Paused"] }], pageInfo: { hasMore: false } }),
    listProviderSubagents: async () => ({ subagents: [] }),
    sendMessage: async (_id: string, text: string) => { if (rejectSend) throw new Error("Lost delivery acknowledgment"); sends.push(text); },
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon, f.guard, async () => false);
  const batch = batchSchema.parse({ id: "batch", tasks: tasksFor(w, clock), state: "sending", createdAt: new Date(clock).toISOString(), sentAt: null, settledAt: null, messageId: "message", attempts: 1, result: "", recipientAgentId: main.id });
  return { ...f, w, main, gateway, batch, sends, beforeFetch: (fn: () => Promise<void>) => { beforeFetch = fn; }, failSend: () => { rejectSend = true; } };
}
test("gateway waits for paused secondary agents, lets recovery stay independent and sends only after resume/idle", async t => {
  const f = await gatewayFixture(t); await f.save([pause({ agentId: "secondary" })]);
  assert.equal((await f.gateway.observe(f.w, true)).guarded, true);
  await assert.rejects(f.gateway.send(f.w, f.batch, "Repair"), DeliveryDeferred); assert.equal(f.sends.length, 0);
  await f.save([pause({ agentId: "secondary", phase: "resumed", settledAt: new Date(clock).toISOString() })]);
  assert.equal((await f.gateway.observe(f.w, true)).guarded, true);
  f.advance(5_001); f.main.status = "running"; assert.equal((await f.gateway.observe(f.w, true)).busy, true);
  await assert.rejects(f.gateway.send(f.w, f.batch, "Repair"), DeliveryDeferred);
  f.main.status = "idle"; await f.save([pause({ agentId: "recovery" })]);
  assert.equal((await f.gateway.observe(f.w, true)).reason, null, "the journal overrides stale Paused labels, and recovery has separate scope");
  await f.gateway.send(f.w, f.batch, "Repair"); assert.deepEqual(f.sends, ["Repair"]);
});
test("a pause arriving during final preflight defers without invoking the daemon send", async t => {
  const f = await gatewayFixture(t); await f.save([]); let calls = 0;
  f.beforeFetch(async () => { if (++calls === 2) await f.save([pause()]); });
  await assert.rejects(f.gateway.send(f.w, f.batch, "Repair"), DeliveryDeferred); assert.equal(f.sends.length, 0);
});
test("unreadable guard state defers; errors after a real send attempt remain ambiguous", async t => {
  const f = await gatewayFixture(t); await writeFile(join(f.directory, "state.json"), "broken");
  await assert.rejects(f.gateway.send(f.w, f.batch, "Repair"), DeliveryDeferred);
  await f.save([]); f.failSend(); await assert.rejects(f.gateway.send(f.w, f.batch, "Repair"), error => error instanceof Error && !(error instanceof DeliveryDeferred));
});
