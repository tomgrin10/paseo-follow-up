import { z } from "zod";
import { HOME_GROUPS, buildHome, type HomeGroupId, type PaseoWorkspaceLite, type Workstream } from "./home";
import type { InboxRow } from "./inbox";
import type { Workspace } from "./model";
import type { Priority } from "./priorities";

/**
 * The Overseer (1.4.0-beta.0): one long-lived agent the developer talks to about the work and the other agents.
 * It routes asks to the agent that owns them and never does the work itself. Everything here is pure, so routing,
 * the digest and the forwarded-message rule are tested without a host.
 */

/** The label Follow-up puts on the Overseer agent. Discovery, tracking and the inbox counts skip agents carrying it. */
export const OVERSEER_LABEL = "follow-up.overseer";
export const OVERSEER_TITLE = "Overseer";
/** Prefix on every task the Overseer forwards, so the receiving agent knows whose words they are. */
export const FORWARD_PREFIX = "From Tom via Overseer:";

export const overseerStateSchema = z.object({
  version: z.literal(1),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  startedAt: z.string().nullable(),
  /** How many times Follow-up created it (1 = the first start). Recreations carry a handoff summary. */
  generation: z.number().int().nonnegative(),
  /** Set when the last recreation failed, shown on the pinned row. */
  error: z.string().nullable().default(null),
  /**
   * What it was created with (Settings → Agents). `key` is the setting it came from ("claude" = the default, newest
   * Opus); a different key offers a restart. Older states have none and count as the default.
   */
  agent: z.object({ key: z.string(), provider: z.string(), model: z.string(), thinking: z.string().nullable(), mode: z.string().nullable() }).nullable().optional(),
});
export type OverseerState = z.infer<typeof overseerStateSchema>;
export const EMPTY_OVERSEER: OverseerState = { version: 1, agentId: null, workspaceId: null, startedAt: null, generation: 0, error: null };

export const isOverseerAgent = (labels: Readonly<Record<string, string>> | null | undefined): boolean => labels?.[OVERSEER_LABEL] === "1";

// ---------- workstreams: what the Overseer knows about every workspace ----------

export type WorkstreamPr = { key: string; number: number; state: string; checks: "passed" | "failed" | "pending" | "unknown"; threads: number; url: string | null };
export type WorkstreamRow = {
  workspaceId: string;
  title: string;
  project: string | null;
  branch: string | null;
  group: HomeGroupId;
  agentId: string | null;
  agentStatus: string | null;
  prs: WorkstreamPr[];
  /** What the workstream asks of the developer right now (the Home line on a Needs-you row). */
  ask: string | null;
  /** The decisive word for the ask ("Permission", "Merge"), when there is one. */
  askKind: string | null;
  /** The last activity line Home shows. */
  activity: string | null;
  activityAt: string | null;
  priority: { score: number; reason: string } | null;
  /** Linear-style keys seen in the title, branch or PR titles (HER-1312). */
  keys: string[];
  /**
   * Resting: Follow-up's dormant flag, or untracked with nothing running, no open PR and no activity in the active
   * window. Listed compactly at the end; its agent is likely unloaded, so sending to it wakes it.
   */
  dormant: boolean;
};

const KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
export const linearKeys = (...texts: (string | null | undefined)[]): string[] =>
  [...new Set(texts.flatMap(t => (t ?? "").toUpperCase().match(KEY) ?? []))];

const prChecks = (p: Workspace["prs"][number]): WorkstreamPr["checks"] => {
  const s = p.snapshot;
  if (!s || p.error) return "unknown";
  return s.failedChecks.length ? "failed" : s.checksPending ? "pending" : "passed";
};

/**
 * Every workstream as the Overseer sees it: Home's own model (so groups and lines never disagree with what the
 * developer sees), plus branch, PRs, agent status and fresh priorities. The Overseer's own workspace is left out.
 */
export function workstreams(input: {
  rows: InboxRow[]; tracked: Workspace[]; paseo: PaseoWorkspaceLite[]; priorities?: readonly Priority[];
  agentStatus?: (agentId: string) => string | null; now: number; exclude?: { agentId: string | null; workspaceId: string | null } | null;
  /** The active window (default 3 days), for workspaces Follow-up doesn't track. */
  windowMs?: number;
}): WorkstreamRow[] {
  const ex = input.exclude;
  const rows = input.rows.filter(r => r.agentId !== ex?.agentId && (!ex?.workspaceId || r.workspaceId !== ex.workspaceId));
  const paseo = input.paseo.filter(p => p.id !== ex?.workspaceId);
  const model = buildHome({ rows, tracked: input.tracked.filter(w => w.id !== ex?.workspaceId), paseo, now: input.now, sort: "priority", priorities: input.priorities });
  const tracked = new Map(input.tracked.map(w => [w.id, w]));
  const lite = new Map(paseo.map(p => [p.id, p]));
  const statuses = new Map(rows.map(r => [r.agentId, r.status]));
  const out: WorkstreamRow[] = [];
  const seen = new Set<string>();
  for (const g of model.groups) for (const s of g.items) {
    if (!s.workspaceId || seen.has(s.workspaceId)) continue;
    seen.add(s.workspaceId);
    const row = rowOf(s, tracked.get(s.workspaceId), lite.get(s.workspaceId), s.agentId ? statuses.get(s.agentId) ?? input.agentStatus?.(s.agentId) ?? null : null);
    row.dormant = resting(row, tracked.get(s.workspaceId), input.now, input.windowMs ?? 3 * 86_400_000);
    out.push(row);
  }
  return out;
}

function resting(r: WorkstreamRow, w: Workspace | undefined, now: number, windowMs: number): boolean {
  if (r.group === "needs" || r.group === "running" || r.group === "fixing") return false;
  if (w) return !!w.dormant;
  if (r.prs.some(p => p.state === "OPEN")) return false;
  const at = r.activityAt ? Date.parse(r.activityAt) : NaN;
  return !Number.isFinite(at) || now - at >= windowMs;
}

function rowOf(s: Workstream, w: Workspace | undefined, p: PaseoWorkspaceLite | undefined, status: string | null): WorkstreamRow {
  const prs = (w?.prs ?? []).map(pr => ({ key: pr.key, number: pr.number, state: pr.snapshot?.state ?? "unknown", checks: prChecks(pr), threads: pr.snapshot?.threads.length ?? 0, url: pr.snapshot?.url ?? null }));
  const needs = s.group === "needs";
  return {
    workspaceId: s.workspaceId!, title: s.title, project: s.project, branch: p?.branch ?? null, group: s.group,
    agentId: s.agentId, agentStatus: status ?? (s.group === "running" || s.group === "fixing" ? "running" : null), prs,
    ask: needs ? [s.word, s.line].filter(Boolean).join(": ") || null : null, askKind: needs ? s.word : null,
    activity: needs ? null : s.line || null, activityAt: s.activityAt ?? s.at,
    priority: s.priority ? { score: s.priority.score, reason: s.priority.reason } : null,
    keys: linearKeys(s.title, p?.branch, p?.pr?.title, ...(w?.prs ?? []).map(x => x.snapshot?.title)),
    dormant: false,
  };
}

const clip = (text: string, max: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
const CHECK: Record<WorkstreamPr["checks"], string> = { passed: "✓", failed: "✗", pending: "…", unknown: "?" };

/** One compact digest line for a workstream (≈ 25–40 tokens). */
export function digestLine(r: WorkstreamRow): string {
  const prs = r.prs.filter(p => !["MERGED", "CLOSED"].includes(p.state)).slice(0, 3).map(p => `#${p.number}${CHECK[p.checks]}${p.threads ? ` ${p.threads}t` : ""}`);
  const merged = r.prs.filter(p => p.state === "MERGED").length;
  return [
    `${clip(r.title, 60)}${r.branch ? ` [${clip(r.branch, 40)}]` : ""}`,
    r.ask ? `asks: ${clip(r.ask, 90)}` : r.activity ? clip(r.activity, 70) : null,
    prs.length ? prs.join(" ") : merged ? `${merged} merged` : null,
    r.agentStatus && r.agentStatus !== "idle" ? r.agentStatus : null,
    r.priority ? `P${r.priority.score} ${clip(r.priority.reason, 50)}` : null,
    `ws=${r.workspaceId}${r.agentId ? ` agent=${r.agentId}` : ""}`,
  ].filter(Boolean).join(" · ");
}

/** Group order for listings: what needs the developer first, Quiet last. */
const GROUP_RANK = new Map(HOME_GROUPS.map((g, i) => [g, i]));
export function orderRows(rows: WorkstreamRow[]): WorkstreamRow[] {
  return [...rows].sort((a, b) => Number(!!a.dormant) - Number(!!b.dormant) || (GROUP_RANK.get(a.group)! - GROUP_RANK.get(b.group)!) || (b.priority?.score ?? -1) - (a.priority?.score ?? -1) || (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.workspaceId.localeCompare(b.workspaceId));
}

export const WORKSTREAMS_PAGE = 40;
/** A page of workstreams for the `workstreams` tool, optionally narrowed by group or a text filter. */
export function pageRows(rows: WorkstreamRow[], opts: { page?: number; size?: number; group?: HomeGroupId; query?: string } = {}) {
  const size = Math.min(Math.max(opts.size ?? WORKSTREAMS_PAGE, 1), 100);
  const q = opts.query?.trim().toLowerCase();
  const filtered = orderRows(rows).filter(r => (!opts.group || r.group === opts.group) && (!q || [r.title, r.branch, r.project, r.ask, r.activity, ...r.keys, ...r.prs.map(p => `#${p.number}`)].some(x => x?.toLowerCase().includes(q))));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
  // Resting workspaces come last and compact: no per-workspace detail, and their agents are likely unloaded.
  const slice = filtered.slice((page - 1) * size, page * size).map(r => r.dormant ? { workspaceId: r.workspaceId, title: r.title, agentId: r.agentId, dormant: true as const } : r);
  return { page, pages, total: filtered.length, resting: filtered.filter(r => r.dormant).length, rows: slice };
}

// ---------- the per-turn digest ----------

/** What the daemon writes for the hook: one line per workstream and a hash per line, so the hook can diff turns. */
export type DigestFile = {
  version: 1; agentId: string;
  /** When the content last changed. The daemon rewrites the file only when `hash` moves. */
  at: string; total: number; needs: number;
  /** Over the agent id and every row hash: equal hashes mean an identical digest. */
  hash: string;
  /** Resting rows carry `resting` and a title-only line; the hook lists them in one compact line. */
  rows: { id: string; group: HomeGroupId; line: string; hash: string; resting?: true }[];
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** The digest file. Only meaningful fields go into the hash, so a ticking age never counts as a change. */
export function digestFile(agentId: string, rows: WorkstreamRow[], now: number): DigestFile {
  const ordered = orderRows(rows);
  const out = ordered.map(r => {
    if (r.dormant) { const line = `${clip(r.title, 50)} ws=${r.workspaceId}`; return { id: r.workspaceId, group: r.group, line, hash: hash(`rest|${line}`), resting: true as const }; }
    const line = digestLine(r); return { id: r.workspaceId, group: r.group, line, hash: hash(`${r.group}|${line}`) };
  });
  return {
    version: 1, agentId, at: new Date(now).toISOString(), total: ordered.length, needs: ordered.filter(r => r.group === "needs").length,
    hash: hash(`${agentId}|${out.map(r => `${r.id}:${r.hash}`).join(",")}`), rows: out,
  };
}

// ---------- routing ----------

const STOP = new Set("the a an and or to of in on for with on at by from is are be it this that these those please can could would should you your my me we our all any some just now then them its pr prs agent agents workspace workspaces tell ask say send let make do get go look looks good".split(" "));
const words = (text: string | null | undefined) => (text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));

export type Candidate = { workspaceId: string; agentId: string | null; title: string; score: number; reasons: string[] };
/**
 * Score every workstream for an ask, by how the developer refers to work: a Linear key or PR number (decisive), the
 * branch, words of the workspace name, words of its open ask, then recent activity as a tie-breaker.
 */
export function scoreCandidates(ask: string, rows: WorkstreamRow[], now: number): Candidate[] {
  const keys = linearKeys(ask);
  const prNumbers = [...ask.matchAll(/(?:#|pull\/|pr\s*)(\d{1,6})\b/gi)].map(m => Number(m[1]));
  const tokens = new Set(words(ask));
  const lowered = ask.toLowerCase();
  const out: Candidate[] = [];
  for (const r of rows) {
    let score = 0; const reasons: string[] = [];
    const hitKeys = keys.filter(k => r.keys.includes(k));
    if (hitKeys.length) { score += 60; reasons.push(`key ${hitKeys.join(", ")}`); }
    const hitPrs = prNumbers.filter(n => r.prs.some(p => p.number === n));
    if (hitPrs.length) { score += 60; reasons.push(`PR #${hitPrs.join(", #")}`); }
    if (r.branch && r.branch.length >= 4 && lowered.includes(r.branch.toLowerCase())) { score += 45; reasons.push(`branch ${r.branch}`); }
    else {
      const b = words(r.branch?.replace(/^[\w.-]+\//, "")).filter(w => tokens.has(w));
      if (b.length) { score += 8 * b.length; reasons.push(`branch words ${b.join(" ")}`); }
    }
    const titleWords = new Set(words(r.title));
    const t = [...tokens].filter(w => titleWords.has(w));
    if (t.length) { score += 12 * t.length + (titleWords.size && t.length === titleWords.size ? 10 : 0); reasons.push(`name ${t.join(" ")}`); }
    const askWords = new Set(words(r.ask));
    const a = [...tokens].filter(w => askWords.has(w) && !titleWords.has(w));
    if (a.length) { score += 6 * a.length; reasons.push(`its ask mentions ${a.join(" ")}`); }
    if (!score) continue;
    const at = r.activityAt ? Date.parse(r.activityAt) : NaN;
    if (Number.isFinite(at) && now - at < 2 * 3_600_000) { score += 4; reasons.push("active in the last 2h"); }
    if (r.group === "needs") { score += 2; reasons.push("has an open ask"); }
    out.push({ workspaceId: r.workspaceId, agentId: r.agentId, title: r.title, score, reasons });
  }
  return out.sort((x, y) => y.score - x.score || x.title.localeCompare(y.title));
}

/** Confident when the best match is strong on its own and clearly ahead of the next one. */
export function routeDecision(candidates: Candidate[]): { confident: boolean; top: Candidate[] } {
  const [first, second] = candidates;
  const confident = !!first && !!first.agentId && first.score >= 40 && (!second || second.score <= first.score * 0.6);
  return { confident, top: candidates.slice(0, 3) };
}

// ---------- the forwarded-message rule ----------

/**
 * A task the developer routes through the Overseer is the developer's own words. It clears the target's Needs-you
 * flag only when it replies to that agent's open ask; a new task to an agent with an unrelated open ask leaves the
 * ask standing (the developer hasn't answered it). Returns who the inbox ledger records as the sender.
 */
export function forwardedSender(input: { replyToAsk: boolean; targetFlagged: boolean }): "developer" | "follow-up" {
  return input.replyToAsk && input.targetFlagged ? "developer" : "follow-up";
}
export const forwardText = (text: string) => `${FORWARD_PREFIX} ${text.trim()}`;

/** A workspace name from a task: the Linear key first when there is one, then the first words, at most 60 chars. */
export function workspaceTitleFor(task: string, key?: string | null): string {
  const k = key ?? linearKeys(task)[0] ?? null;
  const body = task.replace(KEY, "").replace(/\s+/g, " ").replace(/^[\s:,.-]+/, "").trim();
  const title = `${k ? `${k} ` : ""}${body.charAt(0).toUpperCase()}${body.slice(1)}`;
  return clip(title, 60).replace(/[.…]+$/, "");
}
/** A branch name from a title: lower-case words joined by dashes, at most 50 chars. */
export function branchFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "overseer-task";
}

/**
 * Server-side gate for start_workspace: the developer's latest message to the Overseer has to ask for a new
 * workspace, pick "New workspace" on its decision card, or approve the proposal ("yes", "go ahead"). The system
 * prompt asks for the same; this keeps a model slip from starting work on its own.
 */
/** "Follow-up answer D1 (Which agent?): C — New workspace\nContinue…" as the developer sees it: "Answered: C · New workspace". */
export function answerLine(text: string): string | null {
  const m = /^Follow-up answer [A-Z]*\d+(?: \([^)]*\))?: ([A-Z])\s*[—-]\s*([^\n]+)/.exec(text.trim());
  return m ? `Answered: ${m[1]} · ${m[2].trim()}` : null;
}

export function approvesNewWorkspace(message: string | null | undefined): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (/^Follow-up answer \S+ \(.*\): [A-Z] — New workspace\b/m.test(m)) return true;
  if (/\b(new|start|create|spin up|open|kick off)\b[^.?!\n]{0,40}\b(workspace|agent|worktree)\b/i.test(m)) return true;
  return /^(yes|yep|yeah|go ahead|do it|approved?|ok(ay)?|sure|start it)\b/i.test(m);
}

/** The pinned row's state and line, from the Overseer's status and its own inbox row. Null: the Overseer is off. */
export function overseerRowState(status: { enabled: boolean; agentId: string | null; error: string | null } | null, row: Pick<InboxRow, "status" | "needs" | "snooze" | "brief"> | null):
  { state: "start" | "idle" | "running" | "asks" | "error"; line: string } | null {
  if (!status?.enabled) return null;
  if (!status.agentId) return { state: "start", line: "Ask about any workspace or agent. Start it once." };
  if (status.error) return { state: "error", line: `Couldn't bring it back: ${status.error}` };
  if (row && ["running", "initializing"].includes(row.status)) return { state: "running", line: "Working on your ask…" };
  if (row?.brief?.state === "open" && row.brief.kind === "decision" && row.needs && !row.snooze) return { state: "asks", line: `Asks you · ${row.brief.ask}` };
  return { state: "idle", line: "Ask about any workspace or agent" };
}
