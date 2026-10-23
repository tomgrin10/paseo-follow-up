import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { Github, parsePr, ReviewRequestError } from "../server/github";
import { noReviewers, defaultReviewers } from "../shared/reviewers";
import { snapshot, pr, workspace, clock } from "./fixtures";
import type { Snapshot } from "../shared/model";

const reviewers = () => ({ author: "author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "follow-reviewers-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  let current = snapshot({ reviewers: reviewers() }); let now = clock;
  await store.mutate(s => { s.workspaces = [workspace({ prs: [pr({ snapshot: current })] })]; });
  const writes: string[][] = []; let fail: Error | null = null;
  const github = { observe: async () => new Map([["example/app#1", { snapshot: structuredClone(current), error: null }]]), requestReviewers: async (_: unknown, logins: string[]) => { writes.push(logins); if (fail) throw fail; current.reviewers!.requested = logins; } };
  const actions = new PrActions(store, github, { merge: async () => { throw Error("Unexpected merge"); }, invalidate() {} }, new BrowserBridge(), () => now, () => [{ name: "First", login: "reviewer-a" }, { name: "Second", login: "reviewer-b" }]);
  t.after(() => actions.close());
  return { store, actions, writes, get: async () => (await store.snapshot()).workspaces[0], set: (patch: Partial<Snapshot>) => { current = { ...current, ...patch }; }, fail: (error: Error | null) => { fail = error; }, advance: () => { now += 31_000; } };
}
test("reviewer absence requires complete open PR data and counts human/team requests and completed reviews", () => {
  const p = pr({ snapshot: snapshot({ reviewers: reviewers() }) }); assert.equal(noReviewers(p), true);
  for (const patch of [{ requested: ["human"] }, { teams: ["team"] }, { reviewed: ["human"] }, { complete: false }]) { p.snapshot!.reviewers = { ...reviewers(), ...patch }; assert.equal(noReviewers(p), false); }
  for (const patch of [{ reviewers: undefined }, { reviewDecision: "APPROVED", reviewers: { ...reviewers(), reviewed: ["human"] } }, { state: "MERGED" as const }, { complete: false }]) assert.equal(noReviewers(pr({ snapshot: snapshot({ reviewers: reviewers(), ...patch }) })), false);
  assert.equal(noReviewers(pr({ snapshot: snapshot({ reviewers: reviewers(), reviewDecision: "APPROVED" }) })), true, "a bot-only approval is not a human reviewer");
  assert.deepEqual(defaultReviewers("example/app"), []);
});
test("GitHub bot/self/dismissed reviews do not hide missing human reviewers; unknown and truncated requests stay unknown", () => {
  const data: any = { title: "Test", url: "fixture", state: "OPEN", headRefOid: "head", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", author: { login: "author" }, reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "COMMENTED", author: { __typename: "Bot", login: "review-bot" } }, { state: "COMMENTED", author: { __typename: "User", login: "author" } }, { state: "DISMISSED", author: { __typename: "User", login: "dismissed" } }] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [] } };
  assert.equal(noReviewers(pr({ snapshot: parsePr(data, "main", "now", []) })), true);
  data.reviewRequests.nodes = [{ requestedReviewer: { __typename: "Team", slug: "reviewers" } }]; assert.equal(noReviewers(pr({ snapshot: parsePr(data, "main", "now", []) })), false);
  data.reviewRequests.nodes = [{ requestedReviewer: null }]; assert.equal(parsePr(data, "main", "now", []).reviewers!.complete, false);
  data.reviewRequests.nodes = []; data.latestReviews.pageInfo.hasNextPage = true; assert.equal(parsePr(data, "main", "now", []).reviewers!.complete, false);
});
test("one explicit request adds configured reviewers, preserves tracking and does not merge or enable Auto", async t => {
  const f = await fixture(t); const result = await f.actions.requestReviewers("workspace", "example/app#1");
  assert.equal(result.state, "submitted"); assert.deepEqual(f.writes, [["reviewer-a", "reviewer-b"]]);
  const w = await f.get(); assert.equal(w.mainAgentId, "main-agent"); assert.equal(w.enable_auto_sends, false); assert.equal(w.completion, null); assert.equal(w.prActions[0].kind, "request_reviewers"); assert.equal(noReviewers(w.prs[0]), false);
  await f.actions.requestReviewers("workspace", "example/app#1"); assert.equal(f.writes.length, 1, "fresh existing requests prevent repeat notifications");
});
test("the author is excluded and fresh review/PR eligibility changes skip or reject the write", async t => {
  const f = await fixture(t); f.set({ reviewers: { ...reviewers(), author: "reviewer-a" } });
  await f.actions.requestReviewers("workspace", "example/app#1"); assert.deepEqual(f.writes, [["reviewer-b"]]);
  f.set({ reviewers: { ...reviewers(), teams: ["other-team"] } }); await f.actions.requestReviewers("workspace", "example/app#1"); assert.equal(f.writes.length, 1);
  for (const patch of [{ draft: true }, { state: "CLOSED" as const }, { reviewers: { ...reviewers(), complete: false } }]) { f.set({ draft: false, state: "OPEN", reviewers: reviewers(), ...patch }); await assert.rejects(f.actions.requestReviewers("workspace", "example/app#1")); }
  await assert.rejects(f.actions.requestReviewers("workspace", "example/app#2"), /outside/); assert.equal(f.writes.length, 1);
});
test("uncertain requests remain durable and checking state never resends notifications", async t => {
  const f = await fixture(t); f.fail(new ReviewRequestError("Timeout", true));
  assert.equal((await f.actions.requestReviewers("workspace", "example/app#1")).state, "uncertain");
  const id = (await f.get()).prActions[0].id;
  await assert.rejects(f.actions.requestReviewers("workspace", "example/app#1"), /previous PR action/);
  assert.equal((await f.actions.check("workspace", id)).state, "uncertain");
  f.advance(); assert.equal((await f.actions.check("workspace", id)).state, "failed"); assert.equal(f.writes.length, 1);
  f.fail(null); assert.equal((await f.actions.requestReviewers("workspace", "example/app#1")).state, "submitted"); assert.equal(f.writes.length, 2);
});
test("confirmed permission/validation failures are actionable and require a new click", async t => {
  const f = await fixture(t); f.fail(new ReviewRequestError("Write access required", false));
  assert.equal((await f.actions.requestReviewers("workspace", "example/app#1")).state, "failed"); assert.equal((await f.get()).prActions[0].state, "failed"); assert.equal(f.writes.length, 1);
});
test("GitHub review writes use repository-scoped argv and distinguish rejected from ambiguous responses", async () => {
  const calls: { args: string[]; repo: string }[] = [];
  const github = new Github(async (args, repo) => { calls.push({ args, repo }); return "{}"; });
  await github.requestReviewers(pr(), ["reviewer-a", "reviewer-b"]);
  assert.deepEqual(calls, [{ repo: "example/app", args: ["api", "--method", "POST", "repos/example/app/pulls/1/requested_reviewers", "-f", "reviewers[]=reviewer-a", "-f", "reviewers[]=reviewer-b"] }]);
  const denied = new Github(async () => { throw Object.assign(new Error("Denied"), { stderr: "HTTP 403" }); });
  await assert.rejects(denied.requestReviewers(pr(), ["reviewer-a"]), error => error instanceof ReviewRequestError && !error.uncertain);
  const timeout = new Github(async () => { throw Error("timeout"); }); await assert.rejects(timeout.requestReviewers(pr(), ["reviewer-a"]), error => error instanceof ReviewRequestError && error.uncertain);
});
