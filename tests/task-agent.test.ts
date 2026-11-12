import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { taskStatus, claimsWorking, type TaskAgents } from "../shared/task-status";
import { INVARIANTS } from "../shared/status-invariants";
import { updateObligation } from "../server/obligations";
import { taskAgentStates } from "../server/tasks";
import type { Obligation, Workspace } from "../shared/model";
import { workspace } from "./fixtures";

/**
 * Invariant `a-task-only-says-working-when-its-agent-is` (2026-11-12): a task row read "Agent working" because the
 * obligation's stored status was working, long after anyone touched it, and it offered no way to that agent. The task
 * now records who works on it, its line says what that agent is doing now, and it opens the agent only while it's open.
 */
const now = Date.parse("2026-11-12T10:00:00Z");
const ws = (obligations: Partial<Obligation>[] = []): Workspace => workspace({ prs: [],
  obligations: obligations.map((o, i) => ({ id: `t${i}`, title: "Fix workspace reading", status: "working", afterPrs: [], evidence: "", enable_follow_up: false, revision: 0, ...o })) });
const line = (o: Partial<Obligation>, agents: TaskAgents = {}) => { const w = ws([o]); return taskStatus(w.obligations[0], w, agents, now); };

test("a-task-only-says-working-when-its-agent-is: the stored status alone never says working", () => {
  assert.deepEqual(line({}), { text: "In progress", tone: "progress", agentId: null });
  assert.deepEqual(line({ workingAgentId: "sub-1" }), { text: "In progress", tone: "progress", agentId: null }, "live state unknown");
  const inv = INVARIANTS.find(i => i.id === "a-task-only-says-working-when-its-agent-is")!;
  assert.equal(inv.check(ws([{}, { workingAgentId: "sub-1" }, { status: "pending" }]), now), null);
});

test("a working task names its agent and that agent's live state, and opens it only while it's open", () => {
  assert.deepEqual(line({ workingAgentId: "sub-1" }, { "sub-1": { title: "Reader fix", state: "working" } }), { text: "Reader fix working", tone: "working", agentId: "sub-1" });
  assert.deepEqual(line({ workingAgentId: "sub-1" }, { "sub-1": { title: "Reader fix", state: "idle" } }), { text: "Reader fix idle", tone: "idle", agentId: "sub-1" });
  assert.deepEqual(line({ workingAgentId: "sub-1" }, { "sub-1": { title: "Backfill pass", state: "closed" } }), { text: "Backfill pass closed", tone: "closed", agentId: null });
  assert.deepEqual(line({ workingAgentId: "gone" }, { gone: { title: null, state: "closed" } }), { text: "Agent closed", tone: "closed", agentId: null }, "name unknown");
  assert.equal(line({ workingAgentId: "sub-1" }, { "sub-1": { title: null, state: "working" } }).text, "Agent working");
  // Another task's live agent doesn't lend it a state.
  assert.equal(line({ workingAgentId: "sub-2" }, { "sub-1": { title: "Reader fix", state: "working" } }).text, "In progress");
  // Only a live working agent's line claims working.
  for (const state of ["idle", "closed"] as const) assert.equal(claimsWorking(line({ workingAgentId: "a" }, { a: { title: "x", state } }).text), false);
});

test("other statuses keep their words and never name an agent", () => {
  for (const [status, text] of [["done", "Done"], ["waived", "Waived"], ["blocked", "Needs a decision"]] as const) {
    const s = line({ status, evidence: "checked", workingAgentId: "sub-1" }, { "sub-1": { title: "Reader fix", state: "working" } });
    assert.equal(s.text, text); assert.equal(s.agentId, null);
  }
});

test("update_obligation records who works on it: the caller, or the agent it names; kept after the task finishes", () => {
  const w = ws();
  const o = updateObligation(w, { title: "Fix workspace reading", status: "working", caller: "main" });
  assert.equal(o.workingAgentId, "main");
  updateObligation(w, { id: o.id, title: o.title, status: "working", caller: "main", workingAgentId: "sub-1" });
  assert.equal(w.obligations[0].workingAgentId, "sub-1");
  updateObligation(w, { id: o.id, title: o.title, status: "pending", caller: "main" });
  assert.equal(w.obligations[0].workingAgentId, "sub-1", "a non-working update leaves the record");
  updateObligation(w, { id: o.id, title: o.title, status: "working", caller: "other" });
  assert.equal(w.obligations[0].workingAgentId, "other", "a new working update by another agent takes it over");
  const fresh = updateObligation(w, { title: "Run the migration", status: "pending", caller: "main" });
  assert.equal(fresh.workingAgentId, undefined, "only working records an agent");
});

test("taskAgentStates reads the directory's metadata: running is working, closed, archived or missing is closed", () => {
  const agents = [
    { id: "a", status: "running", title: "Reader fix" }, { id: "b", status: "idle", title: "Docs" },
    { id: "c", status: "closed", title: "Old" }, { id: "d", status: "idle", title: "Gone", archivedAt: "2026-11-11T00:00:00Z" },
    { id: "e", status: "idle", title: "Shell", backgroundWork: { count: 2 } },
  ];
  assert.deepEqual(taskAgentStates(["a", "b", "c", "d", "e", "x"], agents), {
    a: { title: "Reader fix", state: "working" }, b: { title: "Docs", state: "idle" }, c: { title: "Old", state: "closed" },
    d: { title: "Gone", state: "closed" }, e: { title: "Shell", state: "working" }, x: { title: null, state: "closed" },
  });
  assert.deepEqual(taskAgentStates(["a"], null), {}, "an unreadable directory says nothing (In progress)");
});

test("the task row and sheet take their line from shared/task-status.ts, never a hard-coded Agent working", async () => {
  const src = await readFile(join(import.meta.dirname, "../client/tasks.tsx"), "utf8");
  assert.ok(!src.includes("Agent working"), "client/tasks.tsx hard-codes Agent working");
  assert.match(src, /taskStatus\(/);
});
