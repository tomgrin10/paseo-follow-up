import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Runtime, type Gateway } from "../server/engine";
import { Store } from "../server/store";
import { AgentActions } from "../server/agent-actions";
import { compact } from "../server/mcp.mjs";
import type { Batch, Obligation, Task, Workspace } from "../shared/model";
import { messageStrip, nextMessageInfo, repairRows } from "../shared/task-rows";
import { sendDecision, SETTLE_REASON } from "../shared/send-decision";
import { taskStatus } from "../shared/task-status";
import { headerLine, liveLine, needsYou } from "../shared/attention";
import { workspaceHeadline } from "../shared/headline";
import { violations } from "../shared/status-invariants";
import { clock, workspace, pr, snapshot } from "./fixtures";

// Q49 (2026-11-12): repairs are tasks. Each row in the next message says only Queued or Sent; the strip at the top of
// Tasks carries when and why, from the one send decision; a task resolved before it went out vanishes.

const at = (ms: number) => new Date(clock - ms).toISOString();
const t = (kind: Task["kind"], n: number, title: string): Task => ({ key: `${kind}:example/app#${n}`, kind, target: kind === "obligation" ? "verify" : `example/app#${n}`, title, fingerprint: "f" });
const REPAIRS = [t("conflict", 1, "Resolve merge conflicts on example/app#1"), t("review", 2, "Use /fix-pr for example/app#2 (2 open threads)"), t("checks", 2, "Fix failing required check unit-tests on example/app#2"), t("restack", 3, "Restack example/app#3 onto example/app#2")];
const AUTO_TASK: Obligation = { id: "verify", title: "Verify the tenant migration", status: "pending", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0, trigger: { event: "now", delayDays: 0 } };
const batch = (state: Batch["state"], tasks: Task[], patch: Partial<Batch> = {}): Batch => ({ id: `b-${state}`, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], tasks, state, createdAt: at(10_000), sentAt: ["sending", "sent", "completed"].includes(state) ? at(5_000) : null, settledAt: state === "completed" ? at(1_000) : null, ...patch });
const message = (state: Batch["state"], patch: Partial<Workspace> = {}) => workspace({ enable_auto_sends: true, mainAgentTitle: "Billing fix", obligations: [AUTO_TASK], batches: [batch(state, [...REPAIRS, { ...t("obligation", 0, "Verify the tenant migration"), key: "obligation:verify" }])], ...patch });

test("every task in the message, repairs and Auto tasks alike, says only Queued or Sent", () => {
  for (const [state, word] of [["pending", "Queued"], ["sent", "Sent"]] as const) {
    const w = message(state);
    const rows = repairRows(w).open;
    assert.deepEqual(rows.map(r => r.text), REPAIRS.map(() => word), state);
    assert.deepEqual(rows.map(r => r.pr), ["#1", "#2", "#2", "#3"]);
    assert.equal(taskStatus(AUTO_TASK, w, {}, clock).text, word, "the Auto task reads like the repairs");
    assert.deepEqual(violations(w, clock), [], state);
  }
});

test("the strip carries when and why, and its reason is the send decision's", () => {
  const cases: Partial<Workspace>[] = [{}, { runtimeBusy: true }, { backgroundBusy: true }, { runtimeReason: "Waiting for Session Guard to resume this workspace" }, { sendWait: "unloaded" }, { enable_auto_sends: false }, { prs: [pr(), pr({ key: "example/app#2", number: 2, snapshot: null, error: "GitHub rate limit" })] }];
  for (const patch of cases) {
    const w = message("pending", patch);
    const strip = messageStrip(w, clock)!;
    const d = sendDecision(w, clock);
    assert.equal(strip.reason, d.waitingOn === "you" ? "waits for your Send in Needs you" : d.reason, JSON.stringify(patch));
    assert.equal(strip.to, "Billing fix");
    // Send now only where the server takes it, and never where the send waits on the developer (Send lives in Needs you).
    assert.equal(strip.sendNow, d.canSendNow && d.waitingOn !== "you", JSON.stringify(patch));
  }
  const settling = message("pending", { batches: [batch("pending", REPAIRS, { createdAt: at(5_000) })] });
  assert.equal(messageStrip(settling, clock)!.reason, SETTLE_REASON, "the settle says why not now");
  assert.equal(messageStrip(message("pending", { runtimeBusy: true }), clock)!.sendNow, false, "no Send now the server would refuse");
  assert.equal(messageStrip(message("pending", { runtimeBusy: true }), clock)!.reason, "sends when its current turn ends, so it isn't interrupted");
  const sent = messageStrip(message("sent"), clock)!;
  assert.equal(sent.phase, "sent"); assert.equal(sent.reason, "waiting for it to report back");
});

test("the panel header says who and what while a message is queued; the strip alone says when and why", () => {
  for (const patch of [{}, { runtimeBusy: true }, { sendWait: "unloaded" as const }]) {
    const w = message("pending", patch);
    const head = headerLine(w, clock);
    assert.equal(head.text, "5 tasks queued for Billing fix", JSON.stringify(patch));
    assert.equal(head.since, null, "never the time");
    assert.ok(!head.text.includes(sendDecision(w, clock).reason), "the reason lives in the strip");
    assert.ok(liveLine(w, clock).text.endsWith(sendDecision(w, clock).reason), "Home (no strip) keeps the full line");
  }
  assert.deepEqual(headerLine(message("sent"), clock), liveLine(message("sent"), clock), "only the queued line changes");
});

test("the Needs-you Send says why it waits on you once, never the agent's or workspace's title, and no second task list", () => {
  const w = message("pending", { sendWait: "unloaded" });
  const send = needsYou(w, clock).find(i => i.kind === "send");
  assert.equal(send?.title, "The agent is idle; Follow-up doesn't wake it");
  assert.ok(!send!.title.includes("Billing fix"), "say it once: the row's title is the workspace's (usually the agent's) name");
  assert.ok(!REPAIRS.some(r => send!.title.includes(r.title)), "the tasks are rows in Tasks, not repeated here");
  assert.equal(liveLine(w, clock).text, "5 tasks queued · the agent is idle; Follow-up doesn't wake it", "Home says it in the same words");
  assert.deepEqual([workspaceHeadline(needsYou(w, clock))?.label, workspaceHeadline(needsYou(w, clock))?.line], ["Send 5 tasks", send?.title], "the pill and inbox: tasks, the same line");
  const off = needsYou(message("pending", { enable_auto_sends: false }), clock).find(i => i.kind === "send");
  assert.equal(off?.title, "5 tasks ready · auto-send is off here", "how much waits and why, never the title");
});

test("done rows say how they finished; a resolved-before-sent repair never shows", () => {
  const w = workspace({ mainAgentTitle: "Billing fix", batches: [
    batch("completed", [REPAIRS[0]], { id: "acked" }),
    batch("completed", [REPAIRS[1]], { id: "quiet", unacknowledged: true }),
    batch("cancelled", [REPAIRS[2]], { id: "never-sent", result: "Conditions resolved before delivery" }),
  ] });
  const { open, done } = repairRows(w);
  assert.deepEqual(open, []);
  const said = new Map(done.map(r => [r.task.kind, r.text]));
  assert.equal(said.get("conflict"), "Done · Billing fix finished it");
  assert.equal(said.get("review"), "Done · resolved on GitHub");
  assert.ok(!done.some(r => r.task.kind === "checks"), "never sent: it vanishes");
});

async function engineFixture(t: any, w: Workspace) {
  const root = await mkdtemp(join(tmpdir(), "follow-rows-"));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = clock; const observations = new Map(w.prs.map(p => [p.key, p.snapshot!]));
  const sends: string[] = [];
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r.json" }), observe: async (): Promise<Runtime> => ({ busy: false, reason: null, archived: false, mainTitle: "Billing fix" }), send: async (_w, _b, text) => { sends.push(text); }, label: async () => {} };
  const github = { observe: async (prs: any[]) => new Map(prs.map(p => [p.key, { snapshot: { ...observations.get(p.key)!, observedAt: new Date(now).toISOString() }, error: null }])) };
  const engine = new Engine(store, github, gateway, () => now);
  return { engine, store, sends, get: async () => (await store.snapshot()).workspaces[0], advance: (ms: number) => { now += ms; }, observe: (k: string, s: any) => observations.set(k, s), now: () => now };
}

test("a repair GitHub clears before it is sent vanishes from Tasks", async t => {
  const f = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) })] }));
  await f.engine.tick();
  let w = await f.get();
  assert.deepEqual(repairRows(w).open.map(r => r.text), ["Queued"]);
  assert.equal(w.mainAgentTitle, "Billing fix");
  assert.match(w.nextMessage ?? "", /^1\. Resolve merge conflicts on example\/app#1$/, "the exact text, no batch id line");
  f.observe("example/app#1", snapshot()); f.advance(10_000); await f.engine.tick();
  w = await f.get();
  assert.deepEqual(repairRows(w), { open: [], done: [] });
  assert.equal(w.nextMessage, null);
  assert.equal(f.sends.length, 0);
});

test("Auto off for one task keeps it out of the message; the agent tool does the same as the switch", async t => {
  const f = await engineFixture(t, workspace({ enable_auto_sends: true, prs: [pr({ snapshot: snapshot({ conflict: true }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ threads: [{ id: "r", updatedAt: "t" }] }) })] }));
  const rpc = { validate: async (_m: string, input: unknown) => input, call: async () => ({}) };
  const actions = new AgentActions({ store: f.store, engine: f.engine, inbox: { noteAction: async () => undefined }, rpc } as never);
  await actions.run("helper-1", "set_auto_send", { workspace: "workspace", value: false, task: "conflict:example/app#1" });
  await f.engine.tick();
  let w = await f.get();
  assert.deepEqual(w.manualTasks, ["conflict:example/app#1"]);
  assert.deepEqual(repairRows(w).open.map(r => [r.task.kind, r.text]), [["review", "Queued"], ["conflict", "Auto off · stays with you"]]);
  f.advance(61_000); await f.engine.tick();
  assert.equal(f.sends.length, 1); assert.doesNotMatch(f.sends[0], /conflicts/);
  await actions.run("helper-1", "set_auto_send", { workspace: "workspace", value: true, task: "conflict:example/app#1" });
  w = await f.get(); assert.deepEqual(w.manualTasks, []);
});

test("workspace_status carries the next message: recipient, tasks, exact text, and when and why", () => {
  const w = message("pending", { nextMessage: "1. Resolve merge conflicts on example/app#1" });
  const info = nextMessageInfo(w, clock)!;
  assert.deepEqual({ to: info.to, reason: info.reason, text: info.text }, { to: "Billing fix", reason: sendDecision(w, clock).reason, text: "1. Resolve merge conflicts on example/app#1" });
  const status = compact("workspace_status", {}, { ...w, nextMessageInfo: info }) as { nextMessage: unknown };
  assert.deepEqual(status.nextMessage, info);
});

test("a row shows the task's short title; the agent's full instruction stays in the message", async () => {
  const { shortTitle } = await import("../shared/task-rows");
  assert.equal(shortTitle({ title: "Address review comments on example/app#160 (2 open threads): read the unresolved threads, fix, push, then reply and resolve" }), "Address review comments (2 open threads)");
  assert.equal(shortTitle({ title: "Restack example/app#3 onto example/app#2" }), "Restack #3 onto #2");
});
