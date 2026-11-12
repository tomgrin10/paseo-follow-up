import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followUpEvents } from "../server/inbox";
import { PrWorkflowStore, type Probe } from "../server/pr-workflow";
import { needsYou } from "../shared/attention";
import { newEntry, prEndEvent, reduce } from "../shared/inbox";
import { agentMerges, noReviewRepoList, REVIEW_MODE_LABELS, repoShippingSummary, repoReview, setNoReviewRepos, setPrWorkflowInputSchema } from "../shared/pr-workflow";
import { emptyReviewerConfig, setReviewerConfig } from "../shared/reviewers";
import { INVARIANTS as STATUS_INVARIANTS } from "../shared/status-invariants";
import { clock, pr, snapshot, workspace } from "./fixtures";

process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { mergeLine: (workflow?: unknown) => string; NO_REVIEW_MERGE: string };
const mcp = await import("../server/mcp.mjs");

/**
 * 2026-11-12 (task d1d8ad04, Q33=A): Tom's repositories come in two kinds. Team repositories (a company repo) are
 * reviewed by people: Follow-up asks the developer to add reviewers and to merge. In a repository nobody else reviews
 * (his own plugins) the agent opens, reviews and merges its PRs itself, yet every PR there asked "#N has no reviewers"
 * and "#N is ready to merge" unless the agent remembered register_pr agentMerges on each one.
 * Invariant a-no-review-repo-never-asks-for-review-or-merge: in a repository set to No review, Follow-up never asks
 * the developer to add reviewers or merge, and its merges flag nobody, unless the PR's own register_pr says false.
 */
const reviewers = () => ({ author: "agent-author", requested: [] as string[], teams: [] as string[], reviewed: [] as string[], complete: true });
const greenUnreviewed = (patch: Partial<Parameters<typeof pr>[0]> = {}) => pr({ snapshot: snapshot({ reviewers: reviewers(), prWorkflow: "github", mergeStateStatus: "CLEAN" }), registeredAgentId: "main-agent", ...patch });
const merged = (patch: Partial<Parameters<typeof pr>[0]> = {}) => pr({ snapshot: snapshot({ state: "MERGED" }), ...patch });
const asks = (w: ReturnType<typeof workspace>) => [...needsYou(w, clock).map(i => i.kind), ...followUpEvents({ version: 1, workspaces: [w] } as never, true).map(e => e.event.type)];
/** The process-wide set is module state: every test that sets it puts it back, so no test leaks a No review repository. */
function fresh(t: { after: (fn: () => void) => void }, noReview: string[] = []) {
  setNoReviewRepos(noReview);
  setReviewerConfig({ ...emptyReviewerConfig(), repos: { "example/app": [{ login: "reviewer", name: "Reviewer" }] } });
  t.after(() => { setNoReviewRepos([]); setReviewerConfig(emptyReviewerConfig()); });
}

test("a-no-review-repo-never-asks-for-review-or-merge: a No review repository asks for neither reviewers nor a merge, in Needs you or the inbox", t => {
  fresh(t);
  const w = workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] });
  assert.deepEqual(asks(w), ["merge", "reviewers"], "a team repository asks (the default)");
  setNoReviewRepos(["Example/App"]);
  assert.equal(repoReview("example/app"), "none", "repository names match case-insensitively");
  assert.deepEqual(asks(w), [], "the same PR in a No review repository asks nothing");
  const noReviewers = workspace({ mainAgentId: "main-agent", prs: [pr({ snapshot: snapshot({ reviewers: reviewers(), checksPending: true }), registeredAgentId: "main-agent" })] });
  assert.deepEqual(asks(noReviewers), [], "no Add reviewers while checks run either");
  for (const inv of STATUS_INVARIANTS.filter(i => i.id === "agent-merges-asks-nothing")) assert.equal(inv.check(w, clock), null);
});

test("a-no-review-repo-never-asks-for-review-or-merge: its merges flag nobody, a team repository's still do", t => {
  fresh(t, ["example/app"]);
  assert.equal(prEndEvent(merged())?.quiet, true);
  assert.equal(prEndEvent(merged({ repo: "example/web", key: "example/web#1" }))?.quiet, undefined, "a team repository's merge still flags");
  const flag = STATUS_INVARIANTS.find(i => i.id === "a-merge-the-agent-made-never-flags-the-developer")!;
  assert.equal(flag.check(workspace({ prs: [merged()] }), clock), null);
});

test("a-no-review-repo-never-asks-for-review-or-merge: the PR's own register_pr answer wins over the repository", t => {
  fresh(t, ["example/app"]);
  assert.equal(agentMerges({ repo: "example/app" }), true);
  assert.equal(agentMerges({ repo: "example/app", agentMerges: false }), false, "false hands one merge back in a No review repository");
  assert.equal(agentMerges({ repo: "example/web", agentMerges: true }), true, "true still works in a team repository");
  assert.deepEqual(asks(workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed({ agentMerges: false })] })), ["merge", "reviewers"]);
});

test("a-no-review-repo-never-asks-for-review-or-merge: every consumer reads agentMerges(pr), never pr.agentMerges", async () => {
  // The one rule lives in shared/pr-workflow.ts. A surface that reads the field directly misses No review repositories.
  const files = [join("index.server.ts")];
  for (const dir of ["shared", "server", "client"]) for (const f of await readdir(dir)) if (/\.(ts|tsx|mjs)$/.test(f) && !/-source\.ts$/.test(f)) files.push(join(dir, f));
  const offenders: string[] = [];
  for (const file of files) {
    if (file === join("shared", "pr-workflow.ts")) continue;
    (await readFile(file, "utf8")).split("\n").forEach((line, i) => {
      if (!/\.agentMerges\b/.test(line)) return;
      // register_pr's own write path stores the answer; it decides nothing.
      if (file === "index.server.ts" && /existing\.agentMerges/.test(line) && /registerPrRpc|altered|existing\.agentMerges = agentMerges/.test(line)) return;
      offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "read agentMerges(pr) from shared/pr-workflow.ts instead");
});

const probe: Probe = { gtInstalled: async () => false, signedIn: async () => false, initialised: async () => false };

test("a-no-review-repo-never-asks-for-review-or-merge: after a restart the set is filled from pr-workflow.json before the first tick", async t => {
  fresh(t);
  const dir = await mkdtemp(join(tmpdir(), "review-mode-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "pr-workflow.json"), JSON.stringify({ version: 1, repos: { "example/app": { review: "none" } }, migratedAt: "2026-11-12T00:00:00Z" }));
  setNoReviewRepos([]); // a fresh worker process
  const store = new PrWorkflowStore(dir, probe);
  await store.read();
  assert.deepEqual(noReviewRepoList(), ["example/app"]);
  assert.deepEqual(asks(workspace({ mainAgentId: "main-agent", prs: [greenUnreviewed()] })), [], "the first tick is already quiet");
  // The worker reads it inside `ready`, which the tick loop and the inbox wait for, before anything ticks.
  const server = await readFile("index.server.ts", "utf8");
  const ready = server.indexOf("const ready = (async () => {");
  const read = server.indexOf("await prWorkflow.read();", ready);
  assert.ok(ready > 0 && read > ready && read < server.indexOf("await engine.recover();", ready), "prWorkflow.read() runs first thing in ready");
  assert.match(server, /const loop = async \(\) => \{\n\s+await ready;/, "the tick loop waits for ready");
});

test("set_pr_workflow review: none saves, team clears back to the default, and every save updates the set", async t => {
  fresh(t);
  const dir = await mkdtemp(join(tmpdir(), "review-mode-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PrWorkflowStore(dir, probe);
  await store.mutate(c => { c.repos["example/app"] = { review: "none" }; });
  assert.equal(repoReview("example/app"), "none");
  assert.equal(store.agentWorkflow("example/app").noReview, true);
  assert.equal(store.agentWorkflow("example/web").noReview, undefined, "team repositories' agent text is unchanged");
  const view = await store.view(["example/app", "example/web"]);
  assert.deepEqual(view.repos.map(r => [r.repo, r.review]), [["example/app", "none"], ["example/web", "team"]]);
  assert.match(repoShippingSummary(view.repos[0]), /No review/);
  await store.mutate(c => { c.repos["example/app"].review = "team"; });
  assert.equal(repoReview("example/app"), "team");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "pr-workflow.json"), "utf8")).repos, {}, "team is the default: nothing is stored");
  assert.ok(setPrWorkflowInputSchema.safeParse({ repo: "example/app", review: "none" }).success);
  assert.ok(setPrWorkflowInputSchema.safeParse({ repo: "example/app", review: null }).success);
  assert.ok(!setPrWorkflowInputSchema.safeParse({ repo: "example/app", review: "solo" }).success);
});

test("agent text: a No review repository tells the agent to merge its own PR once CI is green; team wording is unchanged", () => {
  assert.equal(hook.mergeLine({ mode: "github", reviewFix: null }), "Merging and archiving remain the developer's actions.");
  assert.equal(hook.mergeLine(undefined), "Merging and archiving remain the developer's actions.");
  assert.match(hook.mergeLine({ mode: "github", reviewFix: null, noReview: true }), /merge your own PR once CI is green/);
  for (const wf of [{ mode: "github", reviewFix: null }, { mode: "graphite", reviewFix: "/fix-pr" }]) {
    assert.match(mcp.batchInstructions(wf as never), /Leave merging and archiving to the developer\.$/);
    const own = mcp.batchInstructions({ ...wf, noReview: true } as never);
    assert.match(own, /merge your own PR once CI is green/);
    assert.doesNotMatch(own, /Leave merging and archiving to the developer/);
  }
});

test("one sentence per mode, said the same way everywhere", () => {
  assert.equal(REVIEW_MODE_LABELS.none.hint, "The agent merges its own PRs once checks pass.");
  assert.equal(REVIEW_MODE_LABELS.team.hint, "Follow-up asks you to add reviewers and to merge.");
});

test("Undo brings Add reviewers back: a withdrawn reviewers flag forgets its key, so the same PR can ask again", () => {
  const at = new Date(clock).toISOString();
  const ask = { type: "reviewers" as const, dedupeKey: "example/app#1:reviewers", detail: "#1", prKey: "example/app#1", url: null, names: [] };
  let e = reduce(newEntry("main-agent"), ask, at);
  assert.ok(e.needs?.reasons.some(r => r.reason === "reviewers"));
  e = reduce(e, { type: "facts_live", live: [] }, at); // the repository went No review
  assert.equal(e.needs, null);
  e = reduce(e, ask, at); // Undo: Team review again
  assert.ok(e.needs?.reasons.some(r => r.reason === "reviewers"), "the ask is back");
  // A flag the developer signed off stays handled: it isn't withdrawn, so its key is kept.
  let off = reduce(reduce(newEntry("main-agent"), ask, at), { type: "sign_off" }, at);
  off = reduce(reduce(off, { type: "facts_live", live: [] }, at), ask, at);
  assert.equal(off.needs, null);
});
