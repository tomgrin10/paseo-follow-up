import { checksState } from "./pr-status";
import { z } from "zod";
import { idSchema, textSchema } from "./model";
import type { ListPr as Pr, ListSnapshot as Snapshot, ListWorkspace as Workspace } from "./list";

export const prActionKind = z.enum(["merge", "enable_mwr", "disable_mwr"]);
export const actionPrSchema = z.object({ key: idSchema, repo: z.string(), number: z.number(), title: z.string(), head: z.string(), parent: idSchema.nullable(), base: z.string(), trunk: z.string(), blockers: z.array(z.string()) });
/** `via` and `method` (GitHub mode): who merges, and with which merge method, so the confirmation can say so. */
export const actionPlanSchema = z.object({ id: idSchema, workspaceId: idSchema, target: idSchema, kind: prActionKind, expiresAt: z.string(), prs: z.array(actionPrSchema), blockers: z.array(z.string()), via: z.enum(["graphite", "github"]).optional(), method: z.enum(["squash", "merge", "rebase"]).optional(), mergeQueue: z.boolean().optional() });
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type PrActionKind = z.infer<typeof prActionKind>;

export const browserPrSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), head: z.string().min(1), state: z.enum(["OPEN", "MERGED", "CLOSED"]), mergeWhenReady: z.boolean(), merging: z.boolean() });
export type BrowserPr = z.infer<typeof browserPrSchema>;
/**
 * The most PRs one browser exchange command (and its result) carries: a DoS bound on the untrusted browser side, which
 * the Send to Paseo extension enforces too. A longer stack goes as several commands of at most this many
 * (`browserBatches`), never as one that fails the schema (invariant pr-scale-lists-batch-not-throw).
 */
export const BROWSER_BATCH = 50;
/** `items` in order, as consecutive slices of at most `size`. */
export function browserBatches<T>(items: readonly T[], size = BROWSER_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
/**
 * PR numbers for a sentence: the first `shown`, then "+N more", so a long stack never grows a result past its text cap
 * (invariant pr-scale-lists-batch-not-throw). `prRefs([1, 2, 3], 2)` is "#1, #2 +1 more".
 */
export function prRefs(numbers: readonly (number | string)[], shown = 8): string {
  const head = numbers.slice(0, shown).map(n => `#${n}`).join(", ");
  return numbers.length > shown ? `${head} +${numbers.length - shown} more` : head;
}
export const browserCommandSchema = z.object({ id: idSchema, nonce: idSchema, expiresAt: z.string(), op: z.enum(["read", "enable_mwr", "disable_mwr"]), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), prs: z.array(z.object({ number: z.number().int().positive(), head: z.string(), trunk: z.string() })).min(1).max(BROWSER_BATCH) });
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export const browserResultSchema = z.object({ id: idSchema, nonce: idSchema, outcome: z.enum(["completed", "failed", "uncertain"]), prs: z.array(browserPrSchema).max(BROWSER_BATCH).default([]), applied: z.array(z.number().int().positive()).max(BROWSER_BATCH).default([]), error: z.string().max(500).default("") });
export type BrowserResult = z.infer<typeof browserResultSchema>;
export const browserExchangeSchema = z.object({ clientId: idSchema, ready: z.boolean(), acceptJobs: z.boolean().default(true), results: z.array(browserResultSchema).max(10).default([]), repositories: z.array(browserPrSchema.shape.repo).max(100).default([]) });
export const browserStatusSchema = z.object({ ready: z.boolean(), reason: z.string().nullable() });
/**
 * `merge`, on a submitted merge only: how far it got. "merged" (GitHub merged every PR), "queued" (the merge queue took
 * the bottom PR), "requested" (Graphite took the request; its result comes later). Absent: nothing claims a merge.
 */
export const mergeStageSchema = z.enum(["merged", "queued", "requested"]);
export type MergeStage = z.infer<typeof mergeStageSchema>;
export const actionResultSchema = z.object({ state: z.enum(["submitted", "failed", "uncertain"]), result: textSchema, merge: mergeStageSchema.optional() });

/**
 * For every PR at once: the lowest unmerged PR under it (its downstack, the PRs one click would merge with it) that
 * fails `ok`, null when all pass, or "unreadable" where `downstack` would throw (a cycle, a gap, another repository).
 * One pass over the stack with memoised answers, so asking it of every PR stays linear in the workspace (invariant
 * a-check-costs-linear-in-its-workspace), where calling `downstack` per PR was quadratic and a find per step cubic.
 */
export function downstackScan<P extends Pr>(prs: P[], ok: (p: P) => boolean): (key: string) => P | null | "unreadable" {
  const byKey = new Map<string, P>(); for (const p of prs) if (!byKey.has(p.key)) byKey.set(p.key, p);
  const memo = new Map<string, P | null | "unreadable">();
  return (target: string) => {
    if (memo.has(target)) return memo.get(target)!;
    // Walk down to a known answer or the bottom, then fill the answers back up the chain.
    const chain: P[] = []; const onChain = new Set<string>();
    let key: string | null = target; let base: P | null | "unreadable" = null;
    while (key !== null) {
      if (onChain.has(key)) { base = "unreadable"; break; }
      const pr = byKey.get(key);
      if (!pr || chain.length && pr.repo !== chain.at(-1)!.repo) { base = "unreadable"; break; }
      if (memo.has(key)) {
        // A known PR below: its answer, plus the PR itself (the memo holds what is under it, not the PR).
        const known = memo.get(key)!;
        base = known !== null ? known : pr.snapshot?.state !== "MERGED" && !ok(pr) ? pr : null;
        break;
      }
      chain.push(pr); onChain.add(key); key = pr.parent;
    }
    // A cycle poisons every PR on it, and so does a gap: downstack throws for each of them.
    for (let i = chain.length - 1; i >= 0; i--) {
      const below = chain[i + 1];
      if (base !== "unreadable" && below && base === null && below.snapshot?.state !== "MERGED" && !ok(below)) base = below;
      memo.set(chain[i]!.key, base);
    }
    return memo.get(target) ?? base;
  };
}
export function downstack<P extends Pr>(prs: P[], target: string): P[] {
  const selected: P[] = []; const seen = new Set<string>();
  // One index per call, never a find per step: callers walk every PR's downstack, so a find made a 520-PR stack cubic
  // (2.5 s of one Home build; invariant a-check-costs-linear-in-its-workspace).
  const byKey = new Map<string, P>(); for (const p of prs) if (!byKey.has(p.key)) byKey.set(p.key, p);
  let key: string | null = target; let repo: string | null = null;
  while (key) {
    if (seen.has(key)) throw new Error("This stack has a parent cycle. Reconcile its tracking before merging.");
    seen.add(key);
    const pr = byKey.get(key);
    if (!pr || repo && pr.repo !== repo) throw new Error("A downstack PR is outside this workspace's inventory. Reconcile ownership before merging.");
    repo = pr.repo;
    if (pr.snapshot?.state !== "MERGED") selected.push(pr);
    key = pr.parent;
  }
  return selected.reverse();
}

export const GRAPHITE_READY = ["READY_TO_MERGE", "READY_TO_MERGE_AS_STACK", "READY_TO_MERGE_WITHOUT_CI", "READY_TO_MERGE_AS_STACK_WITHOUT_CI"];
export const graphiteReady = (status: string | null | undefined) => GRAPHITE_READY.includes(status ?? "");
/** Says why Graphite won't merge yet and what to do about it. */
export function graphiteBlocker(status: string | null | undefined): string {
  if (!status) return "Graphite hasn't reported this PR ready to merge. Check the Graphite CLI sign-in on the daemon host, or open the PR in Graphite.";
  return `Graphite says: ${status.toLowerCase().replace(/__/g, ": ").replace(/_/g, " ")}`;
}
/** Snapshots from before workflows existed were Graphite's. */
export const isGithubFlow = (s: Pick<Snapshot, "prWorkflow"> | null | undefined) => s?.prWorkflow === "github";
/** GitHub merges these; UNSTABLE means only optional checks failed, HAS_HOOKS that pre-receive hooks run. */
export const GITHUB_MERGEABLE = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];
/** Approval in GitHub mode: approved, or the repository requires no review (GitHub reports no decision). */
export const githubApproved = (s: Pick<Snapshot, "reviewDecision">) => s.reviewDecision === "APPROVED" || s.reviewDecision === "";
/** Says why GitHub won't merge yet, naming the cause and the fix. Null when GitHub reports it mergeable. */
export function githubBlocker(s: Snapshot): string | null {
  const state = s.mergeStateStatus ?? "UNKNOWN";
  if (GITHUB_MERGEABLE.includes(state)) return null;
  if (state === "DIRTY" || state === "DRAFT") return null; // Reported as Merge conflicts / Draft already.
  if (state === "BEHIND") return "Behind its base branch (update the branch)";
  if (state === "BLOCKED") {
    if (s.threads?.length) return `${s.threads?.length} unresolved review thread${s.threads?.length === 1 ? "" : "s"}`;
    if (s.failedChecks?.length || s.checksPending || !githubApproved(s)) return null; // Already named.
    return "A branch protection rule or ruleset";
  }
  return "GitHub’s mergeability check";
}
export function mergeBlockers(pr: Pr): string[] {
  const s = pr.snapshot;
  if (pr.error || !s?.complete) return ["Refresh PR status"];
  if (s.state !== "OPEN") return [s.state === "MERGED" ? "Already merged" : "PR is closed"];
  const blockers: string[] = [];
  const github = isGithubFlow(s);
  if (s.draft) blockers.push("Draft");
  if (github ? !githubApproved(s) : s.reviewDecision !== "APPROVED") blockers.push(github && s.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Awaiting approval");
  if (s.conflict) blockers.push("Merge conflicts");
  if (s.failedChecks?.length) blockers.push("Required checks failed");
  if (s.checksPending) blockers.push(checksState(s) === "not-started" ? "Required checks not started" : "Required checks pending");
  if (github) { if (s.inMergeQueue) blockers.push("Already in the merge queue"); const g = githubBlocker(s); if (g) blockers.push(g); }
  else if (!graphiteReady(s.graphiteMergeStatus)) blockers.push(graphiteBlocker(s.graphiteMergeStatus));
  return blockers;
}

/** Reviewer requests on other PRs do not own this PR's action slot. */
export function prActionBlocks(action: Pick<Workspace["prActions"][number], "state" | "kind" | "prs">, keys: readonly string[]): boolean {
  return ["sending", "uncertain"].includes(action.state) &&
    (action.kind !== "request_reviewers" || action.prs.some(key => keys.includes(key)));
}
