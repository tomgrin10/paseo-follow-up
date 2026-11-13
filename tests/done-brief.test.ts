import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { briefAsks, BRIEF_KINDS, type BriefKind } from "../shared/brief";
import { flagHeadline } from "../shared/headline";
import { REASONS, type InboxRow, type Reason } from "../shared/inbox";
import { needsYouBlock } from "../shared/needs-block";
import { doneBriefViolations } from "../shared/status-invariants";

/**
 * a-done-brief-is-never-an-ask (2026-11-12, the developer's phone on 2.0.1-beta.3): the panel read "Needs you 1" with
 * one item, "Nothing needed": the agent's turn-end needs_you kind=done, on a row flagged by a merged PR. A done brief
 * says nothing is needed, so no surface draws or counts it as an ask.
 */
const NOW = Date.parse("2026-11-12T10:12:00.000Z");
const since = "2026-11-12T10:00:00.000Z";
const row = (reasons: Reason[], kind: BriefKind, source: "agent" | "extracted" | "followup" | "none" = "agent", detail = "#144 merged"): InboxRow => ({
  agentId: "a1", workspaceId: "w1", title: "Main", workspaceTitle: "Synthetic", multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: since, needs: reasons.length ? { reasons: reasons.map(r => ({ reason: r, at: since, detail, dedupeKey: r })), since } : null,
  snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true,
  brief: { kind, source, state: "open", ask: "Nothing needed", questionIds: [] },
} as InboxRow);
const merged = { kind: "pr" as const, key: "pr:example/app#144", title: "#144 merged", detail: "", state: "waiting" as const, big: null };

test("the reported case: a done brief on a row flagged by a merged PR is not an ask, and the count matches what's drawn", () => {
  const r = row(["pr_merged"], "done");
  assert.equal(briefAsks(r.brief, r), false);
  // What the panel and Home hand their Needs-you block: no brief, so neither "Nothing needed" nor a count of 1.
  assert.equal(needsYouBlock([], briefAsks(r.brief, r) ? { questionIds: [] } : null).count, 0, "nothing else needs you: the block hides");
  const withMerge = needsYouBlock([merged] as never, briefAsks(r.brief, r) ? { questionIds: [] } : null);
  assert.deepEqual([withMerge.count, withMerge.cards.length], [1, 0], "the merge row is the one item, not the done brief");
  const h = flagHeadline(r, NOW)!;
  assert.equal(h.key, "pr_merged");
  assert.equal(h.line, "#144 merged", "the pill and rows read the merge, not \"Nothing needed\"");
  assert.deepEqual(doneBriefViolations(r, [], NOW), []);
});

test("a-done-brief-is-never-an-ask holds for every flag reason, brief source and Needs-you list", () => {
  const failures: string[] = [];
  for (const reason of REASONS) for (const source of ["agent", "extracted", "followup", "none"] as const) for (const items of [[], [merged]]) {
    for (const v of doneBriefViolations(row([reason], "done", source), items as never, NOW)) failures.push(`${reason}/${source}/${items.length}: ${v.detail}`);
  }
  assert.deepEqual(failures, []);
});

test("every other stated kind on a flagged row is still an ask; nothing is one on an unflagged row or without a stated ask", () => {
  for (const kind of BRIEF_KINDS) {
    assert.equal(briefAsks(row(["finished"], kind).brief, row(["finished"], kind)), kind !== "done", kind);
    assert.equal(briefAsks(row([], kind).brief, row([], kind)), false, `${kind} on an unflagged row`);
    assert.equal(briefAsks(row(["finished"], kind, "none").brief, row(["finished"], kind, "none")), false, `${kind} with no ask stated`);
  }
  // A real ask still draws and counts as the block's first card.
  const decision = row(["finished"], "decision");
  assert.deepEqual(needsYouBlock([], briefAsks(decision.brief, decision) ? { questionIds: [] } : null).cards.map(c => c.kind), ["brief"]);
});

test("the panel and Home's detail pane pick their Needs-you brief with the one shared rule", () => {
  const panel = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../client/home.tsx", import.meta.url), "utf8");
  assert.match(panel, /return row\?\.snooze \|\| !briefAsks\(b, row\) \? null : b;/, "panel useMainBrief");
  assert.match(home, /const inBlock = !!w && !!showBrief && !later && briefAsks\(b, row\);/, "Home inBlock");
  for (const [name, src] of [["panel", panel], ["home", home]]) assert.doesNotMatch(src, /needs[^\n]*source !== "none"|source === "none" \? null : b/, `${name} keeps no inline copy of the rule`);
});
