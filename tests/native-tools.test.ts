import test from "node:test";
import assert from "node:assert/strict";
import { availableTools, attachableTools, nativeTools, nativeToolsAvailable, PREFIX, type SessionFlags } from "../server/native-tools";
import { callableTools, toolList, overseerTools } from "../server/mcp.mjs";
/** Paseo 0.16 requires `metadata` on hook agents and session requests; spread, so 0.15's types accept it too. */
const withMetadata = { metadata: {} };

const flags = (over: Partial<SessionFlags> = {}): SessionFlags => ({ recovery: false, brief: true, root: true, overseer: false, ...over });
const names = (list: { 0: string }[]) => list.map(t => t[0]).sort();

test("availability per call matches the stdio bridge's rule for every role", () => {
  assert.deepEqual(names(availableTools(flags(), { role: "main", inbox: true })), names(callableTools(false, false, true, false, true)));
  assert.deepEqual(names(availableTools(flags(), { role: "contributor", inbox: true })), names(callableTools(false, true, true, false, true)));
  assert.deepEqual(names(availableTools(flags(), { role: null, inbox: false })), names(callableTools(false, false, false, true, true)), "untracked root: actions only while the inbox is off");
  assert.deepEqual(names(availableTools(flags({ recovery: true }), { role: "main", inbox: true })), names(callableTools(true, false, false, false, false)), "a recovery session never gets needs_you or actions");
  assert.ok(availableTools(flags({ overseer: true }), { role: null, inbox: true }).some(t => t[0] === overseerTools[0][0]));
  assert.ok(!availableTools(flags(), { role: null, inbox: true }).some(t => t[0] === overseerTools[0][0]), "overseer tools only for the Overseer");
});

test("a session is offered every tool its role could list; the rest of the actions through run_action", () => {
  const listed = { main: [false, false, true, false, true], contributor: [false, true, true, false, true], null: [false, false, true, true, true] } as const;
  for (const role of ["main", "contributor", null] as const) for (const inbox of [true, false]) {
    const offered = new Set(names(attachableTools(flags())));
    const [r, c, , o, a] = listed[String(role) as keyof typeof listed];
    for (const name of names(toolList(r, c, inbox, o, a))) assert.ok(offered.has(name), `${role}/${inbox}: ${name}`);
    const reachable = names(availableTools(flags(), { role, inbox }));
    for (const name of reachable) assert.ok(offered.has(name) || offered.has("run_action"), `${role}/${inbox}: ${name} is reachable`);
  }
  assert.ok(!names(attachableTools(flags())).includes("merge"), "the action long tail is not attached");
  const recovery = names(attachableTools(flags({ recovery: true })));
  assert.ok(!recovery.includes("needs_you") && !recovery.includes("merge"));
  assert.ok(!names(attachableTools(flags({ root: false, brief: false }))).includes("merge"), "no action tools for a non-root session");
});

test("native tools only where the host serves plugin tools to this provider", () => {
  const request = { provider: "claude", tools: [] };
  assert.equal(nativeToolsAvailable(request, null), true);
  assert.equal(nativeToolsAvailable({ provider: "claude" }, null), false, "Paseo 0.14 has no request.tools: stdio fallback");
  assert.equal(nativeToolsAvailable(request, { daemon: { mcp: { injectIntoAgents: false } } }), false);
  assert.equal(nativeToolsAvailable(request, { daemon: { mcp: { enabled: false } } }), false);
  assert.equal(nativeToolsAvailable(request, { agents: { providers: { claude: { paseoTools: { enabled: false } } } } }), false);
  assert.equal(nativeToolsAvailable(request, { agents: { providers: { claude: { paseoTools: { disabledTools: ["follow_needs_you"] } } } } }), false);
  assert.equal(nativeToolsAvailable({ provider: "codex", tools: [] }, { agents: { providers: { claude: { paseoTools: { enabled: false } } } } }), true);
});

test("a call runs the RPC handler with the daemon's agent id, re-checks the role and returns the compact receipt", async () => {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  let role: "main" | null = "main";
  const tools = nativeTools(flags(), async () => ({ role, inbox: true }), async (method, input) => {
    calls.push({ method, input });
    if (method === "follow.agent-status") return { id: "wks_1", title: "W", goal: "G", mainAgentId: "agent-1", enable_tracking: true, enable_auto_sends: true, hold: null, archived: false, prs: [], obligations: [], questions: [], batches: [], excludedStacks: [] };
    return { ok: true };
  });
  for (const tool of tools) assert.match(tool.name, new RegExp(`^${PREFIX}[a-z_]+$`));
  const status = tools.find(t => t.name === "follow_workspace_status")!;
  const context = { agent: { id: "agent-1", workspaceId: "wks_1", parentAgentId: null, provider: "claude", cwd: "/w", title: null, ...withMetadata }, paseo: {} as never, signal: new AbortController().signal };
  const result = await status.execute({ agentId: "spoofed" } as never, context);
  assert.equal(result.isError, true, "unknown arguments are rejected, so an agentId can't be smuggled in");
  const ok = await status.execute({}, context);
  assert.equal(ok.isError, undefined); assert.equal(calls.at(-1)!.input.agentId, "agent-1");
  assert.equal(JSON.parse(ok.text!).detail, "summary", "compact receipt by default");
  const act = tools.find(t => t.name === "follow_run_action")!;
  await act.execute({ action: "list_prs", args: {} }, context);
  assert.deepEqual(calls.at(-1), { method: "follow.agent-act", input: { tool: "list_prs", args: {}, agentId: "agent-1" } });
  role = null;
  const gone = await tools.find(t => t.name === "follow_register_pr")!.execute({ repo: "o/r", number: 1 }, context);
  assert.equal(gone.isError, true, "role re-checked on every call");
  assert.match(gone.text!, /unavailable for the current agent/);
});
