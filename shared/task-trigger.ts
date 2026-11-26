import { z } from "zod";
import type { ListObligation as Obligation, ListWorkspace as Workspace, ListPr as Pr } from "./list";
import { deployed } from "./follow-up";
import { dueLabel } from "./task-due";

/**
 * A task's trigger: what sends it to its agent as a message. now, merge and deploy join the next message and follow
 * Auto-send; at (a-scheduled-task-arrives-once-at-its-time) is a time someone named, the developer in the sheet or the
 * agent for its own check-back, and goes out once at that time whether Auto-send is on or not (server/scheduled-tasks.ts).
 * `sentAt` (it went out) and `notSent` (why it couldn't: the agent closed or archived) are Follow-up's, never an input.
 */
export const TRIGGER_EVENTS = ["now", "merge", "deploy", "at"] as const;
/** An at trigger is at least a minute out and at most this far: anything later is a re-check day. */
export const AT_MIN_MS = 60_000;
export const AT_MAX_DAYS = 30;
const triggerFields = { event: z.enum(TRIGGER_EVENTS), delayDays: z.number().int().min(0).max(3650).default(0), at: z.string().max(40).optional() };
export const taskTriggerSchema = z.object({ ...triggerFields, queuedAt: z.string().max(40).optional(), sentAt: z.string().max(40).optional(), notSent: z.string().max(200).optional() });
export type TaskTrigger = z.infer<typeof taskTriggerSchema>;
/** What a caller passes: `at` as an ISO time with its offset, or `inMinutes` from now; never sentAt or notSent. */
export const taskTriggerInputSchema = z.object({ ...triggerFields, inMinutes: z.number().int().min(1).max(AT_MAX_DAYS * 1440).optional() });
export type TaskTriggerInput = z.infer<typeof taskTriggerInputSchema>;
const OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/**
 * The trigger to store for an input: an at trigger's time resolved (inMinutes from `now`), checked and kept in UTC.
 * The same at as `existing` keeps whether it went out, so an ordinary update never sends it twice. Throws a sentence
 * an agent can act on.
 */
export function storedTrigger(input: TaskTriggerInput | TaskTrigger | null | undefined, existing: TaskTrigger | null | undefined, now: number): TaskTrigger | null | undefined {
  if (!input) return input;
  const { inMinutes, ...rest } = input as TaskTriggerInput & Partial<Pick<TaskTrigger, "sentAt" | "notSent">>;
  for (const k of ["queuedAt", "sentAt", "notSent"] as const) delete (rest as Partial<TaskTrigger>)[k];
  if (rest.event !== "at") {
    if (rest.at !== undefined || inMinutes !== undefined) throw new Error("at and inMinutes go with event \"at\".");
    return { event: rest.event, delayDays: rest.delayDays ?? 0 };
  }
  // The same time passed back (an update that preserves its trigger) is the stored one, even once it's past or sent.
  if (existing?.event === "at" && existing.at && rest.at !== undefined && Date.parse(rest.at) === Date.parse(existing.at)) return existing;
  if (rest.delayDays) throw new Error("An at trigger has no delayDays: pass the time itself in at, or inMinutes.");
  if ((rest.at === undefined) === (inMinutes === undefined)) throw new Error("An at trigger needs at (an ISO time with its offset, like 2026-11-26T12:15:00+02:00) or inMinutes, not both.");
  const ms = inMinutes !== undefined ? now + inMinutes * 60_000 : OFFSET.test(rest.at!) ? Date.parse(rest.at!) : NaN;
  if (!Number.isFinite(ms)) throw new Error("at is an ISO time with its offset, like 2026-11-26T12:15:00+02:00 or 2026-11-26T10:15:00Z, so the time is never a guess.");
  if (ms < now + AT_MIN_MS - 1_000) throw new Error("That time is already here or past. Pick a time at least a minute out, or use event \"now\".");
  if (ms > now + AT_MAX_DAYS * 86_400_000) throw new Error(`An at trigger is at most ${AT_MAX_DAYS} days out. Use recheck for a later day.`);
  const at = new Date(Math.floor(ms / 1000) * 1000).toISOString();
  return { event: "at", delayDays: 0, at };
}
/** An at trigger still waiting to go out: not sent and not refused. */
export function pendingAt(t: TaskTrigger | null | undefined): t is TaskTrigger & { at: string } { return t?.event === "at" && !!t.at && !t.queuedAt && !t.sentAt && !t.notSent; }
/** The message an at trigger sends: its header, the time as the agent reads it (ISO with offset) and what to do. */
export const SCHEDULED_HEADER = "Follow-up scheduled task";
export function scheduledText(o: Pick<Obligation, "id" | "title" | "evidence">, at: string, now: number): string {
  const late = now - Date.parse(at) > 5 * 60_000 ? ` (late: it went out at ${new Date(now).toISOString()}, after Follow-up was down)` : "";
  const evidence = (o.evidence ?? "").trim();
  return [`${SCHEDULED_HEADER} ${o.id}, set for ${at}${late}: ${o.title}`,
    ...(evidence ? [`Where it stood: ${evidence.length > 600 ? `${evidence.slice(0, 600)}…` : evidence}`] : []),
    "Check it now. Close it with update_obligation (status=done with evidence), or set a new time with trigger={event:\"at\", at or inMinutes} and end your turn."].join("\n");
}
/**
 * The time as the developer reads it, in their zone (the device's, where the client draws it): "12:15" today,
 * "tomorrow 09:00", "Nov 28, 09:00". `timeZone` pins it (tests).
 */
export function clockLabel(iso: string, now: number, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const day = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone });
  const time = new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  if (day(ms) === day(now)) return time;
  if (day(ms) === day(now + 86_400_000)) return `tomorrow ${time}`;
  if (day(ms) === day(now - 86_400_000)) return `yesterday ${time}`;
  return `${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}, ${time}`;
}
/** Words a time trigger's row starts with when it couldn't go out: never "Not sent", the sheet's word for no trigger. */
export const DIDNT_GO_OUT = "Didn't go out";
/** An at trigger's line on the task row: "Sends 12:15", then "Sent 12:15", or "Didn't go out · the agent was archived". */
export function atLabel(t: TaskTrigger, now: number, timeZone?: string): string {
  if (t.notSent) return `${DIDNT_GO_OUT} · ${t.notSent}`;
  if (t.sentAt) return `Sent ${clockLabel(t.sentAt, now, timeZone)}`;
  if (t.queuedAt) return `Due ${clockLabel(t.at ?? "", now, timeZone)} · goes when the agent's turn ends`;
  return `Sends ${clockLabel(t.at ?? "", now, timeZone)}`;
}
/** A merged PR whose repository has no deploy check here (invariant public-code-carries-no-host-identifiers). */
export const notSetUpEvidence = (repo: string) => `Deploy check not set up for ${repo}.`;
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function taskSchedule(o: Obligation, w: Workspace, now = Date.now()): { ready: boolean; dueAt: string | null; label: string } {
  const t = o.trigger;
  // due-by-fact: with no developer timing a task says what moves it ("Due · #231 merged", "After #232 merges",
  // "Re-check Nov 25", "Stale · …"); it is never "Manual".
  if (!o.enable_follow_up || !t) return { ready: false, dueAt: null, label: dueLabel(o, w, now) ?? "Open" };
  // An at trigger isn't a batch: it goes out on its own at its time (server/scheduled-tasks.ts), so it is never "ready".
  if (t.event === "at") return { ready: false, dueAt: pendingAt(t) ? t.at : null, label: atLabel(t, now) };
  if (t.event === "now") return { ready: o.afterPrs.length === 0 && t.delayDays === 0, dueAt: null, label: "Now" };
  const label = `${t.delayDays ? `${t.delayDays}d after ` : "After "}${t.event}`;
  if (!o.afterPrs.length) return { ready: false, dueAt: null, label };
  const prs = o.afterPrs.map(key => w.prs.find(p => p.key === key));
  // No deploy check for a dependency's repository: wait, say why, and never read a kept observation as a deploy.
  const unchecked = t.event === "deploy" ? prs.find(p => p?.snapshot?.state === "MERGED" && p.snapshot.deployment?.notSetUp) : undefined;
  if (unchecked) return { ready: false, dueAt: null, label: `Deploy check not set up for ${unchecked.repo}` };
  if (prs.some(p => !p || p.error || !p.snapshot?.complete || p.snapshot.state !== "MERGED" || t.event === "deploy" && !deployed(p, now))) return { ready: false, dueAt: null, label };
  const times = (prs as Pr[]).map(p => t.event === "merge" ? timestamp(p.snapshot?.mergedAt) : p.deploymentAnchor?.mergeCommit === p.snapshot?.mergeCommit ? timestamp(p.deploymentAnchor?.at) : null);
  if (times.some(t => t === null)) return { ready: t.delayDays === 0, dueAt: null, label };
  const due = Math.max(...times as number[]) + t.delayDays * 86_400_000;
  return { ready: due <= now, dueAt: new Date(due).toISOString(), label };
}

/** The one line under the sheet's choices: what the selected one does. */
export const TRIGGER_HELP = {
  manual: "Comes due when its PRs merge or deploy, or on its re-check date; the agent is reminded at the end of its turn.",
  now: "Joins the next message to the agent, and follows your Auto-send choice.",
  at: "Sends once at this time, even with Auto-send off.",
  merge: "Joins the next message once the PRs merge, and follows your Auto-send choice.",
  deploy: "Joins the next message once the PRs deploy, and follows your Auto-send choice.",
} as const;
/**
 * The sheet's quick times (client/tasks.tsx, At a time): in 30 minutes, in an hour, tomorrow at 09:00 on the device's
 * clock (the developer's zone). Each is a whole minute.
 */
export function atChoices(now: number): { label: string; at: number }[] {
  const minute = (ms: number) => Math.ceil(ms / 60_000) * 60_000;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [{ label: "In 30 min", at: minute(now + 30 * 60_000) }, { label: "In 1 hour", at: minute(now + 60 * 60_000) }, { label: "Tomorrow 09:00", at: tomorrow.getTime() }];
}
/**
 * A time typed in the sheet, on the device's clock: "2026-11-26 12:15" (or "…T12:15"), or just "14:30", which is today,
 * or tomorrow once today's has passed. Null when it isn't one.
 */
export function parseLocalTime(text: string, now: number = Date.now()): number | null {
  const short = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (short) {
    const [h, mi] = short.slice(1).map(Number);
    if (h > 23 || mi > 59) return null;
    const t = new Date(now); t.setHours(h, mi, 0, 0);
    if (t.getTime() <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
  }
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, 0, 0);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && t.getHours() === h && t.getMinutes() === mi ? t.getTime() : null;
}
/** The same as typed text: what the sheet's field starts with. */
export function localTimeText(ms: number): string {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Why a time can't be saved, in the server's own bounds (storedTrigger), or null. */
export function atProblem(at: number | null, now: number): string | null {
  if (at === null) return `Write a time like 14:30, or a date and time like ${localTimeText(atChoices(now)[2].at)}.`;
  if (at < now + AT_MIN_MS) return "Pick a time at least a minute from now.";
  if (at > now + AT_MAX_DAYS * 86_400_000) return `Pick a time within ${AT_MAX_DAYS} days.`;
  return null;
}
