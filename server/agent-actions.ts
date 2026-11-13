import { sendingOf } from "../shared/sending";
import { agentActor, type Actor } from "../shared/actor";
import { conditionId, noProgressSends } from "../shared/send-decision";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionPlan } from "../shared/pr-actions";
import { mergeBlockers } from "../shared/pr-actions";
import { recoveryBatch } from "../shared/follow-up";
import { flagHeadline } from "../shared/headline";
import { resolveUntil, type InboxRow } from "../shared/inbox";
import { needKey, needsYou } from "../shared/attention";
import type { Pr, State, Workspace } from "../shared/model";
import { configuredReviewers, reviewerLoginSchema, noReviewers, resolveReviewers, reviewerConfig, reviewerLabel, withoutAuthor, type ReviewerEntry } from "../shared/reviewers";
import { findWorkspace } from "./engine";
import { checkMainClaim, lastMainChange, setMainAgent, type MainAgentInfo } from "./discovery";
import type { InboxAction } from "./inbox";
import { priorityInputSchema, type Priority } from "../shared/priorities";
import type { AboutView } from "../shared/about";
import { ROLE_INFO, roleSummary, type RoleConfig } from "../shared/agent-settings";
import { DISPLAY_TOOLS, RPC_TOOLS, type RpcTool } from "./agent-parity";
import { waitNote, type WaitStatus } from "../shared/wait";
import { reportInputSchema } from "./report-issue";
import type { RenameStatus } from "../shared/rename";
import { DISPLAY_KEYS, displayPreferences } from "../shared/display";
import { DEFAULT_SORT, SORT_MODES } from "../shared/sort";

/**
 * Agent parity: every action the developer can click in Follow-up has a tool that runs the same server path.
 *
 * Each tool calls the method the button's RPC calls (PrActions, Engine, Inbox.act, controlWorkspace), so the
 * inbox, briefs and state change exactly as if the developer clicked. Tools that act on a list, and merge,
 * return a dry-run plan first; `confirm: true` with that plan's id runs it. Every agent write is recorded in
 * the inbox ledger as `by: "agent:<id>"`, which never counts as the developer writing to the agent.
 */
export const AGENT_TOOLS = ["make_main_agent", "list_prs", "add_reviewers", "merge", "enable_merge_when_ready", "disable_merge_when_ready", "send_repairs", "set_auto_send", "clear_hold", "retry_batch", "track", "inbox_list", "sign_off", "snooze", "snooze_workspace", "set_finish_flags", "set_priorities", "workspace_about", "agent_settings", "follow_settings", "set_follow_settings", "project_settings", "set_project_tracking", "pr_workflow", "set_pr_workflow", "reviewer_settings", "reviewer_suggestions", "save_reviewers", "set_agent_setting", "set_wait_for_jobs", "onboarding_status", "onboarding_checks", "set_onboarding", "priorities", "rank_status", "rerank_priorities", "usage", "overseer_status", "overseer_start", "overseer_restart", "overseer_ask", "inbox_brief", "brief_action", "inbox_act", "answer_question", "run_recovery", "refresh", "set_workspace_spec", "set_task_trigger", "pr_controls", "browser_status", "trust_bypass_status", "release_notes", "link_items", "set_linked_items", "updates_status", "check_updates", "set_updates", "install_update", "display_settings", "set_display", "retry_move", "report_issue", "ai_rename"] as const;
export type AgentTool = typeof AGENT_TOOLS[number];
/** Tools that only read. */
export const READ_ONLY_TOOLS: readonly AgentTool[] = ["list_prs", "inbox_list", "workspace_about", "agent_settings", "display_settings", ...RPC_TOOLS.filter(t => t.kind === "read").map(t => t.name as AgentTool)];
/** Tools that can't be undone from Follow-up. */
export const DESTRUCTIVE_TOOLS: readonly AgentTool[] = ["merge"];
/** Tools that plan first and run only with `confirm: true` and the plan's id. */
export const PLANNED_TOOLS: readonly AgentTool[] = ["make_main_agent", "add_reviewers", "merge", "enable_merge_when_ready", "disable_merge_when_ready", "sign_off", "snooze", "snooze_workspace", "set_finish_flags", "set_priorities", "set_display", "ai_rename", ...RPC_TOOLS.filter(t => t.kind === "planned").map(t => t.name as AgentTool)];
/** Tools with a dry run and confirm of their own (not AgentActions' plans): report_issue (server/report-issue/). */
export const SELF_PLANNED_TOOLS: readonly AgentTool[] = ["report_issue"];
const RPC_TOOL = new Map<string, RpcTool>(RPC_TOOLS.map(t => [t.name, t]));
void DISPLAY_TOOLS;

/** The developer's control panel switches (Auto-send, Resume, Retry). The button and the agent tool share it. */
/** `timeZone`: where a snooze's "tonight"/"tomorrow" are (the developer's, from their client; the host's without one). */
export function controlWorkspace(state: State, input: { workspaceId: string; enable_auto_sends?: boolean; clearHold?: boolean; retryBatchId?: string; retryTask?: string; taskAuto?: { key: string; auto: boolean }; mainAgentId?: string; snooze?: { until: string } | null }, now = Date.now(), timeZone?: string | null): Workspace {
  const w = findWorkspace(state, input.workspaceId);
  if (!w.enable_tracking || w.archived) throw new Error("Activate this workspace before changing follow-up controls.");
  if (input.mainAgentId && input.mainAgentId !== w.mainAgentId) {
    if (!w.contributorAgentIds?.includes(input.mainAgentId)) throw new Error("That agent isn't one of this workspace's root agents. Refresh and pick another.");
    setMainAgent(w, input.mainAgentId, "developer", now);
  }
  if (input.enable_auto_sends !== undefined) w.enable_auto_sends = input.enable_auto_sends;
  // Later on a workspace-only Needs-you row, and Bring back now (null).
  if (input.snooze === null) w.snooze = null;
  else if (input.snooze) {
    const until = resolveUntil(input.snooze.until, new Date(now), timeZone);
    if (!until || until.startsWith("pr:")) throw new Error("snooze: give until as next-event, 1h, tonight, tomorrow or an ISO time.");
    const items = needsYou(w, now);
    if (!items.length) throw new Error("Nothing needs you on this workspace, so there's nothing to put off.");
    w.snooze = { until, at: new Date(now).toISOString(), keys: items.map(needKey) };
  }
  if (input.clearHold) w.hold = null;
  if (input.retryTask) {
    // Re-arm one capped condition for NO_PROGRESS_CAP more sends; the next refresh puts it in the next message.
    const h = w.heldTasks?.find(h => h.held === "capped" && h.task.key === input.retryTask);
    if (!h) throw new Error("That task isn't waiting for a retry. Refresh to see its state.");
    const id = conditionId(h.task);
    w.taskRetries = { ...w.taskRetries, [id]: (w.taskRetries?.[id] ?? 0) + noProgressSends(w, h.task) };
    w.heldTasks = w.heldTasks!.filter(x => x !== h);
  }
  if (input.taskAuto) {
    const keys = new Set(w.manualTasks ?? []);
    if (input.taskAuto.auto) keys.delete(input.taskAuto.key); else keys.add(input.taskAuto.key);
    w.manualTasks = [...keys];
  }
  if (input.retryBatchId) {
    const b = w.batches.find(b => b.id === input.retryBatchId);
    if (!b || !["blocked", "uncertain"].includes(b.state)) throw new Error("This batch cannot be retried.");
    if (b.attempts >= 3) throw new Error("Three delivery attempts were made. Resolve this batch with the main agent.");
    b.state = "cancelled";
    w.batches.push({ ...b, ...(recoveryBatch(b) ? { enable_manual_recovery: true } : {}), id: randomUUID(), messageId: randomUUID(), state: "pending", attempts: b.attempts + 1, createdAt: new Date(now).toISOString(), sentAt: null, settledAt: null, result: "", activityAt: null, acknowledgmentError: null });
  }
  const at = new Date(now).toISOString();
  if (input.clearHold || input.retryBatchId && !recoveryBatch(w.batches.find(b => b.id === input.retryBatchId)!)) { w.completion = null; w.declaration = null; w.updatedAt = at; }
  else w.updatedAt = at;
  return w;
}

type Result = { state: "submitted" | "failed" | "uncertain"; result: string };
export type AgentActionDeps = {
  /** The resource governor holds auto-sends machine-wide: queued Sending rows say they go out when it eases. */
  autoSendsHeld?: () => boolean;
  /** The developer's IANA timezone, as their Follow-up client last reported it: snooze's "tonight"/"tomorrow" use it. */
  timeZone?: () => string | null;
  store: { snapshot(): Promise<State>; mutate<T>(fn: (state: State) => T): Promise<T> };
  prActions: {
    prepare(workspaceId: string, key: string, kind: "merge" | "enable_mwr" | "disable_mwr"): Promise<ActionPlan>;
    confirm(planId: string, scope: "target" | "downstack"): Promise<Result>;
    requestReviewers(workspaceId: string, key: string, logins?: string[]): Promise<Result>;
  };
  engine: { sendPending(workspaceId: string, batchId: string): Promise<Workspace>; activate(workspaceId: string): Promise<Workspace> };
  inbox: {
    list(): Promise<{ enabled: boolean; rows: InboxRow[] }>;
    act(input: InboxAction): Promise<{ results: { agentId: string; ok: boolean; cameBack: boolean }[] }>;
    noteAction(by: string, agentId: string, action: string): Promise<void>;
  };
  reviewersFor?: (repo: string) => ReviewerEntry[];
  priorities?: { write(batch: Priority[], replace: boolean): Promise<Priority[]> };
  /** Summary: one sentence on what a workspace is for, written now if there is none yet (or refresh). */
  about?: { view(workspaceId: string, opts: { open?: boolean; wait?: boolean; refresh?: boolean }): Promise<AboutView> };
  /** Settings → Agents, read-only: which agent each special role uses. No write tool. */
  agentSettings?: { all(): Promise<Record<string, RoleConfig>> };
  /** Settings → Agents → Wait for background jobs, for agent_settings (set_wait_for_jobs is an RPC tool). */
  wait?: { status(): Promise<WaitStatus> };
  /** Each known repository's PR workflow (Settings → Following → Shipping PRs). */
  prWorkflows?: () => Promise<{ default: string; repos: { repo: string; effective: string; setting: string; reason: string; reviewFix: unknown }[]; reviewFix: unknown }>;
  /** Runs a developer RPC's own handler (the button's path), and checks an input against its contract. */
  rpc?: { call(method: string, input: unknown, actor?: Actor): Promise<unknown>; validate(method: string, input: unknown): Promise<unknown> };
  /** The acting agent's title, for the "on the developer's behalf" record (shared/actor.ts). The caller is live, so reading it wakes nothing. */
  agentTitle?: (agentId: string) => Promise<string | null>;
  /** One agent's list entry for a main-agent claim (metadata; never loads it). Null when it's gone. */
  agentInfo?: (agentId: string) => Promise<MainAgentInfo>;
  /** Settings → Display (host-scoped preferences, trust bypass among them). */
  display?: { read(): Promise<{ revision: string; values: Record<string, unknown> }>; write(revision: string, values: Record<string, unknown>): Promise<unknown> };
  /** Report an issue (server/report-issue/): plans and files in Follow-up's repository with its own dry run and confirm. */
  report?: { run(caller: string, args: unknown): Promise<unknown> };
  now?: () => number;
};

const login = reviewerLoginSchema;
const prKey = z.string().trim().regex(/^[\w.-]+\/[\w.-]+#\d+$/, "Use owner/repo#number keys from list_prs.");
const id = z.string().trim().min(1).max(200);
const confirm = { planId: id.optional(), confirm: z.boolean().optional() };
const agentIds = z.array(id).min(1).max(100);
export const TOOL_INPUT = {
  list_prs: z.strictObject({ workspace: id.optional(), needs_reviewers: z.boolean().optional(), ready_to_merge: z.boolean().optional(), include_closed: z.boolean().optional() }),
  add_reviewers: z.strictObject({ prs: z.array(prKey).min(1).max(50).optional(), reviewers: z.array(login).min(1).max(15).optional(), ...confirm }),
  merge: z.strictObject({ pr: prKey.optional(), scope: z.enum(["target", "downstack"]).optional(), ...confirm }),
  enable_merge_when_ready: z.strictObject({ pr: prKey.optional(), scope: z.enum(["target", "downstack"]).optional(), ...confirm }),
  disable_merge_when_ready: z.strictObject({ pr: prKey.optional(), scope: z.enum(["target", "downstack"]).optional(), ...confirm }),
  send_repairs: z.strictObject({ workspace: id, batchId: id.optional() }),
  set_auto_send: z.strictObject({ workspace: id, value: z.boolean(), task: z.string().max(400).optional() }),
  clear_hold: z.strictObject({ workspace: id }),
  retry_batch: z.strictObject({ workspace: id, batchId: id.optional(), task: z.string().max(400).optional() }).refine(a => !!a.batchId !== !!a.task, "retry_batch: give batchId or task, not both"),
  track: z.strictObject({ workspace: id }),
  inbox_list: z.strictObject({ flagged_only: z.boolean().optional() }),
  workspace_about: z.strictObject({ workspaceId: id, refresh: z.boolean().optional() }),
  agent_settings: z.strictObject({}),
  sign_off: z.strictObject({ agentIds: agentIds.optional(), ...confirm }),
  snooze: z.strictObject({ agentIds: agentIds.optional(), until: z.string().trim().min(1).max(200).optional(), ...confirm }),
  ai_rename: z.strictObject({ workspaceId: id.optional(), title: z.string().trim().min(1).max(300).optional(), undo: z.boolean().optional(), ...confirm }),
  snooze_workspace: z.strictObject({ workspace: id.optional(), until: z.string().trim().min(1).max(200).optional(), bring_back: z.boolean().optional(), ...confirm }),
  set_finish_flags: z.strictObject({ agentIds: agentIds.optional(), value: z.boolean().optional(), ...confirm }),
  set_priorities: z.strictObject({ priorities: z.array(priorityInputSchema).max(200).optional(), replace: z.boolean().optional(), ...confirm }),
  display_settings: z.strictObject({}),
  make_main_agent: z.strictObject({ agentId: id.optional(), reason: z.string().trim().min(1).max(200).optional(), requested: z.enum(["developer", "self"]).optional(), ...confirm }),
  set_display: z.strictObject({ values: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(), ...confirm }),
  report_issue: reportInputSchema,
  ...Object.fromEntries(RPC_TOOLS.map(t => [t.name, t.input])),
} as unknown as Record<AgentTool, z.ZodType>;

/** One PR as an agent sees it: enough to decide "add reviewers on all" or "merge what's ready". */
export function prRow(w: Workspace, p: Pr) {
  const s = p.snapshot;
  const blockers = mergeBlockers(p);
  return {
    key: p.key, workspaceId: w.id, workspace: w.title, stack: p.stack, parent: p.parent, title: s?.title ?? null, url: s?.url ?? null,
    state: p.error ? "unknown" : s?.state ?? "unknown", draft: !!s?.draft, error: p.error,
    checks: !s ? "unknown" : s.failedChecks.length ? "failed" : s.checksPending ? "pending" : "passed", failedChecks: s?.failedChecks ?? [],
    openThreads: s?.threads.length ?? 0, reviewDecision: s?.reviewDecision ?? null,
    reviewers: s?.reviewers ? { requested: s.reviewers.requested, teams: s.reviewers.teams, reviewed: s.reviewers.reviewed } : null,
    // Read-only: who Add reviewers would ask here and where that list comes from (Settings → Reviewers).
    configuredReviewers: (({ reviewers, source }) => ({ source, reviewers: reviewers.map(r => ({ login: r.login, name: reviewerLabel(r) })) }))(resolveReviewers(reviewerConfig(), p.repo)),
    needsReviewers: noReviewers(p) && !s!.draft, mergeable: blockers.length === 0, mergeBlockers: blockers,
    // How this PR ships: "github" (gh pr merge, GitHub auto-merge) or "graphite". Older snapshots were Graphite's.
    prWorkflow: s?.prWorkflow ?? "graphite",
  };
}

type Plan = { id: string; tool: AgentTool; caller: string; expiresAt: number; run: () => Promise<unknown> };

export class AgentActions {
  private plans = new Map<string, Plan>();
  private reviewersFor: (repo: string) => ReviewerEntry[];
  private now: () => number;
  constructor(private d: AgentActionDeps) { this.reviewersFor = d.reviewersFor ?? configuredReviewers; this.now = d.now ?? Date.now; }

  /** Runs one tool for a verified root agent. The caller's identity is checked by the RPC before this. */
  async run(caller: string, tool: AgentTool, raw: unknown): Promise<unknown> {
    const parsed = TOOL_INPUT[tool].safeParse(raw ?? {});
    if (!parsed.success) throw new Error(`${tool}: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`);
    const args = parsed.data as Record<string, any>;
    if (PLANNED_TOOLS.includes(tool) && args.confirm) return this.confirm(caller, tool, args.planId);
    const rpcTool = RPC_TOOL.get(tool);
    if (rpcTool) return this.runRpc(caller, rpcTool, args);
    if (tool === "display_settings" || tool === "set_display") return this.displayTool(caller, tool, args);
    if (tool === "make_main_agent") return this.planMakeMain(caller, args);
    // Its own planned flow (dry run, planId, confirm with screenshot consent), so it isn't in PLANNED_TOOLS.
    if (tool === "report_issue") { if (!this.d.report) throw new Error("report_issue isn't available in this Follow-up."); return this.d.report.run(caller, args); }
    switch (tool) {
      case "list_prs": return this.listPrs(args);
      case "inbox_list": return this.inboxList(caller, args);
      case "workspace_about": return this.workspaceAbout(args as { workspaceId: string; refresh?: boolean });
      case "agent_settings": {
        if (!this.d.agentSettings) throw new Error("agent_settings isn't available in this Follow-up.");
        const roles = await this.d.agentSettings.all();
        const workflows = await this.d.prWorkflows?.().catch(() => null);
        const wait = await this.d.wait?.status().catch(() => null);
        return { ...(wait ? { waitForBackgroundJobs: { ...wait, note: waitNote(wait), change: "set_wait_for_jobs, only when the developer asks." } } : {}), roles: Object.values(roles).map(r => ({ ...r, summary: roleSummary(r), does: ROLE_INFO[r.role].does })), change: "The developer changes these in Follow-up settings → Agents.",
          ...(workflows ? { prWorkflow: { default: workflows.default, reviewFix: workflows.reviewFix, repos: workflows.repos.map(r => ({ repo: r.repo, workflow: r.effective, setting: r.setting, why: r.reason, reviewFix: r.reviewFix ?? workflows.reviewFix })), change: "The developer changes these in Follow-up settings → Following → Shipping PRs." } } : {}) };
      }
      case "add_reviewers": return this.planReviewers(caller, args);
      case "merge": return this.planPr(caller, tool, "merge", args);
      case "enable_merge_when_ready": return this.planPr(caller, tool, "enable_mwr", args);
      case "disable_merge_when_ready": return this.planPr(caller, tool, "disable_mwr", args);
      case "sign_off": case "snooze": case "set_finish_flags": return this.planInbox(caller, tool, args);
      case "set_priorities": return this.planPriorities(caller, args as { priorities?: z.infer<typeof priorityInputSchema>[]; replace?: boolean });
      case "send_repairs": return this.sendRepairs(caller, args as { workspace: string; batchId?: string });
      case "set_auto_send": return this.control(caller, tool, args.task ? { workspaceId: args.workspace, taskAuto: { key: args.task, auto: args.value } } : { workspaceId: args.workspace, enable_auto_sends: args.value });
      case "clear_hold": return this.control(caller, tool, { workspaceId: args.workspace, clearHold: true });
      case "ai_rename": return this.planRename(caller, args as { workspaceId?: string; title?: string; undo?: boolean });
      case "snooze_workspace": return this.planWorkspaceSnooze(caller, args as { workspace?: string; until?: string; bring_back?: boolean });
      case "retry_batch": return this.control(caller, tool, args.task ? { workspaceId: args.workspace, retryTask: args.task } : { workspaceId: args.workspace, retryBatchId: args.batchId });
      case "track": {
        const w = await this.d.engine.activate(args.workspace);
        await this.note(caller, w.mainAgentId, tool);
        return { workspaceId: w.id, title: w.title, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends };
      }
    }
  }

  private async note(caller: string, target: string | null | undefined, action: string) {
    if (target) await this.d.inbox.noteAction(`agent:${caller}`, target, action).catch(() => undefined);
  }
  private tracked(state: State): Workspace[] { return state.workspaces.filter(w => w.enable_tracking && !w.archived); }
  private findPr(state: State, key: string): { w: Workspace; p: Pr } {
    for (const w of this.tracked(state)) { const p = w.prs.find(p => p.key.toLowerCase() === key.toLowerCase()); if (p) return { w, p }; }
    throw new Error(`${key} isn't a PR in a tracked workspace. Use a key from list_prs.`);
  }
  private plan(caller: string, tool: AgentTool, run: () => Promise<unknown>, ttl = 5 * 60_000): string {
    for (const [key, p] of this.plans) if (p.expiresAt <= this.now()) this.plans.delete(key);
    const planId = randomUUID();
    this.plans.set(planId, { id: planId, tool, caller, expiresAt: this.now() + ttl, run });
    return planId;
  }
  private async confirm(caller: string, tool: AgentTool, planId: string | undefined) {
    if (!planId) throw new Error(`${tool}: confirm needs the planId from the dry run. Call ${tool} without confirm first.`);
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.now()) throw new Error("This plan expired or was already used. Run the dry run again.");
    if (plan.tool !== tool || plan.caller !== caller) throw new Error("This plan belongs to a different tool or agent. Run the dry run again.");
    this.plans.delete(planId);
    return plan.run();
  }

  /** A tool that is one developer RPC: reads run it; writes run it and are noted; planned writes dry-run first. */
  private async runRpc(caller: string, t: RpcTool, args: Record<string, any>) {
    if (!this.d.rpc) throw new Error(`${t.name} isn't available in this Follow-up.`);
    const refusal = t.guard?.(args, caller);
    if (refusal) throw new Error(refusal);
    const { planId: _p, confirm: _c, ...given } = args;
    const input = t.toRpc ? t.toRpc(given) : given;
    // Every RPC an agent tool runs carries the acting agent, so its handler never records the developer.
    const actor = agentActor(caller, await this.d.agentTitle?.(caller).catch(() => null));
    if (t.kind === "read") return this.d.rpc.call(t.rpc, input, actor);
    if (t.kind === "write") { const out = await this.d.rpc.call(t.rpc, input, actor); await this.note(caller, caller, t.name); return out; }
    // Planned: the RPC's own contract checks the arguments now, so a bad call fails at the dry run.
    const checked = await this.d.rpc.validate(t.rpc, input).catch((error: unknown) => { throw new Error(`${t.name}: ${error instanceof Error ? error.message : String(error)}`); });
    const before = t.before ? await this.d.rpc.call(t.before.rpc, t.before.input ? t.before.input(given) : {}).catch(() => null) : undefined;
    const planId = this.plan(caller, t.name as AgentTool, async () => { const out = await this.d.rpc!.call(t.rpc, checked, actor); await this.note(caller, caller, t.name); return out; });
    return { dryRun: true, planId, tool: t.name, change: checked, ...(before !== undefined ? { before } : {}),
      next: `Only when the developer asked for this: call ${t.name} with confirm=true and planId=${planId} within 5 minutes.` };
  }

  /**
   * make_main_agent: a root agent makes itself or another root agent of its workspace the main agent
   * (~/paseo-harness/main-agent-claim.md). The current main can hand its role on; anyone else follows checkMainClaim:
   * the developer's ask is refused only mid-turn, a self-claim needs the main archived, gone, long closed or idle.
   * The rules are checked again at confirm. The old main hears on its next turn through the hook, never by a message.
   */
  private async planMakeMain(caller: string, args: Record<string, any>) {
    if (!args.reason) throw new Error("make_main_agent: give reason, one line the developer sees (\"The developer asked me to take over the release\").");
    if (!args.requested) throw new Error("make_main_agent: give requested: developer (the developer asked for it) or self (your own claim).");
    if (!this.d.agentInfo) throw new Error("make_main_agent isn't available in this Follow-up.");
    const find = (state: State) => this.tracked(state).find(w => w.mainAgentId === caller || w.contributorAgentIds?.includes(caller));
    const w = find(await this.d.store.snapshot());
    if (!w) throw new Error("Only a root agent of a tracked workspace can change its main agent.");
    const target = args.agentId ?? caller; const from = w.mainAgentId;
    const requested = caller === from ? "developer" : args.requested as "developer" | "self";
    const check = async (current: Workspace) => checkMainClaim(current, target, requested, caller === from ? null : await this.d.agentInfo!(current.mainAgentId), this.now());
    const { blockers, rule } = await check(w);
    const reason = `${args.reason}${args.requested === "developer" && caller !== from ? " (the developer asked)" : ""}`;
    const planId = blockers.length ? null : this.plan(caller, "make_main_agent", async () => {
      const fresh = find(await this.d.store.snapshot());
      if (!fresh || fresh.id !== w.id || fresh.mainAgentId !== from) throw new Error("The main agent changed since the dry run. Run make_main_agent again.");
      const again = await check(fresh);
      if (again.blockers.length) throw new Error(again.blockers.join(" "));
      await this.d.store.mutate(state => { const current = findWorkspace(state, w.id); if (current.mainAgentId !== from) throw new Error("The main agent changed since the dry run."); setMainAgent(current, target, "claim", this.now(), { by: `agent:${caller}`, reason }); });
      await this.note(caller, from, "make_main_agent");
      return { workspaceId: w.id, mainAgentId: target, previous: from, reason, undo: "The developer can undo it from the workspace panel; the previous main can't take it back on its own for 2 hours." };
    }, 2 * 60_000);
    return { dryRun: true, planId, workspaceId: w.id, workspace: w.title, from, to: target, requested, rule, blockers, lastChange: lastMainChange(w) ?? null,
      next: planId ? `Call make_main_agent with confirm=true and planId=${planId} within 2 minutes. The developer sees "Main agent changed" with Undo.` : "Blocked. Ask the developer, who can use Make main agent in the workspace panel." };
  }

  /** Settings → Display: the host-scoped preferences the Display screen writes, trust bypass among them. */
  private async displayTool(caller: string, tool: "display_settings" | "set_display", args: Record<string, any>) {
    if (!this.d.display) throw new Error(`${tool} isn't available in this Follow-up.`);
    const current = await this.d.display.read();
    if (tool === "display_settings") return { values: { home_sort: DEFAULT_SORT, ...current.values }, sorts: SORT_MODES, change: "set_display changes these, only when the developer asked. home_sort orders Home and the sidebar view." };
    const values = args.values as Record<string, boolean | string> | undefined;
    if (!values || !Object.keys(values).length) throw new Error("set_display: give values, e.g. { enable_trust_bypass: false } or { home_sort: \"recent\" }. display_settings lists them.");
    const unknown = Object.keys(values).filter(k => !DISPLAY_KEYS.includes(k));
    if (unknown.length) throw new Error(`set_display: unknown setting ${unknown.join(", ")}. display_settings lists them.`);
    const parsed = displayPreferences.schema.safeParse({ ...current.values, ...values });
    if (!parsed.success) throw new Error(`set_display: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const was = (k: string) => current.values[k] ?? (k === "home_sort" ? DEFAULT_SORT : undefined);
    const changes = Object.entries(values).filter(([k, v]) => was(k) !== v).map(([key, to]) => ({ key, from: was(key), to }));
    const planId = changes.length ? this.plan(caller, "set_display", async () => {
      const now = await this.d.display!.read();
      await this.d.display!.write(now.revision, { ...now.values, ...values });
      await this.note(caller, caller, "set_display");
      return { changed: changes.map(c => c.key), values: { ...now.values, ...values } };
    }) : null;
    return { dryRun: true, planId, changes, next: planId ? `Only when the developer asked for this: call set_display with confirm=true and planId=${planId}.` : "Nothing changes." };
  }

  /** The cached Summary sentence and extracted links, or a fresh sentence when none is cached or refresh is set (waits for it). */
  private async workspaceAbout(args: { workspaceId: string; refresh?: boolean }) {
    if (!this.d.about) throw new Error("workspace_about isn't available in this Follow-up.");
    const state = await this.d.store.snapshot();
    const w = this.tracked(state).find(w => w.id === args.workspaceId || w.title === args.workspaceId);
    if (!w) throw new Error(`No tracked workspace matches ${args.workspaceId}.`);
    // refresh: the panel's Rewrite. Writes a new sentence (one small model call) even when one is cached.
    const view = await this.d.about.view(w.id, { open: true, wait: true, refresh: !!args.refresh });
    const r = view.record;
    return { workspaceId: w.id, title: w.title, status: view.status, summary: r?.gist ?? null, gist: r?.gist ?? null, generatedAt: r?.generatedAt ?? null,
      links: (r?.links ?? view.links).map(l => ({ kind: l.kind, key: l.key, url: l.url, title: l.title, state: l.state, priority: l.priority, due: l.due, who: l.who })),
      failedSources: r?.failed ?? [], error: view.error };
  }

  private async listPrs(args: { workspace?: string; needs_reviewers?: boolean; ready_to_merge?: boolean; include_closed?: boolean }) {
    const state = await this.d.store.snapshot();
    const workspaces = this.tracked(state).filter(w => !args.workspace || w.id === args.workspace || w.title === args.workspace);
    if (args.workspace && !workspaces.length) throw new Error(`No tracked workspace matches ${args.workspace}.`);
    const prs = workspaces.flatMap(w => w.prs.map(p => prRow(w, p)))
      .filter(r => args.include_closed || !["MERGED", "CLOSED"].includes(r.state))
      .filter(r => !args.needs_reviewers || r.needsReviewers)
      .filter(r => !args.ready_to_merge || r.mergeable);
    return { prs, workspaces: workspaces.map(w => ({ id: w.id, title: w.title, mainAgentId: w.mainAgentId, enable_auto_sends: w.enable_auto_sends, hold: w.hold, pendingBatches: w.batches.filter(b => b.state === "pending" && !recoveryBatch(b)).map(b => ({ id: b.id, tasks: b.tasks.length })), retryableBatches: w.batches.filter(b => ["blocked", "uncertain"].includes(b.state)).map(b => ({ id: b.id, state: b.state, result: b.result })) })) };
  }

  /** Dry run: who would be asked on each PR, and what stops it. The same checks the Add reviewers button makes. */
  private async planReviewers(caller: string, args: { prs?: string[]; reviewers?: string[] }) {
    if (!args.prs?.length) throw new Error("add_reviewers: give prs (owner/repo#number keys from list_prs).");
    const state = await this.d.store.snapshot();
    const rows = args.prs.map(key => {
      try {
        const { w, p } = this.findPr(state, key);
        const s = p.snapshot;
        const chosen = args.reviewers ?? this.reviewersFor(p.repo).map(r => r.login);
        const reviewers = withoutAuthor(chosen.map(l => ({ login: l, name: null })), s?.reviewers?.author).map(r => r.login);
        const blockers: string[] = [];
        if (p.error || !s?.complete || !s.reviewers?.complete) blockers.push("Reviewer status is unavailable. Refresh first.");
        else if (s.state !== "OPEN" || s.draft) blockers.push("Not an open PR that is ready for review.");
        else if (!noReviewers(p)) blockers.push("Reviewers already assigned.");
        if (!chosen.length) blockers.push(`No reviewers set for ${p.repo}. Pass reviewers, or ask the developer to set them in Settings → Reviewers.`);
        else if (!reviewers.length) blockers.push("Only the PR author was given.");
        return { pr: p.key, workspaceId: w.id, title: s?.title ?? null, reviewers, source: args.reviewers ? "given" : "defaults", blockers };
      } catch (error) { return { pr: key, workspaceId: null, title: null, reviewers: [] as string[], source: args.reviewers ? "given" : "defaults", blockers: [error instanceof Error ? error.message : String(error)] }; }
    });
    const ready = rows.filter(r => !r.blockers.length);
    const planId = ready.length ? this.plan(caller, "add_reviewers", async () => {
      const results = [];
      for (const r of ready) {
        try {
          const result = await this.d.prActions.requestReviewers(r.workspaceId!, r.pr, args.reviewers ? r.reviewers : undefined);
          await this.note(caller, findWorkspace(await this.d.store.snapshot(), r.workspaceId!).mainAgentId, "add_reviewers");
          results.push({ pr: r.pr, ...result });
        } catch (error) { results.push({ pr: r.pr, state: "failed" as const, result: error instanceof Error ? error.message : String(error) }); }
      }
      return { results };
    }) : null;
    return { dryRun: true, planId, rows, next: planId ? `Show the developer this plan if they haven't approved it; then call add_reviewers with confirm=true and planId=${planId}. Blocked rows are skipped.` : "Nothing to request." };
  }

  /** Merge and merge-when-ready: Follow-up's own action plan (plan, then confirm), with its blockers. */
  private async planPr(caller: string, tool: AgentTool, kind: "merge" | "enable_mwr" | "disable_mwr", args: { pr?: string; scope?: "target" | "downstack" }) {
    if (!args.pr) throw new Error(`${tool}: give pr (an owner/repo#number key from list_prs).`);
    const { w, p } = this.findPr(await this.d.store.snapshot(), args.pr);
    const plan = await this.d.prActions.prepare(w.id, p.key, kind);
    const scope = args.scope ?? (plan.prs.length > 1 ? "downstack" : "target");
    const blocked = plan.blockers.length > 0 || (kind === "merge" ? (scope === "target" ? plan.prs.slice(-1) : plan.prs) : plan.prs.slice(-1)).some(p => p.blockers.length > 0);
    const planId = blocked ? null : this.plan(caller, tool, async () => {
      const result = await this.d.prActions.confirm(plan.id, scope);
      await this.note(caller, w.mainAgentId, tool);
      return { pr: plan.target, scope, ...result };
    }, Math.max(1_000, Date.parse(plan.expiresAt) - this.now()));
    return { dryRun: true, planId, kind, target: plan.target, scope, expiresAt: plan.expiresAt, blockers: plan.blockers, prs: plan.prs.map(p => ({ key: p.key, title: p.title, blockers: p.blockers })),
      next: planId ? `Run only if the developer asked for it: call ${tool} with confirm=true and planId=${planId} within a minute.` : "Blocked. Resolve the blockers first." };
  }

  private async sendRepairs(caller: string, args: { workspace: string; batchId?: string }) {
    const w = findWorkspace(await this.d.store.snapshot(), args.workspace);
    const batchId = args.batchId ?? w.batches.find(b => b.state === "pending" && !recoveryBatch(b))?.id;
    if (!batchId) throw new Error("No repairs are waiting to send in this workspace.");
    const after = await this.d.engine.sendPending(w.id, batchId);
    await this.note(caller, w.mainAgentId, "send_repairs");
    const b = after.batches.find(b => b.id === batchId);
    return { workspaceId: w.id, batch: b ? { id: b.id, state: b.state, tasks: b.tasks.length, result: b.result } : null };
  }

  private async control(caller: string, tool: AgentTool, input: Parameters<typeof controlWorkspace>[1]) {
    const w = await this.d.store.mutate(state => controlWorkspace(state, input, this.now(), this.d.timeZone?.()));
    await this.note(caller, w.mainAgentId, tool);
    return { workspaceId: w.id, enable_auto_sends: w.enable_auto_sends, hold: w.hold, snooze: w.snooze ?? null, batches: w.batches.filter(b => !["completed", "cancelled"].includes(b.state)).map(b => ({ id: b.id, state: b.state })) };
  }

  /** Later and Bring back now on a workspace-only Needs-you row, planned like snooze. Same mutator as the row menu. */
  /**
   * Rename with AI (server/rename.ts): the dry run asks for a suggestion (or takes `title`, or plans Undo) and shows the
   * name now and the name after; confirm runs the dialog's Rename with that exact name.
   */
  private async planRename(caller: string, args: { workspaceId?: string; title?: string; undo?: boolean }) {
    if (!this.d.rpc) throw new Error("ai_rename isn't available in this Follow-up.");
    if (!args.workspaceId) throw new Error("ai_rename: give workspaceId (a Paseo workspace id, or one from list_prs).");
    const workspaceId = args.workspaceId;
    const actor = agentActor(caller, await this.d.agentTitle?.(caller).catch(() => null));
    const status = await this.d.rpc.call("follow.rename-status", { workspaceId, suggest: !args.title && !args.undo }) as RenameStatus;
    if (args.undo && !status.last) throw new Error("Nothing to undo: no rename of this workspace in the last 24 hours.");
    const to = args.undo ? status.last!.from : args.title ?? status.suggestion!;
    const input = args.undo ? { workspaceId, undo: true } : { workspaceId, title: to };
    const planId = this.plan(caller, "ai_rename", async () => { const out = await this.d.rpc!.call("follow.rename-workspace", input, actor); await this.note(caller, caller, "ai_rename"); return out; });
    return { dryRun: true, planId, workspaceId, from: status.current, to, ...(status.last && !args.undo ? { undoable: status.last } : {}),
      next: `Only when the developer asked for this: call ai_rename with confirm=true and planId=${planId} within 5 minutes. It can be undone for 24 h with undo=true.` };
  }

  private async planWorkspaceSnooze(caller: string, args: { workspace?: string; until?: string; bring_back?: boolean }) {
    if (!args.workspace) throw new Error("snooze_workspace: give workspace (an id from list_prs).");
    if (!args.bring_back && !args.until) throw new Error("snooze_workspace: give until (next-event, 1h, tonight, tomorrow or an ISO time), or bring_back=true.");
    const snooze = args.bring_back ? null : { until: args.until! };
    // The dry run runs the mutator on a copy, so a bad until or a workspace with nothing to put off fails here.
    const preview = controlWorkspace(structuredClone(await this.d.store.snapshot()), { workspaceId: args.workspace, snooze }, this.now(), this.d.timeZone?.());
    const planId = this.plan(caller, "snooze_workspace", () => this.control(caller, "snooze_workspace", { workspaceId: args.workspace!, snooze }));
    return { dryRun: true, planId, workspaceId: preview.id, snooze: preview.snooze ?? null, next: `Only on the developer's request: call snooze_workspace with confirm=true and planId=${planId}.` };
  }

  private async inboxList(caller: string, args: { flagged_only?: boolean }) {
    const { enabled, rows } = await this.d.inbox.list();
    const now = this.now();
    const tracked = new Map((await this.d.store.snapshot()).workspaces.map(w => [w.id, w]));
    const held = !!this.d.autoSendsHeld?.();
    return { enabled, you: caller, rows: rows.filter(r => !args.flagged_only || r.needs && !r.snooze).map(r => {
      const head = flagHeadline(r, now);
      // Home's Sending row rides its workspace's main agent: queued or sent, when and why, and whether send_repairs would go through.
      const w = r.workspaceId ? tracked.get(r.workspaceId) : undefined;
      const sending = w && w.mainAgentId === r.agentId ? sendingOf(w, now, { held }) : null;
      return { agentId: r.agentId, title: r.title, workspace: r.workspaceTitle, workspaceId: r.workspaceId, status: r.status, flagged: !!head, headline: head?.label ?? null, ask: head?.line ?? null, sending,
        snoozedUntil: r.snooze ? (r.snooze as { until?: string }).until ?? "next-event" : null, enable_finish_flags: r.enable_finish_flags, self: r.agentId === caller };
    }) };
  }

  /** Sign off, snooze and finish flags, for other agents only. Seqs pin the flag that was shown, like the UI. */
  private async planInbox(caller: string, tool: "sign_off" | "snooze" | "set_finish_flags", args: { agentIds?: string[]; until?: string; value?: boolean }) {
    if (!args.agentIds?.length) throw new Error(`${tool}: give agentIds (from inbox_list).`);
    if (args.agentIds.includes(caller)) throw new Error(tool === "sign_off" ? "An agent can't sign itself off. Only the developer clears your flag." : `${tool} is for other agents' rows, not your own.`);
    if (tool === "snooze" && !args.until) throw new Error("snooze: give until (\"next-event\", \"1h\", \"tomorrow\" or an ISO time).");
    const until = tool === "snooze" ? resolveUntil(args.until!, new Date(this.now()), this.d.timeZone?.()) : null;
    if (tool === "snooze" && !until) throw new Error(`snooze: until "${args.until}" isn't one of next-event, 1h, tonight, tomorrow, pr:<repo#n> or an ISO time.`);
    const { rows } = await this.d.inbox.list();
    const plan = args.agentIds.map(agentId => {
      const r = rows.find(r => r.agentId === agentId);
      const blockers = !r ? ["Not in the inbox."] : tool === "sign_off" && !r.needs ? ["Nothing to sign off."] : tool === "snooze" && !r.needs ? ["Not flagged."] : [];
      return { agentId, title: r?.title ?? null, workspace: r?.workspaceTitle ?? null, headline: r ? flagHeadline(r, this.now())?.label ?? null : null, seq: (r as { seq?: number } | undefined)?.seq, blockers };
    });
    const ready = plan.filter(p => !p.blockers.length);
    const planId = ready.length ? this.plan(caller, tool, async () => {
      const ids = ready.map(p => p.agentId);
      const input: InboxAction = tool === "sign_off" ? { action: "sign_off", agentIds: ids, seqs: Object.fromEntries(ready.filter(p => p.seq !== undefined).map(p => [p.agentId, p.seq!])) }
        : tool === "snooze" ? { action: "snooze", agentIds: ids, until: until! } : { action: "set_finish_flags", agentIds: ids, value: args.value ?? true };
      const { results } = await this.d.inbox.act(input);
      for (const r of results) if (r.ok) await this.note(caller, r.agentId, tool);
      return { results };
    }) : null;
    return { dryRun: true, planId, rows: plan.map(({ seq: _seq, ...p }) => p), next: planId ? `Only on the developer's request: call ${tool} with confirm=true and planId=${planId}.` : "Nothing to do." };
  }

  /**
   * Externally supplied priorities for Home's Priority sort. The dry run resolves each workspace (id or exact title)
   * and shows what Home will display; confirm stores them. replace=true drops workspaces the batch leaves out.
   */
  private async planPriorities(caller: string, args: { priorities?: z.infer<typeof priorityInputSchema>[]; replace?: boolean }) {
    if (!args.priorities?.length) throw new Error("set_priorities: give priorities [{ workspace, score 0-100, reason (one line), sources [{ kind: linear|slack|planning|github|paseo, label, url? }] }].");
    if (!this.d.priorities) throw new Error("set_priorities is unavailable on this host.");
    const state = await this.d.store.snapshot();
    const live = state.workspaces.filter(w => !w.archived);
    const at = new Date(this.now()).toISOString();
    const rows = args.priorities.map(p => {
      const matches = live.filter(w => w.id === p.workspace || w.title === p.workspace);
      const blockers = !matches.length ? ["No workspace has this id or title."] : matches.length > 1 ? ["Several workspaces have this title; use the id."] : [];
      return { workspace: p.workspace, workspaceId: matches.length === 1 ? matches[0].id : null, title: matches.length === 1 ? matches[0].title : null, score: p.score, reason: p.reason, sources: p.sources, blockers };
    });
    const ready = rows.filter(r => !r.blockers.length);
    const replace = !!args.replace;
    const planId = ready.length ? this.plan(caller, "set_priorities", async () => {
      const stored = await this.d.priorities!.write(ready.map(r => ({ workspaceId: r.workspaceId!, score: r.score, reason: r.reason, sources: r.sources, at, by: `agent:${caller}` })), replace);
      return { stored: ready.length, total: stored.length, rankedAt: at };
    }) : null;
    return { dryRun: true, planId, replace, rows, next: planId ? `Call set_priorities with confirm=true and planId=${planId} to store them. Home's Priority sort uses them for 6 hours.` : "Nothing to store." };
  }
}
