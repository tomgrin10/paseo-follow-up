import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskSchedule, taskTriggerSchema } from "../shared/task-trigger";
import { workspaceSchema, type Obligation } from "../shared/model";
import { tasksFor } from "../server/tasks";
import { updateObligation } from "../server/obligations";
import { recordSnapshot } from "../server/deployment-anchor";
import { Store } from "../server/store";
import { clock, pr, snapshot, workspace } from "./fixtures";

const day = 86_400_000;
const obligation = (patch: Partial<Obligation> = {}): Obligation => ({ id: "verify", title: "Recheck production behavior in two weeks", status: "waiting", afterPrs: [], enable_follow_up: true, evidence: "Original evidence", revision: 0, ...patch });
const deployed = (at: number) => snapshot({ state: "MERGED", mergeCommit: "squash-commit", mergedAt: new Date(clock - day).toISOString(), deployment: { state: "deployed", environment: "production", commits: ["serving-commit"], evidence: "Serving image contains the merge", observedAt: new Date(at).toISOString() } });

test("legacy enabled tasks and empty dependencies never enter a repair batch", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ conflict: true, threads: [{ id: "feedback", updatedAt: "now" }], failedChecks: ["build"] }) })], obligations: [obligation(), obligation({ id: "dependent", afterPrs: ["example/app#1"], dependencyStage: "merged" })] });
  assert.deepEqual(tasksFor(w, clock).map(t => t.kind), ["conflict", "review", "checks"]);
  assert.equal(taskSchedule(w.obligations[0], w, clock).label, "Manual");
  w.obligations[0].trigger = { event: "deploy", delayDays: 14 };
  assert.equal(taskSchedule(w.obligations[0], w, clock).ready, false);
  w.obligations[0].trigger = { event: "merge", delayDays: 0 };
  assert.equal(taskSchedule(w.obligations[0], w, clock).ready, false);
});
test("creating tasks defaults to manual and ordinary edits preserve explicit scheduling", () => {
  const w = workspace(); const input = { title: "Verify production behavior", status: "waiting" as const, afterPrs: [w.prs[0].key], evidence: "Keep this evidence" };
  const o = updateObligation(w, input);
  assert.equal(o.enable_follow_up, false); assert.equal(o.trigger, undefined);
  updateObligation(w, { ...input, id: o.id, trigger: { event: "deploy", delayDays: 14 } });
  assert.equal(o.enable_follow_up, true); assert.equal(o.dependencyStage, "deployed");
  const revision = o.revision;
  updateObligation(w, { ...input, id: o.id, evidence: "Added result" });
  assert.deepEqual(o.trigger, { event: "deploy", delayDays: 14 }); assert.equal(o.revision, revision);
  updateObligation(w, { ...input, id: o.id, trigger: null });
  assert.equal(o.enable_follow_up, false); assert.equal(o.trigger, null); assert.equal(o.revision, revision + 1);
  assert.deepEqual(o.afterPrs, input.afterPrs);
});
test("invalid triggers cannot bypass PR dependencies, delays or schema bounds", () => {
  const w = workspace(); const input = { title: "Verify behavior", status: "waiting" as const, afterPrs: [], evidence: "" };
  assert.throws(() => updateObligation(w, { ...input, trigger: { event: "merge", delayDays: 0 } }), /at least one/);
  assert.throws(() => updateObligation(w, { ...input, afterPrs: [w.prs[0].key], trigger: { event: "now", delayDays: 0 } }), /Now requires/);
  assert.throws(() => updateObligation(w, { ...input, trigger: { event: "now", delayDays: 14 } }), /Now requires/);
  for (const delayDays of [-1, 0.5, 3651]) assert.equal(taskTriggerSchema.safeParse({ event: "deploy", delayDays }).success, false);
  const o = updateObligation(w, { ...input, trigger: { event: "now", delayDays: 0 } });
  assert.equal(tasksFor(w, clock)[0].target, o.id);
  o.status = "blocked"; assert.equal(tasksFor(w, clock).length, 0);
});
test("merge delays use the last selected mergedAt, never title parsing, and wait for missing event times", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: new Date(clock).toISOString() }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ state: "MERGED", mergedAt: new Date(clock + day).toISOString() }) })], obligations: [obligation({ afterPrs: ["example/app#1", "example/app#2"], trigger: { event: "merge", delayDays: 14 } })] });
  assert.equal(taskSchedule(w.obligations[0], w, clock + 14 * day).ready, false);
  assert.deepEqual(taskSchedule(w.obligations[0], w, clock + 15 * day), { ready: true, dueAt: new Date(clock + 15 * day).toISOString(), label: "14d after merge" });
  w.prs[1].snapshot!.mergedAt = null; assert.equal(taskSchedule(w.obligations[0], w, clock + 100 * day).ready, false);
  w.prs[1].snapshot!.mergedAt = "invalid"; assert.equal(taskSchedule(w.obligations[0], w, clock + 100 * day).ready, false);
  w.prs[1].snapshot!.state = "CLOSED"; w.prs[1].disposition = "Superseded";
  w.obligations[0].trigger!.delayDays = 0; assert.equal(taskSchedule(w.obligations[0], w, clock).ready, false);
});
test("deployment delays persist their first verified clock across polls and storage; fresh deployment remains required", async t => {
  const w = workspace({ prs: [pr()], obligations: [obligation({ afterPrs: ["example/app#1"], trigger: { event: "deploy", delayDays: 14 } })] });
  recordSnapshot(w.prs[0], deployed(clock), clock);
  assert.equal(taskSchedule(w.obligations[0], w, clock).ready, false);
  recordSnapshot(w.prs[0], deployed(clock + 13 * day), clock + 13 * day);
  assert.equal(w.prs[0].deploymentAnchor!.at, new Date(clock).toISOString());
  const root = await mkdtemp(join(tmpdir(), "follow-trigger-")); t.after(() => rm(root, { recursive: true, force: true }));
  await new Store(root).mutate(s => { s.workspaces.push(w); });
  const restored = (await new Store(root).snapshot()).workspaces[0];
  recordSnapshot(restored.prs[0], deployed(clock + 14 * day - 1), clock + 14 * day - 1);
  assert.equal(taskSchedule(restored.obligations[0], restored, clock + 14 * day - 1).ready, false);
  recordSnapshot(restored.prs[0], deployed(clock + 14 * day), clock + 14 * day);
  assert.equal(tasksFor(restored, clock + 14 * day)[0].kind, "obligation");
  assert.equal(tasksFor(restored, clock + 14 * day + 121_000).length, 0);
  assert.deepEqual(workspaceSchema.parse(restored).prs[0].deploymentAnchor, w.prs[0].deploymentAnchor);
});
test("unknown observations retain deployment timing but block delivery; rollback and changed merge reset it", () => {
  const p = pr(); recordSnapshot(p, deployed(clock), clock);
  const unknown = deployed(clock + day); unknown.deployment!.state = "unknown";
  recordSnapshot(p, unknown, clock + day); assert.equal(p.deploymentAnchor!.at, new Date(clock).toISOString());
  const w = workspace({ prs: [p], obligations: [obligation({ afterPrs: [p.key], trigger: { event: "deploy", delayDays: 0 } })] });
  assert.equal(taskSchedule(w.obligations[0], w, clock + day).ready, false);
  for (const state of ["pending", "partial"] as const) {
    const rollback = deployed(clock + day); rollback.deployment!.state = state;
    recordSnapshot(p, rollback, clock + day); assert.equal(p.deploymentAnchor, undefined);
    recordSnapshot(p, deployed(clock + 2 * day), clock + 2 * day);
    assert.equal(p.deploymentAnchor!.at, new Date(clock + 2 * day).toISOString());
  }
  const changed = deployed(clock + 3 * day); changed.mergeCommit = "different-squash";
  recordSnapshot(p, changed, clock + 3 * day); assert.equal(p.deploymentAnchor!.mergeCommit, "different-squash"); assert.equal(p.deploymentAnchor!.at, new Date(clock + 3 * day).toISOString());
});
