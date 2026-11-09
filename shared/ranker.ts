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

export type RankWorkstream = { id: string; title: string; branch: string | null; group: string; ask: string | null; prs: string[]; keys: string[]; dormant: boolean };
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
    id: w.workspaceId, title: clip(w.title, RANK_LIMITS.titleChars), branch: w.branch, group: w.group, ask: w.ask ? clip(w.ask, RANK_LIMITS.textChars) : null,
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

export const RANK_SYSTEM = `You rank a developer's workstreams (Paseo workspaces) by what matters most today. Reply with one JSON object only, no prose or code fence:
{"priorities":[{"workspace":"<workspace id>","score":0-100,"reason":"<one line, at most 60 characters, or empty>","sources":[{"kind":"linear|slack|github|planning|paseo","label":"<short>","url":"<only a url given in the material>"}]}],"notStarted":[{"key":"<Linear key>","title":"<title>","url":"<url>","reason":"<one line>"}]}
Rules:
- Rank only workspace ids from WORKSTREAMS. Give every non-resting workstream a score; leave resting ones out unless an input names them.
- The reason is the concrete fact, at most 60 characters, fact first: "HER-1312 · Urgent · due today", "This week's Okta milestone", "Dana asked twice, demo tomorrow", "Review requested by Avi". Never start it with the source's name ("Slack:", "Plan:", "Linear:"): the list shows the source beside it. Never "important" or "high priority" alone.
- When no outside input (Linear, Slack, GitHub, plan) names a workstream, still score it, but give reason "" and sources [].
- Spread the scores: a clear outside signal (urgent or due Linear issue, a person asking in Slack, a review request, this week's plan) scores above one without. A workstream waiting on the developer (group needs) with a real ask scores higher than the same work without one.
- Use only facts in the material. Never invent a key, a person, a date or a url.
- notStarted: Linear issues assigned to the developer that no workstream covers (match by key in keys, branch or title), at most 10, most urgent first.`;

/** The material for one run, bounded: each list is cut to its limit before the prompt is built, never after. */
export function rankPrompt(inputs: RankInputs, today: string, maxChars: number): string {
  const L = RANK_LIMITS;
  const sections: [string, string[]][] = [
    ["WORKSTREAMS (id · title · group · branch · PRs · keys · open ask)", inputs.workstreams.slice(0, L.workstreams).map(w =>
      [w.id, w.title, w.dormant ? "resting" : w.group, w.branch ?? "-", w.prs.join(", ") || "-", w.keys.join(" ") || "-", w.ask ?? "-"].join(" · "))],
    ["LINEAR (assigned to the developer: key · priority · status · due · project / milestone · title · url)", inputs.linear.slice(0, L.issues).map(i =>
      [i.key, i.priority ?? "-", i.status ?? "-", i.due ?? "-", [i.project, i.milestone].filter(Boolean).join(" / ") || "-", clip(i.title, L.titleChars), i.url ?? "-"].join(" · "))],
    ["SLACK (DMs and mentions, last 48 h: where · who · text · when)", inputs.slack.slice(0, L.messages).map(m => [m.where, m.who ?? "-", clip(m.text, L.textChars), m.at ?? "-"].join(" · "))],
    ["GITHUB (review requested from the developer: repo#number · title · author · url)", inputs.github.slice(0, L.reviews).map(r => [`${r.repo}#${r.number}`, clip(r.title, L.titleChars), r.author ?? "-", r.url ?? "-"].join(" · "))],
    ["PLAN (the CPO's weekly plan: level · title · keys)", (inputs.planning?.items ?? []).slice(0, L.planItems).map(i => [i.level, clip(i.title, L.titleChars), i.keys.join(" ") || "-"].join(" · "))],
  ];
  const head = `Today is ${today} (Asia/Jerusalem).\n`;
  let body = sections.map(([title, lines]) => `${title}:\n${lines.length ? lines.join("\n") : "(none)"}`).join("\n\n");
  // Still too long: drop resting workstreams first, then the tail of each list.
  if (head.length + body.length > maxChars) {
    const lean = { ...inputs, workstreams: inputs.workstreams.filter(w => !w.dormant), slack: inputs.slack.slice(0, 20), linear: inputs.linear.slice(0, 30), planning: inputs.planning && { ...inputs.planning, items: inputs.planning.items.slice(0, 30) } };
    if (lean.workstreams.length < inputs.workstreams.length || lean.slack.length < inputs.slack.length || lean.linear.length < inputs.linear.length) return rankPrompt(lean, today, maxChars);
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
    const reason = clip(p.reason.split(/\r?\n/)[0].replace(SOURCE_PREFIX, ""), 140);
    // No outside signal: a score but no line, so the list doesn't fill with "nothing here".
    priorities.push({ workspaceId: w.id, score: Math.round(Math.min(100, p.score)), reason, sources: reason ? sources : [], at, by: "ranker" });
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
