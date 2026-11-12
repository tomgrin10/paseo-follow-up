// The fixture `gh` behind scripts/fake-github.mjs for the realistic scale check: every PR a query names comes back with
// a live-sized body (reviews, review threads, ~25 checks, the base ref's open PRs), so a cold start reads all ~420 PRs
// the way the live worker does. Writes are refused; REST (branch rules) answers []. Synthetic data only.
export const scaleGh = () => `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] !== "api" || a[1] !== "graphql") { console.log("[]"); process.exit(0); }
const query = (a.find(x => x.startsWith("query=")) || "").slice(6);
const sha = n => Array.from({ length: 40 }, (_, k) => "0123456789abcdef"[(n * 31 + k * 17) % 16]).join("");
const checks = n => Array.from({ length: 25 }, (_, k) => k % 6 === 5 ? { context: "deploy/preview-" + k, state: "SUCCESS" } : { name: "ci / job " + k + " (node 22, shard " + (k % 4) + ")", status: "COMPLETED", conclusion: n % 5 === 0 && k === 2 ? "FAILURE" : "SUCCESS" });
const node = n => ({
  number: n, title: "Synthetic change " + n + ": retry backoff for the billing ledger reconcile job", url: "https://github.com/" + process.env.GH_REPO + "/pull/" + n,
  state: n % 9 === 0 ? "MERGED" : "OPEN", headRefOid: sha(n), headRefName: "feat/synthetic-" + n, baseRefName: n % 3 === 0 ? "main" : "feat/synthetic-" + (n - 1),
  isDraft: false, mergeable: n % 7 === 0 ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: n % 7 === 0 ? "DIRTY" : "BLOCKED", reviewDecision: n % 2 ? "APPROVED" : "REVIEW_REQUIRED",
  mergedAt: n % 9 === 0 ? "2026-11-10T10:00:00Z" : null, mergeCommit: n % 9 === 0 ? { oid: sha(n + 1) } : null, isInMergeQueue: false, autoMergeRequest: null,
  author: { login: "fixture-dev" },
  reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [{ requestedReviewer: { __typename: "User", login: "reviewer-one" } }, { requestedReviewer: { __typename: "Team", slug: "platform" } }] },
  latestReviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "APPROVED", author: { __typename: "User", login: "reviewer-two" } }, { state: "COMMENTED", author: { __typename: "User", login: "reviewer-three" } }] },
  baseRef: { branchProtectionRule: { requiredStatusCheckContexts: ["ci / job 0 (node 22, shard 0)", "ci / job 1 (node 22, shard 1)"] }, rules: { pageInfo: { hasNextPage: false }, nodes: [] },
    associatedPullRequests: { nodes: Array.from({ length: 20 }, (_, k) => ({ number: n - k - 1, headRefName: "feat/synthetic-" + (n - k - 1), state: "OPEN", headRepository: { nameWithOwner: process.env.GH_REPO } })) } },
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: 6 }, (_, k) => ({ id: "PRRT_" + sha(n * 10 + k).slice(0, 20), isResolved: k > 1, comments: { nodes: [{ updatedAt: "2026-11-12T0" + k + ":00:00Z" }] } })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: checks(n) } } } }] },
});
const repository = { defaultBranchRef: { name: "main", branchProtectionRule: { requiredStatusCheckContexts: ["ci / job 0 (node 22, shard 0)"] }, rules: { pageInfo: { hasNextPage: false }, nodes: [] } },
  squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH", mergeQueue: null };
for (const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)) repository[m[1]] = node(Number(m[2]));
console.log(JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4900, resetAt: new Date(Date.now() + 3600e3).toISOString() }, repository } }));
`;
