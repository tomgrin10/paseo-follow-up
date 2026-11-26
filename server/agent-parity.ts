import { MAX_IMAGES } from "../shared/images";
import { z } from "zod";
import { AGENT_ROLES, savedRoleSchema } from "../shared/agent-settings";
import { ONBOARDING_ACTIONS, ONBOARDING_STEPS } from "../shared/onboarding";
import { setPrWorkflowInputSchema } from "../shared/pr-workflow";
import { prStatsInputSchema, setPrStatsInputSchema, statsRepoName } from "../shared/pr-stats-settings";
import { reviewerListSchema } from "../shared/reviewers";
import { taskTriggerInputSchema } from "../shared/task-trigger";
import { UPDATE_MODES } from "../shared/updates";
import { briefChoiceSchema, reportKindSchema } from "../shared/contracts";
import { actionChangeSchema, settingsChangeSchema } from "../shared/dispatch";
import { linearQueueInputSchema } from "../shared/contracts";
import { briefPlanInputSchema, compassSetSchema, planChangeSchema, queueChangeSchema } from "../shared/morning-brief";
import { sourcesChangeSchema } from "../shared/brief-sources";
import { noteActionBase } from "../shared/compass";

/**
 * Agent parity, part 2 (1.4.0-beta.21): tools that are a developer RPC one-to-one. A read runs the RPC's handler; a
 * write is planned: the dry run shows what the developer's screen shows now (`before`) and the change, and
 * `confirm: true` with the plan's id runs the same handler the button runs. Writes are noted in the inbox ledger as
 * `agent:<id>`, like every agent action.
 *
 * `guard` refuses calls an agent must never make for itself (answering its own question, acting on its own brief).
 */
/**
 * An agent tool's pasted images (every-agent-field-takes-images): local file paths, read and checked at the dry run
 * (a regular readable file, an image by its first bytes, under the caps: server/image-store.ts readImageFiles).
 */
export const imagePaths = z.array(z.string().trim().min(1).max(4096)).max(MAX_IMAGES).optional();
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
  // PR statistics (docs/pr-stats.md): the page's model, Settings → PR statistics, and its writes. Turning a repository
  // on shows the estimate first (the dry run's `before`), like the opt-in sheet.
  { name: "pr_stats", rpc: "follow.pr-stats", kind: "read", input: prStatsInputSchema },
  { name: "pr_stats_settings", rpc: "follow.pr-stats-settings", kind: "read", input: z.strictObject({ repo: statsRepoName.optional(), estimate: z.boolean().optional() }) },
  { name: "set_pr_stats", rpc: "follow.set-pr-stats", kind: "planned", before: { rpc: "follow.pr-stats-settings", input: a => ({ ...(a.repo ? { repo: a.repo } : {}), estimate: a.enable === true }) }, input: setPrStatsInputSchema.extend(confirm) },
  // Settings → Reviewers
  { name: "reviewer_settings", rpc: "follow.reviewer-settings", kind: "read", input: none },
  { name: "reviewer_suggestions", rpc: "follow.reviewer-suggestions", kind: "read", input: z.strictObject({ repo }) },
  { name: "save_reviewers", rpc: "follow.save-reviewers", kind: "planned", before: { rpc: "follow.reviewer-settings" },
    input: z.strictObject({ repo: repo.nullable().optional(), reviewers: reviewerListSchema.optional(), ...confirm }), toRpc: a => ({ repo: a.repo ?? null, reviewers: a.reviewers }) },
  // Settings → Agents
  { name: "set_agent_setting", rpc: "follow.set-agent-setting", kind: "planned", before: { rpc: "follow.agent-settings", input: () => ({}) },
    input: z.strictObject({ role: z.enum(AGENT_ROLES).optional(), entry: savedRoleSchema.nullable().optional(), ...confirm }) },
  { name: "set_wait_for_jobs", rpc: "follow.set-wait", kind: "planned", before: { rpc: "follow.agent-settings", input: () => ({}) },
    input: z.strictObject({ enable_wait: z.boolean().optional(), ...confirm }) },
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
  { name: "overseer_ask", rpc: "follow.overseer-ask", kind: "planned", input: z.strictObject({ text: z.string().trim().min(1).max(2000).optional(), images: imagePaths, ...confirm }) },
  // Catch up's deck; Your questions and More context (ask, read, act); the asked agent answers with context_reply
  { name: "catch_up_deck", rpc: "follow.catch-up-deck", kind: "read", input: none },
  { name: "context_requests", rpc: "follow.context-list", kind: "read", input: z.strictObject({ workspaceId: id.optional(), state: z.enum(["all", "open", "tasks"]).optional(), query: z.string().max(200).optional() }) },
  { name: "ask_context", rpc: "follow.context-ask", kind: "planned", before: { rpc: "follow.context-list", input: a => ({ workspaceId: a.workspaceId ?? undefined }) },
    input: z.strictObject({ workspaceId: id.nullable().optional(), agentId: id.nullable().optional(), cardKey: z.string().min(1).max(400).optional(), card: z.string().trim().min(1).max(300).optional(),
      target: z.enum(["overseer", "agent"]).optional(), ask: z.string().trim().min(1).max(2000).optional(), images: imagePaths, ...confirm }),
    // With cardKey: More context, to the card's workspace main agent (target accepted and ignored). Without: a free
    // question to agentId, else the workspace's main agent. Never the caller itself (an-ask-goes-only-to-an-agent-that-can-answer-it).
    toRpc: a => ({ workspaceId: a.workspaceId ?? null, agentId: a.agentId ?? null, cardKey: a.cardKey ?? null, ...(a.card ? { card: a.card } : {}), target: a.target, ask: a.ask, ...(a.images ? { images: a.images } : {}) }) },
  { name: "question_action", rpc: "follow.question-action", kind: "planned", before: { rpc: "follow.context-list", input: () => ({}) },
    input: z.strictObject({ id: z.string().min(1).max(80).optional(), action: z.enum(["done", "reply", "task", "withdraw"]).optional(), text: z.string().trim().min(1).max(2000).optional(), images: imagePaths, ...confirm }),
    toRpc: a => ({ id: a.id, action: a.action, ...(a.text ? { text: a.text } : {}), ...(a.images ? { images: a.images } : {}) }) },
  // Needs-you: the brief card and the inbox's other actions
  // The message queue: what waits to go to agents, and Retry or Cancel on one item (a card's Retry, Needs you's message row).
  { name: "queue_list", rpc: "follow.queue-list", kind: "read", input: z.strictObject({ workspaceId: id.optional(), agentId: id.optional() }) },
  { name: "queue_action", rpc: "follow.queue-action", kind: "planned", before: { rpc: "follow.queue-list", input: () => ({}) },
    input: z.strictObject({ itemId: z.string().min(1).max(400).optional(), action: z.enum(["retry", "cancel"]).optional(), ...confirm }) },
  { name: "inbox_brief", rpc: "follow.inbox-brief", kind: "read", input: z.strictObject({ agentId: id }) },
  { name: "brief_action", rpc: "follow.brief-action", kind: "planned", before: { rpc: "follow.inbox-brief", input: a => ({ agentId: a.agentId }) },
    input: z.strictObject({ agentId: id.optional(), briefId: z.string().max(300).optional(), decisionId: z.string().max(20).optional(), choice: briefChoiceSchema.optional(), words: z.string().trim().max(2000).optional(), move: z.enum(["retry", "done"]).optional(),
      choices: z.array(z.object({ decisionId: z.string().max(20), choice: briefChoiceSchema, words: z.string().trim().max(2000).optional() })).min(1).max(10).optional(), images: imagePaths, ...confirm }),
    guard: (a, caller) => a.agentId === caller ? "brief_action answers another agent's brief for the developer; your own brief is the developer's to answer." : null },
  { name: "inbox_act", rpc: "follow.inbox-act", kind: "planned",
    input: z.strictObject({ action: z.enum(["undo", "unsnooze", "mute_turn", "unsorted_flag", "unsorted_sign_off", "batch_undo"]).optional(), agentIds: z.array(id).max(500).optional(), muteTurn: z.boolean().optional(), ...confirm }),
    guard: (a, caller) => a.agentIds?.includes(caller) ? "inbox_act is for other agents' rows, not your own." : null },
  // Questions: the developer's answer to another agent's question
  { name: "answer_question", rpc: "follow.answer-question", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), questionId: z.string().regex(/^Q\d+$/).optional(), choice: z.string().trim().min(1).max(200).optional(), words: z.string().trim().max(2000).optional(), images: imagePaths, ...confirm }),
    toRpc: a => ({ workspaceId: a.workspaceId, questionId: a.questionId, choice: a.choice, words: a.words, action: "send", ...(a.images ? { images: a.images } : {}) }) },
  // dismissing-anything-in-needs-you-sends-the-agent-nothing: the small x on every Needs-you item and brief.
  { name: "dismiss_item", rpc: "follow.dismiss", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), key: z.string().min(1).max(400).optional(), agentId: id.optional(), issue: z.string().max(30).optional(), compass: z.string().min(1).max(80).optional(), undo: z.boolean().optional(), ...confirm }),
    toRpc: a => ({ ...(a.agentId ? { agentId: a.agentId } : a.issue ? { issue: a.issue } : a.compass ? { compass: a.compass } : { workspaceId: a.workspaceId, key: a.key }), ...(a.undo ? { undo: true } : {}) }),
    guard: (a, caller) => a.agentId === caller ? "dismiss_item dismisses another agent's brief for the developer; your own brief is the developer's to dismiss." : null },
  { name: "dismiss_question", rpc: "follow.dismiss-question", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), questionId: z.string().regex(/^Q\d+$/).optional(), undo: z.boolean().optional(), ...confirm }),
    toRpc: a => ({ workspaceId: a.workspaceId, questionId: a.questionId, ...(a.undo ? { undo: true } : {}) }) },
  // Workspace panel: recovery, refresh, the spec link, task triggers
  { name: "run_recovery", rpc: "follow.recover", kind: "planned", input: z.strictObject({ workspaceId: id.optional(), ...confirm }) },
  { name: "refresh", rpc: "follow.refresh", kind: "write", input: z.strictObject({ workspaceId: id.optional() }) },
  { name: "set_workspace_spec", rpc: "follow.workspace-spec", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), action: z.enum(["set", "remove", "reset"]).optional(), url: z.string().trim().min(1).max(2000).optional(), title: z.string().trim().max(120).nullable().optional(), ...confirm }) },
  { name: "set_task_trigger", rpc: "follow.set-task-trigger", kind: "planned",
    input: z.strictObject({ workspaceId: id.optional(), obligationId: id.optional(), expectedRevision: z.number().int().nonnegative().optional(), trigger: taskTriggerInputSchema.strict().nullable().optional(), afterPrs: z.array(id).optional(), ...confirm }),
    toRpc: a => ({ workspaceId: a.workspaceId, obligationId: a.obligationId, expectedRevision: a.expectedRevision, trigger: a.trigger ?? null, afterPrs: a.afterPrs ?? [] }) },
  // Linked items: the list sheet (read, Add link, remove, Undo) for any workspace
  { name: "link_items", rpc: "follow.linked-items", kind: "read", input: z.strictObject({ workspaceId: id }) },
  { name: "set_linked_items", rpc: "follow.set-linked-items", kind: "planned", before: { rpc: "follow.linked-items", input: a => ({ workspaceId: a.workspaceId }) },
    input: z.strictObject({ workspaceId: id.optional(), action: z.enum(["add", "remove", "undo"]).optional(), ref: z.string().trim().min(1).max(2000).optional(), title: z.string().trim().max(200).optional(), ...confirm }) },
  // PR sheet: what the merge controls see (Send to Paseo, Graphite in Chrome)
  { name: "pr_controls", rpc: "follow.pr-control-status", kind: "read", input: z.strictObject({ workspaceId: id, prKey: z.string().trim().regex(/^[\w.-]+\/[\w.-]+#\d+$/) }) },
  { name: "browser_status", rpc: "follow.browser-status", kind: "read", input: none },
  // What's new: the installed version, the one before it and when, and every shipped note (newest first)
  { name: "release_notes", rpc: "follow.release-notes", kind: "read", input: none },
  // Settings → General: status (mode, channel, newest versions, phase, pending notes, history), Check now, mode/channel, Install now
  { name: "updates_status", rpc: "follow.updates", kind: "read", input: none },
  { name: "check_updates", rpc: "follow.updates", kind: "write", input: none, toRpc: () => ({ check: "manual" }) },
  { name: "set_updates", rpc: "follow.set-updates", kind: "planned", before: { rpc: "follow.updates", input: () => ({}) },
    input: z.strictObject({ mode: z.enum(UPDATE_MODES).optional(), channel: z.enum(["stable", "beta"]).optional(), enable_whats_new: z.boolean().optional(), ...confirm }) },
  { name: "install_update", rpc: "follow.install-update", kind: "planned", before: { rpc: "follow.updates", input: () => ({}) },
    input: z.strictObject({ version: z.string().trim().min(1).max(64), anyway: z.boolean().optional(), ...confirm }) },
  // Settings → General: 2.0's move to the new plugin id (status is in updates_status), Try again
  { name: "retry_move", rpc: "follow.retry-move", kind: "planned", before: { rpc: "follow.updates", input: () => ({}) }, input: z.strictObject({ ...confirm }) },
  // Report an issue's Send: to an agent, a new agent in a workspace, or a new workspace (server/report-send.ts). The dry
  // run shows the targets the sheet offers; an agent reporting for itself files with report_issue instead.
  { name: "report_send", rpc: "follow.report-issue-send", kind: "planned", before: { rpc: "follow.report-issue-targets", input: () => ({}) },
    input: z.strictObject({ kind: reportKindSchema.optional(), text: z.string().max(8000).optional(), error: z.string().max(2000).nullable().optional(), agentId: id.optional(), newAgentWorkspaceId: id.optional(), newWorkspaceProjectId: id.optional(), ...confirm }),
    guard: (a, caller) => {
      if (a.confirm) return null;
      if (!a.kind || a.text === undefined) return "report_send: give kind (bug, feature or feedback) and text (the developer's words).";
      const targets = [a.agentId, a.newAgentWorkspaceId, a.newWorkspaceProjectId].filter(Boolean).length;
      if (targets !== 1) return "report_send: give exactly one target: agentId, newAgentWorkspaceId or newWorkspaceProjectId (follow.report-issue-targets lists them).";
      return a.agentId === caller ? "report_send: that's you. To report it yourself, use report_issue." : null;
    } },
  // Settings → Permissions: trust bypass agents' approvals
  { name: "trust_bypass_status", rpc: "follow.trust-bypass", kind: "read", input: none },
  // New (docs/dispatch.md): what it lists, its recent starts and Undo, its actions and where work goes. `dispatch` itself
  // is AgentActions' own plan (a dry run that freezes what it would send).
  { name: "dispatch_sources", rpc: "follow.dispatch-sources", kind: "read", input: z.strictObject({ fresh: z.boolean().optional(), query: z.string().trim().min(1).max(200).optional() }) },
  { name: "dispatch_records", rpc: "follow.dispatch-records", kind: "read", input: none },
  { name: "dispatch_undo", rpc: "follow.dispatch-undo", kind: "planned", before: { rpc: "follow.dispatch-records", input: () => ({}) }, input: z.strictObject({ dispatchId: id.optional(), ...confirm }) },
  { name: "dispatch_actions", rpc: "follow.dispatch-actions", kind: "read", input: none },
  { name: "set_dispatch_actions", rpc: "follow.set-dispatch-actions", kind: "planned", before: { rpc: "follow.dispatch-actions", input: () => ({}) }, input: z.strictObject({ change: actionChangeSchema.optional(), ...confirm }) },
  { name: "dispatch_settings", rpc: "follow.dispatch-settings", kind: "read", input: none },
  { name: "set_dispatch_settings", rpc: "follow.set-dispatch-settings", kind: "planned", before: { rpc: "follow.dispatch-settings", input: () => ({}) }, input: settingsChangeSchema.extend(confirm),
    toRpc: a => ({ rules: a.rules, bases: a.bases, noTeam: a.noTeam }) },
  // The Morning brief's Linear queue (docs/morning-brief.md). An agent reads without `open`, so it never moves the
  // developer's "since" (a-change-is-against-what-you-last-saw).
  { name: "linear_queue", rpc: "follow.linear-queue", kind: "read", input: linearQueueInputSchema.omit({ open: true }) },
  // Settings → Morning brief: the queue's settings and this week's plan. set_brief_plan's dry run reads the new link's
  // title first (brief_plan with link).
  { name: "brief_settings", rpc: "follow.brief-settings", kind: "read", input: none },
  { name: "set_brief_settings", rpc: "follow.set-brief-settings", kind: "planned", before: { rpc: "follow.brief-settings", input: () => ({}) }, input: queueChangeSchema.extend(confirm) },
  { name: "brief_plan", rpc: "follow.brief-plan", kind: "read", input: briefPlanInputSchema },
  { name: "set_brief_plan", rpc: "follow.set-brief-plan", kind: "planned", before: { rpc: "follow.brief-plan", input: a => (typeof a.link === "string" && a.link ? { link: a.link } : {}) }, input: planChangeSchema.extend(confirm) },
  // The brief's sources: on/off, Retry, check again (set_brief_sources is planned: the dry run shows the sources now).
  { name: "brief_sources", rpc: "follow.brief-sources", kind: "read", input: z.strictObject({ check: z.boolean().optional() }) },
  { name: "set_brief_sources", rpc: "follow.set-brief-sources", kind: "planned", before: { rpc: "follow.brief-sources", input: () => ({}) }, input: sourcesChangeSchema.extend(confirm) },
  { name: "brief_chat_search", rpc: "follow.brief-chat-search", kind: "read", input: z.strictObject({ kind: z.enum(["people", "channels"]), query: z.string().trim().min(1).max(100) }) },
  // Compass (docs/compass.md): the sources that set the developer's priorities. compass_find is the only way an agent
  // learns a place id; set_compass and read_compass are planned (the dry run shows Compass as it is now).
  { name: "compass", rpc: "follow.compass", kind: "read", input: z.strictObject({ workspace: z.string().min(1).max(200).optional() }) },
  { name: "compass_find", rpc: "follow.compass-find", kind: "read", input: z.strictObject({ kind: z.enum(["people", "channels"]), query: z.string().trim().min(1).max(100) }) },
  { name: "set_compass", rpc: "follow.set-compass", kind: "planned", before: { rpc: "follow.compass", input: () => ({}) }, input: compassSetSchema.extend(confirm) },
  // A note by hand: pin, edit, unpin, or Tell the agent (compass-reaches-an-agent-only-by-a-click: a tell is planned, so
  // an agent's tell needs the developer's confirm, like the click). why_suggested reads the notes behind a ranking.
  { name: "compass_note", rpc: "follow.compass-note", kind: "planned", before: { rpc: "follow.compass", input: (a: { workspace?: string }) => (a.workspace ? { workspace: a.workspace } : {}) }, input: noteActionBase.extend(confirm) },
  { name: "why_suggested", rpc: "follow.why-suggested", kind: "read", input: z.strictObject({ workspace: z.string().min(1).max(200).optional(), issue: z.string().min(1).max(60).optional(), note: z.string().min(1).max(80).optional() }) },
  { name: "read_compass", rpc: "follow.read-compass", kind: "planned", before: { rpc: "follow.compass", input: () => ({}) }, input: z.strictObject({ ...confirm }), toRpc: () => ({}) },
  { name: "sweep_queue", rpc: "follow.sweep-queue", kind: "planned", before: { rpc: "follow.linear-queue", input: () => ({ limit: 1 }) }, input: z.strictObject({ ...confirm }), toRpc: () => ({}) },
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
  "follow.control": { tools: ["set_auto_send", "clear_hold", "retry_batch", "make_main_agent", "snooze_workspace"] },
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
  "follow.pr-stats": { tools: ["pr_stats"], note: "The page's leaderboard, a person's drill-down (person) and a refresh (fresh); pr_stats also returns the waiting-now list the page leaves out." },
  "follow.pr-stats-settings": { tools: ["pr_stats_settings"], note: "With estimate: true it is the opt-in sheet's numbers; set_pr_stats enable shows them as its dry run." },
  "follow.set-pr-stats": { tools: ["set_pr_stats"] },
  "follow.reviewer-settings": { tools: ["reviewer_settings"] },
  "follow.reviewer-suggestions": { tools: ["reviewer_suggestions"] },
  "follow.save-reviewers": { tools: ["save_reviewers"] },
  "follow.agent-settings": { tools: ["agent_settings"] },
  "follow.set-agent-setting": { tools: ["set_agent_setting"] },
  "follow.set-wait": { tools: ["set_wait_for_jobs"] },
  "follow.onboarding": { tools: ["onboarding_status"] },
  "follow.onboarding-checks": { tools: ["onboarding_checks"] },
  "follow.set-onboarding": { tools: ["set_onboarding"] },
  "follow.priorities": { tools: ["priorities", "set_priorities"] },
  "follow.rank-status": { tools: ["rank_status"] },
  "follow.brief-settings": { tools: ["brief_settings"] },
  "follow.set-brief-settings": { tools: ["set_brief_settings"] },
  "follow.set-brief-plan": { tools: ["set_brief_plan"] },
  "follow.brief-sources": { tools: ["brief_sources"] },
  "follow.set-brief-sources": { tools: ["set_brief_sources"] },
  "follow.compass": { tools: ["compass"] },
  "follow.compass-find": { tools: ["compass_find"] },
  "follow.set-compass": { tools: ["set_compass"] },
  "follow.read-compass": { tools: ["read_compass"] },
  "follow.compass-note": { tools: ["compass_note"] },
  "follow.rank-now": { tools: ["rerank_priorities"] },
  "follow.usage": { tools: ["usage"] },
  "follow.overseer-status": { tools: ["overseer_status"] },
  "follow.overseer-start": { tools: ["overseer_start"] },
  "follow.overseer-restart": { tools: ["overseer_restart"] },
  "follow.overseer-ask": { tools: ["overseer_ask"] },
  "follow.inbox-list": { tools: ["inbox_list"] },
  "follow.context-ask": { tools: ["ask_context"] },
  "follow.image-support": { exempt: "The field's warning before Send. An agent's tool passes image paths to the same RPCs, and the server leaves images off for a recipient that can't take them and says so in the message (imageSupport), so a tool never has to ask first." },
  "follow.context-list": { tools: ["context_requests"] },
  "follow.question-action": { tools: ["question_action"] },
  "follow.inbox-brief": { tools: ["inbox_brief"] },
  "follow.queue-action": { tools: ["queue_action"] },
  "follow.inbox-act": { tools: ["sign_off", "snooze", "set_finish_flags", "inbox_act"] },
  "follow.brief-action": { tools: ["brief_action"] },
  "follow.dismiss": { tools: ["dismiss_item", "dismiss_question"], note: "The small x on every Needs-you item and brief. The server refuses an agent's own brief, question or workspace; undo: true is the toast's Undo. dismiss_question (follow.dismiss-question, which the client no longer calls) stays as the question-only alias of dismiss_item with key question:Qn." },
  "follow.answer-question": { tools: ["answer_question"], note: "The tool sends (action send). Copy and Put in chat (action copy, chat) only move the developer's own words into their clipboard or their composer for them to send; an agent answers by sending, so it has no Put in chat." },
  "follow.workspace-about": { tools: ["workspace_about"] },
  "follow.rename-status": { tools: ["ai_rename"], note: "The dry run shows the name now and the suggestion." },
  "follow.rename-workspace": { tools: ["ai_rename"], note: "confirm=true renames; undo=true plans Undo." },
  "follow.linked-items": { tools: ["link_items"] },
  "follow.set-linked-items": { tools: ["set_linked_items", "link_item", "unlink_item"] },
  "follow.linked-index": { tools: ["link_items"], note: "Home's search over every workspace's links; an agent reads them per workspace with link_items." },
  "follow.workspace-spec": { tools: ["set_workspace_spec", "set_spec"] },
  "follow.set-task-trigger": { tools: ["set_task_trigger", "update_obligation"] },
  "follow.trust-bypass": { tools: ["trust_bypass_status", "display_settings"] },
  "settings.display": { tools: ["display_settings", "set_display"] },
  "follow.release-notes": { tools: ["release_notes"] },
  "follow.updates": { tools: ["updates_status", "check_updates"] },
  "follow.set-updates": { tools: ["set_updates"] },
  "follow.install-update": { tools: ["install_update"] },
  "follow.client-time-zone": { exempt: "The device reports its timezone so an agent's tonight/tomorrow match the developer's clock; nothing for an agent to do." },
  "follow.retry-move": { tools: ["retry_move"] },
  "follow.dismiss-update-notice": { exempt: "Hides Home's update line for the person looking at it; updates_status already tells an agent what that line said." },
  "follow.report-issue-targets": { tools: ["report_issue"], note: "The Report sheet's agent picker. An agent asked to report files it itself with report_issue; it has no one to hand the prompt to." },
  "follow.report-issue-send": { tools: ["report_send", "report_issue"], note: "report_send hands a report to an agent, a new agent or a new workspace, as the sheet's Send does; an agent reporting for itself calls report_issue directly." },
  "follow.created-items": { tools: ["workspace_status"], note: "Read-only live facts for the chat's created-agent / created-workspace cards; an agent reads them through workspace_status and Paseo's own list_agents." },
  "follow.report-issue-link": { tools: ["report_issue"], note: "Open on GitHub with no agent to send to; report_issue's confirm returns the same prefilled link without GitHub auth." },
  "follow.whats-new-seen": { exempt: "Records that a person closed What's new on a device; an agent reading the notes isn't someone seeing the sheet." },
  // New (client/new.tsx, docs/dispatch.md).
  "follow.dispatch-sources": { tools: ["dispatch_sources"], note: "New's list: the developer's Linear issues and where each would go." },
  "follow.dispatch-preview": { tools: ["dispatch"], note: "The dialog's preview is dispatch's dry run (no confirm): the same plan, instructions and blockers." },
  "follow.dispatch": { tools: ["dispatch"], note: "confirm=true with the dry run's plan id starts exactly what the preview showed." },
  "follow.dispatch-records": { tools: ["dispatch_records"], note: "The dialog's progress while a dispatch starts; Home's row reads the same records from the home feed." },
  "follow.dispatch-undo": { tools: ["dispatch_undo"], note: "Undo in the dialog, the toast and Home's row: cancel a queued dispatch or archive what it created, inside the window." },
  "follow.dispatch-settings": { tools: ["dispatch_settings"], note: "The Project picker's list of projects, and Settings → New work's rules, bases and no-team rule." },
  "follow.set-dispatch-settings": { tools: ["set_dispatch_settings"], note: "Changing From saves the base for that project; Settings → New work adds, changes and removes team rules, bases and the no-team rule, as set_dispatch_settings does." },
  "follow.dispatch-actions": { tools: ["dispatch_actions"], note: "Settings → New work's Actions list: every action in New's order, shown or hidden; the Morning brief's Since lines show the first two." },
  "follow.set-dispatch-actions": { tools: ["set_dispatch_actions"], note: "Settings → New work's move, show/hide, reset, delete and reset-all, the same changes set_dispatch_actions makes." },
  "follow.linear-queue": { tools: ["linear_queue"], note: "The brief's Since block, the queue screen and its raised Needs-you items. Only the developer's brief pane passes open (it marks the read \"since\" stands on), so linear_queue never moves it." },
  "follow.sweep-queue": { tools: ["sweep_queue"], note: "The queue screen's Sweep now." },
};

/**
 * Developer features that change only what one person's view shows (no RPC, nothing stored), and the agent tools
 * that already read the same data. An agent never sees the developer's panel, so there is nothing to mirror; the
 * note says where an agent finds what the developer found.
 */
export const VIEW_PARITY: Record<string, { tools: readonly string[]; note: string }> = {
  "catch-up": { tools: ["catch_up_deck", "answer_question", "dismiss_question", "dismiss_item", "brief_action", "inbox_act", "snooze", "ask_context"], note: "Catch up deals Needs you one card at a time; moving between cards (Skip, Skip workspace, Back, the phone's drag) changes only the developer's view, so it has no server state and no tool. catch_up_deck reads the same deck, and every act on a card is a tool: answer_question, brief_action, inbox_act and snooze (Later), ask_context (More context). A permission is Paseo's own respond_to_permission." },
  "section-search": { tools: ["workspace_status", "list_prs"], note: "The panel's Pull requests, Tasks and Activity search filters lists an agent already reads whole: workspace_status returns the workspace's PRs (title, branch, failed checks), tasks with their evidence, questions with their answers, and the sends, merges and PR actions the timeline is drawn from; list_prs returns every tracked PR with its checks." },
};
