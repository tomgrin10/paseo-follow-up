import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEntry, notifiedBefore, prNotice, pruneNotified, reduce } from "../shared/inbox";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import { pr, snapshot, workspace } from "./fixtures";

/**
 * a-pr-flag-fires-once-per-transition (2026-11-13, beta.4 live): the orchestrator's row read "Merged 29m" for
 * "#92 merged", a PR merged two days before. PR flags deduped through a 200-key ring per agent; its workspace tracks
 * 153 PRs, so each new key evicted the oldest and the next tick re-flagged that PR's old merge. Each PR now keeps the
 * state every flag kind last notified, for as long as the PR is tracked.
 */
const T0 = "2026-11-13T05:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const agentInfo = (id: string): AgentInfo => ({ id, workspaceId: "w1", parentAgentId: null, title: id, status: "idle", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null });
const directory: Directory = { agent: async (id: string) => agentInfo(id), tail: async () => [] } as unknown as Directory;
const none = { prompt: async () => null, lastUserMessageAt: async () => null } as never;

const merged = (n: number, o: { agentMerges?: boolean } = {}) => pr({ key: `example/app#${n}`, number: n, ...o, snapshot: snapshot({ state: "MERGED" }) } as never);
const follow = (prs: unknown[]) => ({ version: 1 as const, workspaces: [workspace({ id: "w1", mainAgentId: "a1", prs: prs as never })] });

async function inbox(t: { after(fn: () => unknown): void }, now = () => Date.parse(at(1))) {
  const dir = await mkdtemp(join(tmpdir(), "follow-pr-flags-")); t.after(() => rm(dir, { recursive: true, force: true }));
  return new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: none, guard: async () => null, now });
}
const flags = async (box: Inbox) => (await box.store.snapshot()).entries.a1?.needs?.reasons.filter(r => r.reason === "pr_merged").map(r => r.detail) ?? [];

test("pr-flags-once: the upgrade backfills 160 old merges without flagging any, then flags only new ones", async t => {
  const box = await inbox(t);
  // A pre-upgrade store: primed long ago, the ring holding only the newest 200 keys (old merges evicted), no notifiedAt.
  const ring = Array.from({ length: 200 }, (_, i) => `example/app#${1000 + i}:conflict:sha${i}`);
  await box.store.mutate(s => { s.importedAt = at(-9000); s.primedAt = at(-9000); s.entries.a1 = { ...newEntry("a1"), seenKeys: ring }; });
  const old = Array.from({ length: 160 }, (_, i) => merged(i + 1));
  await box.observeFollowUp(follow(old) as never);
  const after = await box.store.snapshot();
  assert.deepEqual(await flags(box), [], "no old merge flags on the upgrade");
  assert.ok(after.notifiedAt, "the backfill ran once");
  assert.equal(Object.values(after.entries.a1!.notified ?? {}).filter(n => n.end === "MERGED").length, 160);
  assert.deepEqual(after.entries.a1!.seenKeys, [], "the ring keeps no PR keys");
  // Later ticks: the old merges stay quiet; a new merge flags.
  await box.observeFollowUp(follow(old) as never);
  assert.deepEqual(await flags(box), []);
  await box.observeFollowUp(follow([...old, merged(500)]) as never);
  assert.deepEqual(await flags(box), ["#500 merged"]);
});

test("pr-flags-once: with more than 200 merged PRs, nothing old re-flags and each new non-agent merge flags exactly once", async t => {
  const box = await inbox(t);
  await box.store.mutate(s => { s.importedAt = at(0); s.primedAt = at(0); s.notifiedAt = at(0); });
  const prs: unknown[] = [];
  const seen = new Map<string, number>();
  for (let n = 1; n <= 260; n++) {
    // Every fifth PR is one the agent merges itself: recorded, never flagged.
    prs.push(merged(n, n % 5 === 0 ? { agentMerges: true } : {}));
    await box.observeFollowUp(follow(prs) as never);
    for (const d of await flags(box)) seen.set(d, (seen.get(d) ?? 0) + 1);
    // The developer signs off each flag, so a re-fire would show up as a second count.
    await box.store.mutate(s => { if (s.entries.a1) s.entries.a1 = { ...s.entries.a1, needs: null }; });
  }
  // Twenty more quiet ticks over the full set.
  for (let i = 0; i < 20; i++) { await box.observeFollowUp(follow(prs) as never); for (const d of await flags(box)) seen.set(d, (seen.get(d) ?? 0) + 1); }
  const expected = Array.from({ length: 260 }, (_, i) => i + 1).filter(n => n % 5 !== 0).map(n => `#${n} merged`);
  assert.deepEqual([...seen.keys()].sort(), expected.sort(), "each developer merge flagged; no agent merge did");
  assert.deepEqual([...seen.entries()].filter(([, c]) => c !== 1), [], "each exactly once");
});

test("pr-flags-once: one record per PR and flag kind, the newest state wins, and an untracked PR's record goes", () => {
  assert.deepEqual(prNotice("example/app#7:MERGED"), { pr: "example/app#7", kind: "end", value: "MERGED" });
  assert.deepEqual(prNotice("example/app#7:abc123:checks"), { pr: "example/app#7", kind: "checks", value: "abc123" });
  assert.deepEqual(prNotice("example/app#7:threads:t1,t2"), { pr: "example/app#7", kind: "threads", value: "t1,t2" });
  assert.deepEqual(prNotice("example/app#7:conflict:abc123"), { pr: "example/app#7", kind: "conflict", value: "abc123" });
  assert.deepEqual(prNotice("example/app#7:reviewers"), { pr: "example/app#7", kind: "reviewers", value: "asked" });
  assert.equal(prNotice("paused:p1"), null, "Session Guard pauses keep the small ring");
  let e = newEntry("a1");
  e = reduce(e, { type: "review", dedupeKey: "example/app#7:conflict:sha1", detail: "Merge conflict to fix on #7" }, at(1));
  assert.equal(e.needs?.reasons.length, 1);
  e = { ...e, needs: null };
  e = reduce(e, { type: "review", dedupeKey: "example/app#7:conflict:sha1", detail: "Merge conflict to fix on #7" }, at(2));
  assert.equal(e.needs, null, "the same head doesn't flag twice");
  e = reduce(e, { type: "review", dedupeKey: "example/app#7:conflict:sha2", detail: "Merge conflict to fix on #7" }, at(3));
  assert.equal(e.needs?.reasons.length, 1, "a new head with a conflict is a new transition");
  assert.deepEqual(e.notified, { "example/app#7": { conflict: "sha2" } }, "one record per PR and kind");
  assert.equal(notifiedBefore(e, "example/app#7:conflict:sha1"), false, "only the newest state is kept");
  const pruned = pruneNotified(e, new Set(["example/app#8"]));
  assert.deepEqual(pruned.notified, {}, "an untracked PR's record goes");
  assert.equal(pruneNotified(e, new Set(["example/app#7"])), e, "nothing to prune: the same entry, no copy");
});

test("pr-flags-once: a withdrawn Add reviewers may ask again (its record goes with the flag)", () => {
  let e = reduce(newEntry("a1"), { type: "reviewers", dedupeKey: "example/app#7:reviewers", detail: "#7", prKey: "example/app#7", url: null, names: [] }, at(1));
  assert.equal(e.needs?.reasons[0]?.reason, "reviewers");
  e = reduce(e, { type: "facts_live", live: [] }, at(2));
  assert.equal(e.needs, null);
  e = reduce(e, { type: "reviewers", dedupeKey: "example/app#7:reviewers", detail: "#7", prKey: "example/app#7", url: null, names: [] }, at(3));
  assert.equal(e.needs?.reasons[0]?.reason, "reviewers", "asks again");
});

test("pr-flags-once: invariant a-pr-flag-fires-once-per-transition catches a merge flagged long after it merged", async () => {
  const { factFlagViolations } = await import("../shared/status-invariants");
  const w = workspace({ id: "w1", mainAgentId: "a1", prs: [pr({ key: "example/app#92", number: 92, snapshot: snapshot({ state: "MERGED", mergedAt: "2026-11-10T18:25:09Z" }) })] as never });
  const row = (flagAt: string) => ({ agentId: "a1", needs: { reasons: [{ reason: "pr_merged" as const, at: flagAt, detail: "#92 merged", dedupeKey: "pr_merged" }], since: flagAt } });
  // The live row: flagged 2026-11-13T05:20:38Z for a merge on 2026-11-10.
  assert.deepEqual(factFlagViolations([row("2026-11-13T05:20:38.728Z")], [w]).map(v => v.id), ["a-pr-flag-fires-once-per-transition"]);
  assert.deepEqual(factFlagViolations([row("2026-11-10T18:26:00.000Z")], [w]), [], "a fresh merge flag is news");
});
