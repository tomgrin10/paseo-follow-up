import { projectSchema } from "./settings";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { idSchema, textSchema, workspaceSchema } from "./model";
import { communicationSchema } from "./communication";
import { taskTriggerSchema } from "./task-trigger";
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

export const browserExchangeRpc = defineRpc({ name: "follow.browser-exchange", input: browserExchangeSchema, output: z.object({ jobs: z.array(browserCommandSchema), accepted: z.array(idSchema) }) });
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
