import test from "node:test";
import assert from "node:assert/strict";
import { Deployments } from "../server/deployments";
import { tasksFor } from "../server/tasks";
import { lifecycleOnly } from "../shared/follow-up";
import { completionBlockers } from "../shared/model";
import { compactPrStatus, settledForDisplay } from "../shared/presentation";
import { clock, pr, snapshot, workspace } from "./fixtures";

const merged = "a".repeat(40), current = "b".repeat(40), old = "c".repeat(40);
function fixture() {
  let now = clock, failure = false, missing = false, ready = true, rollback = false, split = false;
  const calls: string[] = [];
  const adapter = new Deployments(async (command, args) => {
    calls.push(`${command} ${args.slice(0, 3).join(" ")}`);
    if (failure) throw new Error("private transport details");
    if (command === "gh") return JSON.stringify({ status: args[1].endsWith(current) ? "ahead" : "behind" });
    if (args[0] === "auth") return "private-fixture-access-token";
    if (args[1] === "services") return JSON.stringify(["backend", "etl", "interpretation", "public-api", "web"].filter(r => !missing || r !== "web").map(role => ({ metadata: { name: `hero-service-vspm-${role}-hash`, labels: { "cloud.googleapis.com/location": "us-central1" } }, status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }], traffic: split ? [{ revisionName: "new", percent: 50 }, { revisionName: "old", percent: 50 }] : [{ revisionName: rollback ? "old" : "new", percent: 100 }] } })));
    return JSON.stringify({ spec: { containers: [{ name: "app", image: `us-central1-docker.pkg.dev/hero-production-environments/hero-docker-repo/prod-vspm-backend@sha256:${(args[3] === "old" ? "2" : "1").repeat(64)}` }] }, status: { conditions: [{ type: "Ready", status: "True" }] } });
  }, (async (url: any) => ({ ok: true, text: async () => JSON.stringify(String(url).includes("/manifests/") ? { config: { digest: `sha256:${String(url).includes("2".repeat(64)) ? "4".repeat(64) : "3".repeat(64)}` } } : { config: { Labels: { "org.opencontainers.image.revision": String(url).includes("4".repeat(64)) ? old : current } } }) })) as any, () => now);
  const target = pr({ repo: "herosecurity/hero-poc", key: "herosecurity/hero-poc#1", snapshot: snapshot({ state: "MERGED", head: "unmerged-head-not-in-history", mergeCommit: merged }) });
  return { adapter, target, calls, failure: () => { failure = true; }, missing: () => { missing = true; }, unready: () => { ready = false; }, rollback: () => { rollback = true; }, split: () => { split = true; }, advance: () => { now += 61_000; } };
}
test("deployment follows the squash merge commit into actual serving images, and caches fleet reads", async () => {
  const f = fixture(); const result = (await f.adapter.observe([f.target])).get(f.target.key)!;
  assert.equal(result.state, "deployed"); assert.deepEqual(result.commits, [current]);
  assert.ok(f.calls.some(c => c.includes(`compare/${merged}...${current}`)));
  const count = f.calls.length; await f.adapter.observe([f.target, f.target]); assert.equal(f.calls.length, count);
  assert.ok(!JSON.stringify(result).includes("private-fixture-access-token"));
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
test("unknown merge commits and repositories cannot claim deployment", async () => {
  const f = fixture(); f.target.snapshot!.mergeCommit = null; assert.equal((await f.adapter.observe([f.target])).get(f.target.key)?.state, "unknown");
  const g = fixture(); g.target.repo = "example/app"; assert.equal((await g.adapter.observe([g.target])).get(g.target.key)?.state, "unknown"); assert.equal(g.calls.length, 0);
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
  assert.match(completionBlockers(workspace({ prs: [p] }), clock)[0], /production deployment/);
  for (const state of ["partial", "unknown"] as const) { p.snapshot!.deployment!.state = state; assert.equal(compactPrStatus(p).label, "Merged"); }
  p.snapshot!.deployment!.state = "deployed"; assert.equal(settledForDisplay(p), true); assert.equal(compactPrStatus(p).label, "Deployed"); assert.equal(compactPrStatus(p).tone, "merged");
  p.snapshot!.deployment!.observedAt = new Date(Date.now() - 121_000).toISOString(); assert.equal(compactPrStatus(p).label, "Merged");
});
