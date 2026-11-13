import { z } from "zod";
import { batchSchema, deploymentSchema, obligationSchema, prObjectSchema, snapshotSchema, workspaceSchema, type Workspace } from "./model";
import { questionSchema } from "./questions";

/**
 * What follow.list and the workspaces feed carry: each followed workspace as the list views draw it (Home, the pill,
 * the sidebar count, header dots, search), never its detail. Invariant a-list-carries-only-what-lists-draw.
 *
 * 2026-11-13 (live 2.0.1-beta.4, 139 followed workspaces): a full follow.list answer was 1.41 MB, and a burst of them
 * stepped the worker's RSS 204 → 236 MB. Most of it was detail only the panel, the PR sheet and agent tools read:
 * deployment evidence, inventory, task evidence, question background, settled batch results, and archived
 * workspaces in full although search only reads their title and PRs. The detail stays one follow.get away
 * (client/workspace-data.ts useWorkspace), and agent tools read the stored workspace on the worker.
 *
 * Each schema below is the stored one minus named fields, so a new stored field reaches the lists by default and
 * the budget test (tests/list-reply-budget.test.ts) says when the list outgrows LIST_REPLY_BUDGET_KB. The types
 * are the enforcement: a list view takes a ListWorkspace, so reading a dropped field there doesn't compile.
 */
const DEPLOYMENT_DETAIL = { evidence: true, commits: true } as const;
const SNAPSHOT_DETAIL = { base: true, trunk: true, headBranch: true, repoMerge: true } as const;
const PR_DETAIL = { discoveredFromSubmission: true } as const;
const OBLIGATION_DETAIL = { evidence: true, previousTitles: true } as const;
const BATCH_DETAIL = { contextPath: true, recoveryHandoffs: true, acknowledgmentError: true } as const;
const QUESTION_DETAIL = { background: true, links: true } as const;
const WORKSPACE_DETAIL = { inventory: true, excludedStacks: true, nextMessage: true } as const;

/**
 * What only an open PR's line reads. A merged PR is terminal: its list form keeps identity, title, url, when it merged
 * and its deploy state (stack bars, "N merged below", deploy waits, search), never its checks, threads or reviewers.
 * Optional in the list type, so a list view that reads one must handle a merged PR without it.
 */
const OPEN_ONLY = { head: true, draft: true, graphiteMergeStatus: true, conflict: true, reviewDecision: true, reviewers: true, mergeWhenReady: true, threads: true, failedChecks: true, otherFailedChecks: true, checksPending: true, checksRunning: true, mergeStateStatus: true, inMergeQueue: true } as const;
export const listSnapshotSchema = snapshotSchema.omit(SNAPSHOT_DETAIL).partial(OPEN_ONLY).extend({
  deployment: deploymentSchema.omit(DEPLOYMENT_DETAIL).nullable().optional(),
  // Defaulted in the stored schema; a merged PR's list form leaves them out, so parsing mustn't put them back.
  graphiteMergeStatus: z.string().nullable().optional(), mergeWhenReady: z.enum(["on", "off", "unknown"]).optional(),
});
export const listPrSchema = prObjectSchema.omit(PR_DETAIL).extend({ snapshot: listSnapshotSchema.nullable() });
export const listBatchSchema = batchSchema.omit(BATCH_DETAIL).extend({});
export const listQuestionSchema = questionSchema.omit(QUESTION_DETAIL);
export const listWorkspaceSchema = workspaceSchema.omit(WORKSPACE_DETAIL).extend({
  // A task's evidence goes out only while it's blocked: the list line reads "Blocked · waits for Q1" from it (shared/task-status.ts blockedLine).
  prs: z.array(listPrSchema), obligations: z.array(obligationSchema.omit(OBLIGATION_DETAIL).extend({ evidence: obligationSchema.shape.evidence.optional() })), batches: z.array(listBatchSchema),
  questions: z.array(listQuestionSchema).default([]),
});
/** An archived workspace, only for search ("Archived" at the bottom of results): its name and its PRs' numbers, titles and stacks. */
export const archivedListWorkspaceSchema = z.object({
  id: workspaceSchema.shape.id, title: workspaceSchema.shape.title, updatedAt: z.string(), archived: z.literal(true), enable_tracking: z.boolean(),
  prs: z.array(z.object({ key: z.string(), number: z.number(), stack: z.string(), snapshot: z.object({ title: z.string() }).nullable() })),
});
export const listEntrySchema = z.union([listWorkspaceSchema, archivedListWorkspaceSchema]);

export type ListWorkspace = z.infer<typeof listWorkspaceSchema>;
export type ArchivedListWorkspace = z.infer<typeof archivedListWorkspaceSchema>;
export type ListEntry = ListWorkspace | ArchivedListWorkspace;
export const isArchivedEntry = (w: ListEntry): w is ArchivedListWorkspace => w.archived;

const drop = <T extends object, K extends string>(value: T, keys: Readonly<Record<K, true>>): Omit<T, K> => {
  const out = { ...value } as Record<string, unknown>;
  for (const k of Object.keys(keys)) delete out[k];
  return out as Omit<T, K>;
};

/** The list form of one stored workspace. Pure; ListCache keeps one per saved workspace object, so an unchanged workspace isn't projected again. */
export function listEntry(w: Workspace): ListEntry {
  if (w.archived) return { id: w.id, title: w.title, updatedAt: w.updatedAt, archived: true, enable_tracking: w.enable_tracking,
    prs: w.prs.map(p => ({ key: p.key, number: p.number, stack: p.stack, snapshot: p.snapshot ? { title: p.snapshot.title } : null })) };
  return {
    ...drop(w, WORKSPACE_DETAIL),
    prs: w.prs.map(p => ({ ...drop(p, PR_DETAIL), snapshot: p.snapshot && {
      ...drop(p.snapshot.state === "MERGED" && p.snapshot.complete ? drop(p.snapshot, OPEN_ONLY) : p.snapshot, SNAPSHOT_DETAIL),
      ...(p.snapshot.deployment !== undefined ? { deployment: p.snapshot.deployment && drop(p.snapshot.deployment, DEPLOYMENT_DETAIL) } : {}),
    } })),
    obligations: w.obligations.map(o => o.status === "blocked" ? { ...drop(o, OBLIGATION_DETAIL), evidence: o.evidence } : drop(o, OBLIGATION_DETAIL)),
    batches: w.batches.map(b => drop(b, BATCH_DETAIL)),
    questions: w.questions.map(q => drop(q, QUESTION_DETAIL)),
  };
}

export type ListPr = ListWorkspace["prs"][number];
export type ListSnapshot = NonNullable<ListPr["snapshot"]>;
export type ListObligation = ListWorkspace["obligations"][number];
export type ListBatch = ListWorkspace["batches"][number];
export type ListQuestion = ListWorkspace["questions"][number];
