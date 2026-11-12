import test from "node:test";
import assert from "node:assert/strict";
import { Github } from "../server/github";
import { httpApi, type GithubApi } from "../server/github-api";
import { clock, pr, snapshot } from "./fixtures";

/**
 * 2026-11-12 08:48-09:02, live 2.0.1-beta.0: tomgrin10's GraphQL budget (5000/h per user, shared with gh, Graphite and
 * every agent) ran out. GitHub answered HTTP 200 with `{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit"}]}`
 * and `x-ratelimit-remaining: 0`. Follow-up only knew the type "RATE_LIMITED", so every PR on that account turned
 * "GitHub status unavailable" ("Unknown" in the panel), merged ones included, and the worker kept asking each tick,
 * logging nothing. Invariant a-github-limit-never-blanks-a-known-pr.
 */
const RESET = Math.floor(clock / 1000) + 600;
const limited = () => new Response(JSON.stringify({ errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 1." }] }), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-used": "5000", "x-ratelimit-reset": String(RESET), "x-ratelimit-resource": "graphql" } });

test("a-github-limit-never-blanks-a-known-pr: GitHub's RATE_LIMIT answer is a rate limit, and the token rests until the reset", async () => {
  let calls = 0; const logs: string[] = []; let now = clock;
  const api = httpApi({ tokens: async owner => owner === "acme" ? "token-b" : "token-a", request: (async () => { calls++; return limited(); }) as typeof fetch, base: "https://github.test", now: () => now, log: line => logs.push(line) });
  await assert.rejects(api.graphql("example/app", "{x}", {}), (e: { rateLimited?: boolean; resetAt?: number }) => !!e.rateLimited && e.resetAt === RESET * 1000);
  assert.equal(calls, 1);
  assert.match(logs.join("\n"), /example\/app.*HTTP 200.*rate limit/i, "the failure is logged with the repo and status");
  // Same token (another owner on the same account): no request until the reset.
  await assert.rejects(api.graphql("example/other", "{x}", {}), (e: { rateLimited?: boolean }) => !!e.rateLimited);
  await assert.rejects(api.rest("example/app", "repos/example/app"), (e: { rateLimited?: boolean }) => !!e.rateLimited);
  assert.equal(calls, 1, "a resting token isn't used");
  // Another account's token is unaffected; after the reset the first one is used again.
  await assert.rejects(api.graphql("acme/site", "{x}", {}));
  assert.equal(calls, 2);
  now = RESET * 1000 + 1;
  await assert.rejects(api.graphql("example/app", "{x}", {}));
  assert.equal(calls, 3, "after the reset it asks again");
});

test("GitHub reads keep at most 4 requests in flight per token", async () => {
  let inFlight = 0, peak = 0;
  const api = httpApi({ tokens: async () => "token-a", base: "https://github.test", request: (async () => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--;
    return new Response("{}", { status: 200 });
  }) as typeof fetch });
  await Promise.all(Array.from({ length: 20 }, (_, i) => api.rest("example/app", `repos/example/app/pulls/${i}`)));
  assert.ok(peak <= 4, `peak ${peak}`);
});

test("a-github-limit-never-blanks-a-known-pr: a limited or failed read keeps every PR's last known status", async () => {
  for (const failure of ["limit", "error"] as const) {
    let graphql = 0;
    const api: GithubApi = {
      graphql: async () => { graphql++; if (failure === "limit") return { errors: [{ type: "RATE_LIMIT", message: "API rate limit already exceeded" }] }; throw Object.assign(new Error("GitHub HTTP 502"), { status: 502 }); },
      rest: async () => [],
    };
    const github = new Github(undefined, undefined, undefined, api, () => clock);
    // After a worker restart nothing is in memory: the last status is the stored snapshot.
    const open = pr({ key: "example/app#1", number: 1, snapshot: snapshot({ state: "OPEN", reviewDecision: "APPROVED" }) });
    const fresh = pr({ key: "example/app#3", number: 3, snapshot: null });
    const result = await github.observe([open, fresh]);
    assert.equal(graphql, 1, failure);
    assert.equal(result.get(open.key)!.error, null, `${failure}: a known PR keeps its status`);
    assert.equal(result.get(open.key)!.snapshot?.reviewDecision, "APPROVED", failure);
    assert.ok(result.get(fresh.key)!.error, `${failure}: a never-read PR says why it has none`);
    if (failure === "limit") assert.match(result.get(fresh.key)!.error!, /limit/i);
  }
});

test("a merged PR whose status is known is never read again", async () => {
  let graphql = 0;
  const api: GithubApi = { graphql: async () => { graphql++; return { data: { repository: null } }; }, rest: async () => [] };
  const github = new Github(undefined, undefined, undefined, api, () => clock);
  const merged = pr({ key: "example/app#2", number: 2, snapshot: snapshot({ state: "MERGED" }) });
  const result = await github.observe([merged]);
  assert.equal(graphql, 0, "no query for a merged PR, even on a cold start");
  assert.equal(result.get(merged.key)!.snapshot?.state, "MERGED");
  assert.equal(result.get(merged.key)!.error, null);
  await github.observe([merged], { background: true, fresh: new Set([merged.key]) });
  assert.equal(graphql, 1, "the developer's Refresh of its workspace still reads it");
});
