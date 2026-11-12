// Retained sizes in a V8 heap snapshot: builds the dominator tree and lists the objects that keep the most memory
// alive, each with its retaining path from the root (e.g. "(GC roots) > Engine.store > Store.state").
//   node --max-old-space-size=8192 scripts/heap-retainers.mjs <file.heapsnapshot> [--top 25] [--min-mb 0.5]
import { readFileSync } from "node:fs";
const file = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const TOP = arg("top", 25); const MIN = arg("min-mb", 0.5) * 1048576;
const s = JSON.parse(readFileSync(file, "utf8"));
const meta = s.snapshot.meta;
const NF = meta.node_fields.length, EF = meta.edge_fields.length;
const nType = meta.node_fields.indexOf("type"), nName = meta.node_fields.indexOf("name"), nSize = meta.node_fields.indexOf("self_size"), nEdges = meta.node_fields.indexOf("edge_count");
const eType = meta.edge_fields.indexOf("type"), eName = meta.edge_fields.indexOf("name_or_index"), eTo = meta.edge_fields.indexOf("to_node");
const nodeTypes = meta.node_types[0], edgeTypes = meta.edge_types[0];
const N = s.nodes.length / NF;
const firstEdge = new Uint32Array(N + 1);
for (let i = 0, e = 0; i < N; i++) { firstEdge[i] = e; e += s.nodes[i * NF + nEdges] * EF; firstEdge[i + 1] = e; }
const weak = edgeTypes.indexOf("weak"), shortcut = edgeTypes.indexOf("shortcut");
const succ = (i, fn) => { for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) { const t = s.edges[e + eType]; if (t === weak || t === shortcut) continue; fn(s.edges[e + eTo] / NF, e); } };
// Postorder DFS from the root (node 0), iterative.
const order = new Int32Array(N).fill(-1); const post = []; const stack = [0]; const it = new Uint32Array(N); const seen = new Uint8Array(N); seen[0] = 1; it[0] = firstEdge[0];
while (stack.length) {
  const v = stack[stack.length - 1]; let pushed = false;
  while (it[v] < firstEdge[v + 1]) {
    const e = it[v]; it[v] += EF; const t = s.edges[e + eType]; if (t === weak || t === shortcut) continue;
    const w = s.edges[e + eTo] / NF; if (!seen[w]) { seen[w] = 1; it[w] = firstEdge[w]; stack.push(w); pushed = true; break; }
  }
  if (!pushed) { stack.pop(); order[v] = post.length; post.push(v); }
}
// Predecessors (reachable only).
const predCount = new Uint32Array(N); for (const v of post) succ(v, w => { predCount[w]++; });
const predStart = new Uint32Array(N + 1); for (let i = 0; i < N; i++) predStart[i + 1] = predStart[i] + predCount[i];
const preds = new Uint32Array(predStart[N]); const fill = predStart.slice(0, N);
for (const v of post) succ(v, w => { preds[fill[w]++] = v; });
// Cooper–Harvey–Kennedy iterative dominators over reverse postorder.
const idom = new Int32Array(N).fill(-1); idom[0] = 0;
const intersect = (a, b) => { while (a !== b) { while (order[a] < order[b]) a = idom[a]; while (order[b] < order[a]) b = idom[b]; } return a; };
for (let changed = true; changed;) {
  changed = false;
  for (let k = post.length - 2; k >= 0; k--) {
    const v = post[k]; let d = -1;
    for (let p = predStart[v]; p < predStart[v + 1]; p++) { const u = preds[p]; if (idom[u] === -1) continue; d = d === -1 ? u : intersect(u, d); }
    if (d !== -1 && idom[v] !== d) { idom[v] = d; changed = true; }
  }
}
const retained = new Float64Array(N);
for (const v of post) retained[v] += s.nodes[v * NF + nSize];
for (const v of post) if (v !== 0) retained[idom[v]] += retained[v];
const label = i => { const t = nodeTypes[s.nodes[i * NF + nType]]; const name = s.strings[s.nodes[i * NF + nName]]; return t === "object" || t === "closure" ? `${name}` : `(${t})${t === "string" ? " " + JSON.stringify(name.slice(0, 40)) : name ? " " + name.slice(0, 40) : ""}`; };
const edgeTo = (from, to) => { let name = "?"; succ(from, (w, e) => { if (w === to && name === "?") { const t = edgeTypes[s.edges[e + eType]]; const n = s.edges[e + eName]; name = t === "element" || t === "hidden" ? `[${n}]` : s.strings[n]; } }); return name; };
// A retaining path: walk up real retainers (not the dominator, which is often the synthetic root), preferring a
// retainer that is an object or closure with a named edge, never revisiting a node.
const path = i => {
  const parts = []; const visited = new Set([i]); let v = i;
  for (let k = 0; k < 10 && v !== 0; k++) {
    let best = -1, bestScore = -1;
    for (let p = predStart[v]; p < predStart[v + 1]; p++) {
      const u = preds[p]; if (visited.has(u)) continue;
      const t = nodeTypes[s.nodes[u * NF + nType]]; const score = (t === "object" || t === "closure" ? 2 : 0) + (order[u] > order[v] ? 1 : 0);
      if (score > bestScore) { best = u; bestScore = score; }
    }
    if (best < 0) break;
    parts.unshift(`${label(best)}.${edgeTo(best, v)}`); visited.add(best); v = best;
  }
  return parts.join(" > ");
};
const mb = v => (v / 1048576).toFixed(2).padStart(7);
console.log(`nodes ${N}, reachable ${post.length}, total retained ${mb(retained[0])} MB`);
// Biggest dominated subtrees that aren't just the root's direct system holders: rank by retained, skip a node whose
// dominator retains almost the same (show the deepest meaningful owner).
const candidates = post.filter(v => v !== 0 && retained[v] >= MIN).sort((a, b) => retained[b] - retained[a]);
const shown = [];
for (const v of candidates) {
  const d = idom[v];
  const children = candidates.filter(c => idom[c] === v);
  // Prefer owners: skip if one child holds > 90% of this node (the child will be listed).
  if (children.some(c => retained[c] > 0.9 * retained[v])) continue;
  shown.push(v); if (shown.length >= TOP) break;
}
for (const v of shown) console.log(`${mb(retained[v])} MB  ${label(v)}  <=  ${path(v)}`);
