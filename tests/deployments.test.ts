import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Deployments, READ_TIMEOUT_MS, TOKEN_MS } from "../server/deployments";
import type { DeployConfig } from "../shared/pr-workflow";
import { tasksFor } from "../server/tasks";
import { lifecycleOnly } from "../shared/follow-up";
import { completionBlockers } from "../shared/model";
import { compactPrStatus, settledForDisplay } from "../shared/presentation";
import { ACME_DEPLOY, clock, pr, snapshot, workspace } from "./fixtures";

const ACME: DeployConfig = ACME_DEPLOY;
const merged = "a".repeat(40), current = "b".repeat(40), old = "c".repeat(40);
function fixture() {
  let now = clock, configured = true, failure = false, missing = false, ready = true, rollback = false, split = false, denied = 0, huge = "";
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(`${command} ${args.slice(0, 3).join(" ")}`);
    if (failure) throw new Error("private transport details");
    if (command === "gh") return JSON.stringify({ status: args[1].endsWith(current) ? "ahead" : "behind" });
    if (args[0] === "auth") return "private-fixture-access-token";
    throw new Error(`unexpected gcloud ${args.join(" ")}`);
  };
  // Cloud Run (Knative v1) and the registry, read in process: the fake answers by URL and records the path.
  const answer = (url: string): unknown => {
    if (url.includes("/services?labelSelector=")) return { items: ["backend", "etl", "interpretation", "public-api", "web"].filter(r => !missing || r !== "web").map(role => ({ metadata: { name: `acme-service-app-${role}-hash`, labels: { "cloud.googleapis.com/location": "us-central1" } }, status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }], traffic: split ? [{ revisionName: "new", percent: 50 }, { revisionName: "old", percent: 50 }] : [{ revisionName: rollback ? "old" : "new", percent: 100 }] } })) };
    if (url.includes("/revisions/")) return { spec: { containers: [{ name: "app", image: `us-central1-docker.pkg.dev/acme-prod/acme-docker/prod-app-backend@sha256:${(url.endsWith("/old") ? "2" : "1").repeat(64)}` }] }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    if (url.includes("/manifests/")) return { config: { digest: `sha256:${url.includes("2".repeat(64)) ? "4".repeat(64) : "3".repeat(64)}` } };
    return { config: { Labels: { "org.opencontainers.image.revision": url.includes("4".repeat(64)) ? old : current } } };
  };
  const request = (async (input: any, init: any) => {
    const url = String(input); calls.push(`fetch ${new URL(url).host}${new URL(url).pathname}${new URL(url).search}`);
    if (failure) throw new Error("private transport details");
    assert.equal(init.headers.Authorization, "Bearer private-fixture-access-token");
    if (denied > 0) { denied--; return { ok: false, status: 401, text: async () => "" }; }
    if (huge && url.includes(huge)) return { ok: true, status: 200, text: async () => " ".repeat(5 * 1024 * 1024) };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer(url)) };
  }) as any;
  const adapter = new Deployments(run, request, () => now, { rest: async (_repo: string, path: string) => JSON.parse(await run("gh", ["api", path])) }, repo => configured && repo === "acme/acme-poc" ? ACME : undefined);
  const target = pr({ repo: "acme/acme-poc", key: "acme/acme-poc#1", snapshot: snapshot({ state: "MERGED", head: "unmerged-head-not-in-history", mergeCommit: merged }) });
  return { adapter, target, calls, failure: () => { failure = true; }, heal: () => { failure = false; }, wait: (ms: number) => { now += ms; }, missing: () => { missing = true; }, unready: () => { ready = false; }, rollback: () => { rollback = true; }, split: () => { split = true; }, advance: () => { now += 61_000; }, unconfigure: () => { configured = false; }, configure: () => { configured = true; }, deny: (n: number) => { denied = n; }, huge: (part: string) => { huge = part; } };
}
test("deployment follows the squash merge commit into actual serving images, and caches fleet reads", async () => {
  const f = fixture(); const result = (await f.adapter.observe([f.target])).get(f.target.key)!;
  assert.equal(result.state, "deployed"); assert.deepEqual(result.commits, [current]);
  assert.ok(f.calls.some(c => c.includes(`compare/${merged}...${current}`)));
  const count = f.calls.length; await f.adapter.observe([f.target, f.target]); assert.equal(f.calls.length, count);
  assert.ok(!JSON.stringify(result).includes("private-fixture-access-token"));
});
test("cloud-run-reads-in-process: fleet reads spawn no gcloud while the token is cached", async () => {
  const f = fixture(); await f.adapter.observe([f.target]);
  const spawns = () => f.calls.filter(c => c.startsWith("gcloud"));
  assert.deepEqual(spawns(), ["gcloud auth print-access-token"], "one token, no gcloud run");
  assert.ok(f.calls.some(c => c.startsWith("fetch us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/acme-prod/revisions/new")), "the revision is read from its region");
  for (let i = 0; i < 5; i++) { f.advance(); await f.adapter.observe([f.target]); }
  assert.equal(f.calls.filter(c => c.includes("/services?")).length, 6, "every expired fleet cache reads the services again");
  assert.deepEqual(spawns(), ["gcloud auth print-access-token"], "...without another gcloud while the token is cached");
  f.wait(TOKEN_MS); await f.adapter.observe([f.target]);
  assert.equal(spawns().length, 2, "an expired token is fetched once more");
});
test("a 401/403 drops the token and retries once; a second refusal fails without transport detail", async () => {
  const f = fixture(); f.deny(1);
  assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "deployed");
  assert.equal(f.calls.filter(c => c.startsWith("gcloud auth")).length, 2, "the refused token is replaced");
  assert.equal(f.calls.filter(c => c.includes("/services?")).length, 2, "the read is retried once");
  const g = fixture(); g.deny(5);
  const value = (await g.adapter.observe([g.target])).get(g.target.key)!;
  assert.equal(value.state, "unknown"); assert.equal(g.adapter.lastError, "Production services unavailable");
  assert.equal(g.calls.filter(c => c.includes("/services?")).length, 2, "exactly one retry");
});
test("an oversized read names what was read, never another source's limit", async () => {
  for (const [part, reason] of [["/services?", "Production services exceed the read limit"], ["/revisions/", "Serving revision exceeds the read limit"], ["/manifests/", "Deployment image metadata exceeds the read limit"]] as const) {
    const f = fixture(); f.huge(part);
    assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "unknown"); assert.equal(f.adapter.lastError, reason);
  }
});
test("every Cloud Run and registry read is aborted after READ_TIMEOUT_MS", async () => {
  let signal: AbortSignal | undefined;
  const adapter = new Deployments(async () => "token", (async (_url: any, init: any) => { signal = init.signal; return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))); }) as any, Date.now, { rest: async () => ({}) }, () => ACME);
  const t = mock.timers; t.enable({ apis: ["setTimeout"] });
  try {
    const pending = adapter.observe([pr({ repo: "acme/acme-poc", key: "acme/acme-poc#1", snapshot: snapshot({ state: "MERGED", mergeCommit: merged }) })]);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.equal(READ_TIMEOUT_MS, 8_000); t.tick(READ_TIMEOUT_MS - 1); assert.equal(signal?.aborted, false); t.tick(1); assert.equal(signal?.aborted, true);
    await pending; assert.equal(adapter.lastError, "read timed out");
  } finally { t.reset(); }
});
test("partial traffic and a rollback prevent deployment from qualifying", async () => {
  const f = fixture(); f.split(); assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "partial");
  const g = fixture(); await g.adapter.observe([g.target]); g.rollback(); g.advance(); assert.equal((await g.adapter.observe([g.target])).get(g.target.key)?.state, "pending");
});
test("missing services, unready revisions, and read failures remain unknown without exposing errors", async () => {
  for (const state of ["missing", "unready", "failure"] as const) {
    const f = fixture(); f[state](); const value = (await f.adapter.observe([f.target])).get(f.target.key)!;
    assert.equal(value.state, "unknown"); assert.ok(!JSON.stringify(value).includes("private transport"));
  }
});
test("a failed probe says why, without transport detail, and retries on the next refresh instead of a minute later", async () => {
  const f = fixture(); f.failure();
  const value = (await f.adapter.observe([f.target])).get(f.target.key)!;
  assert.equal(value.state, "unknown"); assert.match(value.evidence, /Could not verify serving production revisions \(lookup failed\)/);
  assert.equal(f.adapter.lastError, "lookup failed");
  f.heal(); f.wait(16_000);
  assert.equal((await f.adapter.observe([f.target])).get(f.target.key)!.state, "deployed");
  assert.equal(f.adapter.lastError, null);
});
test("unknown merge commits and repositories cannot claim deployment", async () => {
  const f = fixture(); f.target.snapshot!.mergeCommit = null; assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "unknown");
  const g = fixture(); g.target.repo = "example/app"; assert.equal((await g.adapter.observe([g.target])).has(g.target.key), false, "no deploy check: no entry"); assert.equal(g.calls.length, 0);
});
test("public-code-carries-no-host-identifiers: the probe reads only repositories with a deploy check, from injected config", async () => {
  const f = fixture(); f.unconfigure();
  assert.equal(f.adapter.configured("acme/acme-poc"), false);
  assert.equal((await f.adapter.observe([f.target])).size, 0); assert.equal(f.calls.length, 0, "empty config: no gcloud or GitHub call");
  f.configure();
  assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "deployed", "the check comes back with its config");
  assert.ok(f.calls.some(c => c === `fetch run.googleapis.com/apis/serving.knative.dev/v1/namespaces/acme-prod/services?labelSelector=${encodeURIComponent("rollout-group=app")}`), "reads the configured project's services, by its label");
  assert.equal(new Deployments().configured("acme/acme-poc"), false, "the default: no repository has a deploy check");
});
test("all post-deploy dependencies must be freshly deployed; closed, partial, missing and stale do not qualify", () => {
  const d = { state: "deployed" as const, environment: "production", commits: [current], evidence: "Serving image contains the merge", observedAt: new Date(clock).toISOString() };
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED", deployment: d }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ state: "MERGED", deployment: d }) })], obligations: [{ id: "verify", title: "Verify production behavior", status: "waiting", afterPrs: ["example/app#1", "example/app#2"], dependencyStage: "deployed", trigger: { event: "deploy", delayDays: 0 }, enable_follow_up: true, revision: 0, evidence: "" }] });
  assert.equal(tasksFor(w, clock).filter(t => t.kind === "obligation").length, 1);
  assert.equal(tasksFor(w, clock + 121_000).length, 0);
  for (const state of ["partial", "unknown", "pending"] as const) { w.prs[1].snapshot!.deployment = { ...d, state }; assert.equal(tasksFor(w, clock).length, 0); }
  w.prs[1].snapshot!.deployment = d; w.prs[1].snapshot!.state = "CLOSED"; w.prs[1].disposition = "Superseded"; assert.equal(tasksFor(w, clock).length, 0);
});
test("lifecycle-only requirements stay in history without duplicating Tasks or blocking completion", () => {
  const o = { id: "merge", title: "Merge the approved PR", status: "waiting" as const, afterPrs: ["example/app#1"], enable_follow_up: true, revision: 0, evidence: "Original record" };
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], obligations: [o] });
  assert.ok(lifecycleOnly(o)); assert.equal(tasksFor(w, clock).filter(t => t.kind === "obligation").length, 0); assert.equal(completionBlockers(w, clock).length, 0); assert.equal(w.obligations.length, 1);
  assert.equal(lifecycleOnly({ ...o, title: "Merge the PR; then verify tenant behavior" }), false);
});
test("legacy titles and dependencyStage do not schedule tasks; explicit merge triggers can start before deployment", () => {
  const w = workspace({ prs: [pr({ snapshot: snapshot({ state: "MERGED" }) })], obligations: [{ id: "verify", title: "Verify the production rollout", status: "waiting", afterPrs: ["example/app#1"], enable_follow_up: true, revision: 0, evidence: "" }] });
  assert.equal(tasksFor(w, clock).length, 0); w.obligations[0].dependencyStage = "merged"; assert.equal(tasksFor(w, clock).length, 0); w.obligations[0].trigger = { event: "merge", delayDays: 0 }; assert.equal(tasksFor(w, clock).length, 1);
});
test("known pending deployment stays visible; compact labels keep merged and approved distinct", () => {
  const p = pr({ snapshot: snapshot({ state: "MERGED", deployment: { state: "pending", environment: "production", commits: [current], evidence: "Not yet included", observedAt: new Date().toISOString() } }) });
  assert.equal(settledForDisplay(p), false); assert.equal(compactPrStatus(p).label, "Merged");
  assert.match(completionBlockers(workspace({ prs: [p] }), Date.now())[0], /to reach production/);
  for (const state of ["partial", "unknown"] as const) { p.snapshot!.deployment!.state = state; assert.equal(compactPrStatus(p).label, "Merged"); }
  p.snapshot!.deployment!.state = "deployed"; assert.equal(settledForDisplay(p), true); assert.equal(compactPrStatus(p).label, "Deployed"); assert.equal(compactPrStatus(p).tone, "merged");
  p.snapshot!.deployment!.observedAt = new Date(Date.now() - 121_000).toISOString(); assert.equal(compactPrStatus(p).label, "Merged");
});
