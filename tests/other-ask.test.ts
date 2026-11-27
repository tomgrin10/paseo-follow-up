import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askedElsewhere, isAskInput } from "../shared/ask-shape";
import { turnEndCheck, type TurnEndInput } from "../server/turn-end";
import { importShipped, shipped as shippedFile } from "./support/shipped";

// Invariant other-ask-tool-counts-as-asked: one decision, one card. A turn whose ask already reached the developer
// through another tool (another plugin's question board, Claude Code's AskUserQuestion) gets no turn-end needs_you
// nudge, so the agent never restates it as a second Follow-up card. 2026-11-27, harness with a question-board plugin:
// 10 turn-end checks over 26 prompts on turns whose only ask went through that plugin's ask tool.

process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { shouldNudge: (input: object) => boolean };
// The hook as shipped (shared/turn-checks.mjs inlined): one rule, carried into the data directory.
const shipped = await importShipped<{ isAskInput: (input: unknown) => boolean }>("agent-hook.mjs");

// A question board's ask (fictional plugin), Claude Code's AskUserQuestion, and look-alikes that aren't asks.
const BOARD_ASK = { title: "Coupons on sale items", question: "Should coupons stack with sale prices?", options: [{ letter: "A", label: "Stack", consequence: "Lower margin" }, { letter: "B", label: "Don't stack", consequence: "Simpler" }], recommend: "B" };
const ASK_USER = { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] };
const GRID: [unknown, boolean, string][] = [
  [BOARD_ASK, true, "a question with lettered options"],
  [ASK_USER, true, "AskUserQuestion's questions[]"],
  [{ question: "How does the router pick a handler?", repoName: "example/app" }, false, "a docs lookup's bare question"],
  [{ question: "Ship it?", options: [] }, false, "no choices"],
  [{ question: "   ", options: ["A"] }, false, "an empty question"],
  [{ questions: [{ question: "A?", options: ["x"] }, { question: "B?" }] }, false, "one question without choices"],
  [{ questions: [] }, false, "no questions"],
  [{ command: "npm test" }, false, "a shell call"],
  [null, false, "no input"], ["Ship it?", false, "a string"], [[BOARD_ASK], false, "an array"],
];

test("an ask is told by its input's shape, the same in the hook and the worker", () => {
  for (const [input, expected, why] of GRID) {
    assert.equal(isAskInput(input), expected, `shared: ${why}`);
    assert.equal(shipped.isAskInput(input), expected, `shipped hook: ${why}`);
  }
});

const call = (name: string, input: unknown, over: object = {}) => ({ type: "tool_call", callId: name, name, status: "completed", error: null, detail: { input, output: { content: [{ type: "text", text: "Asked Q1." }] } }, ...over });

test("the turn's timeline: another tool's finished ask counts; Follow-up's own, failed and look-alike calls don't", () => {
  assert.equal(askedElsewhere([call("mcp__paseo__board_question_ask", BOARD_ASK)]), true);
  assert.equal(askedElsewhere([call("AskUserQuestion", ASK_USER)]), true);
  assert.equal(askedElsewhere([call("mcp__paseo__follow_ask_question", BOARD_ASK)]), false, "Follow-up's own ask is its own card");
  assert.equal(askedElsewhere([call("board.question_ask", BOARD_ASK, { status: "failed" })]), false, "a failed ask reached nobody");
  assert.equal(askedElsewhere([call("board.question_ask", BOARD_ASK, { detail: { input: BOARD_ASK, output: { isError: true } } })]), false);
  assert.equal(askedElsewhere([call("deepwiki.ask_question", { question: "How?", repoName: "example/app" })]), false, "a lookup named like an ask");
  assert.equal(askedElsewhere(null), false);
});

const base = (over: Partial<TurnEndInput> = {}): TurnEndInput => ({
  provider: "pi", entry: { role: "main", workspaceId: "w1" }, items: [], startedAt: 1000, syncedAt: null, needsYouAt: null, nudge: true, receipt: {}, now: 5000, ...over,
});
const prompt = { type: "user_message", text: "Add coupons to checkout." };

test("hookless turn-end check: a turn that asked through another tool gets no needs_you nudge, and nothing else changes", () => {
  assert.match(turnEndCheck(base({ items: [prompt] })).text!, /follow_needs_you/, "control: a developer's turn is nudged");
  assert.equal(turnEndCheck(base({ items: [prompt, call("board.question_ask", BOARD_ASK)] })).text, null, "asked elsewhere: no second card, and an ask changes nothing to sync");
  assert.match(turnEndCheck(base({ items: [prompt, call("board.question_lookup", { question: "Which file?" })] })).text!, /follow_needs_you/, "a lookup isn't an ask");
  // The sync check is unrelated to asking: an edit still needs sync_workspace, without the needs_you nudge.
  const text = turnEndCheck(base({ items: [prompt, { type: "tool_call", name: "edit", callId: "e1" }, call("board.question_ask", BOARD_ASK)] })).text!;
  assert.match(text, /follow_sync_workspace/); assert.doesNotMatch(text, /follow_needs_you/);
});

test("the Stop hook's decision: an ask through another tool this turn counts, one from an earlier turn doesn't", () => {
  const b = { provider: "claude", brief: { enable_inbox: true, enable_brief_nudge: true, pending: [] }, agentId: "a1", contributor: false, recovery: false, subagent: false, stopHookActive: false, called: null };
  assert.equal(hook.shouldNudge({ ...b, turn: { startedAt: 1000, stopped: false } }), true);
  assert.equal(hook.shouldNudge({ ...b, turn: { startedAt: 1000, stopped: false, askedAt: 2000 } }), false);
  assert.equal(hook.shouldNudge({ ...b, turn: { startedAt: 1000, stopped: false, askedAt: 500 } }), true);
});

async function hookHome(t: { after: (f: () => Promise<void>) => void }, workspaces: object[]) {
  const root = await mkdtemp(join(tmpdir(), "other-ask-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  await writeFile(join(directory, "agent-hook.mjs"), shippedFile("agent-hook.mjs"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces }));
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  return (event: object) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: "a1", FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_RECOVERY: "", FOLLOW_UP_TOOLS: "native" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
}

for (const [who, workspaces] of [["an untracked root agent", []], ["a tracked main agent", [{ id: "w1", title: "Acme checkout", mainAgentId: "a1", enable_tracking: true, archived: false }]]] as const) {
  test(`the installed hook, ${who}: a turn that asked through another tool isn't nudged to ask again`, async t => {
    const fire = await hookHome(t, [...workspaces]);
    const reason = async () => { const out = await fire({ hook_event_name: "Stop" }); return out ? JSON.parse(out).reason as string : ""; };
    await fire({ hook_event_name: "UserPromptSubmit", prompt: "Add coupons to checkout." });
    await fire({ hook_event_name: "PostToolUse", tool_name: "mcp__paseo__board_question_ask", tool_input: BOARD_ASK });
    assert.doesNotMatch(await reason(), /needs_you once/, "asked through the board: no needs_you nudge");
    // Control: the next turn calls a lookup with a bare question, which asks nobody.
    await fire({ hook_event_name: "UserPromptSubmit", prompt: "And the totals?" });
    await fire({ hook_event_name: "PostToolUse", tool_name: "mcp__paseo__board_question_lookup", tool_input: { question: "Which file computes totals?" } });
    assert.match(await reason(), /call follow_needs_you once/, "no ask this turn: nudged as before");
  });
}
