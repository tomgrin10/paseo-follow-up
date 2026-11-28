// Perf check helpers (local): a Playwright page on a held perf daemon (scripts/perf-ui-setup.mjs), with a phone or
// desktop profile, CPU throttling, the React commit probe (perf-ui-probe.cjs) and WebSocket RPC accounting.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./harness.mjs";

// The callers take the slot first; this is re-entrant (HARNESS_SLOT_HELD), so a direct import still queues.
await harness();

const here = dirname(fileURLToPath(import.meta.url));
export const PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpu: 6 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpu: 1 },
};

/** The innermost message object carrying `type` (frames may be wrapped in envelopes). */
function inner(m, depth = 0) {
  if (!m || typeof m !== "object" || depth > 4) return null;
  if (typeof m.type === "string" && (m.method || m.requestId || /plugin|agent|workspace/.test(m.type))) return m;
  for (const k of ["message", "payload", "data", "msg"]) { const r = inner(m[k], depth + 1); if (r) return r; }
  return typeof m.type === "string" ? m : null;
}

export async function launch({ profile = "desktop", cpu, colorScheme = "light", walk = false } = {}) {
  const pw = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const p = PROFILES[profile];
  const context = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile, hasTouch: p.hasTouch, colorScheme, reducedMotion: "no-preference" });
  await context.addInitScript({ content: readFileSync(join(here, "perf-ui-probe.cjs"), "utf8").replace("walk: false", `walk: ${walk}`).replace("const sendMatch = null;", `const sendMatch = ${JSON.stringify(process.env.PERF_SEND_STACKS ?? null)};`) });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const rate = cpu ?? p.cpu;
  if (rate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  // RPC accounting: every frame, by method (plugin RPCs) or message type.
  const rpc = { pending: new Map(), rows: new Map(), on: true, samples: new Map(), subs: new Map() };
  const row = key => { let r = rpc.rows.get(key); if (!r) { r = { key, sent: 0, recv: 0, upBytes: 0, downBytes: 0 }; rpc.rows.set(key, r); } return r; };
  page.on("websocket", ws => {
    ws.on("framesent", f => {
      if (!rpc.on) return; const s = typeof f.payload === "string" ? f.payload : ""; const len = typeof f.payload === "string" ? Buffer.byteLength(f.payload) : f.payload.length;
      let m = null; try { m = inner(JSON.parse(s)); } catch {}
      const key = m ? (m.method ? `${m.type}:${m.method}` : m.type) : "binary/unknown";
      if (m?.requestId) rpc.pending.set(m.requestId, key.replace(/\.request(:|$)/, ".response$1"));
      if (!rpc.samples.has("up " + key)) rpc.samples.set("up " + key, s.slice(0, 600));
      const r = row(key); r.sent += 1; r.upBytes += len;
      if (/invoke\.request/.test(key)) (rpc.log ??= []).push({ t: Date.now(), key, input: JSON.stringify(m.input ?? m.payload?.input ?? null).slice(0, 120) });
    });
    ws.on("framereceived", f => {
      if (!rpc.on) return; const s = typeof f.payload === "string" ? f.payload : ""; const len = typeof f.payload === "string" ? Buffer.byteLength(f.payload) : f.payload.length;
      let m = null; try { m = inner(JSON.parse(s)); } catch {}
      const rid = m?.requestId ?? m?.payload?.requestId;
      let key = m ? (rid && rpc.pending.get(rid)) || (m.method ? `${m.type}:${m.method}` : m.type) : "binary/unknown";
      if (m?.type === "plugin.rpc.subscribe.response" && m.payload?.subscriptionId) rpc.subs.set(m.payload.subscriptionId, key.split(":")[1]);
      if (m?.type === "plugin.rpc.event") key = `plugin.rpc.event:${rpc.subs.get(m.payload?.subscriptionId) ?? "?"}`;
      if (!m && len > 1000) { const head = Buffer.from(f.payload).subarray(0, 300).toString("latin1"); const t = /"type":"([^"]+)"/.exec(head); if (t) key = `binary:${t[1]}`; }
      if (!rpc.samples.has("down " + key)) rpc.samples.set("down " + key, s ? s.slice(0, 600) : `binary ${len}: ` + Buffer.from(f.payload).subarray(0, 200).toString("latin1"));
      const r = row(key); r.recv += 1; r.downBytes += len;
    });
  });
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const reset = async () => { rpc.rows.clear(); await page.evaluate(() => { const p = window.__perf; p.commits = 0; p.rendered = {}; p.mounts = {}; p.events = []; p.longTasks = []; p.commitMs = 0; p.sends = []; }).catch(() => {}); };
  const setWalk = on => page.evaluate(v => { window.__perf.walk = v; }, on);
  const paint = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));

  /** Runs `action`, waits for `until`, then two frames; returns wall time, JS/task/layout time, commits, renders, RPCs. */
  async function measure(label, action, until, { settleMs = 1500 } = {}) {
    await reset();
    const m0 = await metrics(); const w0 = Date.now();
    const t0 = await page.evaluate(() => performance.now());
    await action();
    if (until) await until();
    const t1 = await paint();
    const wall = Date.now() - w0;
    const m1 = await metrics();
    // A settle window after paint: late RPC answers and the renders they cause.
    await page.waitForTimeout(settleMs);
    const m2 = await metrics();
    const perf = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const d = (a, b, k) => Math.round((b[k] - a[k]) * 1000);
    return {
      label, toPaintMs: Math.round(t1 - t0), wallMs: wall,
      scriptMs: d(m0, m1, "ScriptDuration"), taskMs: d(m0, m1, "TaskDuration"), layoutMs: d(m0, m1, "LayoutDuration"), styleMs: d(m0, m1, "RecalcStyleDuration"),
      settle: { scriptMs: d(m1, m2, "ScriptDuration"), taskMs: d(m1, m2, "TaskDuration") },
      nodes: m2.Nodes, jsHeapMb: Math.round(m2.JSHeapUsedSize / 1048576),
      commits: perf.commits, rendered: top(perf.rendered), mounts: top(perf.mounts), renderedTotal: Object.values(perf.rendered).reduce((a, b) => a + b, 0), mountedTotal: Object.values(perf.mounts).reduce((a, b) => a + b, 0),
      events: perf.events.filter(e => e.start >= t0 - 5).map(e => ({ name: e.name, duration: Math.round(e.duration), processing: Math.round(e.processing) })),
      longTasks: perf.longTasks.filter(e => e.start >= t0 - 5).map(e => Math.round(e.duration)),
      sends: perf.sends.filter(s => s.t >= t0 - 5).map(s => ({ ms: Math.round(s.t - t0), stack: s.stack })),
      rpc: [...rpc.rows.values()].sort((a, b) => b.downBytes - a.downBytes), calls: (rpc.log ?? []).filter(x => x.t >= w0).map(x => ({ ms: x.t - w0, key: x.key.replace("plugin.rpc.invoke.request:", ""), input: x.input })),
    };
  }
  return { browser, context, page, cdp, metrics, measure, reset, setWalk, paint, rpc };
}
