// Scale check: does Follow-up wake dormant agents?
//
// Starts an isolated Paseo daemon (never the user's), creates N synthetic workspaces with one fixture agent each,
// ages their last user message past the active window and restarts the daemon so every agent is unloaded, then
// wakes a few on purpose. It then installs Follow-up with every workspace tracked and auto-send on (the 1.3.0-beta.2
// blast radius) and counts loaded agents before and after three poll cycles.
//
//   node scripts/scale-check.mjs [--workspaces 120] [--awake 5] [--realistic] [--plugin <unpacked plugin dir>] [--json]
//   node scripts/scale-check.mjs --data-from <copied plugin-data/follow-up dir> [--idle 1800] ...   (local only)
//
// --data-from starts the worker on a copy of a real data directory, remapped onto the harness's workspaces and agents
// (scripts/scale-data-from.mjs), so a live install's memory can be reproduced at its exact size. It implies
// --realistic's fake GitHub and sets --workspaces to the copy's count. The copy holds real names: never in CI or a PR.
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
import { ACK_READ_MS, BUSY_GROWTH_BUDGET_MB, BUSY_ITEM_BYTES, BUSY_TURN_ITEMS, BUSY_TURNS_PER_MIN, busyVerdict, idleBudgetMb, idleVerdict, SEND_SETTLE_MS, settleBoundMs, settleState } from "./scale-budget.mjs";

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
/** Seeds each workspace with this many never-sent cancelled batches, like the VM's 1.3.0-beta.2 state. */
// --live-sized: --realistic plus the live install's outliers (scripts/scale-seed.ts BIG_*: one 153-PR workspace and a
// live-shaped inbox.json), the seed test:scale:live runs its busy window on.
const LIVE_SIZED = process.argv.includes("--live-sized");
// --budgets-report-only: the RSS, CPU and request budgets are printed as "[report]" lines instead of failing. Only
// test:scale:live uses it, until its derived budgets land; dormant wakes and unsettled sends still fail.
const REPORT_ONLY = process.argv.includes("--budgets-report-only");
const over = message => { console.error(REPORT_ONLY ? `[report] ${message}` : message); if (!REPORT_ONLY) process.exitCode = 1; };
const CHURN = Number(arg("churn", "0")); const DATA_FROM = arg("data-from", null); const REALISTIC = process.argv.includes("--realistic") || LIVE_SIZED || !!DATA_FROM;
const { liveShape, copyLive } = DATA_FROM ? await import("./scale-data-from.mjs") : {};
const shape = DATA_FROM ? await liveShape(DATA_FROM) : null;
const N = shape ? shape.workspaces.length : Number(arg("workspaces", "120")); const AWAKE = Number(arg("awake", "5")); const POLLS = 3; const POLL_MS = 15_000;
/** Agents per workspace: live has ~300 listed agents at 141 workspaces, so --realistic makes two. */
const PER = Number(arg("agents-per-workspace", REALISTIC ? "2" : "1")); const IDLE_MS = Number(arg("idle", "30")) * 1000;
const budget = { busyGrowthMb: Number(arg("busy-growth-budget", String(BUSY_GROWTH_BUDGET_MB))), idleRssMb: idleBudgetMb(arg("idle-rss-budget", "0")), rssMb: Number(arg("rss-budget", "0")), cpuPct: Number(arg("cpu-budget", "0")), requestsPerMin: Number(arg("request-budget", "0")) };
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
// --request-trace <file>: every daemon call the worker makes, with the worker frames that made it (server/request-trace.ts,
// FOLLOW_UP_REQUEST_TRACE), so request budgets' misses name their code (scripts/request-top.mjs; worker.idleWindow bounds it).
const traceFile = arg("request-trace", null);
// --realistic also answers GitHub reads with live-sized PR bodies (scripts/scale-github.mjs), so a cold start reads
// every PR the way the live worker does.
let github = null;
if (REALISTIC) { await mkdir(join(root, "bin"), { recursive: true }); await writeFile(join(root, "bin/gh"), scaleGh()); const { chmod } = await import("node:fs/promises"); await chmod(join(root, "bin/gh"), 0o700); if (shape) { await writeFile(join(root, "pr-states.json"), JSON.stringify(shape.prStates)); process.env.SCALE_GH_STATES = join(root, "pr-states.json"); }
  github = await fakeGithub({ dir: root, gh: join(root, "bin/gh"), owners: shape ? shape.owners : ["example"], gzip: process.argv.includes("--gh-gzip") }); }
const env = harnessEnv(root, { home, strip: github?.strip ?? [], set: { ...(traceFile ? { FOLLOW_UP_REQUEST_TRACE: traceFile } : {}), ...(heapDir || cpuDir || allocDir ? { NODE_OPTIONS: [heapDir && `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=${heapDir}`, cpuDir && `--cpu-prof --cpu-prof-dir=${cpuDir}`, allocDir && `--require ${join(dirname(fileURLToPath(import.meta.url)), "alloc-prof.cjs")}`].filter(Boolean).join(" ") } : {}), ...(allocDir ? { FOLLOW_UP_ALLOC_PROF: allocDir, ...(process.env.FOLLOW_UP_ALLOC_PROF_WINDOWS ? { FOLLOW_UP_ALLOC_PROF_WINDOWS: process.env.FOLLOW_UP_ALLOC_PROF_WINDOWS } : {}) } : {}), PASEO_DAEMON_URL: counted, PASEO_RELAY_ENABLED: "false", ...(github?.env ?? {}) } });
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
    const a = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default", providerOptions: { fixture_ack: "repairs" } }, title: `Synthetic agent ${i}` });
    await client.sendMessage(a.id, `Synthetic task ${i}: ship https://github.com/example/app/pull/${i + 1}`, { messageId: `scale-${i}` });
    const agentIds = [a.id];
    for (let k = 1; k < (shape ? shape.workspaces[i].agents.length : PER); k++) agentIds.push((await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic helper ${i}.${k}` })).id);
    created.push({ workspaceId: w.id, agentId: a.id, agentIds });
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
  if (DATA_FROM) console.error(`data-from: ${JSON.stringify({ ...(await copyLive(DATA_FROM, join(home, "plugin-data/follow-up"), shape, created)), workspaces: N, prs: shape.prs })}`);
  else if (REALISTIC) {
    await writeFile(join(root, "created.json"), JSON.stringify(created));
    // --awake-fresh: the awake workspaces carry no batch history, so they send under any version's rules (a fair
    // send-load baseline for a main build that would otherwise block them).
    await exec("npx", ["tsx", "scripts/scale-seed.ts", join(home, "plugin-data/follow-up/state.json"), join(root, "created.json"), "3", process.argv.includes("--awake-fresh") ? String(AWAKE) : "0", ...(LIVE_SIZED ? [join(home, "plugin-data/follow-up/inbox.json"), "--live-sized"] : [])], { timeout: 120_000 });
  }
  const stateBytesBefore = (await readFile(join(home, "plugin-data/follow-up/state.json"))).length;
  const before = loaded(await agents());
  await cli("plugin", "install", plugin);
  // From install on: the worker's RSS every 250 ms (steps over 10 MB, with when) and V8's heap every 5 s, so a
  // transient spike (V8 grows the heap, RSS keeps the high-water mark) shows when it happens. trace.memory splits each 5 s
  // sample into heap, external and native (RSS minus both), the breakdown at the idle median and the peak, with RSS
  // split into anonymous and file-backed (/proc/<pid>/status RssAnon, RssFile).
  const installedAt = Date.now(); const sendPhaseRequests = counter.snapshot(); const trace = { steps: [], memory: [], peakHeapTotalMb: 0, peakHeapUsedMb: 0, peakRssMb: 0, workerAt: 0 }; let tracing = true;
  const tracer = (async () => {
    let wpid = 0, last = 0, lastUsage = 0;
    while (tracing) {
      if (!wpid) { wpid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]) || 0; if (wpid) trace.workerAt = Date.now(); }
      if (wpid) {
        const status = await readFile(`/proc/${wpid}/status`, "utf8").catch(() => "");
        const now = Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
        const kb = name => Math.round(Number(new RegExp(`${name}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) / 1024);
        if (now && Math.abs(now - last) > 10) { trace.steps.push({ s: Math.round((Date.now() - installedAt) / 100) / 10, at: new Date().toISOString(), rssMb: now }); last = now; }
        trace.peakRssMb = Math.max(trace.peakRssMb, now);
        if (Date.now() - lastUsage > 5000) { lastUsage = Date.now(); const w = await client?.invokePluginRpc("follow-up", "follow.usage", {}).then(u => u?.resources?.worker, () => null); if (w) { trace.memory.push({ s: Math.round((Date.now() - installedAt) / 1000), rssMb: now, heapUsedMb: w.heapUsedMb, heapTotalMb: w.heapTotalMb, externalMb: w.externalMb, nativeMb: Math.round(now - (w.heapTotalMb ?? 0) - (w.externalMb ?? 0)), anonMb: kb("RssAnon"), fileMb: kb("RssFile") }); trace.peakHeapTotalMb = Math.max(trace.peakHeapTotalMb, w.heapTotalMb ?? 0); trace.peakHeapUsedMb = Math.max(trace.peakHeapUsedMb, w.heapUsedMb ?? 0); } }
      }
      await sleep(250);
    }
  })();
  const samples = [];
  for (let poll = 1; poll <= POLLS; poll++) { await sleep(POLL_MS); samples.push(loaded(await agents())); }
  await sleep(5_000);
  const after = loaded(await agents());
  // The idle window measures the steady state, so Follow-up's own sends settle first (2026-11-12, Q49): the realistic
  // seed's history once tripped the retired 3-strike rule, which blocked every awake workspace's next message, so idle
  // looked quiet by accident. Under the per-task cap a loaded, idle agent gets each lingering condition at most twice,
  // then it caps.
  // Quiet: nothing in flight, no queued message still in its settle window, and no acknowledged message whose PR GitHub
  // hasn't been read since (that read decides whether the condition goes out again; the worker reads an open PR at least
  // once a minute, so this waits at most 2 min after an acknowledgment). Bounded: a send loop that never
  // settles fails here instead of passing by never starting the idle window.
  const stateFile = join(home, "plugin-data/follow-up/state.json"); const receiptsFile = join(home, "fixture-receipts.jsonl");
  const sendsSoFar = async () => (await readFile(receiptsFile, "utf8").catch(() => "")).split("\n").filter(l => /Follow-up batch/.test(l)).length;
  const repair = t => ["conflict", "review", "checks", "restack"].includes(t.kind);
  const open = (st, now) => st.workspaces.flatMap(w => w.batches.filter(b => !b.tasks.some(t => t.kind === "inventory") && (
    ["sending", "sent", "uncertain"].includes(b.state)
    || b.state === "pending" && now - Date.parse(b.createdAt) < SEND_SETTLE_MS + 15_000
    || b.state === "completed" && !b.unacknowledged && b.settledAt && Date.parse(b.settledAt) > installedAt && now - Date.parse(b.settledAt) < ACK_READ_MS && b.tasks.some(t => repair(t) && !((Date.parse(w.prs.find(p => p.key === t.target)?.snapshot?.observedAt ?? "") || 0) > Date.parse(b.settledAt)))
  )).map(b => `${w.title}: ${b.state} [${b.tasks.map(t => t.key).join(", ")}]`));
  const lockPid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  const hzSend = Number((await exec("getconf", ["CLK_TCK"])).stdout.trim()) || 100;
  const cpuTicks = async () => { const f = (await readFile(`/proc/${lockPid}/stat`, "utf8")).split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
  // Bounded by the seed's send schedule plus a margin (scripts/scale-budget.mjs), from when the worker loaded the seed.
  const SETTLE_BOUND_MS = arg("settle-timeout", null) ? Number(arg("settle-timeout")) * 1000 : settleBoundMs();
  const seedLoadedAt = () => trace.workerAt || installedAt;
  const settleTicks = []; let still = []; let settle = { settled: false, expired: false }; let peakCpu = 0; let lastTicks = lockPid > 0 ? await cpuTicks() : 0; let lastAt = Date.now();
  while (!settle.settled && !settle.expired) {
    await sleep(5_000);
    if (lockPid > 0) { const t = await cpuTicks().catch(() => lastTicks); peakCpu = Math.max(peakCpu, Math.round((t - lastTicks) / hzSend / ((Date.now() - lastAt) / 1000) * 1000) / 10); lastTicks = t; lastAt = Date.now(); }
    still = open(JSON.parse(await readFile(stateFile, "utf8").catch(() => "{\"workspaces\":[]}")), Date.now());
    settleTicks.push({ atMs: Date.now() - seedLoadedAt(), open: still.length, first: still[0] ?? null });
    settle = settleState(settleTicks, SETTLE_BOUND_MS);
  }
  const settledState = JSON.parse(await readFile(stateFile, "utf8"));
  const runBatches = settledState.workspaces.flatMap(w => w.batches.filter(b => b.sentAt && Date.parse(b.sentAt) > installedAt && !b.tasks.some(t => t.kind === "inventory")));
  const sendPhase = { seconds: Math.round((Date.now() - installedAt) / 1000), sends: await sendsSoFar(), acks: runBatches.filter(b => b.state === "completed" && !b.unacknowledged).length,
    unacknowledged: runBatches.filter(b => b.unacknowledged).length, capped: settledState.workspaces.reduce((n, w) => n + (w.heldTasks ?? []).filter(h => h.held === "capped").length, 0),
    requestsPerMin: ratePerMinute(sendPhaseRequests, counter.snapshot(), "follow-up-worker", Date.now() - installedAt), peakCpuPct: peakCpu, settled: settle.settled, boundSeconds: SETTLE_BOUND_MS / 1000, seedLoadedAfterInstallS: Math.round((seedLoadedAt() - installedAt) / 1000),
    ticks: settleTicks.map(t => ({ s: Math.round(t.atMs / 1000), open: t.open, ...(t.first ? { first: t.first } : {}) })),
    batches: runBatches.map(b => ({ state: b.state, tasks: b.tasks.map(t => t.kind), created: Math.round((Date.parse(b.createdAt) - installedAt) / 1000), sent: Math.round((Date.parse(b.sentAt) - installedAt) / 1000), settled: b.settledAt ? Math.round((Date.parse(b.settledAt) - installedAt) / 1000) : null })) };
  if (!sendPhase.settled) { console.error(`Follow-up's sends didn't settle within ${SETTLE_BOUND_MS / 1000} s of the worker loading the seed; open: ${still.slice(0, 10).join("; ")}`); process.exitCode = 1; }
  // The worker: its pid is in the lock it holds. RSS now, CPU and state.json writes over an idle window.
  const pid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  const ticks = async () => { const f = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
  const rss = async (field = "VmRSS") => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(await readFile(`/proc/${pid}/status`, "utf8"))[1]) / 1024;
  let worker = null;
  if (pid > 0) {
    const { stdout } = await exec("getconf", ["CLK_TCK"]); const hz = Number(stdout.trim()) || 100;
    const { statSync } = await import("node:fs"); const statePath = join(home, "plugin-data/follow-up/state.json");
    let writes = 0; let mtime = statSync(statePath).mtimeMs;
    // --busy <s>: live's busy load first (scripts/scale-budget.mjs BUSY_*): awake agents end turns with live-sized
    // timelines. Judged on growth across the window; the idle window after it then judges the median it settles at.
    const BUSY_MS = Number(arg("busy", "0")) * 1000; const busySamples = []; let busyTurns = 0;
    if (BUSY_MS > 0) {
      const from = Date.now(); let nextBusy = from;
      while (Date.now() - from < BUSY_MS) {
        await sleep(500); busySamples.push(await rss());
        while (nextBusy <= Date.now()) { nextBusy += 60_000 / BUSY_TURNS_PER_MIN; const a = created[busyTurns++ % Math.max(1, AWAKE)].agentId; void client.sendMessage(a, `Fixture: busy turn ${BUSY_TURN_ITEMS} ${BUSY_ITEM_BYTES}`, { messageId: `busy-${busyTurns}` }).catch(() => undefined); }
      }
    }
    const t0 = await ticks(); const started = Date.now(); const requestsBefore = counter.snapshot();
    const idleSamples = [await rss()];
    // --live-mix <turns/min>,<rpcs/min>: the idle window carries live's load instead of none: awake agents end turns
    // with live-sized timelines (turn hooks read their tails) and an app reads the usual RPCs. Compare with a plain run.
    const mix = arg("live-mix", null)?.split(",").map(Number) ?? null; let nextTurn = Date.now(), nextRpc = Date.now(), turnN = 0, rpcN = 0;
    const MIX_RPCS = [["follow.list", {}], ["follow.inbox-list", {}], ["follow.usage", {}], ["follow.workspace-about", { workspaceId: created[0].workspaceId }]];
    // --app-burst <rpcs/s>,<seconds>: an open app's reads (beta.4's Home and panel poll; live 2026-11-13 06:53: ~250
    // plugin RPCs in 2 min), starting 60 s into the idle window, so the step it leaves in RSS shows against the
    // window's first minute. Each method's reply size is reported (appBurst).
    const burst = arg("app-burst", null)?.split(",").map(Number) ?? null; const burstAt = started + 60_000; let nextBurst = burstAt, burstN = 0;
    const bigWs = shape ? created[shape.workspaces.reduce((m, w, i, all) => all[m].agents.length >= w.agents.length ? m : i, 0)]?.workspaceId : created[0].workspaceId;
    const BURST_RPCS = [["follow.list", () => ({})], ["follow.inbox-list", () => ({})], ["follow.get", () => ({ workspaceId: bigWs })], ["follow.workspace-about", k => ({ workspaceId: created[k % created.length].workspaceId })],
      ["follow.priorities", () => ({})], ["follow.rank-status", () => ({})], ["follow.usage", () => ({})], ["follow.inbox-brief", k => ({ agentId: created[k % created.length].agentId })]];
    const appBurst = burst ? { perSecond: burst[0], seconds: burst[1], startSample: 0, endSample: 0, calls: 0, failed: 0, bytes: {} } : null;
    while (Date.now() - started < IDLE_MS) {
      await sleep(500); idleSamples.push(await rss());
      if (appBurst && Date.now() >= nextBurst && Date.now() < burstAt + burst[1] * 1000) {
        if (!appBurst.startSample) appBurst.startSample = idleSamples.length;
        appBurst.endSample = idleSamples.length;
        while (nextBurst <= Date.now()) {
          nextBurst += 1000 / burst[0]; const k = burstN++; const [m, input] = BURST_RPCS[k % BURST_RPCS.length]; appBurst.calls++;
          void client.invokePluginRpc("follow-up", m, input(Math.floor(k / BURST_RPCS.length))).then(out => { const b = appBurst.bytes[m] ??= { calls: 0, maxBytes: 0, totalBytes: 0 }; const n = JSON.stringify(out ?? null).length; b.calls++; b.maxBytes = Math.max(b.maxBytes, n); b.totalBytes += n; }, () => { appBurst.failed++; });
        }
      }
      if (mix && mix[0] && Date.now() >= nextTurn) { nextTurn += 60_000 / mix[0]; const a = created[turnN++ % Math.max(1, AWAKE)].agentId; void client.sendMessage(a, "Fixture: busy turn 30 8000", { messageId: `mix-${turnN}` }).catch(() => undefined); }
      if (mix && mix[1] && Date.now() >= nextRpc) { nextRpc += 60_000 / mix[1]; const [m, input] = MIX_RPCS[rpcN++ % MIX_RPCS.length]; void client.invokePluginRpc("follow-up", m, input).catch(() => undefined); } const m = statSync(statePath).mtimeMs; if (m !== mtime) { writes++; mtime = m; } }
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
    worker = { pid, idleWindow: { from: started, to: Date.now() }, memory: memoryIdle, memoryAfterGc, hostPluginBaselineMb: hostRss.length ? Math.min(...hostRss) : null, rssMb: Math.round(await rss()), idleMedianRssMb: idleVerdict(idleSamples, 0).medianMb, idlePeakRssMb: idleVerdict(idleSamples, 0).peakMb, idleSamplesMb: idleSamples.map(Math.round), lifetimePeakRssMb: Math.round(await rss("VmHWM")), cpuPct, idleSeconds: IDLE_MS / 1000, ...(BUSY_MS > 0 ? { busy: { seconds: BUSY_MS / 1000, turns: busyTurns, ...busyVerdict(busySamples, 0), samplesMb: busySamples.map(Math.round) } } : {}), ...(appBurst ? { appBurst: { ...appBurst, beforeMedianMb: idleVerdict(idleSamples.slice(0, appBurst.startSample), 0).medianMb, afterMedianMb: idleVerdict(idleSamples.slice(appBurst.endSample + 60), 0).medianMb } } : {}), stateWrites: writes, stateBytesBefore, stateBytesAfter: statSync(statePath).size, daemonRequestsPerMin: requests };
  }
  tracing = false; await tracer;
  if (worker) worker.trace = { ...trace, githubRequests: github?.requests.length ?? 0 };
  const receipts = (await readFile(join(home, "fixture-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(l => /Follow-up (batch|recovery)/.test(l)).length;
  const state = JSON.parse(await readFile(join(home, "plugin-data/follow-up/state.json"), "utf8"));
  const result = { workspaces: N, awakeOnPurpose: AWAKE, loadedBefore: before, loadedPerPoll: samples, loadedAfter: after, followUpSends: receipts, sendPhase, dormant: state.workspaces.filter(w => w.dormant).length, autoSendOn: state.workspaces.filter(w => w.enable_auto_sends).length, parked: state.autoSendsParked?.length ?? 0, worker };
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
  if (after > before) { console.error(`Follow-up loaded ${after - before} dormant agents`); process.exitCode = 1; }
  // The budget is the worker's lifetime peak (VmHWM), start-up tick included: 2026-11-12's spike was over before idle began.
  // The idle budget judges the window's median (a GC sawtooth's one spike decides nothing); the peak is reported.
  if (budget.idleRssMb && worker && idleVerdict(worker.idleSamplesMb, budget.idleRssMb).over) { over(`Worker idle RSS median ${worker.idleMedianRssMb} MB (peak ${worker.idlePeakRssMb}), over ${budget.idleRssMb} MB`); }
  // The busy window's growth (2026-11-13: live stepped 315 → 405 MB under agent turns while an idle check passed).
  if (worker?.busy && budget.busyGrowthMb && busyVerdict(worker.busy.samplesMb, budget.busyGrowthMb).over) { over(`Worker RSS grew ${worker.busy.growthMb} MB across the ${worker.busy.seconds} s busy window (${worker.busy.firstMb} → ${worker.busy.lastMb}), over ${budget.busyGrowthMb} MB`); }
  if (budget.rssMb && worker && worker.lifetimePeakRssMb > budget.rssMb) { over(`Worker RSS peaked at ${worker.lifetimePeakRssMb} MB (idle peak ${worker.idlePeakRssMb}), over ${budget.rssMb} MB`); }
  if (budget.requestsPerMin && worker && worker.daemonRequestsPerMin.total > budget.requestsPerMin) { over(`Worker sent ${worker.daemonRequestsPerMin.total} daemon requests/min while idle, over ${budget.requestsPerMin}: ${JSON.stringify(worker.daemonRequestsPerMin.byType)}`); }
  if (budget.cpuPct && worker && worker.cpuPct > budget.cpuPct) { over(`Worker CPU ${worker.cpuPct}% exceeds ${budget.cpuPct}% while idle`); }
} finally {
  await stop().catch(() => {}); await counter.close().catch(() => {}); await github?.close().catch(() => {});
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.error(`kept ${root}`);
}
