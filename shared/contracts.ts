import { queueViewSchema } from "./queue";
import { briefPlanInputSchema, compassSetSchema, planChangeSchema, queueChangeSchema } from "./morning-brief";
import { sourcesChangeSchema } from "./brief-sources";
import { noteActionSchema } from "./compass";
import { projectSchema } from "./settings";
import { renameResultSchema, renameStatusSchema } from "./rename";
import { MAX_REVIEWERS, REPO, reviewerConfigSchema, reviewerEntrySchema, reviewerListSchema } from "./reviewers";
import { prioritySchema } from "./priorities";
import { sendingSchema } from "./sending";
import { usageSchema } from "./usage";
import { aboutViewSchema } from "./about";
import { LINKED_KINDS, linkedItemSchema } from "./linked";
import { AGENT_ROLES, agentSettingsViewSchema, savedRoleSchema } from "./agent-settings";
import { prStatsInputSchema, prStatsOutputSchema, setPrStatsInputSchema, statsRepoName, statsSettingsViewSchema, statsStatusSchema } from "./pr-stats-settings";
import { defineRpc, type PluginSubscriptionContract } from "@getpaseo/plugin";
import { CONTEXT_ANSWER_MAX, CONTEXT_TARGETS, contextRequestSchema } from "./catch-up";
import { HISTORY_FILTERS, QUESTION_ACTIONS } from "./your-questions";
import { ONBOARDING_ACTIONS, ONBOARDING_STEPS, checksSchema, onboardingViewSchema } from "./onboarding";
import { z } from "zod";
import { actionChangeSchema, dispatchActionSchema, dispatchInputSchema, dispatchRecordSchema, settingsChangeSchema } from "./dispatch";
import { inboxRowSchema } from "./inbox";
import { briefSchema } from "./brief";
import { idSchema, textSchema, workspaceSchema } from "./model";
import { listEntrySchema } from "./list";
import { communicationSchema } from "./communication";
import { taskTriggerInputSchema } from "./task-trigger";
import { QUESTION_MODES, questionSchema } from "./questions";
import { specSchema } from "./spec";
import { milestoneInputSchema, NOW_SOURCES } from "./now";
import { HOME_GROUPS } from "./home";
import { prWorkflowViewSchema, setPrWorkflowInputSchema } from "./pr-workflow";
import { setUpdatesInputSchema, updatesViewSchema } from "./updates";
import { releaseNotesViewSchema } from "./changelog";
import { SCALE } from "./scale";
import { imageSupportSchema, imageTargetSchema, imageUploadsSchema } from "./images";
import { actionPlanSchema, actionResultSchema, browserCommandSchema, browserExchangeSchema, browserPrSchema, browserStatusSchema, prActionKind } from "./pr-actions";
/** Each workspace's first live Compass note as one line (shared/compass.ts noteLines). */
const compassLinesSchema = z.record(z.string(), z.string().max(200));

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
export const agentStatusRpc = defineRpc({ name: "follow.agent-status", input: z.strictObject({ agentId: idSchema, detail: z.enum(["summary", "full"]).optional() }), output: workspaceSchema.extend({ /** The caller's own ask the developer dismissed (still standing): don't raise it again. */ dismissedAsk: z.object({ ask: z.string(), kind: z.string(), at: z.string() }).nullable().optional(), prWorkflow: z.object({ mode: z.enum(["graphite", "github"]), reviewFix: z.string().nullable() }).optional(), /** The next message: recipient, tasks, exact text, and when and why it goes (Preview's agent form). */ nextMessageInfo: z.object({ to: z.string(), tasks: z.array(z.string()), text: z.string(), reason: z.string(), eta: z.string().nullable() }).nullable().optional(),
  /** Home's Sending row for this workspace (shared/sending.ts): queued or sent, when and why, and whether Send now (send_repairs) would go through. */
  sending: sendingSchema.nullable().optional() }) });
export const syncWorkspaceRpc = defineRpc({ name: "follow.sync", input: z.strictObject({ agentId: idSchema, summary: z.string().trim().min(1).max(1000),
  /** What the caller is working on toward the goal (shared/now.ts). Omitted keeps the last one; null clears it. */
  milestone: milestoneInputSchema.optional() }), output: z.object({ workspaceId: idSchema, synced: z.literal(true) }) });
const nowLineSchema = z.object({
  agentId: idSchema, role: z.enum(["main", "contributor"]),
  work: z.object({ text: z.string(), source: z.enum(NOW_SOURCES), done: z.array(z.string()), next: z.array(z.string()), position: z.object({ at: z.number().int(), of: z.number().int() }).nullable() }).nullable(),
  state: z.object({ kind: z.string(), text: z.string(), since: z.string().nullable() }),
  waitingOn: z.string().nullable(), needs: z.string().nullable(),
});
/** workspace_now: every agent's line in the caller's workspace, as the panel and Home draw it (shared/now.ts). */
export const workspaceNowRpc = defineRpc({ name: "follow.workspace-now", input: z.strictObject({ agentId: idSchema }), output: z.object({ workspaceId: idSchema, agents: z.array(nowLineSchema) }) });
export const enrollRpc = defineRpc({ name: "follow.enroll", input: z.strictObject({ workspaceId: idSchema.optional(), agentId: idSchema, goal: textSchema }), output: workspaceSchema });
export const registerPrRpc = defineRpc({ name: "follow.register-pr", input: z.strictObject({ agentId: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), stack: textSchema, parentNumber: z.number().int().positive().nullable().optional(), disposition: z.string().max(2000).optional(), agentMerges: z.boolean().optional() }), output: workspaceSchema });
export const obligationRpc = defineRpc({ name: "follow.obligation", input: z.strictObject({ agentId: idSchema, workingAgentId: idSchema.optional(), id: idSchema.optional(), title: textSchema, status: z.enum(["pending", "waiting", "working", "blocked", "done", "waived"]), afterPrs: z.array(idSchema).optional(), dependencyStage: z.enum(["merged", "deployed"]).optional(), evidence: z.string().max(4000).optional(), ask: z.string().trim().min(1).max(1000).optional(), question: z.string().regex(/^Q\d+$/).optional(), need: z.enum(["decision", "action"]).optional(), enable_follow_up: z.boolean().optional(), communication: agentCommunicationSchema.optional(), trigger: taskTriggerInputSchema.strict().nullable().optional(), recheck: z.string().trim().min(1).max(40).optional(), new: z.boolean().optional() }), output: workspaceSchema.extend({ updatedObligationId: idSchema, note: z.string().optional() }) });
export const declareDoneRpc = defineRpc({ name: "follow.done", input: z.strictObject({ agentId: idSchema, summary: textSchema }), output: z.object({ workspace: workspaceSchema, blockers: z.array(z.string()), unconfirmed: z.array(z.string()).default([]), alreadyDone: z.boolean().default(false), next: z.string().default("") }) });
export const acknowledgeRpc = defineRpc({ name: "follow.acknowledge", input: z.strictObject({ agentId: idSchema, batchId: idSchema, /** in_progress: the agent or its own subagent is already on it (Batch.inProgress). */ outcome: z.enum(["completed", "blocked", "in_progress"]), result: textSchema, /** With blocked: only a person can move what is still open (Batch.humanOnly). */ humanOnly: z.boolean().optional(), /** The part only a person can move, with any outcome (Batch.waitingOn). */ waitingOn: z.string().max(500).optional() }), output: workspaceSchema });
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
/**
 * "Nobody's on it" (invariant 86, nobody-s-on-it-is-needs-you): the Needs-you rows for issues that matter and have no
 * workspace, a raised Linear issue and an urgent Compass ask alike, one row per issue (shared/nobody.ts), computed by
 * the worker from the queue and compass.json it holds. Plus the zone their dates read in, the revision (a sweep, a read
 * or a Remove moves it, so an open brief pane re-reads), and Compass's "1 from Dana" for Home's brief row. Rides the
 * home feed, and on 0.15 the priorities poll: never a read of its own.
 */
export const queueNeedsSchema = z.object({
  needs: z.array(z.object({ key: z.string(), title: z.string(), url: z.string().nullable(), due: z.string().nullable(), raisedTo: z.number().nullable(), at: z.string(),
    reasons: z.array(z.object({ from: z.enum(["queue", "compass"]), line: z.string(), source: z.string(), note: z.string().nullable() })).min(1) })),
  timeZone: z.string(),
  revision: z.string(),
  /** "1 from Dana": what Compass heard since the brief's point, for Home's brief row; null: nothing new. */
  heard: z.string().nullable().optional(),
});
export const prioritiesRpc = defineRpc({ name: "follow.priorities", input: z.object({}), output: z.object({ items: z.array(prioritySchema), queue: queueNeedsSchema.optional(), compass: compassLinesSchema.optional() }) });
/** Provider session limits from the Smart Session plugin, for Home's meters. Hidden when it isn't installed. */
/** Summary: collapsed reads the cache; open may start an overview; refresh always does. */
export const workspaceAboutRpc = defineRpc({ name: "follow.workspace-about", input: z.object({ workspaceId: idSchema, open: z.boolean().optional(), refresh: z.boolean().optional() }), output: aboutViewSchema });
// Rename title with AI (shared/rename.ts): the dialog's state and one suggestion, and the rename or its Undo.
export const renameStatusRpc = defineRpc({ name: "follow.rename-status", input: z.object({ workspaceId: idSchema, suggest: z.boolean().optional() }), output: renameStatusSchema });
export const renameWorkspaceRpc = defineRpc({ name: "follow.rename-workspace", input: z.object({ workspaceId: idSchema, title: z.string().max(300).optional(), undo: z.boolean().optional() }), output: renameResultSchema });
export const usageRpc = defineRpc({ name: "follow.usage", input: z.object({}), output: usageSchema });
// Trust bypass agents: how many permission prompts were approved today, and the newest few (tool and a short summary).
export const trustBypassRpc = defineRpc({ name: "follow.trust-bypass", input: z.object({}), output: z.object({ today: z.number().int().nonnegative(), recent: z.array(z.object({ at: z.string(), agentId: z.string(), tool: z.string(), summary: z.string(), mode: z.string() })).max(20) }) });
export const refineTasksRpc = defineRpc({ name: "follow.refine-tasks", input: z.object({ workspaceId: idSchema, tasks: z.array(z.object({ id: idSchema, title: textSchema, afterPrs: z.array(idSchema), dependencyStage: z.enum(["merged", "deployed"]), enable_follow_up: z.boolean(), communication: communicationSchema.optional(), trigger: taskTriggerInputSchema.nullable().optional() })).max(SCALE.perWorkspace) }), output: workspaceSchema });
export const taskTriggerRpc = defineRpc({ name: "follow.set-task-trigger", input: z.object({ workspaceId: idSchema, obligationId: idSchema, expectedRevision: z.number().int().nonnegative(), trigger: taskTriggerInputSchema.strict().nullable(), afterPrs: z.array(idSchema) }), output: workspaceSchema });

// Narrow integration: no inventory, messages, paths, or credentials cross this RPC.
export const prOwnerRpc = defineRpc({ name: "follow.pr-owner", input: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }), output: z.object({ owner: z.object({ workspaceId: idSchema, agentId: idSchema }).nullable() }) });
// Read-only browser view of who owns a PR: titles, ids, agent status and Follow-up's one line. Nothing else.
// `tracked: false` means the repository is outside the scope Follow-up advertises to the browser, so nothing is returned.
export const prWorkspacesRpc = defineRpc({ name: "follow.pr-workspaces", input: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }), output: z.object({ tracked: z.boolean(), more: z.number().int().nonnegative(), workspaces: z.array(z.object({ workspaceId: idSchema, agentId: idSchema, title: z.string().max(200), agentStatus: z.string().max(40), group: z.enum(HOME_GROUPS), state: z.string().max(200), tone: z.enum(["attention", "danger", "success", "accent", "muted"]) })).max(3) }) });

// Questions. Agents ask, record an answer given in chat, or withdraw; the developer answers from the UI.
const optionInput = z.strictObject({ letter: z.string().regex(/^[A-Z]$/), label: z.string().trim().min(1).max(200), consequence: z.string().trim().max(600).optional() });
const linkInput = z.strictObject({ url: z.string().url().optional(), path: z.string().trim().min(1).max(1000).optional(), label: z.string().trim().max(200).optional() });
export const askQuestionRpc = defineRpc({ name: "follow.ask-question", input: z.strictObject({
  agentId: idSchema, title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(2000),
  options: z.array(optionInput).max(26).optional(), recommend: z.string().trim().max(200).optional(), big: z.string().trim().max(300).optional(),
  background: z.string().trim().max(4000).optional(), links: z.array(linkInput).max(10).optional(),
  pr: z.string().trim().max(200).optional(), task: idSchema.optional(), supersedes: z.string().regex(/^Q\d+$/).optional(),
}), output: z.object({ workspaceId: idSchema, question: questionSchema, mode: z.enum(QUESTION_MODES), instruction: z.string(),
  outcome: z.enum(["asked", "duplicate", "superseded", "dismissed"]).default("asked"), of: z.string().nullable().default(null) }) });
export const recordAnswerRpc = defineRpc({ name: "follow.record-answer", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional() }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
export const withdrawQuestionRpc = defineRpc({ name: "follow.withdraw-question", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), reason: z.string().trim().min(1).max(500) }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
/** Dismiss a question that no longer matters, or undo that (dismissing-a-question-sends-the-agent-nothing). Sends nothing. */
export const dismissQuestionRpc = defineRpc({ name: "follow.dismiss-question", input: z.strictObject({ workspaceId: idSchema, questionId: z.string().regex(/^Q\d+$/), undo: z.boolean().optional() }), output: z.object({ workspace: workspaceSchema, question: questionSchema }) });
/**
 * Dismiss anything in Needs you, or undo that (dismissing-anything-in-needs-you-sends-the-agent-nothing): a workspace's
 * item by its key (NeedItem.key; "question:Qn" closes the question as dismissed), or an agent's turn-end brief by its
 * agentId. Sends nothing to any agent. `name` is what the toast calls it ("Q3", or the row's title).
 */
export const dismissRpc = defineRpc({ name: "follow.dismiss", input: z.strictObject({ workspaceId: idSchema.optional(), key: z.string().min(1).max(400).optional(), agentId: idSchema.optional(),
  /** A "Nobody's on it" row (it has no workspace), by its issue key: the queue's raise and Compass's asks on it alike. */
  issue: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/).max(30).optional(),
  /** One Compass suggestion, by its note id (New's Remove, or a row Compass alone put in Needs you). */
  compass: z.string().min(1).max(80).optional(), undo: z.boolean().optional() })
  .refine(i => [!!i.agentId, !!(i.workspaceId && i.key), !!i.issue, !!i.compass].filter(Boolean).length === 1, "Give workspaceId and key for a Needs-you item, agentId for an agent's brief, issue for a Nobody's-on-it row, or compass for a Compass suggestion."),
  output: z.object({ name: z.string() }) });
export const answerQuestionRpc = defineRpc({ name: "follow.answer-question", input: z.object({ workspaceId: idSchema, questionId: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional(), action: z.enum(["send", "copy", "chat", "resend"]),
  /** Pasted images (shared/images.ts): they ride the answer's message, on Send only. */
  images: imageUploadsSchema.optional() }), output: z.object({ workspace: workspaceSchema, question: questionSchema }) });
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
}), output: z.object({ ok: z.literal(true), briefId: z.string(), /** Decisions the developer had dismissed: left off the card, and why. */ note: z.string().optional() }) });
/** Home's detail pane: the full stored brief for one agent (the list carries only its one-liner). */
// The message queue (server/message-queue.ts): what waits to go to agents, and Retry or Cancel on one item.
export const queueListRpc = defineRpc({ name: "follow.queue-list", input: z.strictObject({ workspaceId: idSchema.optional(), agentId: idSchema.optional() }), output: z.object({ items: z.array(queueViewSchema), recent: z.array(queueViewSchema) }) });
export const queueActionRpc = defineRpc({ name: "follow.queue-action", input: z.strictObject({ itemId: z.string().min(1).max(400), action: z.enum(["retry", "cancel"]) }), output: z.object({ item: queueViewSchema }) });
export const inboxBriefRpc = defineRpc({ name: "follow.inbox-brief", input: z.strictObject({ agentId: idSchema }), output: z.object({ brief: briefSchema.nullable() }) });
/** An option letter, or "other" (Something else, which needs words). */
export const briefChoiceSchema = z.string().regex(/^(?:[A-Z]|other)$/);
export const briefActionRpc = defineRpc({ name: "follow.brief-action", input: z.strictObject({
  agentId: idSchema, briefId: z.string().max(300), decisionId: z.string().max(20).optional(), choice: briefChoiceSchema.optional(), words: z.string().trim().max(2000).optional(), move: z.enum(["retry", "done"]).optional(),
  /** 1.4.0: every pick of a multi-decision card, sent together. "other" is Something else, with the words. */
  choices: z.array(z.object({ decisionId: z.string().max(20), choice: briefChoiceSchema, words: z.string().trim().max(2000).optional() })).min(1).max(10).optional(),
  /** One per Send, reused on Retry: the same answer is recorded and sent once (server/inbox.ts briefAction). */
  answerId: z.string().regex(/^[\w-]{8,80}$/).optional(),
  /** Pasted images (shared/images.ts): they ride the answer's message. */
  images: imageUploadsSchema.optional(),
}), output: z.object({ brief: briefSchema }) });

// Agent parity: one RPC carries every agent tool; the server runs the same path as the developer's button.
export const agentActRpc = defineRpc({ name: "follow.agent-act", input: z.strictObject({ agentId: idSchema, tool: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }), output: z.unknown() });

// The Overseer (1.4.0-beta.0).
export const overseerStatusSchema = z.object({ enabled: z.boolean(), agentId: z.string().nullable(), workspaceId: z.string().nullable(), startedAt: z.string().nullable(), generation: z.number().int(), error: z.string().nullable(),
  /** What it runs on ("Claude · Opus 5.5") and, when Settings → Agents changed since, what a restart would use. */
  model: z.string().nullable().default(null), restartWith: z.string().nullable().default(null), configured: z.string().nullable().default(null) });
export const overseerStatusRpc = defineRpc({ name: "follow.overseer-status", input: z.object({}), output: overseerStatusSchema });
export const overseerStartRpc = defineRpc({ name: "follow.overseer-start", input: z.object({}), output: overseerStatusSchema });
export const overseerAskRpc = defineRpc({ name: "follow.overseer-ask", input: z.strictObject({ text: z.string().trim().min(1).max(2000), images: imageUploadsSchema.optional() }), output: overseerStatusSchema });
/** Whether a field's recipient takes pasted images (server/image-support.ts), asked once per target when the first image is added. */
export const imageSupportRpc = defineRpc({ name: "follow.image-support", input: z.strictObject({ target: imageTargetSchema }), output: imageSupportSchema });
// Your questions and Catch up's More context (docs/needs-you.md#your-questions): ask an agent, list the questions, act
// on one, and the asked agent's reply. The ask answers once it is recorded; the send goes through the message queue.
// With a cardKey it is More context about that card (its workspace's main agent answers); without one it is a free
// question: to `agentId` when given (the agent whose chat ran /ask; a tracked workspace's main agent or contributor),
// else to the workspace's main agent.
export const contextAskRpc = defineRpc({ name: "follow.context-ask", input: z.strictObject({
  workspaceId: z.string().min(1).max(200).nullable().optional(), agentId: z.string().min(1).max(200).nullable().optional(), cardKey: z.string().min(1).max(400).nullable().optional(),
  card: z.string().trim().max(300).optional(),
  /** Where the developer asked: Catch up's More context, Your questions' field, or /ask in a chat. Agents' asks are `tool`. */
  via: z.enum(["more", "field", "slash"]).optional(),
  /** Ignored: every ask goes to the card's workspace's main agent. Still accepted, so older callers don't break. */
  target: z.enum(CONTEXT_TARGETS).optional(), ask: z.string().trim().min(1).max(2000), images: imageUploadsSchema.optional() }),
  output: z.object({ request: contextRequestSchema, fresh: z.boolean(), note: z.string().optional() }) });
export const contextListRpc = defineRpc({ name: "follow.context-list", input: z.strictObject({ workspaceId: z.string().max(200).optional(),
  /** open: asking or an unread answer; tasks: made a task. */
  state: z.enum(HISTORY_FILTERS).optional(), query: z.string().max(200).optional() }), output: z.object({ requests: z.array(contextRequestSchema) }) });
/**
 * What to do with a question (Your questions): Done (read; stays in history), Reply (a follow-up question in the same
 * thread, to the same agent), Make a task (an obligation owned by the agent that answered, the Q&A as its note),
 * Withdraw (while asking; a queued message is dropped). An agent's act is recorded as `agent:<id>` and never reads the
 * answer for the developer.
 */
export const questionActionRpc = defineRpc({ name: "follow.question-action", input: z.strictObject({ id: z.string().min(1).max(80), action: z.enum(QUESTION_ACTIONS),
  text: z.string().trim().min(1).max(2000).optional(), images: imageUploadsSchema.optional() }),
  output: z.object({ request: contextRequestSchema, reply: contextRequestSchema.optional(), taskId: z.string().optional() }) });
/** Catch up's deck as the developer's Home would deal it (agent parity: an agent sees what the developer goes through). */
export const catchUpDeckRpc = defineRpc({ name: "follow.catch-up-deck", input: z.strictObject({}), output: z.object({
  cards: z.array(z.object({ key: z.string(), kind: z.string(), workspaceId: z.string().nullable(), agentId: z.string().nullable(), title: z.string(), line: z.string(),
    questionId: z.string().nullable(), item: z.string().nullable(), context: contextRequestSchema.pick({ id: true, state: true, target: true }).nullable() })) }) });
/**
 * Wait for checks (docs/wait-for-checks.md): the caller's PRs whose checks it waits on. `prs`: URLs, owner/repo#N or
 * numbers; none means every open PR of the caller's workspace. `cancel` stops waiting. One message comes after the turn.
 */
export const waitForChecksRpc = defineRpc({ name: "follow.wait-for-checks", input: z.strictObject({ agentId: z.string().min(1).max(200), prs: z.array(z.string().trim().min(1).max(2000)).max(SCALE.perWorkspace).optional(), minutes: z.number().int().min(1).max(720).optional(), cancel: z.boolean().optional() }),
  output: z.object({ text: z.string(), waiting: z.array(z.string()), done: z.array(z.object({ pr: z.string(), result: z.string(), text: z.string() })), notFollowed: z.array(z.string()) }) });
export const contextReplyRpc = defineRpc({ name: "follow.context-reply", input: z.strictObject({ agentId: z.string().min(1).max(200), requestId: z.string().min(1).max(80), text: z.string().trim().min(1).max(CONTEXT_ANSWER_MAX) }), output: z.object({ ok: z.boolean() }) });
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
// PR statistics (docs/pr-stats.md): the model the page and pr_stats read, Settings → PR statistics, and its writes.
export const prStatsRpc = defineRpc({ name: "follow.pr-stats", input: prStatsInputSchema, output: prStatsOutputSchema });
export const prStatsSettingsRpc = defineRpc({ name: "follow.pr-stats-settings", input: z.object({ repo: statsRepoName.optional(), estimate: z.boolean().optional() }), output: statsSettingsViewSchema });
export const setPrStatsRpc = defineRpc({ name: "follow.set-pr-stats", input: setPrStatsInputSchema, output: statsSettingsViewSchema });
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
  output: z.object({ agents: z.array(reportTargetSchema), defaultId: z.string().nullable(), newAgentWorkspace: z.object({ id: idSchema, title: z.string() }).nullable(),
    // The project a new workspace would start in (server/report-send.ts); null without one or without the host feature.
    newWorkspace: z.object({ projectId: idSchema, title: z.string() }).nullable().optional() }) });
/** Send to agent: the report prompt goes to `agentId`, a new agent in `newAgentWorkspaceId`, or a new workspace in `newWorkspaceProjectId`. */
export const reportSendRpc = defineRpc({ name: "follow.report-issue-send", input: z.object({ kind: reportKindSchema, text: z.string().max(8000), error: z.string().max(2000).nullable().optional(), agentId: z.string().max(200).optional(), newAgentWorkspaceId: z.string().max(200).optional(), newWorkspaceProjectId: z.string().max(200).optional() }),
  output: z.object({ agentId: idSchema, title: z.string(), started: z.boolean(), workspaceId: z.string().optional(), queued: z.boolean().optional() }) });
/** Open on GitHub (no agent to send to): a prefilled new-issue link carrying the redacted versions block. */
export const reportLinkRpc = defineRpc({ name: "follow.report-issue-link", input: z.object({ kind: reportKindSchema, text: z.string().max(8000) }), output: z.object({ url: z.string() }) });

/**
 * The chat's created-agent / created-workspace cards (shared/created.ts): live facts for the ids they show, from the
 * engine's directory snapshot (the same cached rows the engine and task lines read; no daemon list call, nothing woken)
 * and Follow-up's store.
 */
const followLineSchema = z.object({ question: z.object({ id: z.string(), title: z.string() }).nullable(),
  chips: z.array(z.object({ text: z.string(), tone: z.enum(["success", "danger", "warning", "merged", "muted"]) })), line: z.string().nullable() });
// New (shared/dispatch.ts, server/dispatch.ts): start work from a Linear issue, a GitHub issue or PR, a link or the
// developer's words. The dispatch records and replies; the workspace and agent start after the reply.
const dispatchIdInput = z.strictObject({ dispatchId: idSchema });
export const dispatchSourcesRpc = defineRpc({ name: "follow.dispatch-sources", input: z.strictObject({ fresh: z.boolean().optional(), query: z.string().trim().min(1).max(200).optional() }), output: z.unknown() });
export const dispatchPreviewRpc = defineRpc({ name: "follow.dispatch-preview", input: dispatchInputSchema, output: z.unknown() });
export const dispatchRpc = defineRpc({ name: "follow.dispatch", input: dispatchInputSchema.extend({ expectHash: z.string().max(40).optional() }), output: z.unknown() });
export const dispatchRecordsRpc = defineRpc({ name: "follow.dispatch-records", input: z.strictObject({}), output: z.object({ records: z.array(dispatchRecordSchema) }) });
export const dispatchUndoRpc = defineRpc({ name: "follow.dispatch-undo", input: dispatchIdInput, output: dispatchRecordSchema });
export const dispatchActionsRpc = defineRpc({ name: "follow.dispatch-actions", input: z.strictObject({}), output: z.object({ actions: z.array(dispatchActionSchema), edited: z.boolean() }) });
export const setDispatchActionsRpc = defineRpc({ name: "follow.set-dispatch-actions", input: z.strictObject({ change: actionChangeSchema }), output: z.object({ actions: z.array(dispatchActionSchema) }) });
export const dispatchSettingsRpc = defineRpc({ name: "follow.dispatch-settings", input: z.strictObject({}), output: z.unknown() });
export const setDispatchSettingsRpc = defineRpc({ name: "follow.set-dispatch-settings", input: settingsChangeSchema, output: z.unknown() });
// The Morning brief's Linear queue (shared/linear-queue.ts, server/linear-queue.ts, docs/morning-brief.md). `open` is the
// developer opening the brief: it marks the read "since" stands on and sweeps when the snapshot is older than 6 h.
// Agents read without `open` (linear_queue), so an agent never moves the developer's "since".
export const linearQueueInputSchema = z.strictObject({
  filter: z.enum(["all", "no-workspace", "changed"]).optional(),
  since: z.string().datetime({ offset: true }).nullable().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  open: z.boolean().optional(),
});
export const linearQueueRpc = defineRpc({ name: "follow.linear-queue", input: linearQueueInputSchema, output: z.unknown() });
// `wait: false` (the queue screen's Sweep now): reply at once with `{ running: true }` and poll the view; agents wait.
export const sweepQueueRpc = defineRpc({ name: "follow.sweep-queue", input: z.strictObject({ wait: z.boolean().optional() }), output: z.unknown() });
// Settings → Morning brief (shared/morning-brief.ts, server/morning-brief.ts): the queue's settings, the plan link and
// its finder, and the pickers' chat search.
export const briefSettingsRpc = defineRpc({ name: "follow.brief-settings", input: z.strictObject({}), output: z.unknown() });
export const setBriefSettingsRpc = defineRpc({ name: "follow.set-brief-settings", input: queueChangeSchema, output: z.unknown() });
export const briefPlanRpc = defineRpc({ name: "follow.brief-plan", input: briefPlanInputSchema, output: z.unknown() });
export const setBriefPlanRpc = defineRpc({ name: "follow.set-brief-plan", input: planChangeSchema, output: z.unknown() });
// The brief's sources (shared/brief-sources.ts, server/brief-sources.ts): `check` asks mcpproxy what it has now (Settings
// sends it on open).
export const briefSourcesRpc = defineRpc({ name: "follow.brief-sources", input: z.strictObject({ check: z.boolean().optional() }), output: z.unknown() });
export const setBriefSourcesRpc = defineRpc({ name: "follow.set-brief-sources", input: sourcesChangeSchema, output: z.unknown() });
export const briefChatSearchRpc = defineRpc({ name: "follow.brief-chat-search", input: z.strictObject({ kind: z.enum(["people", "channels", "docs", "file", "trackers", "calendars"]), query: z.string().trim().min(1).max(1_000) }), output: z.unknown() });
// Compass (shared/compass.ts, server/compass.ts, docs/compass.md): the sources that set the developer's priorities.
export const compassRpc = defineRpc({ name: "follow.compass", input: z.strictObject({ workspace: z.string().min(1).max(200).optional() }), output: z.unknown() });
export const compassFindRpc = defineRpc({ name: "follow.compass-find", input: z.strictObject({ kind: z.enum(["people", "channels", "docs", "file", "trackers", "calendars"]), query: z.string().trim().min(1).max(1_000) }), output: z.unknown() });
export const setCompassRpc = defineRpc({ name: "follow.set-compass", input: compassSetSchema, output: z.unknown() });
export const readCompassRpc = defineRpc({ name: "follow.read-compass", input: z.strictObject({}), output: z.unknown() });
/** Why it matters' menu and compass_note: pin, edit, unpin a note, or tell its workspace's main agent. */
export const compassNoteRpc = defineRpc({ name: "follow.compass-note", input: noteActionSchema, output: z.unknown() });
/** why_suggested: the notes behind a workspace, an issue or a note, and how each was matched. */
export const whySuggestedRpc = defineRpc({ name: "follow.why-suggested", input: z.strictObject({ workspace: z.string().min(1).max(200).optional(), issue: z.string().min(1).max(60).optional(), note: z.string().min(1).max(80).optional() }), output: z.unknown() });
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
  /** Catch up's More context asks (pushed when one is asked or answered); absent from an older worker. */
  context: z.array(contextRequestSchema).optional(),
  /** New's recent dispatches (Home's row: in progress, failed, Undo); absent from an older worker. */
  dispatches: z.array(dispatchRecordSchema).optional(),
  /** Whether any repository has PR statistics (on or paused): Home's PR stats icon shows only then. Absent from an older worker. */
  prStats: z.boolean().optional(),
  /** The raised Linear issues in Needs you (Q8) and the queue's revision; pushed when a sweep or a dismissal changes them. */
  queue: queueNeedsSchema.optional(),
  /** Each workspace's first live Compass note as one line (Home rows, Catch up); absent from an older worker. */
  compass: compassLinesSchema.optional(),
}));
export const displayFeed = subscription("follow.display-feed", z.object({}), z.object({ status: z.string(), revision: z.string().optional(), values: z.unknown().optional() }));
/**
 * The PR stats page's feed for one repository: its sync status, pushed when a run ends or a setting changes. While it
 * is open the repository syncs every 5 minutes instead of hourly (`PrStats.watching`); the page re-reads its model
 * when the status moves. Only the page subscribes, and only while it is on screen.
 */
export const prStatsFeed = subscription("follow.pr-stats-feed", z.object({ repo: statsRepoName }), z.object({
  repo: z.string(), state: z.enum(["on", "paused", "off"]), lastSyncAt: z.number().nullable(), records: z.number().int(), coveredTo: z.number().nullable(),
  waiting: statsStatusSchema.shape.waiting, error: statsStatusSchema.shape.error,
}));
export const FEEDS = [workspacesFeed, inboxFeed, homeFeed, displayFeed, prStatsFeed] as const;
