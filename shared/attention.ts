import { MERGE_QUEUED_STATUSES as QUEUED, checksState, mergeQueued } from "./pr-status";
export { mergeQueued } from "./pr-status";
import { sendItems } from "./send-words";
import { githubOffLine } from "./github-setup";
import { batchView, FINISH_LINE, perSnapshot, stuckLine, unconfirmedRefs } from "./status";
import { deliveryStatus } from "./queue";
import { sentence } from "./errors";
import { blockedOnDeveloper, completionCheck, liveWorkingTask, statusKnown, summary, type Task, type Status } from "./model";
import type { ListBatch as Batch, ListPr as Pr, ListWorkspace as Workspace } from "./list";
import { STALE_REASON, MAIN_WAIT, NO_PROGRESS_CAP, QUIET_WAIT, holdsQueue, mainWait, personPart, stuckBatch } from "./send-decision";
import { workingLine } from "./task-status";
import { owedTask } from "./task-view";
import { taskDue } from "./task-due";
import { clockLabel, pendingAt } from "./task-trigger";
import { followUpObligations, recoveryBatch } from "./follow-up";
import { orderedStacks, prLink, settledForDisplay, type PrLink } from "./presentation";
import { downstackScan, githubApproved, graphiteReady, isGithubFlow, mergeBlockers, prActionBlocks } from "./pr-actions";
import { configuredReviewers, noReviewers, reviewersAsk, suggestedReviewers } from "./reviewers";
import { agentMerges } from "./pr-workflow";
import { awaitingSend, isOpen as questionOpen, questionState, type QuestionState } from "./questions";

/** One colour language for the stack bar, rail nodes and overview bars. */
export type PrTone = "merged" | "approved" | "danger" | "warning" | "pending" | "draft" | "closed" | "unknown";

export function prTone(pr: Pr): PrTone {
  const s = pr.snapshot;
  if (!s?.complete) return "unknown";
  if (s.state === "MERGED") return "merged";
  if (s.state === "CLOSED") return "closed";
  if (s.conflict || s.failedChecks?.length) return "danger";
  if (s.threads?.length || s.reviewDecision === "CHANGES_REQUESTED" || s.otherFailedChecks?.length) return "warning";
  if (s.draft) return "draft";
  return s.reviewDecision === "APPROVED" ? "approved" : "pending";
}

/** PRs that still need repairs from the agent: conflicts, required checks or review feedback. */
export function needsRepair(pr: Pr): boolean {
  const s = pr.snapshot;
  return !pr.error && !!s?.complete && s.state === "OPEN" && !s.draft && (s.conflict || !!s.failedChecks?.length || !!s.threads?.length || s.reviewDecision === "CHANGES_REQUESTED");
}

/**
 * Each PR's distance from its stack's root, every one in one pass (invariant a-check-costs-linear-in-its-workspace).
 * 2026-11-13: depth walked parents with a linear find inside the sort's comparator, O(n² log n) on a 153-PR
 * workspace, run by every status check and Home row. A cycle counts from where it closes, as before.
 */
function depths<P extends { key: string; parent: string | null }>(prs: readonly P[]): Map<string, number> {
  const byKey = new Map<string, P>();
  for (const p of prs) if (!byKey.has(p.key)) byKey.set(p.key, p);
  const out = new Map<string, number>();
  for (const start of prs) {
    if (out.has(start.key)) continue;
    const chain: string[] = []; const onChain = new Set<string>();
    let p: P | undefined = start, base = -1;
    while (p) {
      const known = out.get(p.key);
      if (known !== undefined) { base = known; break; }
      if (onChain.has(p.key)) break;
      chain.push(p.key); onChain.add(p.key);
      p = p.parent === null ? undefined : byKey.get(p.parent);
    }
    // The chain runs child → root: the last key is the root (or where a cycle closed), at base + 1.
    for (let i = chain.length - 1; i >= 0; i--) out.set(chain[i]!, base + chain.length - i);
  }
  return out;
}
/** Parents before children, then by number: the order a stack merges in. */
export function stackOrder<P extends Pr>(prs: readonly P[]): P[] {
  const d = depths(prs);
  return [...prs].sort((a, b) => d.get(a.key)! - d.get(b.key)! || a.number - b.number);
}

export type Segment = { key: string; number: number; stack: string; tone: PrTone };
/** The header bar: one segment per PR in active stacks, or every PR once everything has settled. */
export function stackBar(w: Pick<Workspace, "prs">): { segments: Segment[]; merged: number; total: number } {
  const stacks = orderedStacks(w.prs);
  const active = stacks.filter(s => !s.prs.every(settledForDisplay));
  const shown = (active.length ? active : stacks).flatMap(s => stackOrder(s.prs));
  return {
    segments: shown.map(p => ({ key: p.key, number: p.number, stack: p.stack, tone: prTone(p) })),
    merged: shown.filter(p => p.snapshot?.state === "MERGED").length,
    total: shown.length,
  };
}

/** The most marks the stack bar draws: at the panel's ~370 px that is about 7 px each, still readable and clickable. */
export const STACK_BAR_BUDGET = 40;
/** How loud a tone is in the stack bar: what needs fixing first, settled work last. */
const BAR_RANK: Record<PrTone, number> = { danger: 0, warning: 1, unknown: 2, draft: 3, pending: 4, approved: 5, closed: 6, merged: 7 };
/** One mark on the stack bar: `count` PRs in stack order from #`from` to #`to`, painted `tone`; it opens `key`. */
export type BarMark = { key: string; number: number; tone: PrTone; count: number; from: number; to: number };
/**
 * The stack bar's marks (`stack-bar-reads-at-any-size`): one per PR up to STACK_BAR_BUDGET; past it, runs of
 * neighbouring PRs in the same state, each as wide as its share of the stack; and when even the runs are too many, the
 * stack in equal slices, each painted its loudest PR's tone. The order is kept, a failing PR is never averaged away,
 * and a mark opens its loudest PR. 2026-11-22: a 126-PR workspace drew 126 segments about 1 px wide, a dotted hairline.
 */
export function barMarks(segments: readonly Segment[], budget = STACK_BAR_BUDGET): BarMark[] {
  const one = (s: Segment): BarMark => ({ key: s.key, number: s.number, tone: s.tone, count: 1, from: s.number, to: s.number });
  if (segments.length <= budget) return segments.map(one);
  const merge = (group: readonly Segment[]): BarMark => {
    const loud = group.reduce((a, b) => BAR_RANK[b.tone] < BAR_RANK[a.tone] ? b : a);
    return { key: loud.key, number: loud.number, tone: loud.tone, count: group.length, from: group[0]!.number, to: group.at(-1)!.number };
  };
  const runs: Segment[][] = [];
  for (const s of segments) { const last = runs.at(-1); if (last && last[0]!.tone === s.tone) last.push(s); else runs.push([s]); }
  if (runs.length <= budget) return runs.map(merge);
  const size = Math.ceil(segments.length / budget);
  const slices: Segment[][] = [];
  for (let i = 0; i < segments.length; i += size) slices.push(segments.slice(i, i + size));
  return slices.map(merge);
}

/** A stack longer than this folds its quiet runs in the Pull requests card. */
export const QUIET_FOLD_FROM = 20;
/** The shortest run of quiet PRs worth a fold: shorter ones show as they are. */
export const QUIET_FOLD_MIN = 4;
export type StackItem<P> = { kind: "pr"; pr: P } | { kind: "quiet"; key: string; prs: P[] };
/**
 * The Pull requests card's rows for one stack (`a-long-stack-shows-its-problems`): past QUIET_FOLD_FROM PRs, each run
 * of at least QUIET_FOLD_MIN neighbouring PRs that are only in review (pending: nothing failing, no threads, not
 * approved, not a draft) folds into one "+N in review" row that `isOpen(key)` expands in place. Everything else (a
 * failure, a thread, an approval, a draft, an unknown status) keeps its own row, in stack order, so problems are on
 * screen without scrolling past the quiet ones. 2026-11-22: a 120-PR stack drew every row, about 8000 px, and its
 * seven PRs to fix were scattered through it.
 */
export function quietFold<P extends Pr>(prs: readonly P[], isOpen: (key: string) => boolean, from = QUIET_FOLD_FROM, min = QUIET_FOLD_MIN): StackItem<P>[] {
  if (prs.length <= from) return prs.map(pr => ({ kind: "pr", pr }));
  const out: StackItem<P>[] = [];
  let run: P[] = [];
  const flush = () => {
    if (run.length >= min) { const key = `quiet:${run[0]!.key}`; out.push({ kind: "quiet", key, prs: run }); if (isOpen(key)) out.push(...run.map(pr => ({ kind: "pr" as const, pr }))); }
    else out.push(...run.map(pr => ({ kind: "pr" as const, pr })));
    run = [];
  };
  for (const pr of prs) { if (prTone(pr) === "pending") run.push(pr); else { flush(); out.push({ kind: "pr", pr }); } }
  flush();
  return out;
}

const pendingSends = (w: Workspace) => w.batches.filter(b => !recoveryBatch(b) && b.state === "pending");
const openBatches = (w: Workspace) => w.batches.filter(b => !recoveryBatch(b) && holdsQueue(b));

/** Snapshot-only merge readiness. Pr controls add the browser's live "merging" read on top. */
export function mergeReady(pr: Pr, w: Pick<Workspace, "prActions">, now = Date.now()): boolean {
  const s = pr.snapshot;
  const queued = QUEUED.includes(s?.graphiteMergeStatus ?? "");
  const recentlySubmitted = w.prActions.some(a => a.kind === "merge" && a.state === "submitted" && a.heads[pr.key] === s?.head && now - Date.parse(a.createdAt) < 30_000);
  // GitHub mode: the same verdict Needs you and the merge plan use, so the sheet never offers Merge on a draft, conflict or red check.
  if (isGithubFlow(s)) return mergeBlockers(pr).length === 0 && !recentlySubmitted;
  return !pr.error && !!s?.complete && s.state === "OPEN" && s.reviewDecision === "APPROVED" && !s.draft && !s.conflict && !s.failedChecks?.length && !s.checksPending && !queued && !recentlySubmitted;
}
/** Whether the workflow that ships this PR says it can merge now: Graphite's readiness, or GitHub's own verdict. */
export const workflowReady = (pr: Pr) => isGithubFlow(pr.snapshot) ? mergeBlockers(pr).length === 0 : graphiteReady(pr.snapshot?.graphiteMergeStatus);

/** Why a pending batch cannot be sent right now, or null when Send is available. Mirrors the server's guards. */
export function sendBlocker(w: Workspace, batch: Batch): string | null {
  if (w.hold) return "Resume follow-up first";
  // The Done check waits for the whole workspace; a repair only for the main agent's own wait (Q96 = A), said in the
  // send decision's words.
  if (completionCheck(batch) && (w.runtimeBusy || w.backgroundBusy)) return capitalize(QUIET_WAIT);
  const main = mainWait(w);
  if (main) return capitalize(MAIN_WAIT[main]);
  if (w.runtimeReason) return w.runtimeReason;
  if (w.batches.some(other => other.id !== batch.id && holdsQueue(other))) return "Another batch is still open";
  return null;
}

type NeedItemBase =
  | { kind: "hold"; key: string; title: string; detail: string }
  | { kind: "retry"; key: string; batchId: string; title: string; detail: string; exhausted: boolean }
  /** One task that went out NO_PROGRESS_CAP times with no change (Q49): Retry sends that task again; the rest of the queue moves on. */
  | { kind: "capped"; key: string; taskKey: string; title: string; detail: string }
  /**
   * A task the agent said only a person can move (Batch.humanOnly): the developer's, never an agent failure
   * (a-human-only-outcome-is-a-human-item). `review`: a review only its reviewer can change, so the item asks for a
   * re-review (the PR sheet's reviewers). Send to agent hands it back (retryTask, the retry_batch tool).
   */
  | { kind: "person"; key: string; taskKey: string; prKey: string | null; review: boolean; /** Only part of the task (Batch.waitingOn): the agent goes on with the rest. */ part: boolean; title: string; detail: string }
  /** `finish`: the Done check. It never auto-sends, so it always waits on you. */
  | { kind: "send"; key: string; batchId: string; title: string; tasks: string[]; /** "2 repairs": what the message holds, in the developer's words (send-words). */ what: string; blocker: string | null; finish?: true }
  | { kind: "decision"; key: string; obligationId: string; title: string; detail: string }
  | { kind: "question"; key: string; questionId: string; title: string; detail: string; state: QuestionState; big: string | null }
  | { kind: "answer"; key: string; questionId: string; title: string; detail: string; waiting?: "copied" | "in-chat" }
  | { kind: "check"; key: string; actionId: string; title: string; detail: string }
  /** A forward or report to an agent that didn't go out (Workspace.undelivered): Retry or Cancel its queue item. */
  | { kind: "message"; key: string; itemId: string; title: string; detail: string }
  | { kind: "merge"; key: string; prKey: string; number: number; title: string; detail: string }
  | { kind: "reviewers"; key: string; prKey: string; number: number; /** Whom Follow-up suggests (reviewerLabel). */ suggested: string[]; title: string; detail: string };
/**
 * Every Needs-you item that is about one PR carries `pr`: the row's one-click open of it, and what an agent hands the
 * developer (invariant a-row-that-names-a-pr-opens-it-in-one-click).
 */
export type NeedItem = NeedItemBase & { pr?: PrLink };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The main agent as the developer knows it: its Paseo title, else "the main agent". */
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
/** The Needs-you Send while Auto is off: how much waits and why, never the workspace's title (say it once, Q51). */
export const autoOffLine = (items: readonly Pick<Task, "kind">[]) => `${sendItems(items)} ready · auto-send is off here`;
export const agentName = (w: Pick<Workspace, "mainAgentTitle">) => w.mainAgentTitle?.trim() || "the main agent";
/** A person task's Needs-you title: whom it waits on, never "didn't finish". */
export function personTitle(t: Pick<Task, "kind" | "title">, number?: number): string {
  if (number === undefined) return `${t.title}: waits on a person, not the agent`;
  return t.kind === "review" ? `#${number} waits on its reviewer` : `#${number} waits on a person, not the agent`;
}
/** A task part only a person can move (Batch.waitingOn): the agent goes on with the rest. */
export function partTitle(t: Pick<Task, "kind" | "title">, number?: number): string {
  if (number === undefined) return `Part of ${t.title} waits on a person`;
  return t.kind === "review" ? `Part of #${number} waits on its reviewer` : `Part of #${number} waits on a person`;
}
/** A capped task's Needs-you title: what is still wrong, in plain words. */
export function cappedTitle(t: Pick<Task, "kind" | "target" | "title">): string {
  const pr = `#${t.target.split("#")[1] ?? t.target}`;
  const still = `still there after ${NO_PROGRESS_CAP} messages`;
  switch (t.kind) {
    case "conflict": return `Conflicts on ${pr} are ${still}`;
    case "review": return `Review feedback on ${pr} is ${still}`;
    case "checks": return `Failing checks on ${pr} are ${still}`;
    case "restack": return `${pr} still needs a restack after ${NO_PROGRESS_CAP} messages`;
    default: return `${t.title}: ${still}`;
  }
}

/** Everything waiting on the developer, most urgent first. Each item has exactly one action. */
/** One need as a workspace snooze remembers it: its key plus what it says, so a different hold or blocker is news. */
export const needKey = (i: NeedItem) => `${i.key}|${"detail" in i ? i.detail : i.title}`;

/** A workspace's Later still stands: its time hasn't come and every need it covers was already there when it was set. */
export function workspaceSnoozed(w: Pick<Workspace, "snooze">, items: readonly NeedItem[], now: number): boolean {
  const z = w.snooze;
  if (!z || !items.length) return false;
  if (z.until !== "next-event" && !(Date.parse(z.until) > now)) return false;
  const known = new Set(z.keys);
  return items.every(i => known.has(needKey(i)));
}

/** The needs that count right now: none while the workspace is in Later. Every count (dot, pill, Home) uses this. */
export function activeNeeds(w: Workspace, now = Date.now()): NeedItem[] {
  const items = needsYou(w, now);
  return workspaceSnoozed(w, items, now) ? [] : items;
}

/**
 * Whether a PR asks the developer to add reviewers. The one predicate for Needs you's reviewers item and the inbox's
 * "Add reviewers" flag (server/inbox.ts followUpEvents), so the two never disagree: an open, non-draft PR with no
 * reviewers, in a repository someone is set up to review, that the agent doesn't merge itself, with no reviewer
 * request or merge already in flight. Status invariant reviewers-ask-agrees.
 */
export function asksForReviewers(pr: Pr, w: Pick<Workspace, "prActions">): boolean {
  return !agentMerges(pr) && noReviewers(pr) && !pr.snapshot!.draft && configuredReviewers(pr.repo).length > 0 && !w.prActions.some(a => prActionBlocks(a, [pr.key]));
}

/**
 * What an item's dismissal is pinned to (dismissing-anything-in-needs-you-sends-the-agent-nothing): Dismiss hides the
 * item while this print matches, and a change to what it is about makes a new print, so a real new problem comes back.
 * Per kind, what "changed" means:
 * - merge, reviewers: the PR's head commit (a new push asks again).
 * - retry: the batch, its state, attempts and result (a new failure, or the next attempt failing).
 * - capped, person: the task's fingerprint (what GitHub shows for it) and why it is held.
 * - send: the batch and its tasks' fingerprints (a new batch, or a task added or changed).
 * - decision: the task's revision and ask. hold: the pause's reason. check: the action and its result.
 * - answer: the delivery state and the answer (failed again after a Retry, copied then put in chat).
 * - message: the queue item and its state (queued past the stuck mark, then failed).
 * A question never needs a print: its dismissal closes it (server/questions.ts dismissQuestion).
 */
export function dismissPrint(i: NeedItem, w: Workspace): string {
  switch (i.kind) {
    case "hold": return `${w.hold ?? ""}`;
    case "retry": { const b = w.batches.find(b => b.id === i.batchId); return `${i.batchId}|${b?.state ?? ""}|${b?.attempts ?? 0}|${b?.result ?? ""}`; }
    case "capped": case "person": { const h = (w.heldTasks ?? []).find(h => h.task.key === i.taskKey); return `${i.taskKey}|${h?.task.fingerprint ?? ""}|${i.detail}`; }
    case "send": { const b = w.batches.find(b => b.id === i.batchId); return `${i.batchId}|${(b?.tasks ?? []).map(t => `${t.key}:${t.fingerprint}`).sort().join(",")}`; }
    case "decision": { const o = w.obligations.find(o => o.id === i.obligationId); return `${i.obligationId}|${o?.revision ?? ""}|${i.detail}`; }
    case "question": return i.questionId;
    case "answer": { const a = (w.questions ?? []).find(q => q.id === i.questionId)?.answer; return `${i.questionId}|${a?.delivery.state ?? ""}|${a?.at ?? ""}|${a?.choice ?? ""}|${a?.words ?? ""}`; }
    case "check": return `${i.actionId}|${i.detail}`;
    case "message": { const m = (w.undelivered ?? []).find(m => m.id === i.itemId); return `${i.itemId}|${m?.state ?? ""}`; }
    case "merge": case "reviewers": return `${i.prKey}|${w.prs.find(p => p.key === i.prKey)?.snapshot?.head ?? ""}`;
  }
}
/** The developer dismissed this item and it hasn't changed since (dismissPrint). */
export const isDismissedNeed = (w: Pick<Workspace, "dismissed">, key: string, print: string) => !!w.dismissed?.some(d => d.key === key && d.print === print);
/**
 * Whether the reviewers ask for this PR stands: it asks (asksForReviewers) and the developer hasn't dismissed it since
 * its last push. The inbox's "Add reviewers" flag reads this, so dismissing the ask in Needs you drops the agent row's
 * flag too, and the two never disagree (reviewers-ask-agrees).
 */
export function reviewersAskStands(pr: Pr, w: Pick<Workspace, "prActions" | "dismissed">): boolean {
  return asksForReviewers(pr, w) && !isDismissedNeed(w, `reviewers:${pr.key}`, `${pr.key}|${pr.snapshot?.head ?? ""}`);
}

/**
 * Every Needs-you item, dismissed ones included: what Dismiss looks an item up in (server/dismiss.ts) and what
 * workspace_status reads to say what the developer dismissed. Every count and surface reads needsYou.
 */
const allNeedsOnce = perSnapshot(computeAllNeeds);
export const allNeeds = (w: Workspace, now = Date.now()): NeedItem[] => [...allNeedsOnce(w, now)];
/** What needs the developer, most urgent first, without what they dismissed. Answered once per store snapshot and clock reading (perSnapshot); each caller gets its own array. */
const needsYouOnce = perSnapshot((w: Workspace, now: number) => {
  const all = allNeedsOnce(w, now);
  return w.dismissed?.length ? all.filter(i => !isDismissedNeed(w, i.key, dismissPrint(i, w))) : all;
});
export const needsYou = (w: Workspace, now = Date.now()): NeedItem[] => [...needsYouOnce(w, now)];
function computeAllNeeds(w: Workspace, now: number): NeedItem[] {
  if (!w.enable_tracking || w.archived) return [];
  const items: NeedItem[] = [];
  const questions = w.questions ?? [];
  // A capped task or an uncertain action about one tracked PR links it like the merge and reviewers rows do.
  const linkFor = (key: string) => { const pr = w.prs.find(p => p.key === key); return pr ? { pr: prLink(pr) } : {}; };
  // A question that stopped the agent outranks everything: nothing moves until it's answered.
  const open = questions.filter(questionOpen);
  for (const q of open.filter(q => questionState(q) === "stopped")) items.push({ kind: "question", key: `question:${q.id}`, questionId: q.id, title: `${q.id} · ${q.title}`, detail: q.question, state: "stopped", big: q.big });
  if (w.hold) items.push({ kind: "hold", key: "hold", title: "Follow-up is paused", detail: w.hold });
  // A batch whose review changed, went away or was sent again (Batch.movedOn) isn't stuck: it never shows as failing.
  for (const b of w.batches.filter(b => !recoveryBatch(b) && stuckBatch(b) && !(w.completion && completionCheck(b)))) {
    items.push({ kind: "retry", key: `retry:${b.id}`, batchId: b.id, exhausted: b.attempts >= 3,
      title: stuckLine(b),
      detail: b.result || (b.state === "uncertain" ? "Delivery wasn't confirmed." : "The main agent reported a blocker.") });
  }
  for (const h of (w.heldTasks ?? []).filter(h => h.held === "capped"))
    items.push({ kind: "capped", key: `capped:${h.task.key}`, taskKey: h.task.key, title: cappedTitle(h.task), ...linkFor(h.task.target),
      detail: `Sent ${NO_PROGRESS_CAP} times and GitHub shows no change. Check ${agentName(w)}'s chat, then retry.` });
  for (const h of (w.heldTasks ?? []).filter(h => h.held === "person")) {
    const why = [...w.batches].reverse().find(b => b.humanOnly && b.state === "completed" && b.tasks.some(t => t.key === h.task.key))?.result;
    const pr = w.prs.find(p => p.key === h.task.target);
    items.push({ kind: "person", key: `person:${h.task.key}`, taskKey: h.task.key, prKey: pr?.key ?? null, review: h.task.kind === "review", part: false, title: personTitle(h.task, pr?.number), ...linkFor(h.task.target),
      detail: why || `${capitalize(agentName(w))} says nothing is left for an agent here.` });
  }
  // a-person-part-is-a-person-item: the part of a task the agent said only a person can move, while its PR is open and
  // the whole task isn't already a person item. The rest of the task goes on with the agent.
  const parts = new Map<string, Task>();
  for (const b of w.batches) for (const t of b.tasks) parts.set(t.key, t);
  for (const t of parts.values()) {
    const part = personPart(w, t.key);
    const pr = part ? w.prs.find(p => p.key === t.target) : undefined;
    if (!part || (pr && pr.snapshot?.state && pr.snapshot.state !== "OPEN") || (w.heldTasks ?? []).some(h => h.held === "person" && h.task.key === t.key)) continue;
    items.push({ kind: "person", key: `person:${t.key}`, taskKey: t.key, prKey: pr?.key ?? null, review: t.kind === "review", part: true, title: partTitle(t, pr?.number), ...linkFor(t.target), detail: part.text });
  }
  for (const a of w.prActions.filter(a => a.state === "uncertain")) {
    const numbers = a.prs.map(key => `#${key.split("#")[1]}`).join(", ");
    items.push({ kind: "check", key: `check:${a.id}`, actionId: a.id, ...(a.prs.length === 1 ? linkFor(a.prs[0]) : {}), title: `Check the ${a.kind === "merge" ? "merge" : a.kind === "request_reviewers" ? "reviewer request" : "merge-when-ready change"} on ${numbers}`, detail: a.result });
  }
  // The queue's rare loud case (a-message-is-saved-before-sent-and-arrives-once): the agent's conversation is gone, so
  // it is the developer's to check and Retry. Everything else, an unknown arrival included, retries on its own
  // (a-queued-message-never-stops-short).
  for (const q of questions.filter(q => q.answer?.delivery.state === "failed"))
    items.push({ kind: "answer", key: `answer:${q.id}`, questionId: q.id, title: `Your ${q.id} answer: Failed`, detail: deliveryStatus({ state: "failed", reason: q.answer!.delivery.reason }).detail });
  // A message with no card of its own that didn't go out (a-message-is-saved-before-sent-and-arrives-once).
  for (const m of w.undelivered ?? [])
    items.push({ kind: "message", key: `message:${m.id}`, itemId: m.id, title: `A message to ${m.agentTitle?.trim() || "an agent"} didn't go out`,
      detail: m.state === "failed" ? deliveryStatus({ state: "failed", reason: m.reason }).detail : `${m.reason ? `${sentence(m.reason)} ` : ""}Follow-up keeps retrying; Retry tries now, Cancel drops it.` });
  // Copied or put in the agent's chat: the developer's to send, so it stays here until it is
  // (an-answer-leaves-needs-you-only-when-delivered, shared/questions.ts awaitingSend).
  for (const q of questions.filter(awaitingSend)) {
    const inChat = q.answer!.delivery.state === "in-chat";
    items.push({ kind: "answer", key: `answer:${q.id}`, questionId: q.id, waiting: inChat ? "in-chat" : "copied", title: `Your ${q.id} answer isn't sent yet`,
      detail: inChat ? "It's in the agent's chat. Send it there, or from here." : "You copied it. Paste it into the agent's chat, or send it from here." });
  }
  for (const q of open.filter(q => questionState(q) !== "stopped")) items.push({ kind: "question", key: `question:${q.id}`, questionId: q.id, title: `${q.id} · ${q.title}`, detail: q.question, state: questionState(q), big: q.big });
  // A blocked task is a question once the server mirrors it, or the question that covers it (one-decision-one-card);
  // until then it still shows as a decision.
  for (const o of followUpObligations(w).filter(o => blockedOnDeveloper(o) && !o.coveredBy && !questions.some(q => q.taskId === o.id && q.taskRevision !== null)))
    items.push({ kind: "decision", key: `decision:${o.id}`, obligationId: o.id, title: o.title, detail: o.ask! });
  // Repairs Auto won't send (an agent the developer hasn't messaged within the active window) wait on you just like hand-sent ones (shared/status.ts).
  const view = batchView(w, now);
  const idleWait = (b: Batch) => view?.batch.id === b.id && view.phase === "queued" && view.waitingOn === "you" && !w.hold && !w.goneAgent && !w.dormant;
  for (const b of pendingSends(w).filter(b => completionCheck(b) ? !w.completion : !w.enable_auto_sends || idleWait(b))) {
    items.push(completionCheck(b)
      ? { kind: "send", key: `send:${b.id}`, batchId: b.id, tasks: b.tasks.map(t => t.title), what: sendItems(b.tasks), blocker: sendBlocker(w, b), title: FINISH_LINE, finish: true }
      : { kind: "send", key: `send:${b.id}`, batchId: b.id, tasks: b.tasks.map(t => t.title), what: sendItems(b.tasks), blocker: sendBlocker(w, b),
      // Say it once: the tasks are rows in Tasks; the send item says only why it waits on you, and its button how many.
      title: w.enable_auto_sends ? capitalize(STALE_REASON) : autoOffLine(b.tasks) });
  }
  const blocking = (pr: Pr) => w.prActions.some(a => prActionBlocks(a, [pr.key]));
  // One click merges the PR and its unmerged downstack (a-click-on-merge-merges), so Merge is offered only when every
  // PR it would merge can merge: never a button the plan will refuse. A stack it can't read keeps the PR's own verdict.
  // Each PR's own verdict once: every PR's stack check reads the PRs under it, so recomputing made a long stack's
  // check cubic (invariant a-check-costs-linear-in-its-workspace; tests/pr-scale.test.ts).
  const own = new Map<string, boolean>();
  const canMerge = (p: Pr) => { let v = own.get(p.key); if (v === undefined) own.set(p.key, v = mergeReady(p, w, now) && workflowReady(p) && !blocking(p)); return v; };
  const holding = downstackScan(w.prs, canMerge);
  const stackReady = (pr: Pr) => { const by = holding(pr.key); return by === "unreadable" || by === null; };
  for (const pr of stackOrder(w.prs)) {
    // Only offer Merge here when the PR's workflow (Graphite, or GitHub itself) agrees; otherwise the PR sheet explains what is missing.
    // A PR the agent merges itself (its own register_pr answer, else a No review repository) is the agent's work in
    // flight, never the developer's merge or review. Invariant a-no-review-repo-never-asks-for-review-or-merge.
    if (agentMerges(pr)) continue;
    if (canMerge(pr) && stackReady(pr)) items.push({ kind: "merge", key: `merge:${pr.key}`, prKey: pr.key, number: pr.number, pr: prLink(pr), title: isGithubFlow(pr.snapshot) && pr.snapshot!.reviewDecision !== "APPROVED" ? `#${pr.number} is ready to merge` : `#${pr.number} is approved`, detail: pr.snapshot!.title });
    // One ask per PR (one-reviewers-ask-per-pr): it names whom Follow-up suggests, so Follow-up's own reviewers brief
    // folds into it (shared/needs-block.ts) instead of drawing a second ask for the same PR.
    else if (asksForReviewers(pr, w)) { const suggested = suggestedReviewers(pr.repo, pr.snapshot!.reviewers?.author); items.push({ kind: "reviewers", key: `reviewers:${pr.key}`, prKey: pr.key, number: pr.number, pr: prLink(pr), suggested, title: reviewersAsk(pr.number, suggested, `#${pr.number} has no reviewers`), detail: pr.snapshot!.title }); }
  }
  // One Merge per stack: the topmost ready PR's Merge names and merges the PRs under it ("Merge 3 PRs"), so a ready PR
  // under it isn't a second ask for the same decision. Merging only a lower one stays in its PR sheet.
  const merges = items.filter((i): i is Extract<NeedItem, { kind: "merge" }> => i.kind === "merge");
  // Walk each Merge's parents only until a PR another Merge already covers: everything under it is covered too, so
  // the whole pass reads each PR once (a downstack per Merge was quadratic on a long, all-ready stack).
  const covered = new Set<string>();
  const parentOf = merges.length > 1 ? new Map(w.prs.map(p => [p.key, p.parent] as const)) : new Map<string, string | null>();
  if (merges.length > 1) for (const m of merges) {
    if (holding(m.prKey) === "unreadable") continue;
    for (let k = parentOf.get(m.prKey) ?? null; k !== null && !covered.has(k); k = parentOf.get(k) ?? null) covered.add(k);
  }
  return items.filter(i => i.kind !== "merge" || !covered.has(i.prKey));
}

/** Why a downstack PR holds a merge, in a few words, in the rows' words ("checks failed"). */
function holdReason(p: Pr): string {
  const s = p.snapshot;
  if (!s?.complete || p.error) return "status unknown";
  if (s.conflict) return "conflicts";
  if (s.failedChecks?.length) return "checks failed";
  if (checksState(s) === "running") return "checks running";
  if (checksState(s) === "not-started") return "checks not started";
  if (s.draft) return "a draft";
  if (s.threads?.length) return "open threads";
  if (s.reviewDecision !== "APPROVED") return "not approved yet";
  return isGithubFlow(s) ? "GitHub can't merge it yet" : "Graphite can't merge it yet";
}
/**
 * Approved PRs that Merge isn't offered on because a PR under them can't merge yet (a-click-on-merge-merges: a Merge
 * row merges its whole downstack). Needs you leaves them out (the PR below is the agent's repair), so the panel's
 * Pull requests card and Home's detail pane say it: "#143 approved · waits on #142 (checks failed)". An approved PR
 * never goes quiet.
 */
export function heldMerges(w: Workspace, now = Date.now()): { pr: Pr; by: Pr; line: string }[] {
  if (!w.enable_tracking || w.archived) return [];
  const blocking = (pr: Pr) => w.prActions.some(a => prActionBlocks(a, [pr.key]));
  const own = new Map<string, boolean>();
  const canMerge = (p: Pr) => { let v = own.get(p.key); if (v === undefined) own.set(p.key, v = mergeReady(p, w, now) && workflowReady(p) && !blocking(p)); return v; };
  const holding = downstackScan(w.prs, canMerge);
  const out: { pr: Pr; by: Pr; line: string }[] = [];
  for (const pr of stackOrder(w.prs)) {
    if (agentMerges(pr) || !canMerge(pr)) continue;
    const by = holding(pr.key);
    if (by && by !== "unreadable") out.push({ pr, by, line: `#${pr.number} ${isGithubFlow(pr.snapshot) && pr.snapshot!.reviewDecision !== "APPROVED" ? "is ready" : "approved"} · waits on #${by.number} (${holdReason(by)})` });
  }
  return out;
}

export type HeadlinePart = { text: string; tone?: "warning" | "danger" | "success" };
/** "2 of 6 PRs merged, 3 need you, 1 to fix": counts that say where the work stands. */
export function headline(w: Workspace, now = Date.now()): HeadlinePart[] {
  const bar = stackBar(w);
  const parts: HeadlinePart[] = [];
  const state = summary(w, now);
  if (state.status === "done") {
    const unconfirmed = w.completion?.unconfirmed ?? [];
    return unconfirmed.length ? [{ text: `Done · ${plural(w.prs.length, "PR")} merged`, tone: "success" }, { text: `deploy unconfirmed for ${unconfirmedRefs(unconfirmed)}`, tone: "warning" }]
      : [{ text: `Done · ${plural(w.prs.length, "PR")} shipped`, tone: "success" }];
  }
  if (!bar.total) parts.push({ text: "No PRs registered yet" });
  else if (bar.merged === bar.total) parts.push({ text: bar.total === 1 ? "PR merged" : `All ${bar.total} PRs merged` });
  else parts.push({ text: `${bar.merged} of ${plural(bar.total, "PR")} merged` });
  const need = needsYou(w, now).length;
  if (need) parts.push({ text: `${need} need${need === 1 ? "s" : ""} you`, tone: "warning" });
  // A PR whose only open condition waits on a person (a-human-only-outcome-is-a-human-item) isn't the agent's to fix.
  const personOnly = (p: Pr) => !p.snapshot?.conflict && !p.snapshot?.failedChecks?.length && !!w.heldTasks?.some(h => h.held === "person" && h.task.target === p.key);
  const repair = w.prs.filter(p => needsRepair(p) && !personOnly(p)).length;
  if (repair) parts.push({ text: `${repair} to fix`, tone: "danger" });
  return parts;
}

export type LiveIcon = "spinner" | "sent" | "done" | "paused" | "waiting" | "alert" | "failing" | "idle";
/** What is happening right now, in one line, with the time it started when known. */
/**
 * The panel header's live line. Say it once (Q49): while a message is queued, the Messages to the agent card below carries when
 * and why, so the header says only who and what. Home has no strip and keeps liveLine's full line.
 */
export function headerLine(w: Workspace, now = Date.now()): { icon: LiveIcon; text: string; since: string | null } {
  const live = liveLine(w, now);
  const view = batchView(w, now);
  if (view?.phase !== "queued" || view.kind !== "repairs" || live.text !== view.line) return live;
  const to = w.mainAgentTitle?.trim() || "the main agent";
  return { icon: live.icon, text: `${sendItems(view.batch.tasks)} queued for ${to}`, since: null };
}

export function liveLine(w: Workspace, now = Date.now()): { icon: LiveIcon; text: string; since: string | null } {
  const state = summary(w, now);
  if (state.status === "done") {
    const unconfirmed = w.completion?.unconfirmed ?? [];
    return { icon: "done", text: unconfirmed.length ? `Ready to archive once you've checked ${unconfirmed.length === 1 ? `${unconfirmedRefs(unconfirmed)}'s deploy` : `the deploys of ${unconfirmedRefs(unconfirmed)}`}` : "Ready to archive", since: w.completion?.declaredAt ?? null };
  }
  if (w.hold) return { icon: "paused", text: "Paused until you resume", since: w.interruption?.at ?? null };
  const stopped = (w.questions ?? []).filter(questionOpen).find(q => questionState(q) === "stopped");
  if (stopped) return { icon: "paused", text: `Main agent stopped until you answer ${stopped.id}`, since: stopped.askedAt };
  const view = batchView(w, now);
  if (view?.phase === "sent" && view.kind !== "recovery") return { icon: "sent", text: view.line, since: view.batch.activityAt ?? view.batch.sentAt };
  if (w.runtimeReason) return { icon: "waiting", text: w.runtimeReason, since: null };
  // Queued work, in the same words as the agent card and Home (shared/status.ts). Repairs you send by hand live in Needs you.
  if (view?.phase === "queued" && (view.kind === "finish" || w.enable_auto_sends)) return { icon: "waiting", text: view.line, since: view.batch.createdAt };
  // Say who: the main agent only when it is its own turn (Q96 = A), never for a subagent at work beside an idle main.
  if (w.runtimeBusy) return { icon: "spinner", text: mainWait(w) === "turn" ? "Main agent is working" : "Agents in this workspace are working", since: null };
  // A working task spins only while its recorded agent is running (invariant `a-task-only-says-working-when-its-agent-is`).
  // Otherwise it says what the task row says: "<agent> idle", "<agent> closed", "Agent unavailable" or "In progress", with no spinner.
  const live = liveWorkingTask(w);
  if (live) return { icon: "spinner", text: live.title, since: null };
  // A due task is what the agent owes next, so the line names it, not whichever task comes first (a waiting one whose
  // PR is still in review). Stale says so: the agent was told twice and didn't answer.
  const owed = owedTask(w, now);
  if (owed) return { icon: "waiting", text: `${owed.stale ? "Stale" : "Due"}: ${owed.o.title}`, since: null };
  const working = followUpObligations(w).find(o => o.status === "working");
  if (working) return { icon: "waiting", text: `${working.title} · ${workingLine(working, w.taskAgents ?? {}).text}`, since: null };
  // A wait the agent declared (a waiting task: a release, a reload window, a detached job) says what it waits on. The
  // waiting icon, Home's Waiting group and the brief's "Waiting on others" already say it waits, so the line doesn't.
  // With what moves it ("· after #232 merges"), so the line never reads as if that task were happening now.
  // A wait with its own check-back time names the time (the soonest one): "Registry publish · checks back 12:15".
  const timed = followUpObligations(w).filter(o => o.status === "waiting" && o.enable_follow_up && pendingAt(o.trigger)).sort((a, b) => a.trigger!.at!.localeCompare(b.trigger!.at!))[0];
  if (timed) return { icon: "waiting", text: `${timed.title} · checks back ${clockLabel(timed.trigger!.at!, now)}`, since: null };
  const waiting = followUpObligations(w).find(o => o.status === "waiting");
  if (waiting) { const d = taskDue(waiting, w, now); const moves = d && !d.due ? d.label : null; return { icon: "waiting", text: moves ? `${waiting.title} · ${moves[0].toLowerCase()}${moves.slice(1)}` : waiting.title, since: null }; }
  // GitHub off (works-without-github): nothing is retrying and the statuses below are from before, so the line says
  // why, in the Pull requests card's words (githubOffLine), never "retrying".
  if (w.githubOff && w.prs.some(p => p.snapshot?.state !== "MERGED" && p.snapshot?.state !== "CLOSED")) return { icon: "waiting", text: githubOffLine(w.githubOff)!.title, since: null };
  if (w.prs.some(p => !statusKnown(p))) return { icon: "alert", text: "Some PR status is unavailable · retrying", since: null };
  // The worst open PR first (a-pr-summary-says-the-worst): failing checks before running ones, never the reverse.
  const failing = w.prs.filter(p => p.snapshot?.state === "OPEN" && p.snapshot.failedChecks?.length);
  // Red, in the rows' words ("Checks failed"): a failed check is a repair, not something waiting on the developer.
  if (failing.length) return { icon: "failing", text: failing.length === 1 ? `Checks failed on #${failing[0]!.number}` : `Checks failed on ${failing.length} PRs`, since: null };
  if (w.prs.some(p => p.snapshot?.state === "OPEN" && checksState(p.snapshot) === "running")) return { icon: "waiting", text: "Checks are running", since: null };
  if (w.prs.some(p => p.snapshot?.state === "OPEN")) return { icon: "waiting", text: "Waiting on review and merges", since: null };
  return { icon: "idle", text: "Waiting for the main agent to declare Done", since: null };
}

export const statusGroups: { status: Status; title: string; short: string }[] = [
  { status: "needs-you", title: "Needs you", short: "Needs you" },
  { status: "handling", title: "Agent working", short: "Working" },
  { status: "waiting", title: "Waiting", short: "Waiting" },
  { status: "active", title: "In progress", short: "In progress" },
  { status: "done", title: "Done · ready to archive", short: "Done" },
];

/** Overview grouping: anything with a developer action counts as Needs you, even when the agent is busy. */
export function overviewStatus(w: Workspace, now = Date.now()): Status {
  const status = summary(w, now).status;
  if (status === "done") return status;
  return needsYou(w, now).length ? "needs-you" : status;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 6 ? `${h}h ${m % 60}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Fix checks on acme/app#4" reads as "Fix checks on #4" when the workspace only has one repository. */
export function shortRefs(text: string, w: Pick<Workspace, "prs">): string {
  const repos = new Set(w.prs.map(p => p.repo));
  if (repos.size !== 1) return text;
  const [repo] = repos;
  return text.split(`${repo}#`).join("#");
}
