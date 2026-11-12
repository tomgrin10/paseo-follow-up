// Upgrade check for 2.0's move to its new plugin id (server/plugin-move.ts, runMove in server/update-watchdog.mjs).
//
// An isolated Paseo daemon (never the user's) installs the published 1.x beta from a fake npm registry, under 1.x's
// plugin id, with synthetic workspaces. The registry serves two 2.0 builds of this tree, with provenance the updater
// accepts (it checks the statement, not its signature). Then, in order:
//   1. the 1.x updater installs a broken 2.0 (rc.0): probation fails, it rolls back to 1.x, the data is intact;
//   2. it installs a good 2.0 (rc.1) under the old id; 2.0 copies 1.x's data again (1.x kept working after rc.0);
//   3. the move to the new id starts at a quiet moment, and the registry now serves a broken rc.1: the new id fails
//      probation, the move rolls back to the old id, and the data is intact;
//   4. the registry serves the good rc.1 again, follow.retry-move asks again, and the move finishes;
//   5. the agent tools (follow_*) are the same names as under 1.x, Home and Settings → Plugins show the new id.
//
// --registry: the path for installs from Paseo's plugin list. Paseo installs the registry's reviewed pin
// (tomgrin10/follow-up, served here through PASEO_PLUGIN_REGISTRY) under 1.x's id, and only updates it to the pin.
// The base defaults to the live pin (1.0.1, which has no updater of its own). Steps 1–4 become: the pin moves to 2.0,
// `paseo plugin update` installs it under the old id, and the move reinstalls from the same registry under the new id,
// keeping data and plugin settings. Then step 5 as above.
// Screenshots of Home before and after and of the plugin settings page go to --shots (default: <tmp>/shots).
//
//   npx tsx scripts/check-move.mjs [--registry] [--base 1.4.0-beta.43] [--shots <dir>] [--keep]
//
// Takes about 15 minutes (FOLLOW_UP_UPDATES_FAST: 90 s quiet window, 60 s probation). Needs the paseo CLI and network
// for the base package. The browser part needs playwright-core (SEND_TO_PASEO_SOURCE) and Chromium (STP_CHROMIUM).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } from "node:fs/promises";
import { existsSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv, harnessConfig } from "./harness-env.mjs";
import { PLUGIN_ID as NEW, LEGACY_PLUGIN_ID as OLD, DATA_DIR, LEGACY_DATA_DIR, ENV_PREFIX, LEGACY_ENV_PREFIX, HOOK_MARKER, LEGACY_HOOK_MARKER, invokeSelf } from "../shared/legacy.ts";
import { SOURCE_REPOSITORY } from "../server/update-provenance.ts";
await harness();

const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const keep = process.argv.includes("--keep");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = line => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const NAME = "paseo-follow-up";
const REGISTRY_MODE = process.argv.includes("--registry");
/** The plugin's id in Paseo's plugin registry (plugins.paseo.sh), and the version it pins today. */
const REGISTRY_ID = "tomgrin10/follow-up", LIVE_PIN = "1.0.1";
const BASE = arg("base", REGISTRY_MODE ? LIVE_PIN : (await exec("npm", ["view", `${NAME}@beta`, "version", "--registry", "https://registry.npmjs.org/"], { timeout: 60_000 })).stdout.trim());
const RC0 = "2.0.0-rc.0", RC1 = "2.0.0-rc.1";

const root = await mkdtemp(join(tmpdir(), "follow-move-"));
const home = join(root, "home"), fixture = join(root, "fixture"), build = join(root, "build");
const shots = arg("shots", join(root, "shots"));
const oldDir = join(home, "plugin-data", LEGACY_DATA_DIR), newDir = join(home, "plugin-data", DATA_DIR);
const free = async () => { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

// ── Tarballs ───────────────────────────────────────────────────────────────────────────────────────────────────────
const tarballs = new Map(); // version -> { bytes, integrity, shasum }
const describe = bytes => ({ bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex") });
async function packTree() {
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", build], { timeout: 120_000, maxBuffer: 8 << 20 })).stdout)[0];
  const tree = join(build, "tree"); await mkdir(tree, { recursive: true });
  await exec("tar", ["-xzf", join(build, packed.filename), "-C", tree]);
  return join(tree, "package");
}
/** This tree at `version`; `broken` makes the worker report a load error, so probation fails. */
async function variant(tree, version, broken) {
  const dir = join(build, `${version}${broken ? "-broken" : ""}`); await cp(tree, join(dir, "package"), { recursive: true });
  const pkg = JSON.parse(await readFile(join(dir, "package/package.json"), "utf8")); pkg.version = version;
  await writeFile(join(dir, "package/package.json"), JSON.stringify(pkg, null, 2));
  if (broken) {
    const entry = join(dir, "package/index.server.ts"); const source = await readFile(entry, "utf8");
    const patched = source.replace("let loadError: string | null = null;", "let loadError: string | null = \"Broken on purpose by scripts/check-move.mjs.\";");
    assert.notEqual(patched, source, "the broken build patches loadError");
    await writeFile(entry, patched);
  }
  const file = join(build, `${version}${broken ? "-broken" : ""}.tgz`);
  await exec("tar", ["-czf", file, "-C", dir, "package"]);
  return describe(await readFile(file));
}

// ── Fake registry: packument, version metadata, attestations, tarballs ─────────────────────────────────────────────
const tags = { latest: BASE, beta: BASE };
/** The fake plugin registry's reviewed pin for REGISTRY_ID. */
const pin = { version: BASE };
let registryUrl = "";
const statement = (version, sha512) => ({ _type: "https://in-toto.io/Statement/v1", subject: [{ name: `pkg:npm/${NAME}@${version}`, digest: { sha512 } }], predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { externalParameters: { workflow: { repository: SOURCE_REPOSITORY, path: ".github/workflows/release.yml", ref: "refs/heads/main" } } } } });
const versionDoc = version => {
  const t = tarballs.get(version);
  return { name: NAME, version, dist: { tarball: `${registryUrl}tarballs/${version}.tgz`, integrity: t.integrity, shasum: t.shasum, attestations: { url: `${registryUrl}-/attestations/${version}`, provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };
};
const registry = createHttp((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const json = body => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" }); res.end(JSON.stringify(body)); };
  if (url === `/${NAME}`) return json({ name: NAME, "dist-tags": tags, versions: Object.fromEntries([...tarballs.keys()].map(v => [v, versionDoc(v)])), time: Object.fromEntries([...tarballs.keys()].map(v => [v, new Date().toISOString()])) });
  // Paseo's plugin registry (PASEO_PLUGIN_REGISTRY): the install document for the reviewed pin.
  if (url === `/plugins/${REGISTRY_ID}.json`) {
    const t = tarballs.get(pin.version);
    return json({ id: REGISTRY_ID, artifact: { kind: "npm", package: NAME, version: pin.version, resolved: `${registryUrl}tarballs/${pin.version}.tgz`, integrity: t.integrity } });
  }
  let m = /^\/paseo-follow-up\/(.+)$/.exec(url); if (m && tarballs.has(m[1])) return json(versionDoc(m[1]));
  m = /^\/-\/attestations\/(.+)$/.exec(url);
  if (m && tarballs.has(m[1])) {
    const hex = Buffer.from(tarballs.get(m[1]).integrity.slice(7), "base64").toString("hex");
    return json({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement(m[1], hex))).toString("base64") } } }] });
  }
  m = /^\/tarballs\/(.+)\.tgz$/.exec(url);
  if (m && tarballs.has(m[1])) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(tarballs.get(m[1]).bytes); }
  res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
});

// ── Daemon ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let daemon = null, client = null, browser = null;
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const regPort = await free(); registryUrl = `http://127.0.0.1:${regPort}/`;
const providers = "claude,codex,followup-fixture";
const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true",
  npm_config_registry: registryUrl, npm_config_cache: join(root, "npm-cache"), npm_config_prefer_online: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
  PASEO_PLUGIN_REGISTRY: registryUrl.replace(/\/+$/, ""), FOLLOW_UP_UPDATES_FAST: "1", [`${ENV_PREFIX}TOOL_PROVIDERS`]: providers, [`${LEGACY_ENV_PREFIX}TOOL_PROVIDERS`]: providers }, strip: ["NPM_CONFIG_REGISTRY"] });
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 300_000, maxBuffer: 8 << 20 })).stdout);
const rows = async () => (await client.listPlugins()).filter(p => p.id === OLD || p.id === NEW).map(p => ({ id: p.id, status: p.status, version: p.installation?.currentRevision ?? null, enabled: p.enabled ?? null }));
const events = dir => { try { return readFileSync(join(dir, "updates.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const call = (id, method, input = {}) => client.invokePluginRpc(id, method, input);
const self = (method, input = {}) => invokeSelf(id => call(id, method, input));
async function until(label, test, ms) {
  say(`waiting: ${label}`);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2_000)) { const v = await test().catch(() => null); if (v) return v; }
  throw new Error(`timed out: ${label}\nold events: ${JSON.stringify(events(oldDir))}\nnew events: ${JSON.stringify(events(newDir))}\nplugins: ${JSON.stringify(await rows().catch(e => e.message))}`);
}
async function connect() {
  await client?.close().catch(() => {});
  client = new DaemonClient({ url, clientId: "follow-move-check", clientType: "cli", reconnect: { enabled: true }, suppressSendErrors: true }); await client.connect();
}
/** One MCP JSON-RPC exchange over streamable HTTP (JSON or SSE replies). */
async function mcp(server, session, body) {
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session.id ? { "mcp-session-id": session.id } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
  session.id = response.headers.get("mcp-session-id") ?? session.id;
  const text = await response.text();
  if (body.id === undefined) return null;
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).pop());
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}
/** The follow_* tools a new agent in `workspace` gets over Paseo's MCP, and its own workspace_status answer. */
async function agentTools(workspace, title, { optional = false } = {}) {
  const agent = await workspace.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title });
  const config = await until(`launch config of ${title}`, async () => JSON.parse(await readFile(join(home, `fixture-agent-config-${agent.id}.json`), "utf8")), 30_000);
  const server = Object.values(config.mcpServers ?? {}).find(s => s?.type === "http");
  assert.ok(server, "the agent gets Paseo's MCP");
  const session = {};
  await mcp(server, session, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "follow-move-check", version: "1" } } });
  await mcp(server, session, { method: "notifications/initialized" });
  const names = (await mcp(server, session, { id: 2, method: "tools/list" })).tools.map(t => t.name).filter(n => n.startsWith("follow_")).sort();
  // The worker writes the new agent's scope (scopes.json) just after it starts: ask until it answers.
  // 1.0.1 (the registry's pin) predates Follow-up's tools in Paseo's MCP: `optional` reports what is there.
  const status = await until(`${title}: follow_workspace_status`, async () => {
    const reply = await mcp(server, session, { id: 3, method: "tools/call", params: { name: "follow_workspace_status", arguments: {} } });
    return reply.isError ? null : JSON.parse(reply.content[0].text);
  }, 30_000).catch(error => { if (!optional) throw error; say(`${title}: no answering follow_workspace_status (${names.length} follow_* tools listed)`); return { id: null }; });
  return { names, workspaceId: status.id };
}

// ── Browser ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function openBrowser() {
  const source = process.env.SEND_TO_PASEO_SOURCE;
  let executablePath = process.env.STP_CHROMIUM ?? null;
  if (!executablePath) {
    const cache = join(homedir(), ".cache/ms-playwright");
    const builds = existsSync(cache) ? (await readdir(cache)).filter(d => /^chromium-\d+$/.test(d)).sort() : [];
    const candidate = builds.length ? join(cache, builds.at(-1), "chrome-linux64/chrome") : null;
    executablePath = candidate && existsSync(candidate) ? candidate : null;
  }
  if (!source || !executablePath) { say("no SEND_TO_PASEO_SOURCE or Chromium: skipping screenshots"); return null; }
  const { chromium } = createRequire(join(source, "extension/package.json"))("playwright-core");
  const profile = await mkdtemp(join(root, "browser-"));
  return chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1440, height: 1000 }, args: ["--disable-extensions", "--no-first-run"] });
}
async function shotHome(name) {
  if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByText("Follow-up", { exact: true }).first().click({ timeout: 60_000 });
    await page.waitForTimeout(3_000);
    // 1.x's first open shows the setup tour. Skipping it is saved in Follow-up's data, so after the move it stays skipped.
    const skip = page.getByText("Skip setup", { exact: true });
    result.tour ??= {}; result.tour[name] = await skip.count() > 0;
    if (result.tour[name]) { await skip.first().click(); await page.waitForTimeout(2_000); }
    for (const label of ["Close", "Got it", "Not now"]) { const b = page.getByRole("button", { name: label, exact: true }); if (await b.count()) await b.first().click().catch(() => {}); }
    await page.mouse.move(0, 0); await page.waitForTimeout(800);
    await page.screenshot({ path: join(shots, `${name}.png`) });
    say(`screenshot ${join(shots, `${name}.png`)}`);
  } finally { await page.close(); }
}
/**
 * Follow-up's settings screen under plugin id `id` and its General line for the move, plus Paseo's plugin list.
 * Paseo 0.15 titles the screen "<plugin id> · <name>", 0.16 only "<name>"; both list the id under Settings → Plugins.
 */
async function shotPluginSettings(name, { id = NEW, variants = true } = {}) {
  if (!browser) return null;
  const page = await browser.newPage();
  try {
    const serverId = (await readFile(join(home, "server-id"), "utf8")).trim();
    await page.goto(`http://127.0.0.1:${port}/settings/hosts/${serverId}/plugins`);
    await page.getByText("Plugin source", { exact: true }).waitFor({ timeout: 60_000 });
    const listed = await page.evaluate(ids => ids.filter(i => [...document.querySelectorAll("div")].some(d => d.childElementCount === 0 && d.textContent === i)), [OLD, NEW]);
    await page.screenshot({ path: join(shots, `${name}-plugins.png`) });
    await page.goto(`http://127.0.0.1:${port}/settings/hosts/${serverId}/plugins/${id}/projects`);
    await page.getByText("Back to plugins", { exact: true }).waitFor({ timeout: 60_000 });
    const title = (await page.getByText(/^(?:\S+ · )?Follow-up$/).first().textContent({ timeout: 30_000 }).catch(() => null))?.trim() ?? null;
    // General is the screen's first category, open by default on desktop.
    const line = (await page.getByText(/Follow-up's new plugin id/).first().textContent({ timeout: 30_000 }).catch(() => null))?.trim() ?? null;
    await page.mouse.move(0, 0); await page.waitForTimeout(800);
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
    say(`screenshot ${join(shots, `${name}.png`)}: title ${JSON.stringify(title)}, line ${JSON.stringify(line)}, listed ${JSON.stringify(listed)}`);
    if (!variants) return { title, line, listed };
    // The same line at phone width (the screen opens on its category list there) and in dark mode.
    const moveLine = () => page.getByText(/Follow-up's new plugin id/).first();
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    // The phone opens on the category list; General's row is the first.
    const general = page.getByText("General", { exact: true }).filter({ visible: true });
    // isVisible() doesn't wait: wait for the list (or the open category) to render first.
    await general.or(moveLine()).first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    if (!(await moveLine().isVisible())) await general.first().click({ timeout: 15_000 }).catch(() => {});
    await moveLine().scrollIntoViewIfNeeded({ timeout: 30_000 }).catch(() => {});
    const phone = { line: (await moveLine().textContent({ timeout: 30_000 }).catch(() => null))?.trim() ?? null, overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth) };
    await page.waitForTimeout(800); await page.screenshot({ path: join(shots, `${name}-phone.png`) });
    await page.emulateMedia({ colorScheme: "dark" }); await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
    await moveLine().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.mouse.move(0, 0); await page.waitForTimeout(800); await page.screenshot({ path: join(shots, `${name}-dark.png`), fullPage: true });
    say(`screenshots ${name}-phone.png ${JSON.stringify(phone)}, ${name}-dark.png`);
    return { title, line, listed, phone };
  } finally { await page.close(); }
}

const result = { base: BASE, steps: [] };
const step = (name, detail = {}) => { result.steps.push({ name, ...detail }); say(`ok: ${name} ${JSON.stringify(detail)}`); };
try {
  await Promise.all([home, fixture, build, shots].map(p => mkdir(p, { recursive: true })));
  await new Promise(r => registry.listen(regPort, "127.0.0.1", r));
  // Base: the published 1.x beta, served by this registry.
  const basePack = JSON.parse((await exec("npm", ["pack", `${NAME}@${BASE}`, "--json", "--registry", "https://registry.npmjs.org/", "--pack-destination", build], { cwd: build, timeout: 120_000, maxBuffer: 8 << 20 })).stdout)[0];
  tarballs.set(BASE, describe(await readFile(join(build, basePack.filename))));
  const tree = await packTree();
  tarballs.set(RC0, await variant(tree, RC0, true));
  const good = await variant(tree, RC1, false), broken = await variant(tree, RC1, true);
  tarballs.set(RC1, good);
  say(`registry ${registryUrl}: ${[...tarballs.keys()].join(", ")}`);

  await writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, mcp: true, webUi: true })));
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  const log = openSync(join(root, "daemon.log"), "a");
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 160; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i === 159) throw new Error("isolated daemon did not start"); await sleep(250); } }
  await connect();
  await cli("plugin", "install", fixture);
  await cli("plugin", "install", REGISTRY_MODE ? REGISTRY_ID : `npm:${NAME}@${BASE}`);
  assert.deepEqual((await rows()).map(r => [r.id, r.status]), [[OLD, "running"]], "1.x installs under its old id");
  const registryOf = async id => (await client.listPlugins()).find(p => p.id === id)?.installation?.identity?.registry ?? null;
  if (REGISTRY_MODE) assert.equal((await registryOf(OLD))?.id, REGISTRY_ID, "installed from the plugin registry");
  step("installed 1.x", { id: OLD, version: (await rows())[0].version });

  // Synthetic data: two tracked workspaces, one untracked, and a settings marker Paseo keeps per plugin id.
  // 1.0.1 (the live registry pin) predates this setting; its default already leaves new workspaces unfollowed.
  if (!REGISTRY_MODE) await call(OLD, "follow.set-follow-settings", { enable_follow_every: false });
  const api = createPaseoApi(client);
  const spaces = [];
  for (const title of ["Synthetic checkout rollout", "Synthetic billing migration", "Synthetic untracked"]) {
    const dir = join(root, "projects", title.replace(/\W+/g, "-")); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title, source: { kind: "directory", path: dir } });
    await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: `${title} agent` });
    spaces.push(w);
  }
  for (const w of spaces.slice(0, 2)) await call(OLD, "follow.activate", { workspaceId: w.id });
  const tracked = async id => (await call(id, "follow.list", {})).workspaces.map(w => w.id).sort();
  const before = await tracked(OLD);
  assert.equal(before.length, 2);
  await mkdir(join(home, "plugin-settings", OLD), { recursive: true });
  await writeFile(join(home, "plugin-settings", OLD, "harness-marker.json"), JSON.stringify({ from: "check-move" }));
  const toolsBefore = await agentTools(spaces[0], "Tools under 1.x", { optional: REGISTRY_MODE });
  if (toolsBefore.workspaceId !== null) assert.equal(toolsBefore.workspaceId, spaces[0].id);
  step("synthetic data", { tracked: before, tools: toolsBefore.names.length });
  browser = await openBrowser();
  await shotHome("home-before");

  if (REGISTRY_MODE) {
    // The registry path: nothing updates a registry install but the reviewed pin. The pin moves to 2.0, and the
    // developer updates from Paseo's plugin list; Paseo keeps the old id.
    pin.version = RC1;
    // The CLI shows the update for review first (the developer confirms it in the plugin list); --yes confirms.
    await cli("plugin", "update", OLD, "--yes");
    await until("2.0 runs under the old id", async () => { const r = await rows(); return r.some(x => x.id === OLD && x.version === RC1 && x.status === "running"); }, 8 * 60_000);
    assert.equal((await registryOf(OLD))?.id, REGISTRY_ID, "still a registry install");
    await until("2.0 copied the data", async () => existsSync(join(newDir, "state.json")), 3 * 60_000);
    assert.deepEqual(await tracked(OLD), before, "2.0 under the old id has 1.x's workspaces");
    const waiting = (await call(OLD, "follow.updates")).move;
    assert.ok(["waiting", "moving", "moved"].includes(waiting?.phase), `a registry install moves by itself, not "manual": ${JSON.stringify(waiting)}`);
    step("2.0 under the old id (registry)", { tracked: before, move: waiting?.phase });

    await until("the move finishes", async () => events(newDir).at(-1)?.event === "moved", 10 * 60_000);
    await until("only the new id", async () => { const r = await rows(); return r.length === 1 && r[0].id === NEW && r[0].status === "running" && r[0].version === RC1; }, 3 * 60_000);
    const from = await registryOf(NEW);
    assert.deepEqual([from?.id, from?.url?.replace(/\/+$/, "")], [REGISTRY_ID, registryUrl.replace(/\/+$/, "")], "the new id is installed from the same registry, so the next pin updates it");
    // 1.0.1 stored no enable_follow_every, which today reads as "follow every workspace": 2.0 may add the untracked
    // one on its own. The move must lose nothing.
    const afterMove = await tracked(NEW);
    assert.deepEqual(before.filter(id => !afterMove.includes(id)), [], "every workspace 1.0.1 followed is still followed under the new id");
    assert.ok(existsSync(join(home, "plugin-settings", NEW, "harness-marker.json")), "plugin settings moved");
    assert.ok(existsSync(join(oldDir, "state.json")), "1.x's directory is kept as a backup");
    const moved = (await call(NEW, "follow.updates")).move;
    assert.equal(moved?.phase, "moved");
    step("moved (registry)", { plugins: await rows(), registry: from, move: moved, tracked: afterMove, addedByFollowEvery: afterMove.filter(id => !before.includes(id)) });
  } else {
    // 1. A broken 2.0: the 1.x updater rolls it back.
    await call(OLD, "follow.set-updates", { mode: "auto", channel: "beta" });
    tags.beta = RC0;
    await call(OLD, "follow.updates", { check: "manual" });
    await until("1.x rolls back the broken 2.0", async () => events(oldDir).some(e => e.to === RC0 && e.event === "rolled-back"), 8 * 60_000);
    await until("1.x running again", async () => { const r = await rows(); return r.length === 1 && r[0].id === OLD && r[0].status === "running" && r[0].version === BASE; }, 3 * 60_000);
    assert.deepEqual(await tracked(OLD), before, "1.x's data is intact after the rollback");
    // 1.x keeps working in its directory: a change the next 2.0 must copy again.
    await call(OLD, "follow.activate", { workspaceId: spaces[2].id });
    const afterRollback = await tracked(OLD);
    step("broken 2.0 rolled back to 1.x", { reason: events(oldDir).find(e => e.to === RC0 && e.event === "rolled-back")?.reason, tracked: afterRollback });

    // 2. A good 2.0 under the old id.
    tags.beta = RC1;
    await call(OLD, "follow.updates", { check: "manual" });
    await until("2.0 runs under the old id", async () => { const r = await rows(); return r.some(x => x.id === OLD && x.version === RC1 && x.status === "running"); }, 8 * 60_000);
    // 3. The move will install this version again: from now on npm serves a broken copy of it.
    tarballs.set(RC1, broken);
    await until("1.x's installer keeps 2.0", async () => events(oldDir).some(e => e.to === RC1 && e.event === "updated"), 5 * 60_000);
    assert.deepEqual(await tracked(OLD), afterRollback, "2.0 copied 1.x's newer data again");
    assert.ok((await readdir(join(home, "plugin-data"))).some(d => d.startsWith(`.${DATA_DIR}.before-`)), "the stale copy is kept as a backup");
    step("2.0 under the old id", { tracked: afterRollback });

    await until("the move rolls back", async () => events(newDir).some(e => e.event === "move-rolled-back"), 10 * 60_000);
    await until("the old id runs again", async () => { const r = await rows(); return r.length === 1 && r[0].id === OLD && r[0].status === "running"; }, 3 * 60_000);
    assert.deepEqual(await tracked(OLD), afterRollback, "data intact after the move's rollback");
    const rolled = (await self("follow.updates")).move;
    assert.equal(rolled?.phase, "rolled-back");
    step("forced probation failure rolled the move back", { reason: rolled.reason, plugins: await rows() });
    const back = await shotPluginSettings("settings-rolled-back", { id: OLD, variants: false });
    if (browser) assert.match(back.line ?? "", /^Couldn't move to Follow-up's new plugin id, so it went back to the old one\./, "Settings → General says the move rolled back");

    // 4. Retry with the good build.
    tarballs.set(RC1, good);
    const asked = (await self("follow.retry-move")).move;
    assert.ok(["waiting", "moving"].includes(asked?.phase), `retry asks again: ${JSON.stringify(asked)}`);
    await until("the move finishes", async () => events(newDir).at(-1)?.event === "moved", 10 * 60_000);
    await until("only the new id", async () => { const r = await rows(); return r.length === 1 && r[0].id === NEW && r[0].status === "running" && r[0].version === RC1; }, 3 * 60_000);
    assert.deepEqual(await tracked(NEW), afterRollback, "same workspaces under the new id");
    assert.ok(existsSync(join(home, "plugin-settings", NEW, "harness-marker.json")), "plugin settings moved");
    assert.ok(existsSync(join(oldDir, "state.json")), "1.x's directory is kept as a backup");
    const view = await call(NEW, "follow.updates"), moved = view.move;
    assert.equal(moved?.phase, "moved");
    assert.deepEqual([view.history[0]?.result, view.history[0]?.to], ["updated", RC1], "history ends with the update to 2.0, which 1.x's installer logged after the copy");
    step("moved", { plugins: await rows(), move: moved });

  }

  // 5. Agents: the same follow_* names (2.0 adds follow_retry_move), answered under the new id.
  const toolsAfter = await agentTools(spaces[0], "Tools under 2.0");
  assert.equal(toolsAfter.workspaceId, spaces[0].id);
  const missing = toolsBefore.names.filter(n => !toolsAfter.names.includes(n));
  const added = toolsAfter.names.filter(n => !toolsBefore.names.includes(n));
  assert.deepEqual(missing, [], "no tool lost its name");
  // From a 1.x beta the move's tool is the only new one; from the registry's older pin, 2.0 adds every tool since.
  if (!REGISTRY_MODE) assert.deepEqual(added, ["follow_retry_move"], "the only new tool is the move's");
  else assert.ok(added.includes("follow_retry_move"), "2.0's tools include the move's");
  for (const file of [join(home, ".claude/settings.json"), join(home, ".codex/hooks.json")].filter(existsSync)) {
    const text = await readFile(file, "utf8");
    assert.ok(text.includes(HOOK_MARKER) && !text.includes(LEGACY_HOOK_MARKER), `${file}: only the new hook`);
  }
  step("agent tools unchanged", { names: toolsAfter.names.length, added });

  // A reload doesn't move again.
  const count = events(newDir).length;
  await cli("plugin", "reload", NEW); await sleep(10_000);
  assert.equal(events(newDir).filter(e => e.event === "moving").length, REGISTRY_MODE ? 1 : 2, REGISTRY_MODE ? "one move, nothing after" : "one failed and one good move, nothing after");
  assert.ok(events(newDir).length >= count);
  await shotHome("home-after");
  const settings = await shotPluginSettings("settings-plugin");
  if (browser) {
    assert.ok([`${NEW} · Follow-up`, "Follow-up"].includes(settings.title), `the plugin settings title shows the new id, or only the name (0.16): ${settings.title}`);
    assert.deepEqual(settings.listed, [NEW], "Settings → Plugins lists the new id only");
    assert.equal(settings.line, "Moved to Follow-up's new plugin id.", "Settings → General says the move is done");
    assert.equal(settings.phone.line, settings.line, "the line shows at phone width too");
    assert.equal(settings.phone.overflow, false, "no horizontal overflow at 390 px");
  }
  step("after the move", settings ?? {});
  result.ok = true;
  result.shots = browser ? shots : null;
  console.log(JSON.stringify(result, null, 2));
} catch (error) { process.exitCode = 1; console.error(error); } finally {
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  registry.close();
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  if (process.exitCode || keep) console.error(`kept ${root} (daemon.log, shots)`);
  else if (shots.startsWith(root)) console.error(`screenshots were in ${shots}; pass --shots to keep them`), await rm(root, { recursive: true, force: true });
  else await rm(root, { recursive: true, force: true });
}
