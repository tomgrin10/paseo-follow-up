import { z } from "zod";
import { PRIORITY_SOURCES, prioritySourceSchema, type Priority } from "./priorities";
import type { WorkstreamRow } from "./overseer";

/**
 * The ranker (1.4.0-beta.0, slice 3): one bounded model job that orders Tom's workstreams by what matters today and
 * says why in one line that names its source. Follow-up collects every input itself, read-only and without model
 * tools (Follow-up's own state, Linear, Slack, GitHub review requests and the CPO's weekly plan), hashes them, and
 * calls the model only when they changed. The result goes to the priorities store Home's Priority sort already reads.
 */

export const RANK_SOURCES = ["linear", "slack", "github", "planning"] as const;
export type RankSource = typeof RANK_SOURCES[number];
export const RANK_SOURCE_LABEL: Record<RankSource, string> = { linear: "Linear", slack: "Slack", github: "GitHub", planning: "Plan" };
export type SourceHealth = "ok" | "failed" | "off";

/** `row`: the Home row it was read from. Not in the prompt or the stable inputs; the reply's priority keeps it. */
export type RankWorkstream = { id: string; row?: string; title: string; branch: string | null; group: string; ask: string | null; prs: string[]; keys: string[]; dormant: boolean };
export type RankIssue = { key: string; title: string; priority: string | null; status: string | null; due: string | null; project: string | null; milestone: string | null; url: string | null };
export type RankMessage = { where: string; who: string | null; text: string; at: string | null };
export type RankReview = { repo: string; number: number; title: string; url: string | null; author: string | null };
export type RankPlanItem = { level: string; title: string; keys: string[] };
export type RankPlanning = { title: string | null; url: string | null; items: RankPlanItem[] };
export type RankInputs = { workstreams: RankWorkstream[]; linear: RankIssue[]; slack: RankMessage[]; github: RankReview[]; planning: RankPlanning | null };

export const RANK_LIMITS = { workstreams: 150, issues: 60, messages: 40, reviews: 30, planItems: 60, textChars: 220, titleChars: 120 };
const clip = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The ranker's view of a workstream. Follow-up's own priority is left out, so a ranking never feeds itself. */
export function rankWorkstream(w: WorkstreamRow): RankWorkstream {
  return {
    id: w.workspaceId, ...(w.key ? { row: w.key } : {}), title: clip(w.title, RANK_LIMITS.titleChars), branch: w.branch, group: w.group, ask: w.ask ? clip(w.ask, RANK_LIMITS.textChars) : null,
    prs: w.prs.map(p => `#${p.number} ${p.state.toLowerCase()}${p.checks ? ` checks ${p.checks}` : ""}`), keys: w.keys, dormant: w.dormant,
  };
}

/** Stable across runs: sorted, no timestamps that move by themselves. Equal text means the model would see the same thing. */
export function stableInputs(inputs: RankInputs): string {
  const stable = {
    w: [...inputs.workstreams].sort((a, b) => a.id.localeCompare(b.id)).map(w => [w.id, w.title, w.branch, w.group, w.ask, w.prs, w.keys, w.dormant]),
    l: [...inputs.linear].sort((a, b) => a.key.localeCompare(b.key)).map(i => [i.key, i.title, i.priority, i.status, i.due, i.project, i.milestone]),
    s: inputs.slack.map(m => [m.where, m.who, m.text]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    g: [...inputs.github].sort((a, b) => `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`)).map(r => [r.repo, r.number, r.title]),
    p: inputs.planning ? inputs.planning.items.map(i => [i.level, i.title, i.keys]) : null,
  };
  return JSON.stringify(stable);
}

/**
 * Added for models other than Claude: Codex left reasons empty below its top five. The rules are the same; this
 * restates the one it broke, at the end where it carries most weight.
 */
export const RANK_STRICT = `\nCheck before replying: every object in "priorities" has a "reason" of at least three words. An empty reason, "", "-" or "n/a" is invalid. Reply with the JSON only.`;

export const RANK_SYSTEM = `You rank a developer's workstreams (Paseo workspaces) by what matters most today. Reply with one JSON object only, no prose or code fence:
{"priorities":[{"workspace":"<workspace id>","score":0-100,"reason":"<one line, at most 60 characters, never empty>","sources":[{"kind":"linear|slack|github|planning|paseo","label":"<short>","url":"<only a url given in the material>"}]}],"notStarted":[{"key":"<Linear key>","title":"<title>","url":"<url>","reason":"<one line>"}]}
Rules:
- Rank only workspace ids from WORKSTREAMS. Give every non-resting workstream a score; leave resting ones out unless an input names them.
- The reason is the concrete fact, at most 60 characters, fact first: "ACME-1312 · Urgent · due today", "This week's Okta milestone", "Dana asked twice, demo tomorrow", "Review requested by Avi". Never start it with the source's name ("Slack:", "Plan:", "Linear:"): the list shows the source beside it. Never "important" or "high priority" alone.
- Every ranked workstream has a non-empty reason. When no outside input (Linear, Slack, GitHub, plan) names it, the reason is its strongest Paseo fact (its open ask, PR state or checks, "agent stopped") with sources [{"kind":"paseo","label":"Paseo"}]. Never filler like "no outside signal".
- Direct asks to the developer weigh at least as much as this week's plan milestones: a Slack DM or mention waiting on them, a GitHub review requested from them, a workstream waiting on their decision (group needs with an open ask). Never rank a plan item above a direct ask of similar urgency; a direct ask from a person with a deadline ranks above any plan item.
- Stability: PREVIOUS RANKING lists each workstream's last score. Keep a workstream within 10 points of it unless something about that workstream changed (a new Slack line, issue state, review request, PR or ask). Don't reshuffle what didn't change.
- Spread the scores: a clear outside signal (urgent or due Linear issue, a person asking in Slack, a review request, this week's plan) scores above one without. A workstream waiting on the developer (group needs) with a real ask scores higher than the same work without one.
- Use only facts in the material. Never invent a key, a person, a date or a url.
- notStarted: Linear issues assigned to the developer that no workstream covers (match by key in keys, branch or title), at most 10, most urgent first.`;

/** The material for one run, bounded: each list is cut to its limit before the prompt is built, never after. */
export function rankPrompt(inputs: RankInputs, today: string, maxChars: number, previous: readonly { id: string; score: number }[] = []): string {
  const L = RANK_LIMITS;
  const sections: [string, string[]][] = [
    ["WORKSTREAMS (id · title · group · branch · PRs · keys · open ask)", inputs.workstreams.slice(0, L.workstreams).map(w =>
      [w.id, w.title, w.dormant ? "resting" : w.group, w.branch ?? "-", w.prs.join(", ") || "-", w.keys.join(" ") || "-", w.ask ?? "-"].join(" · "))],
    ["LINEAR (assigned to the developer: key · priority · status · due · project / milestone · title · url)", inputs.linear.slice(0, L.issues).map(i =>
      [i.key, i.priority ?? "-", i.status ?? "-", i.due ?? "-", [i.project, i.milestone].filter(Boolean).join(" / ") || "-", clip(i.title, L.titleChars), i.url ?? "-"].join(" · "))],
    ["SLACK (DMs and mentions, last 48 h: where · who · text · when)", inputs.slack.slice(0, L.messages).map(m => [m.where, m.who ?? "-", clip(m.text, L.textChars), m.at ?? "-"].join(" · "))],
    ["GITHUB (review requested from the developer: repo#number · title · author · url)", inputs.github.slice(0, L.reviews).map(r => [`${r.repo}#${r.number}`, clip(r.title, L.titleChars), r.author ?? "-", r.url ?? "-"].join(" · "))],
    ["PLAN (the CPO's weekly plan: level · title · keys)", (inputs.planning?.items ?? []).slice(0, L.planItems).map(i => [i.level, clip(i.title, L.titleChars), i.keys.join(" ") || "-"].join(" · "))],
    ...(previous.length ? [["PREVIOUS RANKING (id · score)", previous.filter(p => inputs.workstreams.some(w => w.id === p.id)).map(p => `${p.id} · ${p.score}`)] as [string, string[]]] : []),
  ];
  const head = `Today is ${today} (Asia/Jerusalem).\n`;
  let body = sections.map(([title, lines]) => `${title}:\n${lines.length ? lines.join("\n") : "(none)"}`).join("\n\n");
  // Still too long: drop resting workstreams first, then the tail of each list.
  if (head.length + body.length > maxChars) {
    const lean = { ...inputs, workstreams: inputs.workstreams.filter(w => !w.dormant), slack: inputs.slack.slice(0, 20), linear: inputs.linear.slice(0, 30), planning: inputs.planning && { ...inputs.planning, items: inputs.planning.items.slice(0, 30) } };
    if (lean.workstreams.length < inputs.workstreams.length || lean.slack.length < inputs.slack.length || lean.linear.length < inputs.linear.length) return rankPrompt(lean, today, maxChars, previous);
    body = body.slice(0, Math.max(0, maxChars - head.length - 1));
  }
  return head + body;
}

const sourceOut = z.object({ kind: z.enum(PRIORITY_SOURCES), label: z.string().trim().min(1).max(60), url: z.string().url().max(2000).optional().catch(undefined) });
export const rankReplySchema = z.object({
  priorities: z.array(z.object({ workspace: z.string().trim().min(1).max(200), score: z.number().min(0).max(100), reason: z.string().trim().max(300).catch(""), sources: z.array(sourceOut).max(5).catch([]).default([]) })).max(200),
  notStarted: z.array(z.object({ key: z.string().trim().min(1).max(30), title: z.string().trim().min(1).max(200), url: z.string().url().max(2000).optional().catch(undefined), reason: z.string().trim().max(300).catch("") })).max(20).catch([]).default([]),
});
export type RankReply = z.infer<typeof rankReplySchema>;
/** Ranked workspaces whose reason is missing or a placeholder: the ranker asks once more, naming them. */
export function emptyReasons(reply: RankReply, inputs: RankInputs): string[] {
  const known = new Set(inputs.workstreams.map(w => w.id));
  return reply.priorities.filter(p => known.has(p.workspace) && !meaningful(p.reason)).map(p => p.workspace);
}
const meaningful = (reason: string) => { const r = reason.replace(SOURCE_PREFIX, "").trim(); return r.length >= 3 && !/^(-+|n\/?a|none|tbd|\.+)$/i.test(r); };
export const REASON_SYSTEM = `You write the one-line reason for workstreams that were already ranked. Reply with one JSON object only, no prose or code fence:
{"reasons":[{"workspace":"<workspace id>","reason":"<one line, at most 60 characters, never empty>","sources":[{"kind":"linear|slack|github|planning|paseo","label":"<short>","url":"<only a url given in the material>"}]}]}
Rules:
- One entry for every workspace id in WORKSTREAMS, and no others.
- The reason is the concrete fact, fact first: "ACME-1312 · Urgent · due today", "Dana asked twice, demo tomorrow", "Review requested by Avi". Never start it with the source's name.
- When no outside input names it, use its strongest Paseo fact (its open ask, PR state or checks, "agent stopped") with sources [{"kind":"paseo","label":"Paseo"}].
- Use only facts in the material. An empty reason is invalid.`;
export const reasonReplySchema = z.object({
  reasons: z.array(z.object({ workspace: z.string().trim().min(1).max(200), reason: z.string().trim().max(300).catch(""), sources: z.array(sourceOut).max(5).catch([]).default([]) })).max(200),
});
export type ReasonReply = z.infer<typeof reasonReplySchema>;

/**
 * The cheap retry's material: only the workspaces that came back without a reason, and only the outside inputs
 * that can be about them (their Linear keys, their PRs' review requests, plan items with their keys, the Slack lines).
 */
export function reasonInputs(inputs: RankInputs, ids: readonly string[]): RankInputs {
  const want = new Set(ids);
  const workstreams = inputs.workstreams.filter(w => want.has(w.id));
  const keys = new Set(workstreams.flatMap(w => w.keys.map(k => k.toUpperCase())));
  const prs = new Set(workstreams.flatMap(w => w.prs.map(p => p.split(" ")[0])));
  return {
    workstreams,
    linear: inputs.linear.filter(i => keys.has(i.key.toUpperCase())),
    slack: inputs.slack,
    github: inputs.github.filter(r => prs.has(`#${r.number}`)),
    planning: inputs.planning && { ...inputs.planning, items: inputs.planning.items.filter(i => i.keys.some(k => keys.has(k.toUpperCase()))) },
  };
}
/** The first reply with the retry's reasons filled in where it had none; scores and order stay the model's first answer. */
export function fillReasons(reply: RankReply, more: ReasonReply): RankReply {
  const by = new Map(more.reasons.filter(r => meaningful(r.reason)).map(r => [r.workspace, r]));
  return { ...reply, priorities: reply.priorities.map(p => meaningful(p.reason) || !by.has(p.workspace) ? p : { ...p, reason: by.get(p.workspace)!.reason, sources: by.get(p.workspace)!.sources }) };
}
/** Still empty after the retry: the workspace's own strongest fact, so no row is left without one. */
export function paseoReason(w: RankWorkstream): string {
  if (w.ask) return clip(w.ask, 60);
  const failing = w.prs.find(p => /checks failed/.test(p));
  if (failing) return clip(failing.replace(/ open/, ""), 60);
  const open = w.prs.filter(p => / open/.test(p));
  if (open.length) return open.length === 1 ? `${open[0].split(" ")[0]} open` : `${open.length} PRs open`;
  return w.group === "running" ? "Agent working" : "Recent activity in Paseo";
}

/** "Slack: ", "Plan: "…: the source chip already says it. */
const SOURCE_PREFIX = /^(slack|plan|planning|linear|github|paseo)\s*[:·-]\s*/i;
export type NotStarted = { key: string; title: string; url: string | null; reason: string };

/**
 * The reply as priorities Home can show: known workspace ids only, one per workspace (the first), reasons cut to one
 * line, urls only when the material had them. Blocking asks need no floor: Home lists Needs you first whatever the score.
 */
export function toPriorities(reply: RankReply, inputs: RankInputs, at: string): { priorities: Priority[]; notStarted: NotStarted[]; dropped: string[] } {
  const by = new Map(inputs.workstreams.map(w => [w.id, w]));
  const urls = new Set<string>([...inputs.linear.map(i => i.url), ...inputs.github.map(r => r.url), inputs.planning?.url ?? null].filter((u): u is string => !!u));
  const seen = new Set<string>(); const dropped: string[] = [];
  const priorities: Priority[] = [];
  for (const p of reply.priorities) {
    const w = by.get(p.workspace);
    if (!w) { dropped.push(p.workspace); continue; }
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const sources = p.sources.map(s => ({ kind: s.kind, label: clip(s.label, 60), ...(s.url && urls.has(s.url) ? { url: s.url } : {}) })).filter(s => prioritySourceSchema.safeParse(s).success);
    const given = clip(p.reason.split(/\r?\n/)[0].replace(SOURCE_PREFIX, ""), 140);
    // Every ranked row has a reason: the model's, or (after the retry still failed) the workspace's own fact.
    const reason = meaningful(given) ? given : paseoReason(w);
    priorities.push({ workspaceId: w.id, score: Math.round(Math.min(100, p.score)), reason, sources: reason === given ? sources : [{ kind: "paseo", label: "Paseo" }], at, by: "ranker", ...(w.row ? { row: w.row } : {}) });
  }
  priorities.sort((a, b) => b.score - a.score || a.workspaceId.localeCompare(b.workspaceId));
  const covered = new Set(inputs.workstreams.flatMap(w => w.keys.map(k => k.toUpperCase())));
  const known = new Map(inputs.linear.map(i => [i.key.toUpperCase(), i]));
  const notStarted = reply.notStarted.filter(n => known.has(n.key.toUpperCase()) && !covered.has(n.key.toUpperCase())).slice(0, 10)
    .map(n => { const i = known.get(n.key.toUpperCase())!; return { key: i.key, title: i.title, url: i.url, reason: clip(n.reason, 140) }; });
  return { priorities, notStarted, dropped };
}

// ---------- when it runs ----------

const JERUSALEM = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
/** The Asia/Jerusalem calendar day and hour for a moment. */
export function jerusalem(now: number): { day: string; weekday: string; hour: number } {
  const parts = Object.fromEntries(JERUSALEM.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour: Number(parts.hour) };
}
/** Sunday to Thursday, 08:00–20:00 in Asia/Jerusalem: the automatic runs. "Re-rank now" works any time. */
export function inRankWindow(now: number): boolean {
  const j = jerusalem(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(j.weekday) && j.hour >= 8 && j.hour < 20;
}

/** "Linear ok · Slack failed · Plan off": what the last run could read, for the sort header. */
export function healthLine(health: Partial<Record<RankSource, SourceHealth>>): string {
  return RANK_SOURCES.filter(s => health[s] && health[s] !== "ok").map(s => `${RANK_SOURCE_LABEL[s]} ${health[s] === "off" ? "off" : "unavailable"}`).join(" · ");
}

/** What the last model run cost: dollars when the CLI says; Codex is billed to the subscription, so no price. */
export function rankCost(rank: { costUsd?: number | null; last?: { ok: boolean; skipped: string | null; provider: string | null } | null } | null): string {
  const last = rank?.last;
  // The standing ranking's cost: shown after a skipped run too; nothing before the first model run.
  if (!last?.provider) return "";
  if (last.provider === "codex") return "last run on Codex subscription";
  const c = rank?.costUsd;
  return c == null ? "" : c < 0.01 ? "last run <$0.01" : `last run $${c.toFixed(2)}`;
}

// ---------- stability ----------

/** Most a workspace's score may move in one run when nothing about it changed. */
export const STEADY_CAP = 10;

/**
 * Everything the ranker sees about one workspace: its own row, the Linear issues with its keys, review requests for
 * its PRs, plan items with its keys, and Slack lines naming a key, a PR or its branch. Equal means "nothing changed
 * for it", so its score may only drift by STEADY_CAP.
 */
export function workspaceInputs(w: RankWorkstream, inputs: RankInputs): string {
  const keys = new Set(w.keys.map(k => k.toUpperCase()));
  const prs = new Set(w.prs.map(p => p.split(" ")[0]));
  const words = [...keys, ...prs, ...(w.branch ? [w.branch.toLowerCase()] : [])];
  return JSON.stringify([
    [w.title, w.group, w.ask, w.prs, w.keys, w.dormant],
    inputs.linear.filter(i => keys.has(i.key.toUpperCase())).map(i => [i.key, i.priority, i.status, i.due, i.milestone]).sort(),
    inputs.github.filter(r => prs.has(`#${r.number}`)).map(r => r.number).sort(),
    (inputs.planning?.items ?? []).filter(i => i.keys.some(k => keys.has(k.toUpperCase()))).map(i => i.title).sort(),
    inputs.slack.filter(m => words.some(x => m.text.toUpperCase().includes(x.toUpperCase()))).map(m => [m.who, m.text]).sort(),
  ]);
}

/** New scores, held within STEADY_CAP of the previous ones for workspaces whose own inputs didn't change. */
export function damped<T extends { workspaceId: string; score: number }>(items: readonly T[], previous: ReadonlyMap<string, { score: number; fp: string }>, fps: ReadonlyMap<string, string>): T[] {
  return items.map(p => {
    const prev = previous.get(p.workspaceId);
    if (!prev || prev.fp !== fps.get(p.workspaceId)) return p;
    return { ...p, score: Math.max(prev.score - STEADY_CAP, Math.min(prev.score + STEADY_CAP, p.score)) };
  }).sort((a, b) => b.score - a.score || a.workspaceId.localeCompare(b.workspaceId));
}
