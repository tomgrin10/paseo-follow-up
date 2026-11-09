// Trust bypass agents, end to end on a real Paseo daemon (npm run test:trust, in CI).
//
// Starts an isolated Paseo daemon (never the user's) with the fixture provider and the packed plugin. Each synthetic
// agent raises a permission prompt the way a provider does (session.permission), in a different mode:
//   - bypassPermissions and full-access: Follow-up approves it, the turn finishes, it is audited, and no Needs-you row
//     appears (the inbox's grace period sees the resolve first);
//   - an agent switched to bypassPermissions after it opened: approved too (the mode is read at request time);
//   - default and auto: the prompt stays for the developer and flags Needs you;
//   - a question from a bypass agent: never answered.
//
//   node scripts/check-trust-bypass.mjs [--json]
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const exec = promisify(execFile);
try { await exec("paseo", ["--version"], { timeout: 30_000 }); } catch {
  const message = "trust bypass check: the paseo CLI isn't on PATH (npm i -g @getpaseo/cli@0.15.2).";
  if (process.env.CI) { console.error(`${message} Required in CI.`); process.exit(1); }
  console.warn(`${message} Skipping.`); process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = await mkdtemp(join(tmpdir(), "follow-trust-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); const plugin = join(root, "plugin");
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: home, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" };
for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[key];
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;

try {
  for (const dir of [home, fixture, plugin]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true }, browserTools: { enabled: false } } }));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followthrough-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  const log = openSync(join(root, "daemon.log"), "a");
  daemon = spawn("paseo", ["daemon", "run", "--home", home], { env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 120; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i === 119) throw new Error("isolated daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-trust-check", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  await cli("plugin", "install", fixture);
  await cli("plugin", "install", plugin);
  const api = createPaseoApi(client);
  const make = async (modeId, i) => {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    return w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId }, title: `Synthetic ${modeId} agent` });
  };
  const pending = async id => (await client.fetchAgent({ agentId: id }))?.agent?.pendingPermissions ?? [];
  const audit = async () => (await readFile(join(home, "plugin-data/follow-through/trust-bypass.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const needs = async id => {
    const list = await client.invokePluginRpc("follow-through", "follow.inbox-list", {});
    const row = [...list.rows, ...(list.unsorted ?? [])].find(r => r.agentId === id);
    // Only a permission reason counts: a finished turn flags Needs you as usual.
    const permission = (row?.needs?.reasons ?? []).filter(r => r.reason === "permission");
    return permission.length ? JSON.stringify(permission) : null;
  };
  const result = {};

  // Full trust: approved, finished, audited, never flagged.
  const bypass = await make("bypassPermissions", 0);
  const full = await make("full-access", 1);
  const switched = await make("default", 2);
  await client.setAgentMode(switched.id, "bypassPermissions");
  for (const agent of [bypass, full, switched]) await agent.run("Fixture: permission tool Bash", { timeoutMs: 60_000 });
  await sleep(4_500); // past the inbox's permission grace period
  for (const [name, agent] of [["bypassPermissions", bypass], ["full-access", full], ["switched to bypass", switched]]) {
    assert.deepEqual(await pending(agent.id), [], `${name}: nothing left pending`);
    assert.equal(await needs(agent.id), null, `${name}: no Needs-you row`);
  }
  const approvals = await audit();
  assert.deepEqual(new Set(approvals.map(a => a.agentId)), new Set([bypass.id, full.id, switched.id]), "each approval audited");
  result.approved = approvals.map(a => `${a.mode}: ${a.summary}`);
  const stats = await client.invokePluginRpc("follow-through", "follow.trust-bypass", {});
  assert.equal(stats.today, 3);

  // Not full trust, or not a plain tool permission: left for the developer, and flagged.
  const careful = await make("default", 3);
  const auto = await make("auto", 4);
  const asking = await make("bypassPermissions", 5);
  await careful.send("Fixture: permission tool Bash");
  await auto.send("Fixture: permission tool Bash");
  await asking.send("Fixture: permission question AskUserQuestion");
  await sleep(5_000);
  for (const [name, agent] of [["default", careful], ["auto", auto], ["bypass question", asking]]) {
    assert.equal((await pending(agent.id)).length, 1, `${name}: the prompt stays pending`);
    assert.match(await needs(agent.id) ?? "", /permission/i, `${name}: flagged Needs you`);
  }
  assert.equal((await audit()).length, 3, "nothing else approved");
  result.leftForTheDeveloper = ["default", "auto", "bypass question"];
  for (const agent of [careful, auto, asking]) { const [p] = await pending(agent.id); await client.respondToPermission(agent.id, p.id, { behavior: "deny", message: "check done" }).catch(() => undefined); }
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
} catch (error) { process.exitCode = 1; throw error; } finally {
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  if (process.exitCode) console.error(`daemon log: ${join(root, "daemon.log")}`); else await rm(root, { recursive: true, force: true });
}
