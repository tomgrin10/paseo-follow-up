// view-state-is-per-device-settings-are-per-host (plan #11): view state on a running `npm run preview`, on Paseo 0.16
// (HARNESS_PASEO=0.16) and 0.15. Synthetic data only, an isolated preview, never ~/.paseo.
//   node scripts/check-view-settings.mjs [--shots <dir>]
// Checks: a picked settings category and a folded section survive a reload, and the reload never paints the default
// category first (every frame from navigation on is sampled); on 0.16 the device document `follow-up-view` holds them
// (seeded and migrated); on 0.15 localStorage does, as before. The phone app itself is a manual check (docs/settings.md).
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { harness } from "./harness.mjs";
import { harnessEnv } from "./harness-env.mjs";

await harness();
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const p = JSON.parse(await readFile(".preview-isolated.json", "utf8"));
assert.ok(p.root.startsWith("/tmp/follow-install-") && p.home === p.root + "/home", "an isolated preview, never ~/.paseo");
const env = harnessEnv(p.root, { home: p.home, set: { PASEO_DAEMON_URL: `ws://127.0.0.1:${p.port}/ws` } });
// The repo's @getpaseo/client is older than the host: read the pinned CLI's version (as check-recovery-background does).
const { stdout: cliVersion } = await promisify(execFile)("paseo", ["--version"], { env, timeout: 30000 });
const minor = Number(/(\d+)\.(\d+)\.\d+/.exec(cliVersion)[2]);
const host = minor >= 16 ? "0.16" : "0.15";
const DOC_KEY = "@paseo:plugin-device-settings:follow-up/follow-up-view";
const cases = [];
const record = (name, ok, detail = "") => { cases.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} [${host}] ${name}${detail ? ` (${detail})` : ""}`); };

const REAL_HOST = [hostname(), hostname().split(".")[0]].filter(h => h.length >= 4);
const noRealHost = async page => {
  const text = await page.evaluate(() => `${document.title}\n${document.body.innerText}`);
  const hit = REAL_HOST.find(h => text.includes(h));
  if (hit) throw new Error(`the page shows the real hostname (${hit}); a harness daemon must report HARNESS_HOST`);
};
const { chromium } = createRequire(process.env.PLAYWRIGHT_CORE + "/package.json")("playwright-core");
const profile = await mkdtemp(join(tmpdir(), "follow-view-settings-browser-"));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM, headless: true, viewport: { width: 1440, height: 1000 }, colorScheme: "light", args: ["--disable-extensions", "--no-first-run"] });
try {
  // Every frame from the first script on: which category tab is selected. A flash of the default shows up here.
  await context.addInitScript(() => {
    const seen = (window.__categories = []);
    const sample = () => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      const name = tab?.textContent?.trim();
      if (name && seen[seen.length - 1] !== name) seen.push(name);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const page = context.pages()[0] ?? await context.newPage();
  await fetch(`http://127.0.0.1:${p.port}/llms.txt`);
  await page.goto(`http://127.0.0.1:${p.port}/`);
  const dismissNotes = async () => {
    const notes = page.getByText(/^What's new in Follow-up/).first();
    if (!await notes.waitFor({ timeout: 4000 }).then(() => true, () => false)) return;
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    if (await notes.isVisible().catch(() => false)) await page.getByRole("dialog").getByRole("button").first().click();
    await notes.waitFor({ state: "hidden", timeout: 10000 });
  };
  await dismissNotes();
  // Follow-up's settings: Home's gear (both hosts), else Paseo's Settings → Plugins → Follow-up (0.15's plugin menu).
  const tab = name => page.getByRole("tab", { name, exact: true });
  const viaHome = async () => {
    await page.getByRole("button", { name: "Follow-up", exact: true }).first().click();
    const gear = page.getByRole("button", { name: "Follow-up settings", exact: true }).filter({ visible: true }).first();
    await gear.waitFor({ timeout: 20000 }); await gear.click();
    await tab("General").waitFor({ timeout: 20000 });
  };
  const viaPlugins = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("button", { name: "Actions for follow-up", exact: true }).click();
    await page.getByRole("menuitem", { name: "Follow-up", exact: true }).click();
  };
  try { await viaHome(); } catch (error) {
    console.log(`Home's gear didn't open settings (${String(error.message).split("\n")[0]}); trying Settings → Plugins`);
    await page.goto(`http://127.0.0.1:${p.port}/`); await dismissNotes(); await viaPlugins();
  }
  await tab("General").waitFor({ timeout: 30000 });
  const selected = async () => (await page.locator('[role="tab"][aria-selected="true"]').first().textContent())?.trim();
  record("a device that never picked a category opens on General", await selected() === "General");

  await tab("Following").click();
  // Follow-up's Projects fold (it has aria-expanded); Paseo's own settings nav has a "Projects" button too.
  const projects = page.locator('[role="button"][aria-expanded]').filter({ hasText: /^Projects/ }).first();
  await projects.waitFor({ timeout: 30000 });
  const before = await projects.getAttribute("aria-expanded");
  await projects.click();
  const folded = before === "true" ? "false" : "true";
  await page.waitForFunction(([want]) => [...document.querySelectorAll('[role="button"][aria-expanded]')].some(b => b.textContent?.startsWith("Projects") && b.getAttribute("aria-expanded") === want), [folded]);
  // Leave on Reviewers: the category the reload must come back to.
  await tab("Reviewers").click();
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === "Reviewers");
  await page.waitForTimeout(1500); // the document save is async

  const stored = await page.evaluate(k => ({ doc: localStorage.getItem(k), category: localStorage.getItem("follow-up.settings.category"), fold: localStorage.getItem("follow-up.settings.fold.following.projects") }), DOC_KEY);
  record("the localStorage cache keeps the category and fold (one release)", stored.category === "reviewers" && stored.fold === (folded === "true" ? "1" : "0"), JSON.stringify({ category: stored.category, fold: stored.fold }));
  if (host === "0.16") {
    const doc = stored.doc ? JSON.parse(stored.doc) : null;
    const v = doc?.values ?? {};
    record("0.16: the device document follow-up-view holds them, migrated", v.migrated === true && v.entries?.["follow-up.settings.category"] === "reviewers" && v.entries?.["follow-up.settings.fold.following.projects"] === stored.fold && !Object.keys(v.entries ?? {}).some(k => /sort/.test(k)), stored.doc ?? "absent");
  } else {
    record("0.15: no device document (localStorage only, unchanged)", stored.doc == null, stored.doc ?? "absent");
  }

  await page.reload();
  await tab("Reviewers").waitFor({ timeout: 30000 });
  await page.waitForTimeout(2000); // let the document load and any late re-render land
  const frames = await page.evaluate(() => window.__categories);
  record("reload comes back to Reviewers and never paints General first", frames.length > 0 && frames.every(n => n === "Reviewers"), frames.join(" → "));
  await tab("Following").click();
  await projects.waitFor({ timeout: 30000 });
  record("the folded section stays folded after reload", await projects.getAttribute("aria-expanded") === folded, `aria-expanded=${await projects.getAttribute("aria-expanded")}`);

  if (host === "0.16") {
    // An agent-facing setting never moves: the Home sort still lives in the host Display document.
    const doc = JSON.parse(await page.evaluate(k => localStorage.getItem(k), DOC_KEY) ?? "{}");
    record("0.16: home_sort is not in the device document", !JSON.stringify(doc).includes("sort"));
  }
  if (shots) {
    await tab("Reviewers").click(); await page.mouse.move(0, 0); await noRealHost(page);
    await page.screenshot({ path: join(shots, `view-settings-${host}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(800); await noRealHost(page);
    await page.screenshot({ path: join(shots, `view-settings-${host}-phone.png`) });
  }

  // Home's group folds: every group persists except Needs you, which opens on every mount.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openHome = async () => {
    await page.goto(`http://127.0.0.1:${p.port}/`); await dismissNotes();
    await page.getByRole("button", { name: "Follow-up", exact: true }).first().click();
    await page.getByRole("button", { name: /^Needs you, \d+\./ }).first().waitFor({ timeout: 30000 });
  };
  await openHome();
  const needs = () => page.getByRole("button", { name: /^Needs you, \d+\./ }).first();
  const headers = await page.locator('[role="button"][aria-expanded][aria-label]').evaluateAll(els => els.map(e => e.getAttribute("aria-label")).filter(l => /^[^,]+, \d+\. (Collapse|Expand)$/.test(l) && !l.startsWith("Needs you")));
  const otherTitle = headers[0]?.split(",")[0];
  record("Home shows Needs you and another group to fold", !!otherTitle, headers.join(" | "));
  const other = () => page.getByRole("button", { name: new RegExp(`^${otherTitle}, \\d+\\.`) }).first();
  const otherBefore = await other().getAttribute("aria-expanded");
  await other().click(); await needs().click();
  record("closing Needs you holds for this mount", await needs().getAttribute("aria-expanded") === "false");
  await page.waitForTimeout(1500);
  await page.reload(); await page.getByRole("button", { name: /^Needs you, \d+\./ }).first().waitFor({ timeout: 30000 }).catch(openHome);
  await page.waitForTimeout(1500);
  record("after reload Needs you opens again", await needs().getAttribute("aria-expanded") === "true");
  const otherAfter = await other().getAttribute("aria-expanded");
  record(`after reload ${otherTitle} keeps its fold`, otherAfter !== otherBefore, `before=${otherBefore} after=${otherAfter}`);
  if (host === "0.16") {
    const doc = JSON.parse(await page.evaluate(k => localStorage.getItem(k), DOC_KEY) ?? "{}");
    const keys = Object.keys(doc.values?.entries ?? {});
    record("0.16: the device document holds the Home fold, never Needs you's", keys.some(k => k.startsWith("follow-up.home.fold.")) && !keys.includes("follow-up.home.fold.needs"), keys.join(","));
  }
  if (shots) {
    await page.mouse.move(0, 0); await noRealHost(page);
    await page.screenshot({ path: join(shots, `view-home-${host}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" }); await page.waitForTimeout(800); await noRealHost(page);
    await page.screenshot({ path: join(shots, `view-home-${host}-phone.png`) });
  }
} catch (error) {
  const page = context.pages()[0];
  const names = await page?.getByRole("button").evaluateAll(els => els.map(e => e.getAttribute("aria-label") || e.textContent?.trim()).filter(Boolean).slice(0, 80)).catch(() => []);
  console.error("Buttons on the page:", JSON.stringify(names)); throw error;
} finally {
  await context.close(); await rm(profile, { recursive: true, force: true });
}
const failed = cases.filter(c => !c.ok);
console.log(`${failed.length ? "FAIL" : "PASS"}: ${cases.length - failed.length}/${cases.length} view-settings cases on ${host}`);
process.exit(failed.length ? 1 : 0);
