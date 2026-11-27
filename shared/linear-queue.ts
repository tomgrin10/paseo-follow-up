import { z } from "zod";
import { PRIORITY_NAMES, type LinearIssue } from "./linear-issues";
import { WEEKDAYS, defaultWorkdays, type Weekday } from "./workweek";

export { WEEKDAYS, defaultWorkdays, type Weekday };

/**
 * The Morning brief's Linear queue (docs/morning-brief.md): every issue assigned to the developer in the states that
 * count as the queue, swept whole each workday morning, kept as a snapshot, and diffed against the last complete
 * sweep so the brief can say "ACME-142 raised Low → High since Friday". Pure: the sweep itself is server/linear-queue.ts.
 *
 * Linear's priority numbers: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 No priority (the least urgent here).
 */

// ---------- settings and the clock ----------

/** Linear state types that can count as the queue. Completed and canceled never do. */
export const QUEUE_STATE_TYPES = ["triage", "backlog", "unstarted", "started"] as const;
export type QueueStateType = typeof QUEUE_STATE_TYPES[number];

/** What "since" falls back to: the last time the developer read the brief (default), or always the last workday's sweep. */
export const SINCE_MODES = ["read", "workday"] as const;
export type SinceMode = typeof SINCE_MODES[number];

/**
 * The brief's queue settings (Settings → Morning brief → Linear queue; stored in morning-brief.json, shared/morning-brief.ts).
 * `timeZone` null: the developer's device's zone, else the host's. `workdays` null: the zone's usual working week.
 * `since`: "read" is the last read before this viewing session, falling back to the last workday's sweep; "workday" is
 * always the last workday's sweep. Both are stored points (a-change-is-against-what-you-last-saw), never a rolling 24 h.
 */
export const briefSettingsSchema = z.object({
  states: z.array(z.enum(QUEUE_STATE_TYPES)).min(1).default([...QUEUE_STATE_TYPES]),
  sweepAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("07:00"),
  timeZone: z.string().min(1).max(64).nullable().default(null),
  workdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).nullable().default(null),
  since: z.enum(SINCE_MODES).default("read"),
  /** The brief's windows: chat DMs and mentions over the last N hours; meetings from the start of today for N days. */
  chatHours: z.union([z.literal(24), z.literal(48), z.literal(72)]).default(48),
  calendarDays: z.union([z.literal(1), z.literal(2)]).default(1),
});
export const CHAT_HOURS = [24, 48, 72] as const;
export const CALENDAR_DAYS = [1, 2] as const;
export type BriefSettings = z.infer<typeof briefSettingsSchema>;
export const BRIEF_SETTINGS_DEFAULT: BriefSettings = briefSettingsSchema.parse({});

/** Where "today", "07:00" and "a workday" are. Built once per question by the worker (`clockFor`). */
export type Clock = { timeZone: string; workdays: readonly Weekday[] };
export function isZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}
/** The setting's zone, else the developer's device's, else the host's own (never a fixed one). */
export function clockFor(settings: Pick<BriefSettings, "timeZone" | "workdays">, deviceZone: string | null, hostZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): Clock {
  const timeZone = [settings.timeZone, deviceZone, hostZone].find(isZone) ?? "UTC";
  return { timeZone, workdays: settings.workdays ?? defaultWorkdays(timeZone) };
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The calendar day, weekday and time of day of a moment in a zone. */
export function zoned(now: number, timeZone: string): { day: string; weekday: Weekday; hour: number; minute: number } {
  let f = formats.get(timeZone);
  if (!f) formats.set(timeZone, f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }));
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday as Weekday, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
export const isWorkday = (now: number, clock: Clock) => clock.workdays.includes(zoned(now, clock.timeZone).weekday);

// ---------- the snapshot ----------

/** One issue as the snapshot keeps it: what the brief and the ranker read, nothing else. */
export const queueIssueSchema = z.object({
  key: z.string().min(1).max(30),
  title: z.string().max(500),
  /** 0 No priority, 1 Urgent … 4 Low (Linear's numbers). */
  priority: z.number().int().min(0).max(4),
  state: z.string().max(100).nullable(),
  stateType: z.string().max(40).nullable(),
  due: z.string().max(40).nullable(),
  team: z.string().max(30),
  project: z.string().max(200).nullable(),
  milestone: z.string().max(200).nullable(),
  url: z.string().max(2000).nullable(),
  updatedAt: z.string().max(40).nullable(),
  /**
   * Who opened the issue and when (the queue screen's "opened by Dana · 12 days ago"). Display only: never a fact the
   * diff compares, so a snapshot from before these fields (all null) never reads as changed.
   */
  createdAt: z.string().max(40).nullable().default(null),
  creator: z.string().max(200).nullable().default(null),
  creatorId: z.string().max(100).nullable().default(null),
});
export type QueueIssue = z.infer<typeof queueIssueSchema>;

export function toQueueIssue(i: LinearIssue): QueueIssue {
  return { key: i.key, title: i.title, priority: i.priority?.value ?? 0, state: i.state, stateType: i.stateType, due: i.due, team: i.team, project: i.project, milestone: i.milestone, url: i.url, updatedAt: i.updatedAt,
    createdAt: i.createdAt, creator: i.creator, creatorId: i.creatorId };
}

/** One sweep: when, whether it read every page (`complete`), and the issues by key. */
export const sweepSchema = z.object({
  at: z.string(),
  complete: z.boolean(),
  pages: z.number().int().min(0),
  issues: z.record(z.string(), queueIssueSchema),
});
export type Sweep = z.infer<typeof sweepSchema>;

const factsSchema = z.object({ priority: z.number().int().min(0).max(4), due: z.string().nullable(), state: z.string().nullable() });
export type Facts = z.infer<typeof factsSchema>;
/** Why an issue left the queue, from one get_issue after the sweep missed it. */
export const LEFT_CAUSES = ["done", "canceled", "reassigned", "moved", "gone", "unknown"] as const;
export type LeftCause = typeof LEFT_CAUSES[number];

/**
 * One issue's change between two complete sweeps: its facts before (null: it is new) and after (null: it left). The
 * log keeps these for LOG_DAYS so "since Friday" can be answered on a Monday.
 */
export const logEntrySchema = z.object({
  at: z.string(),
  key: z.string().min(1).max(30),
  title: z.string().max(500),
  url: z.string().max(2000).nullable(),
  before: factsSchema.nullable(),
  after: factsSchema.nullable(),
  /** For an issue that left: why, and who has it now when it was reassigned. */
  left: z.object({ cause: z.enum(LEFT_CAUSES), state: z.string().max(100).nullable(), to: z.string().max(200).nullable() }).nullable().default(null),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const SWEEP_TRIGGERS = ["morning", "open", "manual", "agent", "ranker"] as const;
export type SweepTrigger = typeof SWEEP_TRIGGERS[number];

/** Dismissed raises kept: one per raised issue, pruned with the log, so this only bounds a corrupt file. */
export const QUEUE_DISMISSED_MAX = 500;
export const queueFileSchema = z.object({
  version: z.literal(1),
  /** The last two complete sweeps, newest first; or, before any sweep was complete, the newest partial one alone. */
  sweeps: z.array(sweepSchema).max(2),
  log: z.array(logEntrySchema),
  /** The last sweep's outcome (complete, partial or failed). */
  last: z.object({
    at: z.string(), trigger: z.enum(SWEEP_TRIGGERS), ok: z.boolean(), complete: z.boolean(), pages: z.number().int(), reads: z.number().int(),
    durationMs: z.number(), error: z.string().nullable(), total: z.number().int(),
  }).nullable(),
  /**
   * a-change-is-against-what-you-last-saw: when the developer last opened the brief (`at`), and the open before this
   * viewing session began (`prior`), which is what "since" means while they read.
   */
  seen: z.object({ at: z.string(), prior: z.string().nullable() }).nullable(),
  /** The workday whose morning sweep already ran (or was tried), in the brief's zone. */
  morningDay: z.string().nullable(),
  /** The developer's Linear user id (`get_user me`), read once when a sweep first has issues to look up. */
  viewer: z.string().nullable().default(null),
  /**
   * Raised-issue Needs-you items the developer dismissed (decision Q8): the issue's key and the raise's sweep time, so
   * a later raise of the same issue comes back. Pruned with the log.
   */
  dismissed: z.array(z.object({ key: z.string().min(1).max(30), at: z.string() })).max(QUEUE_DISMISSED_MAX).default([]),
});
export type QueueFile = z.infer<typeof queueFileSchema>;
export const emptyQueueFile = (): QueueFile => ({ version: 1, sweeps: [], log: [], last: null, seen: null, morningDay: null, viewer: null, dismissed: [] });

/** Bounds. PAGES_MAX × PAGE_SIZE issues is the most a sweep reads before it says "partial". */
export const QUEUE = {
  /** Pages one sweep may read across every state (a runaway cursor, or a queue past 1000 issues). */
  pagesMax: 40,
  /** Issues that left the queue looked up per sweep (one get_issue each); the rest read "left your queue". */
  lookupsMax: 20,
  logDays: 14,
  /** Opening the brief sweeps again when the last complete sweep is older than this. */
  staleMs: 6 * 3_600_000,
  /** Opens closer together than this are one viewing session: "since" stays put while the developer reads. */
  sessionGapMs: 4 * 3_600_000,
  /** The ranker's view: the queue's top issues by priority, plus every changed one. */
  rankerTop: 40,
} as const;

// ---------- the diff ----------

const facts = (i: QueueIssue): Facts => ({ priority: i.priority, due: i.due, state: i.state });
const sameFacts = (a: Facts, b: Facts) => a.priority === b.priority && a.due === b.due && a.state === b.state;

/**
 * What changed between two complete sweeps, one entry per issue that is new, left, or whose priority, due date or
 * state moved. Pure. `left` says why for the keys the sweep looked up; the rest read "unknown".
 */
export function diffSweeps(prev: Sweep, next: Sweep, left: Readonly<Record<string, LogEntry["left"]>> = {}): LogEntry[] {
  if (!prev.complete || !next.complete) return [];
  const out: LogEntry[] = [];
  for (const [key, now] of Object.entries(next.issues)) {
    const was = prev.issues[key];
    if (!was) out.push({ at: next.at, key, title: now.title, url: now.url, before: null, after: facts(now), left: null });
    else if (!sameFacts(facts(was), facts(now))) out.push({ at: next.at, key, title: now.title, url: now.url, before: facts(was), after: facts(now), left: null });
  }
  for (const [key, was] of Object.entries(prev.issues)) {
    if (next.issues[key]) continue;
    out.push({ at: next.at, key, title: was.title, url: was.url, before: facts(was), after: null, left: left[key] ?? { cause: "unknown", state: null, to: null } });
  }
  return out;
}

/** The log without entries older than LOG_DAYS before `now`. */
export const pruneLog = (log: readonly LogEntry[], now: number) => log.filter(e => now - Date.parse(e.at) <= QUEUE.logDays * 86_400_000);

/** Keys that left the queue between two sweeps: the ones a sweep looks up (at most LOOKUPS_MAX, most urgent first). */
export function leftKeys(prev: Sweep, next: Sweep): string[] {
  return Object.values(prev.issues).filter(i => !next.issues[i.key]).sort(byUrgency).slice(0, QUEUE.lookupsMax).map(i => i.key);
}

export const CHANGE_KINDS = ["new", "raised", "lowered", "due", "state", "left"] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];
/** One issue's change since a point, folded over every sweep since then. */
export type QueueChange = {
  key: string; title: string; url: string | null;
  kinds: ChangeKind[];
  /** Priority now (or when it left), and before. */
  priority: number; priorityBefore: number | null;
  due: string | null; dueBefore: string | null;
  state: string | null; stateBefore: string | null;
  left: LogEntry["left"];
  /** The sweep that saw the newest part of it. */
  at: string;
};

/** Linear's priority as an urgency rank: Urgent 1 … Low 4, No priority 5. */
export const urgency = (priority: number) => priority === 0 ? 5 : priority;
export const priorityName = (priority: number) => PRIORITY_NAMES[priority] ?? "No priority";
/** Most urgent first: priority, then the nearest due date (none last), then the key. */
export function byUrgency(a: { priority: number; due: string | null; key: string }, b: { priority: number; due: string | null; key: string }): number {
  return urgency(a.priority) - urgency(b.priority) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Every change after `since` (exclusive), one per issue: the facts before its first entry against those after its last,
 * so Low → Medium → High reads "raised Low → High" and a raise taken back reads as nothing. Ordered most urgent first
 * across kinds (critique A: a new Urgent issue sits above a Low → High raise), issues that left last. `since` null: the
 * whole log.
 */
export function changesSince(log: readonly LogEntry[], since: string | null): QueueChange[] {
  const t = since ? Date.parse(since) : -Infinity;
  const by = new Map<string, LogEntry[]>();
  for (const e of log) if (Date.parse(e.at) > t) (by.get(e.key) ?? by.set(e.key, []).get(e.key)!).push(e);
  const out: QueueChange[] = [];
  for (const entries of by.values()) {
    entries.sort((a, b) => a.at.localeCompare(b.at));
    const first = entries[0], last = entries[entries.length - 1];
    const before = first.before, after = last.after;
    if (!before && !after) continue; // new, then left again: nothing to say
    const kinds: ChangeKind[] = [];
    if (!before) kinds.push("new");
    else if (!after) kinds.push("left");
    else {
      if (urgency(after.priority) < urgency(before.priority)) kinds.push("raised");
      if (urgency(after.priority) > urgency(before.priority)) kinds.push("lowered");
      if (after.due !== before.due) kinds.push("due");
      if (after.state !== before.state) kinds.push("state");
      if (!kinds.length) continue;
    }
    const now = after ?? before!;
    out.push({ key: last.key, title: last.title, url: last.url, kinds, priority: now.priority, priorityBefore: before?.priority ?? null, due: now.due, dueBefore: before?.due ?? null,
      state: now.state, stateBefore: before?.state ?? null, left: after ? null : last.left, at: last.at });
  }
  return out.sort((a, b) => Number(a.kinds.includes("left")) - Number(b.kinds.includes("left")) || byUrgency(a, b));
}

/**
 * "Since" when the developer hasn't read the brief: the newest sweep from before today (the last workday's), so the
 * first morning still shows what moved overnight. Null when every logged sweep is from today.
 */
export function workdaySince(file: Pick<QueueFile, "log" | "sweeps">, now: number, clock: Clock): string | null {
  const today = zoned(now, clock.timeZone).day;
  const times = [...new Set([...file.sweeps.map(s => s.at), ...file.log.map(e => e.at)])].sort();
  // The log's own times are sweeps too; a sweep before today is the newest time whose day is earlier.
  let out: string | null = null;
  for (const at of times) if (zoned(Date.parse(at), clock.timeZone).day < today) out = at;
  return out;
}

/** a-change-is-against-what-you-last-saw: the brief's "since", a stored point (the read before this session), else the workday's. */
export function briefSince(file: Pick<QueueFile, "log" | "sweeps" | "seen">, now: number, clock: Clock, mode: SinceMode = "read"): string | null {
  return (mode === "read" ? file.seen?.prior : null) ?? workdaySince(file, now, clock);
}

/** The seen marks after the developer opens the brief at `now`: a new session moves `prior` up to the last open. */
export function markSeen(seen: QueueFile["seen"], now: number): NonNullable<QueueFile["seen"]> {
  const at = new Date(now).toISOString();
  if (!seen) return { at, prior: null };
  return now - Date.parse(seen.at) >= QUEUE.sessionGapMs ? { at, prior: seen.at } : { at, prior: seen.prior };
}

/** Whether the morning sweep is due: a workday, past the sweep time, not yet run today. */
export function morningDue(file: Pick<QueueFile, "morningDay">, now: number, clock: Clock, sweepAt: string): boolean {
  const z = zoned(now, clock.timeZone);
  if (!clock.workdays.includes(z.weekday) || file.morningDay === z.day) return false;
  const [h, m] = sweepAt.split(":").map(Number);
  return z.hour * 60 + z.minute >= h * 60 + m;
}

/** The snapshot readers use: the newest sweep (complete, or the only partial one). */
export const current = (file: Pick<QueueFile, "sweeps">): Sweep | null => file.sweeps[0] ?? null;

/** Every issue in the snapshot, most urgent first. */
export const queueIssues = (sweep: Sweep | null): QueueIssue[] => sweep ? Object.values(sweep.issues).sort(byUrgency) : [];

/** A change in a few words for the ranker and agents: "raised Low → High", "new", "due moved to 2026-11-26", "left: done". */
export function changeLine(c: QueueChange): string {
  const parts: string[] = [];
  for (const k of c.kinds) {
    if (k === "new") parts.push("new");
    if (k === "raised" || k === "lowered") parts.push(`${k} ${priorityName(c.priorityBefore ?? 0)} → ${priorityName(c.priority)}`);
    if (k === "due") parts.push(c.due ? `due ${c.dueBefore ? "moved " : ""}to ${c.due}` : "due date removed");
    if (k === "state") parts.push(`${c.stateBefore ?? "?"} → ${c.state ?? "?"}`);
    if (k === "left") parts.push(`left: ${c.left?.cause === "reassigned" ? `reassigned${c.left.to ? ` to ${c.left.to}` : ""}` : c.left?.cause === "moved" ? `moved to ${c.left.state ?? "another state"}` : c.left?.cause ?? "unknown"}`);
  }
  return parts.join(", ");
}

/** The cause of an issue leaving, from its get_issue read. `stateTypes`: what counts as the queue. */
/**
 * the-queue-is-whole: a lookup that finds the issue still assigned to the developer (its `assigneeId` is the viewer's
 * id) and in a queue state means the walk missed it, not that it left. Its lookup puts it back in the sweep, with no
 * log entry. An unknown viewer or assignee id is never "mine": the issue reads as left, as before.
 */
export function missedRead(issue: Pick<LinearIssue, "stateType" | "assigneeId"> | null, viewer: string | null, stateTypes: readonly string[]): boolean {
  return !!issue && !!viewer && issue.assigneeId === viewer && !!issue.stateType && stateTypes.includes(issue.stateType);
}

/** Whether the developer opened the issue: its creator id is the viewer's. Null when either id is unknown. */
export function openedByYou(issue: Pick<QueueIssue, "creatorId">, viewer: string | null): boolean | null {
  return issue.creatorId && viewer ? issue.creatorId === viewer : null;
}

export function leftCause(issue: (Pick<LinearIssue, "stateType" | "state"> & { assignee?: string | null; assigneeIsMe?: boolean | null }) | null, stateTypes: readonly string[]): NonNullable<LogEntry["left"]> {
  if (!issue) return { cause: "gone", state: null, to: null };
  if (issue.stateType === "completed") return { cause: "done", state: issue.state, to: null };
  if (issue.stateType === "canceled") return { cause: "canceled", state: issue.state, to: null };
  if (issue.stateType && !stateTypes.includes(issue.stateType)) return { cause: "moved", state: issue.state, to: null };
  // Still in a queue state but not in the developer's list: someone else has it (or no one).
  return { cause: "reassigned", state: issue.state, to: issue.assignee ?? null };
}

/** A raise that needs the developer (decision Q8): to Urgent or High, on an issue still in the queue with no workspace. */
export type RaisedNeed = Pick<QueueChange, "key" | "title" | "url" | "priority" | "priorityBefore" | "due" | "at">;
/**
 * Decision Q8: every raise to Urgent or High in the log window, on an issue still in the snapshot with no workspace,
 * that the developer hasn't dismissed since it was raised. A raise taken back, a workspace, or the issue leaving ends it.
 */
export function raisedNeeds(file: Pick<QueueFile, "log" | "sweeps" | "dismissed">, hasWorkspace: (key: string) => boolean): RaisedNeed[] {
  const snap = current(file);
  if (!snap) return [];
  return changesSince(file.log, null)
    .filter(c => c.kinds.includes("raised") && (c.priority === 1 || c.priority === 2) && !!snap.issues[c.key] && !hasWorkspace(c.key))
    .filter(c => !file.dismissed.some(d => d.key === c.key && d.at >= c.at))
    .map(c => ({ key: c.key, title: c.title, url: c.url, priority: c.priority, priorityBefore: c.priorityBefore, due: c.due, at: c.at }));
}

/**
 * Whether the home feed's queue revision moved since the pane's read (one-read-per-key-at-mount): the first revision
 * the feed brings after the pane mounted is not a change (the pane's own read is newer than "none yet"), so Home's first
 * open reads the queue once, not again when the feed arrives.
 */
export const queueMoved = (seen: string, next: string): boolean => seen !== "" && seen !== next;
