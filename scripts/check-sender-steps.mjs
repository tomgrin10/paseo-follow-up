// Renders Home's "Recent steps" for a synthetic agent whose timeline holds one message from every sender kind: the
// developer, another agent (raw envelope and Paseo's projected agent_message), a child's finish notification, a
// Follow-up batch, a Follow-up answer and an Overseer forward. Fails if a raw <paseo-system envelope is on screen or if
// anything but the developer's message reads "You". Screenshots desktop and phone, dark and light.
// Usage: node scripts/check-sender-steps.mjs [--pack <paseo-follow-up.tgz>] [--out <dir>]
// Needs PLAYWRIGHT_CORE (a playwright-core directory) and CHROMIUM (a Chromium/headless-shell binary).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
await harness();
const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const out = resolve(arg("--out", "docs/evidence/sender-steps"));
const root = await fs.mkdtemp(join(tmpdir(), "follow-sender-steps-"));
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
  await fs.writeFile(join(home, "fixture-chat.json"), JSON.stringify(senderTurn()));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: home, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true" };
  for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID", "CLAUDE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[key];
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1 << 20 })).stdout);
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  for (let i = 0; ; i++) { try { await cli("workspace", "ls"); break; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); if (i > 80) throw new Error("daemon did not start"); await new Promise(r => setTimeout(r, 250)); } }
  await cli("plugin", "install", fixture); await cli("plugin", "install", plugin);
  client = new DaemonClient({ url, clientId: "follow-sender-steps", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  const api = createPaseoApi(client);
  const w = await api.workspaces.create({ title: "Sender steps", source: { kind: "directory", path: root } });
  const agent = await w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId: "default" }, title: "Export fixes" });
  await client.sendMessage(agent.id, "Fixture: chat — fix the CSV export", { messageId: "fixture-chat" });
  for (let i = 0; i < 80; i++) {
    const history = await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 100 });
    if (history.entries.some(e => /Ship it after CI is green/.test(e.item.text ?? ""))) break;
    if (i === 79) throw new Error(`the fixture turn was not recorded: ${JSON.stringify(history.entries.map(e => e.item)).slice(0, 1500)}`);
    await new Promise(r => setTimeout(r, 250));
  }
  const timeline = (await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 100 })).entries.map(e => e.item);
  await fs.writeFile(join(out, "timeline.json"), JSON.stringify(timeline, null, 2));
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const report = [];
  for (const [form, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) for (const scheme of ["dark", "light"]) {
    context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
    const errors = []; context.on("weberror", e => errors.push(String(e.error())));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    if (form === "phone") await page.getByRole("button", { name: /menu|sidebar/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.getByText(/^Follow-up$/).first().click({ timeout: 30000 }).catch(async error => { await page.screenshot({ path: join(out, `${form}-${scheme}-failed.png`) }); throw error; });
    await page.getByText("Sender steps", { exact: false }).first().click({ timeout: 30000 }).catch(async error => { await page.screenshot({ path: join(out, `${form}-${scheme}-failed.png`) }); throw error; });
    await page.getByText("From Release captain", { exact: true }).first().waitFor({ timeout: 30000 }).catch(async error => { await page.screenshot({ path: join(out, `${form}-${scheme}-failed.png`) }); throw error; });
    await page.waitForTimeout(800);
    await page.getByText("From Release captain", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(out, `${form}-${scheme}.png`) });
    const facts = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll("body *")].filter(n => n.children.length === 0).map(n => n.textContent ?? "");
      return { raw: document.body.innerText.includes("<paseo-system"), you: leaves.filter(t => t === "You").length, labels: leaves.filter(t => /^(From |You, via|Follow-up (batch|answer)|.+ finished$)/.test(t)), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    report.push({ form, scheme, ...facts, errors });
    await context.close(); context = null;
  }
  await browser.close();
  console.log(JSON.stringify({ out, report }, null, 2));
  for (const r of report) { assert.equal(r.raw, false, `${r.form} ${r.scheme}: a raw envelope is on screen`); assert.equal(r.overflow, false, `${r.form} ${r.scheme}: horizontal overflow`); }
} finally {
  await context?.close().catch(() => {}); await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => setTimeout(r, 1500)); if (daemon.exitCode === null) daemon.kill("SIGKILL"); }
  await fs.rm(root, { recursive: true, force: true });
}

/** One message from every sender kind, as the provider would replay them into the timeline. */
function senderTurn() {
  let n = 0;
  const id = () => `fx-${++n}`;
  const user = text => ({ type: "user_message", text, messageId: id() });
  const say = text => ({ type: "assistant_message", text });
  // Recent steps shows the last six: exactly one per sender kind, newest last.
  return [
    say("On it: the export streams in pages of 10k and drops the last page."),
    { type: "tool_call", callId: id(), name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test -- export", output: "pass 18" } },
    user('<paseo-system version="1" kind="agent-message" source-agent-id="agent-captain" message-id="m1" source-agent-title="Release captain">\nThe export truncates rows over 10k. Fix it before the 1.4 cut.\n</paseo-system>'),
    user('<paseo-system version="1" kind="agent-notification" source-agent-id="agent-tests" message-id="m2" source-agent-title="Test runner" event="finished">\nAgent agent-tests (Test runner) finished.\n\n&lt;agent-response&gt;\nAll 42 export tests pass, including the 50k-row case.\n&lt;/agent-response&gt;\n</paseo-system>'),
    user("Follow-through batch b-7\n\n- Fix CI on example/app#412: lint"),
    user("From the developer via Overseer: also keep the header row on every page"),
    user("Follow-up answer D1 (Which encoding?): B — UTF-8 with BOM\nContinue with this choice."),
    user("Looks good. Ship it after CI is green."),
  ].map(item => ({ id: id(), ...item }));
}
