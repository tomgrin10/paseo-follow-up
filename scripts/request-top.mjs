// Summarises a --request-trace file: daemon client calls per minute by method and caller, for one process and a window.
//   node scripts/request-top.mjs <trace.jsonl> [--pid <pid>] [--from <epoch ms>] [--to <epoch ms>]
import { readFileSync } from "node:fs";
const [file] = process.argv.slice(2);
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : null; };
const pid = arg("pid"), from = arg("from") ?? 0, to = arg("to") ?? Infinity;
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => (!pid || r.pid === pid) && r.t >= from && r.t < to);
// Rows seen at the WebSocket (via "ws") are the requests themselves; when present, client-method rows would count twice.
const ws = rows.filter(r => r.via === "ws"); if (ws.length) rows.splice(0, rows.length, ...ws);
const minutes = rows.length ? Math.max(1, ((Number.isFinite(to) ? to : rows.at(-1).t) - (from || rows[0].t)) / 60_000) : 1;
const by = new Map();
for (const r of rows) { const k = `${r.method}  ${r.caller}`; by.set(k, (by.get(k) ?? 0) + 1); }
console.log(`${rows.length} calls over ${minutes.toFixed(1)} min`);
for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`${(n / minutes).toFixed(2).padStart(7)}/min ${String(n).padStart(5)}  ${k}`);
