import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { submittedPrs, reconcileSubmittedStacks } from "../server/submissions";
import { PaseoGateway, type Daemon, type Agent, type withDaemon } from "../server/daemon";
import { applyDiscovery, extractHistory } from "../server/discovery";
import { workspace, pr, snapshot, clock } from "./fixtures";

const shell = (command: string, output: string, patch = {}) => ({ type: "tool_call", name: "Bash", status: "completed", error: null, detail: { type: "shell", command, output }, ...patch });
const url = (n: number, domain = "com") => `https://app.graphite.${domain}/github/pr/example/app/${n}`;
test("submission receipts distinguish authored work from mentions, reads, failures and dry runs", () => {
  const created = shell("cd /scratch/wt2a; gt submit --no-interactive --publish 2>&1 | tail -8", `feature: ${url(2)} (created)\nView your PR at ${url(2)}`);
  assert.deepEqual(submittedPrs([created], "root", "example/app"), [{ repo: "example/app", number: 2, agentId: "root", branch: "feature" }]);
  assert.equal(submittedPrs([shell("gt submit --publish", `View your PR at ${url(3)}`)], "root", "example/app")[0].number, 3, "truncated submit output still has a receipt");
  assert.equal(submittedPrs([shell("cd /scratch; gh pr create --title Change", "https://github.com/example/app/pull/4")], "root", "example/app")[0].number, 4);
  for (const item of [
    { type: "assistant_message", text: url(2) },
    shell("cat docs/pr-example.md", `feature: ${url(2)} (created)`),
    shell("gh pr view 2", url(2)),
    shell("cat 'quoted; gt submit'", `feature: ${url(2)} (created)`),
    shell(String.raw`python -c "print(\"; gt submit\")"`, `feature: ${url(2)} (created)`),
    shell("cat file # gt submit", `feature: ${url(2)} (created)`), shell("gt submit --help", `View your PR at ${url(2)}`),
    shell("gt submit --dry-run", `feature: ${url(2)} (created)`),
    shell("printf 'gt submit'", `feature: ${url(2)} (created)`),
    shell("gt submit", `feature: ${url(2)} (created)`, { status: "failed" }),
    shell("gt submit", `feature: ${url(2)} (created)`, { error: { message: "Unknown result" } }),
    shell("gt submit", "feature: https://app.graphite.com/github/pr/other/repo/2 (created)"),
    shell("gt submit", `feature: ${url(2)}fake (created)`),
  ]) assert.deepEqual(submittedPrs([item], "root", "example/app"), [], JSON.stringify(item));
  assert.equal(submittedPrs([shell(`cd /scratch; gt submit --publish; echo PR=2; printf 'footer'`, `feature: ${url(2)} (created)\nPR=2`)], "root", "example/app")[0].number, 2);
  assert.deepEqual(submittedPrs([created], "root", null), []);
  assert.deepEqual(extractHistory([{ type: "assistant_message", text: url(2) }]).candidates, ["example/app#2"], "current Graphite domain also appears as a candidate, without ownership");
});

test("PRs submitted from a real secondary worktree are discovered after the workspace branch merged and its original owner disappeared", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-cross-worktree-")); t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile); const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-b", "workspace-branch"); await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
  const secondary = join(root, "scratch", "wt2a"); await git("worktree", "add", "-b", "new-bottom", secondary);
  const w = workspace({ mainAgentId: "old-owner", prs: [pr({ snapshot: snapshot({ state: "MERGED", headBranch: "workspace-branch" }) })] });
  const a = { id: "current-root", workspaceId: w.id, labels: {}, archivedAt: null, lastUserMessageAt: "new-turn", status: "running", createdAt: "2026-01-01" } as Agent;
  let calls = 0; let items = [shell(`cd ${secondary}; gt submit --no-interactive --publish`, `new-bottom: ${url(2)} (created)\nnew-top: ${url(3)} (created)` )];
  const client = {
    fetchAgents: async () => ({ entries: [{ agent: a }, { agent: { ...a, id: "child", labels: { "paseo.parent-agent-id": a.id } } }], pageInfo: { hasMore: false } }),
    fetchWorkspaces: async () => ({ entries: [{ id: w.id, name: w.title, projectId: "project" }], pageInfo: { hasMore: false } }),
    listProjects: async () => ({ projects: [{ projectId: "project", projectKey: "remote:github.com/example/app", projectKind: "git" }] }),
    fetchAgentTimeline: async (id: string) => { assert.equal(id, a.id); calls++; return { entries: items.map((item, seqStart) => ({ item, seqStart })), hasOlder: false, error: null, gap: false, staleCursor: false }; },
  } as unknown as Daemon;
  const gateway = new PaseoGateway((async work => work(client)) as typeof withDaemon);
  const state = { version: 1 as const, workspaces: [w] };
  applyDiscovery(state, await gateway.discover(state), clock);
  assert.equal((await git("branch", "--show-current")).stdout.trim(), "workspace-branch");
  assert.equal((await exec("git", ["-C", secondary, "branch", "--show-current"])).stdout.trim(), "new-bottom");
  assert.deepEqual(w.prs.map(p => p.number), [1, 2, 3]); assert.equal(w.mainAgentId, "old-owner");
  assert.deepEqual(w.contributorAgentIds, [a.id]); assert.ok(w.prs.slice(1).every(p => p.registeredAgentId === a.id));
  applyDiscovery(state, await gateway.discover(state), clock); assert.equal(calls, 1); assert.equal(w.prs.length, 3);
  items = [...items, shell(`cd ${secondary}; gh pr create --title Another`, "https://github.com/example/app/pull/4")];
  gateway.markDirty(a.id); applyDiscovery(state, await gateway.discover(state), clock);
  assert.deepEqual(w.prs.map(p => p.number), [1, 2, 3, 4]); assert.equal(calls, 2);
});

test("automatic receipts preserve exclusions, explicit registrations and another workspace's ownership", () => {
  const w = workspace({ completion: { summary: "Old work finished", declaredAt: new Date(clock).toISOString() }, excludedStacks: [{ name: "Excluded", reason: "Not ours", excludedAt: "then", prs: [pr({ key: "example/app#3", number: 3 })], obligations: [] }] });
  const other = workspace({ id: "other", prs: [pr({ key: "example/app#4", number: 4 })] });
  const state = { version: 1 as const, workspaces: [w, other] };
  applyDiscovery(state, [{ id: w.id, title: w.title, mainAgentId: w.mainAgentId, messageAt: null, submissions: [1, 2, 3, 4].map(number => ({ repo: "example/app", number, agentId: "root", branch: "new" })) }], clock);
  assert.deepEqual(w.prs.map(p => p.number), [1, 2]); assert.equal(w.prs[0].registeredAgentId, undefined); assert.equal(w.completion, null);
  w.prs[1].snapshot = snapshot({ headBranch: "bottom", base: "main" });
  w.prs.push(pr({ key: "example/app#5", number: 5, discoveredFromSubmission: true, stack: "top", snapshot: snapshot({ headBranch: "top", base: "bottom" }) }));
  reconcileSubmittedStacks(w); assert.equal(w.prs.at(-1)!.parent, "example/app#2"); assert.equal(w.prs.at(-1)!.stack, "bottom");
  w.prs.at(-1)!.discoveredFromSubmission = false; w.prs.at(-1)!.stack = "Explicit"; w.prs.at(-1)!.parent = null;
  reconcileSubmittedStacks(w); assert.equal(w.prs.at(-1)!.stack, "Explicit"); assert.equal(w.prs.at(-1)!.parent, null);
});
