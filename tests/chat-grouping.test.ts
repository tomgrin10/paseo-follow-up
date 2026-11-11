import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_PRESENTATION, MOMENT_TOOLS, followTimelineItem, createMomentLedger, type TimelineToolCall } from "../shared/chat";
import { WAIT_TOOLS } from "../server/wait";

/*
 * Paseo 0.15.2 groups a run only from items whose kind is "tool_call" or "thought"; any "plugin" item seals the run and
 * renders loose (prepareGroupedHistory / collapseTurns in the app bundle). A timeline transform can only return plugin
 * items, so returning anything for a tool call takes it out of Paseo's group. The invariant: a transform returns
 * nothing (undefined) for routine bookkeeping, and only moments on an explicit allowlist become rows or cards.
 */
// The hook reads stdin unless told it is being imported.
process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { TOOL_NAMES: string[] };
const ALL_TOOLS = [...new Set([...hook.TOOL_NAMES, ...WAIT_TOOLS])];

/** Every spelling an agent's chat records for one of Follow-up's tools. */
function spellings(tool: string): TimelineToolCall[] {
  const done = (name: string, detail: TimelineToolCall["detail"]): TimelineToolCall => ({ type: "tool_call", callId: `${name}-1`, name, status: "completed", error: null, detail });
  const mcp = { type: "unknown", input: { summary: "x", title: "t" }, output: { content: [{ type: "text", text: JSON.stringify({ workspace: { id: "w1", completion: { summary: "Shipped" } }, blockers: [], question: { id: "Q1", title: "t" } }) }] } };
  return [
    done(`mcp__paseo__follow_${tool}`, mcp), done(`paseo.follow_${tool}`, mcp),
    done(`mcp__follow-up__${tool}`, mcp), done(`follow-up.${tool}`, mcp),
    done(`mcp__paseo__${tool}`, mcp),
    done("Bash", { type: "shell", command: `node ~/.paseo/plugin-data/follow-up/mcp.mjs call ${tool} '{"summary":"x"}'`, output: "{}" }),
  ];
}

test("every Follow-up and Wait tool is classified as routine or a moment", () => {
  const unclassified = ALL_TOOLS.filter(t => !(t in TOOL_PRESENTATION));
  assert.deepEqual(unclassified, [], "classify each new tool in TOOL_PRESENTATION (shared/chat.ts); see AGENTS.md");
  assert.deepEqual(Object.keys(TOOL_PRESENTATION).filter(t => !ALL_TOOLS.includes(t)), [], "no stale classifications");
  assert.deepEqual([...MOMENT_TOOLS].sort(), ["ask_question", "declare_done"]);
});

test("routine bookkeeping stays a tool call in every spelling, so Paseo keeps it in its group", () => {
  for (const tool of ALL_TOOLS.filter(t => TOOL_PRESENTATION[t] === "routine"))
    for (const call of spellings(tool)) for (const status of ["running", "completed", "failed", "canceled"] as const)
      assert.equal(followTimelineItem({ ...call, status, error: status === "failed" ? "boom" : null }, createMomentLedger()), undefined, `${call.name} ${status} must stay groupable`);
});

test("only a finished moment leaves the group: the Done card and a question asked", () => {
  for (const tool of MOMENT_TOOLS) {
    const [native, , , , , bridge] = spellings(tool);
    assert.ok(followTimelineItem(native, createMomentLedger()), `${tool} completed is a moment`);
    assert.equal(followTimelineItem({ ...native, status: "running", error: null }, createMomentLedger()), undefined, "a running call stays in the group until it lands");
    assert.equal(followTimelineItem({ ...native, status: "failed", error: "nope" }, createMomentLedger()), undefined, "a failed call is bookkeeping");
    assert.ok(followTimelineItem(bridge, createMomentLedger()) !== undefined || tool === "declare_done", "the CLI bridge form of ask_question is a moment too");
  }
  const blocked: TimelineToolCall = { type: "tool_call", callId: "d", name: "mcp__paseo__follow_declare_done", status: "completed", error: null, detail: { type: "unknown", input: { summary: "x" }, output: JSON.stringify({ workspace: { id: "w1", completion: null }, blockers: ["Verify rollout"] }) } };
  assert.equal(followTimelineItem(blocked, createMomentLedger()), undefined, "Not done yet is the agent's own check, not the developer's moment");
  const isError: TimelineToolCall = { ...blocked, detail: { type: "unknown", input: {}, output: { isError: true, content: [{ type: "text", text: "Tracking is inactive" }] } } };
  assert.equal(followTimelineItem(isError, createMomentLedger()), undefined);
});

test("a repeated declare_done for the same workspace and summary renders one card", () => {
  const ledger = createMomentLedger();
  const done = (callId: string, workspace: string, summary: string): TimelineToolCall => ({ type: "tool_call", callId, name: "mcp__paseo__follow_declare_done", status: "completed", error: null, detail: { type: "unknown", input: { summary }, output: JSON.stringify({ workspace: { id: workspace, completion: { summary } }, blockers: [] }) } });
  const first = followTimelineItem(done("c1", "w1", "Shipped"), ledger);
  assert.ok(first?.done);
  assert.deepEqual(followTimelineItem(done("c1", "w1", "Shipped"), ledger), first, "re-projecting the same call keeps its card");
  assert.equal(followTimelineItem(done("c2", "w1", "Shipped"), ledger), undefined, "the repeat stays a grouped tool call");
  assert.ok(followTimelineItem(done("c3", "w2", "Shipped"), ledger)?.done, "another workspace's card is its own moment");
  assert.ok(followTimelineItem(done("c4", "w1", "Shipped the follow-up too"), ledger)?.done, "a new summary is a new moment");
});
