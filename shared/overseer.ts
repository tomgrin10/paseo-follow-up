import { checksState } from "./pr-status";
import { searchRows } from "./search";
import { sendingOf, type Sending } from "./sending";
import { ANSWER_PREFIX, OTHER_LABEL, parseAnswerMessage, parseAnswersMessage } from "./questions";
import { envelopeParts } from "./queue";
import { z } from "zod";
import { HOME_GROUPS, buildHome, type HomeGroupId, type PaseoWorkspaceLite, type Workstream } from "./home";
import type { InboxRow } from "./inbox";
import type { ListWorkspace as Workspace } from "./list";
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
export const FORWARD_PREFIX = "From the developer via Overseer:";
/**
 * Every prefix a forwarded message has carried. An earlier one named the developer; old transcripts keep that spelling,
 * so anything that recognises a forward checks all of them (isForwarded).
 */
export const FORWARD_PREFIXES = [FORWARD_PREFIX, "From Tom via Overseer:"] as const;
export const isForwarded = (text: string) => FORWARD_PREFIXES.some(p => text.trimStart().startsWith(p));

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

export type WorkstreamPr = { key: string; number: number; state: string; checks: "passed" | "failed" | "pending" | "not_started" | "unknown"; threads: number; url: string | null };
export type WorkstreamRow = {
  workspaceId: string;
  /** The Home row this is (`agent:<id>` or `ws:<id>`): a ranked reason is shown on this row only. */
  key?: string;
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
  /** Linear-style keys seen in the title, branch or PR titles (ACME-1312). */
  keys: string[];
  /**
   * Resting: Follow-up's dormant flag, or untracked with nothing running, no open PR and no activity in the active
   * window. Listed compactly at the end; its agent is likely unloaded, so sending to it wakes it.
   */
  dormant: boolean;
  /** Home's Sending row (shared/sending.ts): queued or sent, when and why, and whether send_repairs would go through. */
  sending?: Sending | null;
};

const KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
export const linearKeys = (...texts: (string | null | undefined)[]): string[] =>
  [...new Set(texts.flatMap(t => (t ?? "").toUpperCase().match(KEY) ?? []))];

const prChecks = (p: Workspace["prs"][number]): WorkstreamPr["checks"] => {
  const s = p.snapshot;
  if (!s?.complete) return "unknown";
  return ({ failed: "failed", running: "pending", "not-started": "not_started", passed: "passed" } as const)[checksState(s)];
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
  /** The machine holds auto-sends (the resource governor). */
  autoSendsHeld?: boolean;
}): WorkstreamRow[] {
  const ex = input.exclude;
  const rows = input.rows.filter(r => r.agentId !== ex?.agentId && (!ex?.workspaceId || r.workspaceId !== ex.workspaceId));
  const paseo = input.paseo.filter(p => p.id !== ex?.workspaceId);
  const model = buildHome({ rows, tracked: input.tracked.filter(w => w.id !== ex?.workspaceId), paseo, now: input.now, sort: "priority", priorities: input.priorities, autoSendsHeld: input.autoSendsHeld });
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
    const w = tracked.get(s.workspaceId);
    if (s.group === "sending" && w) row.sending = sendingOf(w, input.now, { held: input.autoSendsHeld });
    out.push(row);
  }
  return out;
}

function resting(r: WorkstreamRow, w: Workspace | undefined, now: number, windowMs: number): boolean {
  if (r.group === "needs" || r.group === "running" || r.group === "sending") return false;
  if (w) return !!w.dormant;
  if (r.prs.some(p => p.state === "OPEN")) return false;
  const at = r.activityAt ? Date.parse(r.activityAt) : NaN;
  return !Number.isFinite(at) || now - at >= windowMs;
}

function rowOf(s: Workstream, w: Workspace | undefined, p: PaseoWorkspaceLite | undefined, status: string | null): WorkstreamRow {
  const prs = (w?.prs ?? []).map(pr => ({ key: pr.key, number: pr.number, state: pr.snapshot?.state ?? "unknown", checks: prChecks(pr), threads: pr.snapshot?.threads?.length ?? 0, url: pr.snapshot?.url ?? null }));
  const needs = s.group === "needs";
  return {
    workspaceId: s.workspaceId!, key: s.key, title: s.title, project: s.project, branch: p?.branch ?? null, group: s.group,
    agentId: s.agentId, agentStatus: status ?? (s.group === "running" ? "running" : null), prs,
    ask: needs ? [s.word, s.line].filter(Boolean).join(": ") || null : null, askKind: needs ? s.word : null,
    activity: needs ? null : s.line || null, activityAt: s.activityAt ?? s.at,
    priority: s.priority ? { score: s.priority.score, reason: s.priority.reason } : null,
    keys: linearKeys(s.title, p?.branch, p?.pr?.title, ...(w?.prs ?? []).map(x => x.snapshot?.title)),
    dormant: false,
  };
}

const clip = (text: string, max: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
const CHECK: Record<WorkstreamPr["checks"], string> = { passed: "✓", failed: "✗", pending: "…", not_started: "○", unknown: "?" };

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
  const grouped = orderRows(rows).filter(r => !opts.group || r.group === opts.group);
  const filtered = searchRows(grouped, r => [
    { field: "name", text: r.title }, { field: "branch", text: r.branch ?? "" },
    { field: "project", text: r.project ?? "" }, { field: "ask", text: [r.ask, r.activity].filter(Boolean).join(" ") },
    { field: "linked", text: r.keys.join(" ") }, { field: "pr", text: r.prs.map(p => `#${p.number}`).join(" ") },
  ], q ?? "");
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
  /** When the content last changed. The daemon rewrites the file only when `hash` moves, or for an Overseer turn. */
  at: string; total: number; needs: number;
  /** When the worker built it (a-derived-view-is-built-when-read): the hook waits briefly for one built for its turn. */
  builtAt?: string;
  /** Over the agent id and every row hash: equal hashes mean an identical digest. */
  hash: string;
  /** Resting rows carry `resting` and a title-only line; the hook lists them in one compact line. */
  rows: { id: string; group: HomeGroupId; line: string; hash: string; resting?: true }[];
  /**
   * Compass's block (compass-without-the-overseer): this week's plan and up to 12 live notes, `who · until · what ·
   * workspace or unplaced · note id`. Absent without a live note. The Overseer reads Compass here and through the
   * compass_* tools, never a source.
   */
  compass?: string[];
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** The digest file. Only meaningful fields go into the hash, so a ticking age never counts as a change. */
export function digestFile(agentId: string, rows: WorkstreamRow[], now: number, compass: readonly string[] = []): DigestFile {
  const ordered = orderRows(rows);
  const out = ordered.map(r => {
    if (r.dormant) { const line = `${clip(r.title, 50)} ws=${r.workspaceId}`; return { id: r.workspaceId, group: r.group, line, hash: hash(`rest|${line}`), resting: true as const }; }
    const line = digestLine(r); return { id: r.workspaceId, group: r.group, line, hash: hash(`${r.group}|${line}`) };
  });
  return {
    version: 1, agentId, at: new Date(now).toISOString(), total: ordered.length, needs: ordered.filter(r => r.group === "needs").length,
    hash: hash(`${agentId}|${out.map(r => `${r.id}:${r.hash}`).join(",")}${compass.length ? `|c:${compass.join("\n")}` : ""}`), rows: out,
    ...(compass.length ? { compass: [...compass] } : {}),
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

/** "Follow-up answer D1 (Which agent?): C — New workspace\nContinue…" as the developer sees it: "Answered: C · New workspace". */
export function answerLine(text: string): string | null {
  // A message carrying several parts (shared/queue.ts) previews by its first, the answer.
  text = envelopeParts(text)[0] ?? text;
  const m = /^Follow-up answer [A-Z]*\d+(?: \([^)]*\))?: ([A-Z])\s*[—-]\s*([^\n]+)/.exec(text.trim());
  if (m) return `Answered: ${m[1]} · ${m[2].trim()}`;
  // Several decisions answered together: each pick by its label, so the preview says what was decided.
  const several = parseAnswersMessage(text);
  return several ? `Answered: ${several.answers.map((a, i) => `${i + 1}. ${a.choice ? `${a.choice} · ${a.label}` : "skipped"}`).join("; ")}` : null;}

// ---------- the Overseer's start gate (the-overseer-starts-what-the-developer-asked) ----------
//
// start_workspace, and New's dispatch when the Overseer calls it, start a workspace only for work the developer's
// latest message asked for or approved. Deterministic: real grammar over clauses (imperatives, polite requests,
// plurals, wh-questions, negation), never one regex over the whole message.

/**
 * What the developer's latest message approves. `keys`: the Linear keys it approves, or null when it approves work
 * without naming any (then any start passes, except `declined`). `declined`: keys it said no to (Skip on a card,
 * "not ACME-14"). `via` says how, for the refusal text.
 */
export type StartApproval = { keys: string[] | null; declined: string[]; via: "request" | "yes" | "card" };

const VERB = String.raw`start|create|open|spin|kick|launch|begin|fire|set|make|dispatch|work|pick`;
/** Verbs that start work on their own ("start ACME-12", "spin these up"); open/set/make need a workspace word. */
const STRONG = new Set(["start", "create", "spin", "kick", "launch", "begin", "fire", "dispatch", "work", "pick"]);
const PARTICLE: Record<string, RegExp> = { spin: /\bup\b/, kick: /\boff\b/, fire: /\bup\b/, set: /\bup\b/, work: /\bon\b/, pick: /\bup\b/ };
const WORKSPACE = /\b(workspaces?|worktrees?|agents?)\b/;
const ANAPHOR = /\b(it|this|that|these|those|them|both|all|each|one|ones|two|three|the rest)\b/;
const NEGATION = /\b(don'?t|do not|doesn'?t|not|never|no need|hold off|wait|stop|skip|cancel|without)\b/;
/** Polite and filler openers, stripped before reading the clause's verb. */
const OPENER = /^(?:(?:and|also|then|so|ok(?:ay)?|hey|please|pls|now|just|alright|great|cool|thanks)\b[\s,]*|(?:can|could|would|will) (?:you|u)(?: please)?\b\s*|let'?s\b\s*|go ahead and\b\s*|(?:i'?d like|i want|i need|i'?d love) (?:you )?to\b\s*|(?:yes|yeah|yep|sure)\b[\s,]*)+/;
/** A question about the state of things, not a request: "which open workspaces need me?", "how many agents…". */
const WH_QUESTION = /^(which|what|how|why|where|when|who|whose|is|are|was|were|does|did|has|have|had|am|should|shall|do (?:you|we|i|they))\b/;
/** A whole message that says yes to the Overseer's proposal. */
const YES = /^(?:yes|yeah|yep|yup|ya|y|sure|ok(?:ay)?|k|go(?: ahead| for it)?|do it|do (?:both|all|them|those|these|each)|both|all of them|all|approved?|start (?:it|them|both|all)|please do|sounds good|lgtm|ship it|go on|proceed|confirmed?)\b/;

/** Clauses: sentences, lines, and "but"/";" breaks, lower-cased. */
const clauses = (text: string) => text.toLowerCase().split(/[.!?;\n]+|,?\s+but\s+|,\s+(?=not\b)/).map(c => c.trim()).filter(Boolean);

/** A clause that asks for new work: an imperative or polite request with a start verb and something to start. */
function requests(clause: string): boolean {
  const c = clause.replace(OPENER, "").trim();
  if (!c || WH_QUESTION.test(c) || NEGATION.test(c)) return false;
  // "a new workspace for ACME-12", "new worktrees for these": the noun phrase alone is the ask.
  if (/^(?:(?:a|an|some|two|three|\d+)\s+)?new (?:workspaces?|worktrees?|agents?)\b/.test(c) || /^(?:workspaces?|worktrees?) for\b/.test(c)) return true;
  const m = new RegExp(String.raw`^(${VERB})\b(.*)$`).exec(c);
  if (!m) return /\bnew (?:workspaces?|worktrees?|agents?)\b/.test(c) && /^(?:i|we)\b|\bplease\b/.test(c);
  const [, verb, rest] = m;
  if (PARTICLE[verb] && !PARTICLE[verb].test(rest)) return false;
  // The verb's object, past particles, articles and counts: "spin up agents", "start a new workspace", "kick them off".
  const object = rest.trim().split(/[\s,:]+/).find(w => !/^(up|off|on|a|an|the|new|some|more|another|\d+|two|three|separate|fresh|working)$/.test(w)) ?? "";
  if (WORKSPACE.test(object)) return true;
  return STRONG.has(verb) && (new RegExp(`^${KEY.source}$`, "i").test(object) || ANAPHOR.test(object) || object === "work");
}

/** Keys named in clauses that say no ("not ACME-14", "skip ACME-14", "don't start ACME-14"). */
const negatedKeys = (text: string) => clauses(text).filter(c => NEGATION.test(c)).flatMap(c => linearKeys(c));

/** A card decision's pick that starts a workspace: "New workspace", or yes/start on a question about starting one. */
const startsWork = (label: string | null, question: string) => !!label && (/\bnew (workspace|worktree|agent)s?\b/i.test(label) || (/^(yes|start|go|do it)\b/i.test(label) && /\b(start|new|workspace|worktree)\b/i.test(question)));

/** A Follow-up answer from the Overseer's own card: exactly the decisions answered with a start pick. */
function cardApproval(text: string): StartApproval | null | undefined {
  const head = envelopeParts(text)[0] ?? text;
  if (!head.trim().startsWith(ANSWER_PREFIX)) return undefined;
  const several = parseAnswersMessage(head);
  const one = several ? null : parseAnswerMessage(head);
  const decisions = several?.answers ?? (one ? [{ question: one.title, choice: one.choice, label: one.label, words: one.words }] : []);
  if (!decisions.length) return undefined;
  const keys: string[] = []; const declined: string[] = []; let unnamed = false;
  for (const d of decisions) {
    const named = linearKeys(d.question);
    // "Something else" in the developer's own words reads like a chat message about that decision.
    const words = d.choice === OTHER_LABEL ? (d.words ?? d.label?.replace(/^"|"$/g, "") ?? "") : "";
    const own = words ? startApproval(words, d.question) : null;
    if ((d.choice !== OTHER_LABEL && startsWork(d.label, d.question)) || own) {
      const k = own?.keys ?? named;
      if (k.length) keys.push(...k); else unnamed = true;
    } else declined.push(...named);
  }
  if (!keys.length && !unnamed) return null;
  return { keys: unnamed ? null : [...new Set(keys)], declined: declined.filter(k => !keys.includes(k)), via: "card" };
}

/**
 * The approval in the developer's latest message to the Overseer, or null when it approves nothing. `proposal` is
 * what the Overseer said since the developer's previous message (its reply and its card): a bare "yes", or "spin
 * these up", approves the keys it named.
 */
export function startApproval(message: string | null | undefined, proposal?: string | null): StartApproval | null {
  const m = (message ?? "").trim();
  if (!m) return null;
  const card = cardApproval(m);
  if (card !== undefined) return card;
  const declined = negatedKeys(m);
  const named = linearKeys(m).filter(k => !declined.includes(k));
  const proposed = linearKeys(proposal).filter(k => !declined.includes(k));
  const parts = clauses(m);
  if (parts.some(requests)) {
    // Named keys win; "these"/"this"/"both" points at what the Overseer proposed; otherwise any work they described.
    const keys = named.length ? named : proposed.length && parts.some(c => requests(c) && ANAPHOR.test(c)) ? proposed : null;
    return { keys, declined, via: "request" };
  }
  const first = (parts[0] ?? "").replace(/^(?:ok(?:ay)?|great|cool|thanks|perfect)\b[\s,]*/, "").trim() || (parts[0] ?? "");
  if (YES.test(first) && !NEGATION.test(first)) {
    return { keys: named.length ? named : proposed.length ? proposed : null, declined, via: "yes" };
  }
  return null;
}

/**
 * The developer's own words for the new agent (the note on the Overseer's dispatch): their latest message minus the
 * keys it names and the "start these" request itself, or null when nothing else is left. For a card answer, the note
 * the developer wrote on that key's decision. Never the Overseer's paraphrase of the issue: the agent reads it itself.
 */
export function developerNote(message: string | null | undefined, key: string | null): string | null {
  const m = (message ?? "").trim();
  if (!m) return null;
  const head = envelopeParts(m)[0] ?? m;
  if (head.trim().startsWith(ANSWER_PREFIX)) {
    const several = parseAnswersMessage(head);
    const one = several ? null : parseAnswerMessage(head);
    const decisions = several?.answers ?? (one ? [{ question: one.title, choice: one.choice, label: one.label, words: one.words }] : []);
    const d = decisions.find(d => key && linearKeys(d.question).includes(key.toUpperCase())) ?? (decisions.length === 1 ? decisions[0] : null);
    const words = d ? d.words ?? (d.choice === OTHER_LABEL ? d.label?.replace(/^"|"$/g, "") ?? null : null) : null;
    return words?.trim() || null;
  }
  const kept = m.split(/[.!?;\n]+|,\s*/).filter(f => {
    const lower = f.toLowerCase().trim();
    return !requests(lower) && !(YES.test(lower) && lower.replace(YES, "").replace(/[^a-z]+/g, "").length === 0);
  }).map(f => f.replace(new RegExp(KEY.source, "gi"), " ").replace(/\s+/g, " ").replace(/^[\s:,&-]+|[\s:,&-]+$/g, "").replace(/^(and|also|then|but)\s+/i, "").trim())
    .filter(f => /[a-z]/i.test(f) && !/^(and|or|for|these|those|them|both|all|please|thanks|thank you|asap|now)$/i.test(f));
  return kept.length ? kept.join(". ") : null;
}

/** Whether an approval covers a start with this key (null: a task with no Linear key). */
export function approvalCovers(a: StartApproval, key: string | null): boolean {
  const k = key?.toUpperCase() ?? null;
  if (k && a.declined.includes(k)) return false;
  if (!a.keys) return true;
  return !!k && a.keys.includes(k);
}

/**
 * The start gate's refusal: what counts (the developer's request in chat, "yes" to a proposal, New workspace on a
 * card) and the one plain question to ask when they really haven't asked. Never "only the card counts".
 */
export function startRefusal(a: StartApproval | null, key: string | null): string {
  const what = key ? `a workspace for ${key}` : "this workspace";
  const ask = `"Start ${what}?"`;
  const counts = "The developer's go-ahead counts in any form: their request in chat (\"start ACME-12\", \"create workspaces for these\"), \"yes\" to your proposal, or New workspace on your card.";
  if (!a) return `The developer's latest message doesn't ask for ${what}. ${counts} If they haven't asked, ask once in plain words, ${ask}, and wait for the answer.`;
  const k = key?.toUpperCase() ?? null;
  if (k && a.declined.includes(k)) return `The developer said no to ${k} (Skip or "not ${k}"). Don't start it; ask once, ${ask}, only if something changed.`;
  return `The developer approved ${a.keys!.join(", ")}, not ${key ?? "work without one of those keys"}. Start only what they approved; pass the Linear key as linear_key. ${counts} If they want more, ask once, ${ask}.`;
}

/** True when the developer's latest message approves at least one new workspace (any key). */
export function approvesNewWorkspace(message: string | null | undefined, proposal?: string | null): boolean {
  return !!startApproval(message, proposal);
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

/**
 * The pinned Overseer row on a surface with a list filter (Paseo's sidebar view; invariant one-row-everywhere): the
 * same row Home pins, from overseerRowState. While "Filter workspaces" holds a query, the row stays only when the
 * query is about it ("over", "asks", words of its line), the way Home's search keeps the Overseer reachable through
 * its Ask row; anything else hides it, so a filtered list shows only what matches.
 */
export function listOverseerRow(status: Parameters<typeof overseerRowState>[0], row: Parameters<typeof overseerRowState>[1], query: string): (NonNullable<ReturnType<typeof overseerRowState>> & { ranges?: [number, number][] }) | null {
  const o = overseerRowState(status, row);
  if (!o || !overseerMatches(o, query)) return null;
  const ranges = overseerLineRanges(o.line, query);
  return ranges.length ? { ...o, ranges } : o;
}
/** Where the query sits in the row's line, for the filter's highlight (the same marks rows get). */
export function overseerLineRanges(line: string, query: string): [number, number][] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: [number, number][] = [];
  const text = line.toLowerCase();
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}
/** An empty query, or one found in "Overseer" plus the row's line. */
export function overseerMatches(o: { line: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `overseer ${o.line}`.toLowerCase().includes(q);
}
/** What selecting the pinned row does where the list opens chats: a live Overseer opens its chat; Start and a
 * failed restart open Home's Overseer pane, where those controls live. */
export function overseerRowTarget(state: NonNullable<ReturnType<typeof overseerRowState>>["state"]): "chat" | "home" {
  return state === "start" || state === "error" ? "home" : "chat";
}
