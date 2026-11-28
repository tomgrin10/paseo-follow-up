// The dry-run preview for Report a bug… (invariant 154), for scripts/screenshots.mjs
// --report-panel-review: runs the real Reporter dry run (Follow-up's adapter, a fictional workspace, an offline GitHub)
// and prints the exact issue as a small HTML page, the way an agent shows it before asking for a yes. Nothing is filed.
// Usage: npx tsx scripts/report-preview.ts light|dark > preview.html
import { Reporter } from "../server/report-issue";
import { LogRing } from "../server/report-issue/diagnostics";
import { followUpReportConfig } from "../server/report-issue-adapter";
import type { State } from "../shared/model";
import { pr, snapshot, workspace } from "../tests/fixtures";

const scheme = process.argv[2] === "light" ? "light" : "dark";
const WS = "ws-billing-retries";
const read = { observedAt: "2026-11-28T08:58:00Z" };
const w = workspace({
  id: WS, title: "Billing retries", goal: "Retry failed charges with backoff and send the dunning email", mainAgentId: "agent-main", repo: "example/app",
  prs: [
    pr({ key: "example/app#142", repo: "example/app", number: 142, stack: "billing-retries", snapshot: snapshot({ title: "Retry failed charges with exponential backoff", headBranch: "alice/billing-retries", state: "OPEN", failedChecks: ["ci / unit"], ...read }) }),
    pr({ key: "example/app#143", repo: "example/app", number: 143, stack: "billing-retries", snapshot: snapshot({ title: "Send the dunning email", headBranch: "alice/dunning-email", state: "OPEN", conflict: true, ...read }) }),
    pr({ key: "example/app#141", repo: "example/app", number: 141, stack: "billing-retries", snapshot: snapshot({ title: "Charge attempts table", state: "MERGED", ...read }) }),
  ],
  obligations: [{ id: "T1", title: "Check retries in staging after the deploy", status: "pending", afterPrs: [], evidence: "" } as never],
  questions: [{ id: "Q1", title: "Retry card_declined?", question: "Should charges that fail with card_declined retry, or only network failures?", background: null, big: null, options: [], recommend: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "agent-main", askedAt: "2026-11-28T08:00:00Z", mode: "decision", answer: null, closed: null } as never],
});
const logs = new LogRing();
logs.push("warn", `[follow-up] send failed for ${WS} (example/app#142): DAEMON_UNREACHABLE`);
const offline = { send: async (_repo: string, _m: string, path: string) => path === "user" ? { login: "reporter" } : path.startsWith("search/issues") ? { items: [] } : (() => { throw Object.assign(new Error("offline"), { status: 404 }); })() };
const config = followUpReportConfig({
  github: offline as never, updates: async () => ({ version: "2.6.0-beta.6", channel: "beta", installKind: "npm", mode: "notify", history: [], phase: { kind: "idle" } } as never),
  call: async () => null, snapshot: async () => ({ workspaces: [w] } as unknown as State), resources: () => ({ level: "ok", memoryPct: 41 } as never),
  serverInfo: async () => ({ version: "0.16.2" }), logs, toolTransport: () => "native", startedAt: Date.parse("2026-11-28T07:00:00Z"), now: () => Date.parse("2026-11-28T09:00:00Z"),
  agents: async () => [{ id: "agent-main", title: "Billing retries · main", provider: "claude", status: "idle" }],
});
// The environment rows are this machine's; the render shows fictional ones.
const real = config.diagnostics;
config.diagnostics = async () => { const d = await real(); return { ...d, sections: d.sections.map(s => s.level === "environment" ? { ...s, rows: [["OS", "Linux 6.8.0, x64 (Ubuntu 24.04 LTS)"], ["Node", "v24.11.0"], ["gh", "2.83.0 · signed in (1 account)"], ["Paseo CLI", "0.16.2"]] as [string, string][] } : s) }; };
const reporter = new Reporter(config);
const dry = await reporter.run("agent-preview", { kind: "bug", workspace_id: WS, fields: {
  title: "Send repairs stays queued after the daemon reconnects",
  what_happened: "In Billing retries, Send on the failing check showed Queued and never went out.",
  steps: ["Open the workspace panel", "Click Send on the failed check", "Restart Paseo"], expected: "The repair goes to the main agent once Paseo is back.", actual: "It stays Queued until a reload.",
} }) as { title: string; labels: string[]; body: string; redacted: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
/** Just enough markdown for the body template: headings, lists, tables, fences, details. */
function html(md: string): string {
  const out: string[] = []; const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) { const code: string[] = []; while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]); out.push(`<pre>${esc(code.join("\n"))}</pre>`); continue; }
    if (/^<\/?(details|summary)/.test(l)) { out.push(l.replace(/<summary>(.*)<\/summary>/, (_m, t) => `<summary>${esc(t)}</summary>`)); continue; }
    if (l.startsWith("|")) {
      const rows: string[][] = []; for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i].slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|")));
      i--; out.push(`<table>${rows.filter(r => !r.every(c => /^-+$/.test(c)) && r.some(Boolean)).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`); continue;
    }
    const h = /^(#{1,4}) (.*)/.exec(l); if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    const li = /^(\d+\.|-) (.*)/.exec(l); if (li) { out.push(`<div class="li">${esc(li[1])} ${inline(li[2])}</div>`); continue; }
    if (l.startsWith("> ")) { out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`); continue; }
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join("\n");
}
const [bg, fg, muted, line, box] = scheme === "dark" ? ["#0d1117", "#e6edf3", "#8d96a0", "#30363d", "#161b22"] : ["#ffffff", "#1f2328", "#59636e", "#d1d9e0", "#f6f8fa"];
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:${bg};color:${fg};font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}.meta{color:${muted};font-size:13px;margin-bottom:12px}.label{display:inline-block;border:1px solid ${line};border-radius:999px;padding:0 8px;margin-right:6px;font-size:12px}
h1{font-size:22px;margin:0 0 6px;overflow-wrap:anywhere}h3,h4{margin:18px 0 6px;font-size:15px}.card{border:1px solid ${line};border-radius:8px;padding:16px;overflow-wrap:anywhere}
table{border-collapse:collapse;margin:6px 0 12px;width:100%;table-layout:fixed}td{border:1px solid ${line};padding:4px 8px;vertical-align:top;overflow-wrap:anywhere}td:first-child{width:38%;color:${muted}}
pre{background:${box};padding:10px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}code{background:${box};padding:0 4px;border-radius:4px}summary{cursor:pointer;color:${muted};margin-top:12px}.li{margin:2px 0}blockquote{margin:0 0 12px;padding:0 12px;border-left:3px solid ${line};color:${muted}}
</style></head><body><main><div class="meta">Dry run · nothing filed · redacted: ${esc(dry.redacted)}</div><h1>${esc(dry.title)}</h1><div class="meta">${dry.labels.map(l => `<span class="label">${esc(l)}</span>`).join("")}</div>
<div class="card">${html(dry.body.replace("<details>", "<details open>"))}</div></main></body></html>`);
