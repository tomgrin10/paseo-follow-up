import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fsProbe, gitCommonDir, PrWorkflowStore, type Probe } from "../server/pr-workflow";
import { autoMergeArgs, chooseMethod, Github, mergeArgs, retargetArgs } from "../server/github";
import { PrActions } from "../server/pr-actions";
import { BrowserBridge } from "../server/browser-bridge";
import { Store } from "../server/store";
import { inferBaseChains } from "../server/engine";
import { tasksFor } from "../server/tasks";
import { scopes, workflowSummary } from "../server/scopes";
import { needsYou } from "../shared/attention";
import { mergeBlockers } from "../shared/pr-actions";
import { detect, PR_WORKFLOW_LABELS } from "../shared/pr-workflow";
import type { Pr, Snapshot } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { batchParagraph: (workflow?: unknown) => string };
const mcp = await import("../server/mcp.mjs");
const main = createRequire(import.meta.url)("./graphite-main-text.json") as { hookBatch: string; mcpBatch: string; tools: Record<string, string> };

const GRAPHITE_WORDS = /graphite|\bgt\b|\/fix-pr/i;
const githubFlow = { mode: "github", reviewFix: null };
const repoMerge = { methods: ["squash", "merge"] as ("squash" | "merge" | "rebase")[], preferred: "squash" as const, autoMerge: true, mergeQueue: false };
const ghSnapshot = (patch: Partial<Snapshot> = {}) => snapshot({ prWorkflow: "github", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", repoMerge, ...patch });

// ── Auto-detection ───────────────────────────────────────────────────────────

const probe = (o: { gt: boolean; auth: boolean; init: boolean }): Probe => ({ gtInstalled: async () => o.gt, signedIn: async () => o.auth, initialised: async () => o.init });
async function storeWith(p: Probe, paths: Record<string, string> = { "example/app": "/src/app" }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-workflow-"));
  const store = new PrWorkflowStore(dir, p);
  store.paths = async () => new Map(Object.entries(paths).map(([k, v]) => [k, [v]]));
  return { store, dir, close: () => rm(dir, { recursive: true, force: true }) };
}

test("auto: gt missing, sign-in missing or repo not initialised all resolve to GitHub; all present resolves to Graphite", async () => {
  const cases: [Parameters<typeof probe>[0], "graphite" | "github"][] = [
    [{ gt: false, auth: true, init: true }, "github"],
    [{ gt: true, auth: false, init: true }, "github"],
    [{ gt: true, auth: true, init: false }, "github"],
    [{ gt: true, auth: true, init: true }, "graphite"],
  ];
  for (const [o, expected] of cases) {
    const f = await storeWith(probe(o));
    try {
      assert.equal(await f.store.workflow("example/app"), expected, JSON.stringify(o));
      const view = await f.store.view(["example/app"]);
      assert.equal(view.repos[0].detected, expected);
      assert.equal(view.repos[0].effective, expected);
      assert.equal(view.gt.installed, o.gt);
      // GitHub rows lead with GitHub; Graphite is named at most once, as what isn't set up.
      if (expected === "github") { assert.match(view.repos[0].reason, /^(Using GitHub\. Graphite isn’t set up on this machine\.|Using GitHub\. This repository isn’t set up for Graphite\.)$/); assert.doesNotMatch(view.repos[0].reason, /\bgt\b|\/fix-pr/); }
    } finally { await f.close(); }
  }
  // No local checkout to look at: GitHub, not an error.
  const f = await storeWith(probe({ gt: true, auth: true, init: true }), {});
  try { assert.equal(await f.store.workflow("example/app"), "github"); } finally { await f.close(); }
});

test("detection runs gt never and caches: one probe per repository until Check again", async () => {
  let calls = 0;
  const counting: Probe = { gtInstalled: async () => { calls++; return true; }, signedIn: async () => true, initialised: async () => { calls++; return true; } };
  const f = await storeWith(counting);
  try {
    for (let i = 0; i < 5; i++) await f.store.workflow("example/app");
    assert.equal(calls, 2);
    await f.store.view(["example/app"], true);
    assert.equal(calls, 4);
  } finally { await f.close(); }
});

test("Tom's setup (fakes): gt on PATH, Graphite sign-in, a gt-initialised repo opened from a worktree resolves to Graphite", async () => {
  const root = await mkdtemp(join(tmpdir(), "follow-tom-"));
  try {
    const bin = join(root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "gt"), "#!/bin/sh\nexit 99\n"); await chmod(join(bin, "gt"), 0o755);
    await mkdir(join(root, "config", "graphite"), { recursive: true });
    await writeFile(join(root, "config", "graphite", "auth"), JSON.stringify({ authToken: "synthetic" }));
    // The main checkout has gt's repo config; Paseo's project may point at a worktree whose .git is a file.
    const repo = join(root, "acme-poc"); await mkdir(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    await writeFile(join(repo, ".git", ".graphite_repo_config"), JSON.stringify({ trunk: "main" }));
    await writeFile(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = join(root, "wt"); await mkdir(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    assert.equal(await gitCommonDir(worktree), join(repo, ".git"));
    const plain = join(root, "plain"); await mkdir(join(plain, ".git"), { recursive: true });

    const environment = { PATH: `/nonexistent:${bin}`, XDG_CONFIG_HOME: join(root, "config"), HOME: root };
    const store = new PrWorkflowStore(join(root, "data"), fsProbe(environment));
    store.paths = async () => new Map([["acme/acme-poc", [worktree]], ["tomgrin10/plain", [plain]]]);
    assert.equal(await store.workflow("acme/acme-poc"), "graphite");
    assert.equal(await store.workflow("tomgrin10/plain"), "github");
    // Same machine without gt on PATH: everything is GitHub.
    const bare = new PrWorkflowStore(join(root, "data2"), fsProbe({ ...environment, PATH: "/nonexistent" }));
    bare.paths = store.paths;
    assert.equal(await bare.workflow("acme/acme-poc"), "github");
    // No checkout registered as a Paseo project: a tracked workspace's working directory for that repository is
    // looked at next. The project's plain checkout comes first, the workspace's gt-initialised worktree still wins.
    const fallback = new PrWorkflowStore(join(root, "data3"), fsProbe(environment));
    fallback.paths = async () => new Map([["tomgrin10/transcripts", [plain, worktree]], ["tomgrin10/none", []]]);
    assert.equal(await fallback.workflow("tomgrin10/transcripts"), "graphite");
    const view = await fallback.view(["tomgrin10/transcripts", "tomgrin10/none"]);
    assert.equal(view.repos.find(r => r.repo === "tomgrin10/transcripts")?.path, worktree);
    assert.match(view.repos.find(r => r.repo === "tomgrin10/none")!.reason, /No local checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("overrides win over auto, and an unreadable file means the defaults", async () => {
  const f = await storeWith(probe({ gt: false, auth: false, init: false }));
  try {
    await f.store.mutate(c => { c.repos["example/app"] = { workflow: "graphite" }; });
    assert.equal(await f.store.workflow("Example/App"), "graphite");
    await f.store.mutate(c => { c.default = "graphite"; delete c.repos["example/app"]; });
    assert.equal(await f.store.workflow("example/app"), "graphite");
    await writeFile(join(f.dir, "pr-workflow.json"), "{not json");
    const fresh = new PrWorkflowStore(f.dir, probe({ gt: false, auth: false, init: false }));
    assert.equal((await fresh.read()).default, "auto");
  } finally { await f.close(); }
});

test("review-fix seed: an install with a /fix-pr command keeps it, a fresh one gets the built-in steps, once", async () => {
  const seeded = await storeWith(probe({ gt: true, auth: true, init: true }));
  const fresh = await storeWith(probe({ gt: false, auth: false, init: false }));
  try {
    assert.deepEqual((await seeded.store.migrate(async () => true)).reviewFix, { kind: "command", command: "/fix-pr" });
    assert.deepEqual((await fresh.store.migrate(async () => false)).reviewFix, { kind: "builtin" });
    // Runs once: the developer's later choice is never overwritten.
    await seeded.store.mutate(c => { c.reviewFix = { kind: "builtin" }; });
    assert.deepEqual((await seeded.store.migrate(async () => true)).reviewFix, { kind: "builtin" });
    assert.equal(JSON.parse(await readFile(join(seeded.dir, "pr-workflow.json"), "utf8")).reviewFix.kind, "builtin");
  } finally { await seeded.close(); await fresh.close(); }
});

test("labels: the GitHub option never mentions Graphite", () => {
  assert.doesNotMatch(PR_WORKFLOW_LABELS.github.hint + PR_WORKFLOW_LABELS.github.label, GRAPHITE_WORDS);
  assert.equal(detect({ gtInstalled: false, signedIn: false, path: null, initialised: false }).workflow, "github");
});

// ── Readiness ─────────────────────────────────────────────────────────────────

test("GitHub mode: Merge is offered when GitHub says it's mergeable, with no Graphite blocker", () => {
  const ready = pr({ snapshot: ghSnapshot({ graphiteMergeStatus: null }) });
  assert.deepEqual(mergeBlockers(ready), []);
  const w = workspace({ prs: [ready] });
  assert.ok(needsYou(w).some(i => i.kind === "merge"));
  // No required review: GitHub reports no decision, and that's mergeable too.
  assert.deepEqual(mergeBlockers(pr({ snapshot: ghSnapshot({ reviewDecision: "" }) })), []);
  // Graphite mode, same PR: still waits for Graphite, as before.
  const graphite = pr({ snapshot: snapshot({ reviewDecision: "APPROVED", graphiteMergeStatus: null }) });
  assert.ok(mergeBlockers(graphite).some(b => /Graphite/.test(b)));
  assert.ok(!needsYou(workspace({ prs: [graphite] })).some(i => i.kind === "merge"));
});

test("GitHub mode: blockers name GitHub's cause and fix, never Graphite", () => {
  const cases: [Partial<Snapshot>, RegExp][] = [
    [{ mergeStateStatus: "BEHIND" }, /update the branch/],
    [{ mergeStateStatus: "BLOCKED", threads: [{ id: "t", updatedAt: "x" }] }, /1 unresolved review thread/],
    [{ mergeStateStatus: "BLOCKED" }, /branch protection rule or ruleset/],
    [{ mergeStateStatus: "UNKNOWN" }, /mergeability check/],
    [{ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }, /Changes requested/],
    [{ inMergeQueue: true }, /merge queue/],
  ];
  for (const [patch, expected] of cases) {
    const blockers = mergeBlockers(pr({ snapshot: ghSnapshot(patch) }));
    assert.match(blockers.join(" · "), expected, JSON.stringify(patch));
    assert.doesNotMatch(blockers.join(" "), GRAPHITE_WORDS);
  }
  assert.deepEqual(mergeBlockers(pr({ snapshot: ghSnapshot({ mergeStateStatus: "UNSTABLE" }) })), [], "optional checks failing still merges");
});

test("GitHub mode: the sheet's Merge and Needs you agree; a draft, conflicted or red PR is never offered Merge", async () => {
  const { mergeReady } = await import("../shared/attention");
  for (const patch of [{ draft: true, mergeStateStatus: "DRAFT" }, { conflict: true, mergeStateStatus: "DIRTY" }, { failedChecks: ["ci"], mergeStateStatus: "BLOCKED" }, { checksPending: true, mergeStateStatus: "BLOCKED" }, { mergeStateStatus: "BEHIND" }] as Partial<Snapshot>[]) {
    const p = pr({ snapshot: ghSnapshot(patch) });
    const w = workspace({ prs: [p] });
    assert.equal(mergeReady(p, w), false, JSON.stringify(patch));
    assert.ok(!needsYou(w).some(i => i.kind === "merge"), JSON.stringify(patch));
  }
  const ready = pr({ snapshot: ghSnapshot() });
  assert.equal(mergeReady(ready, workspace({ prs: [ready] })), true);
});

test("GitHub mode: the timeline says Auto-merge, not Merge when ready", async () => {
  const { activity } = await import("../shared/activity");
  const action = (key: string) => ({ id: `a-${key}`, kind: "enable_mwr" as const, prs: [key], heads: {}, createdAt: "2026-01-01T00:00:00Z", state: "submitted" as const, result: "" });
  const gh = pr({ snapshot: ghSnapshot() });
  const rows = activity(workspace({ prs: [gh], prActions: [action(gh.key)] })).map(r => r.text).join(" ");
  assert.match(rows, /Auto-merge on for/);
  assert.doesNotMatch(rows, GRAPHITE_WORDS);
  assert.doesNotMatch(rows, /Merge when ready/);
  const graphite = pr({ snapshot: snapshot() });
  assert.match(activity(workspace({ prs: [graphite], prActions: [action(graphite.key)] })).map(r => r.text).join(" "), /Merge when ready on for/);
});

// ── gh arguments ──────────────────────────────────────────────────────────────

test("gh pr merge arguments per merge method, plus --auto and --disable-auto", () => {
  for (const method of ["squash", "merge", "rebase"] as const) assert.deepEqual(mergeArgs(7, { method, head: "abc" }), ["pr", "merge", "7", `--${method}`, "--match-head-commit", "abc"]);
  assert.deepEqual(mergeArgs(7, { method: "squash", head: "abc", mergeQueue: true }), ["pr", "merge", "7", "--match-head-commit", "abc"]);
  assert.deepEqual(autoMergeArgs(7, { enable: true, method: "rebase", head: "abc" }), ["pr", "merge", "7", "--auto", "--rebase", "--match-head-commit", "abc"]);
  assert.deepEqual(autoMergeArgs(7, { enable: false }), ["pr", "merge", "7", "--disable-auto"]);
  assert.deepEqual(retargetArgs(8, "main"), ["pr", "edit", "8", "--base", "main"]);
  // The saved method only when GitHub still allows it; otherwise GitHub's preferred.
  assert.equal(chooseMethod(repoMerge, "merge"), "merge");
  assert.equal(chooseMethod(repoMerge, "rebase"), "squash");
  assert.equal(chooseMethod({ methods: ["rebase"], preferred: null }, null), "rebase");
});

// ── Stacks, merge and auto-merge through GitHub ───────────────────────────────

test("stacks come from base-branch chains, never overriding a registered parent", () => {
  const bottom = pr({ snapshot: ghSnapshot({ headBranch: "feat-a", base: "main" }) });
  const top = pr({ key: "example/app#2", number: 2, snapshot: ghSnapshot({ headBranch: "feat-b", base: "feat-a" }) });
  const unrelated = pr({ key: "example/app#3", number: 3, snapshot: ghSnapshot({ headBranch: "feat-c", base: "release" }) });
  const w = workspace({ prs: [bottom, top, unrelated] });
  inferBaseChains(w);
  assert.equal(w.prs[1].parent, bottom.key);
  assert.equal(w.prs[2].parent, null);
  // Graphite PRs keep what the agent registered.
  const g = workspace({ prs: [pr({ snapshot: snapshot({ headBranch: "a" }) }), pr({ key: "example/app#2", number: 2, snapshot: snapshot({ headBranch: "b", base: "a" }) })] });
  inferBaseChains(g); assert.equal(g.prs[1].parent, null);
});

async function githubFixture() {
  const root = await mkdtemp(join(tmpdir(), "follow-gh-actions-")); const store = new Store(root);
  const bottom = pr({ snapshot: ghSnapshot({ headBranch: "feat-a", head: "a1" }) });
  const top = pr({ key: "example/app#2", number: 2, parent: bottom.key, snapshot: ghSnapshot({ headBranch: "feat-b", base: "feat-a", head: "b1" }) });
  await store.mutate(s => s.workspaces.push(workspace({ prs: [top, bottom] })));
  let observed: Pr[] = [top, bottom];
  const calls: string[] = []; const graphiteCalls: string[] = [];
  let refuseFirstChildMerge = true;
  const github = {
    observe: async () => new Map(observed.map(p => [p.key, { snapshot: p.snapshot, error: p.error }])),
    merge: async (p: Pick<Pr, "number">, o: { method: string; head: string }) => {
      if (p.number === 2 && refuseFirstChildMerge) { refuseFirstChildMerge = false; const { GithubWriteError } = await import("../server/github"); throw new GithubWriteError("GitHub refused it: not mergeable yet", false); }
      calls.push(`merge #${p.number} ${o.method} ${o.head}`);
    },
    autoMerge: async (p: Pick<Pr, "number">, o: { enable: boolean }) => { calls.push(`auto ${o.enable ? "on" : "off"} #${p.number}`); },
    retarget: async (p: Pick<Pr, "number">, base: string) => { calls.push(`retarget #${p.number} ${base}`); },
  };
  const actions = new PrActions(store, github, { invalidate() {}, merge: async () => { graphiteCalls.push("merge"); } }, new BrowserBridge());
  actions.settle = async () => undefined;
  actions.savedMethod = () => "merge";
  return { store, actions, calls, graphiteCalls, bottom, top, observe: (prs: Pr[]) => { observed = prs; }, close: async () => { await actions.close(); await rm(root, { recursive: true, force: true }); } };
}

test("GitHub mode: downstack merge goes in order, retargets the child after its parent merges, and never calls Graphite", async () => {
  const f = await githubFixture(); try {
    const plan = await f.actions.prepare("workspace", f.top.key, "merge");
    assert.deepEqual(plan.prs.map(p => p.number), [1, 2]);
    assert.ok(plan.prs.every(p => !p.blockers.length), JSON.stringify(plan.prs));
    const reply = await f.actions.confirm(plan.id, "downstack");
    assert.equal(reply.state, "submitted", reply.result);
    assert.equal(reply.merge, "merged", "gh merged both: the button and toast may say Merged (mergeWords)");
    // a-merge-outcome-reads-the-same-everywhere: every surface agrees with "Merged" before the next PR read.
    const { headline, needsYou } = await import("../shared/attention");
    const { activity } = await import("../shared/activity");
    const { stackBar } = await import("../shared/attention");
    const after = (await f.store.snapshot()).workspaces[0];
    assert.deepEqual(after.prs.map(p => p.snapshot?.state), ["MERGED", "MERGED"], "the rows say merged");
    assert.deepEqual([stackBar(after).merged, stackBar(after).total], [2, 2], "the progress bar is full");
    assert.ok(headline(after).some(h => h.text === "All 2 PRs merged"), JSON.stringify(headline(after)));
    assert.ok(!needsYou(after).some(i => i.kind === "merge"), "no Merge row left");
    assert.deepEqual(activity(after).filter(r => /merged|Merge/.test(r.text)).map(r => r.text).sort(), ["#1 merged", "#2 merged"], "Activity says it once per PR, never 'requested'");
    assert.deepEqual(f.calls, ["merge #1 merge a1", "retarget #2 main", "merge #2 merge b1"]);
    assert.deepEqual(f.graphiteCalls, []);
    assert.doesNotMatch(reply.result, GRAPHITE_WORDS);
  } finally { await f.close(); }
});

test("GitHub mode: When ready is GitHub auto-merge, hidden with a reason when the repository doesn't allow it", async () => {
  const f = await githubFixture(); try {
    const status = await f.actions.status("workspace", f.bottom.key);
    assert.equal(status.browser.ready, true);
    assert.equal(status.pr?.mergeWhenReady, false);
    const on = await f.actions.prepare("workspace", f.bottom.key, "enable_mwr");
    assert.equal((await f.actions.confirm(on.id, "target")).state, "submitted");
    const off = await f.actions.prepare("workspace", f.top.key, "disable_mwr");
    await f.actions.confirm(off.id, "downstack");
    assert.deepEqual(f.calls, ["auto on #1", "auto off #1", "auto off #2"]);
    // A repository without auto-merge: no switch, and the reason says why.
    f.observe([f.top, { ...f.bottom, snapshot: { ...f.bottom.snapshot!, repoMerge: { ...repoMerge, autoMerge: false } } }]);
    await f.actions.prepare("workspace", f.bottom.key, "merge"); // refresh the stored snapshot
    const hidden = await f.actions.status("workspace", f.bottom.key);
    assert.equal(hidden.browser.ready, false);
    assert.match(hidden.browser.reason ?? "", /auto-merge/i);
    assert.deepEqual(f.graphiteCalls, []);
  } finally { await f.close(); }
});

test("GitHub mode: observation never asks Graphite, and stamps the workflow and repository merge settings", async () => {
  const graphiteAsked: number[] = [];
  const graphite = { observe: async (prs: Pr[]) => { graphiteAsked.push(...prs.map(p => p.number)); return new Map(); }, status: () => null };
  const repository = { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, autoMergeAllowed: true, viewerDefaultMergeMethod: "REBASE", mergeQueue: null,
    p0: { number: 1, title: "t", url: "u", state: "OPEN", headRefName: "a", headRefOid: "h", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", autoMergeRequest: { enabledAt: "x" }, isInMergeQueue: false, baseRef: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [] } } };
  const run = async (args: string[]) => args[1] === "graphql" ? JSON.stringify({ data: { repository } }) : "[]";
  const github = new Github(run, graphite);
  github.workflow = async () => "github";
  const observed = (await github.observe([pr()])).get("example/app#1")!.snapshot!;
  assert.deepEqual(graphiteAsked, []);
  assert.equal(observed.prWorkflow, "github");
  assert.equal(observed.mergeWhenReady, "on");
  assert.deepEqual(observed.repoMerge, { methods: ["squash", "rebase"], preferred: "rebase", autoMerge: true, mergeQueue: false });
  // The same repository in Graphite mode still asks Graphite.
  github.workflow = async () => "graphite";
  await github.observe([pr()]);
  assert.deepEqual(graphiteAsked, [1]);
});

// ── Agent text ────────────────────────────────────────────────────────────────

test("agent and hook text in GitHub mode contain no Graphite, gt or /fix-pr", () => {
  const texts = [
    hook.batchParagraph(githubFlow), mcp.batchInstructions(githubFlow as never),
    ...Object.entries(main.tools).map(([name, d]) => mcp.describeAction(name, d, "github")),
  ];
  for (const text of texts) assert.doesNotMatch(text, GRAPHITE_WORDS, text);
  assert.match(hook.batchParagraph(githubFlow), /gh pr create/);
  assert.match(hook.batchParagraph(githubFlow), /--force-with-lease/);
  assert.match(mcp.describeAction("merge", main.tools.merge, "github"), /gh pr merge/);
  // Repair tasks: review comments and restacks.
  const w = workspace({ prs: [pr({ snapshot: ghSnapshot({ threads: [{ id: "t", updatedAt: "x" }], reviewDecision: "CHANGES_REQUESTED" }) }),
    pr({ key: "example/app#2", number: 2, parent: "example/app#1", snapshot: ghSnapshot({ base: "feat-a" }) })] });
  w.prs[0].snapshot!.state = "MERGED";
  w.prs[0].snapshot!.threads = [];
  const open = workspace({ prs: [pr({ snapshot: ghSnapshot({ threads: [{ id: "t", updatedAt: "x" }] }) })] });
  for (const t of [...tasksFor(w, Date.now(), { reviewFix: () => null }), ...tasksFor(open, Date.now(), { reviewFix: () => null })]) assert.doesNotMatch(t.title, GRAPHITE_WORDS, t.title);
  assert.match(tasksFor(w, Date.now(), { reviewFix: () => null }).find(t => t.kind === "restack")!.title, /gh pr edit --base main/);
});

test("Graphite-mode agent text is unchanged from main (snapshot)", () => {
  const rest = main.hookBatch.slice(hook.batchParagraph(undefined).length);
  for (const wf of [undefined, null, { mode: "graphite", reviewFix: "/fix-pr" }]) {
    assert.equal(hook.batchParagraph(wf) + rest, main.hookBatch);
    assert.equal(mcp.batchInstructions(wf as never), main.mcpBatch);
  }
  assert.ok(main.hookBatch.startsWith(hook.batchParagraph(undefined)));
  for (const [name, d] of Object.entries(main.tools)) for (const wf of [null, "graphite"]) assert.equal(mcp.describeAction(name, d, wf as never), d);
  const reviewing = workspace({ prs: [pr({ snapshot: snapshot({ threads: [{ id: "t", updatedAt: "x" }] }) })] });
  assert.equal(tasksFor(reviewing)[0].title, "Use /fix-pr for example/app#1 (1 open thread)");
  assert.equal(tasksFor(reviewing, Date.now(), { reviewFix: () => "/fix-pr" })[0].title, "Use /fix-pr for example/app#1 (1 open thread)");
});

test("scopes.json carries each agent's workflow; the summary picks the action tools' wording", () => {
  const w = workspace({ id: "w", mainAgentId: "main", contributorAgentIds: ["helper"] });
  assert.deepEqual(scopes({ version: 1, workspaces: [w] }, () => ({ mode: "github", reviewFix: null })).main, { role: "main", workspaceId: "w", workflow: { mode: "github", reviewFix: null } });
  assert.deepEqual(scopes({ version: 1, workspaces: [w] }).main, { role: "main", workspaceId: "w" }, "without a resolver the file is as before");
  assert.equal(workflowSummary(["github", "github"]), "github");
  assert.equal(workflowSummary(["github", "graphite"]), "mixed");
  assert.equal(workflowSummary([]), null);
});

test("Settings summaries: the glance lines count what each repository ships with and what's set by hand", async () => {
  const { shippingSummary, repoShippingSummary, reposShippingSummary } = await import("../shared/pr-workflow");
  const row = (repo: string, effective: "github" | "graphite", own: Partial<{ inherits: boolean; mergeMethod: "rebase" | null; setting: "auto" | "github" | "graphite" }> = {}) =>
    ({ repo, setting: "auto" as const, detected: effective, effective, reason: "", path: null, inherits: true, mergeMethod: null, reviewFix: null, review: "team" as const, deploy: null, github: null, ...own });
  const repos = [row("a/one", "github"), row("a/two", "github", { mergeMethod: "rebase" }), row("a/three", "graphite"), row("a/four", "github", { inherits: false, setting: "github" })];
  assert.equal(shippingSummary({ default: "auto", repos }), "Auto · GitHub in 3, Graphite in 1");
  assert.equal(shippingSummary({ default: "auto", repos: repos.filter(r => r.effective === "github") }), "Auto · GitHub everywhere");
  assert.equal(shippingSummary({ default: "github", repos: [] }), "GitHub");
  assert.equal(reposShippingSummary(repos), "3 GitHub · 1 Graphite · 2 set here");
  assert.equal(reposShippingSummary(repos.filter(r => r.effective === "github" && r.inherits && !r.mergeMethod)), "1 GitHub");
  assert.equal(repoShippingSummary(repos[0]), "GitHub · Auto");
  assert.equal(repoShippingSummary(repos[1]), "GitHub · Rebase · Auto");
  assert.equal(repoShippingSummary(repos[3]), "GitHub · set here");
  // A GitHub-only machine never reads the word Graphite in these lines.
  assert.doesNotMatch([shippingSummary({ default: "auto", repos: [repos[0]] }), reposShippingSummary([repos[0]]), repoShippingSummary(repos[0])].join(" "), GRAPHITE_WORDS);
});

test("setup's Auto means inherit, like Settings' Default, so trying Graphite then Auto leaves nothing pinned", async () => {
  const { setupWrite, setupValue } = await import("../shared/pr-workflow");
  const auto = { default: "auto" as const };
  assert.deepEqual(setupWrite(auto, "acme/api", "graphite"), { repo: "acme/api", setting: "graphite" });
  assert.deepEqual(setupWrite(auto, "acme/api", "auto"), { repo: "acme/api", setting: null });
  // A GitHub default: choosing Auto is a real override for this repository.
  assert.deepEqual(setupWrite({ default: "github" }, "acme/api", "auto"), { repo: "acme/api", setting: "auto" });
  assert.equal(setupValue(auto, { inherits: true, setting: "auto" }), "auto");
  assert.equal(setupValue(auto, { inherits: false, setting: "graphite" }), "graphite");
  // Through the store: graphite, then back to Auto, inherits again.
  const f = await storeWith(probe({ gt: false, auth: false, init: false }));
  try {
    await f.store.mutate(c => { c.repos["example/app"] = { workflow: "graphite" }; });
    const { setting } = setupWrite(auto, "example/app", "auto");
    await f.store.mutate(c => { if (setting === null) delete c.repos["example/app"]?.workflow; });
    assert.equal((await f.store.view(["example/app"])).repos[0].inherits, true);
  } finally { await f.close(); }
});
