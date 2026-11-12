import test from "node:test";
import assert from "node:assert/strict";
import { AgentActions, AGENT_TOOLS, PLANNED_TOOLS, READ_ONLY_TOOLS, SELF_PLANNED_TOOLS, type AgentActionDeps } from "../server/agent-actions";
import { PARITY, RPC_TOOLS } from "../server/agent-parity";
import { clientRpcs } from "./support/client-rpcs";
import { actionTools, toolList } from "../server/mcp.mjs";
import type { State } from "../shared/model";

/**
 * Tom (2026-11-10): "everything should be able to be done by an agent too". Every RPC the client calls (a button,
 * a switch, a settings field) needs an agent tool that does the same, or an explicit exemption with a reason. A new
 * developer RPC without an entry in server/agent-parity.ts PARITY fails here.
 */
const allToolNames = new Set<string>([...toolList(false, false, true, false, true).map((t: unknown[]) => t[0] as string), ...actionTools.map((t: unknown[]) => t[0] as string)]);

test("parity: every RPC the client calls has an agent tool, or an exemption with a reason", async () => {
  const rpcs = await clientRpcs();
  assert.ok(rpcs.size >= 40, `found only ${rpcs.size} client RPCs; the scan is broken`);
  const missing = [...rpcs].filter(([rpc]) => !PARITY[rpc]).map(([rpc, file]) => `${rpc} (${file})`);
  assert.deepEqual(missing, [], "add each to PARITY in server/agent-parity.ts with its agent tools, or { exempt: reason }");
  for (const [rpc, entry] of Object.entries(PARITY)) {
    assert.ok(rpcs.has(rpc.split("#")[0]), `PARITY has ${rpc}, which the client no longer calls: remove it`);
    if ("tools" in entry) for (const tool of entry.tools) assert.ok(allToolNames.has(tool), `${rpc}: ${tool} isn't an agent tool`);
    else assert.ok(("exempt" in entry ? entry.exempt : entry.pending).length >= 30, `${rpc}: an exemption needs a real reason`);
  }
});

test("parity: the bridge, the server and the annotations agree on every action tool", () => {
  const bridge = actionTools.map((t: unknown[]) => t[0] as string).sort();
  assert.deepEqual(bridge, [...AGENT_TOOLS].sort(), "server/mcp.mjs actionTools and AGENT_TOOLS list the same tools");
  for (const t of actionTools as [string, string, string, Record<string, unknown>, string[]][]) {
    const planned = PLANNED_TOOLS.includes(t[0] as never);
    // report_issue plans and confirms itself (server/report-issue/); its one-line description leaves the steps to its first reply.
    if (SELF_PLANNED_TOOLS.includes(t[0] as never)) { assert.ok(!planned && "confirm" in t[3] && "planId" in t[3], `${t[0]}: runs its own dry run and confirm`); continue; }
    assert.equal(planned, "confirm" in t[3] && "planId" in t[3], `${t[0]}: planned tools take planId and confirm`);
    if (planned) assert.match(t[1], /planId/, `${t[0]}: says it runs with confirm and the planId`);
    if (READ_ONLY_TOOLS.includes(t[0] as never)) assert.ok(!planned, `${t[0]}: a read is never planned`);
  }
  for (const t of RPC_TOOLS) assert.ok(t.kind !== "read" || READ_ONLY_TOOLS.includes(t.name as never), `${t.name}: reads are read-only tools`);
});

function rpcFixture(over: Partial<AgentActionDeps> = {}) {
  const calls: { method: string; input: unknown }[] = []; const notes: string[] = [];
  const state = { version: 1, workspaces: [] } as unknown as State;
  let display = { revision: "r1", values: { enable_trust_bypass: true, enable_inbox: true } as Record<string, unknown> };
  const writes: unknown[] = [];
  const deps = {
    store: { snapshot: async () => state, mutate: async <T>(fn: (s: State) => T) => fn(state) },
    prActions: {} as AgentActionDeps["prActions"], engine: {} as AgentActionDeps["engine"],
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async (by: string, agentId: string, action: string) => { notes.push(`${by}>${agentId}:${action}`); } },
    rpc: {
      async validate(method: string, input: unknown) { if (method === "follow.set-follow-settings" && (input as { activeWindowDays?: number }).activeWindowDays === 0) throw new Error("activeWindowDays must be at least 1"); return input; },
      async call(method: string, input: unknown) { calls.push({ method, input }); return { method }; },
    },
    display: { read: async () => display, write: async (revision: string, values: Record<string, unknown>) => { writes.push({ revision, values }); display = { revision: "r2", values }; return { status: "saved" }; } },
    ...over,
  } as AgentActionDeps;
  return { agent: new AgentActions(deps), calls, notes, writes };
}

test("a settings write is planned: the dry run shows before and the change and writes nothing; confirm runs the button's RPC", async () => {
  const f = rpcFixture();
  const plan = await f.agent.run("orchestrator", "set_follow_settings", { enable_auto_sends_default: false }) as { dryRun: boolean; planId: string; change: unknown; before: unknown };
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.change, { enable_auto_sends_default: false });
  assert.deepEqual(plan.before, { method: "follow.follow-settings" }, "what Settings shows now");
  assert.deepEqual(f.calls.map(c => c.method), ["follow.follow-settings"], "the dry run only read");
  await assert.rejects(f.agent.run("someone-else", "set_follow_settings", { confirm: true, planId: plan.planId }), /different tool or agent/);
  await f.agent.run("orchestrator", "set_follow_settings", { confirm: true, planId: plan.planId });
  assert.deepEqual(f.calls.at(-1), { method: "follow.set-follow-settings", input: { enable_auto_sends_default: false } });
  assert.deepEqual(f.notes, ["agent:orchestrator>orchestrator:set_follow_settings"], "audited in the ledger as the agent");
  await assert.rejects(f.agent.run("orchestrator", "set_follow_settings", { confirm: true, planId: plan.planId }), /expired or was already used/);
});

test("reads run the RPC directly; the RPC's own contract rejects bad writes at the dry run", async () => {
  const f = rpcFixture();
  assert.deepEqual(await f.agent.run("a", "reviewer_settings", {}), { method: "follow.reviewer-settings" });
  await assert.rejects(f.agent.run("a", "set_follow_settings", { activeWindowDays: 0 }), /at least 1|too_small|>=1/);
  await f.agent.run("a", "answer_question", { workspaceId: "w", questionId: "Q1", choice: "A" });
  await f.agent.run("a", "rerank_priorities", {});
  await f.agent.run("a", "set_onboarding", { action: "skip" });
  assert.ok(!f.calls.some(c => ["follow.answer-question", "follow.rank-now", "follow.set-onboarding"].includes(c.method)), "planned: nothing runs before confirm");
});

test("inbox_act unsnooze: Bring back now is an agent move too, planned", async () => {
  const f = rpcFixture();
  const plan = await f.agent.run("orchestrator", "inbox_act", { action: "unsnooze", agentIds: ["a2"] }) as { planId: string };
  assert.deepEqual(f.calls, [], "planned: nothing runs before confirm");
  await f.agent.run("orchestrator", "inbox_act", { confirm: true, planId: plan.planId });
  assert.deepEqual(f.calls.at(-1), { method: "follow.inbox-act", input: { action: "unsnooze", agentIds: ["a2"] } });
});
test("never on yourself: an agent can't answer its own brief or act on its own inbox row", async () => {
  const f = rpcFixture();
  await assert.rejects(f.agent.run("me", "brief_action", { agentId: "me", briefId: "b", decisionId: "d1", choice: "A" }), /your own brief/);
  await assert.rejects(f.agent.run("me", "inbox_act", { action: "unsorted_sign_off", agentIds: ["me"] }), /not your own/);
  assert.deepEqual(f.calls, []);
});

test("set_display: trust bypass and the other Display switches, planned, merged into the current document", async () => {
  const f = rpcFixture();
  assert.deepEqual((await f.agent.run("a", "display_settings", {}) as { values: unknown }).values, { enable_trust_bypass: true, enable_inbox: true });
  await assert.rejects(f.agent.run("a", "set_display", { values: { enable_everything: true } }), /unknown setting/);
  const same = await f.agent.run("a", "set_display", { values: { enable_inbox: true } }) as { planId: string | null };
  assert.equal(same.planId, null, "nothing changes, nothing to confirm");
  const plan = await f.agent.run("a", "set_display", { values: { enable_trust_bypass: false } }) as { planId: string; changes: unknown };
  assert.deepEqual(plan.changes, [{ key: "enable_trust_bypass", from: true, to: false }]);
  assert.deepEqual(f.writes, []);
  await f.agent.run("a", "set_display", { confirm: true, planId: plan.planId });
  assert.deepEqual(f.writes, [{ revision: "r1", values: { enable_trust_bypass: false, enable_inbox: true } }]);
});
