// Native tools check (1.4.0-beta.2): Follow-up's tools reach agents through Paseo's own MCP, with no per-agent
// follow-through process.
//
// Starts an isolated Paseo daemon (never the user's) with its agent MCP on, installs the fixture provider and the
// packed plugin, creates N root agents and reads each agent's launch config: how many carry a follow-through stdio
// server (one node mcp.mjs per agent once a real Claude/Codex runs it) and how many get the daemon's MCP. Then it
// calls Follow-up's tools over that MCP as the first agent, the way Claude or Codex would.
//
//   node scripts/check-native-tools.mjs [--agents 10] [--stdio] [--json]
//
// --stdio forces the per-agent bridge (the pre-1.4.0-beta.2 behaviour) for comparison.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { openSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
await harness();

const exec = promisify(execFile);
try { await exec("paseo", ["--version"], { timeout: 30_000 }); } catch {
  const message = "native tools check: the paseo CLI isn't on PATH (npm i -g @getpaseo/cli@0.15.2).";
  if (process.env.CI) { console.error(`${message} Required in CI.`); process.exit(1); }
  console.warn(`${message} Skipping.`); process.exit(0);
}
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("agents", "10")); const STDIO = process.argv.includes("--stdio");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = await mkdtemp(join(tmpdir(), "follow-native-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); const plugin = join(root, "plugin");
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: home, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false",
  FOLLOW_THROUGH_TOOL_PROVIDERS: "claude,codex,followthrough-fixture", ...(STDIO ? { FOLLOW_THROUGH_FORCE_STDIO: "1" } : {}) };
for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[key];
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;

/** One MCP JSON-RPC exchange over streamable HTTP (JSON or SSE replies). */
async function mcp(server, session, body) {
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session.id ? { "mcp-session-id": session.id } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
  session.id = response.headers.get("mcp-session-id") ?? session.id;
  const text = await response.text();
  if (body.id === undefined) return null;
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop());
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}

try {
  await mkdir(home, { recursive: true }); await mkdir(fixture, { recursive: true }); await mkdir(plugin);
  await writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true }, browserTools: { enabled: false } } }));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followthrough-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; i < 120; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i === 119) throw new Error("isolated daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-native-check", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  await cli("plugin", "install", fixture);
  await cli("plugin", "install", plugin);
  // Untracked roots, so each first session takes the root-agent path (default tracking only sets the CLI env).
  await client.invokePluginRpc("follow-through", "follow.set-follow-settings", { enable_follow_every: false });
  const api = createPaseoApi(client);
  const created = [];
  for (let i = 0; i < N; i++) {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    const a = await w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic agent ${i}` });
    created.push({ workspaceId: w.id, agentId: a.id });
  }
  await sleep(1_500);
  const configs = await Promise.all(created.map(async ({ agentId }) => JSON.parse(await readFile(join(home, `fixture-agent-config-${agentId}.json`), "utf8"))));
  const stdioServers = configs.filter(c => c.mcpServers?.["follow-through"]?.type === "stdio").length;
  const paseoMcp = configs.filter(c => Object.values(c.mcpServers ?? {}).some(s => s?.type === "http")).length;
  const result = { mode: STDIO ? "stdio" : "native", agents: N, followThroughStdioServers: stdioServers, agentsWithPaseoMcp: paseoMcp, followTools: 0, call: null };
  // Call Follow-up's tools over the daemon's MCP as the first agent, after tracking its workspace.
  const server = Object.values(configs[0].mcpServers ?? {}).find(s => s?.type === "http");
  if (server) {
    await client.invokePluginRpc("follow-through", "follow.activate", { workspaceId: created[0].workspaceId });
    const session = {};
    await mcp(server, session, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "follow-native-check", version: "1" } } });
    await mcp(server, session, { method: "notifications/initialized" });
    const tools = (await mcp(server, session, { id: 2, method: "tools/list" })).tools.map(t => t.name);
    result.followTools = tools.filter(n => n.startsWith("follow_")).length;
    if (!STDIO) {
      assert.ok(tools.includes("follow_workspace_status") && tools.includes("follow_register_pr"), `follow_ tools listed: ${tools.join(", ")}`);
      const reply = await mcp(server, session, { id: 3, method: "tools/call", params: { name: "follow_workspace_status", arguments: {} } });
      const status = JSON.parse(reply.content[0].text);
      assert.equal(status.id, created[0].workspaceId, "the daemon's caller identity resolves the agent's own workspace");
      result.call = { tool: "follow_workspace_status", workspaceId: status.id, detail: status.detail };

      // A plugin reload (every update) drops request.tools from open sessions; Paseo 0.15.2 re-attaches them only when a
      // session reopens, which it does before that agent's next prompt.
      const data = join(home, "plugin-data/follow-through");
      const instanceBefore = JSON.parse(await readFile(join(data, "tools-instance.json"), "utf8")).instance;
      await cli("plugin", "reload", "follow-through");
      let instanceAfter = instanceBefore;
      for (let i = 0; i < 80 && instanceAfter === instanceBefore; i++) { await sleep(250); instanceAfter = JSON.parse(await readFile(join(data, "tools-instance.json"), "utf8").catch(() => "{}")).instance ?? instanceBefore; }
      assert.notEqual(instanceAfter, instanceBefore, "the reloaded worker records a new instance");
      // Mid-turn: the old registration is gone, and the hook can tell (its marker names the previous worker)...
      const stale = await mcp(server, session, { id: 4, method: "tools/call", params: { name: "follow_workspace_status", arguments: {} } }).then(r => r?.isError ? r.content?.[0]?.text ?? "error" : null, error => error.message);
      assert.match(stale ?? "", /not found|unavailable/i, "the detached tool fails until the session reopens");
      assert.equal(JSON.parse(await readFile(join(data, "hook-state", `native-${created[0].agentId}.json`), "utf8")).instance, instanceBefore, "the hook sees the tools as detached");
      // ...and the bridge the hook points to works meanwhile, with the agent's own launch environment.
      for (let i = 0; i < 80; i++) { try { await readFile(join(data, "mcp.mjs")); if (JSON.parse(await readFile(join(data, "hooks-enabled.json"), "utf8")).expiresAt > Date.now()) break; } catch {} await sleep(250); }
      const bridged = JSON.parse((await exec(process.execPath, [join(data, "mcp.mjs"), "call", "workspace_status", "{}", "--compact"], { env: { ...env, ...configs[0].env, PASEO_DAEMON_URL: url, PASEO_HOME: home }, timeout: 60_000 })).stdout);
      assert.equal(bridged.id, created[0].workspaceId, "the bridge serves the same tool mid-turn");
      // The next prompt reopens the session under the new worker, and the native tools answer again.
      await client.sendAgentMessage(created[0].agentId, "Synthetic follow-up prompt");
      let reopened = null;
      for (let i = 0; i < 80 && !reopened; i++) { await sleep(250); const marker = JSON.parse(await readFile(join(data, "hook-state", `native-${created[0].agentId}.json`), "utf8")); if (marker.instance === instanceAfter) reopened = JSON.parse(await readFile(join(home, `fixture-agent-config-${created[0].agentId}.json`), "utf8")); }
      assert.ok(reopened, "the session reopened under the reloaded worker");
      const server2 = Object.values(reopened.mcpServers ?? {}).find(s => s?.type === "http"); const session2 = {};
      await mcp(server2, session2, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "follow-native-check", version: "1" } } });
      await mcp(server2, session2, { method: "notifications/initialized" });
      const again = JSON.parse((await mcp(server2, session2, { id: 2, method: "tools/call", params: { name: "follow_workspace_status", arguments: {} } })).content[0].text);
      assert.equal(again.id, created[0].workspaceId, "follow_workspace_status works again after the reload");
      result.reload = { midTurnNative: "fails (detached)", midTurnBridge: "ok", afterNextPrompt: "ok" };
    }
  }
  const pid = Number((await readFile(join(home, "plugin-data/follow-through/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  if (pid > 0) result.workerRssMb = Math.round(Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
  if (STDIO) assert.equal(stdioServers, N, "stdio mode: one bridge per root agent"); else { assert.equal(stdioServers, 0, "native mode: no per-agent bridge"); assert.equal(result.followTools > 0, true); }
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
} catch (error) { process.exitCode = 1; throw error; } finally {
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  if (process.exitCode && process.exitCode !== 0) console.error(`daemon log: ${join(root, "daemon.log")}`); else await rm(root, { recursive: true, force: true });
}
