import test from "node:test";
import assert from "node:assert/strict";
import { WaitLedger, waitView, waitLine, clock, type WaitJob } from "../shared/wait-chat";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const job = (calls: WaitJob["calls"], extra: Partial<WaitJob> = {}): WaitJob => ({ jobId: "j", description: "npm test", command: "npm test", createdAt: at(0), firstCallId: calls[0]?.callId ?? "w1", calls, status: null, ...extra });
const line = (j: WaitJob, now: number, compact = false) => waitLine(j, waitView(j, T0 + now * 1000, T0 + 2000), compact).meta;

test("clock: m:ss, then h:mm:ss, floored", () => {
  assert.equal(clock(0), "0:00"); assert.equal(clock(7.9), "0:07"); assert.equal(clock(161), "2:41"); assert.equal(clock(3725), "1:02:05"); assert.equal(clock(-3), "0:00");
});

test("running: job time and a countdown to the next check, across calls", () => {
  const first = job([{ callId: "w1", status: "running", maxWait: 180 }]);
  assert.equal(line(first, 74), "1:14 · next check 1:48", "early: the first call started at the row's timestamp (+2 s)");
  assert.equal(line(first, 180), "3:00 · next check 0:02", "near the cap");
  assert.equal(line(first, 74, true), "1:14", "phones keep the job time only");
  const second = job([{ callId: "w1", status: "completed", maxWait: 180, outcome: "still_pending", checkedAt: at(182) }, { callId: "w2", status: "running", maxWait: 180 }]);
  assert.equal(line(second, 252), "4:12 · next check 1:50", "one row keeps counting; the countdown starts at the last check");
  assert.equal(line(job([{ callId: "w1", status: "running", maxWait: 60 }], { createdAt: null }), 32), "0:30 · next check 0:30", "no receipt yet: counts from the row");
});

test("settled lines: passed, failed, released, still running, stopped, error", () => {
  const done = (outcome: "completed" | "failed" | "still_pending" | "new_message", exitCode?: number) => job([{ callId: "w1", status: "completed", maxWait: 180, outcome, exitCode, checkedAt: at(161) }]);
  assert.equal(line(done("completed", 0), 999), "passed · 2:41");
  assert.equal(line(done("failed", 7), 999), "failed · exit 7 · 2:41");
  assert.equal(line(done("new_message"), 999), "still running · released by a new message at 2:41");
  assert.equal(line(done("still_pending"), 999), "still running · checked at 2:41");
  assert.equal(line(job([{ callId: "w1", status: "canceled", maxWait: 180 }]), 999), "still running · wait stopped");
  assert.equal(line(job([{ callId: "w1", status: "failed", maxWait: 180, error: "Unknown job for this agent" }]), 999), "couldn't check · Unknown job for this agent");
  const checked = job([{ callId: "w1", status: "completed", maxWait: 180, outcome: "still_pending", checkedAt: at(180) }], { status: { status: "completed", exitCode: 0, checkedAt: at(200) } });
  assert.equal(line(checked, 999), "passed · 3:20", "a later wait_get_job settles the row");
  assert.equal(waitLine(job([], { description: null }), { state: "pending", elapsed: null }).title, "Background job");
});

test("the ledger tells rows when their job changes, after the render that changed it", async () => {
  const ledger = new WaitLedger();
  let heard = 0; ledger.subscribe(() => heard++);
  ledger.observe({ type: "tool_call", callId: "w1", name: "mcp__paseo__wait_for_job", status: "running", error: null, detail: { type: "unknown", input: { jobId: "6f1c7a52-8f0e-4d43-9a43-2b7c0f3c1a11" } } });
  assert.equal(heard, 0, "not during the transform");
  await Promise.resolve();
  assert.equal(heard, 1);
});
