import { isOpen, type Question } from "./questions";
import { newestId } from "./sort";
import { activity, activityQuestions, type Activity } from "./activity";
import { activityFields, questionFields } from "./section-search";
import { filterItems, type ItemHit } from "./search";
import { PAGE, TOOL_BUDGET, boundDone, newestFirst, window, type DoneInfo, type HistoryKind } from "./paged";
import { z } from "zod";
import { batchSchema, deploymentSchema, prObjectSchema, snapshotSchema, taskSchema } from "./model";
import { questionSchema } from "./questions";
import { finishedPr, finishedTask, finishedQuestion, finishedBatch, finishedPrAction } from "./finished";
import type { ListPr, ListWorkspace } from "./list";

/**
 * A workspace's history is sent in pages, never whole (invariant pr-scale-lists-batch-not-throw, "every list pages").
 * Questions, sent batches and PR actions only grow; a busy workspace (175 questions, 400 sent batches) made follow.get
 * ~680 KB and its follow.list entry ~515 KB, read on every change. follow.get and follow.list carry what is live in
 * full and the newest `HISTORY_KEPT` settled items of each; the rest is one `follow.activity` page away (the Activity
 * card, which searches every page on the worker). Agent tools read the stored workspace.
 */
export const HISTORY_KEPT = 30;

type Q = Pick<Question, "id" | "askedAt" | "answer" | "closed">;
type B = { sentAt: string | null; settledAt: string | null; createdAt: string; state: string };
type Hist = { questions: readonly Q[]; batches: readonly B[]; prActions: readonly { createdAt: string; state: string }[]; obligations: readonly { status: string; coveredBy?: string; id: string }[] };

const at = (s: string | null | undefined) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : 0; };
const newest = <T>(items: readonly T[], when: (x: T) => number, keep: number) => new Set([...items].sort((a, b) => when(b) - when(a)).slice(0, keep));

/** The workspace with its settled history cut to the newest `keep` of each kind, in its own order. Unchanged (same object) when nothing is cut. */
export function boundHistory<W extends Hist>(w: W, keep = HISTORY_KEPT): W {
  const covers = new Set(w.obligations.filter(o => !finishedTask(o)).flatMap(o => [o.coveredBy, ...w.questions.filter(q => (q as { taskId?: string | null }).taskId === o.id).map(q => q.id)]).filter((x): x is string => !!x));
  const settledQ = w.questions.filter(q => finishedQuestion(q, covers));
  const settledB = w.batches.filter(finishedBatch);
  const settledA = w.prActions.filter(finishedPrAction);
  if (settledQ.length <= keep && settledB.length <= keep && settledA.length <= keep) return w;
  const keptQ = newest(settledQ, q => Math.max(at(q.askedAt), at(q.answer?.at), at(q.closed?.at)), keep);
  const keptB = newest(settledB, b => at(b.settledAt ?? b.sentAt ?? b.createdAt), keep);
  const keptA = newest(settledA, a => at(a.createdAt), keep);
  return {
    ...w,
    questions: w.questions.filter(q => !finishedQuestion(q, covers) || keptQ.has(q)),
    batches: w.batches.filter(b => !finishedBatch(b) || keptB.has(b)),
    prActions: w.prActions.filter(a => !finishedPrAction(a) || keptA.has(a)),
  };
}

export type AgentHistory = Record<HistoryKind, DoneInfo>;
/** One short line, in the tool's own words: how an agent gets what was left out. */
export const HISTORY_HINT = (kind: HistoryKind) => `workspace_status history=${kind} offset/limit pages these (newest first)`;

type AgentW = Hist & { prs: readonly ListPr[]; obligations: readonly { status: string; id: string; coveredBy?: string; finishedAt?: string }[] };

/**
 * workspace_status for an agent (summary and full alike): every live item in full, each finished kind as its newest
 * `PAGE.recentDone` plus a count (`history`), or one page of one kind (`kind` with offset/limit, the others counts only). A busy workspace
 * (350 merged PRs, 400 settled batches) made the summary ~207k characters, over a tool result's limit.
 */
export function agentView<W extends AgentW, X extends object = {}>(w: W, { kind, offset, limit }: { kind?: HistoryKind; offset?: number; limit?: number } = {}, extra?: X, sent: (view: W & X & { history: AgentHistory }) => unknown = view => view): W & X & { history: AgentHistory } {
  // Budget the final sent representation, after summary compaction (invariant 63). Pending work stays whole; when a busy
  // workspace's live items and its finished glance run over, fewer finished items come (a history page shrinks), and
  // `history` says how many were left out. 2026-11-26: scale-live's 153-PR workspace read 52k with five of each kind.
  let recent: number = PAGE.recentDone, size = Math.min(limit ?? PAGE.toolPage, PAGE.maxLimit);
  for (;;) {
    // `extra`: what the reply carries beside the workspace (dismissed items, the next message, the PR workflow), measured with it.
    const view = { ...agentViewOf(w, { kind, offset, limit: size, recent }), ...(extra ?? {}) } as W & X & { history: AgentHistory };
    if (JSON.stringify(sent(view)).length <= TOOL_BUDGET || (kind ? size <= 1 : recent <= 0)) return view;
    if (kind) size = Math.max(1, Math.floor(size / 2)); else recent--;
  }
}

function agentViewOf<W extends AgentW>(w: W, { kind, offset, limit, recent }: { kind?: HistoryKind; offset?: number; limit: number; recent: number }): W & { history: AgentHistory } {
  const covers = new Set(w.obligations.filter(o => !finishedTask(o)).flatMap(o => [o.coveredBy, ...w.questions.filter(q => (q as { taskId?: string | null }).taskId === o.id).map(q => q.id)]).filter((x): x is string => !!x));
  // A history page carries that kind's page; the other kinds' finished items are counts only on that call.
  const page = (k: HistoryKind) => k === kind ? { offset: offset ?? 0, limit } : kind ? { recent: 0 } : { recent };
  const done = {
    prs: finishedPr, tasks: finishedTask,
    questions: (q: Q) => finishedQuestion(q, covers), batches: finishedBatch, prActions: finishedPrAction,
  };
  const prs = boundDone(w.prs, done.prs, { newestFirst: newestFirst(w.prs, p => at(p.snapshot?.mergedAt ?? p.snapshot?.observedAt)), hint: HISTORY_HINT("prs"), ...page("prs") });
  const tasks = boundDone(w.obligations, done.tasks, { newestFirst: newestFirst(w.obligations, o => at(o.finishedAt)), hint: HISTORY_HINT("tasks"), ...page("tasks") });
  const questions = boundDone(w.questions, done.questions, { newestFirst: newestFirst(w.questions, q => Math.max(at(q.askedAt), at(q.answer?.at), at(q.closed?.at))), hint: HISTORY_HINT("questions"), ...page("questions") });
  const batches = boundDone(w.batches, done.batches, { newestFirst: newestFirst(w.batches, b => at(b.settledAt ?? b.sentAt ?? b.createdAt)), hint: HISTORY_HINT("batches"), ...page("batches") });
  const prActions = boundDone(w.prActions, done.prActions, { newestFirst: newestFirst(w.prActions, a => at(a.createdAt)), hint: HISTORY_HINT("prActions"), ...page("prActions") });
  // The newest few finished items are a glance; history pages carry them whole. Delivered answers retained
  // for live tasks are compact context too: keep the answer and task link, without old options/background.
  // Pending delivery is never compacted.
  const glance = <T>(k: HistoryKind, items: T[], isDone: (x: T) => boolean): T[] => k === kind ? items : items.map(x => isDone(x) ? BRIEF_DONE[k](x as Record<string, any>) as T : x);
  const inventory = (w as { inventory?: { candidates?: string[] } | null }).inventory;
  return { ...w,
    prs: glance("prs", prs.items, done.prs), obligations: glance("tasks", tasks.items, done.tasks), questions: glance("questions", questions.items, done.questions).map(q => !done.questions(q) && finishedQuestion(q) ? BRIEF_DONE.questions(q) as typeof q : q),
    batches: glance("batches", batches.items, done.batches), prActions: glance("prActions", prActions.items, done.prActions),
    // Every PR key the inventory ever considered grows with the workspace: the live PRs' keys, and how many there were.
    ...(inventory?.candidates ? { inventory: { ...inventory, candidates: inventory.candidates.filter(k => w.prs.some(p => p.key === k && !finishedPr(p))), candidatesTotal: inventory.candidates.length } } : {}),
    history: { prs: prs.done, tasks: tasks.done, questions: questions.done, batches: batches.done, prActions: prActions.done } };
}

/**
 * A finished item at a glance: what it was and how it ended, without its evidence (a merged PR's checks and reviewers, a
 * settled question's options and background, a batch's task fingerprints), marked `glance: true`; history=<kind> pages
 * them whole. Each shape is picked from the stored item's own schema, and follow.agent-status's contract takes either
 * (shared/contracts.ts), so what agentView builds and what the RPC validates are one definition.
 */
const glance = z.literal(true);
export const prGlanceSchema = prObjectSchema.pick({ key: true, repo: true, number: true, stack: true, parent: true, disposition: true }).extend({
  snapshot: snapshotSchema.pick({ title: true, url: true, state: true, mergedAt: true, observedAt: true, mergeCommit: true })
    .extend({ deployment: deploymentSchema.pick({ state: true, environment: true }).nullable().optional() }).nullable(),
  glance,
});
export const questionGlanceSchema = questionSchema.pick({ id: true, title: true, prKey: true, taskId: true, askedBy: true, askedAt: true, mode: true, answer: true, closed: true }).extend({ glance });
export const batchGlanceSchema = batchSchema.pick({ id: true, state: true, createdAt: true, sentAt: true, settledAt: true, result: true, recipientAgentId: true })
  .extend({ tasks: z.array(taskSchema.pick({ key: true, kind: true, target: true, title: true })), glance });
/** The glance of one item; an item its glance schema can't read (an older record) comes whole, which the contract takes too. */
const brief = (schema: z.ZodTypeAny) => (x: Record<string, unknown>) => { const r = schema.safeParse({ ...x, glance: true }); return r.success ? r.data : x; };
const BRIEF_DONE: Record<HistoryKind, (x: Record<string, any>) => unknown> = {
  prs: brief(prGlanceSchema),
  tasks: o => o,
  questions: brief(questionGlanceSchema),
  batches: brief(batchGlanceSchema),
  prActions: a => a,
};

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
