import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as bridge from "../server/mcp.mjs";
import { actionTools, callableTools, findActions, lookupTools, overseerTools, resolveAction, runTool, schemas, toolList, tools, type ToolTuple } from "../server/mcp.mjs";
import { attachableTools, availableTools } from "../server/native-tools";
import { withSystemPrompt, type PromptDeps } from "../server/session-prompt";
import { WAIT_TOOLS } from "../server/wait";

// Invariant 139, agent-tools-by-role: each kind of agent lists the tools its role uses (ROLE_TOOLS in server/mcp.mjs),
// and every other action stays reachable through find_action/run_action. Before (2.6.0-beta.2) every root agent listed
// all 99 actions: main 117 tools ≈22.1k tokens, an untracked root agent 101 ≈17.7k, the Overseer 107 ≈18.6k.

/** Tokens a tool list costs an agent that loads its schemas (Codex, ACP): chars ÷ 3.6 over the listed JSON, as measured in the harness. */
const tokens = (list: ToolTuple[]) => Math.round(JSON.stringify(schemas(list)).length / 3.6);
const names = (list: ToolTuple[]) => list.map(t => t[0]);

// [recovery, contributor, brief, briefOnly, actions] per role, as the bridge and the native attach call toolList.
const ROLES = {
  main: [false, false, true, false, true],
  contributor: [false, true, true, false, true],
  recovery: [true, false, false, false, false],
  untracked: [false, false, true, true, true],
} as const;
const listed = (role: keyof typeof ROLES, overseer = false) => [...toolList(...ROLES[role]), ...(overseer ? overseerTools : [])];

// Budgets in tokens, with room for a sentence or two. Raising one is a decision: say why in the PR.
const BUDGET = { main: 6200, contributor: 2400, recovery: 2800, untracked: 1500, overseer: 2500, nativeRoot: 6600 };

test("each role's tool list stays inside its token budget", () => {
  const measured = {
    main: tokens(listed("main")), contributor: tokens(listed("contributor")), recovery: tokens(listed("recovery")),
    untracked: tokens(listed("untracked")), overseer: tokens(listed("untracked", true)),
    nativeRoot: tokens(attachableTools({ recovery: false, brief: true, root: true, overseer: false })),
  };
  for (const [role, budget] of Object.entries(BUDGET)) assert.ok(measured[role as keyof typeof measured] <= budget, `${role}: ${measured[role as keyof typeof measured]} tokens, budget ${budget}`);
  assert.ok(listed("main").length <= 24, `main lists ${listed("main").length} tools`);
});

test("no role lists the action long tail; every action stays callable by the roles that had it", () => {
  for (const role of ["main", "untracked"] as const) {
    const list = names(listed(role));
    assert.deepEqual(list.filter(n => actionTools.some(t => t[0] === n)), ["make_main_agent"], `${role} lists no action directly but the claim`);
    assert.ok(list.includes("find_action") && list.includes("run_action"), `${role} has the lookup`);
    assert.deepEqual(names(callableTools(...ROLES[role])).filter(n => actionTools.some(t => t[0] === n)).sort(), names(actionTools).sort(), `${role} may still run every action`);
  }
  assert.deepEqual(names(callableTools(...ROLES.contributor)).filter(n => actionTools.some(t => t[0] === n)).sort(), ["make_main_agent", "report_issue"]);
  assert.deepEqual(names(callableTools(...ROLES.recovery)).filter(n => actionTools.some(t => t[0] === n) || n.endsWith("_action")), []);
  assert.ok(names(listed("contributor")).includes("run_action"), "a contributor reaches report_issue through the lookup");
  // Native: a session lists what its role could list for its lifetime; calls re-check the current role.
  const attached = names(attachableTools({ recovery: false, brief: true, root: true, overseer: false }));
  for (const role of ["main", "contributor", "untracked"] as const) for (const n of names(listed(role))) assert.ok(attached.includes(n), `${role}'s ${n} is attached`);
  const flags = { recovery: false, brief: true, root: true, overseer: false };
  assert.ok(!names(availableTools(flags, { role: "contributor", inbox: true })).includes("merge"), "a contributor can't run the long tail");
  assert.ok(names(availableTools(flags, { role: "main", inbox: true })).includes("merge"), "the main agent may still call an action by name (the CLI, the bridge)");
});

test("find_action finds by words, gives schemas by name and lists everything with no arguments", () => {
  const callable = callableTools(...ROLES.main);
  const found = findActions({ query: "assign reviewers" }, callable);
  assert.equal(found.actions[0]!.name, "add_reviewers");
  assert.ok(found.actions[0]!.input, "with its input schema");
  const byName = findActions({ names: ["merge", "nope"] }, callable);
  assert.equal(byName.actions[0]!.name, "merge"); assert.equal(byName.actions[0]!.destructive, true); assert.deepEqual(byName.unknown, ["nope"]);
  const all = findActions({}, callable);
  assert.equal(all.actions.length, actionTools.length);
  assert.ok(JSON.stringify(all).length < 20_000, "the whole list stays a few thousand tokens");
  assert.equal(findActions({}, callableTools(...ROLES.contributor)).actions.length, 2, "a contributor sees only its own two");
});

test("run_action errors name the action and say how to find it", () => {
  const main = callableTools(...ROLES.main);
  const error = (input: Record<string, unknown>, callable = main) => { try { resolveAction(input as never, callable); return ""; } catch (e) { return (e as Error).message; } };
  assert.match(error({ action: "merg" }), /"merg".*find_action/);
  assert.match(error({}), /run_action needs action.*find_action/);
  assert.match(error({ action: "merge", args: { bogus: 1 } }), /^merge: .*bogus.*find_action \{names: \["merge"\]\}/);
  assert.match(error({ action: "sync_workspace" }), /sync_workspace is a tool of its own.*call sync_workspace directly/);
  assert.match(error({ action: "merge" }, callableTools(...ROLES.contributor)), /merge isn't an action this session can run\. find_action/);
});

test("run_action takes the action's own path: follow.agent-act with the action's name and args", async () => {
  const calls: unknown[] = [];
  const out = await runTool(lookupTools.find(t => t[0] === "run_action")!, { action: "list_prs", args: { needs_reviewers: true } }, callableTools(...ROLES.main), async (method, input) => { calls.push({ method, input }); return { prs: [] }; });
  assert.deepEqual(calls, [{ method: "follow.agent-act", input: { tool: "list_prs", args: { needs_reviewers: true } } }]);
  assert.equal(out.name, "list_prs");
});

// Must-have: a tool Follow-up's own text tells a role to use is listed for that role. The text is the SessionStart hook
// (and on Paseo 0.17 the system prompt; the same text, test/session-prompt.test.ts), the Stop and turn-end texts, the
// Overseer's prompt and a repair batch's instructions. An action named there is fine only when the role has run_action.
const SCAN: Record<string, { env: Record<string, string>; scope?: object; role: keyof typeof ROLES; overseer?: boolean; wait?: boolean }> = {
  "tracked main, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_WAIT: "1" }, scope: { role: "main", workspaceId: "w1" }, role: "main", wait: true },
  "tracked main, stdio": { env: { FOLLOW_UP_TOOLS: "stdio", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_BACKGROUND_WORK: "1" }, scope: { role: "main", workspaceId: "w1" }, role: "main" },
  "contributor, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_WAIT: "1" }, scope: { role: "contributor", workspaceId: "w1" }, role: "contributor", wait: true },
  "untracked root, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "claude" }, role: "untracked" },
  "Overseer, native": { env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_OVERSEER: "1", FOLLOW_UP_BRIEF: "claude" }, role: "untracked", overseer: true },
};
// A recovery session gets no session text (the hook returns first; tests/session-prompt.test.ts), so it isn't scanned.
// Named, not told: needs_you's text names ask_question only to say a question asked with it is already open.
const NAMED_NOT_TOLD: Record<string, string[]> = { ask_question: ["untracked"] };
const UNIVERSE = new Set([...tools, ...actionTools, ...overseerTools, ...lookupTools].map(t => t[0]).concat(WAIT_TOOLS).filter(n => n.includes("_")));

async function sessionStart(t: { after: (f: () => Promise<void>) => void }, scope: object | undefined, env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tool-budget-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "scopes.json"), JSON.stringify({ agents: scope ? { a1: scope } : {} }));
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  await writeFile(join(directory, "background-agents.json"), JSON.stringify({ agents: [] }));
  const blank = Object.fromEntries(["HOOK_IMPORT", "RECOVERY", "TOOLS", "PROVIDER", "ROOT", "BRIEF", "OVERSEER", "WAIT", "BACKGROUND_WORK", "SYSTEM_PROMPT"].map(k => [`FOLLOW_UP_${k}`, ""]));
  return new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, ...blank, PASEO_AGENT_ID: "a1", FOLLOW_UP_PROVIDER: "claude", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad);
    child.once("exit", () => ok(out.trim() ? JSON.parse(out.trim()).hookSpecificOutput.additionalContext as string : ""));
    child.stdin.end(JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }));
  });
}

for (const [name, s] of Object.entries(SCAN)) {
  test(`${name}: every tool its text names is one it lists`, async t => {
    process.env.FOLLOW_UP_HOOK_IMPORT = "1"; // the hook reads stdin unless told it is being imported
    // @ts-expect-error plain JS hook, generated into hook-source.ts
    const hook = await import("../server/agent-hook.mjs") as Record<string, unknown>;
    const deps: PromptDeps = { hostSupports: async () => true, providerSupports: async () => true, bridge: async () => bridge };
    const prompt = (await withSystemPrompt({ agentId: "a1", provider: "claude", purpose: "interactive", env: { ...s.env } }, deps)).appendSystemPrompt ?? [];
    const texts = [await sessionStart(t, s.scope, s.env), ...prompt];
    // The Stop hook's texts go only where the hook sends them: the nudge to root agents with the brief (shouldNudge),
    // due tasks to the tracked main agent, the checks line to every root agent.
    texts.push(String(hook.checksLine));
    if (s.role === "main" || s.role === "untracked") texts.push(String(hook.nudgeReason));
    if (s.role === "main") texts.push(String(hook.dueHeader), bridge.batchInstructions(null), bridge.batchInstructions({ mode: "github", reviewFix: null }));
    if (s.overseer) texts.push(await readFile(resolve("server/overseer-prompt.md"), "utf8"));
    const own = new Set([...names(listed(s.role, s.overseer)), ...(s.wait ? WAIT_TOOLS : [])]);
    const lookup = own.has("run_action");
    const text = texts.join("\n");
    assert.ok(text.length > 200, "the role has text to scan");
    // A follow_<name> is a direct tool call by definition: it must be listed.
    // (follow_settings is an action's own name, not a prefix; follow_session_instructions is the ACP text's own tool.)
    for (const m of text.matchAll(/\bfollow_([a-z_]+)\b/g)) if (!UNIVERSE.has(m[0]) && m[1] !== "session_instructions" && !NAMED_NOT_TOLD[m[1]!]?.includes(s.role)) assert.ok(own.has(m[1]!), `${name} is told to call follow_${m[1]} but doesn't list it`);
    // A bare name: listed, or an action the role reaches through run_action.
    for (const m of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
      const n = m[0];
      if (!UNIVERSE.has(n) || own.has(n) || NAMED_NOT_TOLD[n]?.includes(s.role)) continue;
      assert.ok(lookup && actionTools.some(a => a[0] === n), `${name}'s text names ${n}, which it neither lists nor can run_action`);
    }
  });
}
