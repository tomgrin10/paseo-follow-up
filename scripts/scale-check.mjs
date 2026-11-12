// Scale check: does Follow-up wake dormant agents?
//
// Starts an isolated Paseo daemon (never the user's), creates N synthetic workspaces with one fixture agent each,
// ages their last user message past the active window and restarts the daemon so every agent is unloaded, then
// wakes a few on purpose. It then installs Follow-up with every workspace tracked and auto-send on (the 1.3.0-beta.2
// blast radius) and counts loaded agents before and after three poll cycles.
//
//   node scripts/scale-check.mjs [--workspaces 120] [--awake 5] [--realistic] [--plugin <unpacked plugin dir>] [--json]
//
// Exits non-zero when the loaded count grows, or when --rss-budget / --cpu-budget are exceeded. Skips (exit 0) when
// the paseo CLI is missing, except under CI. Run it inside a memory-capped scope, e.g.
//   systemd-run --user --scope -p MemoryMax=4G node scripts/scale-check.mjs
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { openSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { startCounter, ratePerMinute } from "./daemon-counter.mjs";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv, harnessConfig } from "./harness-env.mjs";
import { fakeGithub } from "./fake-github.mjs";
import { scaleGh } from "./scale-github.mjs";

const exec = promisify(execFile);
// The check drives a real Paseo daemon, so it needs the paseo CLI (CI installs @getpaseo/cli). Without it, local
// runs skip with a message; in CI a missing CLI is a failure, so the resource budget is always enforced there.
try { await exec("paseo", ["--version"], { timeout: 30_000 }); } catch {
  const message = "scale check: the paseo CLI isn't on PATH (npm i -g @getpaseo/cli@0.15.2).";
  if (process.env.CI) { console.error(`${message} Required in CI.`); process.exit(1); }
  console.warn(`${message} Skipping.`); process.exit(0);
}
await harness();
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("workspaces", "120")); const AWAKE = Number(arg("awake", "5")); const POLLS = 3; const POLL_MS = 15_000;
/** Seeds each workspace with this many never-sent cancelled batches, like the VM's 1.3.0-beta.2 state. */
const CHURN = Number(arg("churn", "0")); const REALISTIC = process.argv.includes("--realistic");
/** Agents per workspace: live has ~300 listed agents at 141 workspaces, so --realistic makes two. */
const PER = Number(arg("agents-per-workspace", REALISTIC ? "2" : "1")); const IDLE_MS = Number(arg("idle", "30")) * 1000;
const budget = { idleRssMb: Number(arg("idle-rss-budget", "0")), rssMb: Number(arg("rss-budget", "0")), cpuPct: Number(arg("cpu-budget", "0")), requestsPerMin: Number(arg("request-budget", "0")) };
const root = await mkdtemp(join(tmpdir(), "follow-scale-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); let plugin = arg("plugin", null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
// Every client but this script reaches the daemon through a counting proxy, so the worker's request rate is measured.
const counter = await startCounter(port); const counted = `ws://127.0.0.1:${counter.port}/ws`;
const heapDir = arg("heap-snapshot", null);
// --cpu-prof <dir>: every node process the daemon starts (the worker too) writes a .cpuprofile when it exits, so a
// startup burst or idle CPU can be attributed to functions (node scripts/cpu-top.mjs <file>).
const cpuDir = arg("cpu-prof", null);
// --alloc-prof <dir>: what every node process allocates, garbage included (scripts/alloc-prof.cjs, alloc-top.mjs).
const allocDir = arg("alloc-prof", null);
// --realistic also answers GitHub reads with live-sized PR bodies (scripts/scale-github.mjs), so a cold start reads
// every PR the way the live worker does.
let github = null;
if (REALISTIC) { await mkdir(join(root, "bin"), { recursive: true }); await writeFile(join(root, "bin/gh"), scaleGh()); const { chmod } = await import("node:fs/promises"); await chmod(join(root, "bin/gh"), 0o700); github = await fakeGithub({ dir: root, gh: join(root, "bin/gh"), owners: ["example"] }); }
const env = harnessEnv(root, { home, strip: github?.strip ?? [], set: { ...(heapDir || cpuDir || allocDir ? { NODE_OPTIONS: [heapDir && `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=${heapDir}`, cpuDir && `--cpu-prof --cpu-prof-dir=${cpuDir}`, allocDir && `--require ${join(dirname(fileURLToPath(import.meta.url)), "alloc-prof.cjs")}`].filter(Boolean).join(" ") } : {}), ...(allocDir ? { FOLLOW_UP_ALLOC_PROF: allocDir } : {}), PASEO_DAEMON_URL: counted, PASEO_RELAY_ENABLED: "false", ...(github?.env ?? {}) } });
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;
const start = async () => {
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; i < 120; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i === 119) throw new Error("isolated daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-scale-check", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
};
const stop = async () => { await client?.close().catch(() => {}); client = null; if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); } daemon = null; };
const agents = async () => { const rows = []; let cursor; do { const page = await client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } }); rows.push(...page.entries.map(e => e.agent)); cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null; } while (cursor); return rows; };
// Same rule as shared/agent-load.ts: only a live snapshot carries activeTurn.
const loaded = list => list.filter(a => ["running", "initializing"].includes(a.status) || a.pendingPermissions?.length || (a.status !== "closed" && Object.hasOwn(a, "activeTurn"))).length;

try {
  await mkdir(home, { recursive: true }); await mkdir(fixture, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port })));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
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
    const a = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic agent ${i}` });
    await client.sendMessage(a.id, `Synthetic task ${i}: ship https://github.com/example/app/pull/${i + 1}`, { messageId: `scale-${i}` });
    created.push({ workspaceId: w.id, agentId: a.id });
    for (let k = 1; k < PER; k++) await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic helper ${i}.${k}` });
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
  await mkdir(join(home, "plugin-data/follow-up"), { recursive: true });
  const now = new Date().toISOString();
  const churn = i => Array.from({ length: CHURN }, (_, k) => ({ id: `churn-${i}-${k}`, messageId: `churn-m-${i}-${k}`, tasks: [{ key: `completion:w${i}`, kind: "completion", target: `w${i}`, title: "Verify the workspace is finished and declare Done", fingerprint: `f${k}` }], state: "cancelled", createdAt: now, sentAt: null, settledAt: null, attempts: 1, result: "Conditions resolved before delivery", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] }));
  await writeFile(join(home, "plugin-data/follow-up/state.json"), JSON.stringify({ version: 1, migrations: ["follow-every-1"], workspaces: created.map(({ workspaceId, agentId }, i) => ({ id: workspaceId, title: `Synthetic workspace ${i}`, goal: "Synthetic", mainAgentId: agentId, enable_tracking: true, enable_auto_sends: true, hold: null, archived: false, prs: [], obligations: [], batches: churn(i), completion: null, updatedAt: now, managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false, inventory: null })) }));
  // --realistic: the live install's shape (about 9 KB a workspace: PRs with snapshots, tasks, batch history, questions),
  // from scripts/scale-seed.ts. The empty seed above let a 450 MB worker pass a 240 MB budget (2026-11-12).
  if (REALISTIC) {
    await writeFile(join(root, "created.json"), JSON.stringify(created));
    await exec("npx", ["tsx", "scripts/scale-seed.ts", join(home, "plugin-data/follow-up/state.json"), join(root, "created.json")], { timeout: 120_000 });
  }
  const stateBytesBefore = (await readFile(join(home, "plugin-data/follow-up/state.json"))).length;
  const before = loaded(await agents());
  await cli("plugin", "install", plugin);
  // From install on: the worker's RSS every 250 ms (steps over 10 MB, with when) and V8's heap every 5 s, so a
  // transient spike (V8 grows the heap, RSS keeps the high-water mark) shows when it happens.
  const installedAt = Date.now(); const trace = { steps: [], peakHeapTotalMb: 0, peakHeapUsedMb: 0, peakRssMb: 0 }; let tracing = true;
  const tracer = (async () => {
    let wpid = 0, last = 0, lastUsage = 0;
    while (tracing) {
      if (!wpid) wpid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]) || 0;
      if (wpid) {
        const status = await readFile(`/proc/${wpid}/status`, "utf8").catch(() => "");
        const now = Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
        if (now && Math.abs(now - last) > 10) { trace.steps.push({ s: Math.round((Date.now() - installedAt) / 100) / 10, at: new Date().toISOString(), rssMb: now }); last = now; }
        trace.peakRssMb = Math.max(trace.peakRssMb, now);
        if (Date.now() - lastUsage > 5000) { lastUsage = Date.now(); const w = await client.invokePluginRpc("follow-up", "follow.usage", {}).then(u => u?.resources?.worker, () => null); if (w) { trace.peakHeapTotalMb = Math.max(trace.peakHeapTotalMb, w.heapTotalMb ?? 0); trace.peakHeapUsedMb = Math.max(trace.peakHeapUsedMb, w.heapUsedMb ?? 0); } }
      }
      await sleep(250);
    }
  })();
  const samples = [];
  for (let poll = 1; poll <= POLLS; poll++) { await sleep(POLL_MS); samples.push(loaded(await agents())); }
  await sleep(5_000);
  const after = loaded(await agents());
  // The worker: its pid is in the lock it holds. RSS now, CPU and state.json writes over an idle window.
  const pid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  const ticks = async () => { const f = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
  const rss = async (field = "VmRSS") => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(await readFile(`/proc/${pid}/status`, "utf8"))[1]) / 1024;
  let worker = null;
  if (pid > 0) {
    const { stdout } = await exec("getconf", ["CLK_TCK"]); const hz = Number(stdout.trim()) || 100;
    const { statSync } = await import("node:fs"); const statePath = join(home, "plugin-data/follow-up/state.json");
    let writes = 0; let mtime = statSync(statePath).mtimeMs;
    const t0 = await ticks(); const started = Date.now(); const requestsBefore = counter.snapshot();
    let peak = await rss();
    while (Date.now() - started < IDLE_MS) { await sleep(500); peak = Math.max(peak, await rss()); const m = statSync(statePath).mtimeMs; if (m !== mtime) { writes++; mtime = m; } }
    const requests = ratePerMinute(requestsBefore, counter.snapshot(), "follow-up-worker", Date.now() - started);
    const cpuPct = Math.round(((await ticks()) - t0) / hz / ((Date.now() - started) / 1000) * 1000) / 10;
    // The worker's own breakdown (heap vs native), from the governor's sample in follow.usage.
    const memory = async () => { try { return (await client.invokePluginRpc("follow-up", "follow.usage", {}))?.resources?.worker ?? null; } catch { return null; } };
    const memoryIdle = await memory();
    let memoryAfterGc = null;
    if (heapDir) { process.kill(pid, "SIGUSR2"); await sleep(8_000); memoryAfterGc = await memory(); }
    // The host's own cost: other plugin processes under this daemon (the fixture provider), for comparison.
    const { stdout: ps } = await exec("ps", ["-eo", "pid=,ppid=,rss=,args="]);
    // `paseo daemon run` is a wrapper, so plugin processes are grandchildren: walk the daemon's whole tree.
    const rows = ps.trim().split("\n").map(l => l.trim().split(/\s+/)).map(f => ({ pid: Number(f[0]), ppid: Number(f[1]), rssMb: Math.round(Number(f[2]) / 1024), args: f.slice(3).join(" ") }));
    const tree = new Set([daemon.pid]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; } }
    const hostRss = rows.filter(r => tree.has(r.pid) && r.pid !== pid && /plugin-process/.test(r.args)).map(r => r.rssMb);
    worker = { pid, memory: memoryIdle, memoryAfterGc, hostPluginBaselineMb: hostRss.length ? Math.min(...hostRss) : null, rssMb: Math.round(await rss()), idlePeakRssMb: Math.round(peak), lifetimePeakRssMb: Math.round(await rss("VmHWM")), cpuPct, idleSeconds: IDLE_MS / 1000, stateWrites: writes, stateBytesBefore, stateBytesAfter: statSync(statePath).size, daemonRequestsPerMin: requests };
  }
  tracing = false; await tracer;
  if (worker) worker.trace = { ...trace, githubRequests: github?.requests.length ?? 0 };
  const receipts = (await readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(l => /Follow-up (batch|recovery)/.test(l)).length;
  const state = JSON.parse(await readFile(join(home, "plugin-data/follow-up/state.json"), "utf8"));
  const result = { workspaces: N, awakeOnPurpose: AWAKE, loadedBefore: before, loadedPerPoll: samples, loadedAfter: after, followUpSends: receipts, dormant: state.workspaces.filter(w => w.dormant).length, autoSendOn: state.workspaces.filter(w => w.enable_auto_sends).length, parked: state.autoSendsParked?.length ?? 0, worker };
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
  if (after > before) { console.error(`Follow-up loaded ${after - before} dormant agents`); process.exitCode = 1; }
  // The budget is the worker's lifetime peak (VmHWM), start-up tick included: 2026-11-12's spike was over before idle began.
  if (budget.idleRssMb && worker && worker.idlePeakRssMb > budget.idleRssMb) { console.error(`Worker idle RSS peaked at ${worker.idlePeakRssMb} MB, over ${budget.idleRssMb} MB`); process.exitCode = 1; }
  if (budget.rssMb && worker && worker.lifetimePeakRssMb > budget.rssMb) { console.error(`Worker RSS peaked at ${worker.lifetimePeakRssMb} MB (idle peak ${worker.idlePeakRssMb}), over ${budget.rssMb} MB`); process.exitCode = 1; }
  if (budget.requestsPerMin && worker && worker.daemonRequestsPerMin.total > budget.requestsPerMin) { console.error(`Worker sent ${worker.daemonRequestsPerMin.total} daemon requests/min while idle, over ${budget.requestsPerMin}: ${JSON.stringify(worker.daemonRequestsPerMin.byType)}`); process.exitCode = 1; }
  if (budget.cpuPct && worker && worker.cpuPct > budget.cpuPct) { console.error(`Worker CPU ${worker.cpuPct}% exceeds ${budget.cpuPct}% while idle`); process.exitCode = 1; }
} finally {
  await stop().catch(() => {}); await counter.close().catch(() => {}); await github?.close().catch(() => {});
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.error(`kept ${root}`);
}
