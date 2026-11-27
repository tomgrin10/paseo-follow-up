// Records the take for Follow-up's demo video v2 from its shot list; the edit (video/, a Remotion project) plays the
// same shots. `npm run video:v2:take -- --as-version <stable>` through ~/paseo-harness/tools/harness-slot, then
// `node render.mjs` in video/ (docs/testing.md "Demo video v2").
// v1 (scripts/demo-video.mjs) bakes its cursor and caption band into the frames. v2 records the bare app instead, twice
// as sharp (1280×800 CSS px at 2×, so the 1.6× pane framing stays crisp), and logs what the edit needs: every pointer
// position, each press, the beats, the Follow-up pane's box and the shot list (each shot's start and the UI boxes it
// frames). Writes, to --out (default video/public/take/):
//   raw.mp4    the app at 2560×1600, 30 fps, at the take's own pacing (the app's waits squeezed, as in v1)
//   take.json  { fps, seconds, view, surface, beats, pointer: [[t, x, y]], presses: [[t, x, y]],
//              shots: [{ t, name, boxes }], typing: [[from, to]] }: times in the video's seconds, CSS px of the view
// Usage: node scripts/demo-video-v2.mjs [--out <dir>] [--as-version <X.Y.Z>] [--keep-frames]
//
// The shot list (each shot holds one framing; it starts still while the camera settles, then the action happens
// inside the frame with time to read it):
//   1 Home, the whole window: the inbox, then Catch up.
//   2 Catch up, its header and every card: Allow, Skip, the recommended answer and Send.
//   3 Done while you were away: what went back to agents by itself.
//   4 Ask the Overseer: Home's search, then the question and its answer.
//   5 Home, the whole window: back to the Morning brief it opened on, so the loop is seamless.
// Boot, fixture, synthetic names and the stitch's dead-time squeeze are v1's (see its header). The pointer glides on a
// slight arc with minimum-jerk easing, as a hand moves, so the app's hover states follow the path the edit draws.
//
// Needs PLAYWRIGHT_CORE, CHROMIUM (docs/testing.md) and FFMPEG (with libx264; video/'s ffmpeg-static works:
// FFMPEG=video/node_modules/ffmpeg-static/ffmpeg after `npm --prefix video ci`).
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openHome } from "./ui-home.mjs";
import { harness } from "./harness.mjs";
import { assertNoRealNames } from "./real-names.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const log = (...a) => console.log("[take]", ...a);
function fail(message) { console.error(`demo-video-v2: ${message}`); process.exit(1); }

if (!process.env.PLAYWRIGHT_CORE || !existsSync(join(process.env.PLAYWRIGHT_CORE, "package.json"))) fail("set PLAYWRIGHT_CORE to a playwright-core directory");
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) fail("set CHROMIUM to a Chromium or chrome-headless-shell binary");
const FFMPEG = process.env.FFMPEG;
if (!FFMPEG || !existsSync(FFMPEG)) fail("set FFMPEG to an ffmpeg binary with libx264 (see the header)");
const out = resolve(arg("--out", "video/public/take"));
await harness();
const asVersion = arg("--as-version") ?? (await exec("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--exclude", "*-*"])).stdout.trim().replace(/^v/, "");

const VIEW = { width: 1280, height: 800 };
const SCALE = 2;
const FPS = 30;
const VIEW_TIME = Date.parse("2026-03-04T12:00:00.000Z"); // screenshots.mjs: BASE + VIEW
const QUESTION = "What's blocking the billing release?";
const ANSWER = "Billing retries is waiting on you. Its agent asked whether declined cards should retry (Q1), and #142's test fails until that's settled. #143, the dunning email, is approved and stacked on #142, so both can merge once you answer.";

// ---------- page helpers (run in the browser): v1's, without the drawn cursor ----------
const INIT = () => {
  try { localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "2026-03-04T09:00:00.000Z" })); localStorage.setItem("follow-up.whats-new.seen", "9.9.9"); } catch {}
};
const MODEL_LABEL = () => {
  const swap = root => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/Followup-fixture|Follow-up test agent/i.test(n.data)) n.data = n.data.replace(/Follow-up test agent · \w+|Follow-up test agent|Followup-fixture · Fixture|Followup-fixture/gi, "Claude · Opus");
  };
  const start = () => { swap(document.body); new MutationObserver(ms => { for (const m of ms) swap(m.target.nodeType === 3 ? m.target.parentNode : m.target); }).observe(document.body, { subtree: true, childList: true, characterData: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};
const HIDE_HARNESS_PROJECT = () => {
  const hide = () => {
    for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
      if (!(row.textContent ?? "").includes("overseer-home")) continue;
      const key = row.getAttribute("data-testid").slice("sidebar-project-row-".length);
      let block = row;
      for (let up = row.parentElement; up && up.querySelectorAll('[data-testid^="sidebar-project-row-"]').length === 1; up = up.parentElement) block = up;
      block.style.display = "none";
      for (const list of document.querySelectorAll(`[data-testid="sidebar-workspace-list-${key}"]`)) list.style.display = "none";
    }
  };
  const start = () => { hide(); new MutationObserver(hide).observe(document.body, { subtree: true, childList: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};

// ---------- the log ----------
const now = () => Date.now() / 1000;
const live = []; // scripted spans, kept at full length by the stitch
const pointerLog = []; const pressLog = []; const typingLog = [];
async function scripted(work) { const a = now(); try { return await work(); } finally { live.push([a, now()]); } }
const rest = (page, ms) => scripted(() => page.waitForTimeout(ms));
let pointer = { x: VIEW.width * 0.86, y: VIEW.height * 0.9 };
async function moveTo(page, x, y) { await page.mouse.move(x, y); pointerLog.push([now(), x, y]); pointer = { x, y }; }
/**
 * The shot list, recorded with the take so the edit frames exactly what was played. `shot(name, ...targets)` starts a
 * shot: the edit frames the union of every box logged for it (`frame(name, ...)` adds one mid-shot, such as the next
 * Catch up card or the Overseer's answer), so each shot holds one framing snapped to real UI bounds. No targets: the
 * whole window. Each shot starts with SETTLE of stillness while the camera eases in.
 */
const shotLog = [];
const SETTLE = 1500;
async function boxOf(target) {
  await target.waitFor();
  const b = await target.boundingBox();
  if (!b) throw new Error("shot: a target has no box");
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
async function shot(page, name, ...targets) {
  const boxes = []; for (const t of targets) boxes.push(await boxOf(t));
  shotLog.push({ t: now(), name, boxes });
  log(`shot: ${name}`);
  await rest(page, SETTLE);
}
async function frame(...targets) { for (const t of targets) shotLog.at(-1).boxes.push(await boxOf(t)); }

// ---------- motion: a hand, not a robot ----------
const minJerk = t => t * t * t * (10 - 15 * t + 6 * t * t);
let arcSide = 1;
/**
 * Glides the pointer on a shallow arc (a quadratic bezier bowed off the straight line by ~8% of the distance, sides
 * alternating) with minimum-jerk easing, the velocity profile of a human reach. Wall-clock driven, as in v1.
 */
async function glide(page, x, y, ms) {
  const from = pointer, dx = x - from.x, dy = y - from.y, d = Math.hypot(dx, dy);
  ms ??= Math.min(950, 380 + d * 0.45);
  const bow = Math.min(60, d * 0.08) * (arcSide = -arcSide);
  const cx = (from.x + x) / 2 - (dy / (d || 1)) * bow, cy = (from.y + y) / 2 + (dx / (d || 1)) * bow;
  const start = Date.now(), a = now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms), k = minJerk(t), u = 1 - k;
    await moveTo(page, u * u * from.x + 2 * u * k * cx + k * k * x, u * u * from.y + 2 * u * k * cy + k * k * y);
    if (t >= 1) break;
    await page.waitForTimeout(12);
  }
  live.push([a, now()]);
}
async function glideTo(page, locator, { ms, dx = 0.5 } = {}) {
  await locator.waitFor();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("glideTo: no box");
  await glide(page, box.x + box.width * dx, box.y + box.height / 2, ms);
  return box;
}
async function glideClick(page, locator, { ms, rest: restMs = 380, dx } = {}) {
  const box = await glideTo(page, locator, { ms, dx });
  await scripted(async () => {
    await page.waitForTimeout(restMs);
    pressLog.push([now(), pointer.x, pointer.y]);
    await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
  });
  return box;
}
const visible = locator => locator.filter({ visible: true }).first();

// ---------- run ----------
const work = await fs.mkdtemp(join(tmpdir(), "follow-take-"));
const frameDir = join(work, "frames");
let shots = null; let browser = null; let client = null;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (shots && shots.exitCode === null) {
    shots.kill("SIGINT");
    for (let i = 0; i < 300 && shots.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (shots.exitCode === null) shots.kill("SIGKILL");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void cleanup().finally(() => process.exit(130)); });

try {
  await fs.mkdir(frameDir, { recursive: true }); await fs.mkdir(out, { recursive: true });
  log(`booting the fixture (Home reads v${asVersion})`);
  const boot = () => {
    shots = spawn(process.execPath, ["scripts/screenshots.mjs", "--only", "home", "--overseer-review", "--keep", "--as-version", asVersion, "--out", join(work, "shots")], { stdio: ["ignore", "pipe", "inherit"] });
    return new Promise((resolveKept, reject) => {
      const lines = createInterface({ input: shots.stdout });
      lines.on("line", line => { if (line.startsWith("{")) resolveKept(JSON.parse(line)); else console.log(line); });
      shots.on("exit", code => reject(new Error(`screenshots.mjs exited (${code}) before the fixture was up`)));
    });
  };
  const kept = await boot().catch(error => { log(`${error.message}; booting once more`); return boot(); });
  const { root, home, port } = kept;
  const origin = `http://127.0.0.1:${port}`;
  const serverId = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
  await fs.writeFile(join(root, "clock-offset"), JSON.stringify({ fake: VIEW_TIME, real: Date.now(), rate: 0.001 }));
  await new Promise(r => setTimeout(r, 400));
  client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: "follow-take", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true });
  await client.connect();
  const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
  const overseer = await call("follow.overseer-start", {});
  if (!overseer.agentId) throw new Error(`the Overseer didn't start: ${JSON.stringify(overseer)}`);
  const scriptsFile = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8").catch(() => "{}"));
  scripts[`agent:${overseer.agentId}`] = [{ gate: "overseer" }, { item: { type: "assistant_message", text: ANSWER } }];
  await fs.writeFile(scriptsFile, JSON.stringify(scripts));
  log(`fixture up on ${origin}; Overseer ${overseer.agentId}`);

  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  for (const script of [INIT, MODEL_LABEL, HIDE_HARNESS_PROJECT]) await context.addInitScript(script);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.clock.setFixedTime(VIEW_TIME);
  await openHome(page, { origin, serverId });
  const catchUp = visible(page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }));
  await catchUp.waitFor();
  await visible(page.getByText("Ask about any workspace or agent")).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await moveTo(page, pointer.x, pointer.y);
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "Home");
  if (await page.locator('[data-testid^="sidebar-project-row-"]').filter({ hasText: "overseer-home", visible: true }).count()) throw new Error("the harness's overseer-home project still shows in the sidebar");
  // The Follow-up surface: the pane right of Paseo's sidebar that holds Home (the search's nearest ancestor as tall as
  // the view and reaching its right edge; Home's list column alone is as tall). The edit's zoomed framing is this pane
  // edge to edge, so a zoom's edges land on real UI bounds.
  const surface = await page.getByRole("textbox", { name: /^Search,? or ask the Overseer$/ }).first().evaluate(el => {
    for (let up = el.parentElement; up; up = up.parentElement) {
      const r = up.getBoundingClientRect();
      if (r.height >= innerHeight * 0.95 && r.right >= innerWidth - 2) return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
  });
  if (!surface || surface.x < 100 || surface.width > VIEW.width * 0.9) throw new Error(`no Follow-up surface pane: ${JSON.stringify(surface)}`);
  log(`surface pane ${JSON.stringify(surface)}`);

  // The take.
  const cdp = await context.newCDPSession(page);
  const frames = []; const marks = {}; let writes = Promise.resolve();
  cdp.on("Page.screencastFrame", f => {
    const file = join(frameDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ t: f.metadata.timestamp, file });
    writes = writes.then(() => fs.writeFile(file, Buffer.from(f.data, "base64")));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const mark = name => { marks[name] = now(); log(`beat: ${name}`); };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE, everyNthFrame: 1 });
  await moveTo(page, pointer.x + 1, pointer.y);
  // Shot 1, Home (the whole window): the inbox, then Catch up.
  mark("home");
  shotLog.push({ t: now(), name: "home", boxes: [] });
  await rest(page, 1600);
  await glide(page, VIEW.width * 0.62, VIEW.height * 0.46, 800);
  await rest(page, 200);
  await glideClick(page, catchUp, { ms: 700, rest: 450 });
  // Shot 2, Catch up: its header and every card it deals. Allow, Skip, the recommended answer, each read first.
  const card = page.locator("[data-catch-up-card]");
  const allow = visible(card.getByRole("button", { name: /^Allow/ }));
  await allow.waitFor();
  mark("catchup");
  const header = visible(page.getByText(/^Catch up\s*\d+ of \d+$/));
  await shot(page, "catchup", header, visible(card));
  await glideClick(page, allow, { ms: 700, rest: 600 });
  await visible(card.getByText(/#151/)).waitFor();
  await frame(visible(card));
  await rest(page, 900);
  await glideClick(page, visible(page.getByRole("button", { name: /^Skip this (?!workspace)/ })), { rest: 500 });
  const recommended = visible(card.getByRole("radio").filter({ hasText: "Recommended" }));
  await recommended.waitFor();
  await frame(visible(card));
  await rest(page, 1400);
  await glideClick(page, recommended, { rest: 450, dx: 0.2 });
  await rest(page, 350);
  const sends = page.getByRole("button", { name: /^Send to agent/ }).filter({ visible: true });
  await sends.first().waitFor();
  const tops = await sends.evaluateAll(els => els.map(e => e.getBoundingClientRect().top + window.scrollY));
  const send = sends.nth(tops.indexOf(Math.min(...tops)));
  await frame(send);
  await glideClick(page, send, { rest: 450 });
  await rest(page, 1100);
  await glideClick(page, visible(page.getByRole("button", { name: /^Leave Catch up/ })), { ms: 650, rest: 250 });
  // Shot 3, Done while you were away: what went back to agents by itself.
  const done = visible(page.getByText(/^Done while you were away$/i));
  await done.waitFor();
  mark("repairs");
  const sent2 = visible(page.getByText(/^Sent 2 repairs to the main agent/));
  const sent1 = visible(page.getByText(/^Sent 1 repair to the main agent/));
  await shot(page, "repairs", done, sent2, sent1);
  await glideTo(page, sent2, { ms: 800, dx: 0.35 });
  await rest(page, 2200);
  // Shot 4, Ask the Overseer: Home's search, then the Overseer's answer beside it.
  mark("overseer");
  const search = visible(page.getByRole("textbox", { name: /^Search,? or ask the Overseer$/ }));
  await shot(page, "overseer", search);
  await glideClick(page, search, { ms: 750, rest: 300, dx: 0.3 });
  await rest(page, 250);
  const typeFrom = now();
  await scripted(() => search.pressSequentially(QUESTION, { delay: 45 }));
  typingLog.push([typeFrom, now()]);
  const askRow = visible(page.getByRole("button", { name: /^Ask the Overseer: / }));
  await askRow.waitFor();
  await rest(page, 600);
  await glideClick(page, askRow, { ms: 600, rest: 450, dx: 0.35 });
  await visible(page.getByText(QUESTION)).waitFor();
  await rest(page, 900);
  await fs.writeFile(join(home, "fixture-gate-overseer"), "");
  const answer = visible(page.getByText(/^Billing retries is waiting on you/));
  await answer.waitFor({ timeout: 30000 });
  // The Overseer's header names its provider: the fixture's test label must read as a real model on screen.
  const shown = await page.evaluate(() => document.body.innerText);
  if (/test agent|Followup-fixture|Claude · Opus · /i.test(shown)) throw new Error("the Overseer's header still shows the fixture provider's label");
  await frame(visible(page.getByText(QUESTION)), answer);
  await glide(page, (await answer.boundingBox()).x + 120, (await answer.boundingBox()).y + 110, 900);
  await rest(page, 3000);
  // Shot 5, Home again (the whole window): back to the Morning brief, the pane it opened on, so the loop is seamless.
  mark("end");
  shotLog.push({ t: now(), name: "end", boxes: [] });
  await rest(page, 700);
  await glideClick(page, visible(page.getByText("Morning brief", { exact: true })), { ms: 800, rest: 300 });
  await rest(page, 500);
  await glide(page, VIEW.width * 0.86, VIEW.height * 0.9, 900);
  await rest(page, 1500);
  mark("stop");
  await cdp.send("Page.stopScreencast");
  await writes;
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "the last frame");
  log(`${frames.length} frames over ${(marks.stop - marks.home).toFixed(1)} s of wall clock`);

  // The stitch: v1's. Scripted spans keep their length, each wait for the app at most DEAD_MAX; frames and every
  // logged time go through the same map.
  const DEAD_MAX = 0.3;
  const t0 = Math.min(frames[0].t, marks.home), t1 = marks.stop;
  const spans = live.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    .reduce((m, [a, b]) => { const l = m.at(-1); if (l && a <= l[1]) l[1] = Math.max(l[1], b); else m.push([a, b]); return m; }, []);
  const pieces = []; let cursor = t0;
  for (const [a, b] of spans) { if (a > cursor) pieces.push([cursor, a, Math.min(a - cursor, DEAD_MAX)]); pieces.push([a, b, b - a]); cursor = b; }
  if (t1 > cursor) pieces.push([cursor, t1, Math.min(t1 - cursor, DEAD_MAX)]);
  const PACE = 1.08;
  const remap = t => { let o = 0; for (const [a, b, len] of pieces) { if (t >= b) { o += len; continue; } if (t > a) o += (t - a) / (b - a) * len; break; } return o / PACE; };
  const outT = [...frames.map(f => remap(f.t)), remap(t1)];
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.0005, outT[i + 1] - outT[i]).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  await fs.writeFile(join(work, "frames.txt"), list.join("\n") + "\n");
  const seconds = outT.at(-1);
  const raw = join(out, "raw.mp4");
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"),
    "-vf", `fps=${FPS},scale=${VIEW.width * SCALE}:${VIEW.height * SCALE}:flags=lanczos,setsar=1`, "-t", seconds.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", raw], { maxBuffer: 1 << 24 });
  const r3 = n => Math.round(n * 1000) / 1000;
  const take = {
    fps: FPS, seconds: r3(seconds), view: VIEW, scale: SCALE, surface,
    beats: Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, r3(remap(t))])),
    pointer: pointerLog.filter(([t]) => t <= t1).map(([t, x, y]) => [r3(remap(t)), r3(x), r3(y)]),
    presses: pressLog.map(([t, x, y]) => [r3(remap(t)), r3(x), r3(y)]),
    shots: shotLog.map(sh => ({ ...sh, t: r3(remap(sh.t)) })),
    typing: typingLog.map(([a, b]) => [r3(remap(a)), r3(remap(b))]),
  };
  await fs.writeFile(join(out, "take.json"), JSON.stringify(take, null, 1));
  log(`raw ${raw} (${seconds.toFixed(1)} s); take ${join(out, "take.json")}`);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (argv.includes("--keep-frames") || process.exitCode) log(`kept ${work}`); else await fs.rm(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
