// Renders a synthetic mixed turn (thinking, Bash, edits, Follow-up bookkeeping, a question, a repeated declare_done) in an
// isolated Paseo daemon's web UI and screenshots it collapsed and expanded, desktop and phone, dark and light.
// Usage: node scripts/check-chat-grouping.mjs [--pack <paseo-follow-up.tgz>] [--out <dir>] [--label before|after]
// Needs PLAYWRIGHT_CORE (a playwright-core directory) and CHROMIUM (a Chromium/headless-shell binary).
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";
await harness();
const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const label = arg("--label", "after");
const out = resolve(arg("--out", "docs/evidence/chat-grouping"));
const root = await fs.mkdtemp(join(tmpdir(), "follow-chat-grouping-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const fixture = join(root, "fixture");
await Promise.all([home, plugin, fixture, out].map(p => fs.mkdir(p, { recursive: true })));
const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
const url = `ws://127.0.0.1:${port}/ws`;
let daemon; let client; let context;
try {
  await fs.writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false }, browserTools: { enabled: false } }, features: { webUi: { enabled: true } } }));
  const pack = arg("--pack") ? resolve(arg("--pack")) : join(root, JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60000 })).stdout)[0].filename);
  await exec("tar", ["-xzf", pack, "--strip-components=1", "-C", plugin]);
  await fs.writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followthrough-fixture", requirements: { paseo: ">=0.11.0" } }));
  await fs.writeFile(join(fixture, "index.server.ts"), await fs.readFile("scripts/fixture-provider.ts", "utf8"));
  await fs.writeFile(join(home, "fixture-chat.json"), JSON.stringify(mixedTurn()));
  const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true" } });
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1 << 20 })).stdout);
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; ; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i > 80) throw new Error("daemon did not start"); await new Promise(r => setTimeout(r, 250)); } }
  await cli("plugin", "install", fixture); await cli("plugin", "install", plugin);
  client = new DaemonClient({ url, clientId: "follow-chat-grouping", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  const api = createPaseoApi(client);
  const w = await api.workspaces.create({ title: "Chat grouping", source: { kind: "directory", path: root } });
  const agent = await w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId: "default" }, title: "Retry backoff" });
  await client.sendMessage(agent.id, "Fixture: chat — ship the retry backoff and verify it", { messageId: "fixture-chat" });
  for (let i = 0; i < 80; i++) {
    const history = await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 100 });
    if (history.entries.some(e => e.item.type === "tool_call" && e.item.name.endsWith("follow_needs_you"))) break;
    if (i === 79) throw new Error(`the fixture turn was not recorded: ${JSON.stringify(history.entries.map(e => e.item)).slice(0, 1500)}`);
    await new Promise(r => setTimeout(r, 250));
  }
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const report = [];
  for (const [form, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) for (const scheme of ["dark", "light"]) {
    // Phone: open the workspace at desktop width (the sidebar is a drawer on phones), then narrow the viewport.
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const errors = []; context.on("weberror", e => errors.push(String(e.error())));
    const page = await context.newPage();
    // Deep links land on Home before the host is known, so open the workspace from the sidebar like a person would.
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByText("Chat grouping", { exact: true }).first().click({ timeout: 30000 });
    await page.setViewportSize(viewport);
    await page.getByText("Shipped the retry backoff", { exact: false }).first().waitFor({ timeout: 30000 }).catch(async error => { await page.screenshot({ path: join(out, `${label}-failed.png`) }); throw error; });
    await page.waitForTimeout(1500);
    const shot = async name => { await page.mouse.move(0, 0); await page.waitForTimeout(300); await page.screenshot({ path: join(out, `${label}-${form}-${scheme}-${name}.png`) }); };
    await shot("collapsed");
    const counts = async () => page.evaluate(() => ({ loose: [...document.querySelectorAll("body *")].filter(n => n.children.length === 0 && /^(Synced Follow-up|Read Follow-up status|Task |Registered )/.test(n.textContent ?? "")).length, done: [...document.querySelectorAll("body *")].filter(n => n.children.length === 0 && n.textContent === "Workspace done").length, asked: [...document.querySelectorAll("body *")].filter(n => n.children.length === 0 && /· asked$/.test(n.textContent ?? "")).length, overflow: document.documentElement.scrollWidth > innerWidth }));
    const collapsed = await counts();
    // The turn's summary line, then every run group inside it.
    await page.getByText(/(ran|edited) \d+ (commands?|files?)/i).first().click().catch(() => {});
    await page.waitForTimeout(500);
    for (const group of await page.getByTestId("tool-call-group").all()) await group.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot("expanded");
    report.push({ form, scheme, collapsed, expanded: await counts(), errors });
    await context.close(); context = null;
  }
  await browser.close();
  console.log(JSON.stringify({ label, out, report }, null, 2));
} finally {
  await context?.close().catch(() => {}); await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => setTimeout(r, 1500)); if (daemon.exitCode === null) daemon.kill("SIGKILL"); }
  await fs.rm(root, { recursive: true, force: true });
}

/** One realistic turn: work, bookkeeping between it, a question, the final message, then end-of-turn bookkeeping. */
function mixedTurn() {
  let n = 0;
  const id = () => `fx-${++n}`;
  const think = text => ({ type: "reasoning", text });
  const tool = (name, detail) => ({ type: "tool_call", callId: id(), name, status: "completed", error: null, detail });
  const mcp = (leaf, input, result) => tool(`mcp__paseo__follow_${leaf}`, { type: "unknown", input, output: { content: [{ type: "text", text: JSON.stringify(result) }] } });
  const ws = { id: "wks_fixture", completion: { summary: "Retry backoff shipped and verified in production" } };
  return [
    think("Read the tracker before starting."),
    mcp("workspace_status", {}, { workspace: { id: "wks_fixture" } }),
    tool("Bash", { type: "shell", command: "rg -n 'retry' src/", output: "src/retry.ts:12: export function retry(" }),
    think("The backoff caps at 3 attempts; make it exponential."),
    tool("Edit", { type: "edit", filePath: "/repo/src/retry.ts", unifiedDiff: "@@ -12 +12 @@\n-  delay = 100\n+  delay = 100 * 2 ** attempt" }),
    tool("Write", { type: "write", filePath: "/repo/tests/retry.test.ts", content: "test('backs off', () => {})" }),
    tool("Bash", { type: "shell", command: "npm test", output: "pass 42" }),
    mcp("register_pr", { repo: "example/app", number: 412, stack: "Retry backoff" }, { ok: true }),
    mcp("update_obligation", { title: "Verify retries in production", status: "waiting", afterPrs: ["example/app#412"] }, { ok: true }),
    think("The retry ceiling is a product decision."),
    mcp("ask_question", { title: "Retry ceiling", question: "Cap retries at 5 or 8?" }, { question: { id: "Q3", title: "Retry ceiling" }, instruction: "Asked Q3." }),
    tool("mcp__paseo__wait_prepare_job", { type: "unknown", input: { command: "npm run deploy:check" }, output: { content: [{ type: "text", text: "{\"jobId\":\"j1\"}" }] } }),
    tool("mcp__paseo__wait_for_job", { type: "unknown", input: { jobId: "j1" }, output: { content: [{ type: "text", text: "{\"status\":\"completed\"}" }] } }),
    { type: "assistant_message", text: "Shipped the retry backoff in example/app#412 and verified it in production. Q3 asks whether to cap retries at 5 or 8." },
    mcp("declare_done", { summary: ws.completion.summary }, { workspace: ws, blockers: [] }),
    mcp("declare_done", { summary: ws.completion.summary }, { workspace: ws, blockers: [] }),
    mcp("sync_workspace", { summary: "Shipped #412, verified, asked Q3" }, { ok: true }),
    mcp("needs_you", { kind: "decision", title: "Retry ceiling" }, { ok: true }),
  ].map(item => ({ id: id(), ...item }));
}
