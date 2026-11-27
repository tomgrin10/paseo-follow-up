import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fitTurn, foldTurn, runLabel, runSteps, stepOf, turnSource, TURN_ROWS, TURN_STEPS, type TurnItem, type TurnRow } from "../shared/turn";
import { CLOSE_MS, OPEN_MS, PEEK_CLOSED, peekDeadline, peekStep, timelineOnScreen, type PeekEvent, type PeekState } from "../shared/peek";
import { transcriptTurnItems, toolItem } from "../server/transcript";

// Invariant 137 (a-peek-is-bounded-and-never-wakes) and the peek's timing (shared/peek.ts).

const you = (text: string): TurnItem => ({ type: "user_message", text });
const shell = (command: string, status = "completed"): TurnItem => ({ type: "tool_call", name: "Bash", status, detail: { type: "shell", command } });
const read = (path: string): TurnItem => ({ type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath: path } });
const reply = (text: string): TurnItem => ({ type: "assistant_message", text });
const runs = (rows: TurnRow[]) => rows.filter((r): r is Extract<TurnRow, { kind: "run" }> => r.kind === "run");

test("a turn folds like the chat: your message, a run of steps, the reply", () => {
  const turn = foldTurn([you("old task"), reply("old"), you("Fix the retry gap in example/app"), read("src/retry.ts"), shell("npm test"), reply("Done: retries capped.")], false);
  assert.deepEqual(turn.rows.map(r => r.kind), ["you", "run", "reply"]);
  const [run] = runs(turn.rows);
  assert.equal(run!.steps.length, 2);
  assert.equal(run!.live, false);
  assert.deepEqual(run!.steps.map(s => [s.icon, s.verb, s.target]), [["Eye", "Read", "src/retry.ts"], ["SquareTerminal", "Ran", "npm test"]]);
});

test("the live run names its running step's verb", () => {
  const turn = foldTurn([you("go"), read("a.ts"), shell("npm test", "running")], true);
  const [run] = runs(turn.rows);
  assert.equal(run!.live, true);
  assert.equal(run!.steps.at(-1)!.status, "running");
  assert.match(runLabel(run!), /^Running/);
});

test("a-peek-is-bounded: a 1000-step turn costs the same rows as a short one", () => {
  const items: TurnItem[] = [you("long task")];
  for (let i = 0; i < 1000; i++) { items.push(shell(`step ${i}`)); if (i % 50 === 49) items.push(reply(`checkpoint ${i}`)); }
  const turn = foldTurn(items, true);
  assert.ok(turn.rows.length <= TURN_ROWS, `${turn.rows.length} rows`);
  for (const r of runs(turn.rows)) assert.ok(r.steps.length <= TURN_STEPS);
  // Nothing is lost from the count: older runs fold into one "earlier" run that keeps their steps.
  assert.equal(runs(turn.rows).reduce((n, r) => n + runSteps(r), 0), 1000);
  const narrow = fitTurn(turn, 5);
  assert.ok(narrow.rows.length <= 5);
  assert.equal(runs(narrow.rows).reduce((n, r) => n + runSteps(r), 0), 1000);
});

test("tool names map to Chat Polish's verbs and icons", () => {
  assert.deepEqual([stepOf(toolItem("Edit", { file_path: "src/a.ts" })).verb, stepOf(toolItem("Write", { file_path: "b.ts" })).icon], ["Edited", "FilePlus"]);
  assert.equal(stepOf(toolItem("Grep", { pattern: "retry" })).target, "retry");
  assert.equal(stepOf({ type: "tool_call", name: "mcp__paseo__list_agents", status: "completed" }).icon, "Blocks");
});

test("an unloaded agent's transcript folds into the same rows", () => {
  const lines = [
    { type: "user", timestamp: "2026-11-27T10:00:00Z", message: { role: "user", content: "Fix the flaky test in acme/widgets" } },
    { type: "assistant", timestamp: "2026-11-27T10:00:05Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", timestamp: "2026-11-27T10:00:09Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 failed" }] } },
    { type: "assistant", timestamp: "2026-11-27T10:00:20Z", message: { role: "assistant", content: [{ type: "text", text: "The test races the timer; fixed." }] } },
  ].map(l => JSON.stringify(l));
  const { items, at } = transcriptTurnItems(lines);
  assert.equal(at, "2026-11-27T10:00:20Z");
  const turn = foldTurn(items, false);
  assert.deepEqual(turn.rows.map(r => r.kind), ["you", "run", "reply"]);
  assert.equal(runs(turn.rows)[0]!.failed, 1);
  assert.equal(turnSource({ source: "saved", at: "2026-11-27T07:00:20Z" }, Date.parse("2026-11-27T10:00:20Z")), "Saved transcript · last active 3h ago");
  assert.equal(turnSource({ source: "live", at: null }), null);
});

test("timeline already on screen: one predicate for marks and the chat beside", () => {
  const marked = new Set(["a1"]);
  assert.equal(timelineOnScreen("a1", { marked, chatBeside: null }), true);
  assert.equal(timelineOnScreen("a2", { marked, chatBeside: "a2" }), true);
  assert.equal(timelineOnScreen("a3", { marked, chatBeside: "a2" }), false);
  assert.equal(timelineOnScreen(null, { marked, chatBeside: null }), false);
});

const run = (events: PeekEvent[], s: PeekState = PEEK_CLOSED) => events.reduce(peekStep, s);

test("peek opens after the rest, not on the way across lines", () => {
  let s = run([{ type: "enter", id: "a", t: 0 }, { type: "leave", t: 100 }, { type: "enter", id: "b", t: 100 }, { type: "tick", t: 300 }]);
  assert.equal(s.open, null);
  s = run([{ type: "tick", t: 100 + OPEN_MS }], s);
  assert.equal(s.open, "b");
  assert.equal(peekDeadline(PEEK_CLOSED), null);
});

test("moving down into the peek never switches agents; another line takes over only after its rest", () => {
  let s = run([{ type: "enter", id: "a", t: 0 }, { type: "tick", t: OPEN_MS }]);
  assert.equal(s.open, "a");
  // Down from line a across line b and into the peek, inside the grace.
  s = run([{ type: "leave", t: 400 }, { type: "enter", id: "b", t: 410 }, { type: "leave", t: 470 }, { type: "peekEnter", t: 480 }, { type: "tick", t: 2000 }], s);
  assert.equal(s.open, "a");
  // Resting on b for OPEN_MS takes over.
  s = run([{ type: "peekLeave", t: 2100 }, { type: "enter", id: "b", t: 2110 }, { type: "tick", t: 2110 + OPEN_MS }], s);
  assert.equal(s.open, "b");
});

test("leaving the line and the peek closes after the grace; Esc closes at once", () => {
  let s = run([{ type: "enter", id: "a", t: 0 }, { type: "tick", t: OPEN_MS }, { type: "leave", t: 500 }, { type: "tick", t: 500 + CLOSE_MS - 1 }]);
  assert.equal(s.open, "a");
  s = run([{ type: "tick", t: 500 + CLOSE_MS }], s);
  assert.equal(s.open, null);
  s = run([{ type: "focus", id: "a", t: 0 }, { type: "tick", t: OPEN_MS }, { type: "close" }]);
  assert.equal(s.open, null);
});

test("a permission holds the peek open once the pointer entered it", () => {
  let s = run([{ type: "enter", id: "a", t: 0 }, { type: "tick", t: OPEN_MS }, { type: "asking", on: true, t: 400 }, { type: "peekEnter", t: 500 }, { type: "peekLeave", t: 600 }, { type: "tick", t: 5000 }]);
  assert.equal(s.open, "a");
  s = run([{ type: "close" }], s);
  assert.equal(s.open, null);
});

test("never wakes: an unloaded agent is read from its transcript, never its timeline", async () => {
  const src = await readFile(new URL("../client/turn-view.tsx", import.meta.url), "utf8");
  const hook = src.slice(src.indexOf("export function useTurn"), src.indexOf("// ---------- rows"));
  // The live read and subscription sit after the isLoaded check; the unloaded branch returns to the transcript RPC.
  const gate = hook.indexOf("isLoaded(");
  assert.ok(gate > 0, "useTurn checks isLoaded");
  assert.match(hook.slice(gate, hook.indexOf("void readLive();", gate)), /readSavedTurn\(\); return;/);
  assert.ok(hook.indexOf("timeline.refetch") > 0 && hook.lastIndexOf("timeline.subscribe") > gate, "the timeline is subscribed only after the gate");
  const server = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  const handler = server.slice(server.indexOf("handle(rpc.agentTurnRpc"), server.indexOf("handle(rpc.agentTurnRpc") + 300);
  assert.match(handler, /transcriptTurn\(/);
  assert.doesNotMatch(handler, /timeline|agents\.ref|daemon/i);
});
