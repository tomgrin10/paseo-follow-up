// Summarise a V8 heap snapshot: self size by type/constructor and the largest strings.
//   node scripts/heap-summary.mjs <file.heapsnapshot>
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.argv[2], "utf8"));
const f = s.snapshot.meta.node_fields, n = f.length, types = s.snapshot.meta.node_types[0];
const ti = f.indexOf("type"), ni = f.indexOf("name"), si = f.indexOf("self_size");
const agg = new Map(); const strings = []; let total = 0;
for (let i = 0; i < s.nodes.length; i += n) {
  const type = types[s.nodes[i + ti]]; const name = s.strings[s.nodes[i + ni]]; const size = s.nodes[i + si]; total += size;
  const key = type === "object" || type === "closure" ? `${type}:${name}` : type;
  agg.set(key, (agg.get(key) ?? 0) + size);
  if (type === "string" && size > 100_000) strings.push([size, name]);
}
const mb = v => (v / 1048576).toFixed(2).padStart(7);
console.log("heap snapshot total MB", mb(total));
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(mb(v), k.slice(0, 100));
console.log("largest strings:");
for (const [size, str] of strings.sort((a, b) => b[0] - a[0]).slice(0, 15)) console.log(mb(size), JSON.stringify(str.slice(0, 120)));
