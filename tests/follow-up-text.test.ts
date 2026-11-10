import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOOK_TEXT_PREFIXES, messageSender } from "../shared/message-sender";
import { tailSteps } from "../shared/home";
import { parseLine, transcriptSteps } from "../server/transcript";
import { tailLines } from "../server/about";
import { finishedReply } from "../server/inbox-classifier";
import { followUpTextViolations } from "../shared/status-invariants";

/**
 * Invariant `no-follow-up-text-as-work`: Follow-up's Stop hook continues a turn with "Silently complete this
 * workspace's sidebar bookkeeping…", and the agent answers it ("The sidebar sync is done"). Neither is the agent's
 * work: no Summary input, Finished reason or Recent step may carry them. The fixtures hold the exact hook text, read
 * from server/agent-hook.mjs, in the forms the providers record it (Claude Code: an isMeta "Stop hook feedback:" line;
 * Codex: a `<hook_prompt>` user message).
 */

const hookSource = readFileSync(new URL("../server/agent-hook.mjs", import.meta.url), "utf8");
const constant = (name: string) => JSON.parse(new RegExp(`const ${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(hookSource)![1]) as string;
const STOP_REASON = constant("stopReason");
const QUIET = constant("quietInstruction");
const HOOK_TEXT = `${STOP_REASON} This is metadata bookkeeping only; do not start queued repairs or recovery.\n\nMaintain this tracked workspace's Follow-through sidebar as part of your normal work; do not wait for a developer reminder.\n\n${QUIET}`;
const WORK = "Fixed the export: rows over 10k now stream in pages and the last page is kept.";
const BOOKKEEPING = "The sidebar sync is done. The background check finished earlier and reported FINISHED.";

const claude = (type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
const CLAUDE = [
  claude("user", "Fix the CSV export"),
  claude("assistant", [{ type: "text", text: WORK }]),
  claude("user", `Stop hook feedback:\n${HOOK_TEXT}`, { isMeta: true }),
  claude("assistant", [{ type: "tool_use", name: "mcp__paseo__follow_sync_workspace", input: {} }]),
  claude("assistant", [{ type: "text", text: BOOKKEEPING }]),
];
const codex = (role: "user" | "assistant", text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const CODEX_HOOK = `<hook_prompt hook_run_id="stop:9:/fixture/.codex/hooks.json">${HOOK_TEXT}</hook_prompt>`;
const CODEX = [
  codex("user", "Fix the CSV export"),
  codex("assistant", WORK),
  codex("user", CODEX_HOOK),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "follow_sync_workspace" } }),
  codex("assistant", BOOKKEEPING),
];
/** Paseo's live timeline for a Codex agent: the hook prompt is a user message. */
const LIVE = [{ type: "user_message", text: "Fix the CSV export" }, { type: "assistant_message", text: WORK }, { type: "user_message", text: CODEX_HOOK }, { type: "tool_call", name: "follow_sync_workspace" }, { type: "assistant_message", text: BOOKKEEPING }];
const clean = (texts: (string | null | undefined)[], where: string) => {
  assert.deepEqual(followUpTextViolations(texts), [], `${where} carries Follow-up's hook text`);
  assert.ok(!texts.some(t => t?.includes(BOOKKEEPING)), `${where} carries the bookkeeping reply as work`);
};

test("the hook prefixes the classifier knows are still the hook's words", () => {
  for (const p of HOOK_TEXT_PREFIXES) assert.ok(hookSource.includes(p.trimEnd()), `agent-hook.mjs no longer says "${p}"`);
  assert.deepEqual(messageSender(`Stop hook feedback:\n${HOOK_TEXT}`), { kind: "follow-up", what: "hook", text: HOOK_TEXT });
  assert.deepEqual(messageSender(CODEX_HOOK), { kind: "follow-up", what: "hook", text: HOOK_TEXT });
  assert.equal(messageSender('<hook_prompt hook_run_id="stop:1">Another plugin wants a word</hook_prompt>').kind, "system");
});

test("Recent steps: no hook feedback and no bookkeeping reply, from transcripts or the live timeline", () => {
  for (const [where, steps] of [["Claude transcript", transcriptSteps(CLAUDE)], ["Codex transcript", transcriptSteps(CODEX)], ["live timeline", tailSteps(LIVE as never)]] as const) {
    clean(steps.map(s => s.text), where);
    assert.equal(steps.filter(s => s.kind === "agent").at(-1)?.text, WORK, `${where}: the last agent step is the work`);
  }
});

test("Summary inputs: no hook feedback and no bookkeeping reply", () => {
  for (const [where, items] of [["Claude transcript", CLAUDE.flatMap(parseLine)], ["Codex transcript", CODEX.flatMap(parseLine)], ["live timeline", LIVE]] as const) {
    const tail = tailLines(items);
    clean([...tail.lines, ...tail.users], `Summary (${where})`);
    assert.ok(tail.lines.some(l => l.includes(WORK)), `Summary (${where}) keeps the work`);
  }
});

test("Finished reason: the reply the hook interrupted, never the bookkeeping reply", () => {
  assert.equal(finishedReply(LIVE, null, null), WORK, "Codex: the hook prompt is in the timeline");
  // Claude Code: Paseo's timeline hides the isMeta hook line, so the hook saved the reply it interrupted.
  const claudeLive = [LIVE[0], LIVE[1], LIVE[3], LIVE[4]];
  assert.equal(finishedReply(claudeLive, { at: 2_000, reply: WORK }, 1_000), WORK);
  assert.equal(finishedReply(claudeLive, { at: 500, reply: "an older turn's reply" }, 1_000), BOOKKEEPING, "a save from an earlier turn is ignored");
  clean([finishedReply(LIVE, null, null)], "Finished reason");
});
