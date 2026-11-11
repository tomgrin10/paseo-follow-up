import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tools, actionTools, overseerTools } from "../server/mcp.mjs";
import { NEEDS_YOU_NUDGE } from "../shared/brief";

process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { TOOL_NAMES: string[]; named: (text: string, native?: boolean) => string; isFollowTool: (tool: string) => boolean; isBridgeCall: (args: string, path: string) => boolean; toolsDetached: (native: boolean, current: unknown, mine: unknown) => boolean; shouldRepeat: (provider: string | undefined, turn: unknown, hash: string) => boolean };

test("the hook's tool-name list is every underscore tool the bridge serves", () => {
  const bridge = [...tools, ...actionTools, ...overseerTools].map(t => t[0]).filter(name => name.includes("_"));
  assert.deepEqual([...hook.TOOL_NAMES].sort(), [...new Set(bridge)].sort());
});

test("text names the set the agent has; both sets count as Follow-up's own calls", () => {
  assert.equal(hook.named(NEEDS_YOU_NUDGE, false), NEEDS_YOU_NUDGE, "pre-upgrade sessions keep mcp__follow-up__ names");
  assert.match(hook.named(NEEDS_YOU_NUDGE, true), /call follow_needs_you once/);
  assert.equal(hook.named("Merge/deploy triggers; set_spec and follow_set_spec", true), "Merge/deploy triggers; follow_set_spec and follow_set_spec", "prose and already-prefixed names untouched");
  for (const name of ["mcp__follow-up__needs_you", "follow-up.register_pr", "mcp__paseo__follow_needs_you", "paseo.follow_register_pr"]) assert.equal(hook.isFollowTool(name), true, name);
  for (const name of ["mcp__paseo__list_agents", "Bash", "mcp__other__follow_x"]) assert.equal(hook.isFollowTool(name), false, name);
});

test("bridge calls are recognised however they're spelled; detached tools are told apart by worker instance", () => {
  for (const args of ['{"command":"node \\"$FOLLOW_UP_CLI\\" call needs_you"}', '{"command":"node ${FOLLOW_UP_CLI} call x"}', '{"command":"node /p/plugin-data/follow-up/mcp.mjs call sync_workspace"}'])
    assert.equal(hook.isBridgeCall(args, "/elsewhere/mcp.mjs"), true, args);
  assert.equal(hook.isBridgeCall('{"command":"gt submit"}', "/p/mcp.mjs"), false);
  assert.equal(hook.toolsDetached(true, { instance: "b" }, { instance: "a" }), true, "attached by an earlier worker");
  assert.equal(hook.toolsDetached(true, { instance: "b" }, null), true, "opened before markers existed, so before this worker");
  assert.equal(hook.toolsDetached(true, { instance: "b" }, { instance: "b" }), false);
  assert.equal(hook.toolsDetached(false, { instance: "b" }, null), false, "stdio sessions keep their own server");
  assert.equal(hook.toolsDetached(true, null, null), false, "no worker record: assume attached");
});

async function home(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "hook-native-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "scopes.json"), JSON.stringify({ agents: { a1: { role: "main", workspaceId: "w1" } } }));
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  const fire = (event: object, env: Record<string, string>) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: "a1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_RECOVERY: "", FOLLOW_UP_TOOLS: "", FOLLOW_UP_PROVIDER: "", FOLLOW_UP_ROOT: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
  lastDirectory = directory;
  return fire;
}
let lastDirectory = "";
const context = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : "";

test("native Claude sessions: role text once per session with follow_ names, the bridge's instructions included", async t => {
  const fire = await home(t);
  const env = { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: "claude", FOLLOW_UP_ROOT: "1" };
  const start = context(await fire({ hook_event_name: "SessionStart" }, env));
  assert.match(start, /follow_workspace_status/); assert.doesNotMatch(start, /(?<!follow_)\bworkspace_status/);
  assert.match(start, /follow_needs_you/, "needs_you instruction, formerly the MCP initialize reply");
  assert.match(start, /follow_list_prs/, "action-tool instruction for a root agent");
  assert.doesNotMatch(start, /mcp\.mjs/, "no bridge fallback line");
  assert.equal(context(await fire({ hook_event_name: "UserPromptSubmit", prompt: "a" }, env)), "", "already in context this session");
  assert.equal(context(await fire({ hook_event_name: "UserPromptSubmit", prompt: "b" }, env)), "");
  const nudge = JSON.parse(await fire({ hook_event_name: "Stop" }, env));
  assert.match(nudge.reason, /call follow_needs_you once/);
});

test("stdio and pre-upgrade sessions keep the bridge names; Codex and unknown providers get the text every prompt", async t => {
  const fire = await home(t);
  for (const env of [{}, { FOLLOW_UP_TOOLS: "stdio", FOLLOW_UP_PROVIDER: "codex" }] as Record<string, string>[]) {
    const first = context(await fire({ hook_event_name: "UserPromptSubmit", prompt: "a" }, env));
    assert.match(first, /\bworkspace_status/); assert.doesNotMatch(first, /follow_workspace_status/);
    assert.equal(context(await fire({ hook_event_name: "UserPromptSubmit", prompt: "b" }, env)), first, "repeated each prompt");
  }
  const nudge = JSON.parse(await fire({ hook_event_name: "Stop" }, {}));
  assert.ok(nudge.reason.includes(NEEDS_YOU_NUDGE), "old sessions are nudged with the name they have");
});

test("after a reload mid-turn: the agent is told once to use the bridge, and Stop names the bridge's tools", async t => {
  const fire = await home(t);
  const env = { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: "claude", FOLLOW_UP_ROOT: "1" };
  await fire({ hook_event_name: "UserPromptSubmit", prompt: "a" }, env);
  // This session's tools were attached by worker "old"; a reload started worker "new".
  const data = lastDirectory;
  await writeFile(join(data, "tools-instance.json"), JSON.stringify({ instance: "new" }));
  await writeFile(join(data, "hook-state", "native-a1.json"), JSON.stringify({ instance: "old" }));
  const first = context(await fire({ hook_event_name: "PostToolUse", tool_name: "mcp__paseo__follow_sync_workspace", tool_input: {} }, env));
  assert.match(first, /follow_\* tools are detached/); assert.match(first, /"\$FOLLOW_UP_CLI" call <tool>/);
  assert.doesNotMatch(context(await fire({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, env)), /detached/, "said once");
  const stop = JSON.parse(await fire({ hook_event_name: "Stop" }, env));
  assert.match(stop.reason, /tools are detached/); assert.match(stop.reason, /call needs_you once/); assert.doesNotMatch(stop.reason, /follow_needs_you/);
  // The session reopened (before the next prompt) under the new worker: native names again, no notice.
  await writeFile(join(data, "hook-state", "native-a1.json"), JSON.stringify({ instance: "new" }));
  await fire({ hook_event_name: "UserPromptSubmit", prompt: "b" }, env);
  const stop2 = JSON.parse(await fire({ hook_event_name: "Stop" }, env));
  assert.doesNotMatch(stop2.reason, /detached/); assert.match(stop2.reason, /follow_needs_you/);
});
