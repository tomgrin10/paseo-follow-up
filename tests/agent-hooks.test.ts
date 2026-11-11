import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, lstat, readdir, readlink } from "node:fs/promises";
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
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, PASEO_AGENT_ID: w.mainAgentId, FOLLOW_UP_RECOVERY: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
    assert.equal(JSON.parse(await readFile(f.settings[0] + ".follow-up.bak", "utf8")).hooks.Stop.length, 1);
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
    for (const rule of ["skip resolved tasks", "one PR fully before the next", "/fix-pr", "--publish", "safe reparent", "preserve uncommitted work", "currently serving revision", "acknowledge_batch", "acknowledge a completion batch first", "Merging and archiving remain the developer's actions", "FOLLOW_UP_CLIENT_ENTRY", "/fixture/client.js"]) assert.ok(context.includes(rule), `standing context retains ${rule}`);
    for (const rule of ["original Slack threadUrl", "explicit developer authorization", "purpose=verified", "actual sent replyUrl", "never claim a draft was sent", "do not authorize repairs"]) assert.ok(context.includes(rule), `standing context retains communication rule: ${rule}`);
    assert.equal(await f.run(event, { PASEO_AGENT_ID: "secondary" }), null);
    assert.equal(await f.run(event, { PASEO_AGENT_ID: "" }), null);
    assert.equal(await f.run(event, { FOLLOW_UP_RECOVERY: "1" }), null);
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
    await f.run({ hook_event_name: "PostToolUse", tool_name: "mcp__paseo__follow_sync_workspace", tool_input: { summary: "x" } });
    assert.equal(await f.run({ hook_event_name: "Stop" }), null);
    await tick();
    await f.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gt submit --publish" } });
    assert.equal((await f.run({ hook_event_name: "Stop" })).decision, "block");
    assert.equal(await readFile(join(f.directory, "state.json"), "utf8"), original);
  } finally { await f.close(); }
});
const tick = () => new Promise(r => setTimeout(r, 5));
test("a sync through the bridge satisfies Stop however the call spells it: the record counts, not the tool name", async () => {
  const f = await fixture();
  try {
    for (const command of ['node "$FOLLOW_UP_CLI" call sync_workspace \'{"summary":"x"}\' --compact', "bash ./scripts/finish.sh"]) {
      await f.run({ hook_event_name: "UserPromptSubmit" }); await tick();
      await f.run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/fixture/a.ts" } }); await tick();
      // The RPC handler records the confirmation while the shell call runs; PostToolUse fires when it ends.
      await f.hooks.confirm(f.w.id, f.w.mainAgentId, "Synced through the bridge"); await tick();
      await f.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });
      assert.equal(await f.run({ hook_event_name: "Stop" }), null, command);
    }
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


test("contributor sessions get PR registration and CLI fallback instructions without goal or completion authority", async () => {
  const f = await fixture();
  try {
    f.w.contributorAgentIds = ["root-session"]; await f.save();
    const result = await f.run({ hook_event_name: "UserPromptSubmit" }, { PASEO_AGENT_ID: "root-session" });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /secondary git worktrees/); assert.match(context, /register_pr/); assert.match(context, /sync_workspace/); assert.match(context, /CLI fallback/); assert.match(context, /main agent retains/);
    assert.doesNotMatch(context, /enroll_workspace|update_obligation|declare_done/);
    await f.hooks.confirm(f.w.id, "root-session", "Registered session PRs");
    assert.equal(await f.run({ hook_event_name: "Stop" }, { PASEO_AGENT_ID: "root-session" }), null);
  } finally { await f.close(); }
});

test("1.3.0-beta.4: the hook reads the small scopes.json instead of state.json when the worker wrote it", async () => {
  const f = await fixture();
  try {
    const { scopes } = await import("../server/scopes");
    // state.json says untracked; scopes.json (what the worker derives on each save) says main.
    await writeFile(join(f.directory, "state.json"), JSON.stringify({ version: 1, workspaces: [] }));
    assert.equal(await f.run({ hook_event_name: "SessionStart" }), null, "fallback: no scopes.json, so state.json decides");
    await writeFile(join(f.directory, "scopes.json"), JSON.stringify({ version: 1, agents: scopes({ version: 1, workspaces: [f.w] } as any) }));
    const out = await f.run({ hook_event_name: "SessionStart" });
    assert.match(out.hookSpecificOutput.additionalContext, /workspace_status/);
    await writeFile(join(f.directory, "scopes.json"), JSON.stringify({ version: 1, agents: {} }));
    assert.equal(await f.run({ hook_event_name: "SessionStart" }), null);
  } finally { await f.hooks.stop(); await f.close(); }
});
// 2026-11-10: a harness run replaced the seat account's symlinked settings.json with a regular file (rename() onto a
// symlink replaces the link). Settings and hooks writers must write through symlinks: the link survives, the target changes.
test("hook install and uninstall write through a symlinked settings.json and hooks.json, keeping the links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-hook-link-"));
  try {
    const real = join(directory, "dotfiles"); await mkdir(real);
    await mkdir(join(directory, "claude")); await mkdir(join(directory, "codex"));
    await writeFile(join(real, "settings.json"), JSON.stringify({ model: "keep" }));
    await writeFile(join(real, "hooks.json"), JSON.stringify({}));
    const links = [join(directory, "claude/settings.json"), join(directory, "codex/hooks.json")];
    await symlink(join(real, "settings.json"), links[0]); await symlink("../dotfiles/hooks.json", links[1]);
    const hooks = new AgentHooks(directory, "/fixture/client.js", links);
    await hooks.start();
    for (const link of links) assert.ok((await lstat(link)).isSymbolicLink(), `${link} is still a symlink after install`);
    const installed = JSON.parse(await readFile(join(real, "settings.json"), "utf8"));
    assert.equal(installed.model, "keep"); assert.ok(installed.hooks.Stop[0].hooks[0].command.includes(join(directory, "agent-hook.mjs")), "the target got the hooks");
    assert.ok(JSON.parse(await readFile(join(real, "hooks.json"), "utf8")).hooks.UserPromptSubmit, "the relative link's target got the hooks");
    assert.ok((await lstat(join(real, "settings.json.follow-up.bak"))).isFile(), "the backup sits beside the target");
    assert.deepEqual((await readdir(join(directory, "claude"))).sort(), ["settings.json"], "nothing is written beside the link");
    await hooks.stop();
    for (const link of links) assert.ok((await lstat(link)).isSymbolicLink(), `${link} is still a symlink after uninstall`);
    assert.deepEqual(JSON.parse(await readFile(join(real, "settings.json"), "utf8")), { model: "keep", hooks: {} });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
// A dangling link means the user's dotfiles aren't there (unmounted, moved): refuse, never create a file at the target
// or replace the link, and say which path.
test("a dangling settings symlink is refused with a clear error and left untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-hook-dangling-"));
  try {
    await mkdir(join(directory, "claude"));
    const link = join(directory, "claude/settings.json"); await symlink(join(directory, "missing/settings.json"), link);
    const hooks = new AgentHooks(directory, "/fixture/client.js", [link]);
    await assert.rejects(hooks.start(), /dangling symlink/);
    assert.ok((await lstat(link)).isSymbolicLink()); assert.equal(await readlink(link), join(directory, "missing/settings.json"));
    await assert.rejects(lstat(join(directory, "missing")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
// Defense in depth: a Follow-up whose data dir is a temp dir is a harness or test; it never writes a settings file
// outside the temp dir, whatever env it inherited.
test("a Follow-up running from a temp data dir never writes settings outside the temp dir", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-hook-escape-"));
  try {
    const outside = "/nonexistent-follow-real-home/.claude/settings.json";
    const hooks = new AgentHooks(directory, "/fixture/client.js", [outside, join(directory, "claude/settings.json")]);
    await hooks.start();
    await assert.rejects(lstat("/nonexistent-follow-real-home"), { code: "ENOENT" });
    assert.ok(JSON.parse(await readFile(join(directory, "claude/settings.json"), "utf8")).hooks.Stop, "in-temp settings still install");
    await hooks.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
