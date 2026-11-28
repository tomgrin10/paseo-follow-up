// Every agent tool whose reply can carry a workspace's data answers within TOOL_BUDGET on the live-sized seed
// (invariant 63's TOOL_BUDGET paragraph). 2026-11-28: report_issue with workspace_id (invariant 154) built its own lists
// and returned 168,664 characters live; the guard measured workspace_status alone, so CI passed. The same scan found
// five planned actions (answer_question, dismiss_question, run_recovery, set_workspace_spec, set_task_trigger) whose
// confirm returned the whole stored workspace. Nothing here is a list of tools to remember: the RPC contracts say which
// replies embed a workspace (a scan of their output schemas), and every other tool must be classified below, so a new
// tool fails until it is measured or says why it carries no workspace. Synthetic data only (example/app).
import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../shared/contracts";
import { workspaceSchema, type State, type Workspace } from "../shared/model";
import { TOOL_BUDGET } from "../shared/paged";
import { agentView } from "../shared/history";
import { actionTools, compact, lookupTools, overseerTools, tools } from "../server/mcp.mjs";
import { AGENT_TOOLS, AgentActions, TOOL_INPUT, PLANNED_TOOLS, type AgentTool } from "../server/agent-actions";
import { RPC_TOOLS } from "../server/agent-parity";
import { isWorkspaceRecord } from "../server/bounded-reply";
import { Reporter } from "../server/report-issue";
import { LogRing } from "../server/report-issue/diagnostics";
import { followUpReportConfig } from "../server/report-issue-adapter";
import { sample } from "./support/sample-input";
import { busyAgents, liveSizedWorkspace } from "./support/live-seed";

const size = (v: unknown) => JSON.stringify(v).length;
type Contract = { name: string; output: unknown };
const RPCS = new Map<string, Contract>((Object.values(contracts) as unknown[]).filter((x): x is Contract => !!x && typeof x === "object" && typeof (x as Contract).name === "string" && "output" in (x as object)).map(c => [c.name, c]));

/** The schemas of a workspace's growing lists: a contract whose output reaches one of them embeds workspace data. */
const LISTS = new Set<unknown>((["prs", "obligations", "questions", "batches", "prActions"] as const).flatMap(k => { const s = workspaceSchema.shape[k] as any; return [s, s.element, s.unwrap?.(), s.unwrap?.().element]; }).filter(Boolean));
function embedsWorkspace(schema: any, seen = new Set<unknown>()): boolean {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return false;
  seen.add(schema);
  if (LISTS.has(schema)) return true;
  const d = schema._zod?.def ?? schema.def;
  if (!d) return false;
  const kids = [d.innerType, d.element, d.in, d.out, d.left, d.right, d.valueType, ...(d.options ?? []), ...(d.items ?? []), ...Object.values(d.shape ?? {})];
  return kids.some(k => embedsWorkspace(k, seen));
}

/** The contract's sampled output with the live-sized workspace wherever it holds a workspace record (its own sampled items kept, so receipts find them). */
function withSeed(output: unknown, w: Workspace): unknown {
  if (isWorkspaceRecord(output)) return { ...output, ...w, prs: [...output.prs, ...w.prs], obligations: [...output.obligations, ...w.obligations], questions: [...output.questions, ...w.questions], batches: [...output.batches, ...w.batches], excludedStacks: [...((output as any).excludedStacks ?? []), ...w.excludedStacks] };
  if (Array.isArray(output)) return output.map(x => withSeed(x, w));
  if (output && typeof output === "object") return Object.fromEntries(Object.entries(output).map(([k, v]) => [k, withSeed(v, w)]));
  return output;
}

// How the worker shapes a reply before the transport sees it, where the handler does more than return its contract.
const HANDLER_VIEW: Record<string, (w: Workspace) => unknown> = {
  "follow.agent-status": w => agentView(w, {}, undefined, v => compact("workspace_status", {}, v)),
};

test("every bridge tool whose RPC returns workspace data answers within TOOL_BUDGET as sent", () => {
  const w = liveSizedWorkspace();
  const measured: string[] = [];
  for (const [name, , rpc] of tools as unknown as [string, string, string][]) {
    const c = RPCS.get(rpc);
    assert.ok(c, `${name}: no contract for ${rpc}`);
    if (!embedsWorkspace(c.output) && !HANDLER_VIEW[rpc]) continue;
    const sampled = sample(c.output) as any;
    // A receipt picks the item the call named: name the sampled one.
    const input = { ...(sample((c as any).input) as Record<string, unknown>), ...(sampled?.batches?.[0] ? { batchId: sampled.batches[0].id } : {}) };
    const out = HANDLER_VIEW[rpc]?.(w) ?? withSeed(sampled, w);
    let sent: unknown;
    try { sent = compact(name, input ?? {}, out); } catch (error) { assert.fail(`${name}: its receipt can't read the sampled output (${(error as Error).message})`); }
    assert.ok(size(sent) <= TOOL_BUDGET, `${name}: ${size(sent)} characters`);
    measured.push(name);
  }
  assert.deepEqual(measured.sort(), ["acknowledge_batch", "ask_question", "declare_done", "enroll_workspace", "exclude_stack", "record_answer", "register_pr", "update_obligation", "withdraw_question", "workspace_status"].sort(), "the scan finds the workspace-returning bridge tools");
});

function actions(w: Workspace, rpcOut: (method: string) => unknown) {
  const state = { version: 1, workspaces: [w] } as unknown as State;
  const reporter = new Reporter(followUpReportConfig({
    github: { send: async () => ({ status: 404, body: {} }) } as never, updates: async () => { throw new Error("none"); }, call: async () => null,
    snapshot: async () => state, resources: () => ({ level: "ok" } as never), serverInfo: async () => null, logs: new LogRing(), toolTransport: () => "native",
    startedAt: 0, now: () => Date.parse("2026-11-28T09:00:00Z"), agents: async () => busyAgents(w),
  }));
  return new AgentActions({
    store: { snapshot: async () => state, mutate: async (fn: (s: State) => unknown) => fn(state) }, prActions: {} as never,
    engine: { activate: async () => w } as never, about: { get: async () => null, view: async () => ({ status: "ready", record: null, links: [], error: null }) } as never,
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async () => {} },
    rpc: { call: async (method: string) => rpcOut(method), validate: async (_m: string, input: unknown) => input },
    report: { run: (caller: string, args: unknown) => reporter.run(caller, args) }, now: () => Date.parse("2026-11-28T09:00:00Z"),
  } as never);
}

/** Run a tool as an agent would, through its dry run and confirm when it plans. */
async function reply(a: AgentActions, tool: AgentTool, args: Record<string, unknown>) {
  const first = await a.run("orchestrator", tool, args) as any;
  if (!PLANNED_TOOLS.includes(tool) || !first?.planId) return [first];
  return [first, await a.run("orchestrator", tool, { ...args, confirm: true, planId: first.planId })];
}

test("every action whose RPC returns workspace data answers within TOOL_BUDGET, dry run and confirm", async () => {
  const w = liveSizedWorkspace();
  const measured: string[] = [];
  for (const t of RPC_TOOLS) {
    const c = RPCS.get(t.rpc);
    assert.ok(c, `${t.name}: no contract for ${t.rpc}`);
    if (!embedsWorkspace(c.output)) continue;
    const a = actions(w, method => withSeed(sample(RPCS.get(method)!.output), w));
    const args = sample((TOOL_INPUT as Record<string, unknown>)[t.name]) as Record<string, unknown>;
    for (const r of await reply(a, t.name as AgentTool, args)) assert.ok(size(r) <= TOOL_BUDGET, `${t.name}: ${size(r)} characters`);
    measured.push(t.name);
  }
  assert.ok(["answer_question", "dismiss_question", "run_recovery", "set_workspace_spec", "set_task_trigger"].every(n => measured.includes(n)), `the scan finds the workspace-returning actions (${measured.join(", ")})`);
});

// Tools whose reply no RPC contract describes (the worker builds it, or it is z.unknown()). Each is measured on the
// seed or says why it carries no workspace's lists. A new tool fails the completeness check until it is here.
const MEASURED: Partial<Record<AgentTool, Record<string, unknown>>> = {
  list_prs: { include_closed: true }, report_issue: { kind: "bug", summary: "Send stuck", workspace_id: "WS" }, track: { workspace: "WS" },
  set_auto_send: { workspace: "WS", value: true }, clear_hold: { workspace: "WS" }, workspace_about: { workspaceId: "WS" },
};
const NO_WORKSPACE: Record<string, string> = {
  make_main_agent: "a claim receipt: the target agent and the rules checked", add_reviewers: "the PRs named in the call", merge: "the PRs named in the call",
  enable_merge_when_ready: "the PRs named in the call", disable_merge_when_ready: "the PRs named in the call", send_repairs: "one batch's receipt",
  retry_batch: "control receipt, measured as set_auto_send", inbox_list: "inbox rows, bounded in tests/bounded-tools.test.ts", sign_off: "inbox rows named in the call",
  snooze: "inbox rows named in the call", snooze_workspace: "one workspace's snooze", set_finish_flags: "agents named in the call", set_priorities: "priority rows, one per workspace",
  agent_settings: "settings", display_settings: "settings", set_display: "settings", ai_rename: "a title", pin_workspace: "one flag", dispatch: "one dispatch plan",
  // Overseer tools answer from Home's model and one agent's digest: a row per workspace, never a workspace's lists.
  workstreams: "Home rows, one per workspace", agent_digest: "one agent's last steps (default 10)", route_candidates: "a score per workspace",
  send_to_agent: "a send receipt", start_workspace: "a dispatch receipt", rerank: "ranker state",
  find_action: "action names and descriptions", run_action: "the named action's own reply, guarded as that action",
};

test("every agent tool is scanned, measured or says why it carries no workspace", async () => {
  const contractRpcs = new Set(RPC_TOOLS.map(t => t.name));
  const all = [...(tools as unknown as [string][]), ...(actionTools as unknown as [string][]), ...(overseerTools as unknown as [string][]), ...(lookupTools as unknown as [string][])].map(t => t[0]);
  const bridge = new Set((tools as unknown as [string][]).map(t => t[0]));
  const unclassified = all.filter(n => !bridge.has(n) && !contractRpcs.has(n) && !(n in MEASURED) && !(n in NO_WORKSPACE));
  assert.deepEqual(unclassified, [], "classify each new tool: MEASURED (with its input) or NO_WORKSPACE (with why)");
  for (const n of AGENT_TOOLS) assert.ok(all.includes(n), `${n} is an agent tool the bridge lists`);

  const w = liveSizedWorkspace();
  const a = actions(w, () => null);
  for (const [tool, input] of Object.entries(MEASURED) as [AgentTool, Record<string, unknown>][]) {
    const args = JSON.parse(JSON.stringify(input).replaceAll("\"WS\"", JSON.stringify(w.id)));
    const replies = await reply(a, tool, args).catch((error: Error) => assert.fail(`${tool}: ${error.message}`));
    for (const r of replies) assert.ok(size(r) <= TOOL_BUDGET, `${tool}: ${size(r)} characters`);
  }
});

test("an action's reply that carries a stored workspace gets workspace_status's summary instead", async () => {
  const w = liveSizedWorkspace();
  const a = actions(w, method => method === "follow.recover" ? w : null);
  const [plan, done] = await reply(a, "run_recovery", { workspaceId: w.id }) as any[];
  assert.ok(plan.planId && done, "dry run, then confirm");
  assert.ok(size(w) > 10 * TOOL_BUDGET, `the stored workspace is ${size(w)} characters`);
  assert.ok(size(done) <= TOOL_BUDGET, `confirm: ${size(done)} characters`);
  assert.equal(done.detail, "summary", "the workspace comes as workspace_status's summary");
  assert.equal(done.history.prs.total, w.prs.filter(p => p.snapshot?.state === "MERGED" || p.snapshot?.state === "CLOSED").length);
});
