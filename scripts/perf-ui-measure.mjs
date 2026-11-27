// node scripts/perf-ui-measure.mjs <info.json> <out.json> <phone|desktop> [--walk] [--idle 60]
// Measures every surface on a held perf daemon (scripts/perf-ui-setup.mjs). --walk counts rendered components per
// commit (slower; use its render counts, not its times).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { harness } from "./harness.mjs";
import { launch } from "./perf-ui-lib.mjs";
import { homeUrl } from "./ui-home.mjs";

await harness();
const [infoPath, outPath, profile = "desktop"] = process.argv.slice(2);
const WALK = process.argv.includes("--walk");
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };
const IDLE_S = Number(arg("idle", "60")); const ONLY = arg("only", null)?.split(",");
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const shots = join(dirname(outPath), "shots"); mkdirSync(shots, { recursive: true });
const phone = profile === "phone";
const results = { profile, walk: WALK, at: new Date().toISOString(), steps: [], errors: [], worker: [] };
const workerPid = () => Number(readFileSync(join(info.home, "plugin-data/follow-up/worker.lock"), "utf8").split(":")[0]);
const hz = 100;
const workerSample = () => { try { const pid = workerPid(); const st = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); const status = readFileSync(`/proc/${pid}/status`, "utf8"); return { at: Date.now(), cpuS: (Number(st[11]) + Number(st[12])) / hz, rssMb: Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024) }; } catch { return null; } };

const s = await launch({ profile, walk: WALK });
const { page, measure } = s;
const btn = (re, opts = {}) => page.getByRole("button", { name: re, ...opts });
const visible = loc => () => loc.first().waitFor({ state: "visible", timeout: 30_000 });
const PROF = arg("cpu-prof", null)?.split(",") ?? [];
const topFns = profile => {
  const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; let total = 0;
  profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame; if (["(idle)", "(program)", "(garbage collector)"].includes(f.functionName) && f.functionName !== "(garbage collector)") return; const k = `${f.functionName || "(anon)"} ${(f.url || "").split("/").pop().slice(0, 40)}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); total += (dt[i] || 0) / 1000; });
  return { totalMs: Math.round(total), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v)]) };
};
const step = async (name, fn) => {
  if (ONLY && !ONLY.some(o => name.startsWith(o))) return;
  const prof = PROF.some(p => name.startsWith(p));
  if (prof) { await s.cdp.send("Profiler.enable"); await s.cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await s.cdp.send("Profiler.start"); }
  try { const r = await fn(); if (prof) { const { profile: cp } = await s.cdp.send("Profiler.stop"); r.cpu = topFns(cp); writeFileSync(join(shots, `${profile}-${name}.cpuprofile`), JSON.stringify(cp)); } if (r) { results.steps.push(r); console.log(`${name}: paint ${r.toPaintMs} ms, script ${r.scriptMs} ms, commits ${r.commits}, rendered ${r.renderedTotal}+${r.mountedTotal} mounted, rpc ${r.rpc.map(x => `${x.key}×${x.sent || x.recv} ${x.downBytes}B`).slice(0, 4).join("; ")}`); } }
  catch (e) { if (prof) await s.cdp.send("Profiler.stop").catch(() => {}); results.errors.push({ name, error: String(e).slice(0, 400) }); console.log(`${name}: ERROR ${String(e).slice(0, 200)}`); await page.screenshot({ path: join(shots, `${profile}-${name}-error.png`) }).catch(() => {}); }
};
const idle = async (label) => {
  await s.reset(); const w0 = workerSample(); const m0 = await s.metrics();
  await page.waitForTimeout(IDLE_S * 1000);
  const m1 = await s.metrics(); const w1 = workerSample();
  const perf = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
  const r = { label, idleS: IDLE_S, scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), commits: perf.commits,
    rendered: Object.entries(perf.rendered).sort((a, b) => b[1] - a[1]).slice(0, 20), renderedTotal: Object.values(perf.rendered).reduce((a, b) => a + b, 0),
    rpc: [...s.rpc.rows.values()], worker: w0 && w1 ? { cpuPct: Math.round((w1.cpuS - w0.cpuS) / ((w1.at - w0.at) / 1000) * 1000) / 10, rssMb: w1.rssMb } : null, jsHeapMb: Math.round(m1.JSHeapUsedSize / 1048576), nodes: m1.Nodes };
  console.log(`${label}: ${r.commits} commits, script ${r.scriptMs} ms in ${IDLE_S}s, rpc ${r.rpc.map(x => `${x.key}×${x.sent + x.recv} ${x.downBytes}B`).join("; ")}, worker ${JSON.stringify(r.worker)}`);
  return { ...r, toPaintMs: null, mountedTotal: 0 };
};

try {
  // ---------- bundle + Home first open ----------
  await page.goto(info.origin); await page.waitForTimeout(4000);
  const scripts = new Map();
  page.on("response", async r => { const u = r.url(); if (/\.(m?js)(\?|$)|plugin/.test(u) && r.request().resourceType() === "script") { const b = await r.body().catch(() => null); scripts.set(u, b ? b.length : null); } });
  await s.browser.startTracing(page, { categories: ["devtools.timeline", "v8", "disabled-by-default-devtools.timeline"] });
  await step("home-first-open", () => measure("home-first-open", () => page.goto(homeUrl(info.origin, info.serverId)), visible(page.getByRole("textbox", { name: /^Search/ })), { settleMs: 4000 }));
  const trace = JSON.parse((await s.browser.stopTracing()).toString());
  const evals = {};
  for (const e of trace.traceEvents) {
    if (!e.dur) continue;
    const url = e.args?.data?.url || e.args?.data?.fileName || e.args?.fileName || "";
    if (["EvaluateScript", "v8.compile", "v8.compileModule", "v8.evaluateModule", "v8.parseOnBackground", "FunctionCall"].includes(e.name)) {
      const k = `${e.name} ${url.replace(info.origin, "").slice(0, 120)}`; evals[k] = (evals[k] || 0) + e.dur / 1000;
    }
  }
  results.bundle = { scripts: [...scripts].map(([u, b]) => ({ url: u.replace(info.origin, ""), bytes: b })), evalMs: Object.entries(evals).filter(([, v]) => v > 5).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]) };
  await page.getByRole("button", { name: "Close", exact: true }).last().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(shots, `${profile}-home.png`) });

  // ---------- Home ----------
  const rows = page.getByRole("button", { name: /^Synthetic workspace \d+ (›|\.)/ });
  await step("home-row-1", () => measure("home-row-1 (open row 1)", () => rows.nth(0).click(), null));
  await page.screenshot({ path: join(shots, `${profile}-home-row1.png`) });
  if (phone) { await page.goBack().catch(() => {}); await page.waitForTimeout(2000); }
  await step("home-row-2", () => measure("home-row-2 (switch to row 2)", () => rows.nth(1).click(), null));
  if (phone) { await page.goBack().catch(() => {}); await page.waitForTimeout(2000); }
  await step("home-row-ws0", () => measure("home-row-ws0 (open the 300-question workspace's row)", () => page.getByRole("button", { name: /^Synthetic workspace 0 › / }).first().click(), null, { settleMs: 2500 }));
  await page.screenshot({ path: join(shots, `${profile}-home-ws0.png`) });
  await step("home-pane-q", () => measure("home-pane-q (open a question in Home's decision pane)", () => btn(/^Show Q5:/).first().click(), visible(page.getByRole("radiogroup", { name: "Options for Q5" }))));
  if (phone) { await page.goBack().catch(() => {}); await page.waitForTimeout(2000); }
  const search = page.getByRole("textbox", { name: /^Search/ }).first();
  // With --only, the phone's goBack()s above undo row opens that never ran and leave Home: come back to it first.
  if (!await search.isVisible().catch(() => false)) { await page.goto(homeUrl(info.origin, info.serverId)); await search.waitFor({ timeout: 30_000 }); await page.waitForTimeout(2000); }
  await step("home-search", () => measure("home-search (type 'ledger')", async () => { await search.click(); await search.pressSequentially("ledger", { delay: 60 }); }, null));
  await step("home-search-clear", () => measure("home-search-clear", async () => { await search.fill(""); }, null));
  await page.keyboard.press("Escape").catch(() => {});
  await step("home-sort", () => measure("home-sort (open the sort menu)", () => btn(/^Sort: /).first().click(), visible(page.getByRole("menuitem").first())));
  await page.keyboard.press("Escape"); await page.waitForTimeout(800);
  await step("home-filter", () => measure("home-filter (Needs you only)", () => btn(/^Needs you, \d+\. Show only these/).first().click(), null));
  await btn(/^Needs you, \d+\. /).first().click().catch(() => {}); await page.waitForTimeout(1500);
  await step("home-fold", () => measure("home-fold (fold Needs you group)", () => btn(/^Needs you, \d+\. Collapse/).first().click(), null));
  await btn(/^Needs you, \d+\. Expand/).first().click().catch(() => {}); await page.waitForTimeout(1000);
  await step("home-idle", () => idle("home-idle"));

  // ---------- Catch up, New, Settings ----------
  await step("catch-up", () => measure("catch-up (open)", () => btn(/^Catch up on/).first().click(), null, { settleMs: 2500 }));
  await page.screenshot({ path: join(shots, `${profile}-catchup.png`) });
  await page.goto(homeUrl(info.origin, info.serverId)); await page.getByRole("toolbar", { name: "Status", exact: true }).first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(2000);
  await step("new", () => measure("new (open Dispatch)", () => btn(/^Dispatch/).first().click(), null, { settleMs: 2500 }));
  await page.screenshot({ path: join(shots, `${profile}-new.png`) });
  await page.keyboard.press("Escape"); await page.waitForTimeout(1000);
  await page.goto(homeUrl(info.origin, info.serverId)); await page.getByRole("toolbar", { name: "Status", exact: true }).first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(2000);
  await step("settings", () => measure("settings (open)", () => btn(/^Follow-up settings$/).first().click(), null, { settleMs: 2500 }));
  await page.screenshot({ path: join(shots, `${profile}-settings.png`) });
  for (const tab of ["Following", "Reviewers", "Agents", "Inbox & display"])
    await step(`settings-${tab}`, () => measure(`settings tab ${tab}`, () => page.getByRole("tab", { name: new RegExp(`^${tab}`) }).or(page.getByRole("button", { name: new RegExp(`^${tab}$`) })).first().click(), null, { settleMs: 2000 }));

  // ---------- the chat timeline: three ask_question cards (scripts/perf-chat-seed.mjs) ----------
  await page.goto(`${info.origin}/h/${info.serverId}/workspace/${info.created[0].workspaceId}`); await page.waitForTimeout(5000);
  await step("chat-open", () => measure("chat-open (agent 0's chat, 3 question cards)", async () => {
    if (phone) { await btn(/^Switch tabs/).first().click(); await page.getByText("Synthetic agent 0", { exact: true }).last().click(); }
    else await btn(/^Synthetic agent 0$/).first().click();
  }, visible(btn(/^Q5 · /)), { settleMs: 2500 }));
  await page.screenshot({ path: join(shots, `${profile}-chat.png`) });
  await step("chat-q-tap", () => measure("chat-q-tap (tap the Q5 card)", () => btn(/^Q5 · /).first().click(), visible(page.getByRole("radiogroup", { name: "Options for Q5" })), { settleMs: 2000 }));
  await page.screenshot({ path: join(shots, `${profile}-chat-q5.png`) });
  await page.keyboard.press("Escape"); await page.waitForTimeout(1000);

  // ---------- the panel on the 300-question workspace ----------
  await page.goto(`${info.origin}/h/${info.serverId}/workspace/${info.created[0].workspaceId}`); await page.waitForTimeout(5000);
  if (phone) { await btn(/^Workspace actions/).first().click(); await page.waitForTimeout(1500); }
  await step("panel-open", () => measure("panel-open (header Follow-up)", () => phone ? page.getByRole("menuitem", { name: /Follow-up$/ }).first().click() : btn(/^Follow-up$/).last().click(), visible(btn(/^Needs you, \d+ open/)), { settleMs: 3000 }));
  await page.screenshot({ path: join(shots, `${profile}-panel.png`) });
  await step("panel-q-open", () => measure("panel-q-open (tap Show Q5)", () => btn(/^Show Q5:/).first().click(), visible(page.getByRole("radiogroup", { name: "Options for Q5" }))));
  await page.screenshot({ path: join(shots, `${profile}-panel-q5.png`) });
  await step("panel-q-switch", () => measure("panel-q-switch (tap Show Q29)", () => btn(/^Show Q29:/).first().click(), visible(page.getByRole("radiogroup", { name: "Options for Q29" }))));
  await step("panel-q-pick", () => measure("panel-q-pick (pick B)", () => page.getByRole("radio", { name: /^B\. / }).first().click(), null));
  await step("panel-q-close", () => measure("panel-q-close (Hide Q29)", () => btn(/^Hide Q29:/).first().click(), null));
  await step("panel-fold-needs", () => measure("panel-fold-needs", () => btn(/^Needs you, \d+ open/).first().click(), null));
  await step("panel-unfold-needs", () => measure("panel-unfold-needs", () => btn(/^Needs you/).first().click(), null));
  await step("panel-fold-prs", () => measure("panel-fold-prs", () => btn(/^Pull requests, \d+ open/).first().click(), null));
  await step("panel-unfold-prs", () => measure("panel-unfold-prs", () => btn(/^Pull requests/).first().click(), null));
  await step("panel-prs-next", () => measure("panel-prs-next (PR page 2)", () => btn(/^Next page$/).first().click(), null));
  await step("panel-tasks", () => measure("panel-tasks (unfold tasks)", () => btn(/^Agent's tasks/).first().click(), null));
  await step("panel-agent-line", () => measure("panel-agent-line (tap main agent line)", () => btn(/^Main agent\./).first().click(), null, { settleMs: 2500 }));
  await page.keyboard.press("Escape"); await page.waitForTimeout(1000);
  await step("panel-pr-row", () => measure("panel-pr-row (open a PR sheet)", () => btn(/^Pull request 500\d\d: /).first().click(), null, { settleMs: 2000 }));
  await page.keyboard.press("Escape"); await page.waitForTimeout(1000);
  await step("panel-activity-all", () => measure("panel-activity-all (Show all)", () => btn(/^Show Show all/).first().click(), null, { settleMs: 2500 }));
  await step("panel-idle", () => idle("panel-idle"));
} finally {
  results.samples = Object.fromEntries(s.rpc.samples);
  writeFileSync(outPath, JSON.stringify(results, null, 1));
  await s.browser.close();
}
