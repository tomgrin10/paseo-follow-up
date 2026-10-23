import test from "node:test";
import assert from "node:assert/strict";
import { parsePr, Github, ghEnvironment } from "../server/github";
import { pr } from "./fixtures";
import { Graphite } from "../server/graphite";
const data = () => ({ title: "Test PR", url: "https://github.com/example/app/pull/1", state: "OPEN", headRefOid: "head", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", reviewThreads: { nodes: [{ id: "thread", isResolved: false, comments: { nodes: [{ updatedAt: "yesterday" }] } }], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: "required", status: "COMPLETED", conclusion: "FAILURE" }, { name: "optional", status: "COMPLETED", conclusion: "FAILURE" }] } } } }] } });
test("only required failed checks trigger repairs; approval does not erase threads", () => {
  const s = parsePr(data(), "main", new Date().toISOString(), ["required"]); assert.deepEqual(s.failedChecks, ["required"]); assert.equal(s.threads.length, 1); assert.equal(s.reviewDecision, "APPROVED");
});
test("unknown mergeability and truncated connections are incomplete", () => {
  const d = data(); d.mergeable = "UNKNOWN"; assert.equal(parsePr(d, "main", "today", []).complete, false); d.mergeable = "MERGEABLE"; d.reviewThreads.pageInfo.hasNextPage = true; assert.equal(parsePr(d, "main", "today", []).complete, false);
});
test("multiple PRs are fetched in a single repository query", async () => {
  const calls: string[][] = [];
  const github = new Github(async args => { calls.push(args); if (args[1] === "graphql") return JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, p0: data(), p1: data() } } }); return "[]"; });
  const observed = await github.observe([pr(), pr({ key: "example/app#2", number: 2 })]); assert.equal(observed.size, 2); assert.equal(calls.filter(c => c[1] === "graphql").length, 1); assert.equal(calls.filter(c => c[1] !== "graphql").length, 1); assert.match(calls.find(c => c[1] === "graphql")!.join(" "), /mergedAt/);
});
test("each GitHub request carries its repository without changing shared credentials", async () => {
  const parent = { GH_REPO: "personal/project", GH_TOKEN: "explicit-test-token", PATH: "/example/bin" };
  assert.deepEqual(ghEnvironment("example/app", parent), { ...parent, GH_REPO: "example/app" });
  assert.equal(parent.GH_REPO, "personal/project");
  const scopes: string[] = [];
  const github = new Github(async (args, repo) => { scopes.push(repo); return args[1] === "graphql" ? JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, p0: data() } } }) : "[]"; });
  await github.observe([pr(), pr({ repo: "another/project", key: "another/project#1" })]);
  assert.deepEqual(scopes, ["example/app", "example/app", "another/project", "another/project"]);
});

test("Graphite scheduling stays separate from GitHub approval and lookup failures", async () => {
  let fail = false;
  const github = new Github(async args => args[1] === "graphql" ? JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, p0: data() } } }) : "[]", new Graphite(async () => {
    if (fail) throw new Error("Graphite unavailable");
    return { mergeabilityStatuses: [{ prNumber: 1, mergeabilityStatus: "WAITING_TO_MERGE" }] };
  }, () => fail ? 30_000 : 0));
  let observed = (await github.observe([pr()])).get("example/app#1")!;
  assert.equal(observed.snapshot?.mergeWhenReady, "on");
  fail = true; observed = (await github.observe([pr()])).get("example/app#1")!;
  assert.equal(observed.snapshot?.mergeWhenReady, "unknown");
  assert.equal(observed.error, null); assert.equal(observed.snapshot?.reviewDecision, "APPROVED"); assert.equal(observed.snapshot?.complete, true);
});

test("merge event timestamps are retained separately from observation time", () => {
  const value = { ...data(), state: "MERGED", mergedAt: "2026-01-01T10:00:00Z" };
  assert.equal(parsePr(value, "main", "2026-01-15T10:00:00Z", []).mergedAt, value.mergedAt);
  assert.equal(parsePr(data(), "main", "2026-01-15T10:00:00Z", []).mergedAt, null);
});
