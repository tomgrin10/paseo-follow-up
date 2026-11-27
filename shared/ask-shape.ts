/**
 * One decision, one card (other-ask-tool-counts-as-asked). Another plugin's ask-the-developer tool (a question board's
 * `*_question_ask`, Claude Code's AskUserQuestion) already put the turn's question in front of the developer, so
 * Follow-up's turn-end needs_you nudge must not make the agent ask it again as a second card. An ask is told by its
 * input's shape, never by a list of tool names: a question with choices, either `{question, options[]}` or
 * `{questions: [{question, options[]}, …]}`. A bare `question` with no choices is a lookup (a docs or code search
 * tool), not an ask. The rule itself is `isAskInput` in shared/turn-checks.mjs, which the build
 * inlines into the agent hook, so the hook and the turn-end event read one copy.
 */
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a tool call's input asks the developer a question with choices (shared/turn-checks.mjs, the hook's too). */
export { isAskInput } from "./turn-checks.mjs";
import { isAskInput } from "./turn-checks.mjs";

/** Follow-up's own tool, under any spelling (native, bridge, legacy server). Its asks are its own cards already. */
export const FOLLOW_UP_TOOL = /(^|[._/])follow_[a-z_]+$|^wait_|^(?:mcp__)?follow-up(?:__|[.:/])/;

/** Whether this turn's timeline has a finished call to another tool that asked the developer (the turn-end check). */
export function askedElsewhere(items: readonly unknown[] | null): boolean {
  return (items ?? []).some(i => {
    if (!record(i) || i.type !== "tool_call" || typeof i.name !== "string" || FOLLOW_UP_TOOL.test(i.name)) return false;
    if (i.status !== "completed" || !record(i.detail)) return false;
    const output = i.detail.output;
    if (record(output) && output.isError === true) return false;
    return isAskInput(i.detail.input);
  });
}
