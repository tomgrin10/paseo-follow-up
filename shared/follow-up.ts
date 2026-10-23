import type { Obligation, Pr, Workspace, Batch } from "./model";

export const recoveryBatch = (batch: Pick<Batch, "tasks">): boolean => batch.tasks.length > 0 && batch.tasks.every(t => t.kind === "inventory");

export function lifecycleOnly(o: Pick<Obligation, "title" | "afterPrs" | "category">): boolean {
  if (o.category) return o.category === "pr_lifecycle";
  if (!o.afterPrs.length || /\b(verify|confirm|check|test|run|decide|decision|monitor|resolve|reconcile)\b/i.test(o.title)) return false;
  return /^(merge|approve|publish|land|deploy)\b/i.test(o.title) || /^#\d+.*\bneeds?\b.*\b(approval|merge)\b/i.test(o.title);
}
export const followUpObligations = (w: Workspace): Obligation[] => w.obligations.filter(o => !lifecycleOnly(o));
export function deployed(pr: Pr, now = Date.now()): boolean {
  const d = pr.snapshot?.deployment;
  return !pr.error && pr.snapshot?.state === "MERGED" && !!pr.snapshot.complete && !!d &&
    d.state === "deployed" && now - Date.parse(d.observedAt) >= 0 && now - Date.parse(d.observedAt) <= 120_000;
}
