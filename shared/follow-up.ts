import type { Obligation, Pr, Workspace, Batch } from "./model";

export const recoveryBatch = (batch: Pick<Batch, "tasks">): boolean => batch.tasks.length > 0 && batch.tasks.every(t => t.kind === "inventory");

export function lifecycleOnly(o: Pick<Obligation, "title" | "afterPrs" | "category">): boolean {
  if (o.category) return o.category === "pr_lifecycle";
  if (!o.afterPrs.length || /\b(verify|confirm|check|test|run|decide|decision|monitor|resolve|reconcile)\b/i.test(o.title)) return false;
  return /^(merge|approve|publish|land|deploy)\b/i.test(o.title) || /^#\d+.*\bneeds?\b.*\b(approval|merge)\b/i.test(o.title);
}
export const followUpObligations = (w: Workspace): Obligation[] => w.obligations.filter(o => !lifecycleOnly(o));
/**
 * Where a merged PR stands against its deploy target.
 * - deployed: Follow-up saw its merge commit serving. Latched by deploymentAnchor: a probe error or an old
 *   observation never turns it back; only positive contrary evidence (pending/partial, i.e. a rollback) does.
 * - not-deployed: a fresh probe saw the serving revision without the commit.
 * - unconfirmed: a deploy target exists but Follow-up never confirmed it (probe error, stale, no access).
 * - none: not merged, or no deploy target for this repository.
 */
export type DeployState = "none" | "deployed" | "not-deployed" | "unconfirmed";
export const DEPLOY_FRESH_MS = 120_000;
export function deployState(pr: Pr, now = Date.now()): DeployState {
  const s = pr.snapshot;
  if (s?.state !== "MERGED") return "none";
  const d = s.deployment;
  const age = d ? now - Date.parse(d.observedAt) : NaN;
  const fresh = age >= 0 && age <= DEPLOY_FRESH_MS;
  if (d && fresh && (d.state === "pending" || d.state === "partial")) return "not-deployed";
  if (s.mergeCommit && pr.deploymentAnchor?.mergeCommit === s.mergeCommit) return "deployed";
  if (!pr.error && s.complete && d?.state === "deployed" && fresh) return "deployed";
  return d?.environment ? "unconfirmed" : "none";
}
export function deployed(pr: Pr, now = Date.now()): boolean {
  return deployState(pr, now) === "deployed";
}
