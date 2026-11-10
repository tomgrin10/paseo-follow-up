// Wait for background jobs, end to end (ported from the standalone paseo-wait plugin's check-install.mjs).
//
// Packs Follow-up, installs it into an isolated in-process Paseo daemon (its own PASEO_HOME, HOME and
// CLAUDE_CONFIG_DIR; the agent MCP on, as Wait's native tools need), and drives real synthetic Claude Haiku agents:
//   adoption  asked to run a ~12 s command without being told Wait's tool names; must finish it through Wait.
//   repeat    told to wait in 2 s slices: wakes repeatedly, inspects between waits, completes on the receipt.
//   failure   a failing command: the receipt's exit code comes back as failed.
//   stop      Stop cancels the wait; the job keeps running and completes.
//   message   a new message ends the wait (new_message) before the job finishes.
//   reload    plugin reload: records survive; the session gets Wait back on its next prompt.
//   standalone  with paseo-wait installed and enabled in config.json, a new session gets no Wait tools.
// It samples the plugin worker's memory (one worker, no process per agent) idle and after the cases.
// Only Follow-up's SessionStart hook is loaded into Claude (settingSources: [] otherwise), the production path that
// carries Wait's guidance. Never touches the user's daemon, ~/.claude or ~/.paseo. Real model calls: a few cents.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { join, dirname, delimiter } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:net";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
// --quick: three cases; --cases a,b: just those (e.g. to re-run one that a provider hiccup broke).
const casesAt = process.argv.indexOf("--cases");
const only = casesAt >= 0 ? new Set(process.argv[casesAt + 1].split(",")) : process.argv.includes("--quick") ? new Set(["adoption", "stop", "standalone"]) : null;
// Real model calls need Claude credentials, and Wait's native tools need Paseo 0.15+. Without either (CI has no
// credentials and installs Paseo 0.14), this prints SKIP with the reason and exits 0. --live (npm run test:wait-live)
// makes a missing prerequisite a failure instead.
const liveClaude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const skip = await (async () => {
  const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some(key => process.env[key])
    || await access(join(liveClaude, ".credentials.json")).then(() => true, () => false);
  if (!credentials) return `no Claude credentials (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or ${join(liveClaude, ".credentials.json")})`;
  const version = await exec("paseo", ["--version"], { timeout: 30000 }).then(({ stdout }) => stdout.trim(), () => "");
  const [major, minor] = (version.match(/(\d+)\.(\d+)\./) ?? []).slice(1).map(Number);
  if (!(major > 0 || minor >= 15)) return `Paseo ${version || "CLI not found"} serves no plugin tools to agents; Wait needs 0.15+`;
  return null;
})();
if (skip) {
  if (process.argv.includes("--live")) { console.error(`FAIL check-wait: ${skip}`); process.exit(1); }
  console.log(`SKIP check-wait: ${skip}. Run npm run test:wait-live where Claude credentials and Paseo 0.15+ are available.`);
  process.exit(0);
}
let cli;
for (const directory of (process.env.PATH ?? "").split(delimiter)) { try { cli = await realpath(join(directory, "paseo")); break; } catch {} }
if (!cli) throw new Error("The installed Paseo CLI is required");
const requireInstalled = createRequire(cli);
const load = async name => import(pathToFileURL(requireInstalled.resolve(name)).href);
const { createPaseoDaemon } = await load("@getpaseo/server");
const { DaemonClient } = await load("@getpaseo/client/internal/daemon-client");
const serverRoot = dirname(requireInstalled.resolve("@getpaseo/server"));
const { ClaudeAgentClient } = await import(pathToFileURL(join(serverRoot, "agent/providers/claude/agent.js")).href);
const { query } = await load("@anthropic-ai/claude-agent-sdk");
const { default: pino } = await load("pino");

const root = await mkdtemp(join(tmpdir(), "follow-wait-install-"));
const home = join(root, "paseo"); const userHome = join(root, "user"); const packedDirectory = join(root, "plugin"); const cwd = join(root, "work");
await Promise.all([home, userHome, packedDirectory, cwd].map(path => mkdir(path, { recursive: true })));
const actualClaude = liveClaude;
const keys = ["HOME", "PASEO_HOME", "PASEO_DAEMON_URL", "PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "PASEO_AGENT_CWD"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const url = `ws://127.0.0.1:${port}/ws`;
const pluginId = "follow-through";
const configFile = join(home, "config.json");
const writeConfig = (extra = {}) => writeFile(configFile, JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, mcp: { enabled: true, injectIntoAgents: true }, relay: { enabled: false } }, plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true }, ...extra } }));
const result = { cases: [], memory: [] };
const log = (name, data = {}) => console.log(JSON.stringify({ event: name, ...data }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 180000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await predicate()) return; await pause(100); } throw new Error(`Timed out: ${description}`); }
const isWait = name => /(^|__|\.)wait_(prepare_job|for_job|get_job)$/.test(name);
const ends = suffix => name => name.endsWith(suffix);
let daemon, client;
const launches = new Map();

function receipt(item) {
  const value = item?.detail?.output;
  const text = typeof value === "string" ? value : value?.output ?? value?.content?.find?.(c => c.type === "text")?.text;
  try { return typeof text === "string" ? JSON.parse(text) : text ?? value; } catch { return null; }
}
async function memory(label) {
  const workers = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" ");
      if (Number(stat[1]) !== process.pid) continue;
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0");
      if (!args.some(arg => arg.endsWith("/plugins/plugin-process.js"))) continue;
      const pssKiB = Number((await readFile(`/proc/${pid}/smaps_rollup`, "utf8")).match(/^Pss:\s+(\d+)/m)?.[1]);
      workers.push({ pid: Number(pid), pssKiB });
    } catch {}
  }
  assert.equal(workers.length, 1, "one plugin worker, never one per agent or job");
  result.memory.push({ label, workers }); log("memory", { label, workers });
}
/** Runs a Wait tool as the agent would, through the daemon's plugin tool path (identity from the daemon). */
async function call(agentId, name, input) {
  const tool = daemon.agentManager.getPluginTools(agentId).find(t => t.name === name);
  assert.ok(tool, `${name} attached to ${agentId}`);
  const out = await daemon.agentManager.executePluginTool(tool, agentId, input, new AbortController().signal);
  return { ...out, value: out.structuredContent ?? (() => { try { return JSON.parse(out.text); } catch { return null; } })() };
}
async function runCase(workspaceId, label, command, maxWait, action) {
  const agent = await client.createAgent({ provider: "claude", model: "haiku", modeId: "bypassPermissions", cwd, workspaceId, title: `Wait ${label}` });
  const names = daemon.agentManager.getPluginTools(agent.id).map(t => t.name);
  for (const name of ["wait_prepare_job", "wait_for_job", "wait_get_job"]) assert.ok(names.includes(name), `${name} attached natively`);
  const prompt = label === "adoption"
    ? `Run this finite command: ${JSON.stringify(command)}. It takes about 12 seconds. Report WAIT_ADOPTION with its actual exit code once it has finished.`
    : `Prepare one job with description ${JSON.stringify(label)} and command ${JSON.stringify(command)}. Run its exact bashCommand with native Bash run_in_background=true. Then wait_for_job with max_wait_seconds=${maxWait}. Each still_pending requires wait_get_job and another wait while pending. When finished, reply WAIT_${label.toUpperCase()} and the actual exit code. Do not use timers or plain final replies as a substitute for wait_for_job.`;
  await client.sendMessage(agent.id, prompt);
  const timeline = () => daemon.agentManager.getTimeline(agent.id);
  await until(() => timeline().some(i => i.type === "tool_call" && i.name.endsWith("wait_for_job") && i.status === "running"), `${label} wait starts`);
  const lifecycle = daemon.agentManager.getAgent(agent.id)?.lifecycle; assert.equal(lifecycle, "running", "the agent stays Running while it waits");
  assert.equal(launches.get(agent.id)?.env?.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, "0");
  assert.ok(!Object.keys(launches.get(agent.id)?.mcpServers ?? {}).some(name => /wait/.test(name)), "no Wait MCP server of its own");
  let actionMs;
  if (action) {
    await pause(500); actionMs = Date.now();
    if (action === "stop") await client.cancelAgent(agent.id);
    else await client.sendMessage(agent.id, "A new user message: stop waiting and reply WAIT_MESSAGE_ACK. Do not claim the job is complete.", { activeTurnBehavior: "steer" });
  }
  await until(() => daemon.agentManager.getAgent(agent.id)?.lifecycle !== "running", `${label} turn ends`);
  const endedMs = Date.now();
  const calls = timeline().filter(i => i.type === "tool_call");
  result.lastTimeline = calls.map(i => ({ name: i.name, status: i.status, detail: i.detail, error: i.error }));
  const prepared = receipt(calls.find(i => i.name.endsWith("wait_prepare_job")));
  assert.ok(prepared?.jobId, "prepared job receipt");
  const waits = calls.filter(i => i.name.endsWith("wait_for_job")).map(i => ({ status: i.status, receipt: receipt(i) }));
  if (!action) {
    const terminal = calls.filter(i => i.name.endsWith("wait_for_job") || i.name.endsWith("wait_get_job")).map(receipt).findLast(r => r?.status === "completed" || r?.status === "failed");
    assert.equal(terminal?.status, label === "failure" ? "failed" : "completed", "completion must be observed through a receipt");
    if (label === "repeat") { assert.ok(waits.filter(w => w.receipt?.outcome === "still_pending").length >= 2, "the agent wakes repeatedly"); assert.ok(calls.some(i => i.name.endsWith("wait_get_job")), "and inspects between waits"); }
  } else if (action === "stop") assert.equal(waits.at(-1).status, "canceled");
  else { assert.equal(waits.at(-1).receipt?.outcome, "new_message"); assert.ok(endedMs - actionMs < 7000, "a message releases the wait before the job finishes"); }
  const own = await call(agent.id, "wait_get_job", { jobId: prepared.jobId });
  if (action) {
    assert.equal(own.value.status, "running", "ending observation leaves the job running");
    await until(async () => (await call(agent.id, "wait_get_job", { jobId: prepared.jobId })).value.status === "completed", "the background job exits", 20000);
  }
  const record = { label, waits: waits.map(w => w.receipt?.outcome ?? w.status), exitCode: own.value.exitCode, toolNames: [...new Set(calls.map(i => i.name))], messageLatencyMs: actionMs ? endedMs - actionMs : undefined };
  result.cases.push(record); log("case_passed", record);
  return { agentId: agent.id, jobId: prepared.jobId };
}

try {
  Object.assign(process.env, { HOME: userHome, PASEO_HOME: home, PASEO_DAEMON_URL: url, CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CODEX_HOME: join(userHome, ".codex") });
  for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "PASEO_AGENT_CWD"]) delete process.env[key];
  await writeConfig();
  // Explicit activation only (as check-install.mjs): no tracking, so Follow-up doesn't call gh or a model here.
  await mkdir(join(home, "plugin-data", pluginId), { recursive: true });
  await writeFile(join(home, "plugin-data", pluginId, "state.json"), JSON.stringify({ version: 1, enable_follow_every: false, migrations: ["follow-every-1"], workspaces: [] }));
  const packageInfo = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { cwd: source, timeout: 60000, maxBuffer: 2 ** 22 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packageInfo.filename), "--strip-components=1", "-C", packedDirectory]);
  result.packedBytes = packageInfo.size;
  const logger = pino({ level: "warn" }, pino.destination(join(root, "daemon.log")));
  const hook = join(home, "plugin-data", pluginId, "agent-hook.mjs");
  const claude = new ClaudeAgentClient({ logger, runtimeSettings: { env: { CLAUDE_CONFIG_DIR: actualClaude } }, queryFactory(input) {
    launches.set(input.options.env.PASEO_AGENT_ID, { env: input.options.env, mcpServers: input.options.mcpServers });
    assert.ok(input.options.mcpServers?.paseo, "the agent's Paseo MCP carries Wait's native tools");
    return query({ ...input, options: { ...input.options, settingSources: [], strictMcpConfig: true, hooks: undefined,
      // Follow-up's own SessionStart hook only: the production path that gives Wait's guidance.
      settings: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${hook}'`, timeout: 10 }] }] } },
      systemPrompt: { type: "preset", preset: "claude_code", append: "This is an isolated synthetic test. Execute only the requested finite command; do not inspect unrelated files, modify configuration, or create agents." } } });
  } });
  daemon = await createPaseoDaemon({ listen: `127.0.0.1:${port}`, paseoHome: home, daemonVersion: "0.15.2", corsAllowedOrigins: [], hostnames: true, mcpEnabled: true, mcpInjectIntoAgents: true, browserToolsEnabled: false, relayEnabled: false, staticDir: root, mcpDebug: false, agentStoragePath: join(home, "agents"), agentClients: { claude }, providerCatalogRefreshTimeoutMs: 2000, metadataGeneration: { providers: [] }, pluginsEnabled: true, plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true } } }, logger);
  await daemon.start();
  client = new DaemonClient({ url, clientId: "follow-wait-isolated-test", clientType: "cli", appVersion: "0.15.2", reconnect: { enabled: false } });
  await client.connect(); await client.fetchAgents({ subscribe: {} });
  const installed = (await client.listPlugins()).find(p => p.id === pluginId);
  assert.equal(installed?.status, "running", JSON.stringify(installed));
  await until(async () => { try { return !!JSON.parse(await readFile(join(home, "plugin-data", pluginId, "hooks-enabled.json"), "utf8")).clientEntry; } catch { return false; } }, "Follow-up writes its hook");
  const view = await client.invokePluginRpc(pluginId, "follow.agent-settings", {});
  assert.deepEqual(view.wait, { enable_wait: true, active: true, reason: null }, "on by default");
  await memory("idle");
  const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd }, title: "Synthetic bounded waits" });
  const workspaceId = workspace.workspace.id;
  const want = label => !only || only.has(label);
  let adoption, repeat;
  if (want("adoption")) adoption = await runCase(workspaceId, "adoption", "sleep 12; printf WAIT_ADOPTED", 2);
  if (want("repeat")) repeat = await runCase(workspaceId, "repeat", "sleep 12; printf WAIT_JOB_COMPLETE", 2);
  if (want("failure")) {
    const other = await runCase(workspaceId, "failure", "sleep 3; exit 7", 2);
    if (repeat) { const rejected = await call(other.agentId, "wait_get_job", { jobId: repeat.jobId }); assert.equal(rejected.isError, true); assert.match(rejected.text, /Unknown job/); }
  }
  if (want("stop")) await runCase(workspaceId, "stop", "sleep 10; printf WAIT_STOP_JOB_COMPLETE", 30, "stop");
  if (want("message")) await runCase(workspaceId, "message", "sleep 10; printf WAIT_MESSAGE_JOB_COMPLETE", 30, "message");
  await memory("after_cases");
  const previous = repeat ?? adoption;
  if (previous && want("reload")) {
    assert.equal((await client.reloadPlugin(pluginId)).status, "running");
    await client.sendMessage(previous.agentId, "Reply WAIT_REOPEN_ACK. Do not start another job.");
    await until(() => daemon.agentManager.getPluginTools(previous.agentId).some(t => t.name === "wait_get_job"), "Wait comes back on the next prompt");
    await until(() => daemon.agentManager.getAgent(previous.agentId)?.lifecycle !== "running", "reopen turn ends");
    const old = await call(previous.agentId, "wait_get_job", { jobId: previous.jobId });
    assert.equal(old.value.status, "completed", "job records survive a plugin reload");
    result.cases.push({ label: "reload", preservedExitCode: old.value.exitCode }); log("case_passed", result.cases.at(-1));
  }
  if (want("standalone")) {
    // A stub standalone plugin listed and enabled in config.json: Follow-up's Wait stays off and says why.
    await writeConfig({ "paseo-wait": { source: "directory", path: join(root, "missing-paseo-wait"), enabled: true } });
    const blocked = await client.invokePluginRpc(pluginId, "follow.agent-settings", {});
    assert.deepEqual(blocked.wait, { enable_wait: true, active: false, reason: "standalone" });
    const agent = await client.createAgent({ provider: "claude", model: "haiku", modeId: "bypassPermissions", cwd, workspaceId, title: "Wait standalone" });
    await until(() => launches.has(agent.id) || daemon.agentManager.getPluginTools(agent.id).length > 0, "session opens", 30000).catch(() => undefined);
    assert.ok(!daemon.agentManager.getPluginTools(agent.id).some(t => isWait(t.name)), "no double install");
    await writeConfig();
    result.cases.push({ label: "standalone", waitAttached: false }); log("case_passed", result.cases.at(-1));
  }
  log("PASS", { cases: result.cases.map(c => c.label), workers: 1 });
} catch (error) {
  result.error = error.stack; log("FAIL", { message: error.message, root, lastTimeline: result.lastTimeline }); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {}); await daemon?.stop().catch(error => { result.cleanupError = error.message; });
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  if (process.argv.includes("--output")) await writeFile(process.argv[process.argv.indexOf("--output") + 1], JSON.stringify(result, null, 2) + "\n");
  if (!result.error) await rm(root, { recursive: true, force: true });
  else log("failure_evidence", { directory: root });
  process.exit(process.exitCode ?? 0);
}
