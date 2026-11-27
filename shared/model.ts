import { finishedTask } from "./finished";
import { sendItems } from "./send-words";
import { GITHUB_OFF } from "./github-setup";
import { z } from "zod";
import { deliveryReceiptSchema } from "./queue";
import { OBSERVATION_FRESH_MS } from "./poll";
import { followUpObligations, deployState, recoveryBatch } from "./follow-up";
import { communicationSchema, replyRecorded } from "./communication";
import { taskTriggerSchema } from "./task-trigger";
import { blockedOnDeveloper, isOpen as questionOpen, questionSchema, waitsOnDeveloper } from "./questions";
export { blockedOnDeveloper, waitsOnDeveloper };
import { artifactSchema, specSchema } from "./spec";
import { storedMilestoneSchema } from "./now";
import type { ListPr, ListWorkspace } from "./list";

/** Why a main-agent turn ended canceled (shared/status.ts cancelCause). */
export const CANCEL_CAUSES = ["stop", "replaced", "compaction", "reload", "closed"] as const;
export const textSchema = z.string().trim().min(1).max(2000);
export const idSchema = z.string().min(1).max(200);
export const deploymentSchema = z.object({
  state: z.enum(["deployed", "pending", "partial", "unknown"]), environment: z.string(),
  commits: z.array(z.string()), evidence: z.string(), observedAt: z.string(),
  /**
   * The repository has no deploy check on this machine (host settings). The rest is the last observation, kept so it
   * comes back unchanged when the check is set up again; a deploy-triggered task waits, saying why (shared/task-trigger.ts).
   */
  notSetUp: z.boolean().optional(),
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
export const prObjectSchema = z.object({
  key: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(),
  stack: textSchema, parent: idSchema.nullable(), disposition: z.string().nullable(),
  snapshot: snapshotSchema.nullable(), error: z.string().nullable(),
  registeredAgentId: idSchema.optional(),
  discoveredFromSubmission: z.boolean().optional(),
  /** The agent merges this PR itself (register_pr agentMerges): Follow-up never asks the developer to review or merge it. */
  agentMerges: z.boolean().optional(),
  deploymentAnchor: z.object({ mergeCommit: z.string(), at: z.string() }).optional(),
});
/**
 * A merged PR with a complete snapshot is final: an error from a later failed read means nothing about it. 2.0.1-beta.0's
 * RATE_LIMIT failures left such errors in state.json, and merged-is-final never reads those PRs again, so the error is
 * dropped wherever the state is parsed (load included): existing installs heal without a Refresh.
 * Invariant a-github-limit-never-blanks-a-known-pr.
 */
export const prSchema = prObjectSchema.transform(pr => pr.error && pr.snapshot?.complete && pr.snapshot.state === "MERGED" ? { ...pr, error: null } : pr);
/** A PR's status is known when its last read was complete. A later failed read (`error`) never blanks it; it only makes it older. */
export const statusKnown = <P extends { snapshot: { complete: boolean } | null }>(pr: P): pr is P & { snapshot: NonNullable<P["snapshot"]> } => !!pr.snapshot?.complete;
export const obligationSchema = z.object({
  id: idSchema, title: textSchema,
  status: z.enum(["pending", "waiting", "working", "blocked", "done", "waived"]),
  afterPrs: z.array(idSchema), evidence: z.string().max(4000),
  /** While blocked: the question the developer must answer. Without one, a blocked task waits on nothing of theirs. */
  ask: z.string().max(1000).optional(),
  /**
   * While blocked on the developer: the question that already asks this decision (one-decision-one-card), so the task
   * makes no card of its own. Set by syncTaskQuestions, kept while the ask is unchanged (an answered one still covers it:
   * the agent has the answer), dropped when the ask changes or the task leaves blocked.
   */
  coveredBy: z.string().regex(/^Q\d+$/).optional(),
  /**
   * While blocked on the developer: what the ask wants, a decision or an action they take and report back
   * (one-ask-one-item). Set by update_obligation `need`; without it Follow-up reads the ask (shared/questions.ts taskNeed).
   */
  need: z.enum(["decision", "action"]).optional(),
  /** Background the task carries for whoever works it: Make a task from Your questions puts the question and its answer here. */
  note: z.string().max(2000).optional(),
  enable_follow_up: z.boolean().default(false), revision: z.number().int().nonnegative(),
  dependencyStage: z.enum(["merged", "deployed"]).optional(), category: z.enum(["follow_up", "pr_lifecycle"]).optional(),
  previousTitles: z.array(z.string()).optional(),
  communication: communicationSchema.optional(),
  trigger: taskTriggerSchema.nullable().optional(),
  /**
   * Who is working on it: the agent that last set status=working through update_obligation, or the agent it named
   * (workingAgentId, e.g. an orchestrator's subagent). The task's line reads that agent's live state (shared/task-status.ts).
   */
  workingAgentId: idSchema.optional(),
  /** The agent whose update_obligation made it (a-new-task-is-checked-once): its exact-title repeat updates this task. */
  createdBy: idSchema.optional(),
  /**
   * due-by-fact: when a task with no PRs comes due (default 3 days after its last update), or, set by the agent, the
   * earliest a PR-made due fact nudges it again. ISO time.
   */
  recheckAt: z.string().optional(),
  /** When it was done or waived (ISO). Finished tasks are pruned 30 days later (shared/task-due.ts pruneFinished). */
  finishedAt: z.string().optional(),
  /**
   * The turn-end nudges about this task's current due fact (`key`), as the agent hook recorded them: how many, the last
   * one, and the task's revision then. Two with no change since make the task stale (shared/task-due.ts).
   */
  nudged: z.object({ key: z.string(), count: z.number().int().nonnegative(), at: z.string(), revision: z.number().int().nonnegative() }).optional(),
});
// blockedOnDeveloper and waitsOnDeveloper live in shared/questions.ts (task-due reads them too; no import cycle).
export const taskSchema = z.object({
  key: idSchema, kind: z.enum(["conflict", "review", "checks", "restack", "obligation", "inventory", "completion"]),
  target: idSchema, title: z.string(), fingerprint: z.string(),
  /**
   * What the condition is made of, when it has parts that change on their own: a review's open threads as
   * `id@updatedAt`. A later message about the same task says only what moved since the last one (taskUpdate in
   * shared/send-decision.ts). Absent on older records and on tasks without parts.
   */
  parts: z.array(z.string().max(300)).optional(),
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
  /** Paseo 0.17.2+: what Paseo did with the send (held until the agent's turn ends, or the turn stopped). Absent before. */
  receipt: deliveryReceiptSchema.nullable().optional(),
  /** The last automatic send Follow-up refused for this queued batch (shared/send-decision.ts). Cleared on a send or a task change. */
  refusal: z.object({ reason: z.string(), at: z.string() }).nullable().optional(),
  /**
   * Auto-send put it on its way, so its turn counts against the limit (invariant 133, autoTurnRunning). Never set by the
   * developer's Send, a ride-along or a recovery; cleared when the developer sends it or the queue hands it back.
   */
  automatic: z.boolean().optional(),
  /** The agent's turn ended without acknowledge_batch; Follow-up settled it from GitHub instead (settleUnacknowledged). */
  unacknowledged: z.boolean().optional(),
  /**
   * The agent acknowledged it blocked with nothing left for an agent: only a person can move what is still open (a
   * reviewer re-reviews or dismisses a stale review, access is granted). Settled completed, and its still-open
   * conditions wait as the developer's held "person" tasks (invariant a-human-only-outcome-is-a-human-item).
   */
  humanOnly: z.boolean().optional(),
  /**
   * The part of this batch only a person can move, in the agent's words ("thread 2 needs the reviewer's call"), with
   * any outcome. A person item in Needs you until a later answer for the same task drops it, and the next message
   * tells the agent to leave that part (a-person-part-is-a-person-item).
   */
  waitingOn: z.string().max(500).optional(),
  /**
   * The agent acknowledged it in_progress: it (or its own subagent) is already working on it. Settled completed, not a
   * failure; its unchanged conditions are not sent again while that work runs (inProgressHolds, shared/send-decision.ts),
   * only once the workspace is quiet or the condition changes (invariant a-changed-review-updates-never-cancels).
   */
  inProgress: z.boolean().optional(),
  /**
   * A sent batch whose conditions moved on after it went out: `changed` (the same task, new content on GitHub, which the
   * next message carries), `gone` (nothing it asked for still applies), `retried` (the developer sent it again) or
   * `duplicate` (the same conditions went out again while this one stood). A batch the agent answered keeps its state and
   * result; this only takes it out of Needs you and the queue (holdsQueue, stuckRepair). Never a failure on screen.
   */
  movedOn: z.object({ at: z.string(), why: z.enum(["changed", "gone", "retried", "duplicate"]), reason: z.string() }).optional(),
});
export const workspaceSchema = z.object({
  id: idSchema, title: textSchema, goal: textSchema, mainAgentId: idSchema,
  /** Workspace project repository from discovery, independent of its PRs (shared/now.ts). */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable().optional(),
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
  /**
   * Needs-you items the developer dismissed (dismissing-anything-in-needs-you-sends-the-agent-nothing): the item's key
   * and its print (shared/attention.ts dismissPrint), what it said, when and by whom. An item stays hidden while its
   * print matches; a change (a new head, a new failure, a new batch) is a new print, so it comes back. Nothing here is
   * ever sent to an agent. A question's dismissal lives on the question (closed.dismissed), not here.
   */
  dismissed: z.array(z.object({ key: z.string().max(400), print: z.string().max(2000), title: z.string().max(400), at: z.string(), by: z.string() })).max(100).optional(),
  prs: z.array(prSchema), obligations: z.array(obligationSchema), batches: z.array(batchSchema),
  excludedStacks: z.array(z.object({ name: textSchema, reason: textSchema, excludedAt: z.string(), prs: z.array(prSchema), obligations: z.array(obligationSchema) })).default([]),
  prActions: z.array(z.object({ id: idSchema, kind: z.enum(["merge", "enable_mwr", "disable_mwr", "request_reviewers"]), reviewers: z.array(z.string()).optional(), prs: z.array(idSchema), heads: z.record(z.string(), z.string()), createdAt: z.string(), state: z.enum(["sending", "submitted", "failed", "uncertain"]), result: z.string(), /** A submitted merge: how far it got (mergeStageSchema). */ merge: z.enum(["merged", "queued", "requested"]).optional() })).default([]),
  completion: z.object({ summary: textSchema, declaredAt: z.string(),
    /** PRs whose deploy Follow-up could not confirm when Done was accepted ("Deploy not confirmed by Follow-up"). */
    unconfirmed: z.array(z.string()).optional() }).nullable(),
  /** The main agent declared Done while only Follow-up's own waits remained (a rollout, a refresh); recorded as Done once they clear. */
  declaration: z.object({ summary: textSchema, at: z.string() }).nullable().optional(),
  /** Why the worker holds queued repairs although nothing in this record blocks them (unloaded/long-idle agent, setup). */
  sendWait: z.enum(["stale", "limit", "setup", "unloaded"]).nullable().optional(),
  updatedAt: z.string(), managedDoneLabel: z.boolean(),
  runtimeReason: z.string().nullable(), runtimeBusy: z.boolean(), backgroundBusy: z.boolean().default(false),
  /**
   * What the main agent itself is doing that holds a repair (Q96 = A, invariant a-repair-goes-to-a-free-main-agent): its
   * own turn, its own background job while Wait for background jobs is on, a permission prompt or question, a Session
   * Guard pause or a compaction. Set with runtimeBusy, by the same read
   * (server/daemon.ts observe). runtimeBusy and backgroundBusy stay the whole workspace (Done, "all work finished");
   * other agents and subagents never land here. Absent (a record no refresh has read yet): unknown, so the send
   * decision treats the workspace's busy as the main agent's (Unknown is not off).
   */
  mainBusy: z.enum(["turn", "jobs", "permission", "guard", "compacting"]).nullable().optional(),
  /** Live state of the agents this workspace's working tasks name, refreshed with runtimeBusy from Paseo's agent list
   * (metadata only). Every surface that says a task's agent is working reads this, never the stored status alone. */
  taskAgents: z.record(z.string(), z.object({ title: z.string().nullable(), state: z.enum(["working", "idle", "closed", "archived"]) })).optional(),
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
  /**
   * Messages to this workspace's agents with no card of their own (Overseer forwards, reports handed to an agent) that
   * didn't go out: Failed, or Queued past MESSAGE_STUCK_MS. The message queue writes it (server/message-queue.ts) and
   * clears an entry once its item is sent or cancelled; Needs you shows each with Retry and Cancel.
   */
  undelivered: z.array(z.object({ id: z.string().max(400), agentId: idSchema, agentTitle: z.string().nullable(), state: z.enum(["queued", "failed"]), reason: z.string().nullable(), since: z.string() })).max(20).optional(),
  /**
   * Follow-up is holding back its GitHub reads for this workspace's PRs until `until` (GitHub's reset): the account's
   * GraphQL budget is under the reserve Follow-up leaves for agents (shared/poll.ts). Null or absent: reads run.
   */
  githubWait: z.object({ until: z.string() }).nullable().optional(),
  /**
   * GitHub is off on the host (works-without-github): the CLI is missing or signed out, so this workspace's PRs aren't
   * read. Set only on a workspace with PRs. Null or absent: GitHub is on.
   */
  githubOff: z.enum(GITHUB_OFF).nullable().optional(),
  /** The main agent's title from Paseo, for "Next message to <title>". Absent: "the main agent". */
  mainAgentTitle: z.string().nullable().optional(),
  /** Open tasks kept out of the next message (reconcile): capped (sent NO_PROGRESS_CAP times unchanged), manual (Auto off for that task) or person (the agent said only a person can move it: Batch.humanOnly). */
  heldTasks: z.array(z.object({ task: taskSchema, held: z.enum(["capped", "manual", "person"]) })).optional(),
  /** Task keys the developer keeps for themselves: never auto-sent (shared/send-decision.ts). */
  manualTasks: z.array(z.string()).optional(),
  /** Per condition ("<key>:<fingerprint>"), the unacknowledged sends counted when the developer pressed Retry. */
  taskRetries: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** The exact text of the next message (the pending batch's prompt without its id line), for Preview and workspace_status. */
  nextMessage: z.string().nullable().optional(),
  /**
   * What each agent said it is working on toward the goal (sync_workspace `milestone`), by agent id. Read by `nowOf`
   * (shared/now.ts) for the line on every surface. Cleared at Done and when the agent leaves the workspace.
   */
  milestones: z.record(z.string(), storedMilestoneSchema).optional(),
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
  /**
   * Days without a user message to the main agent before a followed workspace goes dormant and its repairs wait for the
   * developer's Send (Q177; Settings → Following → Advanced). Absent means 3.
   */
  activeWindowDays: z.number().int().min(1).max(60).optional(),
  /** Invariant 133: the most Auto-send turns running at once, machine-wide (Settings → Following → Advanced). Absent means 2. */
  maxAutoSends: z.number().int().min(1).max(10).optional(),
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

export function settled(pr: ListPr): boolean {
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
export function completionGate(w: ListWorkspace, now = Date.now()): CompletionGate {
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
    if (pr.error || !pr.snapshot?.complete || !pr.snapshot.observedAt || now - Date.parse(pr.snapshot.observedAt) > OBSERVATION_FRESH_MS) { add("wait", `Refresh status for ${ref}`); continue; }
    if (pr.snapshot.state === "CLOSED") add("agent", `Settle ${ref} with a disposition`);
    else add("developer", `Settle ${ref}`);
  }
  for (const o of followUpObligations(w).filter(o => !finishedTask(o))) add(waitsOnDeveloper(o, w.questions ?? []) ? "developer" : "agent", o.title);
  for (const o of followUpObligations(w).filter(o => o.status === "done" && o.communication && !replyRecorded(o.communication))) add("agent", `Record the sent reply for ${o.title}`);
  const open = w.batches.filter(b => !recoveryBatch(b) && !completionCheck(b));
  if (open.some(b => ["sending", "sent"].includes(b.state))) add("agent", "Acknowledge the open follow-up batch");
  if (open.some(b => ["blocked", "uncertain"].includes(b.state) && !b.movedOn)) add("developer", "Retry or dismiss the stuck follow-up batch");
  if (open.some(b => b.state === "pending")) add("developer", "Send or dismiss the queued repairs");
  if (w.prActions.some(a => ["sending", "uncertain"].includes(a.state))) add("developer", "Check the outstanding PR action");
  for (const q of (w.questions ?? []).filter(questionOpen)) add("developer", `Answer or withdraw ${q.id} (${q.title})`);
  if (w.hold) add("developer", w.hold);
  if (w.runtimeBusy) add("wait", "Wait for active agent work to finish");
  if (w.backgroundBusy) add("wait", "Wait for background agents and jobs to finish");
  if (w.runtimeReason) add("wait", w.runtimeReason);
  return { blockers, unconfirmed };
}
export function completionBlockers(w: ListWorkspace, now = Date.now()): string[] {
  return completionGate(w, now).blockers.map(b => b.text);
}
/** Only new work or contrary evidence takes a Done back; waiting and observation gaps never do. */
export function revokesDone(w: ListWorkspace, now = Date.now()): boolean {
  return completionGate(w, now).blockers.some(b => b.owner !== "wait" || b.contrary);
}
export type Status = "active" | "handling" | "waiting" | "needs-you" | "done";
/** The first working task whose recorded agent is running right now (invariant `a-task-only-says-working-when-its-agent-is`). */
export function liveWorkingTask<W extends ListWorkspace>(w: W): W["obligations"][number] | undefined {
  return followUpObligations(w).find(o => o.status === "working" && !!o.workingAgentId && w.taskAgents?.[o.workingAgentId]?.state === "working");
}
export function summary(w: ListWorkspace, now = Date.now()): { status: Status; label: string; reason: string } {
  const obligations = followUpObligations(w);
  if (w.hold) return { status: "needs-you", label: "Needs you", reason: w.hold };
  const blocked = w.batches.find(b => !recoveryBatch(b) && ["blocked", "uncertain"].includes(b.state) && !b.movedOn && !(w.completion && completionCheck(b)));
  if (blocked) return { status: "needs-you", label: "Needs you", reason: blocked.result || "Follow-up needs a decision" };
  const question = (w.questions ?? []).find(questionOpen);
  if (question) return { status: "needs-you", label: "Needs you", reason: `${question.id}: ${question.title}` };
  const obligation = obligations.find(o => waitsOnDeveloper(o, w.questions ?? []));
  if (obligation) return { status: "needs-you", label: "Needs you", reason: obligation.title };
  if (w.completion && completionBlockers(w, now).length === 0) return { status: "done", label: "Done", reason: w.completion.summary };
  if (w.runtimeReason) return { status: "waiting", label: "Waiting", reason: w.runtimeReason };
  const batch = w.batches.find(b => !recoveryBatch(b) && ["pending", "sending", "sent"].includes(b.state) && !(b.state === "pending" && completionCheck(b)));
  if (batch) return { status: batch.state === "pending" ? "active" : "handling", label: batch.state === "pending" ? w.enable_auto_sends ? "Auto queued" : "Ready to send" : "Agent handling", reason: `${sendItems(batch.tasks)} ${batch.state === "pending" ? "queued" : batch.recipientAgentId && batch.recipientAgentId !== w.mainAgentId ? "sent to the recovery agent" : "sent to the main agent"}` };
  const live = liveWorkingTask(w);
  if (w.runtimeBusy || live) return { status: "handling", label: "Agent handling", reason: live?.title ?? (w.mainBusy === null ? "Agents in this workspace are working" : "The main agent is working") };
  if (w.prs.some(pr => !statusKnown(pr))) return { status: "waiting", label: "Waiting", reason: "PR status unavailable; refresh will retry" };
  const pending = obligations.find(o => !finishedTask(o));
  if (pending) return { status: pending.status === "waiting" ? "waiting" : "active", label: pending.status === "waiting" ? "Waiting" : "Active", reason: pending.title };
  if (w.prs.some(pr => !settled(pr))) return { status: "waiting", label: "Waiting", reason: "Waiting for PR review, checks, or merge" };
  return { status: "active", label: "Active", reason: "The main agent has not declared completion" };
}
