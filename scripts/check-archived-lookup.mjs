// An archived agent a chat card names reads "archived" through Follow-up's one-off lookup (fetch_agent), and that
// lookup never loads it. Paseo's fetch_agents leaves archived agents out, so the agent is archived before Follow-up is
// installed: the worker never saw it, and only DaemonDirectory.lookup can say "archived" (docs/client.md).
// Usage: node scripts/check-archived-lookup.mjs [--pack <paseo-follow-up.tgz>]. Runs on Paseo 0.15 and 0.16.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";
import { isLoaded } from "../shared/agent-load.ts";
await harness();
const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = await fs.mkdtemp(join(tmpdir(), "follow-archived-lookup-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const fixture = join(root, "fixture");
await Promise.all([home, plugin, fixture].map(p => fs.mkdir(p, { recursive: true })));
const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
const url = `ws://127.0.0.1:${port}/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let daemon; let client;
try {
  await fs.writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false }, browserTools: { enabled: false } } }));
  const pack = arg("--pack") ? resolve(arg("--pack")) : join(root, JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60000 })).stdout)[0].filename);
  await exec("tar", ["-xzf", pack, "--strip-components=1", "-C", plugin]);
  await fs.writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await fs.writeFile(join(fixture, "index.server.ts"), await fs.readFile("scripts/fixture-provider.ts", "utf8"));
  const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" } });
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1 << 20 })).stdout);
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; ; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i > 80) throw new Error("daemon did not start"); await sleep(250); } }
  await cli("plugin", "install", fixture);
  client = new DaemonClient({ url, clientId: "follow-archived-lookup", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  const api = createPaseoApi(client);
  const w = await api.workspaces.create({ title: "Archived lookup", source: { kind: "directory", path: root } });
  const cfg = { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" };
  await w.agents.create({ config: cfg, title: "Main" });
  const docs = await w.agents.create({ config: cfg, title: "Docs pass" });
  await client.sendMessage(docs.id, "Write the docs pass", { messageId: "archived-lookup" });
  await sleep(1500);
  await client.archiveAgent(docs.id);
  // The daemon's own view, from a list read (never a load): includeArchived returns the archived row.
  const row = async () => (await client.fetchAgents({ filter: { includeArchived: true }, page: { limit: 100 } })).entries.map(e => e.agent).find(a => a.id === docs.id);
  for (let i = 0; i < 40 && isLoaded(await row()); i++) await sleep(250);
  const before = await row();
  assert.ok(before?.archivedAt, "the agent is archived");
  assert.equal(isLoaded(before), false, `archiving unloads it (status ${before?.status}, activeTurn ${JSON.stringify(before?.activeTurn)})`);

  await cli("plugin", "install", plugin);
  const ask = () => client.invokePluginRpc("follow-up", "follow.created-items", { agentIds: [docs.id, "agent-never-existed"], workspaceIds: [] });
  let live;
  for (let i = 0; i < 120; i++) { live = await ask().catch(() => null); if (live?.agents?.[docs.id]) break; await sleep(500); }
  assert.equal(live?.agents?.[docs.id]?.state, "archived", `the card reads archived through the lookup: ${JSON.stringify(live)}`);
  assert.equal(live.agents["agent-never-existed"], undefined, "an id Paseo never had stays unknown (words only)");
  // The card keeps reading (its poll stops at archived, but other cards' polls go on): nothing more is looked up or loaded.
  for (let i = 0; i < 6; i++) { await ask(); await sleep(500); }
  const after = await row();
  assert.equal(isLoaded(after), false, `the lookup never loads the agent (status ${after?.status}, activeTurn ${JSON.stringify(after?.activeTurn)})`);
  assert.ok(!["running", "initializing"].includes(after.status), `never resumed: ${after.status}`);
  const { stdout: version } = await exec("paseo", ["--version"], { env });
  console.log(`PASS: an archived agent a card names reads archived through one fetch_agent and stays unloaded (Paseo ${version.trim()}).`);
} finally {
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await sleep(1500); if (daemon.exitCode === null) daemon.kill("SIGKILL"); }
  await fs.rm(root, { recursive: true, force: true });
}
