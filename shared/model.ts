import { z } from "zod";
import { OBSERVATION_FRESH_MS } from "./poll";
import { followUpObligations, deployState, recoveryBatch } from "./follow-up";
import { communicationSchema, replyRecorded } from "./communication";
import { taskTriggerSchema } from "./task-trigger";
import { isOpen as questionOpen, questionSchema } from "./questions";
import { artifactSchema, specSchema } from "./spec";

/** Why a main-agent turn ended canceled (shared/status.ts cancelCause). */
export const CANCEL_CAUSES = ["stop", "replaced", "compaction", "reload", "closed"] as const;
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
  failedChecks: z.array(z.string()), otherFailedChecks: z.array(z.string()).optional(), checksPending: z.boolean(),
  /** Any check still running, required or not (a non-required one can still fail). Drives polling cadence (shared/poll.ts). */
  checksRunning: z.boolean().optional(),
  complete: z.boolean(), observedAt: z.string(),
  mergeCommit: z.string().nullable().optional(), deployment: deploymentSchema.nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  /** 1.4.0-beta.14: which workflow observed this PR. Absent (older snapshots) means Graphite, as before. */
  prWorkflow: z.enum(["graphite", "github"]).optional(),
  /** GitHub's own merge verdict (CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN). */
  mergeStateStatus: z.string().optional(),
  inMergeQueue: z.boolean().optional(),
  /** What the repository allows, read with the PR (no extra request): merge methods, auto-merge and a merge queue. */
  repoMerge: z.object({ methods: z.array(z.enum(["squash", "merge", "rebase"])), preferred: z.enum(["squash", "merge", "rebase"]).nullable(), autoMerge: z.boolean(), mergeQueue: z.boolean() }).optional(),
});
export const prSchema = z.object({
  key: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(),
  stack: textSchema, parent: idSchema.nullable(), disposition: z.string().nullable(),
  snapshot: snapshotSchema.nullable(), error: z.string().nullable(),
  registeredAgentId: idSchema.optional(),
  discoveredFromSubmission: z.boolean().optional(),
  /** The agent merges this PR itself (register_pr agentMerges): Follow-up never asks the developer to review or merge it. */
  agentMerges: z.boolean().optional(),
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
  contributorAgentIds: z.array(idSchema).optional(),
  /** When discovery first saw the recorded main agent closed, cleared once it reads live again (see successorMainAgent). */
  mainClosedSince: z.string().optional(),
  /** A main agent closed for MAIN_CLOSED_HANDOVER_MS handed the workspace to `mainAgentId`; until that agent does main-agent work, a live `from` takes it back. */
  handover: z.object({ from: idSchema, at: z.string(), worked: z.boolean() }).optional(),
  /** Every change of main agent, newest last, at most 20 (1.4.0-beta.22). by: developer, auto, or agent:<id>. */
  mainHistory: z.array(z.object({ from: idSchema, to: idSchema, by: z.string(), reason: z.string().nullable(), at: z.string() })).optional(),
  /** When the main agent last made a main-agent call (sync, tasks, questions, needs_you, Done), hourly at most. */
  mainWorkAt: z.string().optional(),
  enable_tracking: z.boolean().default(false), enable_auto_sends: z.boolean().default(false), hold: z.string().nullable(), archived: z.boolean(),
  /**
   * Later on a workspace-only Needs-you row (no inbox flag to snooze): `until` an ISO time or "next-event", over the
   * needs it was set on (`keys`, needKey). A new need or the time ends it (workspaceSnoozed). Null: not snoozed.
   */
  snooze: z.object({ until: z.string(), at: z.string(), keys: z.array(z.string()) }).nullable().optional(),
  prs: z.array(prSchema), obligations: z.array(obligationSchema), batches: z.array(batchSchema),
  excludedStacks: z.array(z.object({ name: textSchema, reason: textSchema, excludedAt: z.string(), prs: z.array(prSchema), obligations: z.array(obligationSchema) })).default([]),
  prActions: z.array(z.object({ id: idSchema, kind: z.enum(["merge", "enable_mwr", "disable_mwr", "request_reviewers"]), reviewers: z.array(z.string()).optional(), prs: z.array(idSchema), heads: z.record(z.string(), z.string()), createdAt: z.string(), state: z.enum(["sending", "submitted", "failed", "uncertain"]), result: z.string() })).default([]),
  completion: z.object({ summary: textSchema, declaredAt: z.string(),
    /** PRs whose deploy Follow-up could not confirm when Done was accepted ("Deploy not confirmed by Follow-up"). */
    unconfirmed: z.array(z.string()).optional() }).nullable(),
  /** The main agent declared Done while only Follow-up's own waits remained (a rollout, a refresh); recorded as Done once they clear. */
  declaration: z.object({ summary: textSchema, at: z.string() }).nullable().optional(),
  /** Why the worker holds queued repairs although nothing in this record blocks them (unloaded/long-idle agent, setup). */
  sendWait: z.enum(["unloaded", "setup"]).nullable().optional(),
  updatedAt: z.string(), managedDoneLabel: z.boolean(),
  runtimeReason: z.string().nullable(), runtimeBusy: z.boolean(), backgroundBusy: z.boolean().default(false),
  interruption: z.object({ turnId: z.string().nullable(), at: z.string(), kind: z.enum(["canceled", "failed"]), /** Why a canceled turn stopped (shared/status.ts cancelCause); only "stop" holds. */ cause: z.enum(CANCEL_CAUSES).optional(), guardPauseId: z.string().optional(), /** The agent whose turn stopped (since 1.4.0-beta.16). */ agentId: idSchema.optional() }).optional(),
  // Added with questions; older saved states parse with none.
  questions: z.array(questionSchema).default([]),
  // Added with spec links; older saved states parse with none.
  spec: specSchema.nullable().default(null),
  artifacts: z.array(artifactSchema).default([]),
  inventory: z.object({
    revision: z.number().int().positive(), syncedRevision: z.number().int().nonnegative(),
    candidates: z.array(idSchema), historyComplete: z.boolean(), historyError: z.string().nullable(),
    scannedMessageAt: z.string().nullable(),
  }).nullable().default(null),
  /** 1.3.0-beta.3: outside the active scope (no loaded agent, no recent message, no open PR). Absent means active. */
  dormant: z.boolean().optional(),
  /** The main agent's provider conversation no longer exists; Follow-up stops sending to it. */
  goneAgent: z.object({ agentId: idSchema, at: z.string(), reason: z.string() }).nullable().optional(),
});
export const stateSchema = z.object({
  version: z.literal(1), workspaces: z.array(workspaceSchema),
  /** Per-project opt-outs (false) and, with Follow every workspace off, opt-ins (true). */
  projectDefaults: z.record(z.string(), z.boolean()).optional(),
  /** 1.3.0-beta.2: tracking is invisible. Absent means on. */
  enable_follow_every: z.boolean().optional(),
  /** Auto-send for a newly followed workspace. Absent means on. */
  enable_auto_sends_default: z.boolean().optional(),
  /** Workspaces the developer opted out of following, the rare exception. */
  workspaceOptOuts: z.array(idSchema).optional(),
  /** One-time migrations already applied, so they never run twice. */
  migrations: z.array(z.string()).optional(),
  /** Days without a user message before a followed workspace goes dormant. Absent means 3. */
  activeWindowDays: z.number().int().min(1).max(60).optional(),
  /** Workspaces whose auto-send the active-scope migration turned off; it turns back on when they become active. */
  autoSendsParked: z.array(idSchema).optional(),
});
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
/**
 * What stands between a workspace and Done, and who can move it:
 * - agent: the main agent can resolve it with its tools (record a task, acknowledge a batch, withdraw a question);
 * - developer: needs Tom (merge, answer, resume, check a PR action);
 * - wait: time or Follow-up's own observation (agent busy, deploy rollout, status refresh). Never revokes a Done.
 * `unconfirmed` is not a blocker: PRs whose deploy Follow-up could not confirm. Done is accepted with a note.
 */
export type BlockerOwner = "agent" | "developer" | "wait";
/** `contrary`: positive evidence that shipped work regressed (a rollback). It takes back a Done even though nobody acts. */
export type Blocker = { text: string; owner: BlockerOwner; contrary?: true };
export type CompletionGate = { blockers: Blocker[]; unconfirmed: string[] };
/** A completion check is the nudge to declare Done; it never blocks Done itself. */
export const completionCheck = (b: Pick<Batch, "tasks">): boolean => b.tasks.length > 0 && b.tasks.every(t => t.kind === "completion");
export function completionGate(w: Workspace, now = Date.now()): CompletionGate {
  const blockers: Blocker[] = [];
  const unconfirmed: string[] = [];
  const add = (owner: BlockerOwner, text: string, contrary?: true) => blockers.push(contrary ? { owner, text, contrary } : { owner, text });
  for (const pr of w.prs) {
    const ref = `${pr.repo}#${pr.number}`;
    // Merged (or closed with a disposition) is permanent: a later observation failure can't undo it.
    if (pr.snapshot?.complete && settled(pr)) {
      const deploy = deployState(pr, now);
      if (deploy === "not-deployed") add("wait", `Wait for ${ref} to reach ${pr.snapshot.deployment?.environment || "production"}`, true);
      else if (deploy === "unconfirmed") unconfirmed.push(ref);
      continue;
    }
    if (pr.error || !pr.snapshot?.complete || now - Date.parse(pr.snapshot.observedAt) > OBSERVATION_FRESH_MS) { add("wait", `Refresh status for ${ref}`); continue; }
    if (pr.snapshot.state === "CLOSED") add("agent", `Settle ${ref} with a disposition`);
    else add("developer", `Settle ${ref}`);
  }
  for (const o of followUpObligations(w).filter(o => !["done", "waived"].includes(o.status))) add(o.status === "blocked" ? "developer" : "agent", o.title);
  for (const o of followUpObligations(w).filter(o => o.status === "done" && o.communication && !replyRecorded(o.communication))) add("agent", `Record the sent reply for ${o.title}`);
  const open = w.batches.filter(b => !recoveryBatch(b) && !completionCheck(b));
  if (open.some(b => ["sending", "sent"].includes(b.state))) add("agent", "Acknowledge the open follow-up batch");
  if (open.some(b => ["blocked", "uncertain"].includes(b.state))) add("developer", "Retry or dismiss the stuck follow-up batch");
  if (open.some(b => b.state === "pending")) add("developer", "Send or dismiss the queued repairs");
  if (w.prActions.some(a => ["sending", "uncertain"].includes(a.state))) add("developer", "Check the outstanding PR action");
  for (const q of (w.questions ?? []).filter(questionOpen)) add("developer", `Answer or withdraw ${q.id} (${q.title})`);
  if (w.hold) add("developer", w.hold);
  if (w.runtimeBusy) add("wait", "Wait for active agent work to finish");
  if (w.backgroundBusy) add("wait", "Wait for background agents and jobs to finish");
  if (w.runtimeReason) add("wait", w.runtimeReason);
  return { blockers, unconfirmed };
}
export function completionBlockers(w: Workspace, now = Date.now()): string[] {
  return completionGate(w, now).blockers.map(b => b.text);
}
/** Only new work or contrary evidence takes a Done back; waiting and observation gaps never do. */
export function revokesDone(w: Workspace, now = Date.now()): boolean {
  return completionGate(w, now).blockers.some(b => b.owner !== "wait" || b.contrary);
}
export type Status = "active" | "handling" | "waiting" | "needs-you" | "done";
export function summary(w: Workspace, now = Date.now()): { status: Status; label: string; reason: string } {
  const obligations = followUpObligations(w);
  if (w.hold) return { status: "needs-you", label: "Needs you", reason: w.hold };
  const blocked = w.batches.find(b => !recoveryBatch(b) && ["blocked", "uncertain"].includes(b.state) && !(w.completion && completionCheck(b)));
  if (blocked) return { status: "needs-you", label: "Needs you", reason: blocked.result || "Follow-up needs a decision" };
  const question = (w.questions ?? []).find(questionOpen);
  if (question) return { status: "needs-you", label: "Needs you", reason: `${question.id}: ${question.title}` };
  const obligation = obligations.find(o => o.status === "blocked");
  if (obligation) return { status: "needs-you", label: "Needs you", reason: obligation.title };
  if (w.completion && completionBlockers(w, now).length === 0) return { status: "done", label: "Done", reason: w.completion.summary };
  if (w.runtimeReason) return { status: "waiting", label: "Waiting", reason: w.runtimeReason };
  const batch = w.batches.find(b => !recoveryBatch(b) && ["pending", "sending", "sent"].includes(b.state) && !(b.state === "pending" && completionCheck(b)));
  if (batch) return { status: batch.state === "pending" ? "active" : "handling", label: batch.state === "pending" ? w.enable_auto_sends ? "Auto queued" : "Ready to send" : "Agent handling", reason: `${batch.tasks.length} follow-up task${batch.tasks.length === 1 ? "" : "s"} ${batch.state === "pending" ? "queued" : batch.recipientAgentId && batch.recipientAgentId !== w.mainAgentId ? "sent to the recovery agent" : "sent to the main agent"}` };
  if (w.runtimeBusy || obligations.some(o => o.status === "working")) return { status: "handling", label: "Agent handling", reason: obligations.find(o => o.status === "working")?.title ?? "The main agent is working" };
  if (w.prs.some(pr => pr.error || !pr.snapshot?.complete)) return { status: "waiting", label: "Waiting", reason: "PR status unavailable; refresh will retry" };
  const pending = obligations.find(o => !["done", "waived"].includes(o.status));
  if (pending) return { status: pending.status === "waiting" ? "waiting" : "active", label: pending.status === "waiting" ? "Waiting" : "Active", reason: pending.title };
  if (w.prs.some(pr => !settled(pr))) return { status: "waiting", label: "Waiting", reason: "Waiting for PR review, checks, or merge" };
  return { status: "active", label: "Active", reason: "The main agent has not declared completion" };
}
