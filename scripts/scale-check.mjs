// Scale check: does Follow-up wake dormant agents?
//
// Starts an isolated Paseo daemon (never the user's), creates N synthetic workspaces with one fixture agent each,
// ages their last user message past the active window and restarts the daemon so every agent is unloaded, then
// wakes a few on purpose. It then installs Follow-up with every workspace tracked and auto-send on (the 1.3.0-beta.2
// blast radius) and counts loaded agents before and after three poll cycles.
//
//   node scripts/scale-check.mjs [--workspaces 120] [--awake 5] [--plugin <unpacked plugin dir>] [--json]
//
// Exits non-zero when the loaded count grows. Run it inside a memory-capped scope, e.g.
//   systemd-run --user --scope -p MemoryMax=4G node scripts/scale-check.mjs
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { openSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("workspaces", "120")); const AWAKE = Number(arg("awake", "5")); const POLLS = 3; const POLL_MS = 15_000;
const root = await mkdtemp(join(tmpdir(), "follow-scale-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); let plugin = arg("plugin", null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: home, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" };
for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[key];
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;
const start = async () => {
  daemon = spawn("paseo", ["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; i < 120; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i === 119) throw new Error("isolated daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-scale-check", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
};
const stop = async () => { await client?.close().catch(() => {}); client = null; if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); } daemon = null; };
const agents = async () => { const rows = []; let cursor; do { const page = await client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } }); rows.push(...page.entries.map(e => e.agent)); cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null; } while (cursor); return rows; };
// Same rule as shared/agent-load.ts: only a live snapshot carries activeTurn.
const loaded = list => list.filter(a => ["running", "initializing"].includes(a.status) || a.pendingPermissions?.length || (a.status !== "closed" && Object.hasOwn(a, "activeTurn"))).length;

try {
  await mkdir(home, { recursive: true }); await mkdir(fixture, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false }, browserTools: { enabled: false } } }));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followthrough-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  if (!plugin) {
    plugin = join(root, "plugin"); await mkdir(plugin);
    const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
    await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  }
  await start();
  await cli("plugin", "install", fixture);
  const api = createPaseoApi(client);
  const created = [];
  for (let i = 0; i < N; i++) {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    const a = await w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic agent ${i}` });
    await client.sendMessage(a.id, `Synthetic task ${i}: ship https://github.com/example/app/pull/${i + 1}`, { messageId: `scale-${i}` });
    created.push({ workspaceId: w.id, agentId: a.id });
  }
  await sleep(2_000);
  await stop();
  // Age every stored record past the active window, as on a VM with weeks of old workspaces.
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith(".json")) { const text = await readFile(p, "utf8"); if (!text.includes("lastUserMessageAt")) continue; const record = JSON.parse(text); if (record.lastUserMessageAt) { record.lastUserMessageAt = old; await writeFile(p, JSON.stringify(record)); } } } };
  await walk(join(home, "agents"));
  await start();
  for (const { agentId } of created.slice(0, AWAKE)) await client.sendMessage(agentId, "Synthetic: still working", { messageId: `awake-${agentId}` });
  await sleep(2_000);
  // The beta.2 state: every workspace followed with auto-send on, nothing cached.
  await mkdir(join(home, "plugin-data/follow-through"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(home, "plugin-data/follow-through/state.json"), JSON.stringify({ version: 1, migrations: ["follow-every-1"], workspaces: created.map(({ workspaceId, agentId }, i) => ({ id: workspaceId, title: `Synthetic workspace ${i}`, goal: "Synthetic", mainAgentId: agentId, enable_tracking: true, enable_auto_sends: true, hold: null, archived: false, prs: [], obligations: [], batches: [], completion: null, updatedAt: now, managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false, inventory: null })) }));
  const before = loaded(await agents());
  await cli("plugin", "install", plugin);
  const samples = [];
  for (let poll = 1; poll <= POLLS; poll++) { await sleep(POLL_MS); samples.push(loaded(await agents())); }
  await sleep(5_000);
  const after = loaded(await agents());
  const receipts = (await readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(l => /Follow-through (batch|recovery)/.test(l)).length;
  const state = JSON.parse(await readFile(join(home, "plugin-data/follow-through/state.json"), "utf8"));
  const result = { workspaces: N, awakeOnPurpose: AWAKE, loadedBefore: before, loadedPerPoll: samples, loadedAfter: after, followUpSends: receipts, dormant: state.workspaces.filter(w => w.dormant).length, autoSendOn: state.workspaces.filter(w => w.enable_auto_sends).length, parked: state.autoSendsParked?.length ?? 0 };
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
  if (after > before) { console.error(`Follow-up loaded ${after - before} dormant agents`); process.exitCode = 1; }
} finally {
  await stop().catch(() => {});
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.error(`kept ${root}`);
}
