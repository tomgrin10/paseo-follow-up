import test from "node:test";
import assert from "node:assert/strict";
import { Github, fingerprint, parsePr } from "../server/github";
import type { GithubApi } from "../server/github-api";
import { watchVerdict, type CheckWatch, type WatchedPr } from "../shared/check-watch";
import { pr } from "./fixtures";

// Invariant checks-belong-to-the-current-head (152): a pass, a failure or a conflict is reported only for results read
// for the PR's current head. 2026-11-28 01:15Z, example/app#375 shape: the head moved h1 -> h2, GitHub's
// `commits(last:1)` still returned h1's rollup (all passed), and the watch said "all checks passed on h2" while h2's
// workflow run was in progress.

type Row = { head: string; checksOn: string; status: "IN_PROGRESS" | "COMPLETED"; conclusion: string | null };
function fakeGithub(row: Row, hooks: { beforeAnswer?: () => void } = {}) {
  const api: GithubApi = {
    async graphql(repo, query) {
      const repository: Record<string, unknown> = { defaultBranchRef: { name: "main", branchProtectionRule: null, rules: { pageInfo: { hasNextPage: false }, nodes: [] } } };
      for (const [, alias, number] of query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
        repository[alias] = {
          number: Number(number), title: "Add the export button", url: `https://github.com/${repo}/pull/${number}`, state: "OPEN", updatedAt: "2026-11-28T01:00:00Z",
          headRefOid: row.head, headRefName: "export", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
          isInMergeQueue: false, autoMergeRequest: null, mergeCommit: null, mergedAt: null, author: { login: "alice" },
          reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
          baseRef: { branchProtectionRule: { requiredStatusCheckContexts: ["verify"] }, rules: { pageInfo: { hasNextPage: false }, nodes: [] }, associatedPullRequests: { nodes: [] } },
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          commits: { nodes: [{ commit: { oid: row.checksOn, statusCheckRollup: { contexts: {
            checkRunCountsByState: [{ state: row.status === "COMPLETED" ? row.conclusion : row.status, count: 1 }], statusContextCountsByState: [],
            pageInfo: { hasNextPage: false }, nodes: [{ name: "verify", status: row.status, conclusion: row.conclusion }],
          } } } }] },
        };
      }
      hooks.beforeAnswer?.();
      return { data: { rateLimit: { cost: 1, remaining: 4000, resetAt: "2099-01-01T00:00:00Z", limit: 5000 }, repository } };
    },
    async rest() { return []; },
  };
  return api;
}
const T0 = Date.parse("2026-11-28T01:10:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const watch = (createdAt: number): CheckWatch => ({ id: "w1", agentId: "a1", workspaceId: "ws1", prKey: "example/app#375", url: "https://github.com/example/app/pull/375", createdAt: iso(createdAt), until: iso(createdAt + 3 * 3600_000), answering: false, runningHead: null });
const watched = (snapshot: WatchedPr["snapshot"]): WatchedPr => ({ key: "example/app#375", repo: "example/app", number: 375, error: null, snapshot });
const target = pr({ key: "example/app#375", repo: "example/app", number: 375, snapshot: null });

test("checks-belong-to-the-current-head: a new head with the old head's results keeps waiting (#375 shape)", async () => {
  const t = { now: T0 };
  const row: Row = { head: "h1aaaaaaaa", checksOn: "h1aaaaaaaa", status: "COMPLETED", conclusion: "SUCCESS" };
  const github = new Github(undefined, undefined, undefined, fakeGithub(row), () => t.now);
  const first = (await github.observe([target])).get(target.key)!.snapshot!;
  assert.equal(first.head, "h1aaaaaaaa"); assert.equal(first.checksRunning, false);

  // A new commit is pushed and the agent waits. GitHub answers with the new head and the old head's rollup.
  t.now += 60_000;
  const w = watch(t.now);
  t.now += 1_000;
  Object.assign(row, { head: "h2bbbbbbbb", checksOn: "h1aaaaaaaa" });
  const lagged = (await github.observe([target])).get(target.key)!.snapshot!;
  assert.equal(lagged.head, "h2bbbbbbbb");
  assert.equal(lagged.checksHead, "h1aaaaaaaa", "the snapshot says which commit its checks are for");
  assert.deepEqual(lagged.failedChecks, []);
  assert.equal(lagged.checksRunning, true, "results for another commit are not the head's: nothing has reported on h2 yet");
  assert.equal(lagged.checksPending, true);
  // Even long after the head changed, the watch never passes on another commit's results.
  for (const at of [t.now, t.now + 120_000, t.now + 600_000]) {
    const v = watchVerdict(w, watched(lagged), at, t.now - 300_000);
    assert.equal(v.fire, null, `no verdict at +${at - t.now} ms: ${v.fire?.text}`);
  }
  // A hand-built snapshot (an older worker's) that still carries the other commit's results decides nothing either.
  const stale = watchVerdict(w, watched({ ...lagged, checksRunning: false, checksPending: false }), t.now + 120_000, t.now - 300_000);
  assert.equal(stale.fire, null, `a snapshot whose checks are for another commit fires nothing: ${stale.fire?.text}`);

  // GitHub catches up: h2's run is in progress, then passes. Only then "passed on h2bbbbb".
  t.now += 15_000;
  Object.assign(row, { checksOn: "h2bbbbbbbb", status: "IN_PROGRESS", conclusion: null });
  const running = (await github.observe([target])).get(target.key)!.snapshot!;
  const r = watchVerdict(w, watched(running), t.now, null);
  assert.equal(r.fire, null); assert.equal(r.next.runningHead, "h2bbbbbbbb");
  t.now += 120_000;
  Object.assign(row, { status: "COMPLETED", conclusion: "SUCCESS" });
  const done = (await github.observe([target])).get(target.key)!.snapshot!;
  assert.equal(watchVerdict(r.next, watched(done), t.now, null).fire?.text, "Follow-up checks example/app#375: all checks passed on h2bbbbb.");
});

test("checks-belong-to-the-current-head: a failure on the old head is not reported as the new head's", async () => {
  const row: Row = { head: "h2bbbbbbbb", checksOn: "h1aaaaaaaa", status: "COMPLETED", conclusion: "FAILURE" };
  const t = { now: T0 };
  const github = new Github(undefined, undefined, undefined, fakeGithub(row), () => t.now);
  const w = watch(T0 - 1_000);
  const s = (await github.observe([target])).get(target.key)!.snapshot!;
  assert.deepEqual(s.failedChecks, [], "the failure belongs to h1");
  assert.equal(watchVerdict(w, watched(s), T0 + 1_000, T0 - 600_000).fire, null);
});

test("checks-belong-to-the-current-head: a read counts from when it was asked, not answered", async () => {
  // A background read sent before the agent pushed, answered after its wait began, carries the old head: it predates
  // the push, so it decides nothing (the #365 / #360 shape: "passed on" / "conflict on" the old head).
  const t = { now: T0 };
  const row: Row = { head: "h1aaaaaaaa", checksOn: "h1aaaaaaaa", status: "COMPLETED", conclusion: "SUCCESS" };
  let w: CheckWatch | null = null;
  const github = new Github(undefined, undefined, undefined, fakeGithub(row, { beforeAnswer: () => { t.now += 1_000; w = watch(t.now); t.now += 2_000; } }), () => t.now);
  const s = (await github.observe([target])).get(target.key)!.snapshot!;
  assert.equal(s.observedAt, iso(T0), "observedAt is when the query left");
  assert.equal(watchVerdict(w!, watched(s), t.now, T0 - 600_000).fire, null, "a read asked before the wait began decides nothing");
});

test("checks-belong-to-the-current-head: the probe sees the rollup's commit move", () => {
  const base = { updatedAt: "x", state: "OPEN", headRefOid: "h2", baseRefName: "main", reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } };
  const rollup = (oid: string) => ({ ...base, commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { checkRunCountsByState: [{ state: "SUCCESS", count: 1 }], statusContextCountsByState: [] } } } }] } });
  assert.notEqual(fingerprint(rollup("h1"))!.core, fingerprint(rollup("h2"))!.core, "a lagged rollup catching up is a change, even with the same counts");
  // Fixtures and hosts that don't return the rollup's commit keep the old behaviour (results are the head's).
  const snap = parsePr({ ...base, title: "t", url: "u", isDraft: false, mergeable: "MERGEABLE", reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: "verify", status: "COMPLETED", conclusion: "FAILURE" }] } } } }] } }, "main", iso(T0), ["verify"]);
  assert.deepEqual(snap.failedChecks, ["verify"]);
});
