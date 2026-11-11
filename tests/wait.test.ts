// Wait for background jobs, folded in from the standalone paseo-wait plugin (its tests/mcp.test.ts covered the same
// rules over its own MCP; here the tools are native plugin tools, so they're exercised through execute()).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentToolContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { Wait, WAIT_TOOLS, standaloneWaitInstalled, waitStatus, type WaitPaseoConfig } from "../server/wait";
import { AgentSettingsStore } from "../server/agent-settings";
import { AgentActions, PLANNED_TOOLS, READ_ONLY_TOOLS, TOOL_INPUT, type AgentActionDeps } from "../server/agent-actions";
import { actionTools, waitInstruction } from "../server/mcp.mjs";
import { WAIT_STANDALONE_NOTE, waitNote } from "../shared/wait";
import { setWaitRpc } from "../shared/contracts";
import { PARITY } from "../server/agent-parity";
import { parseAgentSettings } from "../shared/agent-settings";

async function dir(t: { after: (f: () => Promise<void>) => void }, prefix = "follow-wait-") {
  const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const request = (cwd: string, patch: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest => ({
  agentId: "synthetic", provider: "claude", cwd, workspaceId: null, title: null, labels: {}, tools: [], mcpServers: { existing: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  reason: "create", purpose: "interactive", env: { KEEP: "yes" }, ...patch,
});
const tool = (wait: Wait, name: string) => wait.tools.find(t => t.name === name)!;
function context(agentId: string, cwd: string, opts: { signal?: AbortSignal; lastUserMessageAt?: () => string | null } = {}): AgentToolContext {
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { lastUserMessageAt: opts.lastUserMessageAt?.() ?? null } }) }) } };
  return { agent: { id: agentId, workspaceId: null, parentAgentId: null, provider: "claude", cwd, title: null }, paseo, signal: opts.signal ?? new AbortController().signal } as unknown as AgentToolContext;
}
const call = async (wait: Wait, name: string, input: unknown, ctx: AgentToolContext) => {
  const t = wait.tools.find(t => t.name === name)!;
  return (await t.execute(await t.input.parseAsync(input), ctx)).structuredContent as Record<string, any>;
};
const run = (command: string) => new Promise<number | null>((ok, bad) => { const child = spawn("bash", ["-c", command]); child.once("error", bad); child.once("exit", ok); });

test("Wait attaches its three native tools to interactive Claude sessions and keeps everything else", async t => {
  const root = await dir(t);
  let enabled = true; let config: WaitPaseoConfig | null = null;
  const wait = new Wait(join(root, "wait"), { enabled: async () => enabled, config: async () => config }); t.after(() => wait.close());
  const base = request(root);
  const next = await wait.open(base);
  assert.deepEqual(next.tools.map(t => t.name).sort(), [...WAIT_TOOLS].sort());
  assert.deepEqual(next.mcpServers, base.mcpServers, "no MCP server of its own: no listener, no port");
  assert.equal(next.env.KEEP, "yes"); assert.equal(next.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, "0"); assert.equal(next.env.FOLLOW_UP_WAIT, "1");
  assert.deepEqual((await wait.open(next)).tools.length, 3, "never attached twice");
  // Who doesn't get it.
  const skipped: Partial<PluginSessionOpenRequest>[] = [{ purpose: "history" }, { provider: "codex" }, { labels: { "plugin-tools/enabled": "false" } }, { labels: { "paseo-wait/enabled": "false" } }, { labels: { "follow-up-wait/enabled": "false" } }];
  for (const patch of skipped) {
    const r = request(root, patch); assert.equal(await wait.open(r), r, JSON.stringify(patch));
  }
  const old = request(root); delete (old as { tools?: unknown }).tools; assert.equal(await wait.open(old), old, "Paseo 0.14: no request.tools, no Wait");
  enabled = false; const r1 = request(root); assert.equal(await wait.open(r1), r1, "the setting turns it off");
  enabled = true; config = { daemon: { mcp: { injectIntoAgents: false } } }; const r2 = request(root); assert.equal(await wait.open(r2), r2, "host doesn't serve plugin tools");
  config = { agents: { providers: { claude: { paseoTools: { disabledTools: ["wait_for_job"] } } } } }; const r3 = request(root); assert.equal(await wait.open(r3), r3);
});

test("no double install: the standalone paseo-wait plugin, installed and enabled, keeps Follow-up's Wait off", async t => {
  const root = await dir(t);
  let config: WaitPaseoConfig | null = { plugins: { "paseo-wait": { enabled: true } } };
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => config }); t.after(() => wait.close());
  const r = request(root); assert.equal(await wait.open(r), r);
  assert.equal(standaloneWaitInstalled(config), true);
  assert.deepEqual(waitStatus(true, config), { enable_wait: true, active: false, reason: "standalone" });
  assert.equal(waitNote(waitStatus(true, config)), "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait.");
  assert.equal(WAIT_STANDALONE_NOTE, waitNote(waitStatus(true, config)));
  config = { plugins: { "paseo-wait": {} } }; assert.equal(standaloneWaitInstalled(config), true, "listed without enabled counts as enabled");
  config = { plugins: { "paseo-wait": { enabled: false } } };
  assert.deepEqual(waitStatus(true, config), { enable_wait: true, active: true, reason: null });
  assert.equal((await wait.open(request(root))).tools.length, 3, "disabled standalone: Follow-up's Wait takes over");
  assert.deepEqual(waitStatus(false, null), { enable_wait: false, active: false, reason: "off" });
  assert.equal(waitNote(waitStatus(false, null)), null);
});

test("tools scope jobs by the daemon's agent identity and cwd, and complete only on an exit receipt", async t => {
  const root = await dir(t);
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null }); t.after(() => wait.close());
  const me = context("agent-a", root);
  const prepared = await call(wait, "wait_prepare_job", { description: "finite", command: "sleep 1.2; exit 3" }, me);
  assert.match(prepared.bashCommand, /run-job\.sh/); assert.equal((await call(wait, "wait_get_job", { jobId: prepared.jobId }, me)).status, "prepared");
  await assert.rejects(call(wait, "wait_get_job", { jobId: prepared.jobId }, context("agent-b", root)), /Unknown job/, "another agent can't read it");
  await assert.rejects(call(wait, "wait_get_job", { jobId: prepared.jobId }, context("agent-a", "/elsewhere")), /ownership/, "nor the same id in another cwd");
  await assert.rejects(tool(wait, "wait_prepare_job").input.parseAsync({ description: "x", command: "true", agentId: "agent-b" }), "identity never comes from model input");
  await assert.rejects(tool(wait, "wait_for_job").input.parseAsync({ jobId: prepared.jobId, max_wait_seconds: 61 }), "60 s hard ceiling");
  const execution = run(prepared.bashCommand);
  const first = await call(wait, "wait_for_job", { jobId: prepared.jobId, max_wait_seconds: 1 }, me);
  assert.equal(first.outcome, "still_pending"); assert.equal(first.status, "running");
  const done = await call(wait, "wait_for_job", { jobId: prepared.jobId, max_wait_seconds: 5 }, me);
  assert.equal(done.outcome, "failed"); assert.equal(done.exitCode, 3); assert.equal(await execution, 3);
  // Records survive a reload: a new Wait over the same directory reads the receipt.
  const reloaded = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null }); t.after(() => reloaded.close());
  assert.equal((await call(reloaded, "wait_get_job", { jobId: prepared.jobId }, me)).exitCode, 3);
});

test("Stop cancels the wait without killing the job; a new message ends observation", async t => {
  const root = await dir(t);
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null }); t.after(() => wait.close());
  const marker = join(root, "finished");
  const prepared = await call(wait, "wait_prepare_job", { description: "long", command: `sleep 1.5; touch '${marker}'` }, context("a", root));
  const execution = run(prepared.bashCommand);
  const stop = new AbortController();
  const started = Date.now();
  const waiting = call(wait, "wait_for_job", { jobId: prepared.jobId, max_wait_seconds: 60 }, context("a", root, { signal: stop.signal }));
  // abort(reason): typed as abort() in this lib target.
  setTimeout(() => Reflect.apply(stop.abort, stop, [new Error("user stop")]), 200);
  await assert.rejects(waiting, /user stop/); assert.ok(Date.now() - started < 1500);
  assert.equal(wait.jobs.activeWaits, 0, "no timer outlives the wait");
  assert.equal((await call(wait, "wait_get_job", { jobId: prepared.jobId }, context("a", root))).status, "running", "the job keeps running");
  let message: string | null = null;
  setTimeout(() => { message = new Date().toISOString(); }, 200);
  const released = await call(wait, "wait_for_job", { jobId: prepared.jobId, max_wait_seconds: 60 }, context("a", root, { lastUserMessageAt: () => message }));
  assert.equal(released.outcome, "new_message"); assert.equal(released.status, "running");
  assert.equal(await execution, 0);
  assert.equal((await call(wait, "wait_get_job", { jobId: prepared.jobId }, context("a", root))).status, "completed");
  await readFile(marker);
});

test("plugin teardown releases active waits and keeps the records", async t => {
  const root = await dir(t);
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null });
  const prepared = await call(wait, "wait_prepare_job", { description: "never run", command: "true" }, context("a", root));
  const waiting = call(wait, "wait_for_job", { jobId: prepared.jobId, max_wait_seconds: 60 }, context("a", root));
  await new Promise(r => setTimeout(r, 100));
  wait.close();
  await assert.rejects(waiting, /preserved/);
  const next = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null }); t.after(() => next.close());
  assert.equal((await call(next, "wait_get_job", { jobId: prepared.jobId }, context("a", root))).status, "prepared");
});

test("the setting: on by default, saved as enable_wait in agents.json next to the role settings", async t => {
  const root = await dir(t);
  const store = new AgentSettingsStore(root);
  assert.equal(await store.waitEnabled(), true);
  await store.save("about", { model: "sonnet" });
  await store.setWait(false);
  const saved = JSON.parse(await readFile(join(root, "agents.json"), "utf8"));
  assert.equal(saved.enable_wait, false); assert.equal(saved.roles.about.model, "sonnet", "roles kept");
  assert.equal(await new AgentSettingsStore(root).waitEnabled(), false, "survives a restart");
  await store.save("about", null);
  assert.equal(JSON.parse(await readFile(join(root, "agents.json"), "utf8")).enable_wait, false, "a role change keeps it");
  await store.setWait(true);
  assert.equal(JSON.parse(await readFile(join(root, "agents.json"), "utf8")).enable_wait, undefined, "on is the default, so it isn't stored");
  assert.equal(parseAgentSettings({ roles: {}, enable_wait: "no" }).file.enable_wait, undefined, "an invalid value means on");
});

test("agent parity: set_wait_for_jobs is the switch's RPC, planned first; agent_settings reads it", async t => {
  const root = await dir(t);
  const store = new AgentSettingsStore(root);
  const notes: string[] = [];
  const status = async () => waitStatus(await store.waitEnabled(), null);
  const calls: string[] = [];
  // The RPC bridge index.server.ts gives AgentActions: the same handlers the Settings switch's RPCs run.
  const rpc = {
    async validate(method: string, input: unknown) { assert.equal(method, setWaitRpc.name); return setWaitRpc.input.parseAsync(input); },
    async call(method: string, input: unknown) {
      calls.push(method);
      if (method === setWaitRpc.name) await store.setWait((input as { enable_wait: boolean }).enable_wait);
      return { wait: await status() };
    },
  };
  const deps = { store: { snapshot: async () => ({ workspaces: [] }) }, prActions: {}, engine: {},
    inbox: { list: async () => ({ enabled: true, rows: [] }), act: async () => ({ results: [] }), noteAction: async (by: string, _a: string, action: string) => { notes.push(`${by} ${action}`); } },
    agentSettings: store, wait: { status }, rpc } as unknown as AgentActionDeps;
  const agent = new AgentActions(deps);
  assert.ok(PLANNED_TOOLS.includes("set_wait_for_jobs")); assert.ok(!READ_ONLY_TOOLS.includes("set_wait_for_jobs"));
  assert.ok(TOOL_INPUT.set_wait_for_jobs);
  assert.deepEqual(PARITY["follow.set-wait"], { tools: ["set_wait_for_jobs"] }, "the switch's RPC has its agent tool");
  assert.ok(actionTools.some(t => t[0] === "set_wait_for_jobs"), "the bridge lists it too");
  assert.equal((await agent.run("orch", "agent_settings", {}) as any).waitForBackgroundJobs.enable_wait, true);
  const plan = await agent.run("orch", "set_wait_for_jobs", { enable_wait: false }) as any;
  assert.equal(plan.dryRun, true); assert.equal(plan.before.wait.enable_wait, true); assert.deepEqual(plan.change, { enable_wait: false });
  assert.equal(await store.waitEnabled(), true, "the dry run writes nothing");
  await assert.rejects(agent.run("orch", "set_wait_for_jobs", { enable_wait: "no" }), "the RPC's contract checks the dry run");
  await assert.rejects(agent.run("other", "set_wait_for_jobs", { confirm: true, planId: plan.planId }), /different tool or agent/);
  await agent.run("orch", "set_wait_for_jobs", { confirm: true, planId: plan.planId });
  assert.equal(await store.waitEnabled(), false);
  assert.deepEqual(notes, ["agent:orch set_wait_for_jobs"], "audited as the agent");
  await assert.rejects(agent.run("orch", "set_wait_for_jobs", { confirm: true, planId: plan.planId }), /expired or was already used/);
});

test("the agent hook gives Wait's guidance once at SessionStart to any Claude session with FOLLOW_UP_WAIT", async t => {
  const root = await dir(t, "follow-wait-hook-");
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "scopes.json"), JSON.stringify({ agents: { main: { role: "main", workspaceId: "w1" } } }));
  const fire = (agentId: string, event: object, env: Record<string, string>) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: agentId, FOLLOW_UP_BRIEF: "", FOLLOW_UP_RECOVERY: "", FOLLOW_UP_TOOLS: "", FOLLOW_UP_ROOT: "", FOLLOW_UP_OVERSEER: "", FOLLOW_UP_WAIT: "", ...env } });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
  const text = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : "";
  // An untracked subagent: only Wait's text, only at SessionStart.
  assert.equal(text(await fire("sub", { hook_event_name: "SessionStart" }, { FOLLOW_UP_WAIT: "1" })), waitInstruction);
  assert.equal(await fire("sub", { hook_event_name: "UserPromptSubmit", prompt: "hi" }, { FOLLOW_UP_WAIT: "1" }), "");
  assert.equal(await fire("sub", { hook_event_name: "SessionStart" }, {}), "", "no Wait, no text");
  // A tracked main agent: Wait's text joins its session context, unprefixed (Wait's names aren't follow_ tools).
  const main = text(await fire("main", { hook_event_name: "SessionStart" }, { FOLLOW_UP_WAIT: "1", FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: "claude", FOLLOW_UP_ROOT: "1" }));
  assert.ok(main.includes(waitInstruction)); assert.match(main, /follow_workspace_status/); assert.doesNotMatch(main, /follow_wait_/);
  assert.match(waitInstruction, /wait_prepare_job/); assert.match(waitInstruction, /instead of ending your turn/);
});
