import { z } from "zod";
import { batchSchema, deploymentSchema, obligationSchema, prObjectSchema, snapshotSchema, workspaceSchema, type Workspace } from "./model";
import { isOpen, questionSchema } from "./questions";
import { boundHistory } from "./history";

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
// repoMerge stays: Home's Merge button reads it to say "Add to merge queue" (shared/merge-click.ts mergeScope).
const SNAPSHOT_DETAIL = { base: true, trunk: true, headBranch: true } as const;
const PR_DETAIL = { discoveredFromSubmission: true } as const;
const OBLIGATION_DETAIL = { evidence: true, previousTitles: true, createdBy: true } as const;
const BATCH_DETAIL = { contextPath: true, recoveryHandoffs: true, acknowledgmentError: true } as const;
const QUESTION_DETAIL = { background: true, links: true } as const;
const WORKSPACE_DETAIL = { inventory: true, excludedStacks: true, nextMessage: true } as const;

/**
 * What only an open PR's line reads. A merged PR is terminal: its list form keeps identity, title, url, when it merged
 * and its deploy state (stack bars, "N more merged", deploy waits, search), never its checks, threads or reviewers.
 * Optional in the list type, so a list view that reads one must handle a merged PR without it.
 */
const OPEN_ONLY = { head: true, draft: true, graphiteMergeStatus: true, conflict: true, reviewDecision: true, reviewers: true, mergeWhenReady: true, threads: true, failedChecks: true, otherFailedChecks: true, checksPending: true, checksRunning: true, mergeStateStatus: true, inMergeQueue: true } as const;
export const listSnapshotSchema = snapshotSchema.omit(SNAPSHOT_DETAIL).partial(OPEN_ONLY).extend({
  // Read stamps travel apart from the entry (splitReadStamps, read-stamps-never-count): optional on the wire, filled
  // back in by the client store before any reader sees the entry.
  observedAt: snapshotSchema.shape.observedAt.optional(),
  deployment: deploymentSchema.omit(DEPLOYMENT_DETAIL).extend({ observedAt: deploymentSchema.shape.observedAt.optional() }).nullable().optional(),
  // Defaulted in the stored schema; a merged PR's list form leaves them out, so parsing mustn't put them back.
  graphiteMergeStatus: z.string().nullable().optional(), mergeWhenReady: z.enum(["on", "off", "unknown"]).optional(),
});
export const listPrSchema = prObjectSchema.omit(PR_DETAIL).extend({ snapshot: listSnapshotSchema.nullable() });
export const listBatchSchema = batchSchema.omit(BATCH_DETAIL).extend({});
// An open question keeps its background and links: Needs you shows it inline (client/questions.tsx QuestionBody).
export const listQuestionSchema = questionSchema.omit(QUESTION_DETAIL).extend({ background: questionSchema.shape.background.unwrap().optional(), links: questionSchema.shape.links.unwrap().optional() });
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
export function listEntry(whole: Workspace): ListEntry {
  // Settled history beyond the newest few goes out only as follow.activity pages (shared/history.ts).
  const w = boundHistory(whole);
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
    questions: w.questions.map(q => isOpen(q) ? q : drop(q, QUESTION_DETAIL)),
  };
}

export type ListPr = ListWorkspace["prs"][number];
export type ListSnapshot = NonNullable<ListPr["snapshot"]>;
export type ListObligation = ListWorkspace["obligations"][number];
export type ListBatch = ListWorkspace["batches"][number];
export type ListQuestion = ListWorkspace["questions"][number];

/**
 * Read-time stamps (read-stamps-never-count, invariant 140): when Follow-up last read a PR (`snapshot.observedAt`) and
 * its deploy target (`snapshot.deployment.observedAt`). Every GitHub probe moves them, so inside a list entry they made
 * every poll a change: the workspaces feed resent whole workspaces (2026-11-27, live-sized seed: 342 KB every ~15 s,
 * the 153-PR workspace's entry alone 317 KB, and all 140 workspaces, 2 MB, about once a minute) and every client
 * rebuilt Home and re-rendered its panel for nothing it could see. ListCache splits them off: the entry it diffs and
 * sends has none, and the stamps ride beside it (`reads`), stamps-only at most once per READS_PUSH_MS. The client
 * store puts them back (withReadStamps), so readers (deployState's freshness, Home's "GitHub" source line) keep them.
 */
export const readStampsSchema = z.record(z.string(), z.record(z.string(), z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])])));
export type ReadStamps = Record<string, [observed: string, deployment?: string]>;
/** How often a feed sends stamps that changed while nothing else did: inside DEPLOY_FRESH_MS (2 min) with a tick to spare. */
export const READS_PUSH_MS = 60_000;

/** The entry without its read stamps, and the stamps (null when it has none, e.g. archived or no PR read yet). */
export function splitReadStamps(entry: ListEntry): { bare: ListEntry; stamps: ReadStamps | null } {
  if (isArchivedEntry(entry)) return { bare: entry, stamps: null };
  let stamps: ReadStamps | null = null;
  const prs = entry.prs.map(p => {
    const s = p.snapshot;
    if (!s || (s.observedAt === undefined && s.deployment?.observedAt === undefined)) return p;
    (stamps ??= {})[p.key] = s.deployment?.observedAt !== undefined ? [s.observedAt ?? "", s.deployment.observedAt] : [s.observedAt ?? ""];
    const { observedAt: _o, deployment, ...rest } = s;
    const bare = deployment ? (({ observedAt: _d, ...d }) => d)(deployment) : deployment;
    return { ...p, snapshot: deployment !== undefined ? { ...rest, deployment: bare } : rest };
  });
  return { bare: stamps ? { ...entry, prs } : entry, stamps };
}

/** The entry with its read stamps back (the client store, before any reader sees it). Unknown keys are ignored. */
/**
 * A full workspace (follow.get) with the list copy's read stamps where they are newer: the open view's "Checked" line
 * follows the feed's stamps without reading the whole workspace again (invariant 150). Same object when none is newer.
 */
export function newerReadStamps<W extends { prs: { key: string; snapshot?: { observedAt?: string; deployment?: { observedAt?: string } | null } | null }[] }>(full: W, stamps: ReadStamps | null | undefined): W {
  if (!stamps) return full;
  let moved = false;
  const prs = full.prs.map(p => {
    const st = stamps[p.key]; const s = p.snapshot;
    if (!st || !s) return p;
    const observed = st[0] && (!s.observedAt || st[0] > s.observedAt) ? st[0] : undefined;
    const deployed = s.deployment && st[1] && (!s.deployment.observedAt || st[1] > s.deployment.observedAt) ? st[1] : undefined;
    if (!observed && !deployed) return p;
    moved = true;
    return { ...p, snapshot: { ...s, ...(observed ? { observedAt: observed } : {}), ...(deployed ? { deployment: { ...s.deployment, observedAt: deployed } } : {}) } };
  });
  return moved ? { ...full, prs } : full;
}

export function withReadStamps<E extends ListEntry>(entry: E, stamps: ReadStamps | null | undefined): E {
  if (!stamps || isArchivedEntry(entry)) return entry;
  return { ...entry, prs: (entry as ListWorkspace).prs.map(p => {
    const st = stamps[p.key]; const s = p.snapshot;
    if (!st || !s) return p;
    return { ...p, snapshot: { ...s, ...(st[0] ? { observedAt: st[0] } : {}), ...(s.deployment && st[1] !== undefined ? { deployment: { ...s.deployment, observedAt: st[1] } } : {}) } };
  }) } as E;
}
