import test from "node:test";
import assert from "node:assert/strict";
import { Github, RULES_TTL_MS } from "../server/github";
import { accountFor, ghTokens, httpApi, DEAD_BUS, type GithubApi } from "../server/github-api";
import { Deployments } from "../server/deployments";
import { POLL_IDLE_MS, TICK_MS, RECENT_CHANGE_MS } from "../shared/poll";
import { clock, pr } from "./fixtures";

// 2026-11-11 cpu-load REPORT.md §5: the live worker made ~40 gh calls/min (+6 gcloud) for ~30 PRs. Root causes:
// ruleset checks were one REST call per base branch per minute (every stacked PR's base is a different branch), every
// read spawned the gh wrapper (~3 processes), settled PRs were re-read every 15 s tick, and the deploy probe described
// every serving revision each minute. These tests pin the cost per tick so it can't creep back.

type Row = { checksPending?: boolean; queued?: boolean; autoMerge?: boolean; state?: string; base?: string; rules?: "ok" | "error" | "truncated"; missing?: boolean; updated?: number };
function fakeGithub(rows: Map<string, Row>) {
  const calls = { graphql: 0, rest: 0, restPaths: [] as string[], perRepo: new Map<string, number>() };
  const ruleNodes = { pageInfo: { hasNextPage: false }, nodes: [{ type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { enforcement: "ACTIVE" }, parameters: { requiredStatusChecks: [{ context: "ci" }] } }, { type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { enforcement: "EVALUATE" }, parameters: { requiredStatusChecks: [{ context: "trial" }] } }] };
  const api: GithubApi = {
    async graphql(repo, query) {
      calls.graphql++; calls.perRepo.set(repo, (calls.perRepo.get(repo) ?? 0) + 1);
      const repository: Record<string, unknown> = { defaultBranchRef: { name: "main", branchProtectionRule: null, rules: ruleNodes } };
      const errors: unknown[] = [];
      for (const [, alias, number] of query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
        const row = rows.get(`${repo}#${number}`) ?? {};
        if (row.missing) { repository[alias] = null; errors.push({ type: "NOT_FOUND", path: ["repository", alias] }); continue; }
        const base = row.base ?? "main";
        if (row.rules === "error") errors.push({ type: "FORBIDDEN", path: ["repository", alias, "baseRef", "rules", "nodes", 0, "repositoryRuleset"] });
        repository[alias] = {
          number: Number(number), title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, state: row.state ?? "OPEN", headRefOid: `head-${row.updated ?? 0}`, headRefName: `b${number}`, baseRefName: base,
          isDraft: false, isInMergeQueue: !!row.queued, autoMergeRequest: row.autoMerge ? { enabledAt: "now" } : null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", author: { login: "dev" },
          reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
          baseRef: { branchProtectionRule: null, rules: row.rules === "truncated" ? { ...ruleNodes, pageInfo: { hasNextPage: true } } : row.rules === "error" ? null : ruleNodes, associatedPullRequests: { nodes: base === "main" ? [] : [{ number: Number(number) - 1, headRefName: base, state: "OPEN", headRepository: { nameWithOwner: repo } }] } },
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: "ci", status: row.checksPending ? "IN_PROGRESS" : "COMPLETED", conclusion: row.checksPending ? null : "SUCCESS" }] } } } }] },
        };
      }
      return { data: { repository }, ...(errors.length ? { errors } : {}) };
    },
    async rest(_repo, path) { calls.rest++; calls.restPaths.push(path); return [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]; },
  };
  return { api, calls };
}
/** N PRs spread over M repositories, each one stacked on the previous PR's branch (distinct base branches). */
function fleet(n: number, m: number, patch: (i: number) => Row = () => ({})) {
  const rows = new Map<string, Row>(); const prs = [];
  for (let i = 0; i < n; i++) {
    const repo = `org${i % m}/repo${i % m}`; const number = i + 1;
    rows.set(`${repo}#${number}`, { base: i < m ? "main" : `b${number - 1}`, ...patch(i) });
    prs.push(pr({ key: `${repo}#${number}`, repo, number }));
  }
  return { rows, prs };
}

test("one aliased GraphQL query per repository per tick (chunked at 15), and no per-branch REST rule calls", async () => {
  const { rows, prs } = fleet(30, 3);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => clock);
  const observed = await github.observe(prs);
  assert.equal(observed.size, 30);
  assert.ok([...observed.values()].every(o => o.error === null && o.snapshot));
  assert.equal(f.calls.graphql, 3, "10 PRs in each of 3 repositories: one query each");
  assert.equal(f.calls.rest, 0, "ruleset checks ride the batched query (Ref.rules)");
  // Only ACTIVE rulesets count, like REST rules/branches.
  assert.deepEqual(observed.get(prs[0].key)!.snapshot!.failedChecks, []);
  const big = fleet(40, 1); const g = fakeGithub(big.rows);
  await new Github(undefined, undefined, undefined, g.api, () => clock).observe(big.prs);
  assert.equal(g.calls.graphql, 3, "40 PRs in one repository: ceil(40 / 15) queries");
});

test("settled repositories back off to one read per POLL_IDLE_MS; a minute of ticks costs a fraction of before", async () => {
  let now = clock;
  const { rows, prs } = fleet(30, 3);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  // Settle: the first reads count as a change, which keeps every-tick reads for RECENT_CHANGE_MS.
  await github.observe(prs, { background: true });
  now += RECENT_CHANGE_MS;
  await github.observe(prs, { background: true });
  f.calls.graphql = 0;
  const ticks = Math.round(10 * 60_000 / TICK_MS);
  for (let i = 0; i < ticks; i++) { now += TICK_MS; const o = await github.observe(prs, { background: true }); assert.equal(o.size, 30); }
  // Before: 3 queries + 27 branch-rule REST calls every minute at least. After: 3 queries per POLL_IDLE_MS.
  assert.equal(f.calls.graphql, 3 * Math.floor(10 * 60_000 / POLL_IDLE_MS));
  assert.equal(f.calls.rest, 0);
  // A backed-off tick still answers with the last observation, never older than the completion gate allows.
  const sample = (await github.observe(prs, { background: true })).get(prs[0].key)!.snapshot!;
  assert.ok(now - Date.parse(sample.observedAt) <= POLL_IDLE_MS + TICK_MS);
});

test("a PR with pending checks is never backed off (finishing checks don't bump updatedAt)", async () => {
  let now = clock;
  const { rows, prs } = fleet(30, 3, i => (i === 4 ? { checksPending: true } : {}));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  await github.observe(prs, { background: true }); now += RECENT_CHANGE_MS; await github.observe(prs, { background: true });
  const pendingRepo = prs[4].repo;
  f.calls.perRepo.clear();
  for (let i = 0; i < 8; i++) { now += TICK_MS; await github.observe(prs, { background: true }); }
  assert.equal(f.calls.perRepo.get(pendingRepo), 8, "the repository with pending checks is read every tick");
  for (const [repo, count] of f.calls.perRepo) if (repo !== pendingRepo) assert.ok(count <= 2, `${repo} backed off`);
  // The checks finish: seen on the very next tick.
  rows.get(prs[4].key)!.checksPending = false;
  now += TICK_MS;
  assert.equal((await github.observe(prs, { background: true })).get(prs[4].key)!.snapshot!.checksPending, false);
});

test("merge queue, merge when ready, busy workspaces and fresh requests all read on this tick", async () => {
  let now = clock;
  const { rows, prs } = fleet(2, 1);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  await github.observe(prs, { background: true }); now += RECENT_CHANGE_MS; await github.observe(prs, { background: true });
  const read = async (o: Parameters<Github["observe"]>[1]) => { const before = f.calls.graphql; now += TICK_MS; await github.observe(prs, o); return f.calls.graphql - before; };
  assert.equal(await read({ background: true }), 0, "settled: backed off");
  assert.equal(await read({ background: true, hot: new Set([prs[1].key]) }), 1, "a busy workspace's PR");
  assert.equal(await read({ background: true, fresh: new Set([prs[0].key]) }), 1, "the developer opened or refreshed its workspace");
  assert.equal(await read({}), 1, "no options (actions, Done declarations): always fresh");
  // A PR in a merge queue: every tick from the read that sees it there.
  rows.get(prs[0].key)!.queued = true; assert.equal(await read({}), 1);
  for (let i = 0; i < 3; i++) assert.equal(await read({ background: true }), 1, "queued: every tick");
  now += RECENT_CHANGE_MS; assert.equal(await read({ background: true }), 1, "still queued long after its last change");
  rows.get(prs[0].key)!.queued = false; rows.get(prs[0].key)!.autoMerge = true;
  const other = new Github(undefined, undefined, undefined, f.api, () => now); other.workflow = async () => "github";
  await other.observe(prs); now += RECENT_CHANGE_MS; await other.observe(prs, { background: true });
  const before = f.calls.graphql; now += TICK_MS; await other.observe(prs, { background: true });
  assert.equal(f.calls.graphql - before, 1, "GitHub auto-merge on: every tick");
});

test("a changed PR keeps the every-tick cadence for RECENT_CHANGE_MS, then backs off", async () => {
  let now = clock;
  const { rows, prs } = fleet(1, 1);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  await github.observe(prs, { background: true }); now += RECENT_CHANGE_MS; await github.observe(prs, { background: true });
  now += POLL_IDLE_MS; rows.get(prs[0].key)!.updated = 1; await github.observe(prs, { background: true });
  const before = f.calls.graphql;
  for (let i = 0; i < 4; i++) { now += TICK_MS; await github.observe(prs, { background: true }); }
  assert.equal(f.calls.graphql - before, 4);
});

test("a partial GraphQL response fails only the PRs its errors point at", async () => {
  const { rows, prs } = fleet(3, 1, i => (i === 1 ? { missing: true } : {}));
  const f = fakeGithub(rows);
  const observed = await new Github(undefined, undefined, undefined, f.api, () => clock).observe(prs);
  assert.equal(observed.get(prs[0].key)!.error, null);
  assert.match(observed.get(prs[1].key)!.error!, /PR unavailable/);
  assert.equal(observed.get(prs[2].key)!.error, null);
});

test("rules that don't come back whole fall back to one REST read per branch per TTL", async () => {
  let now = clock;
  const { rows, prs } = fleet(3, 1, () => ({ base: "release", rules: "error" }));
  rows.get(prs[2].key)!.rules = "truncated";
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  const observed = await github.observe(prs);
  assert.ok([...observed.values()].every(o => o.error === null));
  assert.deepEqual(f.calls.restPaths, ["repos/org0/repo0/rules/branches/release"]);
  now += RULES_TTL_MS - 1; await github.observe(prs); assert.equal(f.calls.rest, 1);
  now += 2; await github.observe(prs); assert.equal(f.calls.rest, 2);
});

test("tokens: one lookup per owner, the account map like the gh wrapper, a dead session bus, refresh on 401", async () => {
  assert.equal(accountFor("# comment\nacme  work\n*  personal\n", "acme"), "work");
  assert.equal(accountFor("acme work\n* personal\n", "other"), "personal");
  assert.equal(accountFor("", "other"), null);
  const lookups: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const tokens = ghTokens({ HOME: "/nonexistent", GH_ACCOUNT_MAP: "/nonexistent/map", PATH: "/usr/bin" }, async (bin, args, env) => { lookups.push({ bin, args, env }); return `token-${lookups.length}\n`; });
  let status = 200; const seen: string[] = [];
  const api = httpApi({ tokens, base: "https://github.test", request: (async (_url: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).authorization); const s = status; status = 200; return { status: s, ok: s < 400, text: async () => JSON.stringify({ data: { ok: true } }) }; }) as unknown as typeof fetch });
  for (let i = 0; i < 5; i++) await api.graphql("acme/app", "query{viewer{login}}", {});
  await api.rest("acme/other", "repos/acme/other");
  assert.equal(lookups.length, 1, "one token lookup for owner acme across six requests");
  assert.equal(lookups[0].env.DBUS_SESSION_BUS_ADDRESS, DEAD_BUS);
  assert.equal(lookups[0].env.GH_TOKEN, undefined);
  status = 401; await api.graphql("acme/app", "query{viewer{login}}", {});
  assert.equal(lookups.length, 2, "a 401 re-resolves the token once");
  assert.deepEqual(seen.slice(-2), ["bearer token-1", "bearer token-2"]);
  const explicit = ghTokens({ GH_TOKEN: "explicit" }, async () => { throw new Error("must not spawn"); });
  assert.equal(await explicit("acme"), "explicit");
});

test("the deploy probe runs one gcloud call per fleet read once its serving revisions are known", async () => {
  let now = clock; const calls: string[] = [];
  const sha = "b".repeat(40);
  const deployments = new Deployments(async (command, args) => {
    calls.push(`${command} ${args.slice(0, 3).join(" ")}`);
    if (command === "gh") return JSON.stringify({ status: "ahead" });
    if (args[0] === "auth") return "token";
    if (args[1] === "services") return JSON.stringify(["backend", "etl", "interpretation", "public-api", "web"].map(role => ({ metadata: { name: `hero-service-vspm-${role}-x`, labels: { "cloud.googleapis.com/location": "us-central1" } }, status: { conditions: [{ type: "Ready", status: "True" }], traffic: [{ revisionName: `${role}-r1`, percent: 100 }] } })));
    return JSON.stringify({ spec: { containers: [{ name: "app", image: `us-central1-docker.pkg.dev/hero-production-environments/hero-docker-repo/prod-vspm-backend@sha256:${"1".repeat(64)}` }] }, status: { conditions: [{ type: "Ready", status: "True" }] } });
  }, (async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.includes("/manifests/") ? { config: { digest: `sha256:${"3".repeat(64)}` } } : { config: { Labels: { "org.opencontainers.image.revision": sha } } }) })) as unknown as typeof fetch, () => now);
  const target = pr({ repo: "herosecurity/hero-poc", key: "herosecurity/hero-poc#1", snapshot: { ...pr().snapshot!, state: "MERGED", mergeCommit: "a".repeat(40) } });
  for (let minute = 0; minute < 10; minute++) { for (let t = 0; t < 4; t++) { await deployments.observe([target]); now += TICK_MS; } }
  const gcloud = calls.filter(c => c.startsWith("gcloud run"));
  assert.equal(gcloud.filter(c => c.includes("services")).length, 10, "one fleet read a minute");
  assert.equal(gcloud.filter(c => c.includes("revisions")).length, 5, "each serving revision described once, not every minute");
});

test("the engine's timer tick may back off; a refresh during it still gets a fresh read right after", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { Engine } = await import("../server/engine"); const { Store } = await import("../server/store"); const { workspace } = await import("./fixtures");
  const root = await mkdtemp(join(tmpdir(), "follow-poll-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(workspace({ prs: [pr()] }), workspace({ id: "busy", mainAgentId: "busy-agent", runtimeBusy: true, prs: [pr({ key: "example/app#2", number: 2 })] })); });
  const seen: Parameters<Github["observe"]>[1][] = []; let release: () => void = () => {}; let gate: Promise<void> | null = null;
  const github = { observe: async (prs: any[], o?: Parameters<Github["observe"]>[1]) => { seen.push(o); if (gate) await gate; return new Map(prs.map(p => [p.key, { snapshot: p.snapshot, error: null }])); } };
  const engine = new Engine(store, github as any, { observe: async () => ({ busy: false, reason: null, archived: false }), send: async () => {}, prepareRecovery: async () => ({ agentId: "r", contextPath: "c" }), label: async () => {} } as any, () => clock);
  gate = new Promise(r => { release = r; });
  const background = engine.tick({ background: true });
  await new Promise(r => setTimeout(r, 20));
  const refresh = engine.tick({ workspaceId: "workspace" });
  gate = null; release(); await background; await refresh;
  assert.equal(seen.length, 2, "the refresh ran its own read after the background tick");
  assert.equal(seen[0]!.background, true);
  assert.deepEqual([...seen[0]!.hot!], ["example/app#2"], "a busy workspace's PRs are hot");
  assert.deepEqual([...seen[1]!.fresh!], ["example/app#1"], "the refreshed workspace's PRs are read now");
  await engine.tick(); assert.deepEqual(seen[2], {}, "any other caller: a full fresh read");
});

test("a first read is not a change: a settled repository backs off right after the worker starts", async () => {
  let now = clock;
  const { rows, prs } = fleet(6, 2, i => (i === 0 ? { checksPending: true } : {}));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => now);
  await github.observe(prs, { background: true });
  f.calls.perRepo.clear();
  for (let i = 0; i < 4; i++) { now += TICK_MS; await github.observe(prs, { background: true }); }
  assert.equal(f.calls.perRepo.get(prs[0].repo), 4, "the repository with pending checks: every tick");
  assert.equal(f.calls.perRepo.get(prs[1].repo), 1, "the settled one: once per POLL_IDLE_MS from the start");
});
