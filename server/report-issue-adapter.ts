import { Reporter, environment, manualIssueLink, type Diagnostics, type DiagnosticsSection, type ReportKind, type ReportPluginConfig } from "./report-issue";
import type { LogRing } from "./report-issue/diagnostics";
import type { RestSend } from "./github-api";
import { summary, type State, type Workspace } from "../shared/model";
import { checksState } from "../shared/pr-status";
import type { Resources } from "../shared/resources";
import type { UpdatesView } from "../shared/updates";
import { agentView } from "../shared/history";
import { finishedAgent } from "../shared/finished";
import { PAGE, TOOL_BUDGET } from "../shared/paged";

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
  /** A workspace's agents from the directory (metadata only; never loads one), for a report about that workspace. */
  agents?: (workspaceId: string) => Promise<ReportAgent[]>;
  now?: () => number;
};

/** One agent of the workspace, from the directory: `archived` and `closed` ones are history (`finishedAgent`). */
export type ReportAgent = { id: string; title: string | null; provider: string; status: string; archived?: boolean; lastActivityAt?: string | null };

/**
 * The room a report's local view may take: TOOL_BUDGET less what the first reply carries beside it (the procedure,
 * the issueGets rows, the note; ~6k). tests/report-subject-budget.test.ts measures the whole reply.
 */
export const REPORT_LOCAL_ROOM = TOOL_BUDGET - 10_000;

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
    const stuck = tracked.flatMap(w => w.batches.filter(b => ["blocked", "uncertain"].includes(b.state) && !b.movedOn));
    if (stuck.length) rows.push(["Blocked or uncertain batches", String(stuck.length)]);
    const errors = tracked.flatMap(w => w.prs.filter(p => p.error)).length;
    if (errors) rows.push(["PRs that failed to refresh", String(errors)]);
  }
  const follow = await d.call("follow.follow-settings", {}).catch(() => null) as { enable_follow_every?: boolean; enable_auto_sends_default?: boolean; activeWindowDays?: number; maxAutoSends?: number } | null;
  if (follow) rows.push(["Following", `follow every workspace: ${onOff(follow.enable_follow_every)} · Auto-send default: ${onOff(follow.enable_auto_sends_default)} · active window: ${follow.activeWindowDays ?? "?"} days · repairs at once: ${follow.maxAutoSends ?? "?"}`]);
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
    if (w.repo) repos.add(w.repo);
    for (const p of w.prs) { repos.add(p.repo); if (p.snapshot?.title) titles.add(p.snapshot.title); }
    if (w.title) titles.add(w.title);
    if (w.goal) titles.add(w.goal);
  }
  return { privateRepos: [...repos], privateTitles: [...titles] };
}

const count = <T>(list: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].map(([k, n]) => `${n} ${k}`).join(", ") || "none";
};
const age = (iso: string | undefined, now: number) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? `${ago(Math.max(0, now - t))} ago` : "unknown"; };
/** An error's code, never its words: "RATE_LIMIT", "HTTP 502", else "error". */
const errorCode = (e: string) => /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.exec(e)?.[0] ?? /\bHTTP \d{3}\b|\b[45]\d\d\b/.exec(e)?.[0] ?? "error";

/**
 * A report about one workspace (subject-is-structural-only, invariant 154). `local` is Follow-up's view of it for the
 * reporting agent to diagnose with, and stays on this machine. `section` is all the public issue gets: states, counts,
 * timings, check and conflict states and error codes, built from structure only, so no title, goal, summary, task or
 * question text, branch or repository name can reach it. `privateTitles` adds the workspace's own text to the
 * redaction list, in case the agent quotes it in a field.
 */
export async function workspaceSubject(d: FollowUpReportDeps, workspaceId: string) {
  const s = await d.snapshot().catch(() => null);
  const w = s?.workspaces.find(x => x.id === workspaceId);
  if (!w) return null;
  const now = (d.now ?? Date.now)();
  const agents = await d.agents?.(workspaceId).catch(() => []) ?? [];
  const logs = d.logs.recent(40).filter(l => l.includes(workspaceId));
  return { local: workspaceLocal(w, agents, logs, now), section: workspaceSection(w, agents.filter(a => !a.archived), logs, now), privateTitles: workspaceTexts(w) };
}

/**
 * Follow-up's view of the workspace, bounded like workspace_status (invariant 63's TOOL_BUDGET): `agentView` decides
 * what comes (live work whole while it fits, finished items the newest `PAGE.recentDone` plus a count in `history`,
 * glances when needed) and this only reshapes it into short rows. Live agents are rows (the main agent first, then
 * running ones, newest first, at most `PAGE.toolPage`); closed and archived ones are counts. 2026-11-28, 2.6.0-beta.6:
 * built from the raw lists, one busy workspace's view was 168,664 characters (every PR, agent and task it ever had).
 */
function workspaceLocal(w: Workspace, agents: ReportAgent[], logs: string[], now: number) {
  const st = summary(w, now);
  const at = (a: ReportAgent) => { const t = Date.parse(a.lastActivityAt ?? ""); return Number.isFinite(t) ? t : 0; };
  const live = agents.filter(a => !finishedAgent(a))
    .sort((a, b) => Number(b.id === w.mainAgentId) - Number(a.id === w.mainAgentId) || Number(b.status === "running") - Number(a.status === "running") || at(b) - at(a));
  const head = {
    workspaceId: w.id, title: w.title, goal: w.goal, status: `${st.status}: ${st.label}${st.reason ? ` (${st.reason})` : ""}`,
    following: w.enable_tracking, autoSend: w.enable_auto_sends, hold: w.hold, archived: w.archived, sendWait: w.sendWait ?? null, mainBusy: w.mainBusy ?? null,
  };
  const rest = {
    agents: live.slice(0, PAGE.toolPage).map(a => ({ id: a.id, title: a.title, provider: a.provider, status: a.status, main: a.id === w.mainAgentId })),
    ...(live.length > PAGE.toolPage ? { agentsMore: live.length - PAGE.toolPage } : {}),
    agentsFinished: { closed: agents.filter(a => !a.archived && finishedAgent(a)).length, archived: agents.filter(a => a.archived).length },
    recentWarnings: logs,
  };
  type V = ReturnType<typeof agentView<Workspace>>;
  const rows = (v: V) => ({
    ...head,
    prs: v.prs.map(p => {
      const g = p as typeof p & { glance?: true; snapshot: (typeof p.snapshot & { failedChecksCount?: number }) | null };
      return { pr: `${p.repo}#${p.number}`, title: p.snapshot?.title ?? null, state: p.snapshot?.state ?? "unknown", draft: p.snapshot?.draft ?? null,
        checks: !p.snapshot ? "unknown" : g.glance ? (g.snapshot?.failedChecksCount ? "failed" : "not read here") : checksState(p.snapshot),
        conflict: p.snapshot?.conflict ?? null, review: p.snapshot?.reviewDecision ?? null, error: p.error, observed: age(p.snapshot?.observedAt, now) };
    }),
    tasks: v.obligations.map(o => ({ id: o.id, title: o.title, status: o.status })),
    questions: v.questions.map(q => ({ id: q.id, title: q.title, ...(typeof (q as { question?: unknown }).question === "string" ? { question: (q as { question: string }).question } : {}),
      state: q.closed ? "closed" : q.answer ? "answered" : "open" })),
    batches: v.batches.map(b => ({ id: b.id, state: b.state, tasks: b.tasks.length })),
    history: v.history,
    ...(v.live && Object.values(v.live).some(x => x.more) ? { live: v.live } : {}),
    ...rest,
  });
  return rows(agentView(w, { budget: REPORT_LOCAL_ROOM }, undefined, rows));
}

function workspaceSection(w: Workspace, agents: { id: string; provider: string; status: string }[], logs: string[], now: number) {
  const st = summary(w, now);
  const snaps = w.prs.map(p => p.snapshot).filter(x => !!x);
  const open = snaps.filter(p => p.state === "OPEN");
  const rows: [string, string][] = [
    ["Status", `${st.status} · following ${w.enable_tracking ? "on" : "off"} · Auto-send ${w.enable_auto_sends ? "on" : "off"}${w.hold ? " · on hold" : ""}${w.archived ? " · archived" : ""}${w.sendWait ? ` · repairs wait: ${w.sendWait}` : ""}${w.mainBusy ? ` · main agent: ${w.mainBusy}` : ""}`],
    ["PRs", `${w.prs.length} (${count(w.prs, p => (p.snapshot?.state ?? "unknown").toLowerCase())})${open.length ? ` · ${open.filter(p => p.draft).length} draft` : ""}`],
  ];
  if (open.length) {
    rows.push(["Checks (open PRs)", count(open, p => checksState(p))]);
    rows.push(["Conflicts (open PRs)", String(open.filter(p => p.conflict).length)]);
    rows.push(["Reviews (open PRs)", count(open, p => (p.reviewDecision || "none").toLowerCase())]);
    rows.push(["Workflow", count(open, p => p.prWorkflow ?? "graphite")]);
  }
  const errors = w.prs.filter(p => p.error);
  if (errors.length) rows.push(["PR refresh errors", count(errors, p => errorCode(p.error!))]);
  if (snaps.length) rows.push(["Last PR read", age(snaps.map(p => p.observedAt).sort().at(-1), now)]);
  rows.push(["Tasks", count(w.obligations, o => o.status)]);
  rows.push(["Questions", `${w.questions.filter(q => !q.closed && !q.answer).length} open · ${w.questions.filter(q => q.answer).length} answered · ${w.questions.filter(q => q.closed).length} closed`]);
  if (w.batches.length) rows.push(["Repair batches", count(w.batches, b => b.state)]);
  rows.push(["Agents", agents.length ? `${agents.length} (${count(agents, a => a.provider)}) · main ${agents.find(a => a.id === w.mainAgentId)?.status ?? "unknown"}` : `${1 + (w.contributorAgentIds?.length ?? 0)} (from Follow-up's record)`]);
  if (w.completion) rows.push(["Done", `declared ${age(w.completion.declaredAt, now)}`]);
  if (logs.length) rows.push(["Recent warnings about it", `${logs.length} (${count(logs, l => errorCode(l))})`]);
  return { title: "This workspace", level: "state" as const, rows };
}

/** Every bit of the workspace's own text, for the redaction list: never in the section, and replaced if quoted. */
function workspaceTexts(w: Workspace): string[] {
  return [w.id, w.title, w.goal, w.completion?.summary, w.declaration?.summary,
    ...w.prs.flatMap(p => [p.snapshot?.title, p.snapshot?.headBranch, p.snapshot?.head, p.stack]),
    ...w.obligations.flatMap(o => [o.title, o.evidence]),
    ...w.questions.flatMap(q => [q.title, q.question, q.background, q.big])].filter((x): x is string => typeof x === "string" && !!x.trim());
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
    subject: { param: "workspace_id", read: id => workspaceSubject(d, id) },
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
export function reportPrompt(kind: ReportKind, text: string, error?: string | null, workspaceId?: string | null): string {
  const what = kind === "bug" ? "a bug" : kind === "feature" ? "a feature request" : "feedback";
  const lines = [
    `Report ${what} about Follow-up for me: ${text.trim() || "(I'll describe it when you ask.)"}`,
    ...(error ? [``, `The error I saw: ${error.trim()}`] : []),
    ``,
    ...(workspaceId ? [`It's about the Follow-up workspace ${workspaceId}. Pass workspace_id="${workspaceId}" on every follow_report_issue call: the first reply gives you Follow-up's view of it to diagnose with. That view stays local; the public issue gets only its structural rows.`, ``] : []),
    `Use the follow_report_issue tool (call it with kind="${kind}"${workspaceId ? `, workspace_id="${workspaceId}"` : ""} and a one-line summary first; it returns the steps). Ask me for anything it needs, and show me the exact issue before filing it.`,
  ];
  return lines.join("\n");
}
