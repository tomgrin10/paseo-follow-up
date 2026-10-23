import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { GraphiteWriteError } from "../server/graphite";
import { downstack } from "../shared/pr-actions";
import { pr, snapshot, workspace } from "./fixtures";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "follow-actions-")); const store = new Store(root);
  const bottom = pr({ snapshot: snapshot({ headBranch: "bottom", head: "bottom-head", reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) });
  const top = pr({ key: "example/app#2", number: 2, parent: bottom.key, snapshot: snapshot({ headBranch: "top", head: "top-head", base: "bottom", reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE_AS_STACK" }) });
  await store.mutate(s => s.workspaces.push(workspace({ prs: [top, bottom] })));
  let observed = [top, bottom]; let fail = false; const merges: number[][] = [];
  const browser = new BrowserBridge();
  const actions = new PrActions(store, { observe: async () => new Map(observed.map(p => [p.key, { snapshot: p.snapshot, error: p.error }])) }, { invalidate() {}, merge: async (_repo, prs) => { merges.push(prs); if (fail) throw new GraphiteWriteError("Timed out after delivery", true); } }, browser);
  return { store, actions, browser, merges, bottom, top, observe: (prs: typeof observed) => { observed = prs; }, fail: () => { fail = true; }, close: async () => { await actions.close(); await rm(root, { recursive: true, force: true }); } };
}
test("upper PR confirmation includes owned downstack, and cancel/prepare sends nothing", async () => {
  const f = await fixture(); try {
    const plan = await f.actions.prepare("workspace", f.top.key, "merge");
    assert.deepEqual(plan.prs.map(p => p.number), [1, 2]); assert.ok(plan.prs.every(p => !p.blockers.length)); assert.deepEqual(f.merges, []);
    await assert.rejects(f.actions.confirm(plan.id, "target"), /depends on downstack/);
    assert.deepEqual(f.merges, []);
    const approved = await f.actions.prepare("workspace", f.top.key, "merge");
    assert.equal((await f.actions.confirm(approved.id, "downstack")).state, "submitted"); assert.deepEqual(f.merges, [[1, 2]]);
    await assert.rejects(f.actions.confirm(approved.id, "downstack"), /expired/);
    const w = (await f.store.snapshot()).workspaces[0]; assert.equal(w.enable_auto_sends, false); assert.equal(w.mainAgentId, "main-agent"); assert.equal(w.completion, null);
    const duplicate = await f.actions.prepare("workspace", f.top.key, "merge"); assert.ok(duplicate.blockers.some(b => b.includes("just submitted")));
  } finally { await f.close(); }
});
test("changed heads and failed downstack checks refuse submission", async () => {
  const f = await fixture(); try {
    const plan = await f.actions.prepare("workspace", f.top.key, "merge");
    f.observe([{ ...f.top, snapshot: { ...f.top.snapshot!, head: "different-head" } }, f.bottom]);
    await assert.rejects(f.actions.confirm(plan.id, "downstack"), /revisions or stack membership changed/);
    f.observe([f.top, { ...f.bottom, snapshot: { ...f.bottom.snapshot!, failedChecks: ["Required tests"] } }]);
    const blocked = await f.actions.prepare("workspace", f.top.key, "merge"); assert.ok(blocked.prs[0].blockers.includes("Required checks failed"));
    await assert.rejects(f.actions.confirm(blocked.id, "downstack"), /readiness changed/); assert.deepEqual(f.merges, []);
  } finally { await f.close(); }
});
test("ownership gaps and changed parentage cannot silently expand merge scope", async () => {
  const f = await fixture(); try {
    assert.throws(() => downstack([{ ...f.top, parent: "another/repo#3" }], f.top.key), /outside/);
    assert.throws(() => downstack([{ ...f.top, parent: f.top.key }], f.top.key), /cycle/);
    f.observe([{ ...f.top, snapshot: { ...f.top.snapshot!, base: "external-branch" } }, f.bottom]);
    const plan = await f.actions.prepare("workspace", f.top.key, "merge"); assert.ok(plan.prs[1].blockers.some(b => b.includes("parent relationships")));
    await assert.rejects(f.actions.confirm(plan.id, "downstack"), /readiness changed/); assert.deepEqual(f.merges, []);
  } finally { await f.close(); }
});
test("uncertain merge is durable and never automatically retried", async () => {
  const f = await fixture(); try {
    f.fail(); const plan = await f.actions.prepare("workspace", f.top.key, "merge");
    assert.equal((await f.actions.confirm(plan.id, "downstack")).state, "uncertain");
    assert.equal((await new Store(f.store.directory).snapshot()).workspaces[0].prActions[0].state, "uncertain");
    const retry = await f.actions.prepare("workspace", f.top.key, "merge"); assert.ok(retry.blockers.length);
    await assert.rejects(f.actions.confirm(retry.id, "downstack"), /readiness changed/); assert.equal(f.merges.length, 1);
  } finally { await f.close(); }
});
test("browser writes are leased once, nonce-bound, and restricted to the requested PRs", async () => {
  const browser = new BrowserBridge(); try {
    browser.exchange("browser", true, []);
    const result = browser.request("disable_mwr", "example/app", [{ number: 2, head: "head", trunk: "main" }]);
    const [job] = browser.exchange("browser", true, []); assert.ok(job); assert.deepEqual(browser.exchange("other", true, []), []);
    browser.exchange("other", true, [{ id: job.id, nonce: job.nonce, outcome: "completed", prs: [], applied: [2], error: "" }]);
    browser.exchange("browser", true, [{ id: job.id, nonce: job.nonce, outcome: "completed", prs: [], applied: [3], error: "" }]);
    browser.exchange("browser", true, [{ id: job.id, nonce: job.nonce, outcome: "completed", prs: [], applied: [2], error: "" }]);
    assert.deepEqual((await result).applied, [2]);
  } finally { browser.close(); }
});

test("a closed unmerged PR never confirms an uncertain merge", async () => {
  const f = await fixture(); try {
    f.fail(); const plan = await f.actions.prepare("workspace", f.bottom.key, "merge");
    await f.actions.confirm(plan.id, "target");
    const action = (await f.store.snapshot()).workspaces[0].prActions[0];
    f.observe([f.top, { ...f.bottom, snapshot: { ...f.bottom.snapshot!, state: "CLOSED" } }]);
    assert.equal((await f.actions.check("workspace", action.id)).state, "uncertain");
    assert.equal(f.merges.length, 1);
  } finally { await f.close(); }
});

test("the actual browser toggle is independent of merge scheduling and target scope", async () => {
  const f = await fixture(); let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const enabled = new Set<number>(); const writes: number[][] = [];
    f.browser.exchange("browser", true, []);
    poll = setInterval(() => {
      for (const job of f.browser.exchange("browser", true, [])) {
        if (job.op !== "read") { writes.push(job.prs.map(p => p.number)); for (const p of job.prs) { if (job.op === "enable_mwr") enabled.add(p.number); else enabled.delete(p.number); } }
        f.browser.exchange("browser", true, [{ id: job.id, nonce: job.nonce, outcome: "completed", prs: job.prs.map(p => ({ repo: job.repo, number: p.number, head: p.head, state: "OPEN", mergeWhenReady: enabled.has(p.number), merging: false })), applied: job.op === "read" ? [] : job.prs.map(p => p.number), error: "" }]);
      }
    }, 5);
    assert.equal((await f.actions.status("workspace", f.top.key)).pr?.mergeWhenReady, false);
    const target = await f.actions.prepare("workspace", f.top.key, "enable_mwr");
    assert.deepEqual(target.prs.map(p => p.number), [1, 2]);
    assert.equal((await f.actions.confirm(target.id, "target")).state, "submitted");
    assert.deepEqual(writes, [[2]]);
    const whole = await f.actions.prepare("workspace", f.top.key, "disable_mwr");
    await f.actions.confirm(whole.id, "downstack");
    assert.deepEqual(writes, [[2], [1, 2]]);
  } finally { clearInterval(poll); await f.close(); }
});

test("a missing companion leaves CLI merge and result checks available", async () => {
  const f = await fixture(); try {
    assert.equal(f.browser.status().ready, false);
    assert.equal((await f.actions.status("workspace", f.top.key)).pr, null);
    f.fail();
    const plan = await f.actions.prepare("workspace", f.top.key, "merge");
    assert.ok(!plan.blockers.length && plan.prs.every(p => !p.blockers.length));
    assert.equal((await f.actions.confirm(plan.id, "downstack")).state, "uncertain");
    f.observe([f.top, f.bottom].map(p => ({ ...p, snapshot: { ...p.snapshot!, graphiteMergeStatus: "QUEUED_TO_MERGE" } })));
    const audit = (await f.store.snapshot()).workspaces[0].prActions[0];
    assert.equal((await f.actions.check("workspace", audit.id)).state, "submitted");
    assert.deepEqual(f.merges, [[1, 2]]);
  } finally { await f.close(); }
});

test("a missing companion refuses only browser toggles without recording a write", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.actions.prepare("workspace", f.top.key, "enable_mwr"), /Open Graphite/);
    const w = (await f.store.snapshot()).workspaces[0];
    assert.deepEqual(w.prActions, []); assert.equal(w.mainAgentId, "main-agent"); assert.equal(w.enable_auto_sends, false);
    assert.equal(w.prs.length, 2); assert.deepEqual(f.merges, []);
  } finally { await f.close(); }
});
