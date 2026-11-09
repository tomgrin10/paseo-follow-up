import { z } from "zod";
import { idSchema, textSchema, type Pr, type Snapshot, type Workspace } from "./model";

export const prActionKind = z.enum(["merge", "enable_mwr", "disable_mwr"]);
export const actionPrSchema = z.object({ key: idSchema, repo: z.string(), number: z.number(), title: z.string(), head: z.string(), parent: idSchema.nullable(), base: z.string(), trunk: z.string(), blockers: z.array(z.string()) });
/** `via` and `method` (GitHub mode): who merges, and with which merge method, so the confirmation can say so. */
export const actionPlanSchema = z.object({ id: idSchema, workspaceId: idSchema, target: idSchema, kind: prActionKind, expiresAt: z.string(), prs: z.array(actionPrSchema), blockers: z.array(z.string()), via: z.enum(["graphite", "github"]).optional(), method: z.enum(["squash", "merge", "rebase"]).optional(), mergeQueue: z.boolean().optional() });
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type PrActionKind = z.infer<typeof prActionKind>;

export const browserPrSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), head: z.string().min(1), state: z.enum(["OPEN", "MERGED", "CLOSED"]), mergeWhenReady: z.boolean(), merging: z.boolean() });
export type BrowserPr = z.infer<typeof browserPrSchema>;
export const browserCommandSchema = z.object({ id: idSchema, nonce: idSchema, expiresAt: z.string(), op: z.enum(["read", "enable_mwr", "disable_mwr"]), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), prs: z.array(z.object({ number: z.number().int().positive(), head: z.string(), trunk: z.string() })).min(1).max(50) });
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export const browserResultSchema = z.object({ id: idSchema, nonce: idSchema, outcome: z.enum(["completed", "failed", "uncertain"]), prs: z.array(browserPrSchema).max(50).default([]), applied: z.array(z.number().int().positive()).max(50).default([]), error: z.string().max(500).default("") });
export type BrowserResult = z.infer<typeof browserResultSchema>;
export const browserExchangeSchema = z.object({ clientId: idSchema, ready: z.boolean(), acceptJobs: z.boolean().default(true), results: z.array(browserResultSchema).max(10).default([]), repositories: z.array(browserPrSchema.shape.repo).max(100).default([]) });
export const browserStatusSchema = z.object({ ready: z.boolean(), reason: z.string().nullable() });
export const actionResultSchema = z.object({ state: z.enum(["submitted", "failed", "uncertain"]), result: textSchema });

export function downstack(prs: Pr[], target: string): Pr[] {
  const selected: Pr[] = []; const seen = new Set<string>();
  let key: string | null = target; let repo: string | null = null;
  while (key) {
    if (seen.has(key)) throw new Error("This stack has a parent cycle. Reconcile its tracking before merging.");
    seen.add(key);
    const pr = prs.find(p => p.key === key);
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
    if (s.threads.length) return `${s.threads.length} unresolved review thread${s.threads.length === 1 ? "" : "s"}`;
    if (s.failedChecks.length || s.checksPending || !githubApproved(s)) return null; // Already named.
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
  if (s.failedChecks.length) blockers.push("Required checks failed");
  if (s.checksPending) blockers.push("Required checks pending");
  if (github) { if (s.inMergeQueue) blockers.push("Already in the merge queue"); const g = githubBlocker(s); if (g) blockers.push(g); }
  else if (!graphiteReady(s.graphiteMergeStatus)) blockers.push(graphiteBlocker(s.graphiteMergeStatus));
  return blockers;
}

/** Reviewer requests on other PRs do not own this PR's action slot. */
export function prActionBlocks(action: Pick<Workspace["prActions"][number], "state" | "kind" | "prs">, keys: readonly string[]): boolean {
  return ["sending", "uncertain"].includes(action.state) &&
    (action.kind !== "request_reviewers" || action.prs.some(key => keys.includes(key)));
}
