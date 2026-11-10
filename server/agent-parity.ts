import { z } from "zod";
import { AGENT_ROLES, savedRoleSchema } from "../shared/agent-settings";
import { ONBOARDING_ACTIONS, ONBOARDING_STEPS } from "../shared/onboarding";
import { setPrWorkflowInputSchema } from "../shared/pr-workflow";
import { reviewerListSchema } from "../shared/reviewers";
import { taskTriggerSchema } from "../shared/task-trigger";

/**
 * Agent parity, part 2 (1.4.0-beta.21): tools that are a developer RPC one-to-one. A read runs the RPC's handler; a
 * write is planned: the dry run shows what the developer's screen shows now (`before`) and the change, and
 * `confirm: true` with the plan's id runs the same handler the button runs. Writes are noted in the inbox ledger as
 * `agent:<id>`, like every agent action.
 *
 * `guard` refuses calls an agent must never make for itself (answering its own question, acting on its own brief).
 */
export type RpcTool = {
  name: string;
  rpc: string;
  kind: "read" | "write" | "planned";
  input: z.ZodType;
  /** The RPC input for these arguments (default: the arguments). */
  toRpc?: (args: Record<string, any>) => unknown;
  /** A read RPC whose answer the dry run shows as `before`. */
  before?: { rpc: string; input?: (args: Record<string, any>) => unknown };
  guard?: (args: Record<string, any>, caller: string) => string | null;
};

const id = z.string().trim().min(1).max(200);
const REPO = /^[\w.-]+\/[\w.-]+$/;
const repo = z.string().regex(REPO, "Use owner/repo.");
const confirm = { planId: id.optional(), confirm: z.boolean().optional() };
const none = z.strictObject({});

export const RPC_TOOLS: readonly RpcTool[] = [
  // Settings → Following
  { name: "follow_settings", rpc: "follow.follow-settings", kind: "read", input: none },
  { name: "set_follow_settings", rpc: "follow.set-follow-settings", kind: "planned", before: { rpc: "follow.follow-settings" },
    input: z.strictObject({ enable_follow_every: z.boolean().optional(), enable_auto_sends_default: z.boolean().optional(), activeWindowDays: z.number().int().min(1).max(60).optional(),
      workspace: z.strictObject({ workspaceId: id, follow: z.boolean().optional(), enable_auto_sends: z.boolean().optional() }).optional(), ...confirm }) },
  { name: "project_settings", rpc: "follow.project-settings", kind: "read", input: none },
  { name: "set_project_tracking", rpc: "follow.set-project-tracking", kind: "planned", before: { rpc: "follow.project-settings" },
    input: z.strictObject({ projectId: id.optional(), enable_default_tracking: z.boolean().optional(), ...confirm }) },
  // Settings → Following → Shipping PRs (workflow, merge method and review fixes, per repository or the default)
  { name: "pr_workflow", rpc: "follow.pr-workflow", kind: "read", input: z.strictObject({ refresh: z.boolean().optional() }) },
  { name: "set_pr_workflow", rpc: "follow.set-pr-workflow", kind: "planned", before: { rpc: "follow.pr-workflow" }, input: setPrWorkflowInputSchema.extend(confirm) },
  // Settings → Reviewers
  { name: "reviewer_settings", rpc: "follow.reviewer-settings", kind: "read", input: none },
  { name: "reviewer_suggestions", rpc: "follow.reviewer-suggestions", kind: "read", input: z.strictObject({ repo }) },
  { name: "save_reviewers", rpc: "follow.save-reviewers", kind: "planned", before: { rpc: "follow.reviewer-settings" },
    input: z.strictObject({ repo: repo.nullable().optional(), reviewers: reviewerListSchema.optional(), ...confirm }), toRpc: a => ({ repo: a.repo ?? null, reviewers: a.reviewers }) },
  // Settings → Agents
  { name: "set_agent_setting", rpc: "follow.set-agent-setting", kind: "planned", before: { rpc: "follow.agent-settings", input: () => ({}) },
    input: z.strictObject({ role: z.enum(AGENT_ROLES).optional(), entry: savedRoleSchema.nullable().optional(), ...confirm }) },
  // Onboarding
  { name: "onboarding_status", rpc: "follow.onboarding", kind: "read", input: none },
  { name: "onboarding_checks", rpc: "follow.onboarding-checks", kind: "read", input: z.strictObject({ fresh: z.boolean().optional() }) },
  { name: "set_onboarding", rpc: "follow.set-onboarding", kind: "planned", before: { rpc: "follow.onboarding" },
    input: z.strictObject({ action: z.enum(ONBOARDING_ACTIONS).optional(), step: z.enum(ONBOARDING_STEPS).optional(), ...confirm }) },
  // Home: Priority sort, provider limits, the Overseer
  { name: "priorities", rpc: "follow.priorities", kind: "read", input: none },
  { name: "rank_status", rpc: "follow.rank-status", kind: "read", input: none },
  { name: "rerank_priorities", rpc: "follow.rank-now", kind: "planned", before: { rpc: "follow.rank-status" }, input: z.strictObject({ force: z.boolean().optional(), ...confirm }) },
  { name: "usage", rpc: "follow.usage", kind: "read", input: none },
  { name: "overseer_status", rpc: "follow.overseer-status", kind: "read", input: none },
  { name: "overseer_start", rpc: "follow.overseer-start", kind: "planned", before: { rpc: "follow.overseer-status" }, input: z.strictObject({ ...confirm }) },
  { name: "overseer_restart", rpc: "follow.overseer-restart", kind: "planned", before: { rpc: "follow.overseer-status" }, input: z.strictObject({ ...confirm }) },
  { name: "overseer_ask", rpc: "follow.overseer-ask", kind: "planned", input: z.strictObject({ text: z.string().trim().min(1).max(2000).optional(), ...confirm }) },
  // Needs-you: the brief card and the inbox's other actions
  { name: "inbox_brief", rpc: "follow.inbox-brief", kind: "read", input: z.strictObject({ agentId: id }) },
  { name: "brief_action", rpc: "follow.brief-action", kind: "planned", before: { rpc: "follow.inbox-brief", input: a => ({ agentId: a.agentId }) },
    input: z.strictObject({ agentId: id.optional(), briefId: z.string().max(300).optional(), decisionId: z.string().max(20).optional(), choice: z.string().regex(/^[A-Z]$/).optional(), move: z.enum(["retry"]).optional(),
      choices: z.array(z.object({ decisionId: z.string().max(20), choice: z.string().regex(/^[A-Z]$/) })).min(1).max(10).optional(), ...confirm }),
    guard: (a, caller) => a.agentId === caller ? "brief_action answers another agent's brief for the developer; your own brief is the developer's to answer." : null },
  { name: "inbox_act", rpc: "follow.inbox-act", kind: "planned",
    input: z.strictObject({ action: z.enum(["undo", "mute_turn", "unsorted_flag", "unsorted_sign_off", "batch_undo"]).optional(), agentIds: z.array(id).max(500).optional(), muteTurn: z.boolean().optional(), ...confirm }),
    guard: (a, caller) => a.agentIds?.includes(caller) ? "inbox_act is for other agents' rows, not your own." : null },
  // Questions: the developer's answer to another agent's question
  { name: "answer_question", rpc: "follow.answer-question", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), questionId: z.string().regex(/^Q\d+$/).optional(), choice: z.string().trim().min(1).max(200).optional(), words: z.string().trim().max(2000).optional(), ...confirm }),
    toRpc: a => ({ workspaceId: a.workspaceId, questionId: a.questionId, choice: a.choice, words: a.words, action: "send" }) },
  // Workspace panel: recovery, refresh, the spec link, task triggers
  { name: "run_recovery", rpc: "follow.recover", kind: "planned", input: z.strictObject({ workspaceId: id.optional(), ...confirm }) },
  { name: "refresh", rpc: "follow.refresh", kind: "write", input: z.strictObject({ workspaceId: id.optional() }) },
  { name: "set_workspace_spec", rpc: "follow.workspace-spec", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), action: z.enum(["set", "remove", "reset"]).optional(), url: z.string().trim().min(1).max(2000).optional(), title: z.string().trim().max(120).nullable().optional(), ...confirm }) },
  { name: "set_task_trigger", rpc: "follow.set-task-trigger", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), obligationId: id.optional(), expectedRevision: z.number().int().nonnegative().optional(), trigger: taskTriggerSchema.nullable().optional(), afterPrs: z.array(id).optional(), ...confirm }),
    toRpc: a => ({ workspaceId: a.workspaceId, obligationId: a.obligationId, expectedRevision: a.expectedRevision, trigger: a.trigger ?? null, afterPrs: a.afterPrs ?? [] }) },
  // PR sheet: what the merge controls see (Send to Paseo, Graphite in Chrome)
  { name: "pr_controls", rpc: "follow.pr-control-status", kind: "read", input: z.strictObject({ workspaceId: id, prKey: z.string().trim().regex(/^[\w.-]+\/[\w.-]+#\d+$/) }) },
  { name: "browser_status", rpc: "follow.browser-status", kind: "read", input: none },
  // Settings → Permissions: trust bypass agents' approvals
  { name: "trust_bypass_status", rpc: "follow.trust-bypass", kind: "read", input: none },
];

/** Settings → Display (host-scoped preferences, trust bypass among them): read and planned write, served by the host. */
export const DISPLAY_TOOLS = ["display_settings", "set_display"] as const;

/**
 * Every RPC the client calls, and the agent tools that do the same thing. scripts and tests/agent-parity.test.ts read
 * the client's imports: a new developer RPC without an entry here fails the test. An exemption needs a reason.
 */
export const PARITY: Record<string, { tools: readonly string[]; note?: string } | { exempt: string } | { pending: string }> = {
  "follow.list": { tools: ["list_prs", "workspace_status"] },
  "follow.get": { tools: ["list_prs", "workspace_status"] },
  "follow.control": { tools: ["set_auto_send", "clear_hold", "retry_batch"], note: "mainAgentId (Make main agent) is pending; see follow.control#mainAgentId." },
  "follow.control#mainAgentId": { pending: "make_main_agent waits for the claim rules (~/paseo-harness/main-agent-claim.md) to be approved by Tom." },
  "follow.send": { tools: ["send_repairs"] },
  "follow.recover": { tools: ["run_recovery"] },
  "follow.refresh": { tools: ["refresh"] },
  "follow.request-reviewers": { tools: ["add_reviewers"] },
  "follow.prepare-pr-action": { tools: ["merge", "enable_merge_when_ready", "disable_merge_when_ready"] },
  "follow.confirm-pr-action": { tools: ["merge", "enable_merge_when_ready", "disable_merge_when_ready"] },
  "follow.check-pr-action": { exempt: "The PR sheet polls a confirmed action's progress; the agent's confirm call returns that result itself." },
  "follow.pr-control-status": { tools: ["pr_controls"] },
  "follow.browser-status": { tools: ["browser_status"] },
  "follow.follow-settings": { tools: ["follow_settings"] },
  "follow.set-follow-settings": { tools: ["set_follow_settings"] },
  "follow.project-settings": { tools: ["project_settings"] },
  "follow.set-project-tracking": { tools: ["set_project_tracking"] },
  "follow.pr-workflow": { tools: ["pr_workflow", "agent_settings"] },
  "follow.set-pr-workflow": { tools: ["set_pr_workflow"] },
  "follow.reviewer-settings": { tools: ["reviewer_settings"] },
  "follow.reviewer-suggestions": { tools: ["reviewer_suggestions"] },
  "follow.save-reviewers": { tools: ["save_reviewers"] },
  "follow.agent-settings": { tools: ["agent_settings"] },
  "follow.set-agent-setting": { tools: ["set_agent_setting"] },
  "follow.onboarding": { tools: ["onboarding_status"] },
  "follow.onboarding-checks": { tools: ["onboarding_checks"] },
  "follow.set-onboarding": { tools: ["set_onboarding"] },
  "follow.priorities": { tools: ["priorities", "set_priorities"] },
  "follow.rank-status": { tools: ["rank_status"] },
  "follow.rank-now": { tools: ["rerank_priorities"] },
  "follow.usage": { tools: ["usage"] },
  "follow.overseer-status": { tools: ["overseer_status"] },
  "follow.overseer-start": { tools: ["overseer_start"] },
  "follow.overseer-restart": { tools: ["overseer_restart"] },
  "follow.overseer-ask": { tools: ["overseer_ask"] },
  "follow.inbox-list": { tools: ["inbox_list"] },
  "follow.inbox-brief": { tools: ["inbox_brief"] },
  "follow.inbox-act": { tools: ["sign_off", "snooze", "set_finish_flags", "inbox_act"] },
  "follow.brief-action": { tools: ["brief_action"] },
  "follow.answer-question": { tools: ["answer_question"] },
  "follow.workspace-about": { tools: ["workspace_about"] },
  "follow.workspace-spec": { tools: ["set_workspace_spec", "set_spec"] },
  "follow.set-task-trigger": { tools: ["set_task_trigger", "update_obligation"] },
  "follow.trust-bypass": { tools: ["trust_bypass_status", "display_settings"] },
  "settings.display": { tools: ["display_settings", "set_display"] },
};
