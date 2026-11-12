// Who allocated in a sampling heap profile (scripts/alloc-prof.cjs): bytes per function (self) and per app frame
// with everything it called (inclusive).
//   node scripts/alloc-top.mjs <file.heapprofile> [--top 25]
import { readFileSync } from "node:fs";
const i = process.argv.indexOf("--top"); const TOP = i > 0 ? Number(process.argv[i + 1]) : 25;
const { head } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const where = n => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), incl = new Map(); let total = 0;
const walk = (n, stack) => {
  const k = where(n); const here = stack.includes(k) ? stack : [...stack, k];
  if (n.selfSize) { total += n.selfSize; self.set(k, (self.get(k) ?? 0) + n.selfSize); for (const s of new Set(here)) incl.set(s, (incl.get(s) ?? 0) + n.selfSize); }
  for (const c of n.children ?? []) walk(c, here);
};
walk(head, []);
const mb = v => (v / 1048576).toFixed(1).padStart(8);
console.log(`allocated (sampled) ${mb(total)} MB`);
console.log("-- self"); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${mb(v)} MB  ${k}`);
console.log("-- inclusive"); for (const [k, v] of [...incl].filter(([k]) => !/^\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${mb(v)} MB  ${k}`);
