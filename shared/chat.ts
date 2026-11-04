import { z } from "zod";

/** Follow-up's own messages and tool calls, recognised in agent chats so they render as compact rows. */
export const FOLLOW_TOOLS = ["workspace_status", "sync_workspace", "enroll_workspace", "register_pr", "exclude_stack", "update_obligation", "acknowledge_batch", "declare_done", "ask_question", "record_answer", "withdraw_question", "set_spec"] as const;
export type FollowTool = (typeof FOLLOW_TOOLS)[number];

/** Claude records mcp__follow-through__register_pr; Codex records follow-through.register_pr. */
export function followToolName(name: string): FollowTool | null {
  const match = /^(?:mcp__)?follow-through(?:__|\.|\/|:)([a-z_]+)$/.exec(name);
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
  done: z.object({ summary: z.string() }).nullable(),
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
  try { const value = JSON.parse(text); return record(value) ? value : null; } catch { return null; }
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
      return { ...base, state: "done", tone: "warning", line: `${id ? `Asked ${id}` : "Asked a question"}: ${firstLine(str(input.title) || str(question?.title))}`, more: [str(input.question), str(result?.instruction)].filter(Boolean).join("\n\n") || more };
    }
    case "record_answer": return { ...base, state: "done", line: `Recorded the ${str(input.id)} answer: ${firstLine(str(input.choice))}`, more: str(input.words) || more };
    case "withdraw_question": return { ...base, state: "done", line: `Withdrew ${str(input.id)} · ${firstLine(str(input.reason))}`, more };
    case "set_spec": {
      const kept = result?.applied === false;
      return { ...base, state: "done", line: kept ? "Spec link kept · the developer chose it" : `Spec link: ${firstLine(str(input.title)) || specHost(str(input.url))}`, more: str(result?.message) || more };
    }
    case "declare_done": {
      const blockers = Array.isArray(result?.blockers) ? result!.blockers.map(str).filter(Boolean) : [];
      const completion = record(result?.completion) ? str(result!.completion.summary) : record(record(result?.workspace) ? (result!.workspace as Record<string, unknown>).completion : null) ? str(((result!.workspace as Record<string, unknown>).completion as Record<string, unknown>).summary) : "";
      if (blockers.length) return { ...base, state: "done", tone: "warning", line: `Not done yet · ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`, more: blockers.map(b => `• ${b}`).join("\n") };
      return { ...base, state: "done", tone: "success", line: "Declared done", more, done: { summary: completion || str(input.summary) } };
    }
  }
}

export const answerCardSchema = z.object({ id: z.string(), title: z.string(), choice: z.string(), label: z.string().nullable(), words: z.string().nullable(), text: z.string() });
export type AnswerCard = z.infer<typeof answerCardSchema>;
