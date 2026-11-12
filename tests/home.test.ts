import test from "node:test";
import assert from "node:assert/strict";
import { buildHome, briefPane, followUpLog, lastWorkdayEnd, nextNeeds, paneButtons, quietFolds, tailSteps, type PaseoWorkspaceLite } from "../shared/home";
import type { InboxRow, Reason } from "../shared/inbox";
import type { Batch, Workspace } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

const NOW = Date.parse("2026-11-09T09:50:00.000Z"); // a Monday
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (agentId: string, patch: Partial<InboxRow> = {}): InboxRow => ({
  agentId, workspaceId: `w-${agentId}`, title: "Main", workspaceTitle: `Workspace ${agentId}`, multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: at(5), needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, brief: null, ...patch,
});
const flagged = (agentId: string, reason: Reason, minutesAgo: number, patch: Partial<InboxRow> = {}) =>
  row(agentId, { needs: { reasons: [{ reason, at: at(minutesAgo), detail: `${reason} detail`, dedupeKey: reason }], since: at(minutesAgo) }, ...patch });
const batch = (patch: Partial<Batch> = {}): Batch => ({ id: "b1", tasks: [{ key: "checks:example/app#1", kind: "checks", target: "example/app#1", title: "Fix lint on example/app#1", fingerprint: "f" }], state: "sent", createdAt: at(30), sentAt: at(20), settledAt: null, messageId: "m1", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [], ...patch });
const ws = (id: string, patch: Partial<Workspace> = {}) => workspace({ id, title: `Tracked ${id}`, mainAgentId: `agent-${id}`, updatedAt: at(60), ...patch });
const groupOf = (model: ReturnType<typeof buildHome>, key: string) => model.groups.find(g => g.items.some(i => i.key === key))?.id ?? null;
const paseo = (id: string, project = "atlas"): PaseoWorkspaceLite => ({ id, name: `Paseo ${id}`, project, activityAt: at(300) });

test("each workstream lands in the group of what it needs from the developer", () => {
  const model = buildHome({
    now: NOW,
    rows: [
      flagged("perm", "permission", 3),
      flagged("fin", "finished", 30),
      row("run", { status: "running" }),
      flagged("later", "finished", 10, { snooze: { until: at(-60), at: at(1) } }),
    ],
    tracked: [
      ws("fixing", { batches: [batch()] }),
      ws("merge", { prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })] }),
      ws("waiting", { prs: [pr({ snapshot: snapshot({ reviewDecision: "REVIEW_REQUIRED" }) })] }),
      ws("done", { prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: at(600), observedAt: new Date(NOW).toISOString() }) })], completion: { summary: "Shipped", declaredAt: at(500) } }),
    ],
    paseo: [paseo("untracked")],
  });
  assert.equal(groupOf(model, "agent:perm"), "needs");
  assert.equal(groupOf(model, "agent:fin"), "needs");
  assert.equal(groupOf(model, "ws:merge"), "needs");
  assert.equal(groupOf(model, "agent:run"), "running");
  assert.equal(groupOf(model, "agent:later"), "later");
  assert.equal(groupOf(model, "ws:fixing"), "fixing");
  assert.equal(groupOf(model, "ws:waiting"), "waiting");
  assert.equal(groupOf(model, "ws:done"), "quiet");
  assert.equal(model.byKey.get("ws:done")!.readyToArchive, true);
  assert.equal(groupOf(model, "ws:untracked"), "quiet");
  // Groups appear in the design's order, and empty groups are left out rather than shown empty.
  assert.deepEqual(model.groups.map(g => g.id), ["needs", "fixing", "running", "waiting", "later", "quiet"]);
  assert.equal(model.needs, 3);
});

test("Needs you: blocking asks first, then decisions only the developer makes, then finished turns, oldest first in each", () => {
  const model = buildHome({
    now: NOW,
    rows: [
      flagged("fin-old", "finished", 300),
      flagged("perm-new", "permission", 2),
      flagged("err-old", "error", 90),
      flagged("decision", "finished", 5, { brief: { kind: "decision", source: "agent", state: "open", ask: "A or B?" } }),
    ],
    tracked: [ws("merge", { updatedAt: at(400), prs: [pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE" }) })] })],
    paseo: [],
  });
  const needs = model.groups.find(g => g.id === "needs")!.items.map(i => i.key);
  assert.deepEqual(needs, ["agent:err-old", "agent:decision", "agent:perm-new", "ws:merge", "agent:fin-old"]);
  assert.deepEqual(model.groups[0].items.map(i => i.tier), [0, 0, 0, 1, 2]);
  assert.equal(nextNeeds(model, "agent:err-old")!.key, "agent:decision");
});

test("a running main agent working on Follow-up's repairs shows under Follow-up is fixing, not Running", () => {
  const model = buildHome({ now: NOW, rows: [row("agent-x", { workspaceId: "x", status: "running" })], tracked: [ws("x", { batches: [batch()] })], paseo: [] });
  assert.equal(groupOf(model, "agent:agent-x"), "fixing");
  assert.equal(model.groups.length, 1);
});

test("a workspace is never listed twice: its flagged agent row covers the workspace row", () => {
  const model = buildHome({ now: NOW, rows: [flagged("agent-y", "finished", 3, { workspaceId: "y" })], tracked: [ws("y")], paseo: [paseo("y")] });
  const keys = model.groups.flatMap(g => g.items.map(i => i.key));
  assert.deepEqual(keys, ["agent:agent-y"]);
  assert.equal(model.byKey.get("agent:agent-y")!.project, "atlas");
});

test("rows carry at most two badges and a PR chip with its checks", () => {
  const model = buildHome({ now: NOW, rows: [], paseo: [], tracked: [ws("m", { prs: [
    pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE", conflict: false }) }),
    pr({ key: "example/app#2", number: 2, parent: "example/app#1", snapshot: snapshot({ failedChecks: ["lint", "test"], conflict: true }) }),
  ] })] });
  const s = model.byKey.get("ws:m")!;
  assert.ok(s.badges.length <= 2);
  assert.equal(s.badges[0].text, "Merge ready");
  assert.equal(s.pr!.label, "#1+1");
  assert.equal(s.pr!.checks!.text, "✓");
});

test("an unchanged row keeps its signature, so the memoised list row doesn't redraw", () => {
  const input = { now: NOW, rows: [flagged("a", "finished", 3)], tracked: [], paseo: [] };
  const first = buildHome(input).byKey.get("agent:a")!.sig;
  assert.equal(buildHome({ ...input, now: NOW + 60_000 }).byKey.get("agent:a")!.sig, first);
  assert.notEqual(buildHome({ ...input, rows: [flagged("a", "permission", 3)] }).byKey.get("agent:a")!.sig, first);
});

test("Quiet folds by project and pages; ready-to-archive comes first in a project", () => {
  const model = buildHome({ now: NOW, rows: [], paseo: [paseo("q1"), paseo("q2", "hub"), paseo("done", "atlas")],
    tracked: [ws("done", { prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: at(600), observedAt: new Date(NOW).toISOString() }) })], completion: { summary: "Shipped", declaredAt: at(900) } })] });
  const folds = quietFolds(model.groups.find(g => g.id === "quiet")!.items);
  assert.deepEqual(folds.map(f => [f.project, f.items.length, f.archivable]), [["atlas", 2, 1], ["hub", 1, 0]]);
  assert.equal(folds[0].items[0].key, "ws:done");
});

test("the brief pane names the first move and what Follow-up did since the last workday", () => {
  const tracked = [ws("f", { batches: [batch({ state: "completed", sentAt: at(600), settledAt: at(500), result: "Lint fixed" })] })];
  const rows = [flagged("perm", "permission", 3, { workspaceTitle: "Vendor risk export" }), row("s", { signedOffAt: at(30) })];
  const model = buildHome({ now: NOW, rows, tracked, paseo: [] });
  const pane = briefPane({ model, rows, tracked, now: NOW });
  assert.match(pane.headline, /^Start with Vendor risk export\. It's waiting on a permission\./);
  assert.equal(pane.first!.key, "agent:perm");
  assert.equal(pane.away.count, 2); // sent, then finished
  assert.match(pane.cleared ?? "", /1 signed off/);
});

test("the log lists only Follow-up's own actions, not merges or questions", () => {
  const w = ws("l", { batches: [batch({ sentAt: at(60) })], prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: at(30) }) })] });
  const lines = followUpLog([w], NOW - 86_400_000);
  assert.deepEqual(lines.map(l => l.text), ["Sent 1 task to the main agent"]);
});

test("last workday skips the weekend", () => {
  const monday = new Date(2026, 10, 9, 9, 50).getTime();
  const end = new Date(lastWorkdayEnd(monday));
  assert.equal(end.getDay(), 5);
  assert.equal(end.getHours(), 18);
});

test("the tail keeps messages and one-line tool calls, joins streamed text and drops plugin rows", () => {
  const steps = tailSteps([
    { type: "user_message", text: "Fix SCIM" },
    { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "rg memberOf\nmore" } },
    { type: "reasoning", text: "thinking" },
    { type: "assistant_message", text: "Found " }, { type: "assistant_message", text: "it." },
    { type: "plugin", text: "brief" },
  ]);
  assert.deepEqual(steps, [{ kind: "you", text: "Fix SCIM" }, { kind: "tool", text: "Bash · rg memberOf", failed: false }, { kind: "agent", text: "Found it." }]);
});

test("the detail pane fills exactly one primary: Allow, then a workspace item, then nothing for decisions, else Sign off", () => {
  const base = { permissions: 0, decisions: false, items: [] as never[], flagged: true, hasAgent: true };
  assert.equal(paneButtons({ ...base, permissions: 1, decisions: true }).primary, "allow");
  assert.equal(paneButtons({ ...base, items: ["send"] as never[] }).primary, "item");
  assert.equal(paneButtons({ ...base, decisions: true }).primary, null);
  assert.equal(paneButtons(base).primary, "sign_off");
  assert.equal(paneButtons({ ...base, flagged: false }).primary, null);
  assert.deepEqual(paneButtons({ ...base, permissions: 1 }).buttons, ["deny", "allow", "sign_off", "sign_off_next", "later", "open_full", "reply"]);
  assert.ok(!paneButtons({ ...base, hasAgent: false, flagged: false }).buttons.includes("reply"));
});

// Bug class: a name that changed in Paseo (Rename with AI, or a rename in Paseo) must show on Home at once, not after
// the inbox's directory refreshes.
test("a Needs-you row is named by Paseo's live workspace list, not the inbox's older copy", () => {
  const model = buildHome({ now: NOW, rows: [row("agent-r", { workspaceId: "r", workspaceTitle: "Old name" })], tracked: [], paseo: [{ ...paseo("r"), name: "Retry soft declines with backoff" }] });
  assert.equal([...model.byKey.values()].find(s => s.agentId === "agent-r")?.title, "Retry soft declines with backoff");
});
