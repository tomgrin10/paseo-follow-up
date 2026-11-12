import { Reporter, environment, manualIssueLink, type Diagnostics, type DiagnosticsSection, type ReportKind, type ReportPluginConfig } from "./report-issue";
import type { LogRing } from "./report-issue/diagnostics";
import type { RestSend } from "./github-api";
import type { State } from "../shared/model";
import type { Resources } from "../shared/resources";
import type { UpdatesView } from "../shared/updates";

/**
 * Follow-up's adapter for the shared Report-an-issue module (server/report-issue/): its repository, its tool name,
 * and what it knows about itself for the diagnostics block and for redaction. Everything is read only while a report
 * is being prepared; nothing here runs in the background.
 */
export const REPORT_REPO = "tomgrin10/paseo-follow-up";
export const REPORT_TOOL = "report_issue";

export type FollowUpReportDeps = {
  github: RestSend;
  updates: () => Promise<UpdatesView>;
  /** A developer RPC's own handler, for settings (best effort). */
  call: (method: string, input?: unknown) => Promise<unknown>;
  snapshot: () => Promise<State>;
  resources: () => Resources;
  /** The daemon's server_info (its version, when it says). */
  serverInfo: () => Promise<{ version?: unknown; serverVersion?: unknown } | null | undefined>;
  logs: LogRing;
  /** Whether native tools are served (Paseo's agent MCP) or the stdio bridge. */
  toolTransport: () => string;
  startedAt: number;
  now?: () => number;
};

const ago = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const onOff = (v: unknown) => v === true ? "on" : v === false ? "off" : "unknown";

/** Versions and install: also what the sheet's Open on GitHub link carries (no GitHub call needed). */
async function versionsSection(d: FollowUpReportDeps): Promise<DiagnosticsSection> {
  const u = await d.updates().catch(() => null);
  const info = await d.serverInfo().catch(() => null);
  const daemon = typeof info?.version === "string" ? info.version : typeof info?.serverVersion === "string" ? info.serverVersion : null;
  const last = u?.history?.[0];
  return { title: "Versions and install", level: "versions", rows: [
    ["Follow-up", u ? `${u.version} (${u.channel} channel, installed from ${u.installKind}, updates: ${u.mode})` : "unknown"],
    ...(last ? [["Last update", `${last.from ?? "?"} → ${last.to ?? "?"}, ${String(last.result)}`] as [string, string]] : []),
    ["Paseo", `daemon ${daemon ?? "unknown"}`],
  ] };
}

async function stateSection(d: FollowUpReportDeps): Promise<DiagnosticsSection> {
  const now = (d.now ?? Date.now)();
  const rows: [string, string][] = [];
  const s = await d.snapshot().catch(() => null);
  if (s) {
    const tracked = s.workspaces.filter(w => w.enable_tracking && !w.archived);
    const open = tracked.flatMap(w => w.prs.filter(p => p.snapshot?.state === "OPEN"));
    rows.push(["Tracked workspaces", `${tracked.length} (${tracked.filter(w => w.enable_auto_sends).length} with Auto-send)`]);
    rows.push(["Open PRs followed", `${open.length} in ${new Set(open.map(p => p.repo.toLowerCase())).size} repositories`]);
    const stuck = tracked.flatMap(w => w.batches.filter(b => ["blocked", "uncertain"].includes(b.state)));
    if (stuck.length) rows.push(["Blocked or uncertain batches", String(stuck.length)]);
    const errors = tracked.flatMap(w => w.prs.filter(p => p.error)).length;
    if (errors) rows.push(["PRs that failed to refresh", String(errors)]);
  }
  const follow = await d.call("follow.follow-settings", {}).catch(() => null) as { enable_follow_every?: boolean; enable_auto_sends_default?: boolean; activeWindowDays?: number } | null;
  if (follow) rows.push(["Following", `follow every workspace: ${onOff(follow.enable_follow_every)} · Auto-send default: ${onOff(follow.enable_auto_sends_default)} · active window: ${follow.activeWindowDays ?? "?"} days`]);
  const display = await d.call("settings.display", {}).catch(() => null) as { values?: Record<string, unknown> } | null;
  if (display?.values) rows.push(["Display", `Needs-you inbox: ${onOff(display.values.enable_inbox)}`]);
  const u = await d.updates().catch(() => null);
  if (u) rows.push(["Update phase", `${u.phase.kind}${u.registryError ? ` · last check failed: ${u.registryError}` : ""}`]);
  const r = d.resources();
  const mem = process.memoryUsage().rss;
  rows.push(["Worker", `up ${ago(now - d.startedAt)} · RSS ${Math.round(mem / 1_048_576)} MB · governor ${r.level}${r.memoryPct != null ? ` (working set ${Math.round(r.memoryPct)} %)` : ""}`]);
  rows.push(["Agent tools", d.toolTransport()]);
  return { title: "Follow-up state", level: "state", rows };
}

/** Repository names and PR titles Follow-up knows: private ones become repo-N and PR-N in a report. */
async function redaction(d: FollowUpReportDeps) {
  const s = await d.snapshot().catch(() => null);
  const repos = new Set<string>(); const titles = new Set<string>();
  for (const w of s?.workspaces ?? []) {
    for (const p of w.prs) { repos.add(p.repo); if (p.snapshot?.title) titles.add(p.snapshot.title); }
    if (w.title) titles.add(w.title);
    if (w.goal) titles.add(w.goal);
  }
  return { privateRepos: [...repos], privateTitles: [...titles] };
}

export function followUpReportConfig(d: FollowUpReportDeps): ReportPluginConfig {
  return {
    name: "Follow-up", repo: REPORT_REPO, toolName: `follow_${REPORT_TOOL}`, assetsFolder: "follow-up",
    github: { request: (method, path, body) => d.github.send(REPORT_REPO, method, path, body) },
    diagnostics: async (): Promise<Diagnostics> => {
      const [versions, env, state] = await Promise.all([versionsSection(d), environment({ clis: [["Paseo CLI", "paseo", ["--version"]], ["Claude Code", "claude", ["--version"]], ["Codex", "codex", ["--version"]], ["Graphite", "gt", ["--version"]]] }), stateSection(d)]);
      return { sections: [versions, env, state], logs: d.logs.recent(20) };
    },
    redaction: () => redaction(d),
    now: d.now,
  };
}

export function followUpReporter(d: FollowUpReportDeps) {
  const config = followUpReportConfig(d);
  const reporter = new Reporter(config);
  return {
    reporter,
    /** The sheet's Open on GitHub (no agent to send to): a prefilled link with the redacted versions block. */
    manualLink: (kind: ReportKind, text: string) => manualIssueLink({ ...config, diagnostics: async () => ({ sections: [await versionsSection(d), await environment({ clis: [] })] }) }, kind, text),
  };
}

/** What the sheet sends to the agent it picked. The words name the tool so the agent takes it from there. */
export function reportPrompt(kind: ReportKind, text: string, error?: string | null): string {
  const what = kind === "bug" ? "a bug" : kind === "feature" ? "a feature request" : "feedback";
  const lines = [
    `Report ${what} about Follow-up for me: ${text.trim() || "(I'll describe it when you ask.)"}`,
    ...(error ? [``, `The error I saw: ${error.trim()}`] : []),
    ``,
    `Use the follow_report_issue tool (call it with kind="${kind}" and a one-line summary first; it returns the steps). Ask me for anything it needs, and show me the exact issue before filing it.`,
  ];
  return lines.join("\n");
}
