// Where a .cpuprofile's time went: self time per function and inclusive time per top-level caller, optionally only in
// a time window (seconds from the profile's start), so a startup burst and the idle tail can be read apart.
//   node scripts/cpu-top.mjs <file.cpuprofile> [--from 0] [--to 10] [--top 30]
import { readFileSync } from "node:fs";
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const FROM = arg("from", 0) * 1e6, TO = arg("to", Infinity) * 1e6, TOP = arg("top", 30);
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const where = n => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), incl = new Map(); let t = 0, total = 0;
for (let i = 0; i < p.samples.length; i++) {
  t += p.timeDeltas[i]; if (t < FROM || t > TO) continue;
  const dt = p.timeDeltas[i + 1] ?? 0; total += dt;
  let n = byId.get(p.samples[i]); self.set(where(n), (self.get(where(n)) ?? 0) + dt);
  const seen = new Set();
  for (let id = n.id; id !== undefined; id = parent.get(id)) { const k = where(byId.get(id)); if (seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); }
}
const ms = v => (v / 1000).toFixed(0).padStart(7);
console.log(`window ${FROM / 1e6}s..${TO === Infinity ? "end" : TO / 1e6 + "s"} of ${(t / 1e6).toFixed(1)}s, sampled ${ms(total)} ms`);
console.log("-- self"); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${ms(v)} ms  ${k}`);
console.log("-- inclusive (app frames)"); for (const [k, v] of [...incl].filter(([k]) => /server\/|index\.server|shared\/|plugin\//.test(k)).sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${ms(v)} ms  ${k}`);
