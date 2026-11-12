import test from "node:test";
import assert from "node:assert/strict";
import { newEntry, reduce, type Entry } from "../shared/inbox";
import { flagHeadline } from "../shared/headline";
import { followUpEvents } from "../server/inbox";
import { violations } from "../shared/status-invariants";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * 2026-11-12, live sidebar: rows sat in NEEDS YOU as "PR closed · #37 merged" and "#1629 merged". followUpEvents emitted
 * pr_closed for every MERGED or CLOSED PR, whoever merged it, and the headline called every one "PR closed". An agent
 * that merged its own PR (register_pr agentMerges: true, which promises the developer is never asked about it) flagged
 * the developer anyway. Invariants a-merge-the-agent-made-never-flags-the-developer and pr-label-matches-state.
 */
const at = (i: number) => new Date(clock + i * 1000).toISOString();
const flagsFor = (w: ReturnType<typeof workspace>, start: Entry = newEntry("main-agent")) =>
  followUpEvents({ version: 1, workspaces: [w] } as never, true).filter(e => e.agentId === "main-agent").reduce((e, ev, i) => reduce(e, ev.event, at(i)), start);
const merged = (patch = {}) => pr({ key: "example/app#37", number: 37, snapshot: snapshot({ state: "MERGED" }), ...patch });
const closed = () => pr({ key: "example/app#38", number: 38, snapshot: snapshot({ state: "CLOSED" }) });

test("a-merge-the-agent-made-never-flags-the-developer: a PR the agent merged itself raises no flag", () => {
  const e = flagsFor(workspace({ prs: [merged({ agentMerges: true })] }));
  assert.equal(e.needs, null, "the agent merged it and reports it in its own turn");
});

test("a-merge-the-agent-made-never-flags-the-developer: it still wakes a snooze set 'until this PR merges'", () => {
  const snoozed: Entry = { ...newEntry("main-agent"), needs: { reasons: [{ reason: "finished", at: at(0), detail: "Done", dedupeKey: "t1" }], since: at(0) }, snooze: { until: "pr:example/app#37", at: at(0) } as never };
  const e = flagsFor(workspace({ prs: [merged({ agentMerges: true })] }), snoozed);
  assert.equal(e.snooze, null, "the merge it waited for happened");
});

test("pr-label-matches-state: a merge reads Merged, only a closed-unmerged PR reads PR closed", () => {
  const m = flagsFor(workspace({ prs: [merged()] }));
  assert.match(flagHeadline({ needs: m.needs, snooze: null, brief: null }, clock)?.label ?? "", /^Merged\b/);
  const c = flagsFor(workspace({ prs: [closed()] }));
  assert.match(flagHeadline({ needs: c.needs, snooze: null, brief: null }, clock)?.label ?? "", /^PR closed\b/, "closed without merging still flags");
});

test("both invariants hold for a PR merged by its agent, merged by the developer, and closed unmerged", () => {
  const ids = ["a-merge-the-agent-made-never-flags-the-developer", "pr-label-matches-state"];
  for (const w of [workspace({ prs: [merged({ agentMerges: true })] }), workspace({ prs: [merged()] }), workspace({ prs: [closed()] })])
    assert.deepEqual(violations(w, clock).filter(v => ids.includes(v.id)), []);
});

test("pr-label-matches-state: a flag stored before pr_merged existed still reads Merged", () => {
  const needs = { reasons: [{ reason: "pr_closed" as const, at: at(0), detail: "#37 merged", dedupeKey: "example/app#37:MERGED" }], since: at(0) };
  assert.match(flagHeadline({ needs, snooze: null, brief: null }, clock)?.label ?? "", /^Merged\b/);
});
