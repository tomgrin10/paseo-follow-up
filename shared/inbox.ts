import { z } from "zod";
import { briefSchema, BRIEF_KINDS, BRIEF_SOURCES, BRIEF_STATES } from "./brief";
import { agentMerges, agentMergesKey } from "./pr-workflow";

/**
 * The "Needs you" inbox: one flag per root agent that only the developer clears, by signing it off or
 * writing to the agent. Opening, reading and Paseo's own unread state never touch it.
 * Everything here is pure so the reducer can be tested row by row against the design's event table.
 */

export const REASONS = ["permission", "error", "paused", "ci", "review", "reviewers", "finished", "pr_closed", "pr_merged"] as const;
export type Reason = typeof REASONS[number];
/** Most urgent first. The displayed reason is the first unresolved one in this order. */
export const reasonRank = (reason: Reason) => REASONS.indexOf(reason);

const isoSchema = z.string();
export const reasonEntrySchema = z.object({ reason: z.enum(REASONS), at: isoSchema, detail: z.string(), dedupeKey: z.string(),
  /** "reviewers" only: the PR it asks about, so the client can withdraw it the moment that PR's repository goes No review. */
  prKey: z.string().optional() });
export type ReasonEntry = z.infer<typeof reasonEntrySchema>;
export const needsSchema = z.object({ reasons: z.array(reasonEntrySchema), since: isoSchema });
export type Needs = z.infer<typeof needsSchema>;
/** `until` is an ISO time, "next-event" (any new flag wakes it) or "pr:<repo#n>" (wakes when that PR merges or closes). */
export const snoozeSchema = z.object({ until: z.string(), at: isoSchema });
export type Snooze = z.infer<typeof snoozeSchema>;

export const entrySchema = z.object({
  agentId: z.string(),
  needs: needsSchema.nullable().default(null),
  snooze: snoozeSchema.nullable().default(null),
  signedOffAt: isoSchema.nullable().default(null),
  lastTomMessageAt: isoSchema.nullable().default(null),
  seq: z.number().int().default(0),
  /**
   * The last sign-off or Later, for Undo. A Later's undo (`kind: "snooze"`) puts back the snooze it replaced, and only
   * while the snooze it set (`set`) still stands: a flag that broke it since stays broken.
   */
  undo: z.object({ kind: z.enum(["sign_off", "snooze"]).default("sign_off"), seq: z.number().int(), prev: needsSchema.nullable(), prevSnooze: snoozeSchema.nullable().default(null), set: snoozeSchema.nullable().default(null), expires: isoSchema }).nullable().default(null),
  /** D2: "Sign off · mute this turn". The next turn end is absorbed once. */
  muteTurn: z.boolean().default(false),
  /** Per-agent "Don't flag finishes": permission prompts and errors still flag, plain turn ends don't. */
  enable_finish_flags: z.boolean().default(true),
  /** Archived: hidden, kept for 7 days so an unarchive restores it. */
  goneAt: isoSchema.nullable().default(null),
  /** Dedupe keys that already flagged (CI head SHA, review thread ids, PR state), so a sign-off sticks. */
  seenKeys: z.array(z.string()).default([]),
  /** Last turn end or flag this entry saw; restart reconciliation compares agent activity against it. */
  lastEventAt: isoSchema.nullable().default(null),
  /** The brief card for this agent's newest flagged turn (additive; older builds ignore it). */
  brief: briefSchema.nullable().default(null),
});
export type Entry = z.infer<typeof entrySchema>;

export const outboxSchema = z.object({
  answerId: z.string(), agentId: z.string(), briefId: z.string(), messageId: z.string(), text: z.string(), at: isoSchema,
  attempts: z.number().int().default(0), state: z.enum(["sending", "failed"]).default("sending"), error: z.string().nullable().default(null),
});
export type OutboxEntry = z.infer<typeof outboxSchema>;
export const inboxStateSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema).default({}),
  /** D4 first-run import. Null until it has run once. */
  importedAt: isoSchema.nullable().default(null),
  /** Older idle agents that were not imported. Null once emptied or dismissed. */
  unsorted: z.array(z.string()).nullable().default(null),
  /** One Undo for a confirmed batch sign-off, kept 24 h. */
  batchUndo: z.object({ at: isoSchema, expires: isoSchema, entries: z.array(z.object({ agentId: z.string(), seq: z.number().int(), prev: needsSchema.nullable(), prevSnooze: snoozeSchema.nullable().default(null) })), unsorted: z.array(z.string()).nullable().default(null) }).nullable().default(null),
  /** Follow-up's own deliveries, written before sending, so its messages never count as the developer's. */
  ledger: z.array(z.object({ agentId: z.string(), messageId: z.string().nullable(), at: isoSchema,
    /** "developer": a brief option or move the developer clicked. It counts as their message (design §6, F6). */
    /** "agent:<id>": a Follow-up action another agent took through its tools (agent parity). Never the developer's. */
    by: z.union([z.enum(["follow-up", "developer"]), z.string().regex(/^agent:[\w-]+$/)]).optional(),
    /** Set on an agent action's record (no message was sent), so the classifier never matches it to a message. */
    action: z.string().max(60).optional() })).default([]),
  /**
   * Brief answers recorded but not yet confirmed by Paseo (AnswerOutbox in server/inbox.ts). The card's RPC replies once
   * the answer is here; delivery runs after, retried with the same messageId (Paseo's receipts make a resend a no-op).
   */
  outbox: z.array(outboxSchema).default([]),
  /** Last time the worker was alive; anything that finished after it was missed. */
  lastSeen: isoSchema.nullable().default(null),
  /** Set once Follow-up's existing PR states were recorded as already seen. */
  primedAt: isoSchema.nullable().default(null),
  signOffs: z.number().int().default(0),
  /** One-time repairs applied to this store (additive; `version` stays 1 so older builds still read it). */
  revision: z.number().int().default(0),
  /** Where each flagged turn's brief came from, newest last, for the adoption share (R2). Capped. */
  briefOrigins: z.array(z.object({ at: isoSchema, origin: z.enum(["tool", "structured", "extraction", "fallback"]) })).default([]),
});
export type InboxState = z.infer<typeof inboxStateSchema>;
export const emptyInbox = (): InboxState => inboxStateSchema.parse({ version: 1 });

export type InboxEvent =
  | { type: "turn_end"; outcome: "completed"; detail: string; delegated?: boolean;
      /** F7: the agent said there is nothing for the developer (needs_you kind=done), or Paseo still shows it running. No finish flag. */
      quiet?: boolean }
  | { type: "turn_end"; outcome: "failed"; detail: string }
  | { type: "turn_end"; outcome: "canceled"; guard: "attention" | "waiting" | null; detail: string }
  | { type: "message"; from: "tom" | "automation" }
  | { type: "permission"; requestId: string; detail: string }
  | { type: "permission_resolved"; requestId: string }
  | { type: "crash"; detail: string }
  | { type: "paused"; pauseId: string; detail: string }
  | { type: "ci"; dedupeKey: string; detail: string; suppressed?: boolean }
  | { type: "review"; dedupeKey: string; detail: string; suppressed?: boolean }
  /** An open, non-draft PR with nobody asked to review it: the developer's job (it never waits on open threads). */
  | { type: "reviewers"; dedupeKey: string; detail: string; prKey: string; url: string | null; names: string[] }
  /** A registered PR left OPEN. `merged`: it merged (else it closed unmerged). `quiet`: the agent merged it itself
   * (register_pr agentMerges), so it wakes a "until this PR merges" snooze but flags nobody. Older events: neither. */
  | { type: "pr_closed"; dedupeKey: string; detail: string; prKey: string; merged?: boolean; quiet?: boolean }
  /** The outside facts (FACT_REASONS) that still hold for this agent's PRs: a flag whose fact ended is withdrawn. */
  | { type: "facts_live"; live: Reason[] }
  | { type: "sign_off"; seq?: number; muteTurn?: boolean }
  | { type: "undo" }
  | { type: "snooze"; until: string }
  /** Bring back now: ends a Later early. */
  | { type: "unsnooze" }
  | { type: "tick" }
  | { type: "open" }
  | { type: "archive" }
  | { type: "unarchive" }
  | { type: "set_finish_flags"; value: boolean }
  | { type: "reconcile"; detail: string };

export type State = "QUIET" | "NEEDS" | "LATER" | "GONE";
export function stateOf(e: Entry | undefined): State {
  if (!e) return "QUIET";
  if (e.goneAt) return "GONE";
  if (!e.needs) return "QUIET";
  return e.snooze ? "LATER" : "NEEDS";
}

export const newEntry = (agentId: string): Entry => entrySchema.parse({ agentId });
const UNDO_MS = 24 * 3_600_000;
const GONE_MS = 7 * 24 * 3_600_000;
const SEEN_LIMIT = 200;

export class StaleSignOff extends Error {
  constructor() { super("This agent changed since you looked. Its newest flag is still showing."); }
}

function add(e: Entry, reason: Reason, detail: string, dedupeKey: string, at: string, prKey?: string) {
  const reasons = (e.needs?.reasons ?? []).filter(r => r.dedupeKey !== dedupeKey);
  reasons.push({ reason, at, detail, dedupeKey, ...(prKey ? { prKey } : {}) });
  e.needs = { reasons, since: e.needs?.since ?? at };
}
function seen(e: Entry, key: string): boolean {
  if (e.seenKeys.includes(key)) return true;
  e.seenKeys = [...e.seenKeys, key].slice(-SEEN_LIMIT);
  return false;
}
/** Permission, error and paused always break a snooze; a plain finish never does. */
const BREAKS: Reason[] = ["permission", "error", "paused", "ci", "review", "pr_closed", "pr_merged"];
/**
 * Reasons that describe the agent's last turn, not an outside fact: a newer turn start from anyone (the developer,
 * another agent, the host resuming it) supersedes them, and a new failure flags again. Outside facts (permission by
 * request, ci, review, reviewers, pr_closed) and the agent's own finish with its ask stay until handled.
 */
export const RUN_STATE_REASONS: readonly Reason[] = ["error", "paused"];
/**
 * Reasons that mirror a PR fact Follow-up observes (red CI, threads or a conflict, no reviewers): they last as long as
 * the fact does. Once no PR of the agent shows it (fixed, merged, reviewers added, or the agent is on it), the flag is
 * withdrawn (`facts_live`), so a merged PR never leaves "Add reviewers" behind. Status invariant outside-fact-is-live.
 */
export const FACT_REASONS: readonly Reason[] = ["ci", "review", "reviewers"];
/**
 * What a row shows for an agent: a running agent has outlived its last turn's run-state flags and the card that only
 * reported them (`running-is-not-stale`). A card with open questions stays: only the developer closes it.
 */
export function liveFlag<B extends { kind: string; state: string; questionIds?: string[]; at?: string; source?: string }>(status: string, needs: Needs | null, brief: B | null, turnStartedAt: string | null = null, background = false, waiting = false): { needs: Needs | null; brief: B | null } {
  // Paseo 0.16 background work still live: the agent isn't finished yet, so a finish waits (shown, not erased).
  if (background) needs = withoutReasons(needs, ["finished"]);
  // The main agent declared a wait (a working or waiting task in its workspace): a finish that states no ask is that
  // wait, not news, so it waits too (shown again once the task settles). An agent's own ask still flags.
  // Status invariant in-flight-reads-waiting; tests/in-flight-status.test.ts.
  if (waiting && !(brief?.state === "open" && brief.source !== "none" && !["done", "unknown"].includes(brief.kind))) needs = withoutReasons(needs, ["finished"]);
  // Only a flag older than the current turn's start is stale. Paseo can still read "running" for a moment after a
  // turn fails (server/directory.ts keeps a failed agent busy until its re-read), so status alone isn't enough, and
  // without a known turn start nothing is dropped here (the reducer and the load repair cover those turns).
  if (!["running", "initializing"].includes(status) || !turnStartedAt) return { needs, brief };
  const stale = brief?.state === "open" && (brief.kind === "error" || brief.kind === "paused") && !brief.questionIds?.length && !!brief.at && brief.at < turnStartedAt;
  return { needs: withoutRunState(needs, turnStartedAt), brief: stale ? null : brief };
}
/** The PR an add-reviewers brief asks about: its Add reviewers move's PR. Null for every other kind. */
export function reviewersBriefPr(b: { kind: string; moves?: readonly { kind: string; prKey?: string | null }[]; prKey?: string }): string | null {
  if (b.kind !== "reviewers") return null;
  return b.prKey ?? b.moves?.find(m => m.kind === "add_reviewers")?.prKey ?? null;
}
/**
 * An open add-reviewers brief whose PR the agent merges itself (`agentMergesKey`): not an ask, so no surface draws it.
 * Invariant a-no-review-repo-never-asks-for-review-or-merge.
 */
export const reviewersBriefWithdrawn = (b: { kind: string; state: string; moves?: readonly { kind: string; prKey?: string | null }[]; prKey?: string }): boolean => {
  const pr = b.state === "open" ? reviewersBriefPr(b) : null;
  return !!pr && agentMergesKey(pr);
};
/**
 * A row as the client draws it: without the add-reviewers flags and brief of PRs the agent merges itself. The daemon
 * withdraws those on its next tick; this closes the gap, so the moment a repository flips to No review its asks leave
 * the pill, the inbox row, Home and the panel count together, and come back on Undo. The client inbox store applies it
 * to every row it hands out (client/inbox-store.ts); invariant a-no-review-repo-never-asks-for-review-or-merge.
 */
export function withoutWithdrawnAsks<R extends Pick<InboxRow, "needs" | "brief">>(row: R): R {
  // A flag stored before reasons carried their PR falls back on the add-reviewers brief's PR.
  const briefPr = row.brief ? reviewersBriefPr(row.brief) : null;
  const reasons = row.needs?.reasons.filter(r => { const pr = r.reason === "reviewers" ? r.prKey ?? briefPr : null; return !(pr && agentMergesKey(pr)); });
  const needsGone = !!row.needs && reasons!.length !== row.needs.reasons.length;
  const briefGone = !!row.brief && reviewersBriefWithdrawn(row.brief);
  if (!needsGone && !briefGone) return row;
  const needs = needsGone ? reasons!.length ? { reasons: reasons!, since: reasons!.map(r => r.at).sort()[0] } : null : row.needs;
  return { ...row, needs, brief: briefGone ? null : row.brief };
}
function withoutReasons(needs: Needs | null, drop: readonly Reason[]): Needs | null {
  if (!needs) return null;
  const reasons = needs.reasons.filter(r => !drop.includes(r.reason));
  if (reasons.length === needs.reasons.length) return needs;
  return reasons.length ? { reasons, since: reasons.map(r => r.at).sort()[0] } : null;
}
/** Drop the run-state flags a newer turn has outlived (all of them without `before`); null when nothing is left. */
export function withoutRunState(needs: Needs | null, before?: string): Needs | null {
  if (!needs) return null;
  const reasons = needs.reasons.filter(r => !RUN_STATE_REASONS.includes(r.reason) || (before !== undefined && r.at >= before));
  if (reasons.length === needs.reasons.length) return needs;
  return reasons.length ? { reasons, since: reasons.map(r => r.at).sort()[0] } : null;
}

/**
 * Apply one event to one agent's entry (design §2.3). Returns the next entry; the input is not mutated.
 * Throws StaleSignOff when a sign-off carries a seq that moved, so an offline replay never clears newer news.
 */
export function reduce(prev: Entry, event: InboxEvent, now: string): Entry {
  const e: Entry = structuredClone(prev);
  const before = JSON.stringify(e);
  const flag = (reason: Reason, detail: string, dedupeKey: string, prKey?: string) => {
    if (e.goneAt) return;
    add(e, reason, detail, dedupeKey, now, prKey);
    e.lastEventAt = now;
    const wake = BREAKS.includes(reason) || e.snooze?.until === "next-event";
    if (e.snooze && wake) e.snooze = null;
  };
  switch (event.type) {
    case "turn_end":
      e.lastEventAt = now;
      if (event.outcome === "completed") {
        // #1, #1b. D2 mute absorbs one finish; "Don't flag finishes" and D3 delegated agents skip it.
        if (e.muteTurn) { e.muteTurn = false; break; }
        // F7: "Nothing needed" and still-running turns add nothing. An older open flag stays as it was.
        if (event.quiet) break;
        if (!e.enable_finish_flags) break;
        if (event.delegated && !e.lastTomMessageAt) break;
        flag("finished", event.detail, "finished");
      } else if (event.outcome === "failed") flag("error", event.detail, "error"); // #2
      else if (event.guard === "attention") flag("paused", event.detail, "paused"); // #3b → #7
      // #3: the developer's own interrupt, or a Session Guard pause that will resume by itself.
      break;
    case "message":
      // #11 clears everything. #12 automation changes nothing, except that its turn supersedes the last turn's
      // failure or pause (RUN_STATE_REASONS): the agent is running again.
      if (event.from === "tom") { e.needs = null; e.snooze = null; e.muteTurn = false; e.lastTomMessageAt = now; }
      else { e.needs = withoutRunState(e.needs); if (!e.needs) e.snooze = null; }
      break;
    case "permission": flag("permission", event.detail, `permission:${event.requestId}`); break; // #4
    case "permission_resolved": // #5, D1: answering is attending.
      if (e.needs) {
        const reasons = e.needs.reasons.filter(r => r.dedupeKey !== `permission:${event.requestId}`);
        e.needs = reasons.length ? { ...e.needs, reasons } : null;
        if (!e.needs) e.snooze = null;
      }
      break;
    case "crash": flag("error", event.detail, "error"); break; // #6
    case "paused": if (!seen(e, `paused:${event.pauseId}`)) flag("paused", event.detail, "paused"); break; // #7
    case "ci": if (!seen(e, event.dedupeKey) && !event.suppressed) flag("ci", event.detail, "ci"); break; // #8
    case "review": if (!seen(e, event.dedupeKey) && !event.suppressed) flag("review", event.detail, "review"); break; // #9
    case "reviewers": if (!seen(e, event.dedupeKey)) flag("reviewers", event.detail, "reviewers", event.prKey); break;
    case "facts_live":
      if (e.needs) {
        const dead = FACT_REASONS.filter(r => !event.live.includes(r));
        // A withdrawn "Add reviewers" may come back (Undo on No review, reviewers removed): forget its key so the same
        // PR can ask again. CI and threads key on the head or the threads, so a new fact already has a new key.
        // No PR of this agent asks any more, so every "<pr>:reviewers" key goes.
        if (dead.includes("reviewers") && e.needs.reasons.some(r => r.reason === "reviewers")) e.seenKeys = e.seenKeys.filter(k => !k.endsWith(":reviewers"));
        e.needs = withoutReasons(e.needs, dead); if (!e.needs) e.snooze = null;
      }
      break;
    case "pr_closed": // #10, and a "until this PR merges" snooze wakes here.
      if (!seen(e, event.dedupeKey)) {
        if (e.snooze?.until === `pr:${event.prKey}`) e.snooze = null;
        // pr-label-matches-state: a merge flags as merged; a-merge-the-agent-made-never-flags-the-developer: quiet flags nothing.
        const merged = event.merged ?? / merged$/.test(event.detail);
        if (!event.quiet) flag(merged ? "pr_merged" : "pr_closed", event.detail, merged ? "pr_merged" : "pr_closed");
      }
      break;
    case "sign_off": { // #13
      if (event.seq !== undefined && event.seq !== e.seq) throw new StaleSignOff();
      if (e.needs || e.snooze) e.undo = { kind: "sign_off", seq: e.seq + 1, prev: e.needs, prevSnooze: e.snooze, set: null, expires: new Date(Date.parse(now) + UNDO_MS).toISOString() };
      e.needs = null; e.snooze = null; e.signedOffAt = now;
      if (event.muteTurn) e.muteTurn = true;
      break;
    }
    case "undo": { // #14
      const u = e.undo;
      if (!u || Date.parse(u.expires) < Date.parse(now)) break;
      if (u.kind === "snooze") {
        if (e.snooze && u.set && e.snooze.until === u.set.until && e.snooze.at === u.set.at) e.snooze = u.prevSnooze;
        e.undo = null;
        break;
      }
      if (!e.needs) { e.needs = u.prev; e.snooze = u.prevSnooze; }
      else if (u.prev) {
        // Something new flagged since: keep it and bring the signed-off reasons back too.
        const keys = new Set(e.needs.reasons.map(r => r.dedupeKey));
        e.needs = { reasons: [...u.prev.reasons.filter(r => !keys.has(r.dedupeKey)), ...e.needs.reasons], since: u.prev.since < e.needs.since ? u.prev.since : e.needs.since };
      }
      e.undo = null; e.signedOffAt = null; e.muteTurn = false;
      break;
    }
    case "snooze": // #15, and #15b: Later is undoable like a sign-off.
      if (e.needs && !e.goneAt) {
        const set = { until: event.until, at: now };
        e.undo = { kind: "snooze", seq: e.seq + 1, prev: e.needs, prevSnooze: e.snooze, set, expires: new Date(Date.parse(now) + UNDO_MS).toISOString() };
        e.snooze = set;
      }
      break;
    case "unsnooze": if (e.snooze && e.needs) e.snooze = null; break; // #15c
    case "tick": // #16, plus housekeeping.
      if (e.snooze && /^\d{4}-/.test(e.snooze.until) && Date.parse(e.snooze.until) <= Date.parse(now)) e.snooze = null;
      if (e.undo && Date.parse(e.undo.expires) < Date.parse(now)) e.undo = null;
      break;
    case "open": break; // #17: opening, reading, switching away and Paseo's read state change nothing.
    case "archive": if (!e.goneAt) e.goneAt = now; break; // #18
    case "unarchive": if (e.goneAt && Date.parse(now) - Date.parse(e.goneAt) <= GONE_MS) e.goneAt = null; break;
    case "set_finish_flags": e.enable_finish_flags = event.value; break;
    case "reconcile": // #20
      if (e.enable_finish_flags) flag("finished", event.detail, "finished");
      break;
  }
  if (JSON.stringify(e) !== before) e.seq = prev.seq + 1;
  return e;
}

/** True once a gone entry is past its 7-day keep. */
export const expired = (e: Entry, now: number) => !!e.goneAt && now - Date.parse(e.goneAt) > GONE_MS;

export function displayReason(needs: Needs | null): ReasonEntry | null {
  if (!needs?.reasons.length) return null;
  return [...needs.reasons].sort((a, b) => reasonRank(a.reason) - reasonRank(b.reason) || a.at.localeCompare(b.at))[0];
}

/** D9: by urgency group, then oldest first, so the longest wait floats up. Ties break on id for stability. */
export function compareNeeds(a: { agentId: string; needs: Needs | null }, b: { agentId: string; needs: Needs | null }): number {
  const ra = displayReason(a.needs), rb = displayReason(b.needs);
  const ua = ra ? reasonRank(ra.reason) : REASONS.length, ub = rb ? reasonRank(rb.reason) : REASONS.length;
  return ua - ub || (a.needs?.since ?? "").localeCompare(b.needs?.since ?? "") || a.agentId.localeCompare(b.agentId);
}

/** "12m", "3h", "2d": the compact age the rows and the composer control show. */
export function age(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * A wall-clock time (day offset from today, hour) in an IANA timezone, as an instant. Two passes settle the zone's
 * offset, including across a daylight-saving change between now and then.
 */
function zonedAt(now: Date, timeZone: string, dayOffset: number, hour: number): Date {
  const parts = (t: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(t).map(p => [p.type, Number(p.value)])) as Record<string, number>;
  const offset = (t: Date) => { const p = parts(t); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t.getTime() / 1000) * 1000; };
  const today = parts(now);
  const wall = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, 0, 0);
  let at = wall - offset(new Date(wall));
  at = wall - offset(new Date(at));
  return new Date(at);
}

/** Whether a string names a timezone this runtime knows ("Asia/Jerusalem", "UTC"). */
export function isTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

/**
 * Snooze presets offered by "Later…". Times are local to the device that picks them, or, given `timeZone`, to that
 * zone: the daemon resolves an agent tool's "tonight"/"tomorrow" in the developer's timezone (the one their Follow-up
 * client last reported), not the host's, which is often UTC.
 */
export function snoozeUntil(choice: "hour" | "tonight" | "tomorrow" | "next-event", now: Date, timeZone?: string | null): string {
  if (choice === "next-event") return "next-event";
  if (choice === "hour") return new Date(now.getTime() + 3_600_000).toISOString();
  if (isTimeZone(timeZone)) {
    if (choice === "tonight") { const d = zonedAt(now, timeZone, 0, 18); return (d > now ? d : zonedAt(now, timeZone, 1, 18)).toISOString(); }
    return zonedAt(now, timeZone, 1, 9).toISOString();
  }
  const d = new Date(now);
  if (choice === "tonight") { d.setHours(18, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d.toISOString(); }
  d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString();
}

/**
 * The words the snooze tools accept ("1h", "hour", "tonight", "tomorrow", "next-event", "pr:<repo#n>", an ISO time) as
 * what a snooze stores: an ISO time or a wake word. Null for anything else. A raw "1h" stored as-is never woke.
 * `timeZone`: where "tonight" and "tomorrow" are (snoozeUntil).
 */
export function resolveUntil(until: string, now: Date, timeZone?: string | null): string | null {
  const u = until.trim().toLowerCase();
  if (u === "1h" || u === "hour") return snoozeUntil("hour", now);
  if (u === "tonight" || u === "tomorrow" || u === "next-event") return snoozeUntil(u, now, timeZone);
  if (/^pr:[\w.-]+\/[\w.-]+#\d+$/i.test(until.trim())) return until.trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(until.trim()) && Number.isFinite(Date.parse(until)) ? new Date(until).toISOString() : null;
}

/**
 * The Later group's time column: when the row comes back, short. "in 25m", "in 2h" within three hours, then "18:00",
 * "tomorrow 09:00", "Tue 09:00"; "next event"; "#12 merges". "now" once the time has passed and the row hasn't moved yet.
 */
export function wakeShort(until: string | null | undefined, now: number): string {
  if (!until) return "";
  if (until === "next-event") return "next event";
  if (until.startsWith("pr:")) return `#${until.split("#")[1]} merges`;
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return "";
  const m = Math.ceil((at - now) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m}m`;
  if (m < 180) return `in ${Math.floor(m / 60)}h`;
  return wakeLabel({ until, at: new Date(now).toISOString() }, now);
}

/** "Back at 22:19", "Back tomorrow 09:00", "Back at the next event", "Back when #12 merges": a Later row's return, as a sentence. */
export function backLabel(until: string, now: number): string {
  const w = wakeLabel({ until, at: new Date(now).toISOString() }, now);
  if (!w) return "In Later";
  return w === "next event" ? "Back at the next event" : /^\d/.test(w) ? `Back at ${w}` : `Back ${w}`;
}

export function wakeLabel(snooze: Snooze, now: number): string {
  if (snooze.until === "next-event") return "next event";
  if (snooze.until.startsWith("pr:")) return `when #${snooze.until.split("#")[1]} merges`;
  const at = new Date(snooze.until);
  if (!Number.isFinite(at.getTime())) return "";
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const next = new Date(now); next.setDate(next.getDate() + 1);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  // "Tomorrow 09:00" reads back as "tomorrow 09:00", not the weekday the developer has to work out.
  return sameDay ? time : next.toDateString() === at.toDateString() ? `tomorrow ${time}` : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** An optimistic action queued while the host was unreachable. */
export type PendingAction = { agentId: string; seq: number; action: "sign_off" };
/**
 * Replay queued sign-offs after reconnecting. A sign-off whose entry moved on (a newer event arrived)
 * is dropped and reported, so the developer sees what came back instead of it vanishing.
 */
export function replay(pending: PendingAction[], entries: Record<string, Entry>, now: string): { entries: Record<string, Entry>; applied: string[]; cameBack: string[] } {
  const next = { ...entries }; const applied: string[] = []; const cameBack: string[] = [];
  for (const p of pending) {
    const e = next[p.agentId];
    if (!e) continue;
    try { next[p.agentId] = reduce(e, { type: "sign_off", seq: p.seq }, now); applied.push(p.agentId); }
    catch (error) { if (error instanceof StaleSignOff) cameBack.push(p.agentId); else throw error; }
  }
  return { entries: next, applied, cameBack };
}

/** What the list RPC returns per root agent. Agent facts come from Paseo; the flag comes from the store. */
export const inboxRowSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  workspaceTitle: z.string().nullable(),
  /** The workspace has more than one root agent, so the row reads "Workspace › Agent". */
  multiRoot: z.boolean(),
  status: z.string(),
  delegatedFrom: z.string().nullable(),
  /** Session Guard "waiting" pause: shown on the Running row, not a flag. */
  resumesAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  needs: needsSchema.nullable(),
  snooze: snoozeSchema.nullable(),
  signedOffAt: z.string().nullable(),
  undoable: z.boolean(),
  seq: z.number().int(),
  muteTurn: z.boolean(),
  enable_finish_flags: z.boolean(),
  /** The open or collapsed brief's one-liner, so every surface says the same thing (§4). */
  brief: z.object({ kind: z.enum(BRIEF_KINDS), source: z.enum(BRIEF_SOURCES), state: z.enum(BRIEF_STATES), ask: z.string(), questionIds: z.array(z.string()).optional(), at: z.string().optional(),
    /** An add-reviewers brief's PR, so the client withdraws it with the PR's reviewers flag (`withoutWithdrawnAsks`). */ prKey: z.string().optional() }).nullable().optional(),
  /** When the agent's current turn started, if the worker saw it start (status invariant running-is-not-stale). */
  turnStartedAt: z.string().nullable().optional(),
  /** Paseo 0.16: the agent's live background work (shells, tasks); absent means none or a 0.15 host. */
  backgroundWork: z.number().int().positive().optional(),
});
export type InboxRow = z.infer<typeof inboxRowSchema>;

export type Section = "needs" | "later" | "running" | "signed";
export function sectionOf(row: InboxRow, now: number): Section | null {
  if (row.needs && !row.snooze) return "needs";
  if (row.needs && row.snooze) return "later";
  if (["running", "initializing"].includes(row.status) || row.resumesAt) return "running";
  if (row.signedOffAt && now - Date.parse(row.signedOffAt) < 24 * 3_600_000 && new Date(row.signedOffAt).toDateString() === new Date(now).toDateString()) return "signed";
  return null;
}

/** The rows of one section in display order. Needs you follows D9; the others put the newest first. */
export function sectionRows(rows: InboxRow[], section: Section, now: number): InboxRow[] {
  const picked = rows.filter(r => sectionOf(r, now) === section);
  if (section === "needs") return picked.sort(compareNeeds);
  if (section === "later") return picked.sort((a, b) => (a.snooze!.until).localeCompare(b.snooze!.until));
  if (section === "signed") return picked.sort((a, b) => (b.signedOffAt ?? "").localeCompare(a.signedOffAt ?? ""));
  return picked.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

/** "Sign off & next" opens the top of Needs you, never the row below, so it can't walk past a permission. */
export function nextAfter(rows: InboxRow[], currentAgentId: string | null, now: number): InboxRow | null {
  return sectionRows(rows, "needs", now).find(r => r.agentId !== currentAgentId) ?? null;
}

/** Title for a row: "Workspace › Agent" only when the workspace has more than one root agent. */
export function rowTitle(row: Pick<InboxRow, "title" | "workspaceTitle" | "multiRoot">): { primary: string; agent: string | null } {
  if (row.multiRoot && row.workspaceTitle) return { primary: row.workspaceTitle, agent: row.title };
  return { primary: row.workspaceTitle || row.title, agent: null };
}

/**
 * The inbox event for a registered PR that left OPEN, or null while it is open (or unread). One place for the rule, so
 * the worker (server/inbox.ts followUpEvents) and the status invariants agree: a merge is `merged`, and a merge the
 * agent made itself (register_pr agentMerges, or any merge in a No review repository: `agentMerges`) is `quiet`.
 */
export function prEndEvent(pr: { key: string; repo: string; number: number; agentMerges?: boolean; snapshot: { state: string; complete: boolean } | null }): Extract<InboxEvent, { type: "pr_closed" }> | null {
  const s = pr.snapshot;
  if (!s?.complete || (s.state !== "MERGED" && s.state !== "CLOSED")) return null;
  const merged = s.state === "MERGED";
  return { type: "pr_closed", dedupeKey: `${pr.key}:${s.state}`, detail: `#${pr.number} ${merged ? "merged" : "closed"}`, prKey: pr.key, merged, ...(merged && agentMerges(pr) ? { quiet: true } : {}) };
}
