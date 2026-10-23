import type { Workspace } from "../shared/model";

export function excludeStack(w: Workspace, stack: string, reason: string, obligationIds: string[], at: string): void {
  if (w.excludedStacks.some(s => s.name === stack)) return;
  const prs = w.prs.filter(p => p.stack === stack);
  if (!prs.length) throw new Error("Stack is not registered in this workspace");
  const keys = new Set(prs.map(p => p.key));
  if (w.prs.some(p => !keys.has(p.key) && p.parent && keys.has(p.parent))) throw new Error("Reconcile dependent PRs in other stacks before excluding this stack");
  if (obligationIds.some(id => !w.obligations.some(o => o.id === id))) throw new Error("An obligation selected for exclusion is not recorded");
  const obligations = w.obligations.filter(o => obligationIds.includes(o.id) || o.afterPrs.length > 0 && o.afterPrs.every(key => keys.has(key)));
  const ids = new Set(obligations.map(o => o.id));
  if (w.obligations.some(o => !ids.has(o.id) && o.afterPrs.some(key => keys.has(key)))) throw new Error("Reconcile obligations with dependencies in multiple stacks before excluding this stack");
  w.excludedStacks.push({ name: stack, reason, excludedAt: at, prs, obligations });
  w.prs = w.prs.filter(p => !keys.has(p.key));
  w.obligations = w.obligations.filter(o => !ids.has(o.id));
  for (const b of w.batches.filter(b => b.state === "pending")) {
    b.tasks = b.tasks.filter(t => !keys.has(t.target) && !ids.has(t.target));
    if (!b.tasks.length) { b.state = "cancelled"; b.result = `Stack excluded from workspace scope: ${reason}`; }
  }
  w.completion = null; w.updatedAt = at;
}
