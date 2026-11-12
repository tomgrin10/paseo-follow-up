// Poll cost: what Follow-up's PR polling costs per minute, in an isolated harness daemon.
//
// Starts an isolated Paseo daemon (never the user's) with W synthetic workspaces holding N tracked PRs across R
// repositories (stacked, a few with pending checks), and a fake GitHub: an HTTP server for in-process reads and a
// `gh` shim first on PATH that counts every spawn. It installs the plugin, waits one warm-up minute, then measures
// gh spawns, HTTP requests and the worker's CPU over a window. Run it on two builds at the same N for before/after:
//
//   node scripts/poll-cost.mjs [--prs 30] [--workspaces 10] [--repos 3] [--pending 3] [--merged 0] [--closed 0] [--deploy-merged 0] [--minutes 3] [--plugin <dir>] [--cpu-prof <dir>] [--json]
//
// --pending K keeps K PRs (one per repository first) with checks in progress. --cpu-prof writes the worker's V8 CPU profile (node --cpu-prof) for the window. Run under the harness-slot wrapper.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createNet } from "node:net";
import { createServer } from "node:http";
import { openSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";

const exec = promisify(execFile);
await harness();
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg("prs", "30")); const W = Number(arg("workspaces", "10")); const R = Number(arg("repos", "3")); const MINUTES = Number(arg("minutes", "3"));
const PENDING = Number(arg("pending", String(Math.max(1, Math.round(N / 10))))); const MERGED = Number(arg("merged", "0")); const CLOSED = Number(arg("closed", "0")); const profileDir = arg("cpu-prof", null);
// Merged PRs in the deployment repository (acme/acme-poc): each needs a fleet read (gcloud), the serving image's
// commit (registry) and one ancestry compare per (merge, serving commit). 2026-11-12: those compares still spawned gh.
const DEPLOY_MERGED = Number(arg("deploy-merged", "0"));
const root = await mkdtemp(join(tmpdir(), "follow-poll-cost-"));
const home = join(root, "home"); const fixture = join(root, "fixture"); const bin = join(root, "bin"); let plugin = arg("plugin", null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = async () => { const s = createNet(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

// The fake GitHub. One PR row per tracked PR; PENDING of them keep checks in progress.
const repos = Array.from({ length: R }, (_, i) => `example-${i}/app`);
const rows = new Map();
for (let i = 0; i < N; i++) { const repo = repos[i % R]; const number = 100 + i; rows.set(`${repo}#${number}`, { repo, number, base: i < R ? "main" : `b${number - R}`, pending: i < PENDING, state: i >= N - MERGED ? "MERGED" : i >= N - MERGED - CLOSED ? "CLOSED" : "OPEN" }); }
for (let i = 0; i < DEPLOY_MERGED; i++) { const repo = "acme/acme-poc"; const number = 5000 + i; rows.set(`${repo}#${number}`, { repo, number, base: "main", pending: false, state: "MERGED", merge: i.toString(16).padStart(40, "d") }); }
const counts = { points: 0, graphql: 0, rest: 0, ghSpawns: 0, gcloudSpawns: 0, compares: 0 };
const prNode = (repo, number) => {
  const row = rows.get(`${repo}#${number}`); if (!row) return null;
  return { number, title: `Synthetic PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, state: row.state, headRefOid: `head${number}`, headRefName: `b${number}`, baseRefName: row.base, isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", mergedAt: row.state === "MERGED" ? "2026-11-01T00:00:00Z" : null, mergeCommit: row.state === "MERGED" ? { oid: row.merge ?? "a".repeat(40) } : null, isInMergeQueue: false, autoMergeRequest: null, author: { login: "developer" },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [{ requestedReviewer: { __typename: "User", login: "reviewer" } }] },
    latestReviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "COMMENTED", author: { __typename: "User", login: "reviewer" } }] },
    baseRef: { branchProtectionRule: null, rules: { pageInfo: { hasNextPage: false }, nodes: [] }, associatedPullRequests: { nodes: row.base === "main" ? [] : [{ number: number - R, headRefName: row.base, state: "OPEN", headRepository: { nameWithOwner: repo } }] } },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: 3 }, (_, k) => ({ id: `t${number}-${k}`, isResolved: k > 0, comments: { nodes: [{ updatedAt: "2026-11-01T00:00:00Z" }] } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: ["build", "test", "lint", "e2e"].map(name => ({ name, status: row.pending && name === "e2e" ? "IN_PROGRESS" : "COMPLETED", conclusion: row.pending && name === "e2e" ? null : "SUCCESS" })) } } } }] } };
};
const graphql = (query, variables) => {
  counts.graphql++;
  const repo = `${variables.owner}/${variables.name}`;
  const repository = { defaultBranchRef: { name: "main", branchProtectionRule: { requiredStatusCheckContexts: ["build"] }, rules: { pageInfo: { hasNextPage: false }, nodes: [{ type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { enforcement: "ACTIVE" }, parameters: { requiredStatusChecks: [{ context: "test" }] } }] } },
    squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH", mergeQueue: null };
  let cost = 0;
  for (const [, alias, number] of query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) { repository[alias] = prNode(repo, Number(number)); cost++; }
  // GitHub charges this query shape ~1 point per PR (measured with rateLimit(dryRun:true): 15 PRs = 16 points).
  counts.points += Math.max(1, cost);
  return { data: { rateLimit: { cost: Math.max(1, cost), remaining: 4000, resetAt: new Date(Date.now() + 3_600_000).toISOString() }, repository } };
};
const answer = (method, path, body) => {
  if (method === "POST" && path === "/graphql") { const { query, variables } = JSON.parse(body); return graphql(query, variables); }
  if (/\/compare\//.test(path)) { counts.compares++; return { status: "ahead" }; }
  if (/\/rules\/branches\//.test(path)) { counts.rest++; return [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]; }
  counts.rest++; return [];
};
const apiPort = await free();
const api = createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__spawn") { counts[url.searchParams.get("kind") === "gcloud" ? "gcloudSpawns" : "ghSpawns"]++; res.end("{}"); return; }
  // The fake Artifact Registry: the serving image's config names the serving commit.
  if (url.pathname.startsWith("/v2/")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(url.pathname.includes("/manifests/") ? { config: { digest: `sha256:${"3".repeat(64)}` } } : { config: { Labels: { "org.opencontainers.image.revision": "b".repeat(40) } } })); return; }
  if (url.pathname === "/__shim") { const { args } = JSON.parse(body); res.end(JSON.stringify(shim(args))); return; }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer(req.method, url.pathname, body)));
}); });
// What the gh CLI would print for a read: `api graphql -f k=v... -f query=...` or `api <path>`.
const shim = args => {
  if (args[0] === "auth") return "fake-token";
  if (args[0] === "api" && args[1] === "graphql") { const vars = {}; for (let i = 2; i < args.length; i++) if (args[i] === "-f") { const [k, ...v] = args[++i].split("="); vars[k] = v.join("="); } const { query, ...variables } = vars; return graphql(query, variables); }
  if (args[0] === "api") return answer("GET", `/${args[1]}`, "");
  return {};
};
await new Promise(r => api.listen(apiPort, "127.0.0.1", r));

const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const env = harnessEnv(root, { home, set: { PATH: `${bin}:${process.env.PATH}`, PASEO_RELAY_ENABLED: "false", GH_TOKEN: "fake-token", FOLLOW_UP_GITHUB_API: `http://127.0.0.1:${apiPort}`, FOLLOW_UP_DEPLOY_REGISTRY: `http://127.0.0.1:${apiPort}`, POLL_COST_API: `http://127.0.0.1:${apiPort}`, ...(profileDir ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${profileDir}` } : {}) } });
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env: { ...env, NODE_OPTIONS: "" }, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;
try {
  await mkdir(home, { recursive: true }); await mkdir(fixture, { recursive: true }); await mkdir(bin, { recursive: true });
  if (profileDir) await mkdir(profileDir, { recursive: true });
  // gh and gcloud shims: count the spawn, answer from the fake. Plain node, no shell. gcloud answers the production
  // fleet: five ready services, one revision each, all serving the image whose commit is "b"×40.
  const gcloudSource = "x";
  const fleet = ["backend", "etl", "interpretation", "public-api", "web"].map(role => ({ metadata: { name: `acme-service-app-${role}-x`, labels: { "cloud.googleapis.com/location": "us-central1" } }, status: { conditions: [{ type: "Ready", status: "True" }], traffic: [{ revisionName: `${role}-r1`, percent: 100 }] } }));
  const revision = { spec: { containers: [{ name: "app", image: `us-central1-docker.pkg.dev/acme-prod/acme-docker/prod-app-backend@sha256:${"1".repeat(64)}` }] }, status: { conditions: [{ type: "Ready", status: "True" }] } };
  const shimSource = kind => `#!/usr/bin/env node
const base = process.env.POLL_COST_API; const args = process.argv.slice(2);
const gcloud = a => a[0] === "auth" ? "registry-token" : a[1] === "services" ? ${JSON.stringify(JSON.stringify(fleet))} : ${JSON.stringify(JSON.stringify(revision))};
(async () => { await fetch(base + "/__spawn?kind=${kind}");
  if (${JSON.stringify(kind)} === "gcloud") { process.stdout.write(${JSON.stringify(gcloudSource)}[0] ? gcloud(args) : "[]"); return; }
  const r = await fetch(base + "/__shim", { method: "POST", body: JSON.stringify({ args }) }); const text = await r.text();
  process.stdout.write(typeof JSON.parse(text) === "string" ? JSON.parse(text) : text); })();
`;
  for (const kind of ["gh", "gcloud"]) { await writeFile(join(bin, kind), shimSource(kind)); await chmod(join(bin, kind), 0o755); }
  await writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false }, browserTools: { enabled: false } } }));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  if (!plugin) {
    plugin = join(root, "plugin"); await mkdir(plugin);
    const packed = JSON.parse((await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
    await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  }
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; i < 120; i++) { try { await cli("workspace", "ls"); break; } catch { if (daemon.exitCode !== null || i === 119) throw new Error("isolated daemon did not start"); await sleep(250); } }
  client = new DaemonClient({ url, clientId: "follow-poll-cost", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  await cli("plugin", "install", fixture);
  const paseo = createPaseoApi(client);
  const created = [];
  for (let i = 0; i < W; i++) {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await paseo.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    const a = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic agent ${i}` });
    await client.sendMessage(a.id, `Synthetic task ${i}`, { messageId: `poll-${i}` });
    created.push({ workspaceId: w.id, agentId: a.id });
  }
  await sleep(3_000);
  const now = new Date().toISOString(); const keys = [...rows.keys()];
  await mkdir(join(home, "plugin-data/follow-up"), { recursive: true });
  await writeFile(join(home, "plugin-data/follow-up/state.json"), JSON.stringify({ version: 1, migrations: ["follow-every-1"], workspaces: created.map(({ workspaceId, agentId }, i) => ({
    id: workspaceId, title: `Synthetic workspace ${i}`, goal: "Synthetic", mainAgentId: agentId, enable_tracking: true, enable_auto_sends: false, hold: null, archived: false,
    prs: keys.filter((_, k) => k % W === i).map(key => { const r = rows.get(key); return { key, repo: r.repo, number: r.number, stack: `Stack ${i}`, parent: null, disposition: null, snapshot: null, error: null }; }),
    obligations: [], batches: [], completion: null, updatedAt: now, managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false, inventory: null })) }));
  await cli("plugin", "install", plugin);
  await sleep(60_000); // warm-up: first reads, discovery, settling
  const pid = Number((await readFile(join(home, "plugin-data/follow-up/worker.lock"), "utf8").catch(() => "")).split(":")[0]);
  const ticks = async () => { const f = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
  const hz = Number((await exec("getconf", ["CLK_TCK"])).stdout.trim()) || 100;
  const start = { ...counts, cpu: await ticks(), at: Date.now() };
  // Store writes in the window (store-writes-only-real-changes): each atomic rename gives the file a new inode.
  const files = { "state.json": 0, "inbox.json": 0 }; const seen = {};
  const watch = setInterval(async () => { for (const f of Object.keys(files)) { const s = await stat(join(home, "plugin-data/follow-up", f)).catch(() => null); const k = s ? `${s.ino}:${s.mtimeMs}` : null; if (k && seen[f] && seen[f] !== k) files[f]++; if (k) seen[f] = k; } }, 200);
  await sleep(MINUTES * 60_000);
  clearInterval(watch);
  const minutes = (Date.now() - start.at) / 60_000;
  const rate = k => Math.round((counts[k] - start[k]) / minutes * 10) / 10;
  const state = JSON.parse(await readFile(join(home, "plugin-data/follow-up/state.json"), "utf8"));
  const observed = state.workspaces.flatMap(w => w.prs).filter(p => p.snapshot && !p.error).length;
  const result = { prs: N, workspaces: W, repos: R, runningChecks: PENDING, merged: MERGED, closed: CLOSED, deployMerged: DEPLOY_MERGED, minutes: Math.round(minutes * 10) / 10, observedPrs: observed,
    perMinute: { ghSpawns: rate("ghSpawns"), processesViaWrapper: Math.round(rate("ghSpawns") * 3 * 10) / 10, gcloudSpawns: rate("gcloudSpawns"), graphqlRequests: rate("graphql"), restRequests: rate("rest"), compares: rate("compares"), graphqlPointsPerHour: Math.round(rate("points") * 60) },
    // The warm-up minute: a cold start's reads (the deploy probe's compares land here).
    warmup: { ghSpawns: start.ghSpawns, gcloudSpawns: start.gcloudSpawns, compares: start.compares },
    storeWritesPerMinute: Object.fromEntries(Object.entries(files).map(([f, n]) => [f, Math.round(n / ((Date.now() - start.at) / 60_000) * 10) / 10])),
    workerCpuPct: Math.round(((await ticks()) - start.cpu) / hz / (minutes * 60) * 1000) / 10 };
  console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
  if (observed < N) { console.error(`only ${observed} of ${N} PRs observed`); process.exitCode = 1; }
} finally {
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  api.close();
  if (profileDir) console.error(`cpu profiles: ${(await readdir(profileDir).catch(() => [])).join(", ")}`);
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true }).catch(() => {}); else console.error(`kept ${root}`);
}
