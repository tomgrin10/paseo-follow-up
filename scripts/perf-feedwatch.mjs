// node scripts/perf-feedwatch.mjs <info.json> [seconds] : every follow.workspaces-feed push, which workspaces and why.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFileSync } from "node:fs";
const info = JSON.parse(readFileSync(process.argv[2], "utf8")); const secs = Number(process.argv[3] || 90);
const c = new DaemonClient({ url: `ws://127.0.0.1:${info.port}/ws`, clientId: "perf-feedwatch", clientType: "cli", reconnect: { enabled: false } });
await c.connect();
const t0 = Date.now(); const prev = new Map();
c.subscribeRawMessages(m => {
  if (m.type !== "plugin.rpc.event") return;
  const e = m.payload?.event; if (!e || !Array.isArray(e.workspaces)) return;
  const bytes = JSON.stringify(e).length;
  const rows = e.workspaces.map(w => {
    const p = prev.get(w.id); const changed = p ? Object.keys(w).filter(k => JSON.stringify(w[k]) !== JSON.stringify(p[k])) : ["(new)"];
    if (p && changed.includes("prs") && !globalThis.shown) { globalThis.shown = true; const a = p.prs[0], b = w.prs[0]; const diff = (x, y, path = "") => { if (JSON.stringify(x) === JSON.stringify(y)) return []; if (x && y && typeof x === "object" && typeof y === "object") return Object.keys({ ...x, ...y }).flatMap(k => diff(x[k], y[k], `${path}.${k}`)); return [`${path}: ${JSON.stringify(x)?.slice(0, 60)} -> ${JSON.stringify(y)?.slice(0, 60)}`]; }; console.log("PR diff", w.title, diff(a, b).slice(0, 20)); console.log("pr keys", Object.keys(b), "snapshot keys", Object.keys(b.snapshot || {}), "pr bytes", JSON.stringify(b).length); }
    prev.set(w.id, w); return `${w.title?.slice(-6)} ${JSON.stringify(w).length}B [${changed.slice(0, 8).join(",")}]`;
  });
  console.log(`${Math.round((Date.now() - t0) / 1000)}s rev ${e.revision} full=${e.full} ${bytes}B ${e.workspaces.length} ws; ${rows.slice(0, 12).join(" | ")}`);
});
c.observePluginRpc("follow-up", "follow.workspaces-feed", {});
await new Promise(r => setTimeout(r, secs * 1000));
process.exit(0);
