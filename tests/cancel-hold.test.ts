import test from "node:test";
import assert from "node:assert/strict";
import { workspace, clock } from "./fixtures";
import type { Workspace } from "../shared/model";
import * as status from "../shared/status";
import { holdViolations } from "../shared/status-invariants";

const { interruptionHold, holdSuperseded, liftHold } = status;
const at = new Date(clock).toISOString();
const main = () => ({ ...workspace({ id: "w1", mainAgentId: "main" }) }) as Workspace;

/**
 * 2026-11-11, wks_5dfd3a653ad3c305 (main agent 37bc4ab1): Smart Session's queued /compact ran as turn …-3. An agent's
 * notification arrived 10 ms later, Paseo replaced the turn ("Compaction canceled.", outcome reason "Interrupted") and
 * started turn …-5. Follow-up read the cancel as the developer pressing Stop and held auto-sends until Resume.
 */
const live = {
  hold: interruptionHold("canceled"),
  interruption: { turnId: "foreground-turn-46063a91-6bed-4356-ad05-22718d502be0-3", at: "2026-11-11T11:27:10.646Z", kind: "canceled" as const, agentId: "main" },
};

test("the replaced compaction's Stop hold lifts on the main agent's next turn", () => {
  const w = { ...main(), ...live };
  assert.equal(holdSuperseded(w, { agentId: "main", turnId: "autonomous-turn-46063a91-6bed-4356-ad05-22718d502be0-5" }), true);
  if (holdSuperseded(w, { agentId: "main", turnId: "autonomous-turn-46063a91-6bed-4356-ad05-22718d502be0-5" })) liftHold(w);
  assert.equal(w.hold, null);
  assert.deepEqual(holdViolations({ ...main(), ...live }, "autonomous-turn-46063a91-6bed-4356-ad05-22718d502be0-5").map(v => v.id), ["automatic-hold-is-not-stale"]);
});

test("a hold from before Follow-up recorded the interruption (wks_e68ccc7b52c57d1f) lifts on a main-agent turn", () => {
  const w = { ...main(), hold: interruptionHold("canceled"), interruption: undefined };
  assert.equal(holdSuperseded(w, { agentId: "main", turnId: null }), false, "no turn running: nothing says the agent resumed");
  assert.equal(holdSuperseded(w, { agentId: "helper", turnId: "t2" }), false, "another agent's turn is not the main agent resuming");
  assert.equal(holdSuperseded(w, { agentId: "main", turnId: "t2" }), true);
});

/**
 * Every way a main-agent turn ends canceled, with the reason string Paseo 0.16 sends (server/agent/agent-manager.js,
 * providers/claude/agent.js, plugins/lifecycle/index.js). The reason text alone can't tell Stop from a replaced turn:
 * both are "Interrupted". Only a genuine Stop holds; when unsure, nothing holds.
 */
const CASES: { cause: string; reason: string; prompt?: string | null; newerTurn?: boolean; holds: boolean }[] = [
  { cause: "stop", reason: "Interrupted", holds: true },
  { cause: "stop", reason: "interrupted", holds: true },
  { cause: "replaced", reason: "Interrupted", newerTurn: true, holds: false },
  { cause: "replaced", reason: "interrupted", newerTurn: true, holds: false },
  { cause: "compaction", reason: "Interrupted", prompt: "/compact Preserve: the current goal", holds: false },
  { cause: "compaction", reason: "Interrupted", prompt: "/compact", newerTurn: true, holds: false },
  { cause: "reload", reason: "agent reloaded", holds: false },
  { cause: "closed", reason: "agent closed", holds: false },
];

test("cancel causes: only the developer's Stop holds Follow-up", () => {
  const { cancelCause, holdOnTurnEnd, CANCEL_CAUSES } = status;
  assert.deepEqual([...new Set(CASES.map(c => c.cause))].sort(), [...CANCEL_CAUSES].sort(), "every cause is enumerated");
  for (const c of CASES) {
    const label = `${c.cause} · ${JSON.stringify(c.reason)}${c.prompt ? " · /compact" : ""}${c.newerTurn ? " · newer turn" : ""}`;
    assert.equal(cancelCause({ reason: c.reason, prompt: c.prompt ?? null, newerTurn: !!c.newerTurn }), c.cause, label);
    const w = main();
    holdOnTurnEnd(w, { agentId: "main", turnId: "t1", at, outcome: { kind: "canceled", reason: c.reason }, prompt: c.prompt ?? null, newerTurn: !!c.newerTurn });
    assert.equal(w.hold, c.holds ? interruptionHold("canceled") : null, label);
    assert.equal(!!w.interruption, c.holds, label);
  }
  // A failed turn still holds (its own hold lifts on the next turn, #91); a helper agent's cancel never holds.
  const failed = main(); holdOnTurnEnd(failed, { agentId: "main", turnId: "t1", at, outcome: { kind: "failed", error: { message: "boom" } }, prompt: null, newerTurn: false });
  assert.equal(failed.hold, interruptionHold("failed"));
  const helper = main(); holdOnTurnEnd(helper, { agentId: "helper", turnId: "t1", at, outcome: { kind: "canceled", reason: "Interrupted" }, prompt: null, newerTurn: false });
  assert.equal(helper.hold, null);
});

test("only-a-stop-holds: a workspace never holds for a cancel that wasn't the developer's Stop", async () => {
  const { violations } = await import("../shared/status-invariants");
  const { CANCEL_CAUSES } = status;
  for (const cause of CANCEL_CAUSES) {
    const w = { ...main(), hold: interruptionHold("canceled"), interruption: { turnId: "t1", at, kind: "canceled" as const, agentId: "main", cause } };
    assert.equal(violations(w, clock).some(v => v.id === "only-a-stop-holds"), cause !== "stop", cause);
  }
  // Every hold holdOnTurnEnd leaves satisfies it.
  for (const c of CASES) {
    const w = main();
    status.holdOnTurnEnd(w, { agentId: "main", turnId: "t1", at, outcome: { kind: "canceled", reason: c.reason }, prompt: c.prompt ?? null, newerTurn: !!c.newerTurn });
    assert.deepEqual(violations(w, clock).filter(v => v.id === "only-a-stop-holds"), [], c.cause);
  }
});

/**
 * 2026-11-12 08:06, wks_5dfd3a653ad3c305: Smart Session delivered a /compact (queue item settled 08:06:23.965) and a
 * second one replaced it 22 ms later ("Compaction canceled."). The canceled turn's prompt need not be in the timeline
 * tail when its end is handled, and the replacing turn may not have started yet: Smart Session's own queue says a
 * /compact was just delivered, so the cancel is the compaction's, never the developer's Stop.
 */
test("only-a-stop-holds: a cancel right after Smart Session delivered a /compact is the compaction's", () => {
  const { cancelCause, compactionDelivered, holdOnTurnEnd } = status;
  const end = Date.parse("2026-11-12T08:06:24.018Z");
  const item = (patch: Record<string, unknown>) => ({ id: "c1", agentId: "main", state: "sent", createdAt: "2026-11-12T08:06:08.719Z", settledAt: "2026-11-12T08:06:23.965Z", confirmedAt: null, ...patch });
  assert.equal(compactionDelivered([item({})], "main", end), true, "delivered 53 ms before the cancel");
  assert.equal(compactionDelivered([item({ state: "sending", settledAt: null })], "main", end), true, "still being delivered: the send hadn't returned");
  assert.equal(compactionDelivered([item({ agentId: "other" })], "main", end), false, "another agent's compaction");
  assert.equal(compactionDelivered([item({ settledAt: "2026-11-12T07:50:00.000Z" })], "main", end), false, "delivered long before");
  assert.equal(compactionDelivered([item({ confirmedAt: "2026-11-12T08:06:20.000Z", settledAt: "2026-11-12T08:05:00.000Z" })], "main", end), false, "that compaction already finished");
  assert.equal(compactionDelivered([item({ state: "pending", settledAt: null })], "main", end), false, "queued, not sent: the turn isn't the /compact");
  assert.equal(cancelCause({ reason: "Interrupted", prompt: null, newerTurn: false, compaction: true }), "compaction");
  const w = main();
  holdOnTurnEnd(w, { agentId: "main", turnId: "t1", at, outcome: { kind: "canceled", reason: "Interrupted" }, prompt: null, newerTurn: false, compaction: true });
  assert.equal(w.hold, null, "no hold");
});

test("only-a-stop-holds: the worker's turn-end handler asks Smart Session's queue before holding", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("index.server.ts", "utf8");
  assert.match(source, /compactionJustDelivered\(event\.agent\.id/, "agent.turn_ended reads the compaction queue");
  assert.match(source, /holdOnTurnEnd\(w, \{[^}]*\bcompaction\b[^}]*\}\)/, "and passes it to holdOnTurnEnd");
});
