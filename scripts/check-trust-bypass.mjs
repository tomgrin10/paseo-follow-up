// Trust bypass agents, end to end on a real Paseo daemon (npm run test:trust, in CI).
//
// Starts an isolated Paseo daemon (never the user's) with the fixture provider and the packed plugin. Each synthetic
// agent raises a permission prompt the way a provider does (session.permission), in a different mode:
//   - bypassPermissions and full-access: Follow-up approves it, the turn finishes, it is audited, and no Needs-you row
//     appears (the inbox's grace period sees the resolve first);
//   - an agent switched to bypassPermissions after it opened: approved too (the mode is read at request time);
//   - default and auto: the prompt stays for the developer and flags Needs you;
//   - a question from a bypass agent: never answered;
//   - a bypass prompt already pending when Follow-up loads: answered by the load sweep.
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
  /**
   * Waits for a state, never for a wall-clock grace: the inbox's grace ordering (an answer inside the grace period
   * never flags, an unanswered prompt does) is proved with mock timers in tests/inbox.test.ts. Here only the end
   * state counts, and both end states are final: a resolved prompt can't flag later, and a flagged one stays flagged.
   */
  const until = async (check, label, ms = 60_000) => {
    const deadline = Date.now() + ms; let last;
    while (Date.now() < deadline) { last = await check(); if (last) return last; await sleep(250); }
    throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
  };
  const result = {};

  // Full trust: approved, finished, audited, never flagged.
  const bypass = await make("bypassPermissions", 0);
  const full = await make("full-access", 1);
  const switched = await make("default", 2);
  await client.setAgentMode(switched.id, "bypassPermissions");
  for (const agent of [bypass, full, switched]) await agent.run("Fixture: permission tool Bash", { timeoutMs: 60_000 });
  for (const [name, agent] of [["bypassPermissions", bypass], ["full-access", full], ["switched to bypass", switched]]) {
    await until(async () => (await pending(agent.id)).length === 0, `${name}: nothing left pending`);
    await until(async () => await needs(agent.id) === null, `${name}: no Needs-you row`);
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
  for (const [name, agent] of [["default", careful], ["auto", auto], ["bypass question", asking]]) {
    assert.match(await until(() => needs(agent.id), `${name}: flagged Needs you`), /permission/i);
    assert.equal((await pending(agent.id)).length, 1, `${name}: the prompt stays pending`);
  }
  assert.equal((await audit()).length, 3, "nothing else approved");
  result.leftForTheDeveloper = ["default", "auto", "bypass question"];
  for (const agent of [careful, auto, asking]) { const [p] = await pending(agent.id); await client.respondToPermission(agent.id, p.id, { behavior: "deny", message: "check done" }).catch(() => undefined); }

  // A prompt already pending when Follow-up loads raises no new event: the load sweep answers it. Follow-up is off
  // while the bypass agent asks, then turned back on (the same as an install or update landing mid-prompt).
  await cli("plugin", "disable", "follow-through");
  const early = await make("bypassPermissions", 6);
  await early.send("Fixture: permission tool Bash");
  await until(async () => (await pending(early.id)).length === 1, "pending while Follow-up is off");
  await cli("plugin", "enable", "follow-through");
  await until(async () => (await pending(early.id)).length === 0, "the load sweep approved the prompt that was already pending");
  const swept = await until(async () => { const rows = await audit(); return rows.length >= 4 && rows; }, "the sweep's approval audited");
  assert.equal(swept.length, 4, "only that prompt");
  assert.equal(swept.at(-1).agentId, early.id);
  await until(async () => await needs(early.id) === null, "no Needs-you row for it");
  result.sweptAtLoad = `${swept.at(-1).mode}: ${swept.at(-1).summary}`;

  // Agent parity: an agent turns trust bypass off with set_display (planned: dry run, then confirm), the same host
  // settings write as Settings → Permissions. The next bypass prompt then stays for the developer.
  const act = (agentId, tool, args) => client.invokePluginRpc("follow-through", "follow.agent-act", { agentId, tool, args });
  const plan = await act(early.id, "set_display", { values: { enable_trust_bypass: false } });
  assert.deepEqual(plan.changes, [{ key: "enable_trust_bypass", from: true, to: false }], "the dry run shows the change");
  assert.equal((await client.invokePluginRpc("follow-through", "settings.display.read", {})).values.enable_trust_bypass, true, "the dry run wrote nothing");
  await act(early.id, "set_display", { confirm: true, planId: plan.planId });
  assert.equal((await client.invokePluginRpc("follow-through", "settings.display.read", {})).values.enable_trust_bypass, false, "confirm wrote the host setting");
  const after = await make("bypassPermissions", 7);
  await after.send("Fixture: permission tool Bash");
  assert.match(await until(() => needs(after.id), "trust bypass off: the prompt flags Needs you"), /permission/i);
  assert.equal((await pending(after.id)).length, 1, "trust bypass off: the prompt stays pending");
  assert.equal((await audit()).length, 4, "nothing approved after the agent turned it off");
  result.agentTurnedTrustOff = true;
  // A developer RPC as an agent tool on a real daemon: Settings → Following's Auto-send default, planned.
  const before = await client.invokePluginRpc("follow-through", "follow.follow-settings", {});
  const flip = !before.enable_auto_sends_default;
  const followPlan = await act(early.id, "set_follow_settings", { enable_auto_sends_default: flip });
  assert.equal((await client.invokePluginRpc("follow-through", "follow.follow-settings", {})).enable_auto_sends_default, before.enable_auto_sends_default, "the dry run wrote nothing");
  await act(early.id, "set_follow_settings", { confirm: true, planId: followPlan.planId });
  assert.equal((await client.invokePluginRpc("follow-through", "follow.follow-settings", {})).enable_auto_sends_default, flip, "confirm ran the Settings RPC");
  result.agentChangedFollowSettings = true;
  { const [p] = await pending(after.id); await client.respondToPermission(after.id, p.id, { behavior: "deny", message: "check done" }).catch(() => undefined); }
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
} catch (error) { process.exitCode = 1; throw error; } finally {
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  if (process.exitCode) console.error(`daemon log: ${join(root, "daemon.log")}`); else await rm(root, { recursive: true, force: true });
}
