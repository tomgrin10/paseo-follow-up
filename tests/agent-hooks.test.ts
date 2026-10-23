import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentHooks, reconcileHooks } from "../server/agent-hooks";
import { workspace } from "./fixtures";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "follow-hook-"));
  const settings = [join(directory, "claude/settings.json"), join(directory, "codex/hooks.json")];
  await mkdir(join(directory, "claude"));
  await writeFile(settings[0], JSON.stringify({ model: "keep", hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "existing hook" }] }] } }));
  const hooks = new AgentHooks(directory, "/fixture/client.js", settings);
  await hooks.start();
  const w = workspace({ enable_tracking: true, enable_auto_sends: false });
  const state = { version: 1, workspaces: [w] };
  const save = () => writeFile(join(directory, "state.json"), JSON.stringify(state));
  await save();
  const run = async (event: Record<string, unknown>, env: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, PASEO_AGENT_ID: w.mainAgentId, FOLLOW_THROUGH_RECOVERY: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { error += c; });
    const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(error))); });
    child.stdin.end(JSON.stringify({ session_id: "fixture-session", ...event }));
    await done; assert.equal(error, ""); return output ? JSON.parse(output) : null;
  };
  return { directory, settings, hooks, w, save, run, close: () => rm(directory, { recursive: true, force: true }) };
}
test("hook installation preserves other handlers, backs up once, remains idempotent and removes only its own entries", async () => {
  const f = await fixture();
  try {
    const first = await readFile(f.settings[0], "utf8"); await f.hooks.start(); assert.equal(await readFile(f.settings[0], "utf8"), first);
    assert.equal(JSON.parse(first).model, "keep"); assert.equal(JSON.parse(first).hooks.Stop[0].hooks[0].command, "existing hook");
    assert.equal(JSON.parse(await readFile(f.settings[0] + ".follow-through.bak", "utf8")).hooks.Stop.length, 1);
    await f.hooks.stop(); const after = JSON.parse(await readFile(f.settings[0], "utf8")); assert.equal(after.hooks.Stop.length, 1); assert.equal(after.hooks.Stop[0].hooks[0].command, "existing hook");
    assert.equal(await f.run({ hook_event_name: "UserPromptSubmit" }), null);
    const command: string = (reconcileHooks({}, "/tmp/a'b/agent-hook.mjs").hooks!.Stop[0].hooks![0]).command!;
    assert.ok(command.includes("a'\\''b"));
  } finally { await f.close(); }
});
test("only an enabled, unarchived main agent receives normal-turn instructions, including custom Claude main agents", async () => {
  const f = await fixture();
  try {
    const event = { hook_event_name: "UserPromptSubmit" };
    const result = await f.run({ ...event, agent_type: "custom-main" }); assert.match(result.hookSpecificOutput.additionalContext, /sync_workspace/); assert.match(result.hookSpecificOutput.additionalContext, /Auto still governs/);
    assert.match(result.hookSpecificOutput.additionalContext, /Do routine bookkeeping silently/); assert.match(result.hookSpecificOutput.additionalContext, /without another recap/);
    const context = result.hookSpecificOutput.additionalContext;
    for (const rule of ["skip resolved tasks", "one PR fully before the next", "/fix-pr", "--publish", "safe reparent", "preserve uncommitted work", "currently serving revision", "acknowledge_batch", "acknowledge a completion batch first", "Merging and archiving remain the developer's actions", "FOLLOW_THROUGH_CLIENT_ENTRY", "/fixture/client.js"]) assert.ok(context.includes(rule), `standing context retains ${rule}`);
    for (const rule of ["original Slack threadUrl", "explicit developer authorization", "purpose=verified", "actual sent replyUrl", "never claim a draft was sent", "do not authorize repairs"]) assert.ok(context.includes(rule), `standing context retains communication rule: ${rule}`);
    assert.equal(await f.run(event, { PASEO_AGENT_ID: "secondary" }), null);
    assert.equal(await f.run(event, { PASEO_AGENT_ID: "" }), null);
    assert.equal(await f.run(event, { FOLLOW_THROUGH_RECOVERY: "1" }), null);
    assert.equal(await f.run({ ...event, agent_id: "provider-child" }), null);
    f.w.enable_tracking = false; await f.save(); assert.equal(await f.run(event), null);
    f.w.enable_tracking = true; f.w.archived = true; await f.save(); assert.equal(await f.run(event), null);
    f.w.archived = false; await f.save(); await writeFile(join(f.directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: 0, clientEntry: "/fixture/client.js" })); assert.equal(await f.run(event), null);
  } finally { await f.close(); }
});
test("a missing sidebar sync continues once; confirmation avoids it and later shell work makes it stale", async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.directory, "state.json"), "utf8");
    await f.run({ hook_event_name: "UserPromptSubmit" });
    const stop = await f.run({ hook_event_name: "Stop", stop_hook_active: false }); assert.equal(stop.decision, "block"); assert.match(stop.reason, /metadata bookkeeping only/);
    await f.run({ hook_event_name: "UserPromptSubmit", prompt: stop.reason }); assert.equal(await f.run({ hook_event_name: "Stop" }), null);
    await f.run({ hook_event_name: "UserPromptSubmit" }); await f.hooks.confirm(f.w.id, f.w.mainAgentId, "Sidebar matches current work");
    assert.equal(await f.run({ hook_event_name: "Stop" }), null);
    await f.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gt submit --publish" } });
    assert.equal((await f.run({ hook_event_name: "Stop" })).decision, "block");
    assert.equal(await readFile(join(f.directory, "state.json"), "utf8"), original);
  } finally { await f.close(); }
});
test("compaction restores instructions; tracker calls, continued stops and background work do not create loops", async () => {
  const f = await fixture();
  try {
    const oldSession = { hook_event_name: "PostToolUse", session_id: "already-running", tool_name: "Read" };
    assert.match((await f.run(oldSession)).hookSpecificOutput.additionalContext, /Do routine bookkeeping silently/);
    assert.equal(await f.run(oldSession), null, "running sessions receive the quiet policy once without a wake-up message");
    assert.match((await f.run({ hook_event_name: "SessionStart", source: "compact" })).hookSpecificOutput.additionalContext, /after compaction/);
    await f.run({ hook_event_name: "UserPromptSubmit" }); await f.hooks.confirm(f.w.id, f.w.mainAgentId, "No changes");
    await f.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `node '${f.directory}/mcp.mjs' call sync_workspace '{}'` } });
    assert.equal(await f.run({ hook_event_name: "Stop" }), null);
    await f.run({ hook_event_name: "UserPromptSubmit" }); assert.equal(await f.run({ hook_event_name: "Stop", stop_hook_active: true }), null);
    assert.equal(await f.run({ hook_event_name: "Stop", background_tasks: ["running child"] }), null);
    await writeFile(join(f.directory, "state.json"), "broken"); assert.equal(await f.run({ hook_event_name: "Stop" }), null);
  } finally { await f.close(); }
});
