import { summary, type Batch, type Pr, type Workspace, type Status } from "./model";
import { followUpObligations, recoveryBatch } from "./follow-up";
import { orderedStacks, settledForDisplay } from "./presentation";
import { graphiteReady, prActionBlocks } from "./pr-actions";
import { defaultReviewers, noReviewers } from "./reviewers";
import { isOpen as questionOpen, questionState, type QuestionState } from "./questions";

/** One colour language for the stack bar, rail nodes and overview bars. */
export type PrTone = "merged" | "approved" | "danger" | "warning" | "pending" | "draft" | "closed" | "unknown";

export function prTone(pr: Pr): PrTone {
  const s = pr.snapshot;
  if (pr.error || !s?.complete) return "unknown";
  if (s.state === "MERGED") return "merged";
  if (s.state === "CLOSED") return "closed";
  if (s.conflict || s.failedChecks.length) return "danger";
  if (s.threads.length || s.reviewDecision === "CHANGES_REQUESTED" || s.otherFailedChecks?.length) return "warning";
  if (s.draft) return "draft";
  return s.reviewDecision === "APPROVED" ? "approved" : "pending";
}

/** PRs that still need repairs from the agent: conflicts, required checks or review feedback. */
export function needsRepair(pr: Pr): boolean {
  const s = pr.snapshot;
  return !pr.error && !!s?.complete && s.state === "OPEN" && !s.draft && (s.conflict || s.failedChecks.length > 0 || s.threads.length > 0 || s.reviewDecision === "CHANGES_REQUESTED");
}

function depth(prs: Pr[], p: Pr, seen = new Set<string>()): number {
  if (seen.has(p.key)) return 0;
  seen.add(p.key);
  const parent = prs.find(x => x.key === p.parent);
  return parent ? depth(prs, parent, seen) + 1 : 0;
}
/** Parents before children, then by number: the order a stack merges in. */
export function stackOrder(prs: Pr[]): Pr[] {
  return [...prs].sort((a, b) => depth(prs, a) - depth(prs, b) || a.number - b.number);
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

const pendingSends = (w: Workspace) => w.batches.filter(b => !recoveryBatch(b) && b.state === "pending");
const openBatches = (w: Workspace) => w.batches.filter(b => !recoveryBatch(b) && ["sending", "sent", "blocked", "uncertain"].includes(b.state));
const QUEUED = ["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"];

/** Snapshot-only merge readiness. Pr controls add the browser's live "merging" read on top. */
export function mergeReady(pr: Pr, w: Pick<Workspace, "prActions">, now = Date.now()): boolean {
  const s = pr.snapshot;
  const queued = QUEUED.includes(s?.graphiteMergeStatus ?? "");
  const recentlySubmitted = w.prActions.some(a => a.kind === "merge" && a.state === "submitted" && a.heads[pr.key] === s?.head && now - Date.parse(a.createdAt) < 30_000);
  return !pr.error && !!s?.complete && s.state === "OPEN" && s.reviewDecision === "APPROVED" && !s.draft && !s.conflict && !s.failedChecks.length && !s.checksPending && !queued && !recentlySubmitted;
}
export const mergeQueued = (pr: Pr) => QUEUED.includes(pr.snapshot?.graphiteMergeStatus ?? "");

/** Why a pending batch cannot be sent right now, or null when Send is available. Mirrors the server's guards. */
export function sendBlocker(w: Workspace, batch: Batch): string | null {
  if (w.hold) return "Resume follow-up first";
  if (w.runtimeBusy) return "Sends after the agent's current turn";
  if (w.runtimeReason) return w.runtimeReason;
  if (w.batches.some(other => other.id !== batch.id && ["sending", "sent", "blocked", "uncertain"].includes(other.state))) return "Another batch is still open";
  return null;
}

export type NeedItem =
  | { kind: "hold"; key: string; title: string; detail: string }
  | { kind: "retry"; key: string; batchId: string; title: string; detail: string; exhausted: boolean }
  | { kind: "send"; key: string; batchId: string; title: string; tasks: string[]; blocker: string | null }
  | { kind: "decision"; key: string; obligationId: string; title: string; detail: string }
  | { kind: "question"; key: string; questionId: string; title: string; detail: string; state: QuestionState; big: string | null }
  | { kind: "answer"; key: string; questionId: string; title: string; detail: string }
  | { kind: "check"; key: string; actionId: string; title: string; detail: string }
  | { kind: "merge"; key: string; prKey: string; number: number; title: string; detail: string }
  | { kind: "reviewers"; key: string; prKey: string; number: number; title: string; detail: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything waiting on the developer, most urgent first. Each item has exactly one action. */
export function needsYou(w: Workspace, now = Date.now()): NeedItem[] {
  if (!w.enable_tracking || w.archived) return [];
  const items: NeedItem[] = [];
  const questions = w.questions ?? [];
  // A question that stopped the agent outranks everything: nothing moves until it's answered.
  const open = questions.filter(questionOpen);
  for (const q of open.filter(q => questionState(q) === "stopped")) items.push({ kind: "question", key: `question:${q.id}`, questionId: q.id, title: `${q.id} · ${q.title}`, detail: q.question, state: "stopped", big: q.big });
  if (w.hold) items.push({ kind: "hold", key: "hold", title: "Follow-up is paused", detail: w.hold });
  for (const b of w.batches.filter(b => !recoveryBatch(b) && ["blocked", "uncertain"].includes(b.state))) {
    items.push({ kind: "retry", key: `retry:${b.id}`, batchId: b.id, exhausted: b.attempts >= 3,
      title: b.state === "uncertain" ? "Check whether the repairs arrived" : "The repairs didn't finish",
      detail: b.result || (b.state === "uncertain" ? "Delivery wasn't confirmed." : "The main agent reported a blocker.") });
  }
  for (const a of w.prActions.filter(a => a.state === "uncertain")) {
    const numbers = a.prs.map(key => `#${key.split("#")[1]}`).join(", ");
    items.push({ kind: "check", key: `check:${a.id}`, actionId: a.id, title: `Check the ${a.kind === "merge" ? "merge" : a.kind === "request_reviewers" ? "reviewer request" : "merge-when-ready change"} on ${numbers}`, detail: a.result });
  }
  // Answers Paseo didn't confirm need a look before anything is sent again.
  for (const q of questions.filter(q => q.answer?.delivery.state === "unconfirmed"))
    items.push({ kind: "answer", key: `answer:${q.id}`, questionId: q.id, title: `Check that the agent got your ${q.id} answer`, detail: q.answer!.delivery.reason ?? "Paseo didn't confirm the message." });
  for (const q of open.filter(q => questionState(q) !== "stopped")) items.push({ kind: "question", key: `question:${q.id}`, questionId: q.id, title: `${q.id} · ${q.title}`, detail: q.question, state: questionState(q), big: q.big });
  // A blocked task is a question once the server mirrors it; until then it still shows as a decision.
  for (const o of followUpObligations(w).filter(o => o.status === "blocked" && !questions.some(q => q.taskId === o.id && q.taskRevision !== null)))
    items.push({ kind: "decision", key: `decision:${o.id}`, obligationId: o.id, title: o.title, detail: o.evidence });
  if (!w.enable_auto_sends) for (const b of pendingSends(w)) {
    items.push({ kind: "send", key: `send:${b.id}`, batchId: b.id, tasks: b.tasks.map(t => t.title), blocker: sendBlocker(w, b),
      title: `${plural(b.tasks.length, "repair")} ready for the main agent` });
  }
  const blocking = (pr: Pr) => w.prActions.some(a => prActionBlocks(a, [pr.key]));
  for (const pr of stackOrder(w.prs)) {
    // Only offer Merge here when Graphite agrees; otherwise the PR sheet explains what is missing.
    if (mergeReady(pr, w, now) && graphiteReady(pr.snapshot?.graphiteMergeStatus) && !blocking(pr)) items.push({ kind: "merge", key: `merge:${pr.key}`, prKey: pr.key, number: pr.number, title: `#${pr.number} is approved`, detail: pr.snapshot!.title });
    else if (noReviewers(pr) && !pr.snapshot!.draft && defaultReviewers(pr.repo).length && !blocking(pr)) items.push({ kind: "reviewers", key: `reviewers:${pr.key}`, prKey: pr.key, number: pr.number, title: `#${pr.number} has no reviewers`, detail: pr.snapshot!.title });
  }
  return items;
}

export type HeadlinePart = { text: string; tone?: "warning" | "danger" | "success" };
/** "2 of 6 PRs merged, 3 need you, 1 to fix": counts that say where the work stands. */
export function headline(w: Workspace, now = Date.now()): HeadlinePart[] {
  const bar = stackBar(w);
  const parts: HeadlinePart[] = [];
  const state = summary(w, now);
  if (state.status === "done") return [{ text: `Done · ${plural(w.prs.length, "PR")} shipped`, tone: "success" }];
  if (!bar.total) parts.push({ text: "No PRs registered yet" });
  else if (bar.merged === bar.total) parts.push({ text: bar.total === 1 ? "PR merged" : `All ${bar.total} PRs merged` });
  else parts.push({ text: `${bar.merged} of ${plural(bar.total, "PR")} merged` });
  const need = needsYou(w, now).length;
  if (need) parts.push({ text: `${need} need${need === 1 ? "s" : ""} you`, tone: "warning" });
  const repair = w.prs.filter(needsRepair).length;
  if (repair) parts.push({ text: `${repair} to fix`, tone: "danger" });
  return parts;
}

export type LiveIcon = "spinner" | "done" | "paused" | "waiting" | "alert" | "idle";
/** What is happening right now, in one line, with the time it started when known. */
export function liveLine(w: Workspace, now = Date.now()): { icon: LiveIcon; text: string; since: string | null } {
  const state = summary(w, now);
  if (state.status === "done") return { icon: "done", text: "Ready to archive", since: w.completion?.declaredAt ?? null };
  if (w.hold) return { icon: "paused", text: "Paused until you resume", since: w.interruption?.at ?? null };
  const stopped = (w.questions ?? []).filter(questionOpen).find(q => questionState(q) === "stopped");
  if (stopped) return { icon: "paused", text: `Main agent stopped until you answer ${stopped.id}`, since: stopped.askedAt };
  const sent = openBatches(w).find(b => ["sending", "sent"].includes(b.state));
  if (sent) {
    const who = sent.recipientAgentId && sent.recipientAgentId !== w.mainAgentId ? "Recovery agent" : "Main agent";
    return { icon: "spinner", text: `${who} is working on ${plural(sent.tasks.length, "repair")}`, since: sent.activityAt ?? sent.sentAt };
  }
  if (w.runtimeReason) return { icon: "waiting", text: w.runtimeReason, since: null };
  const pending = pendingSends(w)[0];
  if (pending && w.enable_auto_sends) return { icon: "waiting", text: `${plural(pending.tasks.length, "repair")} queued · sends when the agent is idle`, since: pending.createdAt };
  if (w.runtimeBusy) return { icon: "spinner", text: "Main agent is working", since: null };
  const working = followUpObligations(w).find(o => o.status === "working");
  if (working) return { icon: "spinner", text: working.title, since: null };
  if (w.prs.some(p => p.error || !p.snapshot?.complete)) return { icon: "alert", text: "Some PR status is unavailable · retrying", since: null };
  if (w.prs.some(p => p.snapshot?.state === "OPEN" && p.snapshot.checksPending)) return { icon: "waiting", text: "Checks are running", since: null };
  if (w.prs.some(p => p.snapshot?.state === "OPEN")) return { icon: "waiting", text: "Waiting on review and merges", since: null };
  return { icon: "idle", text: "Waiting for the main agent to declare Done", since: null };
}

/** The composer pill: absent unless something needs the developer. */
export function pillFor(w: Workspace, now = Date.now()): { label: string; urgent: boolean; count: number } | null {
  const items = needsYou(w, now);
  if (!items.length) return null;
  const urgent = items.some(i => i.kind === "hold" || i.kind === "retry" || i.kind === "check" || i.kind === "answer" || i.kind === "question" && i.state === "stopped");
  if (items.length > 1) return { label: items.every(i => i.kind === "question") ? `${items.length} questions` : `${items.length} need you`, urgent, count: items.length };
  const [item] = items;
  const label = item.kind === "send" ? `Send ${plural(item.tasks.length, "repair")}` : item.kind === "merge" ? `Merge #${item.number}` : item.kind === "reviewers" ? `Reviewers for #${item.number}` : item.kind === "hold" ? "Follow-up paused" : item.kind === "decision" ? "Decision needed" : item.kind === "question" ? `Question ${item.questionId}` : item.kind === "answer" ? `Check ${item.questionId} answer` : item.kind === "retry" ? "Repairs blocked" : "Check PR action";
  return { label, urgent, count: 1 };
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
