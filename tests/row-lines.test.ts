import test from "node:test";
import assert from "node:assert/strict";
import { buildHome, type PaseoWorkspaceLite } from "../shared/home";
import type { InboxRow, Reason } from "../shared/inbox";
import type { Workspace } from "../shared/model";
import { workstreams } from "../shared/overseer";
import { priorityRow, type Priority } from "../shared/priorities";
import { rankWorkstream, toPriorities, type RankInputs } from "../shared/ranker";
import { SORT_MODES } from "../shared/sort";
import { homeViolations } from "../shared/status-invariants";
import { pr, workspace } from "./fixtures";

// 1.4.0-beta.34 (seen in Paseo 0.16's sidebar view): in one workspace with an errored agent and a finished one, the
// Finished row's subline read "Agent errored before follow-up started; needs attention". Priorities are per workspace,
// the ranker read the workspace's first row (the error), and Home put that reason under every row of the workspace.
const NOW = Date.parse("2026-11-10T13:30:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (agentId: string, workspaceId: string, patch: Partial<InboxRow> = {}): InboxRow => ({
  agentId, workspaceId, title: agentId, workspaceTitle: `Workspace ${workspaceId}`, multiRoot: true, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: at(5), needs: null, snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true, brief: null, ...patch,
});
const flagged = (agentId: string, workspaceId: string, reason: Reason, minutesAgo: number, patch: Partial<InboxRow> = {}) =>
  row(agentId, workspaceId, { needs: { reasons: [{ reason, at: at(minutesAgo), detail: `${reason} detail`, dedupeKey: reason }], since: at(minutesAgo) }, ...patch });
const lite = (id: string): PaseoWorkspaceLite => ({ id, name: `Workspace ${id}`, project: "atlas", activityAt: at(30) });
const ERRORED = "Agent errored before follow-up started; needs attention";

/** The ranker's round trip: Home's rows as the Overseer sees them, a reply about "w", the stored priorities. */
function ranked(rows: InboxRow[], tracked: Workspace[], paseo: PaseoWorkspaceLite[], reason = ERRORED): Priority[] {
  const inputs: RankInputs = { workstreams: workstreams({ rows, tracked, paseo, now: NOW }).map(rankWorkstream), linear: [], slack: [], github: [], planning: null };
  return toPriorities({ priorities: [{ workspace: "w", score: 60, reason, sources: [] }], notStarted: [] }, inputs, at(2)).priorities;
}
const lineOf = (m: ReturnType<typeof buildHome>, key: string) => m.byKey.get(key)?.priority?.reason ?? null;

test("a Finished row never shows the reason ranked for its errored sibling", () => {
  const rows = [flagged("synthetic", "w", "error", 5), flagged("bg-nowait", "w", "finished", 3)];
  const priorities = ranked(rows, [], [lite("w")]);
  assert.equal(priorities[0].row, "agent:synthetic", "the ranker read the error row");
  for (const sort of SORT_MODES) {
    const model = buildHome({ rows, tracked: [], paseo: [lite("w")], now: NOW, sort, priorities });
    assert.equal(model.byKey.get("agent:bg-nowait")!.group, "needs");
    assert.equal(lineOf(model, "agent:bg-nowait"), null, `${sort}: the Finished row has no line of another row's`);
    assert.equal(lineOf(model, "agent:synthetic"), ERRORED, `${sort}: the row it was ranked from keeps it`);
    assert.deepEqual(homeViolations(model, priorities, NOW), []);
  }
});

test("a priority for the whole workspace shows on one row: its only row, its own row, or its main agent's", () => {
  const legacy: Priority = { workspaceId: "w", score: 50, reason: "HER-12 due Friday", sources: [{ kind: "linear", label: "HER-12" }], at: at(2) };
  const two = [flagged("a", "w", "error", 5), flagged("b", "w", "finished", 3)];
  const untracked = buildHome({ rows: two, tracked: [], paseo: [lite("w")], now: NOW, priorities: [legacy] });
  assert.deepEqual([lineOf(untracked, "agent:a"), lineOf(untracked, "agent:b")], [null, null], "no row to pick: no line, the score still sorts");
  const tracked = buildHome({ rows: two, tracked: [workspace({ id: "w", mainAgentId: "b", prs: [] })], paseo: [lite("w")], now: NOW, priorities: [legacy] });
  assert.deepEqual([lineOf(tracked, "agent:a"), lineOf(tracked, "agent:b")], [null, "HER-12 due Friday"], "the main agent's row");
  const one = buildHome({ rows: [flagged("a", "w", "error", 5)], tracked: [], paseo: [lite("w")], now: NOW, priorities: [legacy] });
  assert.equal(lineOf(one, "agent:a"), "HER-12 due Friday");
  // The row it was ranked from has gone (its flag cleared): the reason described it, so no other row inherits it.
  const gone = buildHome({ rows: [flagged("b", "w", "finished", 3)], tracked: [], paseo: [lite("w")], now: NOW, priorities: [{ ...legacy, row: "agent:a" }] });
  assert.equal(lineOf(gone, "agent:b"), null);
  assert.equal(priorityRow({ workspaceId: "w" }, [{ key: "agent:a", agentId: "a" }, { key: "ws:w", agentId: "m" }]), "ws:w");
});

test("row-lines-own-row holds for every row kind, every sort, with ranked and workspace-wide priorities", () => {
  // Each workspace mixes row kinds: needs (each flag), later, running, sending, tracked workspace rows, Paseo-only.
  const reasons: Reason[] = ["permission", "error", "paused", "ci", "review", "reviewers", "finished", "pr_closed", "pr_merged"];
  const rows: InboxRow[] = [];
  reasons.forEach((r, i) => {
    rows.push(flagged(`n${i}`, `w${i}`, r, 10 + i));
    rows.push(i % 3 === 0 ? row(`r${i}`, `w${i}`, { status: "running" }) : i % 3 === 1 ? flagged(`l${i}`, `w${i}`, "finished", 4, { snooze: { until: at(-60), at: at(1) } } as Partial<InboxRow>) : flagged(`f${i}`, `w${i}`, "finished", 2));
  });
  const tracked = [
    workspace({ id: "w1", mainAgentId: "n1", prs: [pr()] }),
    workspace({ id: "t-busy", mainAgentId: "tb", runtimeBusy: true, prs: [] }),
    workspace({ id: "t-open", mainAgentId: "to", prs: [pr()] }),
    workspace({ id: "t-quiet", mainAgentId: "tq", prs: [] }),
  ];
  const paseo = [...reasons.map((_, i) => lite(`w${i}`)), lite("t-busy"), lite("t-open"), lite("t-quiet"), lite("bare")];
  const inputs: RankInputs = { workstreams: workstreams({ rows, tracked, paseo, now: NOW }).map(rankWorkstream), linear: [], slack: [], github: [], planning: null };
  const reply = { priorities: inputs.workstreams.map((w, i) => ({ workspace: w.id, score: 90 - i, reason: `Reason read from ${w.row}`, sources: [] })), notStarted: [] };
  const rankedPriorities = toPriorities(reply, inputs, at(1)).priorities;
  assert.ok(rankedPriorities.length >= 10 && rankedPriorities.every(p => p.row), "every ranked priority names its row");
  const wide: Priority[] = rankedPriorities.map(({ row: _row, ...p }) => ({ ...p, reason: `Workspace-wide ${p.workspaceId}` }));
  for (const priorities of [rankedPriorities, wide]) for (const sort of SORT_MODES) {
    const model = buildHome({ rows, tracked, paseo, now: NOW, sort, priorities });
    assert.deepEqual(homeViolations(model, priorities, NOW), [], sort);
    for (const s of model.byKey.values()) if (s.priority && priorities === rankedPriorities) assert.equal(s.priority.reason, `Reason read from ${s.key}`);
  }
});

test("row-lines-own-row catches a reason on a row it wasn't ranked from", () => {
  const rows = [flagged("synthetic", "w", "error", 5), flagged("bg-nowait", "w", "finished", 3)];
  const priorities = ranked(rows, [], [lite("w")]);
  const model = buildHome({ rows, tracked: [], paseo: [lite("w")], now: NOW, priorities });
  const leaked = new Map([...model.byKey].map(([k, s]) => [k, { ...s, priority: model.byKey.get("agent:synthetic")!.priority }]));
  assert.deepEqual(homeViolations({ byKey: leaked }, priorities, NOW).map(v => v.id), ["row-lines-own-row"]);
});
