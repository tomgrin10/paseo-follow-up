import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followUpEvents } from "../server/inbox";
import { PrWorkflowStore, type Probe } from "../server/pr-workflow";
import { needsYou } from "../shared/attention";
import { newEntry, prEndEvent, reduce, reviewersBriefWithdrawn, withoutWithdrawnAsks, type InboxRow } from "../shared/inbox";
import { briefAsks, liveBrief, pickBrief } from "../shared/brief";
import { flagHeadline } from "../shared/headline";
import { agentMerges, agentMergesKey, handsMergeBack, setHandedBackPrs, reviewersMissing, noReviewRepoList, REVIEW_MODE_LABELS, repoShippingSummary, repoReview, setNoReviewRepos, setPrWorkflowInputSchema } from "../shared/pr-workflow";
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
  setNoReviewRepos(noReview); setHandedBackPrs([]);
  setReviewerConfig({ ...emptyReviewerConfig(), repos: { "example/app": [{ login: "reviewer", name: "Reviewer" }] } });
  t.after(() => { setNoReviewRepos([]); setHandedBackPrs([]); setReviewerConfig(emptyReviewerConfig()); });
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
  // The hook text is per workspace: it says "merge your own PR" only when every repository the workspace touches is No review.
  assert.equal(store.agentWorkflow("example/app", ["example/app", "example/web"]).noReview, undefined, "one team repository keeps the team wording");
  assert.equal(store.agentWorkflow("example/web", ["example/app"]).noReview, true);
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

test("a-no-review-repo-never-asks-for-review-or-merge: a PR the agent merges itself never reads \"No reviewers\"", async t => {
  // 2026-11-12, Tom's live panel: #139 and #147 (register_pr agentMerges) read "… · No reviewers" in Pull requests.
  fresh(t);
  const open = (patch: Partial<Parameters<typeof pr>[0]> = {}) => pr({ snapshot: snapshot({ reviewers: reviewers() }), ...patch });
  assert.equal(reviewersMissing(open()), true, "a team-review PR keeps it");
  assert.equal(reviewersMissing(open({ agentMerges: true })), false, "register_pr agentMerges drops it");
  setNoReviewRepos(["example/app"]);
  assert.equal(reviewersMissing(open()), false, "a No review repository drops it");
  assert.equal(reviewersMissing(open({ agentMerges: false })), true, "a merge handed back keeps it");
  // Every surface that shows the fragment (panel PR rows, the PR sheet) goes through reviewersMissing; Home's chip
  // comes from Needs you's reviewers item, which asksForReviewers already gates.
  const offenders: string[] = [];
  for (const f of await readdir("client")) if (/\.tsx?$/.test(f)) (await readFile(join("client", f), "utf8")).split("\n").forEach((line, i) => { if (/\bnoReviewers\(/.test(line)) offenders.push(`client/${f}:${i + 1}`); });
  assert.deepEqual(offenders, [], "use reviewersMissing(pr) from shared/pr-workflow.ts");
});

test("a-no-review-repo-never-asks-for-review-or-merge: the moment the repository flips, no surface draws the add-reviewers ask; Undo brings it back", t => {
  // 2026-11-12, #147 renders: right after "example/app: no review … Undo", Needs you, the header and the Home row still
  // read "Add reviewers to #240: Ravi" until the daemon's next tick (up to 15 s), contradicting the toast just tapped.
  fresh(t);
  const at = new Date(clock).toISOString();
  const full = { ...pickBrief({ reviewers: { prKey: "example/app#240", repo: "example/app", number: 240, url: null, names: ["Ravi"] } }), state: "open" as const };
  assert.equal(full.ask, "Add reviewers to #240: Ravi");
  const row: Pick<InboxRow, "needs" | "snooze" | "brief"> = {
    needs: reduce(newEntry("main-agent"), { type: "reviewers", dedupeKey: "example/app#240:reviewers", detail: "#240", prKey: "example/app#240", url: null, names: ["Ravi"] }, at).needs, snooze: null,
    brief: { kind: "reviewers", source: "followup", state: "open", ask: full.ask, prKey: "example/app#240" },
  };
  const other = { reason: "finished" as const, at, detail: "Finished", dedupeKey: "turn:1" };
  const drawn = (r: typeof row) => { const shown = withoutWithdrawnAsks(r); return { needs: shown.needs?.reasons.map(x => x.reason) ?? [], headline: flagHeadline(shown, clock)?.line ?? null, brief: shown.brief?.ask ?? null }; };
  assert.deepEqual(drawn(row), { needs: ["reviewers"], headline: "Suggested: Ravi", brief: "Add reviewers to #240: Ravi" }, "Team review asks");
  assert.equal(reviewersBriefWithdrawn(full), false);
  setNoReviewRepos(["example/app"]); // the link's tap: the client's set flips before any daemon round trip
  assert.deepEqual(drawn(row), { needs: [], headline: null, brief: null }, "the pill, the row, Home's group and the count all lose it at once");
  assert.equal(reviewersBriefWithdrawn(full), true, "the panel's brief card and the chat's card draw nothing");
  assert.equal(liveBrief(full), null, "liveBrief, the one place the check composes, drops it");
  assert.equal(briefAsks(full, row), false, "and so does briefAsks (a-done-brief-is-never-an-ask's predicate)");
  const mixed = withoutWithdrawnAsks({ ...row, needs: { reasons: [...row.needs!.reasons, other], since: at } });
  assert.deepEqual(mixed.needs?.reasons.map(r => r.reason), ["finished"], "another flag on the same agent stays");
  assert.equal(mixed.brief, null);
  assert.deepEqual(withoutWithdrawnAsks({ ...row, needs: { reasons: [{ ...row.needs!.reasons[0], prKey: undefined }], since: at } }).needs, null, "a flag stored without its PR falls back on the brief's PR");
  setHandedBackPrs(["example/app#240"]); // register_pr agentMerges false: the merge is the developer's again
  assert.deepEqual(drawn(row).needs, ["reviewers"], "a merge handed back still asks");
  assert.equal(handsMergeBack({ repo: "example/app", agentMerges: false }), true);
  setHandedBackPrs([]);
  setNoReviewRepos([]); // Undo
  assert.deepEqual(drawn(row), { needs: ["reviewers"], headline: "Suggested: Ravi", brief: "Add reviewers to #240: Ravi" }, "Undo brings it back");
  assert.equal(agentMergesKey("example/app#240"), false);
});

test("a-no-review-repo-never-asks-for-review-or-merge: nothing on the client draws an add-reviewers ask around the helpers", async () => {
  const src = async (f: string) => readFile(join("client", f), "utf8");
  const store = await src("inbox-store.ts");
  assert.match(store, /const view = \(\) => shown \?\?= \{ rows: \(data\?\.rows \?\? \[\]\)\.map\(r => withoutWithdrawnAsks\(r\)\), overseer: data\?\.overseer \? withoutWithdrawnAsks/, "every row the inbox store hands out goes through withoutWithdrawnAsks");
  assert.match(store, /rows: \(\) => \(enabled && data\?\.enabled \? view\(\)\.rows : \[\]\)/);
  assert.match(store, /overseer: \(\) => view\(\)\.overseer/);
  assert.match(store, /onNoReviewRepos\(\(\) => \{ shown = null; emit\(\); \}\)/, "a flip re-renders every inbox surface");
  assert.match(await src("brief.tsx"), /if \(b\.state === "open" && !liveBrief\(b\)\) return null;/, "the brief card draws nothing for a withdrawn ask");
  const offenders: string[] = [];
  for (const f of await readdir("client")) {
    if (!/\.tsx?$/.test(f) || f === "inbox-store.ts") continue;
    (await src(f)).split("\n").forEach((line, i) => {
      // The raw inbox answer skips the filter; an open brief read from the daemon must ask the helper on the same line.
      if (/\.data\(\)\??\.(rows|overseer)\b/.test(line)) offenders.push(`client/${f}:${i + 1} reads raw inbox rows`);
      if (/brief\.data\?\.brief\b/.test(line) && !/liveBrief\(brief\.data\?\.brief\)/.test(line)) offenders.push(`client/${f}:${i + 1} reads the daemon's brief without liveBrief`);
    });
  }
  assert.deepEqual(offenders, []);
});
