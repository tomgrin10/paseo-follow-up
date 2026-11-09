import { projectSchema } from "./settings";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { inboxRowSchema } from "./inbox";
import { briefSchema } from "./brief";
import { idSchema, textSchema, workspaceSchema } from "./model";
import { communicationSchema } from "./communication";
import { taskTriggerSchema } from "./task-trigger";
import { QUESTION_MODES, questionSchema } from "./questions";
import { specSchema } from "./spec";
import { actionPlanSchema, actionResultSchema, browserCommandSchema, browserExchangeSchema, browserPrSchema, browserStatusSchema, prActionKind } from "./pr-actions";

const agentCommunicationSchema = z.strictObject({
  threadUrl: communicationSchema.shape.threadUrl, recipient: communicationSchema.shape.recipient,
  purpose: communicationSchema.shape.purpose.unwrap().optional(), authorization: communicationSchema.shape.authorization.unwrap().optional(), replyUrl: communicationSchema.shape.replyUrl.unwrap().optional(),
});

export const listRpc = defineRpc({ name: "follow.list", input: z.object({}), output: z.object({ workspaces: z.array(workspaceSchema), error: z.string().nullable() }) });
export const getRpc = defineRpc({ name: "follow.get", input: z.object({ workspaceId: idSchema }), output: z.object({ workspace: workspaceSchema.nullable(), error: z.string().nullable() }) });
export const agentStatusRpc = defineRpc({ name: "follow.agent-status", input: z.strictObject({ agentId: idSchema, detail: z.enum(["summary", "full"]).optional() }), output: workspaceSchema });
export const syncWorkspaceRpc = defineRpc({ name: "follow.sync", input: z.strictObject({ agentId: idSchema, summary: z.string().trim().min(1).max(1000) }), output: z.object({ workspaceId: idSchema, synced: z.literal(true) }) });
export const enrollRpc = defineRpc({ name: "follow.enroll", input: z.strictObject({ workspaceId: idSchema.optional(), agentId: idSchema, goal: textSchema }), output: workspaceSchema });
export const registerPrRpc = defineRpc({ name: "follow.register-pr", input: z.strictObject({ agentId: idSchema, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), stack: textSchema, parentNumber: z.number().int().positive().nullable().optional(), disposition: z.string().max(2000).optional() }), output: workspaceSchema });
export const obligationRpc = defineRpc({ name: "follow.obligation", input: z.strictObject({ agentId: idSchema, id: idSchema.optional(), title: textSchema, status: z.enum(["pending", "waiting", "working", "blocked", "done", "waived"]), afterPrs: z.array(idSchema).optional(), dependencyStage: z.enum(["merged", "deployed"]).optional(), evidence: z.string().max(4000).optional(), enable_follow_up: z.boolean().optional(), communication: agentCommunicationSchema.optional(), trigger: taskTriggerSchema.strict().nullable().optional() }), output: workspaceSchema.extend({ updatedObligationId: idSchema }) });
export const declareDoneRpc = defineRpc({ name: "follow.done", input: z.strictObject({ agentId: idSchema, summary: textSchema }), output: z.object({ workspace: workspaceSchema, blockers: z.array(z.string()) }) });
export const acknowledgeRpc = defineRpc({ name: "follow.acknowledge", input: z.strictObject({ agentId: idSchema, batchId: idSchema, outcome: z.enum(["completed", "blocked"]), result: textSchema }), output: workspaceSchema });
export const controlRpc = defineRpc({ name: "follow.control", input: z.object({ workspaceId: idSchema, enable_auto_sends: z.boolean().optional(), clearHold: z.boolean().optional(), retryBatchId: idSchema.optional() }), output: workspaceSchema });
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
export const requestReviewersRpc = defineRpc({ name: "follow.request-reviewers", input: z.object({ workspaceId: idSchema, prKey: idSchema }), output: actionResultSchema });

export const projectSettingsRpc = defineRpc({ name: "follow.project-settings", input: z.object({}), output: z.object({ projects: z.array(projectSchema) }) });
export const setProjectTrackingRpc = defineRpc({ name: "follow.set-project-tracking", input: z.object({ projectId: idSchema, enable_default_tracking: z.boolean() }), output: z.object({ projects: z.array(projectSchema) }) });
export const refineTasksRpc = defineRpc({ name: "follow.refine-tasks", input: z.object({ workspaceId: idSchema, tasks: z.array(z.object({ id: idSchema, title: textSchema, afterPrs: z.array(idSchema), dependencyStage: z.enum(["merged", "deployed"]), enable_follow_up: z.boolean(), communication: communicationSchema.optional(), trigger: taskTriggerSchema.nullable().optional() })).max(50) }), output: workspaceSchema });
export const taskTriggerRpc = defineRpc({ name: "follow.set-task-trigger", input: z.object({ workspaceId: idSchema, obligationId: idSchema, expectedRevision: z.number().int().nonnegative(), trigger: taskTriggerSchema.nullable(), afterPrs: z.array(idSchema) }), output: workspaceSchema });

// Narrow integration: no inventory, messages, paths, or credentials cross this RPC.
export const prOwnerRpc = defineRpc({ name: "follow.pr-owner", input: z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() }), output: z.object({ owner: z.object({ workspaceId: idSchema, agentId: idSchema }).nullable() }) });

// Questions. Agents ask, record an answer given in chat, or withdraw; the developer answers from the UI.
const optionInput = z.strictObject({ letter: z.string().regex(/^[A-Z]$/), label: z.string().trim().min(1).max(200), consequence: z.string().trim().max(600).optional() });
const linkInput = z.strictObject({ url: z.string().url().optional(), path: z.string().trim().min(1).max(1000).optional(), label: z.string().trim().max(200).optional() });
export const askQuestionRpc = defineRpc({ name: "follow.ask-question", input: z.strictObject({
  agentId: idSchema, title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(2000),
  options: z.array(optionInput).max(26).optional(), recommend: z.string().trim().max(200).optional(), big: z.string().trim().max(300).optional(),
  background: z.string().trim().max(4000).optional(), links: z.array(linkInput).max(10).optional(),
  pr: z.string().trim().max(200).optional(), task: idSchema.optional(),
}), output: z.object({ workspaceId: idSchema, question: questionSchema, mode: z.enum(QUESTION_MODES), instruction: z.string() }) });
export const recordAnswerRpc = defineRpc({ name: "follow.record-answer", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional() }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
export const withdrawQuestionRpc = defineRpc({ name: "follow.withdraw-question", input: z.strictObject({ agentId: idSchema, id: z.string().regex(/^Q\d+$/), reason: z.string().trim().min(1).max(500) }), output: z.object({ workspaceId: idSchema, question: questionSchema }) });
export const answerQuestionRpc = defineRpc({ name: "follow.answer-question", input: z.object({ workspaceId: idSchema, questionId: z.string().regex(/^Q\d+$/), choice: z.string().trim().min(1).max(200), words: z.string().trim().max(2000).optional(), action: z.enum(["send", "copy", "resend"]) }), output: z.object({ workspace: workspaceSchema, question: questionSchema }) });
export const setSpecRpc = defineRpc({ name: "follow.set-spec", input: z.strictObject({ agentId: idSchema, url: z.string().trim().min(1).max(2000), title: z.string().trim().max(120).optional() }), output: z.object({ workspaceId: idSchema, spec: specSchema.nullable(), applied: z.boolean(), message: z.string() }) });
export const workspaceSpecRpc = defineRpc({ name: "follow.workspace-spec", input: z.discriminatedUnion("action", [
  z.object({ workspaceId: idSchema, action: z.literal("set"), url: z.string().trim().min(1).max(2000), title: z.string().trim().max(120).nullable().optional() }),
  z.object({ workspaceId: idSchema, action: z.literal("remove") }),
  z.object({ workspaceId: idSchema, action: z.literal("reset") }),
]), output: workspaceSchema });

// Needs-you inbox. Names stay under follow. like the rest of the plugin.
export const inboxListRpc = defineRpc({ name: "follow.inbox-list", input: z.object({}), output: z.object({ enabled: z.boolean(), rows: z.array(inboxRowSchema), unsorted: z.array(inboxRowSchema).nullable(), firstRun: z.boolean(), batchUndo: z.object({ at: z.string(), count: z.number().int() }).nullable(), signOffs: z.number().int(), error: z.string().nullable(),
  /** Adoption share of needs_you over the last 7 days of flagged turns (R2). Optional for older daemons. */
  briefStats: z.object({ days: z.number().int(), total: z.number().int(), tool: z.number().int(), structured: z.number().int(), extraction: z.number().int(), fallback: z.number().int() }).optional() }) });
export const inboxActRpc = defineRpc({ name: "follow.inbox-act", input: z.strictObject({
  action: z.enum(["sign_off", "undo", "snooze", "mute_turn", "set_finish_flags", "unsorted_flag", "unsorted_sign_off", "batch_undo"]),
  agentIds: z.array(idSchema).max(500).optional(), seqs: z.record(z.string(), z.number().int()).optional(),
  until: z.string().max(200).optional(), value: z.boolean().optional(), muteTurn: z.boolean().optional(),
}), output: z.object({ results: z.array(z.object({ agentId: z.string(), ok: z.boolean(), cameBack: z.boolean() })) }) });

// The brief ("what you need to do"). needs_you comes from the agent's bridge; brief-action from the card.
const needsYouOption = z.strictObject({ label: z.string(), consequence: z.string().optional() });
export const needsYouRpc = defineRpc({ name: "follow.needs-you", input: z.strictObject({
  agentId: idSchema, ask: z.string(), kind: z.enum(["decision", "action", "review", "done"]),
  decisions: z.array(z.strictObject({ question: z.string(), options: z.array(needsYouOption).optional(), recommend: z.number().int().optional() })).optional(),
  context: z.string().optional(),
  links: z.array(z.strictObject({ label: z.string(), url: z.string().optional(), path: z.string().optional(), pr: z.string().optional() })).optional(),
}), output: z.object({ ok: z.literal(true), briefId: z.string() }) });
/** Home's detail pane: the full stored brief for one agent (the list carries only its one-liner). */
export const inboxBriefRpc = defineRpc({ name: "follow.inbox-brief", input: z.strictObject({ agentId: idSchema }), output: z.object({ brief: briefSchema.nullable() }) });
export const briefActionRpc = defineRpc({ name: "follow.brief-action", input: z.strictObject({
  agentId: idSchema, briefId: z.string().max(300), decisionId: z.string().max(20).optional(), choice: z.string().regex(/^[A-Z]$/).optional(), move: z.enum(["retry"]).optional(),
}), output: z.object({ brief: briefSchema }) });

// Agent parity: one RPC carries every agent tool; the server runs the same path as the developer's button.
export const agentActRpc = defineRpc({ name: "follow.agent-act", input: z.strictObject({ agentId: idSchema, tool: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }), output: z.unknown() });
