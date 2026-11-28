// report_issue with workspace_id answers within TOOL_BUDGET (invariant 63's TOOL_BUDGET paragraph, invariant 154).
// 2026-11-28, 2.6.0-beta.6 live: the first call about one busy workspace returned 168,664 characters, all of it the
// local view: every PR the workspace ever had (401), every agent in its directory (345, mostly closed) and every task
// (174). The local view now reuses workspace_status's bounding (agentView): live work whole while it fits, finished
// items the newest few and a count; closed and archived agents are a count. Synthetic data only (example/app).
import test from "node:test";
import assert from "node:assert/strict";
import { Reporter } from "../server/report-issue";
import { LogRing } from "../server/report-issue/diagnostics";
import { followUpReportConfig, type FollowUpReportDeps } from "../server/report-issue-adapter";
import { PAGE, TOOL_BUDGET } from "../shared/paged";
import { finishedPr, finishedTask } from "../shared/finished";
import type { State } from "../shared/model";
import { busyAgents, liveSizedWorkspace } from "./support/live-seed";

const size = (v: unknown) => JSON.stringify(v).length;

function reporter() {
  const w = liveSizedWorkspace();
  const agents = busyAgents(w);
  const deps: FollowUpReportDeps = {
    github: { send: async () => ({ status: 404, body: {} }) } as never, updates: async () => { throw new Error("none"); }, call: async () => null,
    snapshot: async () => ({ workspaces: [w] } as unknown as State), resources: () => ({ level: "ok" } as never), serverInfo: async () => null,
    logs: new LogRing(), toolTransport: () => "native", startedAt: Date.parse("2026-11-28T07:00:00Z"), now: () => Date.parse("2026-11-28T09:00:00Z"),
    agents: async id => id === w.id ? agents : [],
  };
  return { w, agents, reporter: new Reporter(followUpReportConfig(deps)) };
}

test("report_issue about the live-sized workspace answers within TOOL_BUDGET, live work whole", async () => {
  const { w, agents, reporter: r } = reporter();
  const first = await r.run("agent-x", { kind: "bug", summary: "Send stuck", workspace_id: w.id }) as any;
  console.log(`report_issue procedure with workspace_id: ${size(first)} characters`);
  assert.ok(size(first) <= TOOL_BUDGET, `report_issue's first reply: ${size(first)} characters`);
  const local = first.subject.local;
  const openPrs = w.prs.filter(p => !finishedPr(p)).length;
  assert.equal(local.prs.filter((p: any) => p.state === "OPEN").length, openPrs, "every open PR");
  assert.equal(local.history.prs.total, w.prs.filter(finishedPr).length, "finished PRs: a count");
  assert.equal(local.history.prs.shown, PAGE.recentDone, "and the newest few");
  assert.equal(local.tasks.filter((t: any) => !["done", "waived"].includes(t.status)).length, w.obligations.filter(o => !finishedTask(o)).length, "every open task");
  const live = agents.filter(a => !a.archived && a.status !== "closed");
  assert.deepEqual(local.agents.map((a: any) => a.id), live.map(a => a.id), "live agents are rows, main first");
  assert.deepEqual(local.agentsFinished, { closed: agents.filter(a => !a.archived && a.status === "closed").length, archived: agents.filter(a => a.archived).length }, "closed and archived agents: counts");
  assert.ok(local.agents[0].main);
});
