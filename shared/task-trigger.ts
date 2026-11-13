import { z } from "zod";
import type { ListObligation as Obligation, ListWorkspace as Workspace, ListPr as Pr } from "./list";
import { deployed } from "./follow-up";

export const taskTriggerSchema = z.object({ event: z.enum(["now", "merge", "deploy"]), delayDays: z.number().int().min(0).max(3650).default(0) });
export type TaskTrigger = z.infer<typeof taskTriggerSchema>;
/** A merged PR whose repository has no deploy check here (invariant public-code-carries-no-host-identifiers). */
export const notSetUpEvidence = (repo: string) => `Deploy check not set up for ${repo}.`;
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function taskSchedule(o: Obligation, w: Workspace, now = Date.now()): { ready: boolean; dueAt: string | null; label: string } {
  const t = o.trigger;
  if (!o.enable_follow_up || !t) return { ready: false, dueAt: null, label: "Manual" };
  if (t.event === "now") return { ready: o.afterPrs.length === 0 && t.delayDays === 0, dueAt: null, label: "Now" };
  const label = `${t.delayDays ? `${t.delayDays}d after ` : "After "}${t.event}`;
  if (!o.afterPrs.length) return { ready: false, dueAt: null, label };
  const prs = o.afterPrs.map(key => w.prs.find(p => p.key === key));
  // No deploy check for a dependency's repository: wait, say why, and never read a kept observation as a deploy.
  const unchecked = t.event === "deploy" ? prs.find(p => p?.snapshot?.state === "MERGED" && p.snapshot.deployment?.notSetUp) : undefined;
  if (unchecked) return { ready: false, dueAt: null, label: `Deploy check not set up for ${unchecked.repo}` };
  if (prs.some(p => !p || p.error || !p.snapshot?.complete || p.snapshot.state !== "MERGED" || t.event === "deploy" && !deployed(p, now))) return { ready: false, dueAt: null, label };
  const times = (prs as Pr[]).map(p => t.event === "merge" ? timestamp(p.snapshot?.mergedAt) : p.deploymentAnchor?.mergeCommit === p.snapshot?.mergeCommit ? timestamp(p.deploymentAnchor?.at) : null);
  if (times.some(t => t === null)) return { ready: t.delayDays === 0, dueAt: null, label };
  const due = Math.max(...times as number[]) + t.delayDays * 86_400_000;
  return { ready: due <= now, dueAt: new Date(due).toISOString(), label };
}
