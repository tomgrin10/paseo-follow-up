import { projectSchema } from "./settings";
import { renameResultSchema, renameStatusSchema } from "./rename";
import { MAX_REVIEWERS, REPO, reviewerConfigSchema, reviewerEntrySchema, reviewerListSchema } from "./reviewers";
import { prioritySchema } from "./priorities";
import { usageSchema } from "./usage";
import { aboutViewSchema } from "./about";
import { LINKED_KINDS, linkedItemSchema } from "./linked";
import { AGENT_ROLES, agentSettingsViewSchema, savedRoleSchema } from "./agent-settings";
import { defineRpc, type PluginSubscriptionContract } from "@getpaseo/plugin";
import { ONBOARDING_ACTIONS, ONBOARDING_STEPS, checksSchema, onboardingViewSchema } from "./onboarding";
import { z } from "zod";
import { inboxRowSchema } from "./inbox";
import { briefSchema } from "./brief";
import { idSchema, textSchema, workspaceSchema } from "./model";
import { listEntrySchema } from "./list";
import { communicationSchema } from "./communication";
import { taskTriggerSchema } from "./task-trigger";
import { QUESTION_MODES, questionSchema } from "./questions";
import { specSchema } from "./spec";
import { HOME_GROUPS } from "./home";
import { prWorkflowViewSchema, setPrWorkflowInputSchema } from "./pr-workflow";
import { setUpdatesInputSchema, updatesViewSchema } from "./updates";
import { releaseNotesViewSchema } from "./changelog";
import { actionPlanSchema, actionResultSchema, browserCommandSchema, browserExchangeSchema, browserPrSchema, browserStatusSchema, prActionKind } from "./pr-actions";

const agentCommunicationSchema = z.strictObject({
  threadUrl: communicationSchema.shape.threadUrl, recipient: communicationSchema.shape.recipient,
  purpose: communicationSchema.shape.purpose.unwrap().optional(), authorization: communicationSchema.shape.authorization.unwrap().optional(), replyUrl: communicationSchema.shape.replyUrl.unwrap().optional(),
});

/**
 * Tracked workspaces. 1.3.0-beta.4: pass the `revision` you hold as `since` to get only what changed (`full` false,
 * plus `removed` ids). Without it, or when it's too old, the answer is the full list.
 */
export const listRpc = defineRpc({ name: "follow.list", input: z.object({ since: z.number().optional() }), output: z.object({ workspaces: z.array(listEntrySchema), error: z.string().nullable(), revision: z.number().optional(), full: z.boolean().optional(), removed: z.array(z.string()).optional() }) });
export const getRpc = defineRpc({ name: "follow.get", input: z.object({ workspaceId: idSchema }), output: z.object({ workspace: workspaceSchema.nullable(), error: z.string().nullable() }) });
/** `prWorkflow` (1.4.0-beta.14): how this workspace ships PRs (graphite | github) and its review-fix command (null: built-in steps). */
export const agentStatusRpc = defineRpc({ name: "follow.agent-status", input: z.strictObject({ agentId: idSchema, detail: z.enum(["summary", "full"]).optional() }), output: workspaceSchema.extend({ prWorkflow: z.object({ mode: z.enum(["graphite", "github"]), reviewFix: z.string().nullable() }).optional(), /** The next message: recipient, tasks, exact text, and when and why it goes (Preview's agent form). */ nextMessageInfo: z.object({ to: z.string(), tasks: z.array(z.string()), text: z.string(), reason: z.string(), eta: z.string().nullable() }).nullable().optional() }) });
export const syncWorkspaceRpc = defineRpc({ name: "follow.sync", input: z.strictObject({ agentId: idSchema, summary: z.string().trim().min(1).max(1000) }), output: z.object({ workspaceId: idSchema, synced: z.literal(true) }) });
export const enrollRpc = defineRpc({ name: "follow.enroll", input: z.strictObject({ workspaceId: idSchema.optional(), agentId: idSchema, goal: textSchema }), output: workspaceSchema });
export const registerPrRpc = defineRpc({ name: "follow.register-pr", input: z.strictObject({ agentId: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), stack: textSchema, parentNumber: z.number().int().positive().nullable().optional(), disposition: z.string().max(2000).optional(), agentMerges: z.boolean().optional() }), output: workspaceSchema });
export const obligationRpc = defineRpc({ name: "follow.obligation", input: z.strictObject({ agentId: idSchema, workingAgentId: idSchema.optional(), id: idSchema.optional(), title: textSchema, status: z.enum(["pending", "waiting", "working", "blocked", "done", "waived"]), afterPrs: z.array(idSchema).optional(), dependencyStage: z.enum(["merged", "deployed"]).optional(), evidence: z.string().max(4000).optional(), ask: z.string().trim().min(1).max(1000).optional(), enable_follow_up: z.boolean().optional(), communication: agentCommunicationSchema.optional(), trigger: taskTriggerSchema.strict().nullable().optional() }), output: workspaceSchema.extend({ updatedObligationId: idSchema }) });
export const declareDoneRpc = defineRpc({ name: "follow.done", input: z.strictObject({ agentId: idSchema, summary: textSchema }), output: z.object({ workspace: workspaceSchema, blockers: z.array(z.string()), unconfirmed: z.array(z.string()).default([]), alreadyDone: z.boolean().default(false), next: z.string().default("") }) });
export const acknowledgeRpc = defineRpc({ name: "follow.acknowledge", input: z.strictObject({ agentId: idSchema, batchId: idSchema, outcome: z.enum(["completed", "blocked"]), result: textSchema }), output: workspaceSchema });
export const controlRpc = defineRpc({ name: "follow.control", input: z.object({ workspaceId: idSchema, enable_auto_sends: z.boolean().optional(), clearHold: z.boolean().optional(), retryBatchId: idSchema.optional(), /** Retry one capped task (Q49): its key. */ retryTask: z.string().max(400).optional(), /** Auto per task: a task key and whether Follow-up sends it. */ taskAuto: z.object({ key: z.string().max(400), auto: z.boolean() }).optional(), /** The developer's "Make main agent": one of the workspace's other root agents. */ mainAgentId: idSchema.optional(),
  /** Later on a workspace-only Needs-you row; null is Bring back now. */ snooze: z.object({ until: z.string().trim().min(1).max(200) }).nullable().optional() }), output: workspaceSchema });
export const refreshRpc = defineRpc({ name: "follow.refresh", input: z.object({ workspaceId: idSchema.optional() }), output: z.object({ ok: z.boolean() }) });

export const activateRpc = defineRpc({ name: "follow.activate", input: z.object({ workspaceId: idSchema }), output: workspaceSchema });
export const sendRpc = defineRpc({ name: "follow.send", input: z.object({ workspaceId: idSchema, batchId: idSchema }), output: workspaceSchema });
export const recoverRpc = defineRpc({ name: "follow.recover", input: z.object({ workspaceId: idSchema }), output: workspaceSchema });

export const excludeStackRpc = defineRpc({ name: "follow.exclude-stack", input: z.strictObject({ agentId: idSchema, stack: textSchema, reason: textSchema, obligationIds: z.array(idSchema).default([]) }), output: workspaceSchema });

export const browserExchangeRpc = defineRpc({ name: "follow.browser-exchange", input: browserExchangeSchema, output: z.object({ jobs: z.array(browserCommandSchema), accepted: z.array(idSchema), repositories: z.array(browserPrSchema.shape.repo).max(100).optional() }) });
export const browserStatusRpc = defineRpc({ name: "follow.browser-status", input: z.object({}), output: browserStatusSchema });
export const prControlStatusRpc = defineRpc({ name: "follow.pr-control-status", input: z.object({ workspaceId: idSchema, prKey: idSchema }), output: z.object({ browser: browserStatusSchema, pr: browserPrSchema.nullable(), error: z.string().nullable() }) });
export const preparePrActionRpc = defineRpc({ name: "follow.prepare-pr-action", input: z.object({ workspaceId: idSchema, prKey: idSchema, kind: prActionKind }), output: actionPlanSchema });
export const confirmPrActionRpc = defineRpc({ name: "follow.confirm-pr-action", input: z.object({ planId: idSchema, scope: z.enum(["target", "downstack"]) }), output: actionResultSchema });
export const checkPrActionRpc = defineRpc({ name: "follow.check-pr-action", input: z.object({ workspaceId: idSchema, actionId: idSchema }), output: actionResultSchema });
/** `reviewers` picks who to ask for this PR only (the picker); `remember` also saves them as the repository's list. */
export const requestReviewersRpc = defineRpc({ name: "follow.request-reviewers", input: z.object({ workspaceId: idSchema, prKey: idSchema, reviewers: z.array(reviewerEntrySchema).min(1).max(MAX_REVIEWERS).optional(), remember: z.boolean().optional() }), output: actionResultSchema });
/** `noReview`: the repositories set to No review (pr-workflow.json), so the client's Needs you agrees with the server's. */
const reviewerSettingsSchema = z.object({ config: reviewerConfigSchema, repos: z.array(z.string()), noReview: z.array(z.string()).default([]) });
/** Settings → Reviewers: the saved lists and the repositories Follow-up has seen PRs in. */
export const reviewerSettingsRpc = defineRpc({ name: "follow.reviewer-settings", input: z.object({}), output: reviewerSettingsSchema });
/** `repo: null` is the default for all repos. An empty list clears it. */
export const saveReviewersRpc = defineRpc({ name: "follow.save-reviewers", input: z.object({ repo: z.string().regex(REPO).nullable(), reviewers: reviewerListSchema }), output: reviewerSettingsSchema });
/** Autocomplete from the repository's collaborators and teams. Read on demand and cached; never polled. */
export const reviewerSuggestionsRpc = defineRpc({ name: "follow.reviewer-suggestions", input: z.object({ repo: z.string().regex(REPO) }), output: z.object({ suggestions: z.array(z.object({ login: z.string(), name: z.string().nullable(), kind: z.enum(["user", "team"]) })), error: z.string().nullable() }) });

export const projectSettingsRpc = defineRpc({ name: "follow.project-settings", input: z.object({}), output: z.object({ projects: z.array(projectSchema) }) });
export const setProjectTrackingRpc = defineRpc({ name: "follow.set-project-tracking", input: z.object({ projectId: idSchema, enable_default_tracking: z.boolean() }), output: z.object({ projects: z.array(projectSchema) }) });
/** Following (1.3.0-beta.2): the two global switches and the per-workspace exceptions, for Settings only. */
const followSettingsSchema = z.object({
  enable_follow_every: z.boolean(), enable_auto_sends_default: z.boolean(),
  /** Days without a user message before a followed workspace goes dormant (1.3.0-beta.3). */
  activeWindowDays: z.number().int().optional(),
  workspaces: z.array(z.object({ id: idSchema, title: z.string(), enable_tracking: z.boolean(), enable_auto_sends: z.boolean(), optedOut: z.boolean(), dormant: z.boolean().optional(), parked: z.boolean().optional() })),
});
export const followSettingsRpc = defineRpc({ name: "follow.follow-settings", input: z.object({}), output: followSettingsSchema });
export const setFollowSettingsRpc = defineRpc({ name: "follow.set-follow-settings", input: z.object({
  enable_follow_every: z.boolean().optional(), enable_auto_sends_default: z.boolean().optional(),
  activeWindowDays: z.number().int().min(1).max(60).optional(),
  workspace: z.object({ workspaceId: idSchema, follow: z.boolean().optional(), enable_auto_sends: z.boolean().optional() }).optional(),
}), output: followSettingsSchema });
/** External priorities for Home's Priority sort (written by the set_priorities agent tool). */
export const prioritiesRpc = defineRpc({ name: "follow.priorities", input: z.object({}), output: z.object({ items: z.array(prioritySchema) }) });
/** Provider session limits from the Smart Session plugin, for Home's meters. Hidden when it isn't installed. */
/** Summary: collapsed reads the cache; open may start an overview; refresh always does. */
export const workspaceAboutRpc = defineRpc({ name: "follow.workspace-about", input: z.object({ workspaceId: idSchema, open: z.boolean().optional(), refresh: z.boolean().optional() }), output: aboutViewSchema });
// Rename with AI (shared/rename.ts): the dialog's state and one suggestion, and the rename or its Undo.
export const renameStatusRpc = defineRpc({ name: "follow.rename-status", input: z.object({ workspaceId: idSchema, suggest: z.boolean().optional() }), output: renameStatusSchema });
export const renameWorkspaceRpc = defineRpc({ name: "follow.rename-workspace", input: z.object({ workspaceId: idSchema, title: z.string().max(300).optional(), undo: z.boolean().optional() }), output: renameResultSchema });
export const usageRpc = defineRpc({ name: "follow.usage", input: z.object({}), output: usageSchema });
// Trust bypass agents: how many permission prompts were approved today, and the newest few (tool and a short summary).
export const trustBypassRpc = defineRpc({ name: "follow.trust-bypass", input: z.object({}), output: z.object({ today: z.number().int().nonnegative(), recent: z.array(z.object({ at: z.string(), agentId: z.string(), tool: z.string(), summary: z.string(), mode: z.string() })).max(20) }) });
export const refineTasksRpc = defineRpc({ name: "follow.refine-tasks", input: z.object({ workspaceId: idSchema, tasks: z.array(z.object({ id: idSchema, title: textSchema, afterPrs: z.array(idSchema), dependencyStage: z.enum(["merged", "deployed"]), enable_follow_up: z.boolean(), communication: communicationSchema.optional(), trigger: taskTriggerSchema.nullable().optional() })).max(50) }), output: workspaceSchema });
export const taskTriggerRpc = defineRpc({ name: "follow.set-task-trigger", input: z.object({ workspaceId: idSchema, obligationId: idSchema, expectedRevision: z.number().int().nonnegative(), trigger: taskTriggerSchema.nullable(), afterPrs: z.array(idSchema) }), output: workspaceSchema });

// Narrow integration: no inventory, messages, paths, or credentials cross this RPC.
export const prOwnerRpc = defineRpc({ name: "follow.pr-owner", input: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }), output: z.object({ owner: z.object({ workspaceId: idSchema, agentId: idSchema }).nullable() }) });
// Read-only browser view of who owns a PR: titles, ids, agent status and Follow-up's one line. Nothing else.
// `tracked: false` means the repository is outside the scope Follow-up advertises to the browser, so nothing is returned.
export const prWorkspacesRpc = defineRpc({ name: "follow.pr-workspaces", input: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }), output: z.object({ tracked: z.boolean(), more: z.number().int().nonnegative(), workspaces: z.array(z.object({ workspaceId: idSchema, agentId: idSchema, title: z.string().max(200), agentStatus: z.string().max(40), group: z.enum(HOME_GROUPS), state: z.string().max(200) })).max(3) }) });

// Questions. Agents ask, record an answer given in chat, or withdraw; the developer answers from the UI.
const optionInput = z.strictObject({ letter: z.string().regex(/^[A-Z]$/), label: z.string().trim().min(1).max(200), consequence: z.string().trim().max(600).optional() });
const linkInput = z.strictObject({ url: z.string().url().optional(), path: z.string().trim().min(1).max(1000).optional(), label: z.string().trim().max(200).optional() });
export const askQuestionRpc = defineRpc({ name: "follow.ask-question", input: z.strictObject({
  agentId: idSchema, title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(2000),
  options: z.array(optionInput).max(26).optional(), recommend: z.string().trim().max(200).optional(), big: z.string().trim().max(300).optional(),
  background: z.string().trim().max(4000).optional(), links: z.array(linkInput).max(10).optional(),
  pr: z.string().trim().max(200).optional(), task: idSchema.optional(), supersedes: z.string().regex(/^Q\d+$/).optional(),
}), output: z.object({ workspaceId: idSchema, question: questionSchema, mode: z.enum(QUESTION_MODES), instruction: z.string(),
  outcome: z.enum(["asked", "duplicate", "superseded"]).default("asked"), of: z.string().nullable().default(null) }) });
export const recordAnswerRpc = defineRpc({ name: "follow.record-answer", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional() }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
export const withdrawQuestionRpc = defineRpc({ name: "follow.withdraw-question", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), reason: z.string().trim().min(1).max(500) }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
export const answerQuestionRpc = defineRpc({ name: "follow.answer-question", input: z.object({ workspaceId: idSchema, questionId: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional(), action: z.enum(["send", "copy", "chat", "resend"]) }), output: z.object({ workspace: workspaceSchema, question: questionSchema }) });
export const setSpecRpc = defineRpc({ name: "follow.set-spec", input: z.strictObject({ agentId: idSchema, url: z.string().trim().min(1).max(2000), title: z.string().trim().max(120).optional() }), output: z.object({ workspaceId: idSchema, spec: specSchema.nullable(), applied: z.boolean(), message: z.string() }) });
export const workspaceSpecRpc = defineRpc({ name: "follow.workspace-spec", input: z.discriminatedUnion("action", [
  z.object({ workspaceId: idSchema, action: z.literal("set"), url: z.string().trim().min(1).max(2000), title: z.string().trim().max(120).nullable().optional() }),
  z.object({ workspaceId: idSchema, action: z.literal("remove") }),
  z.object({ workspaceId: idSchema, action: z.literal("reset") }),
]), output: workspaceSchema });

// Linked items (shared/linked.ts). The agent's own: link_item / unlink_item, for its workspace (main or contributor).
const linkRef = z.string().trim().min(1).max(2000);
const linkReceipt = z.object({ workspaceId: idSchema, ok: z.boolean(), key: z.string().nullable(), pending: z.boolean(), message: z.string() });
export const linkItemRpc = defineRpc({ name: "follow.link-item", input: z.strictObject({ agentId: idSchema, ref: linkRef, why: z.string().trim().max(140).optional(), title: z.string().trim().max(200).optional() }), output: linkReceipt });
export const unlinkItemRpc = defineRpc({ name: "follow.unlink-item", input: z.strictObject({ agentId: idSchema, ref: linkRef, reason: z.string().trim().min(1).max(200) }), output: linkReceipt });
const linkedViewSchema = z.object({
  workspaceId: idSchema, items: z.array(linkedItemSchema.extend({ spec: z.boolean() })),
  excluded: z.array(z.object({ key: z.string(), at: z.string(), by: z.string(), reason: z.string().nullable() })),
  counts: z.record(z.string(), z.number()), pending: z.number(),
});
// The developer's list: read any workspace's items, add one by hand, remove one, or undo a removal.
export const linkedItemsRpc = defineRpc({ name: "follow.linked-items", input: z.strictObject({ workspaceId: idSchema }), output: linkedViewSchema });
export const setLinkedItemsRpc = defineRpc({ name: "follow.set-linked-items", input: z.discriminatedUnion("action", [
  z.strictObject({ workspaceId: idSchema, action: z.literal("add"), ref: linkRef, title: z.string().trim().max(200).optional() }),
  z.strictObject({ workspaceId: idSchema, action: z.literal("remove"), ref: linkRef }),
  z.strictObject({ workspaceId: idSchema, action: z.literal("undo"), ref: linkRef }),
]), output: linkedViewSchema.extend({ message: z.string().nullable() }) });
/**
 * Home's search over linked keys and titles, every workspace at once. Home fetches it only while its search field has
 * text (and keeps it a minute), so the list's poll never reads linked.json.
 */
export const linkedIndexRpc = defineRpc({ name: "follow.linked-index", input: z.strictObject({}), output: z.object({
  workspaces: z.record(z.string(), z.array(z.object({ key: z.string(), kind: z.enum(LINKED_KINDS), title: z.string().nullable() }))),
}) });

// Needs-you inbox. Names stay under follow. like the rest of the plugin.
/**
 * `etag` (1.4.0): the client sends the tag of the answer it holds; when nothing changed the reply is
 * `{ unchanged: true }` with empty rows instead of the whole list again. Older clients omit it and get full answers.
 */
export const inboxListRpc = defineRpc({ name: "follow.inbox-list", input: z.object({ etag: z.string().max(64).optional() }), output: z.object({ etag: z.string().optional(), unchanged: z.boolean().optional(), enabled: z.boolean(), rows: z.array(inboxRowSchema), unsorted: z.array(inboxRowSchema).nullable(), firstRun: z.boolean(), batchUndo: z.object({ at: z.string(), count: z.number().int() }).nullable(), signOffs: z.number().int(), error: z.string().nullable(),
  /** Adoption share of needs_you over the last 7 days of flagged turns (R2). Optional for older daemons. */
  briefStats: z.object({ days: z.number().int(), total: z.number().int(), tool: z.number().int(), structured: z.number().int(), extraction: z.number().int(), fallback: z.number().int() }).optional(),
  /** The Overseer's own row (1.4.0-beta.0), kept out of rows and every Needs-you count. */
  overseer: inboxRowSchema.nullable().optional(),
  /** PRs in No review repositories that hand their merge back (shared/pr-workflow.ts handsMergeBack). Usually empty. */
  handedBack: z.array(z.string()).optional() }) });
export const inboxActRpc = defineRpc({ name: "follow.inbox-act", input: z.strictObject({
  action: z.enum(["sign_off", "undo", "snooze", "unsnooze", "mute_turn", "set_finish_flags", "unsorted_flag", "unsorted_sign_off", "batch_undo"]),
  agentIds: z.array(idSchema).max(500).optional(), seqs: z.record(z.string(), z.number().int()).optional(),
  until: z.string().max(200).optional(), value: z.boolean().optional(), muteTurn: z.boolean().optional(),
}), output: z.object({ results: z.array(z.object({ agentId: z.string(), ok: z.boolean(), cameBack: z.boolean() })) }) });

// The brief ("what you need to do"). needs_you comes from the agent's bridge; brief-action from the card.
const needsYouOption = z.strictObject({ label: z.string(), consequence: z.string().optional() });
export const needsYouRpc = defineRpc({ name: "follow.needs-you", input: z.strictObject({
  agentId: idSchema, ask: z.string(), kind: z.enum(["decision", "action", "review", "done"]),
  decisions: z.array(z.strictObject({ question: z.string(), options: z.array(needsYouOption).optional(), recommend: z.number().int().optional() })).optional(),
  questions: z.array(z.string()).optional(),
  context: z.string().optional(),
  links: z.array(z.strictObject({ label: z.string(), url: z.string().optional(), path: z.string().optional(), pr: z.string().optional() })).optional(),
}), output: z.object({ ok: z.literal(true), briefId: z.string() }) });
/** Home's detail pane: the full stored brief for one agent (the list carries only its one-liner). */
export const inboxBriefRpc = defineRpc({ name: "follow.inbox-brief", input: z.strictObject({ agentId: idSchema }), output: z.object({ brief: briefSchema.nullable() }) });
/** An option letter, or "other" (Something else, which needs words). */
export const briefChoiceSchema = z.string().regex(/^(?:[A-Z]|other)$/);
export const briefActionRpc = defineRpc({ name: "follow.brief-action", input: z.strictObject({
  agentId: idSchema, briefId: z.string().max(300), decisionId: z.string().max(20).optional(), choice: briefChoiceSchema.optional(), words: z.string().trim().max(2000).optional(), move: z.enum(["retry", "done"]).optional(),
  /** 1.4.0: every pick of a multi-decision card, sent together. "other" is Something else, with the words. */
  choices: z.array(z.object({ decisionId: z.string().max(20), choice: briefChoiceSchema, words: z.string().trim().max(2000).optional() })).min(1).max(10).optional(),
  /** One per Send, reused on Retry: the same answer is recorded and sent once (server/inbox.ts briefAction). */
  answerId: z.string().regex(/^[\w-]{8,80}$/).optional(),
}), output: z.object({ brief: briefSchema }) });

// Agent parity: one RPC carries every agent tool; the server runs the same path as the developer's button.
export const agentActRpc = defineRpc({ name: "follow.agent-act", input: z.strictObject({ agentId: idSchema, tool: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }), output: z.unknown() });

// The Overseer (1.4.0-beta.0).
export const overseerStatusSchema = z.object({ enabled: z.boolean(), agentId: z.string().nullable(), workspaceId: z.string().nullable(), startedAt: z.string().nullable(), generation: z.number().int(), error: z.string().nullable(),
  /** What it runs on ("Claude · Opus 5.5") and, when Settings → Agents changed since, what a restart would use. */
  model: z.string().nullable().default(null), restartWith: z.string().nullable().default(null), configured: z.string().nullable().default(null) });
export const overseerStatusRpc = defineRpc({ name: "follow.overseer-status", input: z.object({}), output: overseerStatusSchema });
export const overseerStartRpc = defineRpc({ name: "follow.overseer-start", input: z.object({}), output: overseerStatusSchema });
export const overseerAskRpc = defineRpc({ name: "follow.overseer-ask", input: z.strictObject({ text: z.string().trim().min(1).max(2000) }), output: overseerStatusSchema });
export const rankStatusSchema = z.object({ enabled: z.boolean(), running: z.boolean(), lastRunAt: z.string().nullable(), healthLine: z.string(), error: z.string().nullable(), costUsd: z.number().nullable(), notStarted: z.number().int(),
  last: z.object({ ok: z.boolean(), skipped: z.string().nullable(), top: z.string().nullable(), provider: z.string().nullable(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }).nullable() });
export const rankStatusRpc = defineRpc({ name: "follow.rank-status", input: z.object({}), output: rankStatusSchema });
/** Starts a ranking and returns at once (a slow model outlasts the plugin RPC timeout); poll follow.rank-status. */
export const rankNowRpc = defineRpc({ name: "follow.rank-now", input: z.strictObject({ force: z.boolean().optional() }), output: z.object({ started: z.boolean(), running: z.boolean() }) });
export const overseerActRpc = defineRpc({ name: "follow.overseer-act", input: z.strictObject({ agentId: idSchema, tool: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }), output: z.unknown() });
export const overseerRestartRpc = defineRpc({ name: "follow.overseer-restart", input: z.object({}), output: overseerStatusSchema });
/** Settings → Agents. `catalog` asks for Paseo's provider list (cached ten minutes; `fresh` re-reads it). */
export const agentSettingsRpc = defineRpc({ name: "follow.agent-settings", input: z.object({ catalog: z.boolean().optional(), fresh: z.boolean().optional() }), output: agentSettingsViewSchema });
export const setAgentSettingRpc = defineRpc({ name: "follow.set-agent-setting", input: z.strictObject({ role: z.enum(AGENT_ROLES), entry: savedRoleSchema.nullable() }), output: agentSettingsViewSchema });
/** Settings → Agents → Wait for background jobs (1.4.0-beta.24). Applies to sessions opened afterwards. */
export const setWaitRpc = defineRpc({ name: "follow.set-wait", input: z.strictObject({ enable_wait: z.boolean() }), output: agentSettingsViewSchema });

// Getting started (1.4.0-beta.10): the setup flow's progress and its readiness checks. Choices write through the
// Settings screen's own RPCs and settings documents; these only hold where the flow is.
export const onboardingRpc = defineRpc({ name: "follow.onboarding", input: z.object({}), output: onboardingViewSchema });
export const setOnboardingRpc = defineRpc({ name: "follow.set-onboarding", input: z.strictObject({ action: z.enum(ONBOARDING_ACTIONS), step: z.enum(ONBOARDING_STEPS).optional() }), output: onboardingViewSchema });
/** Run on demand while the flow is open, cached a minute; `fresh` is Check again. Never polled. */
export const onboardingChecksRpc = defineRpc({ name: "follow.onboarding-checks", input: z.object({ fresh: z.boolean().optional() }), output: checksSchema });
/**
 * Settings → Following → Shipping PRs, and onboarding's "How do you ship PRs?": the global default, each repository's
 * setting and what auto detected (filesystem checks only, cached; `refresh` re-checks). Never polled.
 */
export const prWorkflowRpc = defineRpc({ name: "follow.pr-workflow", input: z.object({ refresh: z.boolean().optional() }), output: prWorkflowViewSchema });
/** `{ repo, setting }` sets one repository (`setting: null` inherits the default); `default` sets the default. */
export const setPrWorkflowRpc = defineRpc({ name: "follow.set-pr-workflow", input: setPrWorkflowInputSchema, output: prWorkflowViewSchema });
/** What's new and the release notes: this host's version record and every shipped note. Never polled. */
export const releaseNotesRpc = defineRpc({ name: "follow.release-notes", input: z.object({}), output: releaseNotesViewSchema });
/** What's new was closed for `version`: the host-wide record, for apps without local storage. Only moves forward. */
export const whatsNewSeenRpc = defineRpc({ name: "follow.whats-new-seen", input: z.strictObject({ version: z.string().max(64) }), output: releaseNotesViewSchema });
/**
 * Settings → General (and onboarding's Updates step). `check` asks the registry now: "settings" when the screen opens
 * (skipped when a check ran in the last minute, or Mode is Off), "manual" for Check now. Without it, no request.
 */
export const updatesRpc = defineRpc({ name: "follow.updates", input: z.strictObject({ check: z.enum(["settings", "manual"]).optional() }), output: updatesViewSchema });
export const setUpdatesRpc = defineRpc({ name: "follow.set-updates", input: setUpdatesInputSchema, output: updatesViewSchema });
/** Install now. Without `anyway` it still waits for a quiet moment; `anyway` installs even with agents mid-turn. */
export const installUpdateRpc = defineRpc({ name: "follow.install-update", input: z.strictObject({ version: z.string().max(64), anyway: z.boolean().optional() }), output: updatesViewSchema });
/** Hides a Home update notice on every device (until the next version, for "available"). */
/** The developer's IANA timezone, from their Follow-up client: an agent tool's "tonight"/"tomorrow" resolve in it. */
export const clientTimeZoneRpc = defineRpc({ name: "follow.client-time-zone", input: z.strictObject({ timeZone: z.string().min(1).max(64) }), output: z.object({ ok: z.boolean() }) });
/** 2.0's move to the new plugin id: ask again after it rolled back or failed (same quiet rule as an update). */
export const retryMoveRpc = defineRpc({ name: "follow.retry-move", input: z.strictObject({}), output: updatesViewSchema });
export const dismissUpdateNoticeRpc = defineRpc({ name: "follow.dismiss-update-notice", input: z.strictObject({ id: z.string().max(120) }), output: updatesViewSchema });

/**
 * Report an issue (server/report-issue/, the sheet in client/report-issue.tsx). The sheet only hands the developer's
 * words to an agent, which files the issue with follow_report_issue after its own dry run and the developer's yes.
 */
export const reportKindSchema = z.enum(["bug", "feature", "feedback"]);
const reportTargetSchema = z.object({ id: idSchema, title: z.string(), provider: z.string(), status: z.string(), workspaceId: z.string().nullable(), workspaceTitle: z.string().nullable(), main: z.boolean() });
/** Who the sheet can send to: live agents (metadata only, nothing is loaded), the default first; where a new one would start. */
export const reportTargetsRpc = defineRpc({ name: "follow.report-issue-targets", input: z.object({ workspaceId: z.string().max(200).optional(), agentId: z.string().max(200).optional() }),
  output: z.object({ agents: z.array(reportTargetSchema), defaultId: z.string().nullable(), newAgentWorkspace: z.object({ id: idSchema, title: z.string() }).nullable() }) });
/** Send to agent: the report prompt goes to `agentId`, or to a new agent started in `newAgentWorkspaceId`. */
export const reportSendRpc = defineRpc({ name: "follow.report-issue-send", input: z.object({ kind: reportKindSchema, text: z.string().max(8000), error: z.string().max(2000).nullable().optional(), agentId: z.string().max(200).optional(), newAgentWorkspaceId: z.string().max(200).optional() }),
  output: z.object({ agentId: idSchema, title: z.string(), started: z.boolean() }) });
/** Open on GitHub (no agent to send to): a prefilled new-issue link carrying the redacted versions block. */
export const reportLinkRpc = defineRpc({ name: "follow.report-issue-link", input: z.object({ kind: reportKindSchema, text: z.string().max(8000) }), output: z.object({ url: z.string() }) });

/**
 * The chat's created-agent / created-workspace cards (shared/created.ts): live facts for the ids they show, from the
 * engine's directory snapshot (the same cached rows the engine and task lines read; no daemon list call, nothing woken)
 * and Follow-up's store.
 */
const followLineSchema = z.object({ question: z.object({ id: z.string(), title: z.string() }).nullable(),
  chips: z.array(z.object({ text: z.string(), tone: z.enum(["success", "danger", "warning", "merged", "muted"]) })), line: z.string().nullable() });
export const createdItemsRpc = defineRpc({ name: "follow.created-items",
  input: z.strictObject({ agentIds: z.array(idSchema).max(40), workspaceIds: z.array(idSchema).max(40) }),
  output: z.object({
    agents: z.record(z.string(), z.object({ title: z.string().nullable(), state: z.enum(["working", "idle", "closed", "archived"]), workspaceId: z.string().nullable(), main: z.boolean() })),
    workspaces: z.record(z.string(), z.object({ name: z.string().nullable(), follow: followLineSchema.nullable() })),
  }) });

/**
 * Subscriptions (Paseo 0.16, `client.subscribe`): the polled reads above as pushes from the worker's own state
 * (server/feeds.ts). Plain objects rather than `defineSubscription`, which a 0.15 host's SDK doesn't have; on 0.15 the
 * client keeps polling the RPCs (`client/feeds.ts`). Each pushes its current value first, then only real changes.
 */
const subscription = <I extends z.ZodType, E extends z.ZodType>(name: string, input: I, event: E): PluginSubscriptionContract<I, E> => ({ name, input, event });
export const workspacesFeed = subscription("follow.workspaces-feed", z.object({ since: z.number().optional() }),
  z.object({ revision: z.number(), full: z.boolean(), workspaces: z.array(listEntrySchema), removed: z.array(z.string()), error: z.string().nullable() }));
export const inboxFeed = subscription("follow.inbox-feed", z.object({}), inboxListRpc.output);
/** Home's extras: priorities, the ranker, the Overseer and the usage meters (without the worker's live resources). */
export const homeFeed = subscription("follow.home-feed", z.object({}), z.object({
  priorities: prioritiesRpc.output.shape.items, rank: rankStatusSchema, overseer: overseerStatusSchema,
  usage: usageSchema.nullable(),
  /** False when Smart Session's data directory can't be watched: the client reads usage once a minute instead. */
  usageLive: z.boolean(),
}));
export const displayFeed = subscription("follow.display-feed", z.object({}), z.object({ status: z.string(), revision: z.string().optional(), values: z.unknown().optional() }));
export const FEEDS = [workspacesFeed, inboxFeed, homeFeed, displayFeed] as const;
