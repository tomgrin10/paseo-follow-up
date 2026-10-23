import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communicationSchema, replyRecorded } from "../shared/communication";
import { completionBlockers } from "../shared/model";
import { updateObligation } from "../server/obligations";
import { tasksFor } from "../server/tasks";
import { Store } from "../server/store";
import { Engine, type Gateway } from "../server/engine";
import { clock, pr, snapshot, workspace } from "./fixtures";

const threadUrl = "https://example.slack.com/archives/C123/p1767261600000000";
const replyUrl = "https://example.slack.com/archives/C123/p1767261660000000?thread_ts=1767261600.000000";
const communication = () => communicationSchema.parse({ threadUrl, recipient: "Requester", authorization: "The developer explicitly requested an update in this thread." });
const progress = () => ({ title: "Update the requester in Slack", status: "pending" as const, afterPrs: [], trigger: { event: "now" as const, delayDays: 0 }, evidence: "", communication: communication() });

test("communication destinations and receipts require real Slack permalinks in the original channel/thread", () => {
  for (const invalid of ["http://example.slack.com/archives/C123/p1767261600000000", "https://slack.com.evil.invalid/archives/C123/p1767261600000000", "https://example.slack.com/", "https://name:secret@example.slack.com/archives/C123/p1767261600000000"])
    assert.equal(communicationSchema.safeParse({ ...communication(), threadUrl: invalid }).success, false);
  assert.equal(replyRecorded({ ...communication(), replyUrl }), true);
  assert.equal(replyRecorded({ ...communication(), replyUrl: replyUrl.split("?")[0] }), true);
  for (const wrong of [threadUrl, replyUrl.replace("example.slack.com", "other.slack.com"), replyUrl.replace("C123", "C456"), replyUrl.replace("thread_ts=1767261600", "thread_ts=1767261000")]) assert.equal(replyRecorded({ ...communication(), replyUrl: wrong }), false);
});
test("pending duplicate replies reconcile without losing metadata during ordinary task updates", () => {
  const w = workspace();
  const first = updateObligation(w, progress());
  const again = updateObligation(w, { ...progress(), evidence: "Current state checked" });
  assert.equal(again.id, first.id); assert.equal(w.obligations.length, 1);
  updateObligation(w, { id: first.id, title: first.title, status: "blocked", afterPrs: [], evidence: "Slack connection is read-only" });
  assert.deepEqual(first.communication, communication()); assert.equal(first.status, "blocked");
  const verified = updateObligation(w, { ...progress(), title: "Verify the fix and update the requester", communication: { ...communication(), purpose: "verified" } });
  assert.notEqual(verified.id, first.id); assert.equal(w.obligations.length, 2);
});
test("Auto never substitutes for communication authorization; drafts and blocked/uncertain sends stay unfinished", () => {
  const w = workspace({ enable_auto_sends: true });
  const o = updateObligation(w, { ...progress(), communication: { ...communication(), authorization: "" } });
  assert.deepEqual(tasksFor(w, clock), []);
  assert.ok(completionBlockers(w, clock).includes(o.title));
  updateObligation(w, { ...progress(), id: o.id }); assert.equal(tasksFor(w, clock)[0].target, o.id);
  updateObligation(w, { ...progress(), id: o.id, status: "blocked", evidence: "Send result is uncertain; check the thread before any retry" });
  assert.deepEqual(tasksFor(w, clock), []);
  assert.throws(() => updateObligation(w, { ...progress(), id: o.id, status: "done", evidence: "Draft prepared" }), /draft is not a sent reply/);
  assert.equal(o.status, "blocked");
});
test("verify-and-reply waits for actual serving revisions and cannot finish with the root link or another thread", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })] });
  const input = { ...progress(), afterPrs: [w.prs[0].key], trigger: { event: "deploy" as const, delayDays: 0 }, dependencyStage: "deployed" as const, communication: { ...communication(), purpose: "verified" as const } };
  const o = updateObligation(w, input); assert.deepEqual(tasksFor(w, clock), []);
  w.prs[0].snapshot!.deployment = { state: "deployed", environment: "production", commits: ["serving-revision"], evidence: "Merge is serving", observedAt: new Date(clock).toISOString() };
  assert.equal(tasksFor(w, clock)[0].target, o.id);
  assert.deepEqual(tasksFor(w, clock + 121_000), []);
  assert.throws(() => updateObligation(w, { ...input, id: o.id, status: "done", evidence: "Posted", communication: { ...input.communication, replyUrl: threadUrl } }), /reply receipt/);
  updateObligation(w, { ...input, id: o.id, status: "done", evidence: "Verified behavior; posted the result", communication: { ...input.communication, replyUrl } });
  assert.equal(o.status, "done"); assert.equal(tasksFor(w, clock).some(t => t.kind === "obligation"), false);
  assert.deepEqual(completionBlockers(w, clock), []);
  o.communication!.replyUrl = null;
  assert.match(completionBlockers(w, clock)[0], /Record the sent reply/);
});
test("reply destination changes invalidate queued work and recorded replies cannot be automatically resent", () => {
  const w = workspace(); const o = updateObligation(w, progress()); const before = tasksFor(w, clock)[0];
  updateObligation(w, { ...progress(), id: o.id, communication: { ...communication(), threadUrl: threadUrl.replace("C123", "C456") } });
  assert.notEqual(tasksFor(w, clock)[0].fingerprint, before.fingerprint);
  updateObligation(w, { ...progress(), id: o.id, communication: { ...communication(), replyUrl }, evidence: "Equivalent update already exists" });
  assert.deepEqual(tasksFor(w, clock), []);
});
test("communication records survive storage and only a receipt or explicit waiver completes their batch", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-communication-")); t.after(() => rm(root, { recursive: true, force: true }));
  const w = workspace({ prs: [] }); const o = updateObligation(w, progress());
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  assert.deepEqual((await new Store(root).snapshot()).workspaces[0].obligations[0].communication, communication());
  const sends: string[] = [];
  const gateway: Gateway = { observe: async () => ({ busy: false, reason: null, archived: false }), send: async (_w, _b, text) => { sends.push(text); }, label: async () => {}, prepareRecovery: async () => { throw new Error("Not a recovery request"); } };
  const engine = new Engine(store, { observe: async () => new Map() }, gateway, () => clock);
  await engine.tick(); const batch = (await store.snapshot()).workspaces[0].batches[0];
  await engine.sendPending(w.id, batch.id);
  assert.equal(sends[0], `Follow-through batch ${batch.id}\n\n1. Update the requester in Slack`);
  await assert.rejects(engine.acknowledge(w.mainAgentId, batch.id, "completed", "Draft prepared"), /Record the sent reply/);
  await engine.acknowledge(w.mainAgentId, batch.id, "blocked", "Posting is unavailable");
  assert.equal((await engine.declareDone(w.mainAgentId, "Finished")).blockers.includes(o.title), true);
  await store.mutate(s => { updateObligation(s.workspaces[0], { ...progress(), id: o.id, status: "done", evidence: "Posted the update", communication: { ...communication(), replyUrl } }); });
  await engine.acknowledge(w.mainAgentId, batch.id, "completed", "Reply verified in original thread");
  await engine.tick(); assert.equal(sends.length, 1);
  assert.deepEqual((await engine.declareDone(w.mainAgentId, "Reply sent; all work complete")).blockers, []);
  await engine.stop();
});
test("an authorized progress update can report unknown PR state; dependent verification still waits", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-communication-")); t.after(() => rm(root, { recursive: true, force: true }));
  const w = workspace({ enable_auto_sends: true }); updateObligation(w, progress());
  updateObligation(w, { ...progress(), title: "Verify and update the requester", afterPrs: [w.prs[0].key], trigger: { event: "deploy" as const, delayDays: 0 }, communication: { ...communication(), purpose: "verified" } });
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(w); });
  const sends: string[] = []; let now = clock;
  const gateway: Gateway = { observe: async () => ({ busy: false, reason: null, archived: false }), send: async (_w, _b, text) => { sends.push(text); }, label: async () => {}, prepareRecovery: async () => { throw new Error("Not recovery"); } };
  const engine = new Engine(store, { observe: async () => new Map([[w.prs[0].key, { snapshot: null, error: "Temporarily unavailable" }]]) }, gateway, () => now);
  await engine.tick(); now += 61_000; await engine.tick();
  assert.equal(sends.length, 1); assert.match(sends[0], /Update the requester in Slack/); assert.doesNotMatch(sends[0], /Verify and update/);
  await engine.stop();
});
