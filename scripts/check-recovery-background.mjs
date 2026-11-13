// recovery-is-quiet-keeps-its-tools-and-unloads (plan #8): the recovery agent on a running `npm run preview`, on
// Paseo 0.16 (HARNESS_PASEO=0.16) and 0.15. Synthetic fixture agents only.
//   node scripts/check-recovery-background.mjs [--shots <dir>]
// Checks: background exactly when the host advertises features.backgroundAgents; left out of the default agent list
// there; its Follow-up tools survive a second session (reload reruns session_open); after acknowledge it is idle with
// nothing that vetoes Paseo's idle-runtime cleanup; a later recovery still works; and that "Open recovery agent" opens it.
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";

await harness();
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const p = JSON.parse(await readFile(".preview-isolated.json", "utf8"));
assert.ok(p.root.startsWith("/tmp/follow-install-") && p.home === p.root + "/home", "an isolated preview, never ~/.paseo");
const env = harnessEnv(p.root, { home: p.home, set: { PASEO_DAEMON_URL: `ws://127.0.0.1:${p.port}/ws` } });
await writeFile(p.root + "/fixture/index.server.ts", await readFile("scripts/fixture-provider.ts", "utf8"));
await promisify(execFile)("paseo", ["--home", p.home, "plugin", "reload", "followup-fixture", "--json"], { env, timeout: 120000 });

const c = new DaemonClient({ url: env.PASEO_DAEMON_URL, clientId: "recovery-background-check", clientType: "cli", reconnect: { enabled: false } });
await c.connect();
const api = createPaseoApi(c);
const call = (name, input = {}) => c.invokePluginRpc("follow-up", name, input);
const wait = async (fn, label, tries = 80) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 500)); } throw Error("Timed out: " + label); };
// The host: this repo's @getpaseo/client (0.14) parses server_info with its own schema and drops feature names newer
// than itself, so read the version of the CLI harness-slot pinned instead (the plugin worker uses the host's client).
const { stdout: cliVersion } = await promisify(execFile)("paseo", ["--version"], { env, timeout: 30000 });
const [, minor] = /(\d+)\.(\d+)\.\d+/.exec(cliVersion).slice(1).map(Number);
const host016 = minor >= 16; // features.backgroundAgents arrived in Paseo 0.16
const host = host016 ? "0.16" : "0.15";
const cases = [];
const record = (name, ok, detail = "") => { cases.push({ host, name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} [${host}] ${name}${detail ? ` (${detail})` : ""}`); };

const directory = join(p.root, "recovery-background-workspace"); await mkdir(directory, { recursive: true });
const w = await api.workspaces.create({ title: "Recovery background check", source: { kind: "directory", path: directory } });
const main = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default", providerOptions: { fixture_marker: "recovery-bg", fixture_mode: "deferred" } }, title: "Recovery background main" });
await call("follow.activate", { workspaceId: w.id });
await call("follow.enroll", { agentId: main.id, goal: "Check the recovery agent stays quiet" });

const recover = async () => {
  await call("follow.recover", { workspaceId: w.id });
  const ws = await wait(async () => { const v = (await call("follow.get", { workspaceId: w.id })).workspace; return v.batches.some(b => b.state === "sent" && b.recipientAgentId && b.tasks.every(t => t.kind === "inventory") && !b.settledAt) ? v : null; }, "recovery sent");
  return ws.batches.find(b => b.state === "sent" && b.tasks.every(t => t.kind === "inventory") && !b.settledAt);
};
const batch = await recover();
const agentId = batch.recipientAgentId;
const snap = (await c.fetchAgent(agentId))?.agent;
record("background exactly when the host advertises backgroundAgents", (snap?.background === true) === host016, `background=${snap?.background ?? "absent"}`);
const listed = (await c.fetchAgents({})).entries.some(e => e.agent.id === agentId);
record(host016 ? "left out of the default agent list (no sidebar row)" : "listed as today", listed === !host016, `listed=${listed}`);

const toolsIn = async () => { const cfg = JSON.parse(await readFile(join(p.home, `fixture-agent-config-${agentId}.json`), "utf8")); return { recovery: cfg.env?.FOLLOW_UP_RECOVERY === "1", tools: !!cfg.env?.FOLLOW_UP_TOOLS || Object.keys(cfg.mcpServers ?? {}).length > 0 }; };
const first = await toolsIn();
record("first session has Follow-up's recovery tools", first.recovery && first.tools, JSON.stringify(first));
await api.agents.ref(agentId).reload().catch(e => record("reload", false, String(e)));
await new Promise(r => setTimeout(r, 1500));
const second = await toolsIn();
record("second session (reload reruns session_open) keeps them", second.recovery && second.tools, JSON.stringify(second));

await call("follow.acknowledge", { agentId, batchId: batch.id, outcome: "completed", result: "Synthetic recovery result: nothing missed" });
const settled = await wait(async () => { const a = (await c.fetchAgent(agentId))?.agent; return a && a.status === "idle" ? a : null; }, "recovery idle after acknowledge");
const work = Number(settled.backgroundWork?.count ?? 0);
const collectable = settled.status === "idle" && !(settled.activeTurn && settled.activeTurn.id) && (settled.pendingPermissions ?? []).length === 0 && !(work > 0);
record("after acknowledge: idle, no turn, no permission, no background work (host-collectable)", collectable, `status=${settled.status} perms=${(settled.pendingPermissions ?? []).length} work=${work}`);

const next = await recover();
record("a later recovery still starts", !!next.recipientAgentId, `recipient=${next.recipientAgentId === agentId ? "same agent" : "new agent"}`);
await call("follow.acknowledge", { agentId: next.recipientAgentId, batchId: next.id, outcome: "blocked", result: "Synthetic failure: the history was unreadable" });
const failed = await wait(async () => { const a = (await c.fetchAgent(next.recipientAgentId))?.agent; return a && a.status === "idle" ? a : null; }, "idle after a failed batch");
record("after a failed batch: host-collectable too", failed.status === "idle" && (failed.pendingPermissions ?? []).length === 0 && !(Number(failed.backgroundWork?.count ?? 0) > 0));

// The panel's Recovery row, and what "Open recovery agent" does on this host.
// Renders go into PRs: harnessEnv pins the daemon's hostname to a fictional one; this is the backstop (as in
// scripts/screenshots.mjs): a page that names the real machine fails instead of being saved.
const REAL_HOST = [hostname(), hostname().split(".")[0]].filter(h => h.length >= 4);
const noRealHost = async page => {
  const text = await page.evaluate(() => `${document.title}\n${document.body.innerText}`);
  const hit = REAL_HOST.find(h => text.includes(h));
  if (hit) throw new Error(`the page shows the real hostname (${hit}); a harness daemon must report HARNESS_HOST`);
};
const { chromium } = createRequire(process.env.PLAYWRIGHT_CORE + "/package.json")("playwright-core");
const profile = await mkdtemp(join(tmpdir(), "follow-recovery-bg-browser-"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  try {
    await fetch(`http://127.0.0.1:${p.port}/llms.txt`);
    await page.goto(`http://127.0.0.1:${p.port}/`);
    // A fresh profile opens "What's new in Follow-up 2.0.0" (a major) over everything: close it first.
    const dismissNotes = async () => {
      const notes = page.getByText(/^What's new in Follow-up/).first();
      if (!await notes.waitFor({ timeout: 4000 }).then(() => true, () => false)) return;
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      if (await notes.isVisible().catch(() => false)) await page.getByRole("dialog").getByRole("button").first().click();
      await notes.waitFor({ state: "hidden", timeout: 10000 });
    };
    const openWorkspace = async () => {
      await dismissNotes();
      await page.getByRole("button", { name: /^Recovery background check/ }).first().click();
      await page.mouse.move(900, 400); // the sidebar row's hover card names the host machine: never in a render
    };
    // Older hosts label the panel toggle "Open workspace follow-up"; 0.15.4 and 0.16 put a "Follow-up" icon in the
    // workspace header (the first "Follow-up" button is the sidebar's Home link).
    // On a 0.16 phone the panels sit behind "Open Explorer sidebar", where Follow-up is a tab.
    const panelToggle = () => ({ click: async () => {
      const legacy = page.getByRole("button", { name: "Open workspace follow-up", exact: true }).first();
      if (await legacy.isVisible().catch(() => false)) return legacy.click();
      const explorer = page.getByRole("button", { name: "Open Explorer sidebar", exact: true });
      if (page.viewportSize().width < 600 && await explorer.isVisible().catch(() => false)) await explorer.click();
      // The Follow-up tab may already be the open one (the phone keeps the last panel): then this click is a no-op.
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click({ timeout: 5000 }).catch(() => undefined);
    } });
    // The Recovery block says it once (recovery-offers-one-primary-action): Retry after a failure, Run otherwise.
    const actionShown = name => page.getByRole("button", { name, exact: true }).filter({ visible: true }).count().then(n => n > 0);
    const rows = async state => {
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`http://127.0.0.1:${p.port}/`);
      await openWorkspace();
      for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
        if (label === "phone") { await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: "dark" }); }
        await panelToggle().click();
        const fold = page.getByRole("button", { name: /Spec, agent and recovery/ }).first();
        await fold.waitFor({ timeout: 30000 });
        if (await fold.getAttribute("aria-expanded") !== "true") await fold.click();
        await page.getByText(state === "failed" ? "Recovery needs a check" : "Last recovery finished", { exact: true }).first().waitFor({ timeout: 30000 });
        const open = page.getByRole("button", { name: "Open recovery agent", exact: true }).first();
        const shown = await open.isVisible().catch(() => false);
        record(`${state} ${label}: the Recovery row offers "Open recovery agent"`, shown, `visible=${shown}`);
        const run = await actionShown("Run recovery"), retry = await actionShown("Retry recovery");
        record(`${state} ${label}: one primary action, ${state === "failed" ? "Retry recovery" : "Run recovery"}`, state === "failed" ? retry && !run : run && !retry, `run=${run} retry=${retry}`);
        await page.getByText("Recovery", { exact: true }).first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width, "no horizontal overflow");
        if (shots) { await noRealHost(page); await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, `recovery-row-${host}-${state}-${label}.png`) }); }
        if (state === "failed" && label === "desktop" && host016 && shown) {
          // openAgent on a background agent: it opens a "Follow-up recovery" tab with the agent's chat (plan #8 item 3).
          await open.click();
          await page.waitForTimeout(2500);
          const url = page.url();
          const opens = url.includes(agentId) || await page.getByText("Follow-up recovery", { exact: true }).first().isVisible().catch(() => false);
          record("pressing it opens the background agent's chat in a tab (openAgent works, so the button stays)", opens, `url=${url.replace(/^https?:\/\/[^/]+/, "")}`);
          if (shots) { await noRealHost(page); await page.screenshot({ path: join(shots, `recovery-open-${host}-desktop.png`) }); }
          await page.goto(`http://127.0.0.1:${p.port}/`);
          await openWorkspace();
        }
      }
    };
    await rows("failed");
    // Idle: one more recovery that finishes.
    const last = await recover();
    await call("follow.acknowledge", { agentId: last.recipientAgentId, batchId: last.id, outcome: "completed", result: "Synthetic recovery result: nothing missed" });
    await rows("idle");
  } catch (error) {
    // Show what the page had, so a selector miss is readable without a rerun.
    await page.mouse.move(900, 400).catch(() => undefined);
    if (shots) await page.screenshot({ path: join(shots, "debug-fail.png"), clip: { x: 320, y: 40, width: 1120, height: 960 } }).catch(() => undefined);
    const names = await page.getByRole("button").evaluateAll(els => els.map(e => e.getAttribute("aria-label") || e.textContent?.trim()).filter(Boolean).slice(0, 80)).catch(() => []);
    console.error("Buttons on the page:", JSON.stringify(names));
    throw error;
  }
  await page.close();
} finally { await browser.close(); await rm(profile, { recursive: true, force: true }); }

await writeFile(join(p.root, `recovery-background-${host}.json`), JSON.stringify(cases, null, 2));
await api.dispose?.(); await c.close();
const failedCases = cases.filter(x => !x.ok);
console.log(JSON.stringify(cases));
if (failedCases.length) { console.error(`FAIL: ${failedCases.length} case(s)`); process.exit(1); }
console.log(`PASS: recovery background check on Paseo ${host}`);
