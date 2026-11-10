import { z } from "zod";

/** Follow-up's own messages and tool calls, recognised in agent chats so they render as compact rows. */
export const FOLLOW_TOOLS = ["workspace_status", "sync_workspace", "enroll_workspace", "register_pr", "exclude_stack", "update_obligation", "acknowledge_batch", "declare_done", "ask_question", "record_answer", "withdraw_question", "set_spec"] as const;
export type FollowTool = (typeof FOLLOW_TOOLS)[number];

/**
 * Claude records mcp__follow-through__register_pr; Codex records follow-through.register_pr. Since 1.4.0-beta.2 the
 * tools are served through Paseo's own MCP as follow_register_pr: mcp__paseo__follow_register_pr / paseo.follow_register_pr.
 */
export function followToolName(name: string): FollowTool | null {
  const match = /^(?:mcp__)?follow-through(?:__|\.|\/|:)([a-z_]+)$/.exec(name) ?? /^(?:mcp__)?paseo(?:__|\.|\/|:)follow_([a-z_]+)$/.exec(name);
  return match && (FOLLOW_TOOLS as readonly string[]).includes(match[1]) ? match[1] as FollowTool : null;
}

/** The CLI fallback agents run when MCP is unavailable: node …/follow-through/mcp.mjs call <tool> '<json>'. */
export function followShellCall(command: string): { tool: FollowTool; input: Record<string, unknown> } | null {
  const match = /plugin-data\/follow-through\/mcp\.mjs['"]?\s+call\s+([a-z_]+)(?:\s+'((?:[^']|'"'"')*)')?/.exec(command);
  if (!match || !(FOLLOW_TOOLS as readonly string[]).includes(match[1])) return null;
  let input: Record<string, unknown> = {};
  try { const parsed = JSON.parse((match[2] ?? "{}").replace(/'"'"'/g, "'")); if (record(parsed)) input = parsed; } catch {}
  return { tool: match[1] as FollowTool, input };
}

export const batchCardSchema = z.object({ kind: z.enum(["batch", "recovery"]), tasks: z.array(z.string()), text: z.string() });
export type BatchCard = z.infer<typeof batchCardSchema>;

/** A repair batch or recovery brief that Follow-up sent as a user message. */
export function parseBatchPrompt(text: string): BatchCard | null {
  const batch = /^(?:Workspace follow-through batch|Follow-through batch) \S+\n\n([\s\S]+)$/.exec(text.trim());
  if (batch) {
    const tasks = batch[1].split("\n").map(line => /^\d+\.\s+(.+)$/.exec(line.trim())?.[1]).filter((t): t is string => !!t);
    return tasks.length ? { kind: "batch", tasks, text } : null;
  }
  if (/^Follow-through recovery \S+/.test(text.trim())) return { kind: "recovery", tasks: [], text };
  return null;
}

export const toolRowSchema = z.object({
  tool: z.enum(FOLLOW_TOOLS),
  state: z.enum(["running", "done", "failed", "canceled"]),
  line: z.string(),
  tone: z.enum(["muted", "warning", "danger", "success"]),
  more: z.string().nullable(),
  done: z.object({ summary: z.string(), /** PRs whose deploy Follow-up could not confirm. */ unconfirmed: z.array(z.string()).optional() }).nullable(),
});
export type ToolRow = z.infer<typeof toolRowSchema>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Text from Claude's { output } / { content: [{ text }] } shapes or Codex's MCP result. */
export function readText(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(part => typeof part === "string" ? part : record(part) && typeof part.text === "string" ? part.text : undefined);
    return parts.every(p => p !== undefined) ? parts.join("\n") : undefined;
  }
  if (!record(value)) return undefined;
  const key = ["output", "content", "text", "message", "result"].find(name => name in value);
  return key ? readText(value[key]) : undefined;
}
function json(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const parse = (body: string) => { try { const value = JSON.parse(body); return record(value) ? value : null; } catch { return null; } };
  // Some providers wrap the reply in extra text; the receipt is the outermost JSON object.
  return parse(text) ?? (text.indexOf("{") >= 0 ? parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) : null);
}
const str = (value: unknown) => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const firstLine = (text: string) => text.split("\n").map(l => l.trim()).find(Boolean) ?? "";
const specHost = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
const prKey = (key: string) => key.includes("#") ? `#${key.split("#")[1]}` : key;

const RUNNING: Record<FollowTool, string> = {
  workspace_status: "Reading Follow-up status…", sync_workspace: "Syncing Follow-up…", enroll_workspace: "Updating the goal…",
  register_pr: "Registering a PR…", exclude_stack: "Excluding a stack…", update_obligation: "Updating a task…",
  acknowledge_batch: "Reporting repair results…", declare_done: "Checking whether the work is done…",
  ask_question: "Asking you a question…", record_answer: "Recording your answer…", withdraw_question: "Withdrawing a question…", set_spec: "Saving the spec link…",
};
const NAMES: Record<FollowTool, string> = {
  workspace_status: "Follow-up status", sync_workspace: "Follow-up sync", enroll_workspace: "Goal update", register_pr: "PR registration",
  exclude_stack: "Stack exclusion", update_obligation: "Task update", acknowledge_batch: "Repair report", declare_done: "Done check",
  ask_question: "Question", record_answer: "Answer record", withdraw_question: "Question withdrawal", set_spec: "Spec link",
};

/** One line for a finished Follow-up tool call, plus the text it opens to. */
export function toolRow(tool: FollowTool, status: "running" | "completed" | "failed" | "canceled", input: Record<string, unknown>, output: string | undefined, error?: string): ToolRow {
  const base = { tool, done: null, more: null, tone: "muted" as const };
  if (status === "running") return { ...base, state: "running", line: RUNNING[tool] };
  if (status === "canceled") return { ...base, state: "canceled", line: `${NAMES[tool]} canceled` };
  if (status === "failed") return { ...base, state: "failed", tone: "danger", line: firstLine(error ?? "") || `${NAMES[tool]} failed`, more: error?.trim() || null };
  const result = json(output);
  const more = output?.trim() || null;
  switch (tool) {
    case "workspace_status": return { ...base, state: "done", line: "Read Follow-up status", more };
    case "sync_workspace": return { ...base, state: "done", line: str(input.summary) ? `Synced Follow-up · ${firstLine(str(input.summary))}` : "Synced Follow-up", more: str(input.summary) || more };
    case "enroll_workspace": return { ...base, state: "done", line: `Goal: ${firstLine(str(input.goal) || str(result?.goal))}`, more };
    case "register_pr": {
      const repo = str(input.repo), number = str(input.number), parent = input.parentNumber ? ` on #${str(input.parentNumber)}` : "";
      return { ...base, state: "done", line: `Registered ${repo ? `${repo.split("/")[1]} ` : ""}#${number}${input.stack ? ` in ${str(input.stack)}` : ""}${parent}`, more };
    }
    case "exclude_stack": return { ...base, state: "done", tone: "warning", line: `Excluded stack ${str(input.stack)}`, more: str(input.reason) || more };
    case "update_obligation": {
      const status = str(input.status);
      const verb = status === "done" ? "Task done" : status === "waived" ? "Task waived" : status === "blocked" ? "Task needs a decision" : input.id ? "Task updated" : "Task added";
      const after = Array.isArray(input.afterPrs) && input.afterPrs.length ? ` · after ${input.afterPrs.map(k => prKey(str(k))).join(", ")}` : "";
      return { ...base, state: "done", tone: status === "blocked" ? "warning" : "muted", line: `${verb}: ${firstLine(str(input.title))}${after}`, more: str(input.evidence) || more };
    }
    case "acknowledge_batch": {
      const blocked = input.outcome === "blocked";
      return { ...base, state: "done", tone: blocked ? "warning" : "muted", line: `${blocked ? "Repairs blocked" : "Repairs finished"} · ${firstLine(str(input.result))}`, more: str(input.result) || more };
    }
    case "ask_question": {
      const question = record(result?.question) ? result!.question as Record<string, unknown> : null;
      const id = str(question?.id);
      return { ...base, state: "done", tone: "warning", line: `${id ? `${id} · ` : ""}${firstLine(str(input.title) || str(question?.title))} · asked`, more: [str(input.question), str(result?.instruction)].filter(Boolean).join("\n\n") || more };
    }
    case "record_answer": return { ...base, state: "done", line: `${str(input.id)} · answer recorded: ${firstLine(str(input.choice))}`, more: str(input.words) || more };
    case "withdraw_question": return { ...base, state: "done", line: `${str(input.id)} · withdrawn: ${firstLine(str(input.reason))}`, more };
    case "set_spec": {
      const kept = result?.applied === false;
      return { ...base, state: "done", line: kept ? "Spec link kept · the developer chose it" : `Spec link: ${firstLine(str(input.title)) || specHost(str(input.url))}`, more: str(result?.message) || more };
    }
    case "declare_done": {
      // Only a reply Follow-up wrote can show Done: never the agent's own summary when the result is missing or unreadable.
      const blockers = Array.isArray(result?.blockers) ? result!.blockers.map(str).filter(Boolean) : [];
      const workspace = record(result?.workspace) ? result!.workspace as Record<string, unknown> : null;
      const completionRecord = record(result?.completion) ? result!.completion : record(workspace?.completion) ? workspace!.completion as Record<string, unknown> : null;
      const next = str(result?.next);
      if (blockers.length) return { ...base, state: "done", tone: "warning", line: `Not done yet · ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`, more: [blockers.map(b => `• ${b}`).join("\n"), next].filter(Boolean).join("\n\n") };
      if (!completionRecord) return { ...base, state: "done", line: "Done check", more };
      if (result?.alreadyDone === true) return { ...base, state: "done", line: "Already done · nothing changed", more: next || more };
      const unconfirmed = Array.isArray(completionRecord.unconfirmed) ? completionRecord.unconfirmed.map(str).filter(Boolean) : [];
      return { ...base, state: "done", tone: "success", line: "Declared done", more, done: { summary: str(completionRecord.summary) || str(input.summary), ...(unconfirmed.length ? { unconfirmed } : {}) } };
    }
  }
}

/**
 * How each of Follow-up's agent tools (and Wait's) shows in a chat. Paseo 0.15.2 groups a run only from tool_call and
 * thought items, and a timeline transform can only return plugin items, so a transformed call always leaves Paseo's
 * group and sits loose. Routine bookkeeping therefore stays an ordinary tool call; only a moment the developer should
 * see on its own becomes a row or card. A new tool must be added here (tests/chat-grouping.test.ts fails otherwise).
 */
export const TOOL_PRESENTATION: Record<string, "routine" | "moment"> = {
  workspace_status: "routine", sync_workspace: "routine", enroll_workspace: "routine", register_pr: "routine", exclude_stack: "routine",
  update_obligation: "routine", acknowledge_batch: "routine", record_answer: "routine", withdraw_question: "routine", set_spec: "routine",
  workspace_about: "routine", agent_settings: "routine", needs_you: "routine", list_prs: "routine", add_reviewers: "routine",
  enable_merge_when_ready: "routine", disable_merge_when_ready: "routine", send_repairs: "routine", set_auto_send: "routine", clear_hold: "routine",
  retry_batch: "routine", inbox_list: "routine", sign_off: "routine", set_finish_flags: "routine", set_priorities: "routine", agent_digest: "routine",
  route_candidates: "routine", send_to_agent: "routine", start_workspace: "routine", display_settings: "routine", set_display: "routine",
  follow_settings: "routine", set_follow_settings: "routine", project_settings: "routine", set_project_tracking: "routine", pr_workflow: "routine",
  set_pr_workflow: "routine", reviewer_settings: "routine", reviewer_suggestions: "routine", save_reviewers: "routine", set_agent_setting: "routine",
  set_wait_for_jobs: "routine", onboarding_status: "routine", onboarding_checks: "routine", set_onboarding: "routine", rank_status: "routine",
  rerank_priorities: "routine", overseer_status: "routine", overseer_start: "routine", overseer_restart: "routine", overseer_ask: "routine",
  inbox_brief: "routine", brief_action: "routine", inbox_act: "routine", answer_question: "routine", run_recovery: "routine",
  set_workspace_spec: "routine", set_task_trigger: "routine", pr_controls: "routine", browser_status: "routine", trust_bypass_status: "routine",
  release_notes: "routine", updates_status: "routine", check_updates: "routine", set_updates: "routine", install_update: "routine", make_main_agent: "routine", wait_prepare_job: "routine", wait_get_job: "routine",
  // The developer's moments: the workspace is done, or the agent asked them something. needs_you runs every turn, so a
  // card there would be noise; the inbox already carries it.
  declare_done: "moment", ask_question: "moment",
  // Wait's live timer: the first wait_for_job on a job is its row (shared/wait-chat.ts); later waits on that job stay
  // grouped and only feed the row.
  wait_for_job: "moment",
};
export const MOMENT_TOOLS = Object.keys(TOOL_PRESENTATION).filter(t => TOOL_PRESENTATION[t] === "moment");

/** The fields of Paseo's tool_call timeline item that the transform reads. */
export type TimelineToolCall = { type: "tool_call"; callId: string; name: string; status: "running" | "completed" | "failed" | "canceled"; error: unknown; detail: unknown };

/** Done cards already shown, by workspace and summary, so a repeated declare_done doesn't draw a second card. */
export type MomentLedger = Map<string, string>;
export const createMomentLedger = (): MomentLedger => new Map();
const LEDGER_LIMIT = 500;

/**
 * The plugin row for a Follow-up tool call, or undefined to leave it as Paseo's own grouped tool call. Pure apart from
 * the ledger, which keeps the first call that drew each Done card.
 */
export function followTimelineItem(item: TimelineToolCall, ledger: MomentLedger): ToolRow | undefined {
  const detail = item.detail;
  let tool = followToolName(item.name);
  let input: Record<string, unknown> = {};
  let output: string | undefined;
  if (tool) {
    if (record(detail) && record(detail.input)) input = detail.input;
    output = record(detail) && "output" in detail ? readText(detail.output) : undefined;
  } else if (record(detail) && detail.type === "shell" && typeof detail.command === "string") {
    const call = followShellCall(detail.command);
    if (!call) return undefined;
    tool = call.tool; input = call.input; output = typeof detail.output === "string" ? detail.output : undefined;
  } else return undefined;
  if (TOOL_PRESENTATION[tool] !== "moment" || item.status !== "completed") return undefined;
  if (record(detail) && record(detail.output) && detail.output.isError === true) return undefined;
  const row = toolRow(tool, "completed", input, output);
  if (tool !== "declare_done") return row;
  if (!row.done) return undefined;
  const result = json(output);
  const workspace = record(result?.workspace) && typeof result!.workspace.id === "string" ? result!.workspace.id : str(result?.workspaceId);
  const key = `${workspace}\0${row.done.summary}`;
  const first = ledger.get(key);
  if (first !== undefined && first !== item.callId) return undefined;
  if (first === undefined) { if (ledger.size >= LEDGER_LIMIT) ledger.delete(ledger.keys().next().value!); ledger.set(key, item.callId); }
  return row;
}

export const answerCardSchema = z.object({ id: z.string(), title: z.string(), choice: z.string(), label: z.string().nullable(), words: z.string().nullable(), text: z.string(),
  /** 1.4.0: a multi-decision answer, one entry per decision with its question; `choice: null` was skipped. */
  answers: z.array(z.object({ id: z.string(), question: z.string(), choice: z.string().nullable(), label: z.string().nullable() })).optional() });
export type AnswerCard = z.infer<typeof answerCardSchema>;
