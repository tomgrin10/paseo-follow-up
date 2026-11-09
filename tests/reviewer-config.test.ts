import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { Github } from "../server/github";
import { ReviewerConfigStore, ReviewerSuggestions, seedFromHistory } from "../server/reviewer-config";
import { allAssigned, configuredReviewers, emptyReviewerConfig, resolveReviewers, reviewerConfig, reviewerEntrySchema, setReviewerConfig, splitReviewers, withoutAuthor, type ReviewerConfig } from "../shared/reviewers";
import { needsYou } from "../shared/attention";
import { pickBrief } from "../shared/brief";
import { snapshot, pr, workspace, clock } from "./fixtures";
import type { State, Workspace } from "../shared/model";
type PrAction = Workspace["prActions"][number];

const tmp = async (t: TestContext) => { const d = await mkdtemp(join(tmpdir(), "follow-reviewer-config-")); t.after(() => rm(d, { recursive: true, force: true })); return d; };
const cfg = (patch: Partial<ReviewerConfig> = {}): ReviewerConfig => ({ ...emptyReviewerConfig(), ...patch });
const people = (...logins: string[]) => logins.map(login => ({ login, name: null }));
const open = () => ({ author: "author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true });
const asked = (prs: string[], reviewers: string[], createdAt = new Date(clock).toISOString(), state: PrAction["state"] = "submitted"): PrAction =>
  ({ id: `a-${prs[0]}-${createdAt}`, kind: "request_reviewers", reviewers, prs, heads: {}, createdAt, state, result: "" } as PrAction);

test("resolution: the repository's list, else the default for all repos, else nobody; repo keys ignore case", () => {
  const config = cfg({ repos: { "acme/api": people("ana") }, defaults: people("dev-lead", "acme/platform") });
  assert.deepEqual(resolveReviewers(config, "Acme/API"), { reviewers: people("ana"), source: "repo" });
  assert.deepEqual(resolveReviewers(config, "acme/web"), { reviewers: people("dev-lead", "acme/platform"), source: "default" });
  assert.deepEqual(resolveReviewers(cfg(), "acme/web"), { reviewers: [], source: "none" });
  assert.deepEqual(resolveReviewers(cfg({ repos: { "acme/api": [] }, defaults: people("dev-lead") }), "acme/api").source, "default", "an emptied list falls back");
});

test("logins: users and org/team slugs are accepted; anything else is refused", () => {
  for (const login of ["octocat", "a-b", "acme/platform-team", "acme/team.v2"]) assert.equal(reviewerEntrySchema.safeParse({ login }).success, true, login);
  for (const login of ["", "-bad", "bad-", "a/b/c", "has space", "x;rm", "@octocat"]) assert.equal(reviewerEntrySchema.safeParse({ login }).success, false, login);
});

test("author exclusion drops only the author (any case); a team is never the author", () => {
  assert.deepEqual(withoutAuthor(people("Author", "ana", "acme/author"), "author").map(r => r.login), ["ana", "acme/author"]);
  assert.deepEqual(withoutAuthor(people("ana"), null).map(r => r.login), ["ana"]);
});

test("team vs user: GitHub gets reviewers[] for people and team_reviewers[] by slug; a team counts as assigned by its slug", async () => {
  assert.deepEqual(splitReviewers(["ana", "acme/platform", "bo"]), { users: ["ana", "bo"], teams: ["platform"] });
  const calls: string[][] = [];
  await new Github(async args => { calls.push(args); return "{}"; }).requestReviewers(pr(), ["ana", "acme/platform"]);
  assert.deepEqual(calls, [["api", "--method", "POST", "repos/example/app/pulls/1/requested_reviewers", "-f", "reviewers[]=ana", "-f", "team_reviewers[]=platform"]]);
  await assert.rejects(new Github(async () => "{}").requestReviewers(pr(), ["acme/a/b"]), /No eligible reviewers/);
  assert.equal(allAssigned(["ana", "acme/platform"], { requested: ["ANA"], teams: ["platform"], reviewed: [] }), true);
  assert.equal(allAssigned(["acme/platform"], { requested: [], teams: [], reviewed: [] }), false);
});

async function actionsFixture(t: TestContext, reviewersFor: () => { login: string; name: string | null }[], author = "author") {
  const store = new Store(await tmp(t));
  let current = snapshot({ reviewers: { ...open(), author } });
  await store.mutate(s => { s.workspaces = [workspace({ prs: [pr({ snapshot: current })] })]; });
  const writes: string[][] = [];
  const github = { observe: async () => new Map([["example/app#1", { snapshot: structuredClone(current), error: null }]]),
    requestReviewers: async (_: unknown, logins: string[]) => { writes.push(logins); const { users, teams } = splitReviewers(logins); current = { ...current, reviewers: { ...current.reviewers!, requested: users, teams } }; } };
  const actions = new PrActions(store, github, { merge: async () => { throw Error("Unexpected merge"); }, invalidate() {} }, new BrowserBridge(), () => clock, reviewersFor);
  t.after(() => actions.close());
  return { actions, writes };
}

test("Add reviewers asks the saved people and teams, minus the author, and says who by name", async t => {
  const f = await actionsFixture(t, () => [{ login: "ana", name: "Ana" }, { login: "author", name: "Me" }, { login: "acme/platform", name: "Platform" }]);
  const result = await f.actions.requestReviewers("workspace", "example/app#1");
  assert.deepEqual(f.writes, [["ana", "acme/platform"]]);
  assert.equal(result.state, "submitted"); assert.equal(result.result, "Requested Ana and Platform.");
});

test("with nobody configured the button doesn't error about defaults; the picker's explicit choice still works and keeps saved names", async t => {
  const none = await actionsFixture(t, () => []);
  await assert.rejects(none.actions.requestReviewers("workspace", "example/app#1"), /No reviewers set for example\/app\. Pick who to ask/);
  assert.equal(none.writes.length, 0);
  const picked = await actionsFixture(t, () => [{ login: "ana", name: "Ana" }]);
  const result = await picked.actions.requestReviewers("workspace", "example/app#1", ["ana", "bo"]);
  assert.deepEqual(picked.writes, [["ana", "bo"]]); assert.equal(result.result, "Requested Ana and bo.");
  const self = await actionsFixture(t, () => [], "bo");
  await assert.rejects(self.actions.requestReviewers("workspace", "example/app#1", ["bo"]), /Only the PR author/);
});

test("the picker's Remember saves a repository list in reviewers.json (owner-only), separate from state.json, and updates what Needs you reads", async t => {
  const dir = await tmp(t);
  const reviewers = new ReviewerConfigStore(dir);
  setReviewerConfig(emptyReviewerConfig());
  const w = workspace({ prs: [pr({ snapshot: snapshot({ reviewers: open() }) })] });
  assert.equal(needsYou(w).some(i => i.kind === "reviewers"), false, "nothing configured: no Needs-you row");
  await reviewers.save("Example/App", [{ login: "ana", name: "Ana" }, { login: "ana", name: "dup" }, { login: "acme/platform", name: null }]);
  const saved = JSON.parse(await readFile(join(dir, "reviewers.json"), "utf8"));
  assert.deepEqual(saved.repos, { "example/app": [{ login: "ana", name: "Ana" }, { login: "acme/platform", name: null }] }, "one entry per login, keyed by lower-case repo");
  assert.equal((await stat(join(dir, "reviewers.json"))).mode & 0o777, 0o600);
  assert.deepEqual(configuredReviewers("example/app").map(r => r.login), ["ana", "acme/platform"]);
  assert.equal(needsYou(w).some(i => i.kind === "reviewers"), true);
  await reviewers.save("example/app", []);
  assert.deepEqual(reviewerConfig().repos, {}, "an emptied list is removed");
  await reviewers.save(null, people("lead"));
  assert.deepEqual(configuredReviewers("other/repo").map(r => r.login), ["lead"]);
  // A second store over the same folder reads what was written.
  assert.deepEqual((await new ReviewerConfigStore(dir).read()).defaults.map(r => r.login), ["lead"]);
  setReviewerConfig(emptyReviewerConfig());
});

test("an unreadable reviewers.json is reported, never silently replaced", async t => {
  const dir = await tmp(t);
  await writeFile(join(dir, "reviewers.json"), "{not json");
  await assert.rejects(new ReviewerConfigStore(dir).read(), /reviewers\.json/);
  assert.equal(await readFile(join(dir, "reviewers.json"), "utf8"), "{not json");
});

test("migration: an install that requested reviewers keeps them (latest submitted request per repo, legacy names); it runs once and never overwrites", async t => {
  const state: State = { version: 1, workspaces: [
    workspace({ id: "w1", prActions: [
      asked(["acme/acme-poc#1362"], ["reviewer-a", "reviewer-b"], "2026-10-01T00:00:00.000Z"),
      asked(["acme/acme-poc#1400"], ["someone-else"], "2026-09-01T00:00:00.000Z"),
      asked(["acme/acme-poc#1401"], ["failed-person"], "2026-11-01T00:00:00.000Z", "failed"),
    ] }),
    workspace({ id: "w2", prActions: [asked(["acme/api#7"], ["ana", "acme/platform"])] }),
  ] } as State;
  assert.deepEqual(seedFromHistory(state), {
    "acme/acme-poc": [{ login: "reviewer-a", name: "Uri" }, { login: "reviewer-b", name: "Yuval" }],
    "acme/api": [{ login: "ana", name: null }, { login: "acme/platform", name: null }],
  });
  const dir = await tmp(t);
  const store = new ReviewerConfigStore(dir);
  await store.save("acme/api", people("kept"));
  const migrated = await store.migrate(state, new Date(clock));
  assert.deepEqual(migrated.repos["acme/api"], people("kept"), "a list the developer already set wins");
  assert.deepEqual(migrated.repos["acme/acme-poc"].map(r => r.name), ["Uri", "Yuval"]);
  assert.ok(migrated.migratedAt);
  await store.save("acme/acme-poc", []);
  assert.equal((await store.migrate(state)).repos["acme/acme-poc"], undefined, "a second start doesn't seed again");
  setReviewerConfig(emptyReviewerConfig());
});

test("migration: a fresh install, or one that never requested reviewers, starts empty", async t => {
  const fresh = await new ReviewerConfigStore(await tmp(t)).migrate({ version: 1, workspaces: [workspace({ prs: [pr({ repo: "acme/acme-poc", key: "acme/acme-poc#1" })] })] } as State);
  assert.deepEqual(fresh.repos, {}); assert.deepEqual(fresh.defaults, []); assert.ok(fresh.migratedAt);
  setReviewerConfig(emptyReviewerConfig());
});

test("suggestions: collaborators and teams read on demand, cached, bounded; a failure is graceful and retried later", async () => {
  let now = 0; const calls: string[] = []; let fail = false;
  const s = new ReviewerSuggestions(async args => {
    calls.push(args[1]); if (fail) throw new Error("HTTP 403");
    return args[1].includes("/teams") ? JSON.stringify([{ slug: "platform", name: "Platform" }]) : JSON.stringify([{ login: "ana", type: "User" }, { login: "ci-bot", type: "Bot" }]);
  }, () => now);
  assert.deepEqual(await s.suggest("acme/api"), { suggestions: [{ login: "ana", name: null, kind: "user" }, { login: "acme/platform", name: "Platform", kind: "team" }], error: null });
  await s.suggest("ACME/api"); assert.equal(calls.length, 2, "cached per repository");
  now += 601_000; await s.suggest("acme/api"); assert.equal(calls.length, 4, "the cache expires");
  fail = true; const failed = await s.suggest("acme/web");
  assert.deepEqual(failed.suggestions, []); assert.match(failed.error!, /Type a login/);
  for (let i = 0; i < 30; i++) await s.suggest(`acme/r${i}`);
  assert.ok((s as unknown as { cache: Map<string, unknown> }).cache.size <= 20);
});

test("briefs name the configured reviewers, or say none are set and that Add reviewers lets you pick", () => {
  const named = pickBrief({ reviewers: { prKey: "acme/api#7", repo: "acme/api", number: 7, url: null, names: ["Ana", "Platform"] } });
  assert.equal(named.ask, "Add reviewers to #7: Ana and Platform");
  const none = pickBrief({ reviewers: { prKey: "acme/api#7", repo: "acme/api", number: 7, url: null, names: [] } });
  assert.equal(none.sourceLine, "No reviewers set for acme/api; Add reviewers lets you pick.");
  assert.deepEqual(none.moves.map(m => m.kind), ["add_reviewers"], "the button opens the picker rather than sending anyone to GitHub");
});
