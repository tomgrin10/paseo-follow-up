// node scripts/perf-sizes.mjs <info.json>: reply sizes of the reads a client makes, on a held perf daemon (scripts/perf-ui-setup.mjs).
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFileSync } from "node:fs";
const info = JSON.parse(readFileSync(process.argv[2], "utf8"));
const c = new DaemonClient({ url: `ws://127.0.0.1:${info.port}/ws`, clientId: "perf-sizes", clientType: "cli", reconnect: { enabled: false } });
await c.connect();
const r = await c.invokePluginRpc("follow-up", "follow.list", {});
const all = r.workspaces; console.log("list bytes", JSON.stringify(r).length, "n", all.length);
for (const w of [all.find(x => x.title?.endsWith("(0)")) ?? all[0], all[5]]) {
  console.log(w.title, JSON.stringify(w).length, Object.entries(w).map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 8));
  console.log(" questions", w.questions.length, "open", w.questions.filter(q => !q.answer && !q.closed).length, "batches", w.batches.length, "prs", w.prs.length, "merged", w.prs.filter(p => p.snapshot?.state === "MERGED").length);
}
const g = await c.invokePluginRpc("follow-up", "follow.get", { workspaceId: info.created[0].workspaceId });
console.log("follow.get ws0", JSON.stringify(g).length);
process.exit(0);
