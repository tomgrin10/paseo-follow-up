import { isOpen, answerStatus } from "./questions";
import { newestId } from "./sort";
import { activity, activityQuestions, type Activity } from "./activity";
import { activityFields, questionFields } from "./section-search";
import { filterItems, type ItemHit } from "./search";
import { PAGE, boundDone, newestFirst, window, type DoneInfo, type HistoryKind } from "./paged";
import { settled } from "./model";
import type { ListWorkspace } from "./list";

/**
 * A workspace's history is sent in pages, never whole (invariant pr-scale-lists-batch-not-throw, "every list pages").
 * Questions, sent batches and PR actions only grow; a busy workspace (175 questions, 400 sent batches) made follow.get
 * ~680 KB and its follow.list entry ~515 KB, read on every change. follow.get and follow.list carry what is live in
 * full and the newest `HISTORY_KEPT` settled items of each; the rest is one `follow.activity` page away (the Activity
 * card, which searches every page on the worker). Agent tools read the stored workspace.
 */
export const HISTORY_KEPT = 30;

type Q = { id: string; askedAt: string; answer: { at: string; delivery: { state: string } } | null; closed: { at: string } | null };
type B = { sentAt: string | null; settledAt: string | null; createdAt: string; state: string };
type Hist = { questions: readonly Q[]; batches: readonly B[]; prActions: readonly { createdAt: string; state: string }[]; obligations: readonly { status: string; coveredBy?: string; id: string }[] };

const at = (s: string | null | undefined) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : 0; };
const newest = <T>(items: readonly T[], when: (x: T) => number, keep: number) => new Set([...items].sort((a, b) => when(b) - when(a)).slice(0, keep));

/** Whether a question still matters to a surface outside Activity: open, an answer not yet delivered, or a live task's cover. */
function liveQuestion(q: Q, covers: ReadonlySet<string>): boolean {
  return isOpen(q as never) || !answerStatus(q as never)?.delivered || covers.has(q.id);
}
const liveBatch = (b: B) => !b.settledAt || !["completed", "blocked", "cancelled"].includes(b.state);

/** The workspace with its settled history cut to the newest `keep` of each kind, in its own order. Unchanged (same object) when nothing is cut. */
export function boundHistory<W extends Hist>(w: W, keep = HISTORY_KEPT): W {
  const covers = new Set(w.obligations.filter(o => o.status !== "done" && o.status !== "waived").flatMap(o => [o.coveredBy, ...w.questions.filter(q => (q as { taskId?: string | null }).taskId === o.id).map(q => q.id)]).filter((x): x is string => !!x));
  const settledQ = w.questions.filter(q => !liveQuestion(q, covers));
  const settledB = w.batches.filter(b => !liveBatch(b));
  const settledA = w.prActions.filter(a => a.state !== "sending");
  if (settledQ.length <= keep && settledB.length <= keep && settledA.length <= keep) return w;
  const keptQ = newest(settledQ, q => Math.max(at(q.askedAt), at(q.answer?.at), at(q.closed?.at)), keep);
  const keptB = newest(settledB, b => at(b.settledAt ?? b.sentAt ?? b.createdAt), keep);
  const keptA = newest(settledA, a => at(a.createdAt), keep);
  return {
    ...w,
    questions: w.questions.filter(q => liveQuestion(q, covers) || keptQ.has(q)),
    batches: w.batches.filter(b => liveBatch(b) || keptB.has(b)),
    prActions: w.prActions.filter(a => a.state === "sending" || keptA.has(a)),
  };
}

export type AgentHistory = Record<HistoryKind, DoneInfo>;
/** One short line, in the tool's own words: how an agent gets what was left out. */
export const HISTORY_HINT = (kind: HistoryKind) => `workspace_status history=${kind} offset/limit pages these (newest first)`;

type AgentW = Hist & { prs: readonly Parameters<typeof settled>[0][]; obligations: readonly { status: string; id: string; coveredBy?: string; finishedAt?: string }[] };

/**
 * workspace_status for an agent (summary and full alike): every live item in full, each finished kind as its newest
 * `PAGE.recentDone` plus a count (`history`), or one page of one kind (`kind` with offset/limit, the others counts only). A busy workspace
 * (350 merged PRs, 400 settled batches) made the summary ~207k characters, over a tool result's limit.
 */
export function agentView<W extends AgentW>(w: W, { kind, offset, limit }: { kind?: HistoryKind; offset?: number; limit?: number } = {}): W & { history: AgentHistory } {
  const covers = new Set(w.obligations.filter(o => o.status !== "done" && o.status !== "waived").flatMap(o => [o.coveredBy, ...w.questions.filter(q => (q as { taskId?: string | null }).taskId === o.id).map(q => q.id)]).filter((x): x is string => !!x));
  // A history page carries that kind's page; the other kinds' finished items are counts only on that call.
  const page = (k: HistoryKind) => k === kind ? { offset: offset ?? 0, limit } : kind ? { recent: 0 } : {};
  const prs = boundDone(w.prs, settled, { newestFirst: newestFirst(w.prs, p => at(p.snapshot?.mergedAt ?? p.snapshot?.observedAt)), hint: HISTORY_HINT("prs"), ...page("prs") });
  const tasks = boundDone(w.obligations, o => o.status === "done" || o.status === "waived", { newestFirst: newestFirst(w.obligations, o => at(o.finishedAt)), hint: HISTORY_HINT("tasks"), ...page("tasks") });
  const questions = boundDone(w.questions, q => !liveQuestion(q, covers), { newestFirst: newestFirst(w.questions, q => Math.max(at(q.askedAt), at(q.answer?.at), at(q.closed?.at))), hint: HISTORY_HINT("questions"), ...page("questions") });
  const batches = boundDone(w.batches, b => !liveBatch(b), { newestFirst: newestFirst(w.batches, b => at(b.settledAt ?? b.sentAt ?? b.createdAt)), hint: HISTORY_HINT("batches"), ...page("batches") });
  const prActions = boundDone(w.prActions, a => a.state !== "sending", { newestFirst: newestFirst(w.prActions, a => at(a.createdAt)), hint: HISTORY_HINT("prActions"), ...page("prActions") });
  return { ...w, prs: prs.items, obligations: tasks.items, questions: questions.items, batches: batches.items, prActions: prActions.items,
    history: { prs: prs.done, tasks: tasks.done, questions: questions.done, batches: batches.done, prActions: prActions.done } };
}

export type ActivityTab = "timeline" | "questions";
export type ActivityPage<Qn> = {
  tab: ActivityTab;
  timeline: { row: Activity; hit: ItemHit | null }[];
  questions: { question: Qn; hit: ItemHit | null }[];
  offset: number; total: number;
  /** Each tab's count: every row, or its matches while searching. */
  counts: { timeline: number; questions: number };
  /** Every row the card holds (both tabs), for "n of N" while searching. */
  all: number;
};

/**
 * One page of the Activity card, from the stored workspace: the timeline (`activity`) or the questions tab
 * (`activityQuestions`, open first, then newest), searched with the same matcher the card's search uses (`filterItems`)
 * across every row, then cut to [offset, offset + limit).
 */
export function activityPage<W extends ListWorkspace>(w: W, { tab, query, offset = 0, limit = PAGE.size }: { tab: ActivityTab; query?: string | null; offset?: number; limit?: number }): ActivityPage<W["questions"][number]> {
  type Qn = W["questions"][number];
  const rows = activity(w);
  const qs = activityQuestions(w.questions as Qn[]).sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || newestId(a.id, b.id));
  const found = query?.trim() ? {
    timeline: (filterItems(rows, activityFields, query) ?? []).map(r => ({ row: r.item, hit: r.hit as ItemHit | null })),
    questions: (filterItems(qs, q => questionFields(q as never), query) ?? []).map(r => ({ question: r.item, hit: r.hit as ItemHit | null })),
  } : { timeline: rows.map(row => ({ row, hit: null })), questions: qs.map(question => ({ question, hit: null })) };
  const list = tab === "timeline" ? found.timeline : found.questions;
  const page = window<unknown>(list, offset, limit);
  return {
    tab,
    timeline: tab === "timeline" ? page.items as ActivityPage<Qn>["timeline"] : [],
    questions: tab === "questions" ? page.items as ActivityPage<Qn>["questions"] : [],
    offset: page.offset, total: page.total,
    counts: { timeline: found.timeline.length, questions: found.questions.length },
    all: rows.length + qs.length,
  };
}
