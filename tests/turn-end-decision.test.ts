import test from "node:test";
import assert from "node:assert/strict";
import { turnEndDecision, type TurnEndFacts } from "../shared/turn-checks.mjs";
import { providerCaps } from "../shared/provider-support";
import { turnEndCheck, type TurnEndInput } from "../server/turn-end";
// @ts-expect-error plain JS hook, generated into hook-source.ts
import { stopDecision } from "../server/agent-hook.mjs";

/**
 * Invariant 147, one-turn-end-decision: one function (shared/turn-checks.mjs turnEndDecision) decides the turn-end
 * checks for every provider, and the provider never decides them: a hook provider (Claude Code, Codex) gets them from
 * its Stop hook, every other provider from Paseo's turn-end event, and exactly one of the two acts for any agent.
 * 2026-11-27: the hook's nudge checked provider === "claude" and the event skipped hook providers, so a Codex root
 * agent never got the needs_you nudge.
 */

// One of each provider kind Paseo runs: hook (Claude Code, Codex), system prompt (OpenCode, Pi), ACP (Copilot).
const PROVIDERS = ["claude", "codex", "opencode", "pi", "copilot"];
const NOW = 10_000;
const brief = { enable_inbox: true, enable_brief_nudge: true, pending: [] };

/** A tracked main agent's turn the developer started, which changed something, synced nothing and stated no ask. */
function both(provider: string, over: { needsYou?: boolean; synced?: boolean } = {}) {
  const hook = stopDecision({ workspace: { id: "w1" }, contributor: false, root: true, brief, agentId: "a1", turn: { startedAt: 1000, dirtyAt: 1500, stopped: false },
    synced: over.synced ? { workspaceId: "w1", at: 2000 } : null, called: over.needsYou ? { at: 2000 } : null, due: [], receipt: {}, now: NOW });
  const input: TurnEndInput = { provider, entry: { role: "main", workspaceId: "w1" }, items: [{ type: "user_message", text: "Fix the export, please." }, { type: "tool_call", name: "edit", callId: "c1" }],
    startedAt: 1000, syncedAt: over.synced ? 2000 : null, needsYouAt: over.needsYou ? 2000 : null, nudge: true, receipt: {}, now: NOW };
  const event = turnEndCheck(input).text;
  return { hook: providerCaps(provider).turnEnd === "hook" ? hook : null, event };
}

test("one-turn-end-decision: every provider kind gets the sync and needs_you checks, from exactly one trigger", () => {
  for (const provider of PROVIDERS) {
    const { hook, event } = both(provider);
    if (providerCaps(provider).turnEnd === "hook") {
      assert.equal(event, null, `${provider}: the event leaves it to the Stop hook`);
      assert.equal(hook!.sync, true, `${provider}: sync`); assert.equal(hook!.nudge, true, `${provider}: needs_you nudge`);
    } else {
      assert.match(event ?? "", /sync_workspace/, `${provider}: sync`); assert.match(event ?? "", /call follow_needs_you once/, `${provider}: needs_you nudge`);
    }
    const quiet = both(provider, { needsYou: true, synced: true });
    assert.equal(quiet.event, null, `${provider}: nothing due, nothing sent`);
    if (quiet.hook) assert.equal(quiet.hook.any, false, `${provider}: nothing due, no block`);
  }
});

test("one-turn-end-decision: the facts decide, never the provider", () => {
  const facts: TurnEndFacts = { trigger: "hook", role: "main", root: true, nudgeOn: true, changed: true, synced: false, needsYouCalled: false, askedElsewhere: false, now: NOW };
  const all = (over: Partial<TurnEndFacts>) => turnEndDecision({ ...facts, ...over });
  assert.deepEqual([all({}).sync, all({}).nudge], [true, true]);
  assert.equal(all({ role: "contributor" }).nudge, false, "a contributor reports to the main agent");
  assert.equal(all({ role: "contributor" }).sync, true, "a contributor still syncs");
  assert.equal(all({ role: null }).nudge, true, "a root agent outside any tracked workspace is nudged");
  assert.equal(all({ role: null }).sync, false, "and has nothing to sync");
  assert.equal(all({ role: "recovery" }).any, false, "recovery: nothing");
  assert.equal(all({ root: false, role: null }).any, false, "not a root agent: nothing");
  assert.equal(all({ nudgeOn: false }).nudge, false);
  assert.equal(all({ askedElsewhere: true }).nudge, false, "one decision, one card");
  assert.equal(all({ trigger: "event", developerTurn: false }).nudge, false, "the event nudges only a turn the developer started");
  assert.equal(all({ trigger: "event", developerTurn: true }).nudge, true);
  assert.deepEqual(all({ due: [{ id: "t1", key: "k", revision: 1, dueAt: new Date(0).toISOString(), line: "Check the export" }], receipt: {} }).due, ["Check the export"]);
});
