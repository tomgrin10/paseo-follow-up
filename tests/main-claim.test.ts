import test from "node:test";
import assert from "node:assert/strict";
import { AgentActions, type AgentActionDeps } from "../server/agent-actions";
import { checkMainClaim, markMainWork, setMainAgent, MAIN_CHANGE_COOLDOWN_MS, MAIN_IDLE_MS, MAIN_RECLAIM_MS, type MainAgentInfo } from "../server/discovery";
import { scopes } from "../server/scopes";
import { toolList } from "../server/mcp.mjs";
import { recentMainChange } from "../shared/home";
import type { State, Workspace } from "../shared/model";
import { clock, pr, workspace } from "./fixtures";

// Main-agent claims, as approved (~/paseo-harness/main-agent-claim.md, 2026-11-10).
const idle: MainAgentInfo = { status: "idle", activeTurn: null, pendingPermissions: [] };
const busy: MainAgentInfo = { status: "running", activeTurn: { id: "t" }, pendingPermissions: [] };
const at = (ms: number) => new Date(clock - ms).toISOString();
const ws = (patch: Partial<Workspace> = {}) => workspace({ mainAgentId: "main", contributorAgentIds: ["helper"], prs: [pr({ registeredAgentId: "main" })], ...patch });

test("rule 1-3: the developer's ask is refused only mid-turn; anyone outside the workspace's roots never", () => {
  assert.deepEqual(checkMainClaim(ws(), "helper", "developer", idle, clock), { blockers: [], rule: "asked by the developer" });
  assert.match(checkMainClaim(ws(), "helper", "developer", busy, clock).blockers.join(), /mid-turn/);
  assert.match(checkMainClaim(ws(), "helper", "developer", { ...idle, pendingPermissions: [{}] }, clock).blockers.join(), /mid-turn/, "a pending permission is mid-turn");
  assert.match(checkMainClaim(ws(), "stranger", "developer", idle, clock).blockers.join(), /root agents/);
  assert.match(checkMainClaim(ws(), "main", "developer", idle, clock).blockers.join(), /Already/);
});

test("rule 2: a self-claim needs the main archived, gone, closed 30 minutes, or idle 24 hours with every open PR the claimant's", () => {
  assert.match(checkMainClaim(ws(), "helper", "self", idle, clock).blockers.join(), /ask the developer/i, "a live, working main keeps it");
  assert.equal(checkMainClaim(ws(), "helper", "self", null, clock).rule, "the main agent is archived or gone");
  assert.equal(checkMainClaim(ws(), "helper", "self", { ...idle, archivedAt: at(1) }, clock).rule, "the main agent is archived or gone");
  assert.equal(checkMainClaim(ws({ mainClosedSince: at(MAIN_CHANGE_COOLDOWN_MS) }), "helper", "self", { status: "closed" }, clock).rule, "the main agent has been closed for 30 minutes");
  assert.ok(checkMainClaim(ws({ mainClosedSince: at(MAIN_CHANGE_COOLDOWN_MS - 1) }), "helper", "self", { status: "closed" }, clock).blockers.length, "29 minutes closed isn't enough");
  const theirs = ws({ prs: [pr({ registeredAgentId: "helper" })], mainWorkAt: at(MAIN_IDLE_MS) });
  assert.equal(checkMainClaim(theirs, "helper", "self", idle, clock).rule, "it registered every open PR and the main agent has been idle for 24 hours");
  assert.ok(checkMainClaim({ ...theirs, mainWorkAt: at(MAIN_IDLE_MS - 1) }, "helper", "self", idle, clock).blockers.length, "the main worked within 24 hours");
  assert.ok(checkMainClaim({ ...theirs, mainWorkAt: undefined }, "helper", "self", idle, clock).blockers.length, "unknown main activity never counts as idle");
  assert.ok(checkMainClaim({ ...theirs, prs: [pr({ registeredAgentId: "helper" }), pr({ key: "example/app#2", number: 2, registeredAgentId: "main" })] }, "helper", "self", idle, clock).blockers.length, "every open PR, not some");
});

test("rule 4: no self-claim within 30 minutes of a change, and the agent that lost the role can't take it back for 2 hours", () => {
  const changed = ws({ mainHistory: [{ from: "helper", to: "main", by: "agent:main", reason: "r", at: at(MAIN_CHANGE_COOLDOWN_MS - 1) }] });
  assert.match(checkMainClaim(changed, "helper", "self", null, clock).blockers.join(), /less than 30 minutes/);
  assert.equal(checkMainClaim(changed, "helper", "developer", idle, clock).blockers.length, 0, "the developer's ask isn't held by the cooldown");
  const lost = ws({ mainHistory: [{ from: "helper", to: "main", by: "agent:main", reason: "r", at: at(MAIN_RECLAIM_MS - 1) }] });
  assert.match(checkMainClaim(lost, "helper", "self", null, clock).blockers.join(), /2 hours/);
  assert.equal(checkMainClaim({ ...lost, mainHistory: [{ ...lost.mainHistory![0], at: at(MAIN_RECLAIM_MS) }] }, "helper", "self", null, clock).blockers.length, 0);
});

function tool(state: State, info: Record<string, MainAgentInfo>) {
  const notes: string[] = [];
  const deps = {
    store: { snapshot: async () => state, mutate: async <T>(fn: (s: State) => T) => fn(state) },
    prActions: {} as AgentActionDeps["prActions"], engine: {} as AgentActionDeps["engine"],
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async (by: string, agentId: string, action: string) => { notes.push(`${by}>${agentId}:${action}`); } },
    agentInfo: async (id: string) => info[id] ?? null, now: () => clock,
  } as AgentActionDeps;
  return { agent: new AgentActions(deps), notes, w: () => state.workspaces[0] };
}

test("make_main_agent: a contributor takes over when the developer asks; dry run, confirm, history, audit", async () => {
  const state = { version: 1, workspaces: [ws()] } as unknown as State;
  const info: Record<string, MainAgentInfo> = { main: idle };
  const f = tool(state, info);
  await assert.rejects(f.agent.run("helper", "make_main_agent", { requested: "developer" }), /give reason/);
  const plan = await f.agent.run("helper", "make_main_agent", { requested: "developer", reason: "Tom asked me to take over the release" }) as { planId: string; from: string; to: string; blockers: string[] };
  assert.deepEqual([plan.from, plan.to, plan.blockers], ["main", "helper", []]);
  assert.equal(f.w().mainAgentId, "main", "the dry run changes nothing");
  info.main = busy;
  await assert.rejects(f.agent.run("helper", "make_main_agent", { confirm: true, planId: plan.planId }), /mid-turn/, "rules are checked again at confirm");
  info.main = idle;
  const again = await f.agent.run("helper", "make_main_agent", { requested: "developer", reason: "Tom asked me to take over the release" }) as { planId: string };
  await f.agent.run("helper", "make_main_agent", { confirm: true, planId: again.planId });
  assert.equal(f.w().mainAgentId, "helper");
  assert.deepEqual(f.w().contributorAgentIds, ["main"]);
  assert.deepEqual(f.w().mainHistory?.at(-1), { from: "main", to: "helper", by: "agent:helper", reason: "Tom asked me to take over the release (the developer asked)", at: new Date(clock).toISOString() });
  assert.deepEqual(f.notes, ["agent:helper>main:make_main_agent"]);
  // The old main can't take it straight back on its own.
  const back = await f.agent.run("main", "make_main_agent", { requested: "self", reason: "I'm back" }) as { planId: string | null; blockers: string[] };
  assert.equal(back.planId, null); assert.ok(back.blockers.some(b => /30 minutes|2 hours/.test(b)));
});

test("make_main_agent: the main can hand its role on; a stranger can't touch the workspace", async () => {
  const state = { version: 1, workspaces: [ws()] } as unknown as State;
  const f = tool(state, { main: busy });
  const plan = await f.agent.run("main", "make_main_agent", { agentId: "helper", requested: "self", reason: "Handing the release to the helper" }) as { planId: string };
  await f.agent.run("main", "make_main_agent", { confirm: true, planId: plan.planId });
  assert.equal(f.w().mainAgentId, "helper", "the main itself isn't held by its own turn or the self-claim rules");
  await assert.rejects(f.agent.run("stranger", "make_main_agent", { requested: "developer", reason: "x" }), /root agent of a tracked workspace/);
});

test("main-agent work is noted at most hourly, and makes a handover stick", () => {
  const w = ws({ handover: { from: "x", at: at(1), worked: false } });
  const state = { version: 1, workspaces: [w] } as unknown as State;
  assert.equal(markMainWork(state, "main", clock), true);
  assert.equal(w.mainWorkAt, new Date(clock).toISOString()); assert.equal(w.handover?.worked, true);
  assert.equal(markMainWork(state, "main", clock + 59 * 60_000), false, "no write within the hour");
  assert.equal(markMainWork(state, "helper", clock + 2 * 3_600_000), false, "only the main's work counts");
});

test("rule 3: the old main hears on its next turn through the hook, from scopes.json, for a day", async () => {
  process.env.FOLLOW_THROUGH_HOOK_IMPORT = "1";
  // @ts-expect-error plain JS hook, generated into hook-source.ts
  const { demotedNotice } = await import("../server/agent-hook.mjs");
  const w = ws(); setMainAgent(w, "helper", "claim", clock, { by: "agent:helper", reason: "Tom asked" });
  const entry = scopes({ version: 1, workspaces: [w] } as unknown as State).main as { role: string; demoted?: { to: string; at: string } };
  assert.equal(entry.role, "contributor");
  assert.deepEqual({ to: entry.demoted?.to, at: entry.demoted?.at }, { to: "helper", at: new Date(clock).toISOString() });
  const notice = demotedNotice(entry.demoted, clock + 60_000);
  assert.match(notice!.text, /no longer this workspace's main agent: helper took over at 10:00 UTC \(it was claimed: Tom asked\)/);
  assert.equal(demotedNotice(entry.demoted, clock + 24 * 3_600_000 + 1), null, "after a day it's history");
});

test("rule 5: Home badges an agent's or Follow-up's change for a day; the developer's own isn't announced", () => {
  const w = ws(); setMainAgent(w, "helper", "claim", clock, { by: "agent:helper", reason: "r" });
  assert.equal(recentMainChange(w, clock + 60_000)?.to, "helper");
  assert.equal(recentMainChange(w, clock + 24 * 3_600_000), null);
  const mine = ws(); setMainAgent(mine, "helper", "developer", clock);
  assert.equal(recentMainChange(mine, clock + 60_000), null);
  assert.equal(mine.mainHistory?.at(-1)?.by, "developer");
});

test("contributors are offered make_main_agent and no other action tool; recovery sessions none", () => {
  const names = (list: unknown[][]) => list.map(t => t[0] as string);
  const contributor = names(toolList(false, true, false, false, true));
  assert.ok(contributor.includes("make_main_agent"));
  assert.ok(!contributor.includes("merge") && !contributor.includes("set_display"));
  assert.ok(!names(toolList(true, false, false, false, true)).includes("make_main_agent"));
});
