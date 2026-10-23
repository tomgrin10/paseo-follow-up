import { z } from "zod";
import { idSchema, textSchema, type Pr } from "./model";

export const prActionKind = z.enum(["merge", "enable_mwr", "disable_mwr"]);
export const actionPrSchema = z.object({ key: idSchema, repo: z.string(), number: z.number(), title: z.string(), head: z.string(), parent: idSchema.nullable(), base: z.string(), trunk: z.string(), blockers: z.array(z.string()) });
export const actionPlanSchema = z.object({ id: idSchema, workspaceId: idSchema, target: idSchema, kind: prActionKind, expiresAt: z.string(), prs: z.array(actionPrSchema), blockers: z.array(z.string()) });
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type PrActionKind = z.infer<typeof prActionKind>;

export const browserPrSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), head: z.string().min(1), state: z.enum(["OPEN", "MERGED", "CLOSED"]), mergeWhenReady: z.boolean(), merging: z.boolean() });
export type BrowserPr = z.infer<typeof browserPrSchema>;
export const browserCommandSchema = z.object({ id: idSchema, nonce: idSchema, expiresAt: z.string(), op: z.enum(["read", "enable_mwr", "disable_mwr"]), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), prs: z.array(z.object({ number: z.number().int().positive(), head: z.string(), trunk: z.string() })).min(1).max(50) });
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export const browserResultSchema = z.object({ id: idSchema, nonce: idSchema, outcome: z.enum(["completed", "failed", "uncertain"]), prs: z.array(browserPrSchema).max(50).default([]), applied: z.array(z.number().int().positive()).max(50).default([]), error: z.string().max(500).default("") });
export type BrowserResult = z.infer<typeof browserResultSchema>;
export const browserExchangeSchema = z.object({ clientId: idSchema, ready: z.boolean(), acceptJobs: z.boolean().default(true), results: z.array(browserResultSchema).max(10).default([]) });
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

export function mergeBlockers(pr: Pr): string[] {
  const s = pr.snapshot;
  if (pr.error || !s?.complete) return ["Refresh PR status"];
  if (s.state !== "OPEN") return [s.state === "MERGED" ? "Already merged" : "PR is closed"];
  const blockers: string[] = [];
  if (s.draft) blockers.push("Draft");
  if (s.reviewDecision !== "APPROVED") blockers.push("Awaiting approval");
  if (s.conflict) blockers.push("Merge conflicts");
  if (s.failedChecks.length) blockers.push("Required checks failed");
  if (s.checksPending) blockers.push("Required checks pending");
  if (!["READY_TO_MERGE", "READY_TO_MERGE_AS_STACK", "READY_TO_MERGE_WITHOUT_CI", "READY_TO_MERGE_AS_STACK_WITHOUT_CI"].includes(s.graphiteMergeStatus ?? "")) blockers.push("Graphite is not ready to merge");
  return blockers;
}
