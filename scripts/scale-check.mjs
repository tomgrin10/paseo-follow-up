// Scale check: does Follow-up wake dormant agents?
//
// Starts an isolated Paseo daemon (never the user's), creates N synthetic workspaces with one fixture agent each,
// ages their last user message past the active window and restarts the daemon so every agent is unloaded, then
// wakes a few on purpose. It then installs Follow-up with every workspace tracked and auto-send on (the 1.3.0-beta.2
// blast radius) and counts loaded agents before and after three poll cycles.
//
//   node scripts/scale-check.mjs [--workspaces 120] [--awake 5] [--plugin <unpacked plugin dir>] [--json]
//
// Exits non-zero when the loaded count grows, or when --rss-budget / --cpu-budget are exceeded. Skips (exit 0) when
// the paseo CLI is missing, except under CI. Run it inside a memory-capped scope, e.g.
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
// The check drives a real Paseo daemon, so it needs the paseo CLI (CI installs @getpaseo/cli). Without it, local
// runs skip with a message; in CI a missing CLI is a failure, so the resource budget is always enforced there.
try { await exec("paseo", ["--version"], { timeout: 30_000 }); } catch {
  const message = "scale check: the paseo CLI isn't on PATH (npm i -g @getpaseo/cli@0.15.2).";
  if (process.env.CI) { console.error(`${message} Required in CI.`); process.exit(1); }
  console.warn(`${message} Skipping.`); process.exit(0);
}
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("workspaces", "120")); const AWAKE = Number(arg("awake", "5")); const POLLS = 3; const POLL_MS = 15_000;
/** Seeds each workspace with this many never-sent cancelled batches, like the VM's 1.3.0-beta.2 state. */
const CHURN = Number(arg("churn", "0")); const IDLE_MS = Number(arg("idle", "30")) * 1000;
const budget = { rssMb: Number(arg("rss-budget", "0")), cpuPct: Number(arg("cpu-budget", "0")) };
const root = await mkdtemp(join(tmpdir(), "follow-scale-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); let plugin = arg("plugin", null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const heapDir = arg("heap-snapshot", null);
const env = { ...process.env, ...(heapDir ? { NODE_OPTIONS: `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=${heapDir}` } : {}), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: home, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" };
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
  const churn = i => Array.from({ length: CHURN }, (_, k) => ({ id: `churn-${i}-${k}`, messageId: `churn-m-${i}-${k}`, tasks: [{ key: `completion:w${i}`, kind: "completion", target: `w${i}`, title: "Verify the workspace is finished and declare Done", fingerprint: `f${k}` }], state: "cancelled", createdAt: now, sentAt: null, settledAt: null, attempts: 1, result: "Conditions resolved before delivery", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] }));
  await writeFile(join(home, "plugin-data/follow-through/state.json"), JSON.stringify({ version: 1, migrations: ["follow-every-1"], workspaces: created.map(({ workspaceId, agentId }, i) => ({ id: workspaceId, title: `Synthetic workspace ${i}`, goal: "Synthetic", mainAgentId: agentId, enable_tracking: true, enable_auto_sends: true, hold: null, archived: false, prs: [], obligations: [], batches: churn(i), completion: null, updatedAt: now, managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false, inventory: null })) }));
  const stateBytesBefore = (await readFile(join(home, "plugin-data/follow-through/state.json"))).length;
  const before = loaded(await agents());
  await cli("plugin", "install", plugin);
  const samples = [];
  for (let poll = 1; poll <= POLLS; poll++) { await sleep(POLL_MS); samples.push(loaded(await agents())); }
  await sleep(5_000);
  const after = loaded(await agents());
  // The worker: its pid is in the lock it holds. RSS now, CPU and state.json writes over an idle window.
  const pid = Number((await readFile(join(home, "plugin-data/follow-through/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  const ticks = async () => { const f = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
  const rss = async (field = "VmRSS") => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(await readFile(`/proc/${pid}/status`, "utf8"))[1]) / 1024;
  let worker = null;
  if (pid > 0) {
    const { stdout } = await exec("getconf", ["CLK_TCK"]); const hz = Number(stdout.trim()) || 100;
    const { statSync } = await import("node:fs"); const statePath = join(home, "plugin-data/follow-through/state.json");
    let writes = 0; let mtime = statSync(statePath).mtimeMs;
    const t0 = await ticks(); const started = Date.now();
    let peak = await rss();
    while (Date.now() - started < IDLE_MS) { await sleep(500); peak = Math.max(peak, await rss()); const m = statSync(statePath).mtimeMs; if (m !== mtime) { writes++; mtime = m; } }
    const cpuPct = Math.round(((await ticks()) - t0) / hz / ((Date.now() - started) / 1000) * 1000) / 10;
    // The worker's own breakdown (heap vs native), from the governor's sample in follow.usage.
    const memory = async () => { try { return (await client.invokePluginRpc("follow-through", "follow.usage", {}))?.resources?.worker ?? null; } catch { return null; } };
    const memoryIdle = await memory();
    if (heapDir) { process.kill(pid, "SIGUSR2"); await sleep(8_000); }
    // The host's own cost: other plugin processes under this daemon (the fixture provider), for comparison.
    const { stdout: ps } = await exec("ps", ["-eo", "pid=,ppid=,rss=,args="]);
    // `paseo daemon run` is a wrapper, so plugin processes are grandchildren: walk the daemon's whole tree.
    const rows = ps.trim().split("\n").map(l => l.trim().split(/\s+/)).map(f => ({ pid: Number(f[0]), ppid: Number(f[1]), rssMb: Math.round(Number(f[2]) / 1024), args: f.slice(3).join(" ") }));
    const tree = new Set([daemon.pid]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; } }
    const hostRss = rows.filter(r => tree.has(r.pid) && r.pid !== pid && /plugin-process/.test(r.args)).map(r => r.rssMb);
    worker = { pid, memory: memoryIdle, hostPluginBaselineMb: hostRss.length ? Math.min(...hostRss) : null, rssMb: Math.round(await rss()), idlePeakRssMb: Math.round(peak), lifetimePeakRssMb: Math.round(await rss("VmHWM")), cpuPct, idleSeconds: IDLE_MS / 1000, stateWrites: writes, stateBytesBefore, stateBytesAfter: statSync(statePath).size };
  }
  const receipts = (await readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(l => /Follow-through (batch|recovery)/.test(l)).length;
  const state = JSON.parse(await readFile(join(home, "plugin-data/follow-through/state.json"), "utf8"));
  const result = { workspaces: N, awakeOnPurpose: AWAKE, loadedBefore: before, loadedPerPoll: samples, loadedAfter: after, followUpSends: receipts, dormant: state.workspaces.filter(w => w.dormant).length, autoSendOn: state.workspaces.filter(w => w.enable_auto_sends).length, parked: state.autoSendsParked?.length ?? 0, worker };
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
  if (after > before) { console.error(`Follow-up loaded ${after - before} dormant agents`); process.exitCode = 1; }
  if (budget.rssMb && worker && worker.idlePeakRssMb > budget.rssMb) { console.error(`Worker RSS peaked at ${worker.idlePeakRssMb} MB, over ${budget.rssMb} MB`); process.exitCode = 1; }
  if (budget.cpuPct && worker && worker.cpuPct > budget.cpuPct) { console.error(`Worker CPU ${worker.cpuPct}% exceeds ${budget.cpuPct}% while idle`); process.exitCode = 1; }
} finally {
  await stop().catch(() => {});
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.error(`kept ${root}`);
}
