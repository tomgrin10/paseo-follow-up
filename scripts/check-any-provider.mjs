// An agent on a provider that is neither Claude nor Codex gets Follow-up (an-agent-on-any-provider-gets-follow-up),
// end to end on a real Paseo 0.17 daemon. Starts an isolated daemon (never the user's) with its agent MCP on, Claude and
// Codex off (harnessConfig), and one generic ACP provider, "Acme ACP": scripts/fake-acp-agent.mjs, registered as
// `agents.providers["acme-acp"] = { extends: "acp", command: [node, fake-acp-agent.mjs] }`. No model, no network.
//
// 1. Creates a tracked synthetic workspace with an agent on Acme ACP and prompts it to call follow_workspace_status;
//    the fake agent records what Paseo gave it at session/new (mcpServers, any system prompt) and calls the tool through
//    the Paseo MCP server it was handed. Asserts the follow_* tools are listed and the call answers for its own
//    workspace; then reads follow_session_instructions, the tool an ACP agent gets Follow-up's instructions through
//    (Paseo 0.17.4 passes no plugin system prompt to ACP), and asserts it answers with them.
// 2. Renders Settings → Agents at 1440×900 and 390×844, light and dark: the one notes block shows (Acme ACP reads its
//    instructions through a tool; Summaries' linked items, Compass and Ask need a provider with no tools), and AI priority shows off with why,
//    the helper rows show the fallback pick (Acme ACP, never Claude), nothing overflows horizontally.
//
//   PLAYWRIGHT_CORE=<dir> CHROMIUM=<bin> HARNESS_PASEO=system ~/paseo-harness/tools/harness-slot \
//     node scripts/check-any-provider.mjs [--out docs/evidence/any-provider]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon, waitUntil } from "./harness.mjs";
import { harnessEnv, harnessConfig } from "./harness-env.mjs";
import { assertNoRealNames } from "./real-names.mjs";
await harness();

const exec = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const out = resolve(arg("--out", "docs/evidence/any-provider"));
const PROVIDER = "acme-acp"; const LABEL = "Acme ACP";
const root = await fs.mkdtemp(join(tmpdir(), "follow-any-provider-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const bin = join(root, "bin");
const record = join(root, "acp-record.jsonl");
await Promise.all([home, plugin, bin, out].map(p => fs.mkdir(p, { recursive: true })));
const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
const url = `ws://127.0.0.1:${port}/ws`; const ORIGIN = `http://127.0.0.1:${port}`;
const log = (...a) => console.log("[any-provider]", ...a);
const records = async () => (await fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l));
let daemon; let client; let browser;
const report = { provider: PROVIDER, paseo: null, tools: null, call: null, instructions: null, catalog: null, roles: null, shots: [] };

try {
  await fs.copyFile("scripts/fake-acp-agent.mjs", join(bin, "fake-acp-agent.mjs"));
  const acme = { extends: "acp", label: LABEL, description: "A fictional ACP agent (harness only)", command: [process.execPath, join(bin, "fake-acp-agent.mjs")], env: { FAKE_ACP_RECORD: record } };
  await fs.writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, mcp: true, webUi: true, providers: { [PROVIDER]: acme } })));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 120_000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true" } });
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120_000, maxBuffer: 1 << 22 })).stdout);
  report.paseo = (await exec("paseo", ["--version"], { env })).stdout.trim();
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", openSync(join(root, "daemon.log"), "a"), openSync(join(root, "daemon.log"), "a")] });
  await waitUntil("the isolated daemon", async () => { assert.equal(daemon.exitCode, null, "isolated daemon exited"); try { await cli("workspace", "ls"); return true; } catch { return false; } }, { baseMs: 30_000 });
  await cli("plugin", "install", plugin);
  client = new DaemonClient({ url, clientId: "follow-any-provider", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect();
  const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
  await waitUntil("Follow-up's worker", async () => { try { await call("follow.set-onboarding", { action: "finish" }); return true; } catch { return false; } }, { baseMs: 30_000 });

  // The catalog: Acme ACP available, Claude and Codex not; helpers left on their default fall back to Acme ACP.
  const settings = await waitUntil("Acme ACP in Follow-up's catalog", async () => {
    const view = await call("follow.agent-settings", { catalog: true, fresh: true });
    return view.catalog?.providers.find(p => p.id === PROVIDER)?.available ? view : null;
  }, { baseMs: 60_000 });
  report.catalog = settings.catalog.providers.map(p => ({ id: p.id, label: p.label, available: p.available }));
  report.roles = settings.roles.map(r => ({ role: r.role, provider: r.provider, model: r.model }));
  assert.ok(!settings.catalog.providers.some(p => (p.id === "claude" || p.id === "codex") && p.available), "Claude and Codex are off in the harness");

  // 1. An agent on Acme ACP in a tracked workspace calls a follow_* tool through the MCP server Paseo gave it.
  // Untracked roots, as in check-native-tools: with default tracking on, a new agent's first session opens before
  // discovery records its workspace and gets only the bridge env (index.server.ts session_open), on any provider.
  await call("follow.set-follow-settings", { enable_follow_every: false });
  const api = createPaseoApi(client);
  const dir = join(root, "projects", "acme-app"); await fs.mkdir(dir, { recursive: true });
  const w = await api.workspaces.create({ title: "Acme checkout fixes", source: { kind: "directory", path: dir } });
  const agent = await w.agents.create({ config: { provider: `${PROVIDER}/acme-1`, modeId: "default" }, title: "Checkout agent" });
  await waitUntil("tracking the workspace", async () => { try { await call("follow.activate", { workspaceId: w.id }); return true; } catch { return false; } }, { baseMs: 30_000 });
  await client.sendAgentMessage(agent.id, "Check where this workspace stands: call follow_workspace_status.");
  const mcpRecord = await waitUntil("the fake ACP agent's tool call", async () => (await records()).find(r => r.kind === "mcp") ?? null, { baseMs: 60_000 });
  const all = await records();
  const opened = all.filter(r => r.kind === "session/new" || r.kind === "session/load" || r.kind === "session/resume").filter(r => (r.params.mcpServers ?? []).length);
  const followTools = Object.values(mcpRecord.listed).flat().map(t => t.name).filter(n => n.startsWith("follow_"));
  report.tools = { servers: Object.keys(mcpRecord.listed), followTools: followTools.length, sample: followTools.slice(0, 8), error: mcpRecord.error };
  assert.ok(followTools.includes("follow_workspace_status"), `follow_* tools listed: ${followTools.join(", ")}`);
  const allTools = Object.values(mcpRecord.listed).flat().map(t => t.name);
  report.tools.needsYou = allTools.filter(n => /needs_you/.test(n));
  assert.ok(mcpRecord.result && !mcpRecord.result.isError, `follow_workspace_status answered: ${JSON.stringify(mcpRecord.result ?? mcpRecord.error).slice(0, 400)}`);
  const status = JSON.parse(mcpRecord.result.content[0].text.replace(/^[^{]*/, ""));
  assert.equal(status.id, w.id, "the tool answers for the agent's own workspace (caller identity from the daemon)");
  report.call = { tool: "follow_workspace_status", workspaceId: status.id === w.id ? "own workspace" : status.id, detail: status.detail ?? null };
  // The instructions an ACP agent can't get in its system prompt, through the tool every description points at.
  assert.ok(allTools.includes("follow_session_instructions"), "the ACP agent is offered follow_session_instructions");
  await client.sendAgentMessage(agent.id, "Read your instructions: call follow_session_instructions.");
  const read = await waitUntil("the instructions tool call", async () => (await records()).find(r => r.kind === "mcp" && r.tool === "follow_session_instructions") ?? null, { baseMs: 60_000 });
  const instructionsText = read.result?.content?.[0]?.text ?? "";
  report.instructionsTool = { chars: instructionsText.length, start: instructionsText.slice(0, 80) };
  assert.ok(read.result && !read.result.isError && /follow_needs_you|follow_wait_for_checks|follow_workspace_status/.test(instructionsText), `follow_session_instructions answered with Follow-up's instructions: ${instructionsText.slice(0, 200)}`);

  // What instruction text reached the agent: the session/new params (any field but mcpServers), the prompts, the env.
  const FOLLOW_TEXT = /Follow-up|follow_workspace_status|needs_you|register_pr/;
  const sessionText = opened.map(r => JSON.stringify({ ...r.params, mcpServers: undefined })).join("\n");
  // Only what Paseo put in the session itself: not our own prompts here, nor Follow-up's turn-end check messages.
  const promptText = all.filter(r => r.kind === "prompt" && !/^Follow-up turn-end check:/.test(r.text)).map(r => r.text).join("\n");
  const spawnEnv = all.filter(r => r.kind === "spawn").map(r => r.followUpEnv);
  report.instructions = {
    sessionNewKeys: [...new Set(opened.flatMap(r => Object.keys(r.params)))],
    inSessionNew: FOLLOW_TEXT.test(sessionText),
    inPrompt: FOLLOW_TEXT.test(promptText.replace("call follow_workspace_status.", "").replace("call follow_session_instructions.", "")),
    promptBlocks: all.filter(r => r.kind === "prompt").map(r => r.blocks),
    followUpEnv: spawnEnv.at(-1) ?? {},
  };
  log("instructions reaching the ACP agent:", JSON.stringify(report.instructions));

  // 2. Settings → Agents, desktop and phone, light and dark.
  const SERVER_ID = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const fallback = settings.roles.filter(r => r.provider === PROVIDER).length;
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) for (const scheme of ["light", "dark"]) {
    const name = `agents-${device}-${scheme}`;
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: device === "phone" ? 2 : 1.25, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/agents`);
      await page.locator(`[data-testid="plugin-settings-tab-agents"]`).filter({ visible: true }).first().waitFor();
      const line = page.getByText(/reads Follow-up's instructions from a tool/).first();
      await line.waitFor();
      await page.getByText(LABEL).first().waitFor();
      await line.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const facts = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.right > vw + 1 && s.visibility !== "hidden" && !e.closest('[style*="overflow"]'); }).map(e => `${e.tagName}.${(e.getAttribute("data-testid") ?? e.textContent ?? "").slice(0, 40)}`);
        const leaf = [...document.querySelectorAll("div")].find(d => /reads Follow-up's instructions from a tool/.test(d.textContent ?? "") && d.children.length === 0);
        let el = leaf?.parentElement && /read other people's messages/.test(leaf.parentElement.textContent ?? "") ? leaf.parentElement : leaf;
        const r = el?.getBoundingClientRect();
        return { pageScrolls: document.scrollingElement.scrollWidth > vw + 1, wide: wide.slice(0, 5), line: el?.innerText ?? null, lineBox: r ? { left: r.left, right: r.right, width: Math.round(r.width), lines: Math.round(r.height / (parseFloat(getComputedStyle(el).lineHeight) || 20)), vw } : null, notes: [...document.querySelectorAll("div")].filter(d => d.children.length === 0 && /^(On Acme ACP, |Not available in Paseo|Your agents on )/.test(d.textContent ?? "")).map(d => ({ text: (d.textContent ?? "").slice(0, 40), width: Math.round(d.getBoundingClientRect().width) })), priority: (() => {
          const sw = document.querySelector('[role="switch"][aria-label="AI priority"]');
          let row = sw; while (row && !(row.innerText ?? "").includes("Sorts Home")) row = row.parentElement;
          while (row?.parentElement && !/Recovery|Overseer|Summaries/.test(row.parentElement.innerText ?? "") ) row = row.parentElement;
          const amber = [...(row?.querySelectorAll("div") ?? [])].find(d => d.children.length === 0 && /^AI priority reads other people's messages/.test(d.textContent ?? ""));
          let opacity = 1; for (let e = amber; e && e !== document.body; e = e.parentElement) opacity *= parseFloat(getComputedStyle(e).opacity);
          const pickerButton = [...(row?.querySelectorAll('[role="button"], button') ?? [])].some(b => /No provider here can run it/.test(b.textContent ?? ""));
          return sw ? { label: sw.textContent, hint: sw.getAttribute("aria-description") ?? sw.getAttribute("title") ?? null, amberOpacity: amber ? opacity : null, pickerButton, checked: sw.getAttribute("aria-checked"), disabled: sw.getAttribute("aria-disabled") === "true" || sw.hasAttribute("disabled"), text: row?.innerText ?? null } : null;
        })(), text: document.body.innerText };
      });
      assertNoRealNames(facts.text, name);
      assert.equal(facts.pageScrolls, false, `${name}: the page scrolls sideways`);
      assert.ok(facts.lineBox && facts.lineBox.left >= 0 && facts.lineBox.right <= facts.lineBox.vw + 1, `${name}: the line overflows ${JSON.stringify(facts.lineBox)}`);
      const claudePick = /\bClaude\b(?! Code)/.test(facts.text.split(new RegExp(`^${LABEL} reads Follow-up`, "m"))[0].replace(/with Claude, Haiku[^.]*\./, "").replace(/other than Claude or Codex/g, "").replace(/need[s]? Claude or Codex/g, ""));
      assert.ok(facts.priority, `${name}: AI priority's switch is on the page`);
      assert.equal(facts.priority.label, "Unavailable", `${name}: AI priority's switch reads Unavailable`);
      assert.equal(facts.priority.disabled, true, `${name}: AI priority's switch is disabled with no guarded provider`);
      assert.doesNotMatch(facts.priority.text ?? "", /Recommended/, `${name}: AI priority shows no Recommended chip on an unguarded provider`);
      assert.match(facts.priority.text ?? "", /No provider here can run it/, `${name}: AI priority's picker says no provider here can run it`);
      assert.equal(facts.priority.pickerButton, false, `${name}: AI priority's picker is static text, not a button`);
      assert.doesNotMatch(facts.priority.text ?? "", /Claude · |Codex · /, `${name}: AI priority's picker shows no unavailable Claude or Codex pick`);
      assert.doesNotMatch(facts.priority.text ?? "", /Reads a lot and has to give reasons/, `${name}: AI priority's need line is hidden while blocked`);
      assert.equal(facts.priority.amberOpacity, 1, `${name}: AI priority's reason is drawn at full opacity`);
      assert.doesNotMatch(facts.text, /Pick Claude|Not in Paseo/, `${name}: no "Pick Claude" and no provider census`);
      const path = join(out, `${name}.png`);
      await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide" });
      report.shots.push({ name, path: relative(process.cwd(), path), line: facts.line, lineBox: facts.lineBox, notes: facts.notes, priority: facts.priority, offscreen: facts.wide, claudeInRows: claudePick, acmeInRows: (facts.text.match(new RegExp(LABEL, "g")) ?? []).length });
      log(`${name}: ${path}`);
    } catch (error) {
      await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {});
      throw new Error(`shot ${name}: ${error.message}`);
    } finally { await context.close(); }
  }
  report.fallbackRoles = fallback;
  await fs.writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  // Paseo 0.17.4 passes no plugin instructions to an ACP agent (inSessionNew false above): the line says it reads them through a tool.
  for (const shot of report.shots) {
    const lines = (shot.line ?? "").split("\n").map(l => l.trim()).filter(Boolean);
    assert.equal(lines.length, 2, `${shot.name}: the notes block is two lines: ${JSON.stringify(shot.line)}`);
    assert.match(lines[0], new RegExp(`^${LABEL} reads Follow-up's instructions from a tool at the start of each session\\. Nothing to set up\\.$`), `${shot.name}: first line ${JSON.stringify(lines[0])}`);
    assert.match(lines[1], /^Compass, Ask and Summaries' linked issues read other people's messages/, `${shot.name}: second line ${JSON.stringify(lines[1])}`);
  }
  assert.equal(report.instructions.inSessionNew || report.instructions.inPrompt, false, "no instruction text was claimed in the ACP session itself; it comes through the tool");
  assert.equal(report.instructions.followUpEnv.FOLLOW_UP_SYSTEM_PROMPT, undefined, "the session env claims no system-prompt text an ACP agent never gets");
} catch (error) {
  console.error(error?.stack ?? error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise(r => daemon.once("exit", r)); }
  if (process.exitCode) console.error(`kept ${root} (daemon.log, acp-record.jsonl)`); else await fs.rm(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
