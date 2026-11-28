import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fitTurn, foldTurn, runLabel, runSteps, stepOf, turnSource, TURN_ROWS, TURN_STEPS, type TurnItem, type TurnRow } from "../shared/turn";
import { CLOSE_MS, OPEN_MS, PEEK_CLOSED, peekDeadline, peekStep, peekWait, pointerWhere, timelineOnScreen, type PeekEvent, type PeekState } from "../shared/peek";
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

// The root cause behind invariant 151 (2.6.0-beta.4 live check: a peek stayed open with the pointer on the Home title;
// replayed with the live check's moves on perf-ui-setup's live-sized fictional seed while awake agents streamed busy
// turns, 9 of 40 stayed open and 21 rests never opened, though every row's pointerleave arrived).
// Browsers fire setTimeout up to ~1 ms before its delay on performance.now() (headless Chromium: about 80 % of 150 ms
// timers, as early as 0.9 ms). A tick before the deadline changes nothing, so the state stays the same object; a host
// that re-arms only when the state changes never ticks again, and the grace close (or the open intent) is lost.
test("an-open-peek-closes-when-the-pointer-is-away: a timer that fires early waits again", () => {
  const leaving = run([{ type: "leave", t: 1000 }], opened);
  const early = peekStep(leaving, { type: "tick", t: 1000 + CLOSE_MS - 0.4 });
  assert.equal(early, leaving, "an early tick changes nothing");
  // What to wait for is read from the state and the clock, so the host waits again for what is left.
  assert.ok(peekWait(early, 1000 + CLOSE_MS - 0.4)! > 0);
  assert.equal(peekWait(PEEK_CLOSED, 0), null);
  assert.equal(peekStep(early, { type: "tick", t: 1000 + CLOSE_MS }).open, null);
  // The open intent too.
  const arming = run([{ type: "enter", id: "b", t: 0 }]);
  assert.equal(peekStep(arming, { type: "tick", t: OPEN_MS - 0.9 }), arming);
  assert.ok(peekWait(arming, OPEN_MS - 0.9)! > 0);
});

test("an-open-peek-closes-when-the-pointer-is-away: the host's timer re-checks the clock before it ticks", async () => {
  const src = await readFile(new URL("../client/turn-view.tsx", import.meta.url), "utf8");
  const timer = src.slice(src.indexOf("// One timer"), src.indexOf("// Place it when it opens"));
  // It never dispatches a tick before the deadline: it waits again for what is left (peekWait), then ticks.
  assert.match(timer, /peekWait\(state, clock\(\)\)/);
  assert.match(timer, /const wait = peekWait\(state, now\)/);
});

// Invariant 151 (an-open-peek-closes-when-the-pointer-is-away), the class: the host also reads where the pointer is
// from the document, so a peek never waits on one leave event (a hover lost to React Native Web's nested-Pressable hover
// lock, a node replaced under the pointer), and the machine closes on that alone.
const opened = run([{ type: "enter", id: "a", t: 0 }, { type: "tick", t: OPEN_MS }]);
const at = (where: "line" | "pending" | "peek" | "away", t: number): PeekEvent => ({ type: "pointer", where, t });

test("an-open-peek-closes-when-the-pointer-is-away: no leave event needed", () => {
  // The line's leave never arrives; the document says the pointer is away.
  assert.equal(run([at("away", 1000), { type: "tick", t: 1000 + CLOSE_MS }], opened).open, null);
  // Moves away keep coming: they never push the close later.
  assert.equal(run([at("away", 1000), at("away", 1100), at("away", 1140), { type: "tick", t: 1000 + CLOSE_MS }], opened).open, null);
  // Crossing the gap into the peek, its own enter lost too: the pointer over the peek keeps it.
  assert.equal(run([at("away", 1000), at("peek", 1060), { type: "tick", t: 9000 }], opened).open, "a");
  // Back over the line cancels the grace.
  assert.equal(run([at("away", 1000), at("line", 1050), { type: "tick", t: 9000 }], opened).open, "a");
  // Leaving the peek with its leave lost closes it too.
  assert.equal(run([{ type: "peekEnter", t: 500 }, at("away", 1000), { type: "tick", t: 1000 + CLOSE_MS }], opened).open, null);
  // A line armed on the way whose leave was lost never opens once the pointer is away.
  const armed = run([{ type: "enter", id: "b", t: 0 }, at("away", 100), { type: "tick", t: OPEN_MS }, { type: "tick", t: 9000 }]);
  assert.equal(armed.open, null);
  assert.equal(peekDeadline(armed), null);
  // A takeover arming on line b while the pointer rests on it is kept.
  assert.equal(run([{ type: "enter", id: "b", t: 1000 }, at("pending", 1100), { type: "tick", t: 1000 + OPEN_MS }], opened).open, "b");
});

test("an-open-peek-closes-when-the-pointer-is-away: what it keeps", () => {
  // The permission's sticky peek stays until closed.
  const asking = run([{ type: "asking", on: true, t: 400 }, { type: "peekEnter", t: 500 }, at("away", 600), { type: "tick", t: 9000 }], opened);
  assert.equal(asking.open, "a");
  // Nothing to change returns the same state, so the host doesn't redraw on every pointer move.
  assert.equal(peekStep(PEEK_CLOSED, at("away", 1)), PEEK_CLOSED);
  assert.equal(peekStep(opened, at("line", 1)), opened);
  const closing = peekStep(opened, at("away", 1000));
  assert.equal(peekStep(closing, at("away", 1010)), closing);
  const inPeek = peekStep(opened, at("peek", 1000));
  assert.equal(peekStep(inPeek, at("peek", 1010)), inPeek);
});

test("pointerWhere: the peek, then the open line, then the arming line, else away", () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  const boxes = { line: box(0, 100, 400, 138), pending: box(0, 138, 400, 176), peek: box(408, 100, 848, 400) };
  assert.equal(pointerWhere({ x: 10, y: 120 }, boxes), "line");
  assert.equal(pointerWhere({ x: 10, y: 150 }, boxes), "pending");
  assert.equal(pointerWhere({ x: 500, y: 300 }, boxes), "peek");
  assert.equal(pointerWhere({ x: 404, y: 120 }, boxes), "away");
  assert.equal(pointerWhere({ x: 30, y: 600 }, { line: null, pending: null, peek: null }), "away");
});

test("an-open-peek-closes-when-the-pointer-is-away: the host reads the document's pointer", async () => {
  const src = await readFile(new URL("../client/turn-view.tsx", import.meta.url), "utf8");
  const host = src.slice(src.indexOf("export function PeekHost"));
  assert.match(host, /addEventListener\("pointermove"/);
  assert.match(host, /type: "pointer", where: pointerWhere\(/);
  // Keyboard entry holds it: focus on the line or in the peek, never the pointer, decides then.
  assert.match(host, /held\(/);
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
