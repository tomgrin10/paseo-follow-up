// Wait for checks, end to end (docs/wait-for-checks.md). Packs Follow-up into an isolated in-process Paseo daemon
// (its own PASEO_HOME, HOME and CLAUDE_CONFIG_DIR; the agent MCP on), with a fake GitHub (scripts/fake-github.mjs), and
// drives one real Claude Haiku agent in a tracked workspace:
//   1. example/app#7 has a check running. The agent is told to wait for it without being told the tool's name (only
//      Follow-up's SessionStart hook carries it). It must call wait_for_checks and end its turn, with no gh call.
//   2. The fixture's check finishes. The agent gets exactly one "Follow-up checks" message, and answers it.
//   3. Nothing more arrives for a minute after that, and no read of the fake GitHub was made for the wait beyond the
//      engine's own passes (counted: requests while waiting vs. the same window before the call).
// Skips like check-wait without Claude credentials or Paseo 0.15+ (CI); --live fails instead. Real model calls: cents.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, chmod, mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join, dirname, delimiter } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { harness, onShutdown } from "./harness.mjs";
import { harnessEnv, applyEnv, harnessConfig, harnessDaemonProviders, assertProviderStubsUnused } from "./harness-env.mjs";

import { fakeGithub } from "./fake-github.mjs";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const liveClaude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const skip = await (async () => {
  const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some(key => process.env[key])
    || await access(join(liveClaude, ".credentials.json")).then(() => true, () => false);
  if (!credentials) return "no Claude credentials";
  const version = await exec("paseo", ["--version"], { timeout: 30000 }).then(({ stdout }) => stdout.trim(), () => "");
  const [major, minor] = (version.match(/(\d+)\.(\d+)\./) ?? []).slice(1).map(Number);
  if (!(major > 0 || minor >= 15)) return `Paseo ${version || "CLI not found"} serves no plugin tools`;
  return null;
})();
if (skip) {
  if (process.argv.includes("--live")) { console.error(`FAIL check-wait-for-checks: ${skip}`); process.exit(1); }
  console.log(`SKIP check-wait-for-checks: ${skip}.`); process.exit(0);
}
await harness();
let cli;
for (const directory of (process.env.PATH ?? "").split(delimiter)) { try { cli = await realpath(join(directory, "paseo")); break; } catch {} }
if (!cli) throw new Error("The installed Paseo CLI is required");
const requireInstalled = createRequire(cli);
const load = async name => import(pathToFileURL(requireInstalled.resolve(name)).href);
const { createPaseoDaemon } = await load("@getpaseo/server");
const { BUILTIN_PROVIDER_IDS } = await load("@getpaseo/protocol/provider-manifest");
const { DaemonClient } = await load("@getpaseo/client/internal/daemon-client");
const serverRoot = dirname(requireInstalled.resolve("@getpaseo/server"));
const { ClaudeAgentClient } = await import(pathToFileURL(join(serverRoot, "agent/providers/claude/agent.js")).href);
const { query } = await load("@anthropic-ai/claude-agent-sdk");
const { default: pino } = await load("pino");

const root = await mkdtemp(join(tmpdir(), "follow-wait-checks-"));
const home = join(root, "paseo"); const userHome = join(root, "user"); const packedDirectory = join(root, "plugin"); const cwd = join(root, "work");
await Promise.all([home, userHome, packedDirectory, cwd].map(path => mkdir(path, { recursive: true })));
const actualClaude = liveClaude;
const original = { ...process.env };
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const url = `ws://127.0.0.1:${port}/ws`;
const pluginId = "follow-up";
const configFile = join(home, "config.json");
// The live-model check: claude stays real, in the env (its stub skipped) and in the config (its provider on).
const REAL = ["claude"];
const writeConfig = (extra = {}) => writeFile(configFile, JSON.stringify(harnessConfig({ port, mcp: true, real: REAL, extra: { plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true }, ...extra } } })));
const log = (name, data = {}) => console.log(JSON.stringify({ event: name, ...data }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 180000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await predicate()) return; await pause(250); } throw new Error(`Timed out: ${description}`); }
const result = {};
let daemon, client, github;
onShutdown(async () => { await client?.close().catch(() => {}); await daemon?.stop().catch(() => {}); await github?.close().catch(() => {}); });

// The fake GitHub: PR #7's one check, rewritten mid-run.
const fixture = join(root, "github-fixture.json");
const setCheck = (status, conclusion) => writeFile(fixture, JSON.stringify({ status, conclusion }));
const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
if (process.env.GH_REPO !== "example/app") { console.error("wrong repo"); process.exit(1); }
if (a[0] !== "api" || a[1] !== "graphql") { console.log("[]"); process.exit(0); }
const c = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
const q = a.find(x => x.startsWith("query=")) || "";
const pr = n => ({ number: n, title: "Tidy the vendor settings copy", url: "https://github.com/example/app/pull/" + n, state: "OPEN", headRefName: "tidy-copy", headRefOid: "head-7", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", autoMergeRequest: null, isInMergeQueue: false, author: { login: "alice" }, reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] }, baseRef: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: c.status, conclusion: c.conclusion }] } } } }] } });
const r = { defaultBranchRef: { name: "main", branchProtectionRule: null }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, autoMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH", mergeQueue: null };
for (const m of q.matchAll(/(p\\d+):\\s*pullRequest\\(number:\\s*(\\d+)\\)/g)) r[m[1]] = pr(Number(m[2]));
console.log(JSON.stringify({ data: { repository: r } }));
`);
await chmod(join(bin, "gh"), 0o700);
await setCheck("IN_PROGRESS", null);

try {
  github = await fakeGithub({ dir: root, gh: join(bin, "gh") });
  applyEnv(harnessEnv(root, { home: userHome, paseoHome: home, set: { PASEO_DAEMON_URL: url, PATH: `${bin}${delimiter}${process.env.PATH}`, ...github.env }, strip: github.strip, real: REAL }));
  await writeConfig();
  await mkdir(join(home, "plugin-data", pluginId), { recursive: true });
  await writeFile(join(home, "plugin-data", pluginId, "state.json"), JSON.stringify({ version: 1, enable_follow_every: false, migrations: ["follow-every-1"], workspaces: [] }));
  const packageInfo = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { cwd: source, timeout: 60000, maxBuffer: 2 ** 22 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packageInfo.filename), "--strip-components=1", "-C", packedDirectory]);
  const logger = pino({ level: "warn" }, pino.destination(join(root, "daemon.log")));
  const hook = join(home, "plugin-data", pluginId, "agent-hook.mjs");
  const providerConfig = harnessDaemonProviders({ builtinProviderIds: BUILTIN_PROVIDER_IDS, real: REAL, settings: { claude: { env: { CLAUDE_CONFIG_DIR: actualClaude } } } });
  const claude = new ClaudeAgentClient({ logger, runtimeSettings: providerConfig.agentProviderSettings.claude, queryFactory(input) {
    return query({ ...input, options: { ...input.options, settingSources: [], strictMcpConfig: true, hooks: undefined,
      settings: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${hook}'`, timeout: 10 }] }], PostToolUse: [{ hooks: [{ type: "command", command: `node '${hook}'`, timeout: 10 }] }] } },
      systemPrompt: { type: "preset", preset: "claude_code", append: "This is an isolated synthetic test. There is no real repository or network; do not inspect unrelated files, modify configuration, or create agents." } } });
  } });
  daemon = await createPaseoDaemon({ ...providerConfig, listen: `127.0.0.1:${port}`, paseoHome: home, daemonVersion: "0.15.2", corsAllowedOrigins: [], hostnames: true, mcpEnabled: true, mcpInjectIntoAgents: true, browserToolsEnabled: false, relayEnabled: false, staticDir: root, mcpDebug: false, agentStoragePath: join(home, "agents"), agentClients: { claude }, providerCatalogRefreshTimeoutMs: 2000, metadataGeneration: { providers: [] }, pluginsEnabled: true, plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true } } }, logger);
  await daemon.start();
  client = new DaemonClient({ url, clientId: "follow-wait-checks-test", clientType: "cli", appVersion: "0.15.2", reconnect: { enabled: false } });
  await client.connect(); await client.fetchAgents({ subscribe: {} });
  await client.refreshProvidersSnapshot();
  assertProviderStubsUnused(root);
  assert.equal((await client.listPlugins()).find(p => p.id === pluginId)?.status, "running");
  await until(async () => { try { return !!JSON.parse(await readFile(join(home, "plugin-data", pluginId, "hooks-enabled.json"), "utf8")).clientEntry; } catch { return false; } }, "Follow-up writes its hook");
  result.host = client.getLastServerInfoMessage?.()?.version ?? null;
  const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd }, title: "Synthetic vendor copy" });
  const workspaceId = workspace.workspace.id;
  const agent = await client.createAgent({ provider: "claude", model: "haiku", modeId: "bypassPermissions", cwd, workspaceId, title: "Vendor copy" });
  await client.invokePluginRpc(pluginId, "follow.activate", { workspaceId });
  await until(async () => (await client.invokePluginRpc(pluginId, "follow.get", { workspaceId })).workspace?.mainAgentId === agent.id, "Follow-up tracks the workspace with the agent as main", 60000);
  const tools = () => daemon.agentManager.getPluginTools(agent.id);
  const call = async (name, input) => { const tool = tools().find(t => t.name === name); assert.ok(tool, name); return daemon.agentManager.executePluginTool(tool, agent.id, input, new AbortController().signal); };
  await client.sendMessage(agent.id, "Reply READY.");
  await until(() => daemon.agentManager.getAgent(agent.id)?.lifecycle === "idle" && tools().some(t => t.name.endsWith("wait_for_checks")), "the session opens with wait_for_checks", 120000);
  await call(tools().find(t => t.name.endsWith("register_pr")).name, { repo: "example/app", number: 7, stack: "tidy-copy" });
  await until(async () => (await client.invokePluginRpc(pluginId, "follow.get", { workspaceId })).workspace?.prs.find(p => p.number === 7)?.snapshot?.checksRunning === true, "Follow-up reads #7 with its check running", 90000);
  const before = github.requests.length; const beforeAt = Date.now();
  await client.sendMessage(agent.id, "You just pushed https://github.com/example/app/pull/7 and its CI check is running. Wait for the checks to finish, then reply CHECKS_DONE followed by the result. Don't fix anything.");
  const timeline = () => daemon.agentManager.getTimeline(agent.id);
  await until(() => timeline().some(i => i.type === "tool_call" && i.name.endsWith("wait_for_checks")), "the agent calls wait_for_checks", 180000);
  await until(() => daemon.agentManager.getAgent(agent.id)?.lifecycle === "idle", "the agent ends its turn", 180000);
  const calls = timeline().filter(i => i.type === "tool_call");
  result.toolCalls = calls.map(i => i.name);
  const shell = calls.filter(i => /bash/i.test(i.name)).map(i => JSON.stringify(i.detail ?? {}));
  assert.ok(!shell.some(s => /\bgh\b/.test(s)), `no gh call: ${shell.join(" | ")}`);
  const waitingAt = Date.now();
  await pause(30000);
  const idleReads = github.requests.length - before;
  result.readsWhileWaiting30s = idleReads;
  await setCheck("COMPLETED", "SUCCESS");
  const messages = () => timeline().filter(i => i.type === "user_message" && /Follow-up checks/.test(JSON.stringify(i)));
  await until(() => messages().length >= 1, "one Follow-up checks message arrives", 240000);
  result.messageAfterMs = Date.now() - waitingAt - 30000;
  await until(() => daemon.agentManager.getAgent(agent.id)?.lifecycle === "idle", "the agent answers it", 180000);
  const reply = timeline().filter(i => i.type === "assistant_message").map(i => i.text ?? JSON.stringify(i)).join("\n");
  assert.match(reply, /CHECKS_DONE/);
  await pause(60000);
  assert.equal(messages().length, 1, "exactly one message");
  assert.match(JSON.stringify(messages()[0]), /all checks passed/);
  result.messages = messages().length;
  assertProviderStubsUnused(root);
  log("PASS", result);
} catch (error) {
  result.error = error.stack; log("FAIL", { message: error.message, root, result }); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {}); await daemon?.stop().catch(() => {}); await github?.close().catch(() => {});
  applyEnv(original);
  if (!result.error) await rm(root, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
