import { z } from "zod";
import { followUpObligations, deployed, recoveryBatch } from "./follow-up";
import { communicationSchema, replyRecorded } from "./communication";
import { taskTriggerSchema } from "./task-trigger";

export const textSchema = z.string().trim().min(1).max(2000);
export const idSchema = z.string().min(1).max(200);
export const deploymentSchema = z.object({
  state: z.enum(["deployed", "pending", "partial", "unknown"]), environment: z.string(),
  commits: z.array(z.string()), evidence: z.string(), observedAt: z.string(),
});
export const snapshotSchema = z.object({
  title: z.string(), url: z.string(), state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  head: z.string(), base: z.string(), trunk: z.string(), draft: z.boolean(),
  headBranch: z.string().default(""), graphiteMergeStatus: z.string().nullable().default(null),
  conflict: z.boolean(), reviewDecision: z.string(),
  reviewers: z.object({ author: z.string().nullable(), requested: z.array(z.string()), teams: z.array(z.string()), reviewed: z.array(z.string()), complete: z.boolean() }).optional(),
  mergeWhenReady: z.enum(["on", "off", "unknown"]).default("unknown"),
  threads: z.array(z.object({ id: z.string(), updatedAt: z.string() })),
  failedChecks: z.array(z.string()), checksPending: z.boolean(),
  complete: z.boolean(), observedAt: z.string(),
  mergeCommit: z.string().nullable().optional(), deployment: deploymentSchema.nullable().optional(),
  mergedAt: z.string().nullable().optional(),
});
export const prSchema = z.object({
  key: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(),
  stack: textSchema, parent: idSchema.nullable(), disposition: z.string().nullable(),
  snapshot: snapshotSchema.nullable(), error: z.string().nullable(),
  deploymentAnchor: z.object({ mergeCommit: z.string(), at: z.string() }).optional(),
});
export const obligationSchema = z.object({
  id: idSchema, title: textSchema,
  status: z.enum(["pending", "waiting", "working", "blocked", "done", "waived"]),
  afterPrs: z.array(idSchema), evidence: z.string().max(4000),
  enable_follow_up: z.boolean().default(false), revision: z.number().int().nonnegative(),
  dependencyStage: z.enum(["merged", "deployed"]).optional(), category: z.enum(["follow_up", "pr_lifecycle"]).optional(),
  previousTitles: z.array(z.string()).optional(),
  communication: communicationSchema.optional(),
  trigger: taskTriggerSchema.nullable().optional(),
});
export const taskSchema = z.object({
  key: idSchema, kind: z.enum(["conflict", "review", "checks", "restack", "obligation", "inventory", "completion"]),
  target: idSchema, title: z.string(), fingerprint: z.string(),
});
export const batchSchema = z.object({
  id: idSchema, tasks: z.array(taskSchema),
  enable_manual_recovery: z.boolean().optional(),
  state: z.enum(["pending", "sending", "sent", "completed", "blocked", "cancelled", "uncertain"]),
  createdAt: z.string(), sentAt: z.string().nullable(), settledAt: z.string().nullable(),
  messageId: idSchema, attempts: z.number().int().nonnegative(), result: z.string(),
  recipientAgentId: idSchema.nullable().default(null), contextPath: z.string().nullable().default(null),
  activityAt: z.string().nullable().default(null),
  acknowledgmentError: z.object({ agentId: idSchema, at: z.string(), error: z.string() }).nullable().default(null),
  recoveryHandoffs: z.array(z.object({ fromAgentId: idSchema, toAgentId: idSchema, at: z.string() })).default([]),
});
export const workspaceSchema = z.object({
  id: idSchema, title: textSchema, goal: textSchema, mainAgentId: idSchema,
  enable_tracking: z.boolean().default(false), enable_auto_sends: z.boolean().default(false), hold: z.string().nullable(), archived: z.boolean(),
  prs: z.array(prSchema), obligations: z.array(obligationSchema), batches: z.array(batchSchema),
  excludedStacks: z.array(z.object({ name: textSchema, reason: textSchema, excludedAt: z.string(), prs: z.array(prSchema), obligations: z.array(obligationSchema) })).default([]),
  prActions: z.array(z.object({ id: idSchema, kind: z.enum(["merge", "enable_mwr", "disable_mwr", "request_reviewers"]), reviewers: z.array(z.string()).optional(), prs: z.array(idSchema), heads: z.record(z.string(), z.string()), createdAt: z.string(), state: z.enum(["sending", "submitted", "failed", "uncertain"]), result: z.string() })).default([]),
  completion: z.object({ summary: textSchema, declaredAt: z.string() }).nullable(),
  updatedAt: z.string(), managedDoneLabel: z.boolean(),
  runtimeReason: z.string().nullable(), runtimeBusy: z.boolean(), backgroundBusy: z.boolean().default(false),
  interruption: z.object({ turnId: z.string().nullable(), at: z.string(), kind: z.enum(["canceled", "failed"]), guardPauseId: z.string().optional() }).optional(),
  inventory: z.object({
    revision: z.number().int().positive(), syncedRevision: z.number().int().nonnegative(),
    candidates: z.array(idSchema), historyComplete: z.boolean(), historyError: z.string().nullable(),
    scannedMessageAt: z.string().nullable(),
  }).nullable().default(null),
});
export const stateSchema = z.object({ version: z.literal(1), workspaces: z.array(workspaceSchema), projectDefaults: z.record(z.string(), z.boolean()).optional() });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type Pr = z.infer<typeof prSchema>;
export type Obligation = z.infer<typeof obligationSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Batch = z.infer<typeof batchSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type State = z.infer<typeof stateSchema>;

export function settled(pr: Pr): boolean {
  return pr.snapshot?.state === "MERGED" || (pr.snapshot?.state === "CLOSED" && !!pr.disposition);
}
export function completionBlockers(w: Workspace, now = Date.now()): string[] {
  const blockers = w.prs.flatMap(pr => {
    if (pr.error || !pr.snapshot?.complete || now - Date.parse(pr.snapshot.observedAt) > 120_000)
      return [`Refresh status for ${pr.repo}#${pr.number}`];
    if (pr.snapshot.state === "MERGED" && pr.snapshot.deployment?.environment && !deployed(pr, now)) return [`Verify production deployment of ${pr.repo}#${pr.number}`];
    return settled(pr) ? [] : [`Settle ${pr.repo}#${pr.number}${pr.snapshot.state === "CLOSED" ? " with a disposition" : ""}`];
  });
  blockers.push(...followUpObligations(w).filter(o => !["done", "waived"].includes(o.status)).map(o => o.title));
  blockers.push(...followUpObligations(w).filter(o => o.status === "done" && o.communication && !replyRecorded(o.communication)).map(o => `Record the sent reply for ${o.title}`));
  if (w.batches.some(b => !recoveryBatch(b) && ["pending", "sending", "sent", "blocked", "uncertain"].includes(b.state))) blockers.push("Finish outstanding follow-up batches");
  if (w.prActions.some(a => ["sending", "uncertain"].includes(a.state))) blockers.push("Check the outstanding PR action");
  if (w.hold) blockers.push(w.hold);
  if (w.runtimeBusy) blockers.push("Wait for active agent work to finish");
  if (w.backgroundBusy) blockers.push("Wait for active background agents to finish");
  if (w.runtimeReason) blockers.push(w.runtimeReason);
  return blockers;
}
export type Status = "active" | "handling" | "waiting" | "needs-you" | "done";
export function summary(w: Workspace, now = Date.now()): { status: Status; label: string; reason: string } {
  const obligations = followUpObligations(w);
  if (w.hold) return { status: "needs-you", label: "Needs you", reason: w.hold };
  const blocked = w.batches.find(b => !recoveryBatch(b) && ["blocked", "uncertain"].includes(b.state));
  if (blocked) return { status: "needs-you", label: "Needs you", reason: blocked.result || "Follow-up needs a decision" };
  const obligation = obligations.find(o => o.status === "blocked");
  if (obligation) return { status: "needs-you", label: "Needs you", reason: obligation.title };
  if (w.completion && completionBlockers(w, now).length === 0) return { status: "done", label: "Done", reason: w.completion.summary };
  if (w.runtimeReason) return { status: "waiting", label: "Waiting", reason: w.runtimeReason };
  const batch = w.batches.find(b => !recoveryBatch(b) && ["pending", "sending", "sent"].includes(b.state));
  if (batch) return { status: batch.state === "pending" ? "active" : "handling", label: batch.state === "pending" ? w.enable_auto_sends ? "Auto queued" : "Ready to send" : "Agent handling", reason: `${batch.tasks.length} follow-up task${batch.tasks.length === 1 ? "" : "s"} ${batch.state === "pending" ? "queued" : batch.recipientAgentId && batch.recipientAgentId !== w.mainAgentId ? "sent to the recovery agent" : "sent to the main agent"}` };
  if (w.runtimeBusy || obligations.some(o => o.status === "working")) return { status: "handling", label: "Agent handling", reason: obligations.find(o => o.status === "working")?.title ?? "The main agent is working" };
  if (w.prs.some(pr => pr.error || !pr.snapshot?.complete)) return { status: "waiting", label: "Waiting", reason: "PR status unavailable; refresh will retry" };
  const pending = obligations.find(o => !["done", "waived"].includes(o.status));
  if (pending) return { status: pending.status === "waiting" ? "waiting" : "active", label: pending.status === "waiting" ? "Waiting" : "Active", reason: pending.title };
  if (w.prs.some(pr => !settled(pr))) return { status: "waiting", label: "Waiting", reason: "Waiting for PR review, checks, or merge" };
  return { status: "active", label: "Active", reason: "The main agent has not declared completion" };
}
