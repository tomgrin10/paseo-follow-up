// Do real agents reach for show_card at the right time, unprompted? A manual live-model check (real Claude and Codex
// agents, real model calls). Starts an isolated Paseo daemon (its own PASEO_HOME, HOME, CLAUDE_CONFIG_DIR and
// CODEX_HOME; never the user's), installs this checkout of Follow-up, and for each scenario × provider × run creates a
// tracked synthetic workspace (a small fictional repo, `example/app`) whose only agent is its main agent, sends one
// short task that never mentions cards or show_card, waits for the agent to settle and scores what it did:
//   used     show_card called (any call) when the scenario should use it; not called when it shouldn't
//   linked   when the agent asked a question: the question's links point at a shown card
//   valid    the first show_card call succeeded (no schema refusal)
//   page     an .html/page file the agent wrote instead (the old habit)
// The guidance agents get is only Follow-up's own: show_card's description and one line of the main agent's
// instructions. Each run also checks that the line reached the agent (its transcript or session file).
//
// Logins, as check-wait and check-agent-guidance: an in-process daemon; Claude runs the real claude CLI reading the
// developer's credentials from its own config dir, read-only (the provider's env, never a copy; a copied login burned
// the refresh token on 2026-11-17), settingSources [] and only Follow-up's installed hooks; its transcripts are moved
// out of that dir after each run. Codex runs with CODEX_HOME set to the harness-only login dir in place
// (~/paseo-harness/logins/codex, made once by harness-codex-login.sh; never the live ~/.codex, never copied), so it
// gets Follow-up's instructions from Paseo but not Follow-up's Codex hooks (those land in the temp CODEX_HOME).
//   HARNESS_PASEO=system ~/paseo-harness/tools/harness-slot node scripts/check-cards-scenarios.mjs \
//     [--providers claude,codex] [--runs 2] [--only decision,yesno] [--parallel 3] [--out <dir>]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { join, resolve, dirname, delimiter } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { deflateSync } from "node:zlib";
import { harness, onShutdown, waitUntil } from "./harness.mjs";
import { realpath } from "node:fs/promises";
import { harnessEnv, applyEnv, harnessConfig, harnessDaemonProviders, assertProviderStubsUnused } from "./harness-env.mjs";

const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const PROVIDERS = arg("--providers", "claude,codex").split(",");
const RUNS = Number(arg("--runs", "2"));
const PARALLEL = Number(arg("--parallel", "3"));
const ONLY = arg("--only") ? new Set(arg("--only").split(",")) : null;
const MODELS = { claude: arg("--claude-model", "opus"), codex: arg("--codex-model", "") };
const out = resolve(arg("--out", join(tmpdir(), `cards-scenarios-${Date.now()}`)));
const REAL = PROVIDERS;
const LINE = "and link the question to it; don't build a separate page";
const exists = path => fs.access(path).then(() => true, () => false);
const liveClaude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const harnessCodexLogin = join(homedir(), "paseo-harness", "logins", "codex");
if (PROVIDERS.includes("claude") && !await exists(join(liveClaude, ".credentials.json"))) { console.error(`refused: no Claude credentials in ${liveClaude}`); process.exit(3); }
if (PROVIDERS.includes("codex") && !await exists(join(harnessCodexLogin, "auth.json"))) { console.error("refused: no harness-only Codex login; run ~/paseo-harness/tools/harness-codex-login.sh once"); process.exit(3); }

// ---------- scenarios ----------
const SCENARIOS = [
  { id: "decision", should: true, question: true, prompt: "I rendered two versions of the new checkout summary: designs/checkout-a.png and designs/checkout-b.png. Which one should we ship?" },
  { id: "benchmark", should: true, prompt: "I rewrote parseRows in src/parse.js; the previous version is in src/parse-old.js. Run bench/bench.mjs on both and tell me whether the rewrite is actually faster." },
  { id: "migration", should: true, prompt: "Migrate the four services in services/ from config.json to config.env (KEY=value lines, keys upper-cased). Do them one at a time and run `node services/check.mjs <name>` after each. I want to follow along as you go." },
  { id: "matrix", should: true, prompt: "Run `node tests/run.mjs` under each combination of FAST_PATH=0/1 and STRICT=0/1 and give me the results for every combination." },
  { id: "findings", should: true, prompt: "Review src/ for security problems before we open the repo. Rank what you find by severity." },
  { id: "page", should: true, question: true, prompt: "Put together something I can look at comparing the three caching options in docs/caching-options.md (cost, latency, effort), with your recommendation, then ask me which one to go with." },
  { id: "yesno", should: false, prompt: "Does src/parse.js export parseRows? Just yes or no." },
  { id: "status", should: false, prompt: "What version is package.json at?" },
  { id: "trivial", should: false, prompt: "Fix the typo \"recieve\" in src/notify.mjs." },
].filter(s => !ONLY || ONLY.has(s.id));

// ---------- fixture repo ----------
function png(width, height, draw) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) { const [r, g, b] = draw(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const inRect = (x, y, [x0, y0, w, h]) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
function mock(rects) { return png(480, 320, (x, y) => { for (const [r, c] of rects) if (inRect(x, y, r)) return c; return [248, 248, 246]; }); }
const GREY = [205, 205, 200], DARK = [60, 60, 66], GREEN = [34, 150, 90], BLUE = [40, 90, 200];
const FILES = {
  "package.json": JSON.stringify({ name: "example-app", version: "3.4.1", type: "module", private: true }, null, 2) + "\n",
  "README.md": "# example/app\n\nAcme's checkout service (fictional fixture).\n",
  "src/parse.mjs": "",
  "src/parse.js": "export function parseRows(text) {\n  const out = [];\n  let start = 0;\n  for (let i = 0; i <= text.length; i++) {\n    if (i === text.length || text.charCodeAt(i) === 10) { if (i > start) out.push(text.slice(start, i).split(',')); start = i + 1; }\n  }\n  return out;\n}\n",
  "src/parse-old.js": "export function parseRows(text) {\n  return text.split(/\\n/).filter(l => l.length).map(l => l.split(',').map(c => c.replace(/^\\s+|\\s+$/g, '')));\n}\n",
  "bench/bench.mjs": "import { parseRows as next } from '../src/parse.js';\nimport { parseRows as old } from '../src/parse-old.js';\nconst rows = Array.from({ length: 20000 }, (_, i) => `${i},acme-${i},${i * 3},ok`).join('\\n');\nconst which = process.argv[2] ?? 'both';\nfor (const [name, fn] of [['old', old], ['new', next]]) {\n  if (which !== 'both' && which !== name) continue;\n  const times = [];\n  for (let r = 0; r < 15; r++) { const t = performance.now(); fn(rows); times.push(performance.now() - t); }\n  times.sort((a, b) => a - b);\n  console.log(`${name}: median ${times[7].toFixed(2)} ms, p90 ${times[13].toFixed(2)} ms, min ${times[0].toFixed(2)} ms (15 runs, 20k rows)`);\n}\n",
  "src/notify.mjs": "// Sends the order receipt.\nexport function notify(user, order) {\n  // Customers recieve this right after payment.\n  return `Hi ${user.name}, your order ${order.id} is confirmed.`;\n}\n",
  "src/db.mjs": "import { execSync } from 'node:child_process';\nexport function findOrder(db, id) {\n  return db.query(`SELECT * FROM orders WHERE id = '${id}'`);\n}\nexport function backup(name) {\n  return execSync(`pg_dump acme > /tmp/${name}.sql`);\n}\n",
  // A fictional key, split so the source carries no key-shaped string (secret scanning); the fixture file gets it whole.
  "src/config.mjs": "export const STRIPE_KEY = 'sk_" + "live_" + "acmeFIXTURE0000fake';\nexport const ADMIN_PASSWORD = 'acme-admin-2024';\nexport const COOKIE = { httpOnly: false, secure: false };\n",
  "src/render.mjs": "export function greeting(req) {\n  return `<h1>Welcome ${req.query.name}</h1>`;\n}\nexport function redirect(req, res) { res.redirect(req.query.next); }\n",
  "src/token.mjs": "export function resetToken() {\n  return Math.random().toString(36).slice(2);\n}\n",
  "services/check.mjs": "import { readFileSync, existsSync } from 'node:fs';\nconst name = process.argv[2];\nconst dir = new URL(`./${name}/`, import.meta.url);\nif (existsSync(new URL('config.json', dir))) { console.error(`${name}: config.json still present`); process.exit(1); }\nconst env = Object.fromEntries(readFileSync(new URL('config.env', dir), 'utf8').trim().split('\\n').map(l => l.split('=')));\nconst want = { api: ['PORT', 'DB_URL'], billing: ['PORT', 'STRIPE_MODE', 'RETRIES'], search: ['PORT', 'INDEX'], worker: ['QUEUE', 'CONCURRENCY'] }[name];\nconst missing = want.filter(k => !(k in env));\nif (missing.length) { console.error(`${name}: missing ${missing.join(', ')}`); process.exit(1); }\nconsole.log(`${name}: ok (${Object.keys(env).length} keys)`);\n",
  "services/api/config.json": JSON.stringify({ port: 8080, db_url: "postgres://localhost/acme" }) + "\n",
  "services/billing/config.json": JSON.stringify({ port: 8081, stripe_mode: "test", retries: 3 }) + "\n",
  "services/search/config.json": JSON.stringify({ port: 8082, index: "orders-v2" }) + "\n",
  "services/worker/config.json": JSON.stringify({ queue: "acme-jobs", concurrency: 4 }) + "\n",
  "tests/run.mjs": "const fast = process.env.FAST_PATH === '1', strict = process.env.STRICT === '1';\nconst cases = ['parses empty', 'parses quoted', 'rejects bad rows', 'keeps order', 'handles CRLF', 'large input'];\nlet failed = 0;\nfor (const c of cases) {\n  const fail = (fast && strict && c === 'handles CRLF') || (strict && c === 'parses quoted') || (fast && c === 'large input' && !strict);\n  console.log(`${fail ? 'FAIL' : 'ok  '} ${c}`); if (fail) failed++;\n}\nconsole.log(`${cases.length - failed}/${cases.length} passed`);\nprocess.exit(failed ? 1 : 0);\n",
  "docs/caching-options.md": "# Caching options for the order API\n\n1. **In-process LRU** (per pod). Cost: none. p95 latency: 4 ms on hit; hit rate ~55% (pods don't share). Effort: 1 day. Invalidation is per pod, so stale reads up to the TTL.\n2. **Redis (managed)**. Cost: ~$180/month. p95 latency: 9 ms on hit; hit rate ~85%. Effort: 4 days (client, failover, invalidation on write).\n3. **CDN edge cache for GET /orders/:id**. Cost: ~$40/month. p95 latency: 25 ms global; hit rate ~70%; needs per-user cache keys. Effort: 3 days, plus auth review.\n",
};
delete FILES["src/parse.mjs"];
async function fixture(dir) {
  for (const [path, text] of Object.entries(FILES)) { await fs.mkdir(join(dir, path, ".."), { recursive: true }); await fs.writeFile(join(dir, path), text); }
  await fs.mkdir(join(dir, "designs"), { recursive: true });
  // A: one dense column, a small grey total and a full-width green button. B: two columns, a big total and a blue button.
  await fs.writeFile(join(dir, "designs/checkout-a.png"), mock([[[20, 20, 440, 18], DARK], [[20, 50, 300, 10], GREY], [[20, 68, 300, 10], GREY], [[20, 86, 300, 10], GREY], [[20, 104, 300, 10], GREY], [[340, 120, 120, 12], GREY], [[20, 250, 440, 46], GREEN]]));
  await fs.writeFile(join(dir, "designs/checkout-b.png"), mock([[[20, 20, 220, 18], DARK], [[20, 56, 200, 10], GREY], [[20, 74, 200, 10], GREY], [[20, 92, 200, 10], GREY], [[260, 50, 200, 120], [236, 236, 232]], [[280, 70, 160, 30], DARK], [[280, 120, 160, 36], BLUE]]));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["-c", "user.name=Alice Example", "-c", "user.email=alice@example.com", "add", "-A"], { cwd: dir });
  await exec("git", ["-c", "user.name=Alice Example", "-c", "user.email=alice@example.com", "commit", "-q", "-m", "Initial fixture"], { cwd: dir });
}

// ---------- daemon ----------
await harness();
let cli;
for (const directory of (process.env.PATH ?? "").split(delimiter)) { try { cli = await realpath(join(directory, "paseo")); break; } catch {} }
if (!cli) throw new Error("The installed Paseo CLI is required");
const requireInstalled = createRequire(cli);
const load = async name => import(pathToFileURL(requireInstalled.resolve(name)).href);
const { createPaseoDaemon } = await load("@getpaseo/server");
const { BUILTIN_PROVIDER_IDS } = await load("@getpaseo/protocol/provider-manifest");
const { DaemonClient } = await load("@getpaseo/client/internal/daemon-client");
const { createPaseoApi } = await load("@getpaseo/client");
const serverRoot = dirname(requireInstalled.resolve("@getpaseo/server"));
const { ClaudeAgentClient } = await import(pathToFileURL(join(serverRoot, "agent/providers/claude/agent.js")).href);
const { query } = await load("@anthropic-ai/claude-agent-sdk");
const { default: pino } = await load("pino");
const paseoVersion = (await exec("paseo", ["--version"], { timeout: 30000 })).stdout.trim();

const root = await fs.mkdtemp(join(tmpdir(), "follow-cards-scenarios-"));
const home = join(root, "paseo"); const userHome = join(root, "user"); const plugin = join(root, "plugin");
await Promise.all([home, userHome, plugin, out].map(p => fs.mkdir(p, { recursive: true })));
const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
const url = `ws://127.0.0.1:${port}/ws`;
const log = (...a) => console.log(`[cards-scenarios ${new Date().toISOString().slice(11, 19)}]`, ...a);
const original = { ...process.env };
const launches = new Map();
let daemon; let client;
onShutdown(async () => { await client?.close().catch(() => {}); await daemon?.stop().catch(() => {}); });
const report = { versions: {}, runs: [] };

try {
  applyEnv(harnessEnv(root, { home: userHome, paseoHome: home, set: { PASEO_DAEMON_URL: url, DISABLE_AUTOUPDATER: "1" }, real: REAL }));
  const env = process.env;
  await fs.writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, mcp: true, real: REAL, extra: { plugins: { "follow-up": { source: "directory", path: plugin, enabled: true } } } })));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 120_000, maxBuffer: 1 << 22 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  report.versions = {
    paseo: paseoVersion,
    claude: PROVIDERS.includes("claude") ? (await exec("claude", ["--version"])).stdout.trim() : null,
    codex: PROVIDERS.includes("codex") ? (await exec("codex", ["--version"])).stdout.trim() : null,
    followUp: packed.version, claudeModel: MODELS.claude, codexModel: MODELS.codex || "default",
  };
  log("versions", JSON.stringify(report.versions));
  const logger = pino({ level: "warn" }, pino.destination(join(root, "daemon.log")));
  const settingsFile = join(env.CLAUDE_CONFIG_DIR, "settings.json");
  let hooksNow = {};
  const providerConfig = harnessDaemonProviders({ builtinProviderIds: BUILTIN_PROVIDER_IDS, real: REAL, settings: { claude: { env: { CLAUDE_CONFIG_DIR: liveClaude } }, codex: { env: { CODEX_HOME: harnessCodexLogin } } } });
  const claude = new ClaudeAgentClient({ logger, runtimeSettings: providerConfig.agentProviderSettings.claude, queryFactory(input) {
    const id = input.options.env?.PASEO_AGENT_ID;
    if (id) launches.set(id, [...(launches.get(id) ?? []), { systemPrompt: input.options.systemPrompt }]);
    const preset = input.options.systemPrompt && typeof input.options.systemPrompt === "object" ? input.options.systemPrompt : { type: "preset", preset: "claude_code" };
    return query({ ...input, options: { ...input.options, settingSources: [], strictMcpConfig: true, hooks: undefined, settings: { hooks: hooksNow }, systemPrompt: preset } });
  } });
  daemon = await createPaseoDaemon({ ...providerConfig, listen: `127.0.0.1:${port}`, paseoHome: home, daemonVersion: paseoVersion.replace(/^\D+/, ""), corsAllowedOrigins: [], hostnames: true, mcpEnabled: true, mcpInjectIntoAgents: true, browserToolsEnabled: false, relayEnabled: false, staticDir: root, mcpDebug: false, agentStoragePath: join(home, "agents"), agentClients: { claude }, providerCatalogRefreshTimeoutMs: 5000, metadataGeneration: { providers: [] }, pluginsEnabled: true, plugins: { "follow-up": { source: "directory", path: plugin, enabled: true } } }, logger);
  await daemon.start();
  client = new DaemonClient({ url, clientId: "follow-cards-scenarios", clientType: "cli", appVersion: paseoVersion, reconnect: { enabled: false } });
  await client.connect(); await client.fetchAgents({ subscribe: {} });
  await client.refreshProvidersSnapshot();
  assertProviderStubsUnused(root);
  const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
  await waitUntil("Follow-up's worker", async () => { try { await call("follow.set-onboarding", { action: "finish" }); return true; } catch { return false; } }, { baseMs: 30_000 });
  await waitUntil("Follow-up installs its Claude hooks", async () => { try { hooksNow = JSON.parse(await fs.readFile(settingsFile, "utf8")).hooks ?? {}; return ["SessionStart", "Stop"].every(e => JSON.stringify(hooksNow[e] ?? "").includes("agent-hook")); } catch { return false; } }, { baseMs: 60_000 });
  await call("follow.set-follow-settings", { enable_follow_every: false });
  const api = createPaseoApi(client);

  async function runOne(scenario, provider, n) {
    const name = `${scenario.id}-${provider}-${n}`;
    const dir = join(root, "projects", name); await fs.mkdir(dir, { recursive: true }); await fixture(dir);
    const w = await api.workspaces.create({ title: `example/app ${name}`, source: { kind: "directory", path: dir } });
    const model = MODELS[provider];
    const agent = await w.agents.create({ config: { provider: model ? `${provider}/${model}` : provider, modeId: provider === "codex" ? "full-access" : "bypassPermissions" }, title: "Main" });
    await waitUntil(`tracking ${name}`, async () => { try { await call("follow.activate", { workspaceId: w.id }); return true; } catch { return false; } }, { baseMs: 30_000 });
    const started = Date.now();
    await client.sendAgentMessage(agent.id, scenario.prompt);
    // Settled: idle, and no new timeline entries for 25 s (Follow-up's turn-end check may start one more turn).
    let last = -1; let idleSince = 0;
    await waitUntil(`${name} to settle`, async () => {
      const a = (await client.fetchAgent(agent.id)).agent;
      if (a?.lastError) throw new Error(`${name}: ${a.lastError}`);
      const n = (await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 500 })).entries.length;
      const idle = a?.status === "idle" || a?.lifecycle === "idle";
      if (!idle || n !== last) { last = n; idleSince = 0; return false; }
      if (!idleSince) idleSince = Date.now();
      return Date.now() - idleSince > 25_000;
    }, { baseMs: 900_000, everyMs: 3000 });
    const entries = (await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 500 })).entries.map(e => e.item);
    const tools = entries.filter(i => i?.type === "tool_call");
    const isShow = i => /(^|_|\.)show_card$/.test(i.name ?? "");
    const shows = tools.filter(isShow);
    const asks = tools.filter(i => /(^|_|\.)ask_question$/.test(i.name ?? ""));
    const failed = i => i.status === "failed" || i.status === "error" || !!i.error || /"isError":\s*true/.test(JSON.stringify(i.detail ?? {}));
    const cards = await call("follow.cards", { workspaceId: w.id });
    const ws = (await call("follow.get", { workspaceId: w.id })).workspace;
    const questions = (ws?.questions ?? []).map(q => ({ id: q.id, title: q.title, links: q.links ?? [], answered: !!q.answer, closed: q.closed ?? null, mode: q.mode ?? null }));
    const linked = questions.some(q => q.links.some(l => l.card && cards.cards.some(c => c.id === l.card)));
    const untracked = (await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir })).stdout.split("\n").filter(Boolean).map(l => l.slice(3));
    const pages = untracked.filter(p => /\.html?$/i.test(p));
    // Did the main agent get the line? Claude: its transcript (hook context); Codex: its session file.
    const claudeDir = join(liveClaude, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    const lineReached = provider === "claude"
      ? (launches.get(agent.id) ?? []).some(l => JSON.stringify(l.systemPrompt ?? "").includes(LINE)) || (await exec("grep", ["-rlF", LINE, claudeDir]).then(r => !!r.stdout.trim(), () => false))
      : await (async () => {
        // This run's Codex session files (they name its folder) move out of the login dir into the evidence.
        let reached = false;
        for (const f of (await exec("grep", ["-rlF", dir, join(harnessCodexLogin, "sessions")]).then(r => r.stdout, () => "")).split("\n").filter(Boolean)) {
          if ((await fs.readFile(f, "utf8")).includes(LINE)) reached = true;
          await fs.mkdir(join(out, "transcripts", name), { recursive: true }); await fs.copyFile(f, join(out, "transcripts", name, f.split("/").pop())); await fs.rm(f, { force: true });
        }
        return reached;
      })();
    if (provider === "claude") { await fs.cp(claudeDir, join(out, "transcripts", name), { recursive: true }).catch(() => {}); await fs.rm(claudeDir, { recursive: true, force: true }); }
    const agentSnap = (await client.fetchAgent(agent.id)).agent;
    const usage = agentSnap?.usage ?? agentSnap?.lastUsage ?? agentSnap?.tokenUsage ?? null;
    const text = entries.filter(i => i?.type === "assistant_message").map(i => i.text ?? "").join("\n").slice(-1500);
    const r = {
      name, scenario: scenario.id, provider, should: scenario.should, questionExpected: !!scenario.question,
      used: shows.length > 0, right: scenario.should ? shows.length > 0 : shows.length === 0,
      firstValid: shows.length ? !failed(shows[0]) : null, showCalls: shows.length, showErrors: shows.filter(failed).map(i => JSON.stringify(i.error ?? i.detail).slice(0, 600)),
      asked: asks.length, linked: asks.length ? linked : null, pages, untracked,
      cards: cards.cards.map(c => ({ id: c.id, title: c.title, blocks: (c.blocks ?? []).map(b => b.type), question: c.question?.id ?? null })),
      questions, toolNames: [...new Set(tools.map(i => i.name))], lineReached,
      seconds: Math.round((Date.now() - started) / 1000), usage, finalText: text,
      firstShowInput: shows[0] ? JSON.stringify(shows[0].detail?.input ?? shows[0].detail ?? {}).slice(0, 3000) : null,
    };
    report.runs.push(r);
    await fs.writeFile(join(out, `${name}.json`), JSON.stringify({ ...r, timeline: entries }, null, 2));
    log(`${name}: ${r.right ? "RIGHT" : "WRONG"} used=${r.used} valid=${r.firstValid} asked=${r.asked} linked=${r.linked} pages=${pages.length} ${r.seconds}s line=${r.lineReached}`);
    await client.archiveAgent?.(agent.id).catch(() => {});
  }

  const queue = [];
  for (let n = 1; n <= RUNS; n++) for (const s of SCENARIOS) for (const p of PROVIDERS) queue.push([s, p, n]);
  const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) { const [s, p, n] = queue.shift(); try { await runOne(s, p, n); } catch (error) { log(`${s.id}-${p}-${n}: ERROR ${error.message}`); report.runs.push({ name: `${s.id}-${p}-${n}`, scenario: s.id, provider: p, error: error.message }); } }
  });
  await Promise.all(workers);

  // Table: scenario × provider: right / runs.
  const table = {};
  for (const r of report.runs) { const k = `${r.scenario}|${r.provider}`; table[k] ??= { right: 0, wrong: 0, errors: 0, runs: 0 }; table[k].runs++; if (r.error) table[k].errors++; else if (r.right) table[k].right++; else table[k].wrong++; }
  report.table = table;
  await fs.writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("| scenario | provider | right | wrong | errors | runs |\n| --- | --- | --- | --- | --- | --- |");
  for (const [k, v] of Object.entries(table)) { const [s, p] = k.split("|"); console.log(`| ${s} | ${p} | ${v.right} | ${v.wrong} | ${v.errors} | ${v.runs} |`); }
  log(`report: ${join(out, "report.json")}`);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {}); await daemon?.stop().catch(() => {});
  applyEnv(original);
  await fs.cp(join(root, "daemon.log"), join(out, "daemon.log")).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
