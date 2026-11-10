import { batchView } from "./status";
import { liveLine, needsYou, prTone, stackOrder, type NeedItem, type PrTone } from "./attention";
import { activity, type Activity } from "./activity";
import { followUpObligations, recoveryBatch } from "./follow-up";
import { flagHeadline, HEADLINE_ICON, HEADLINE_TONE, HEADLINE_WORD, workspaceHeadline, withoutBriefQuestions, type Headline, type HeadlineKey, type HeadlineTone } from "./headline";
import { rowTitle, sectionOf, type InboxRow } from "./inbox";
import { settled, summary, type Pr, type Workspace } from "./model";
import { isOpen as questionOpen } from "./questions";
import { taskSchedule } from "./task-trigger";
import { freshPriorities, type Priority, type PrioritySourceKind } from "./priorities";
import { DEFAULT_SORT, sortItems, type SortMode } from "./sort";

/**
 * Home (design §3): every workstream in one list, grouped by what it needs from the developer. Pure, so the
 * grouping and the order inside Needs you are tested without a host. A workstream is a workspace with its root
 * agent; a workspace with several flagged root agents shows one row per agent.
 */

export const HOME_GROUPS = ["needs", "fixing", "running", "waiting", "later", "quiet"] as const;
export type HomeGroupId = typeof HOME_GROUPS[number];
export const GROUP_TITLE: Record<HomeGroupId, string> = {
  needs: "Needs you", fixing: "Follow-up is fixing", running: "Running", waiting: "Waiting on others", later: "Later", quiet: "Quiet",
};

/** Inside Needs you: blocking asks first, then decisions only the developer makes, then finished turns to sign off. */
export type Tier = 0 | 1 | 2;
const TIER: Record<HeadlineKey, Tier> = {
  permission: 0, error: 0, paused: 0, blocked: 0, decision: 0, question: 0,
  action: 1, repairs: 1, finish: 1, merge: 1, reviewers: 1, review: 1, flagged: 1,
  finished: 2, pr_closed: 2,
};
export const tierOf = (key: HeadlineKey): Tier => TIER[key];

export type BadgeTone = "warning" | "danger" | "success" | "merged" | "muted";
export type Badge = { text: string; tone: BadgeTone };
/**
 * The newest change of main agent within a day, when an agent or Follow-up made it (the developer knows their own).
 * Home badges it; the panel shows "Main agent changed: A → B" with Undo.
 */
export function recentMainChange(w: Pick<Workspace, "mainHistory" | "mainAgentId">, now: number): NonNullable<Workspace["mainHistory"]>[number] | null {
  const last = w.mainHistory?.at(-1);
  return last && last.by !== "developer" && last.to === w.mainAgentId && now - Date.parse(last.at) < 24 * 60 * 60_000 ? last : null;
}
export type PrChip = { label: string; tone: PrTone; checks: { text: string; tone: BadgeTone } | null; url: string | null };
/** A Paseo workspace as Home needs it. Untracked workspaces still get a row, in Quiet. */
export type PaseoWorkspaceLite = {
  id: string; name: string; project: string | null; activityAt: string | null;
  /** From the descriptor's git runtime (0.15.x); refreshed by Paseo, never by spawning git here. */
  branch?: string | null;
  /** The descriptor's own PR, when Paseo's GitHub runtime knows one. */
  pr?: { number: number | null; title: string } | null;
};

export type Workstream = {
  /** Stable list key: `agent:<id>` for an agent row, `ws:<id>` for a workspace row. */
  key: string;
  agentId: string | null;
  workspaceId: string | null;
  title: string;
  /** "› Agent" when the workspace has more than one root agent. */
  agent: string | null;
  project: string | null;
  group: HomeGroupId;
  tier: Tier | null;
  icon: string;
  tone: HeadlineTone | "running" | "success";
  /** Muted second part: the ask, the last action, or why it waits. */
  line: string;
  /** The decisive word for the line ("Permission", "Merge"), when there is one. */
  word: string | null;
  badges: Badge[];
  pr: PrChip | null;
  /** The age shown on the right. */
  at: string | null;
  readyToArchive: boolean;
  /** Latest activity anywhere on the workstream, for the Recent sort. */
  activityAt?: string | null;
  /** Existing importance data: a big open question. */
  urgent?: boolean;
  /** The nearest task deadline, when a scheduled task has one. */
  due?: string | null;
  /** A fresh external priority (Priority sort): the one-line reason and its sources. Never invented. */
  priority?: { score: number; reason: string; source: { kind: PrioritySourceKind; label: string } | null } | null;
  /** Changes whenever anything shown on the row changes, so a memoised row re-renders only then. */
  sig: string;
};

export type HomeGroup = { id: HomeGroupId; title: string; items: Workstream[] };
export type HomeModel = {
  groups: HomeGroup[]; needs: number; byKey: Map<string, Workstream>;
  /** The sort the groups are in, and when fresh external priorities were ranked (null: "By urgency"). */
  sort: SortMode; rankedAt: string | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Follow-up is fixing": only work that is in flight or about to go out on its own (shared/status.ts). */
const fixingBatch = (w: Workspace, now: number) => { const view = batchView(w, now); return view?.fixing && summary(w, now).status !== "done" ? view.batch : undefined; };

/** The PR chip: the first PR that hasn't settled (else the last one), "+n" for the rest, and its checks. */
export function prChip(w: Workspace | undefined): PrChip | null {
  if (!w?.prs.length) return null;
  const ordered = stackOrder(w.prs);
  const open = ordered.filter(p => !settled(p));
  const pr: Pr = open[0] ?? ordered.at(-1)!;
  const more = (open.length || ordered.length) - 1;
  const s = pr.snapshot;
  const checks = !s || pr.error ? null
    : s.state === "MERGED" ? { text: "merged", tone: "merged" as const }
    : s.state === "CLOSED" ? { text: "closed", tone: "muted" as const }
    : s.failedChecks.length ? { text: `✗ ${s.failedChecks.length}`, tone: "danger" as const }
    : s.checksPending ? { text: "running", tone: "muted" as const }
    : s.draft ? { text: "draft", tone: "muted" as const }
    : s.threads.length ? { text: plural(s.threads.length, "thread"), tone: "warning" as const }
    : { text: "✓", tone: "success" as const };
  return { label: `#${pr.number}${more > 0 ? `+${more}` : ""}`, tone: prTone(pr), checks, url: s?.url ?? null };
}

/** Up to two semantic badges, most telling first. */
export function badges(input: { headline: Headline | null; row?: InboxRow; workspace?: Workspace; items: NeedItem[] }): Badge[] {
  const out: Badge[] = [];
  const { headline: h, row, workspace: w, items } = input;
  const add = (b: Badge) => { if (!out.some(x => x.text === b.text)) out.push(b); };
  if (h?.key === "decision" || h?.key === "question") add({ text: "Asks you", tone: "warning" });
  if (h?.key === "permission") add({ text: "Needs approval", tone: "warning" });
  if (h?.key === "error") add({ text: "Error", tone: "danger" });
  if (h?.key === "paused") add({ text: "Paused", tone: "warning" });
  if (items.some(i => i.kind === "retry" && i.exhausted)) add({ text: "Budget reached", tone: "danger" });
  if (items.some(i => i.kind === "merge")) add({ text: "Merge ready", tone: "success" });
  if (items.some(i => i.kind === "reviewers")) add({ text: "No reviewers", tone: "warning" });
  if (w?.prs.some(p => p.snapshot?.state === "OPEN" && p.snapshot.conflict)) add({ text: "Conflict", tone: "danger" });
  if (!items.some(i => i.kind === "merge") && w?.prs.some(p => p.snapshot?.state === "OPEN" && p.snapshot.reviewDecision === "APPROVED")) add({ text: "Approved", tone: "success" });
  if (row && row.muteTurn) add({ text: "Muted turn", tone: "muted" });
  return out.slice(0, 2);
}

function sigOf(s: Omit<Workstream, "sig">): string {
  return [s.group, s.tier, s.icon, s.tone, s.title, s.agent, s.line, s.word, s.at, s.readyToArchive, s.badges.map(b => b.text).join("|"), s.pr ? `${s.pr.label}:${s.pr.checks?.text}` : "",
    s.priority ? `${s.priority.reason}:${s.priority.source?.label}` : ""].join("\u0001");
}
const make = (s: Omit<Workstream, "sig">): Workstream => ({ ...s, sig: sigOf(s) });
const stripSig = ({ sig: _sig, ...s }: Workstream): Omit<Workstream, "sig"> => s;

/** The Home group of a tracked workspace without an agent row: the order buildHome uses below. */
export function trackedGroup(w: Workspace, now: number): HomeGroupId {
  if (needsYou(w, now).length) return "needs";
  if (fixingBatch(w, now)) return "fixing";
  if (w.runtimeBusy) return "running";
  const state = summary(w, now);
  if (state.status === "done") return "quiet";
  if (w.prs.some(p => p.snapshot?.state === "OPEN") || state.status === "waiting") return "waiting";
  return "quiet";
}

/** Build every group from the inbox rows, Follow-up's tracked workspaces and Paseo's workspace list. */
export function buildHome(input: { rows: InboxRow[]; tracked: Workspace[]; paseo: PaseoWorkspaceLite[]; now: number; sort?: SortMode; priorities?: readonly Priority[]; hidden?: readonly string[] }): HomeModel {
  // Workspaces Follow-up keeps off the list (the Overseer's own): no row, no count.
  const hidden = new Set(input.hidden ?? []);
  const rows = input.rows.filter(r => !r.workspaceId || !hidden.has(r.workspaceId));
  const { now } = input;
  const sort = input.sort ?? DEFAULT_SORT;
  const fresh = freshPriorities(input.priorities ?? [], now);
  const tracked = new Map(input.tracked.filter(w => !w.archived && !hidden.has(w.id)).map(w => [w.id, w]));
  const paseo = new Map(input.paseo.filter(w => !hidden.has(w.id)).map(w => [w.id, w]));
  const project = (id: string | null) => id ? paseo.get(id)?.project ?? null : null;
  const out: Workstream[] = [];
  const covered = new Set<string>();
  /** Any root agent per workspace, so a workspace row can still show the agent's tail. */
  const anyAgent = new Map<string, string>();

  for (const row of rows) {
    if (row.workspaceId && !anyAgent.has(row.workspaceId)) anyAgent.set(row.workspaceId, row.agentId);
    const section = sectionOf(row, now);
    const w = row.workspaceId ? tracked.get(row.workspaceId) : undefined;
    const t = rowTitle(row);
    const base = { key: `agent:${row.agentId}`, agentId: row.agentId, workspaceId: row.workspaceId, title: t.primary, agent: t.agent, project: project(row.workspaceId), readyToArchive: false };
    if (section === "needs") {
      // The workspace's items go with its main agent's flag; another root agent's flag stands on its own.
      const items = w && w.mainAgentId === row.agentId ? withoutBriefQuestions(needsYou(w, now), row) : [];
      const h = flagHeadline(row, now, items);
      if (!h) continue;
      out.push(make({ ...base, group: "needs", tier: tierOf(h.key), icon: HEADLINE_ICON[h.key], tone: HEADLINE_TONE[h.key], word: HEADLINE_WORD[h.key],
        line: h.line === HEADLINE_WORD[h.key] ? "" : h.line, badges: badges({ headline: h, row, workspace: w, items }), pr: prChip(w), at: row.needs!.since }));
      if (row.workspaceId) covered.add(row.workspaceId);
    } else if (section === "later") {
      const h = flagHeadline({ ...row, snooze: null }, now);
      out.push(make({ ...base, group: "later", tier: null, icon: "AlarmClock", tone: "muted", word: h ? HEADLINE_WORD[h.key] : null,
        line: h && h.line !== HEADLINE_WORD[h.key] ? h.line : "", badges: [], pr: prChip(w), at: row.needs?.since ?? null }));
      if (row.workspaceId) covered.add(row.workspaceId);
    } else if (section === "running") {
      const fixing = w && w.mainAgentId === row.agentId ? fixingBatch(w, now) : undefined;
      out.push(make({ ...base, group: fixing ? "fixing" : "running", tier: null, icon: fixing ? "Wrench" : row.resumesAt ? "CirclePause" : "LoaderCircle", tone: "running",
        word: null, line: fixing ? w ? liveLine(w, now).text : "Fixing" : row.resumesAt ? "Paused at the usage limit" : "Working", badges: [], pr: prChip(w), at: fixing?.sentAt ?? row.lastActivityAt }));
      if (row.workspaceId) covered.add(row.workspaceId);
    }
  }

  for (const w of tracked.values()) {
    if (covered.has(w.id) || !w.enable_tracking) continue;
    covered.add(w.id);
    const base = { key: `ws:${w.id}`, agentId: w.mainAgentId, workspaceId: w.id, title: paseo.get(w.id)?.name || w.title, agent: null, project: project(w.id) };
    const items = needsYou(w, now);
    const group = trackedGroup(w, now);
    const h = workspaceHeadline(items);
    if (group === "needs" && h) {
      out.push(make({ ...base, group: "needs", tier: tierOf(h.key), icon: HEADLINE_ICON[h.key], tone: HEADLINE_TONE[h.key], word: HEADLINE_WORD[h.key], line: h.line,
        badges: badges({ headline: h, workspace: w, items }), pr: prChip(w), at: w.updatedAt, readyToArchive: false }));
      continue;
    }
    const fixing = fixingBatch(w, now);
    const state = summary(w, now);
    const live = liveLine(w, now);
    if (group === "fixing" && fixing) out.push(make({ ...base, group: "fixing", tier: null, icon: "Wrench", tone: "running", word: null, line: live.text, badges: [], pr: prChip(w), at: fixing.sentAt ?? fixing.createdAt, readyToArchive: false }));
    else if (group === "running") out.push(make({ ...base, group: "running", tier: null, icon: "LoaderCircle", tone: "running", word: null, line: live.text, badges: [], pr: prChip(w), at: w.updatedAt, readyToArchive: false }));
    else if (state.status === "done") out.push(make({ ...base, group: "quiet", tier: null, icon: "CircleCheck", tone: "success", word: null, line: w.completion?.summary ?? "Done", badges: [], pr: prChip(w), at: w.completion?.declaredAt ?? w.updatedAt, readyToArchive: true }));
    else if (group === "waiting") out.push(make({ ...base, group: "waiting", tier: null, icon: "Clock", tone: "muted", word: null, line: live.text, badges: badges({ headline: null, workspace: w, items }), pr: prChip(w), at: w.updatedAt, readyToArchive: false }));
    else out.push(make({ ...base, group: "quiet", tier: null, icon: "Circle", tone: "muted", word: null, line: live.text, badges: [], pr: prChip(w), at: w.updatedAt, readyToArchive: false }));
  }

  for (const p of paseo.values()) {
    if (covered.has(p.id)) continue;
    out.push(make({ key: `ws:${p.id}`, agentId: anyAgent.get(p.id) ?? null, workspaceId: p.id, title: p.name, agent: null, project: p.project, group: "quiet", tier: null,
      icon: "Circle", tone: "muted", word: null, line: "", badges: [], pr: null, at: p.activityAt, readyToArchive: false }));
  }

  // Facts the sorts read: latest activity, importance, deadlines and fresh external priorities.
  const lastActivity = new Map<string, string>();
  const bump = (key: string | null, at: string | null | undefined) => { if (key && at && (!lastActivity.has(key) || lastActivity.get(key)! < at)) lastActivity.set(key, at); };
  for (const r of rows) { bump(r.workspaceId, r.lastActivityAt); bump(`agent:${r.agentId}`, r.lastActivityAt); }
  for (const p of paseo.values()) bump(p.id, p.activityAt);
  for (const w of tracked.values()) bump(w.id, w.updatedAt);
  const finished: Workstream[] = out.map(s => {
    const w = s.workspaceId ? tracked.get(s.workspaceId) : undefined;
    const p = s.workspaceId ? fresh.byWorkspace.get(s.workspaceId) : undefined;
    const activityAt = [s.at, lastActivity.get(s.key) ?? null, s.workspaceId ? lastActivity.get(s.workspaceId) ?? null : null].filter((x): x is string => !!x).sort().at(-1) ?? null;
    const urgent = !!w?.questions.some(q => questionOpen(q) && !!q.big);
    const due = w ? followUpObligations(w).filter(o => !["done", "waived"].includes(o.status)).map(o => taskSchedule(o, w, now).dueAt).filter((x): x is string => !!x).sort()[0] ?? null : null;
    const priority = p ? { score: p.score, reason: p.reason, source: p.sources[0] ? { kind: p.sources[0].kind, label: p.sources[0].label } : null } : null;
    // Rule 5 of main-agent claims: a quiet badge for a day after an agent or Follow-up changed the main agent.
    // Last in line, so it never pushes out a badge that asks for something.
    const badges = w && recentMainChange(w, now) ? [...s.badges, { text: "Main agent changed", tone: "muted" as const }].slice(0, 2) : s.badges;
    return make({ ...stripSig(s), badges, activityAt, urgent, due, priority });
  });
  const byGroup = new Map<HomeGroupId, Workstream[]>(HOME_GROUPS.map(g => [g, []]));
  for (const s of finished) byGroup.get(s.group)!.push(s);
  for (const id of HOME_GROUPS) {
    const items = sortItems(byGroup.get(id)!, sort, id, fresh.byWorkspace);
    // Quiet folds by project; each fold keeps the chosen order.
    byGroup.set(id, id === "quiet" ? [...items].sort((a, b) => (a.project ?? "￿").localeCompare(b.project ?? "￿")) : items);
  }
  const groups = HOME_GROUPS.map(id => ({ id, title: GROUP_TITLE[id], items: byGroup.get(id)! })).filter(g => g.items.length > 0);
  return { groups, needs: byGroup.get("needs")!.length, byKey: new Map(finished.map(s => [s.key, s])), sort, rankedAt: fresh.rankedAt };
}

/**
 * The status at a glance: one count per group (and ready to archive). Home's strip, the navigator, the sidebar badge
 * and the brief headline all read this, so they never disagree.
 */
export type HomeCounts = Record<HomeGroupId, number> & { archivable: number };
export function homeCounts(model: Pick<HomeModel, "groups">): HomeCounts {
  const out = Object.fromEntries(HOME_GROUPS.map(g => [g, 0])) as HomeCounts;
  out.archivable = 0;
  for (const g of model.groups) { out[g.id] = g.items.length; if (g.id === "quiet") out.archivable = g.items.filter(s => s.readyToArchive).length; }
  return out;
}

/** Needs you: tier, then the longest wait first, then key for a stable order. */
export function compareNeedsItems(a: Pick<Workstream, "tier" | "at" | "key">, b: Pick<Workstream, "tier" | "at" | "key">): number {
  return (a.tier ?? 3) - (b.tier ?? 3) || (a.at ?? "￿").localeCompare(b.at ?? "￿") || a.key.localeCompare(b.key);
}

/** "Sign off & next" inside Home: the top of Needs you that isn't the row just handled. */
export function nextNeeds(model: HomeModel, after: string | null): Workstream | null {
  return model.groups.find(g => g.id === "needs")?.items.find(s => s.key !== after) ?? null;
}

/** Quiet, folded by project. Projects with the most recent activity first. */
export function quietFolds(items: Workstream[]): { project: string; items: Workstream[]; archivable: number }[] {
  const by = new Map<string, Workstream[]>();
  for (const s of items) { const k = s.project ?? "Other"; by.set(k, [...by.get(k) ?? [], s]); }
  return [...by.entries()].map(([project, list]) => ({ project, items: list, archivable: list.filter(s => s.readyToArchive).length }))
    .sort((a, b) => b.items.length - a.items.length || a.project.localeCompare(b.project));
}

// ---------- the brief pane and the log ----------

/** The end of the last workday before `now` (18:00 local), skipping weekends: "since you were last here". */
export function lastWorkdayEnd(now: number): number {
  const d = new Date(now);
  d.setHours(18, 0, 0, 0);
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}

export type LogLine = Activity & { workspaceId: string; workspaceTitle: string; agentId: string };
/** What Follow-up did on its own (repairs it sent and how they went, recoveries), newest first. Nothing the developer did. */
export function followUpLog(workspaces: Workspace[], since: number): LogLine[] {
  const own = /^(sent|done|stopped|recovery):/;
  return workspaces.filter(w => !w.archived).flatMap(w => activity(w).filter(a => own.test(a.key) && Date.parse(a.at) >= since)
    .map(a => ({ ...a, key: `${w.id}:${a.key}`, workspaceId: w.id, workspaceTitle: w.title, agentId: w.mainAgentId })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
}

export type BriefPaneModel = {
  headline: string;
  /** The row the headline points at, so the pane can offer it as the first move. */
  first: Workstream | null;
  waiting: string | null;
  cleared: string | null;
  away: { count: number; top: LogLine[] };
  counts: HomeCounts;
};

const MOVE: Partial<Record<HeadlineKey, string>> = {
  permission: "It's waiting on a permission.", error: "It stopped on an error.", paused: "It's paused until you look.", blocked: "Follow-up is blocked on it.",
  decision: "The agent is blocked on your answer.", question: "The agent is waiting on your answer.", merge: "It's approved and ready to merge.",
  reviewers: "Its PR has no reviewers yet.", repairs: "Fixes are ready to send.", finish: "Its work is in; ask the agent to declare Done.", review: "It has review feedback.", action: "It needs something only you can do.",
  finished: "It finished and is waiting for your sign-off.", pr_closed: "Its PR merged or closed.",
};
const keyOfWord = (word: string | null): HeadlineKey | null => (Object.entries(HEADLINE_WORD).find(([, w]) => w === word)?.[0] as HeadlineKey | undefined) ?? null;

/** Brief pane v0 (design §4): a headline that names the first move, the waiting note, what cleared, Done while away. */
export function briefPane(input: { model: HomeModel; rows: InboxRow[]; tracked: Workspace[]; now: number }): BriefPaneModel {
  const { model, rows, tracked, now } = input;
  const since = lastWorkdayEnd(now);
  const get = (id: HomeGroupId) => model.groups.find(g => g.id === id)?.items ?? [];
  const needs = get("needs"), fixing = get("fixing"), live = get("running"), waiting = get("waiting");
  const first = needs[0] ?? null;
  let headline: string;
  if (first) {
    const key = keyOfWord(first.word);
    const more = needs.length > 1 ? ` ${plural(needs.length - 1, "other thing", "other things")} after that.` : "";
    headline = `Start with ${first.title}. ${(key && MOVE[key]) ?? "It needs you."}${more}`;
  } else headline = fixing.length || live.length
    ? `Nothing needs you. ${[live.length ? `${live.length} running` : "", fixing.length ? `Follow-up is fixing ${fixing.length}` : ""].filter(Boolean).join(", ")}.`
    : "Nothing needs you.";
  const oldestWait = waiting[0];
  const waitingNote = oldestWait ? `${oldestWait.title}${oldestWait.pr ? ` (${oldestWait.pr.label})` : ""}: ${oldestWait.line || "waiting"}${waiting.length > 1 ? `, and ${waiting.length - 1} more waiting on others` : ""}.` : null;
  const merged = tracked.flatMap(w => w.prs).filter(p => p.snapshot?.state === "MERGED" && p.snapshot.mergedAt && Date.parse(p.snapshot.mergedAt) >= since).length;
  const signed = rows.filter(r => r.signedOffAt && Date.parse(r.signedOffAt) >= since).length;
  const cleared = merged || signed ? [merged ? `${plural(merged, "PR")} merged` : "", signed ? `${signed} signed off` : ""].filter(Boolean).join(", ") : null;
  const log = followUpLog(tracked, since);
  return { headline, first, waiting: waitingNote, cleared, away: { count: log.length, top: log.slice(0, 4) },
    counts: homeCounts(model) };
}

/** "Mon 18:00": when "since you were away" starts, for the pane's labels. */
export function sinceLabel(now: number): string {
  const d = new Date(lastWorkdayEnd(now));
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

// ---------- the detail pane ----------

export type TailStep = { kind: "you" | "agent" | "tool" | "error"; text: string; failed?: boolean };
type TimelineItem = { type: string; text?: string; message?: string; name?: string; status?: string; detail?: Record<string, unknown> | null; error?: unknown };
/**
 * The agent's last `n` steps for "Recent · last N steps": messages, one-line tool calls and errors. Reasoning,
 * todos and plugin rows (the brief card itself) are left out; the pane shows the brief above.
 */
export function tailSteps(items: TimelineItem[], n = 6): TailStep[] {
  const out: TailStep[] = [];
  for (const it of items) {
    if (it.type === "user_message" && it.text) out.push({ kind: "you", text: it.text });
    else if (it.type === "assistant_message" && it.text) {
      // Streaming arrives as several chunks of one message: join consecutive agent text.
      const last = out.at(-1);
      if (last?.kind === "agent") last.text += it.text; else out.push({ kind: "agent", text: it.text });
    } else if (it.type === "tool_call") {
      const d = it.detail ?? {};
      const what = [d.command, d.filePath, d.path, d.url, d.query, d.pattern].find(v => typeof v === "string" && v.trim()) as string | undefined;
      // MCP tools read by their own name: "mcp__follow-through__send_to_agent" and "mcp__paseo__follow_send_to_agent" are "send_to_agent".
      out.push({ kind: "tool", text: `${(it.name ?? "Tool").replace(/^mcp__.+?__/, "").replace(/^follow_/, "")}${what ? ` · ${what.split("\n")[0]}` : ""}`, failed: it.status === "failed" || !!it.error });
    } else if (it.type === "error" && it.message) out.push({ kind: "error", text: it.message });
  }
  return out.slice(-n);
}

export type PaneInput = {
  /** Pending permission prompts on the agent. */
  permissions: number;
  /** The open brief has decisions with options: the options are the move. */
  decisions: boolean;
  /** The workspace's own items (merge, reviewers, send, hold…). */
  items: NeedItem["kind"][];
  flagged: boolean;
  hasAgent: boolean;
};
export type PaneButton = "allow" | "deny" | "sign_off" | "sign_off_next" | "later" | "open_full" | "reply";
/**
 * Which buttons the detail pane shows and the one that is filled (design §6: only one filled primary on screen).
 * A permission's Allow wins, then a workspace item's own primary (Resume, Send repairs), then decision options
 * (outlined, so none is filled), else Sign off.
 */
export function paneButtons(p: PaneInput): { buttons: PaneButton[]; primary: PaneButton | "item" | null } {
  const buttons: PaneButton[] = [];
  if (p.permissions) buttons.push("deny", "allow");
  if (p.flagged) buttons.push("sign_off", "sign_off_next", "later");
  buttons.push("open_full");
  if (p.hasAgent) buttons.push("reply");
  const primary = p.permissions ? "allow"
    : p.items.some(k => k === "hold" || k === "send") ? "item"
    : p.decisions ? null
    : p.flagged ? "sign_off" : null;
  return { buttons, primary };
}

/** Two lines say the same thing (trimmed, case-insensitive, ignoring trailing punctuation): show only one of them. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (x: string | null | undefined) => (x ?? "").trim().replace(/[.!?…:;,\s]+$/u, "").replace(/\s+/g, " ").toLowerCase();
  return !!n(a) && n(a) === n(b);
}
