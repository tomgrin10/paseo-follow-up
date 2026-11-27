import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rm, trackPersistence } from "./support/store-temp-dir";
import { WATCH_SETTLE_MS, coveredByRepair, parsePrRef, watchVerdict, type CheckWatch, type WatchedPr } from "../shared/check-watch";
import { CheckWatches, checksItemId, type WatchAgent } from "../server/check-watches";
import { hostWatches, waitForChecksAnswer } from "../server/wait-for-checks";
import { RUNNING_POLL_MS, TICK_MS, dueForRead } from "../shared/poll";
import { QUEUE_KINDS, type NewQueueItem } from "../shared/queue";
import { testQueue } from "./support/queue";
import type { Channel } from "../server/message-queue";
import { tools, toolList } from "../server/mcp.mjs";

process.env.FOLLOW_UP_HOOK_IMPORT = "1";
// @ts-expect-error plain JS hook, generated into hook-source.ts
const hook = await import("../server/agent-hook.mjs") as { pollsGithub: (tool: string, input: unknown) => boolean; pollNudge: string; checksLine: string };

const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const watch = (over: Partial<CheckWatch> = {}): CheckWatch => ({ id: "w1", agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "https://github.com/example/app/pull/12", createdAt: iso(T0), until: iso(T0 + 3 * 3600_000), answering: false, runningHead: null, ...over });
type Snap = NonNullable<WatchedPr["snapshot"]>;
const pr = (s: Partial<Snap> = {}, over: Partial<WatchedPr> = {}): WatchedPr => ({ key: "example/app#12", repo: "example/app", number: 12, error: null,
  snapshot: { url: "https://github.com/example/app/pull/12", state: "OPEN", head: "abcdef1234", conflict: false, complete: true, observedAt: iso(T0 + 15_000), failedChecks: [], otherFailedChecks: [], checksPending: false, checksRunning: false, ...s }, ...over });

test("a watch decides only on a read made after it began", () => {
  const before = watchVerdict(watch(), pr({ observedAt: iso(T0 - 1000), failedChecks: ["lint"] }), T0 + 20_000, T0 - 600_000);
  assert.equal(before.fire, null, "a read from before the call may predate the agent's push");
  const after = watchVerdict(watch(), pr({ failedChecks: ["lint"] }), T0 + 20_000, T0 - 600_000);
  assert.equal(after.fire?.kind, "failed");
  assert.match(after.fire!.text, /^Follow-up checks example\/app#12: 1 check failed on abcdef1: lint\. Details: https:\/\/github\.com\/example\/app\/pull\/12\/checks$/);
});

test("all passed needs checks seen running on the head, or a quiet head", () => {
  const running = watchVerdict(watch(), pr({ checksRunning: true, checksPending: true }), T0 + 20_000, T0);
  assert.equal(running.fire, null); assert.equal(running.next.runningHead, "abcdef1234");
  const passed = watchVerdict(running.next, pr({ observedAt: iso(T0 + 45_000) }), T0 + 45_000, T0 + 40_000);
  assert.equal(passed.fire?.kind, "passed", "they finished on the head they ran on");
  // Just pushed: GitHub may list the head before any suite exists. Not "passed" until it has been quiet a while.
  assert.equal(watchVerdict(watch(), pr(), T0 + 20_000, T0 + 10_000).fire, null);
  assert.equal(watchVerdict(watch(), pr(), T0 + 20_000, T0 + 20_000 - WATCH_SETTLE_MS).fire?.kind, "passed");
  assert.equal(watchVerdict(watch(), pr(), T0 + 20_000, null).fire, null, "unknown quiet time: wait for a run or the next read");
  assert.match(watchVerdict(watch(), pr({ checksPending: true }), T0 + 20_000, T0 - WATCH_SETTLE_MS).fire!.text, /required check hasn't reported/);
});

test("merged, closed, a conflict and the time limit end the watch; a required failure doesn't wait for the rest", () => {
  assert.equal(watchVerdict(watch(), pr({ state: "MERGED" }), T0 + 20_000).fire?.kind, "merged");
  assert.equal(watchVerdict(watch(), pr({ state: "CLOSED" }), T0 + 20_000).fire?.kind, "closed");
  assert.equal(watchVerdict(watch(), pr({ conflict: true, checksRunning: true }), T0 + 20_000).fire?.kind, "conflict");
  const early = watchVerdict(watch(), pr({ failedChecks: ["test"], checksRunning: true }), T0 + 20_000);
  assert.equal(early.fire?.kind, "failed"); assert.match(early.fire!.text, /Others are still running/);
  assert.equal(watchVerdict(watch(), pr({ otherFailedChecks: ["docs"], checksRunning: true }), T0 + 20_000).fire, null, "a non-required failure waits for the run to end");
  assert.equal(watchVerdict(watch(), pr({ otherFailedChecks: ["docs"] }), T0 + 20_000).fire?.kind, "failed");
  assert.equal(watchVerdict(watch(), pr({ checksRunning: true }), T0 + 3 * 3600_000).fire?.kind, "expired");
  assert.equal(watchVerdict(watch(), undefined, T0).fire?.kind, "gone");
  assert.equal(watchVerdict(watch(), pr({}, { error: "HTTP 502" }), T0 + 20_000).fire, null, "a failed read decides nothing");
});

test("PR references: URLs, keys and numbers; other forges are named as such", () => {
  assert.deepEqual(parsePrRef("https://github.com/example/app/pull/12/checks"), { repo: "example/app", number: 12, forge: "github" });
  assert.deepEqual(parsePrRef("example/app#12"), { repo: "example/app", number: 12, forge: "github" });
  assert.deepEqual(parsePrRef("#12"), { repo: null, number: 12, forge: "github" });
  assert.equal(parsePrRef("https://gitlab.example.com/acme/app/-/merge_requests/4")?.forge, "other");
  assert.equal(parsePrRef("the big one"), null);
});

// waiting-for-checks-adds-no-github-read: fails on main, where a watched settled PR waits out the 60 s idle interval.
test("a watched PR is read once after the wait began, then at the running-checks cadence, and never under the reserve", () => {
  const base = { snapshot: { state: "OPEN", complete: true, checksRunning: false, checksPending: false } as never, error: null, changedAt: null, now: T0 + 20_000, repoUrgent: false };
  assert.equal(dueForRead({ ...base, readAt: T0 - 5_000, tier: "normal" }), false, "unwatched: settled, read 25 s ago, waits for 60 s");
  assert.equal(dueForRead({ ...base, readAt: T0 - 5_000, tier: "normal", watchedSince: T0 }), true, "the read after the wait began");
  assert.equal(dueForRead({ ...base, readAt: T0 + 10_000, tier: "normal", watchedSince: T0 }), false, "then no more often than the running-checks cadence");
  assert.equal(dueForRead({ ...base, now: T0 + 10_000 + RUNNING_POLL_MS - TICK_MS / 2, readAt: T0 + 10_000, tier: "normal", watchedSince: T0 }), true);
  for (const tier of ["reserve", "critical"] as const) assert.equal(dueForRead({ ...base, readAt: T0 - 5_000, tier, watchedSince: T0 }), false, `${tier}: no read for a watch`);
  assert.equal(dueForRead({ ...base, snapshot: { state: "MERGED", complete: true } as never, readAt: T0 - 5_000, tier: "normal", watchedSince: T0 }), false, "merged is final");
});

function fakeQueue() {
  const items: NewQueueItem[] = []; const channels = new Map<string, Channel>();
  return { items, channels, queue: { enqueue: (i: NewQueueItem) => { items.push(i); }, register: (k: string, c: Channel) => { channels.set(k, c); } } as never };
}
const workspace = (prs: WatchedPr[], over: Record<string, unknown> = {}) => ({ id: "ws1", mainAgentId: "a1", contributorAgentIds: ["c1"], enable_tracking: true, archived: false, enable_auto_sends: false, batches: [], prs, ...over });
async function watches(t: { after: (f: () => Promise<void>) => void }, state: { workspaces: unknown[] }, agent: (id: string) => WatchAgent = () => ({ status: "idle", archived: false, workspaceId: "ws1" }), now = () => T0) {
  const directory = await mkdtemp(join(tmpdir(), "check-watches-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = trackPersistence(directory, new CheckWatches(directory, { snapshot: async () => state as never, agent: async id => agent(id), quietSince: () => T0 - 600_000, now }));
  const q = fakeQueue(); store.attachQueue(q.queue);
  return { store, q, directory };
}

test("a watch fires once, as one checks message, and ends", async t => {
  const state = { workspaces: [workspace([pr({ failedChecks: ["lint"] })])] };
  const { store, q } = await watches(t, state);
  const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 });
  await store.evaluate(); assert.equal(q.items.length, 0, "the tool call still answering owns its verdict");
  await store.answered(w.id, false);
  await store.evaluate(); await store.evaluate(new Set(["ws1"]));
  assert.equal(q.items.length, 1); assert.equal(q.items[0].kind, "checks"); assert.equal(q.items[0].id, checksItemId(w));
  assert.match(q.items[0].text, /1 check failed/);
  assert.deepEqual(await store.list(), []);
  assert.ok(QUEUE_KINDS.includes("checks"));
});

test("a requested verdict reaches a closed agent once after idle unload", async t => {
  const { store, directory } = await watches(t, { workspaces: [workspace([pr({ state: "MERGED" })])] }, () => ({ status: "closed", archived: false, workspaceId: "ws1" }));
  const q = await testQueue(directory); store.attachQueue(q.queue); q.queue.start();
  t.after(async () => { q.queue.stop(); });
  const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 });
  await store.answered(w.id, false); await store.evaluate(); await q.queue.idle(); await store.evaluate(); await q.queue.idle();
  assert.equal(q.delivered.length, 1);
  assert.deepEqual(q.delivered[0].target.recipients, ["a1"]);
  assert.deepEqual(await store.list(), []);
});

test("a watch never wakes an archived agent", async t => {
  for (const agent of [{ status: "closed", archived: true }, { status: "idle", archived: true }]) {
    const { store, q } = await watches(t, { workspaces: [workspace([pr({ state: "MERGED" })])] }, () => ({ ...agent, workspaceId: "ws1" }));
    const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 }); await store.answered(w.id, false);
    await store.evaluate();
    assert.equal(q.items.length, 0, JSON.stringify(agent)); assert.deepEqual(await store.list(), [], "and the watch ends");
  }
  // The channel reopens an unloaded agent, cancels a gone agent, and holds a running turn.
  const { q } = await watches(t, { workspaces: [workspace([])] }, id => id === "closed" ? { status: "closed", archived: false, workspaceId: "ws1" } : id === "archived" ? { status: "closed", archived: true, workspaceId: "ws1" } : id === "gone" ? null : { status: "running", archived: false, workspaceId: "ws1" });
  const channel = q.channels.get("checks")!;
  const item = (agentId: string) => ({ ref: { agentId, workspaceId: "ws1" }, state: "queued" }) as never;
  assert.deepEqual(await channel.resolve(item("closed")), { target: { workspaceId: "ws1", recipients: ["closed"] } });
  assert.ok("cancel" in await channel.resolve(item("gone")));
  assert.ok("cancel" in await channel.resolve(item("archived")));
  assert.deepEqual(await channel.resolve(item("busy")), { defer: "waits for the agent's turn to end" });
});

test("a waited-for failure is sent once: the repair carries it when Auto-send will send it", async t => {
  const batches = [{ state: "pending", tasks: [{ kind: "checks", target: "example/app#12" }] }];
  assert.equal(coveredByRepair(workspace([], { enable_auto_sends: true, batches }) as never, "a1", "example/app#12"), true);
  assert.equal(coveredByRepair(workspace([], { enable_auto_sends: false, batches }) as never, "a1", "example/app#12"), false, "Auto-send off: the watch sends it");
  assert.equal(coveredByRepair(workspace([], { enable_auto_sends: true, batches }) as never, "c1", "example/app#12"), false, "a contributor waiting gets its own message");
  const { store, q } = await watches(t, { workspaces: [workspace([pr({ failedChecks: ["lint"] })], { enable_auto_sends: true, batches })] });
  const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 }); await store.answered(w.id, false);
  await store.evaluate();
  assert.equal(q.items.length, 0); assert.equal(store.fired[0].why, "repair"); assert.deepEqual(await store.list(), []);
});

test("watches survive a restart and expire after their limit", async t => {
  let now = T0;
  const state = { workspaces: [workspace([pr({ checksRunning: true })])] };
  const { store, q, directory } = await watches(t, state, undefined, () => now);
  const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 60 * 60_000 });
  await store.flush();
  const again = trackPersistence(directory, new CheckWatches(directory, { snapshot: async () => state as never, agent: async () => ({ status: "idle", archived: false, workspaceId: "ws1" }), now: () => now }));
  again.attachQueue(q.queue);
  assert.equal((await again.list())[0].answering, false, "a call cut off by the restart leaves the watch to message");
  await again.evaluate(); assert.equal(q.items.length, 0);
  now = T0 + 61 * 60_000; await again.evaluate();
  assert.equal(q.items.length, 1); assert.match(q.items[0].text, /stopped waiting after the time limit/);
  assert.equal(q.items[0].id, checksItemId(w));
});

test("the tool answers at once from its own workspace's read, and points elsewhere for PRs it can't see", async t => {
  const state = { workspaces: [workspace([pr({ state: "MERGED" }), pr({ checksRunning: true }, { key: "example/app#13", number: 13 })])] };
  const { store, q } = await watches(t, state);
  let nudged = 0;
  const deps = { state: async () => state as never, watches: store, nudge: async () => { nudged++; }, hostVersion: async () => "0.17.1", readMs: 50 };
  const answer = await waitForChecksAnswer({ agentId: "a1", prs: ["#12", "https://github.com/example/app/pull/13"] }, deps);
  assert.equal(nudged, 1, "one nudge of the caller's workspace, no read of its own");
  assert.deepEqual(answer.done.map(d => d.result), ["merged"]); assert.deepEqual(answer.waiting, ["example/app#13"]);
  assert.match(answer.text, /End your turn now/);
  await store.evaluate(); assert.equal(q.items.length, 0, "the merged one was answered in the call, not messaged too");
  const other = await waitForChecksAnswer({ agentId: "a1", prs: ["https://gitlab.example.com/acme/app/-/merge_requests/4"] }, deps);
  assert.match(other.text, /subscribe_change_request/);
  const untracked = await waitForChecksAnswer({ agentId: "stranger" }, { ...deps, hostVersion: async () => "0.16.2" });
  assert.match(untracked.text, /doesn't follow this workspace/); assert.match(untracked.text, /check it once later/);
  assert.equal(hostWatches("0.17.0"), true); assert.equal(hostWatches("0.16.9"), false); assert.equal(hostWatches(""), false);
  const registered: string[] = [];
  await waitForChecksAnswer({ agentId: "a1", prs: ["example/app#20"] }, { ...deps, register: async (repo, n) => { registered.push(`${repo}#${n}`); } });
  assert.deepEqual(registered, ["example/app#20"], "the caller's own PR, not followed yet, is registered");
  assert.equal((await waitForChecksAnswer({ agentId: "a1", cancel: true }, deps)).text, "Stopped waiting on 1 PR.");
});

test("every root agent gets wait_for_checks; recovery doesn't", () => {
  const names = (list: unknown[][]) => list.map(t => t[0]);
  assert.ok(tools.some((t: unknown[]) => t[0] === "wait_for_checks"));
  assert.ok(names(toolList(false, false, true, false, true)).includes("wait_for_checks"), "main");
  assert.ok(names(toolList(false, true, false, false, true)).includes("wait_for_checks"), "contributor");
  assert.ok(names(toolList(false, false, true, true, true)).includes("wait_for_checks"), "untracked root");
  assert.ok(!names(toolList(true, false, false, false, false)).includes("wait_for_checks"), "recovery");
});

// Real command shapes (fictional repos): polling is nudged, one look is not.
const POLLING = [
  "gh pr checks 12 --watch", "gh pr checks 12 --watch --fail-fast", "gh run watch 123", "while true; do gh pr checks 12; sleep 30; done",
  "until gh pr checks 12 | grep -q pass; do sleep 20; done", "for i in $(seq 60); do gh pr view 7 --json statusCheckRollup; sleep 10; done",
  "sleep 300 && gh pr checks 9", "while sleep 30; do gh api graphql -f query=@q.graphql; done", "watch -n 30 gh pr status",
  "for n in 1 2 3; do gh run list --branch feat -L 1; sleep 45; done", "while :; do gh api repos/acme/app/commits/abc/check-runs; sleep 15; done",
];
const LOOKING = [
  "gh pr checks 12", "gh pr view 12 --json title", "sleep 5 && npm test", "for f in *.ts; do npx prettier -w $f; done", "gh pr create --fill",
  "gh api user", "git push && gh pr checks 12", "while read l; do echo $l; done < f.txt", "gh run view 123 --log-failed",
  "for pr in 1 2 3; do gh pr merge $pr --squash; done", "for pr in 4 5 6; do gh pr view $pr --json title; done", "gh api repos/acme/app/pulls/3/comments",
  "npm run build && sleep 2 && curl localhost:3000",
];
test("the polling matcher: every polling shape, no single look", () => {
  for (const command of POLLING) assert.equal(hook.pollsGithub("Bash", { command }), true, command);
  for (const command of LOOKING) assert.equal(hook.pollsGithub("Bash", { command }), false, command);
  assert.equal(hook.pollsGithub("Monitor", { command: "until [ \"$(gh pr view 4 --json state -q .state)\" = MERGED ]; do sleep 60; done", description: "PR 4" }), true, "Monitor");
  assert.equal(hook.pollsGithub("exec_command", { cmd: ["bash", "-lc", "gh run watch 9"] }), true, "Codex");
  assert.equal(hook.pollsGithub("Edit", { new_string: "while true; do gh pr checks; sleep 1; done" }), false, "only shell tools");
  assert.equal(hook.pollsGithub("Read", { file_path: "/tmp/gh-loop.sh" }), false);
});

test("the polling nudge never blocks a command and comes at most once per turn", async t => {
  const root = await mkdtemp(join(tmpdir(), "poll-nudge-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "scopes.json"), JSON.stringify({ agents: { a1: { role: "main", workspaceId: "w1" } } }));
  const fire = (agent: string, event: object) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: agent, FOLLOW_UP_BRIEF: "", FOLLOW_UP_RECOVERY: "", FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: "claude", FOLLOW_UP_ROOT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
  for (const agent of ["a1", "untracked"]) {
    const start = await fire(agent, { hook_event_name: "SessionStart" });
    assert.match(start, /follow_wait_for_checks/, `${agent}: the SessionStart line`);
    await fire(agent, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const poll = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "while true; do gh pr checks 12; sleep 30; done" } };
    const first = await fire(agent, poll);
    const parsed = JSON.parse(first);
    assert.equal(parsed.decision, undefined, "context only, never a block");
    assert.match(parsed.hookSpecificOutput.additionalContext, /call follow_wait_for_checks/);
    assert.doesNotMatch(await fire(agent, poll), /wait_for_checks/, `${agent}: once per turn`);
    assert.doesNotMatch(await fire(agent, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr checks 12" } }), /wait_for_checks/);
    await fire(agent, { hook_event_name: "UserPromptSubmit", prompt: "again" });
    assert.match(await fire(agent, poll), /wait_for_checks/, `${agent}: a new turn can be nudged again`);
  }
});

test("an archived workspace cancels checks before enqueue and before send", async t => {
  const state = { workspaces: [workspace([pr({ state: "MERGED" })])] };
  const { store, q } = await watches(t, state);
  const w = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 });
  await store.answered(w.id, false); await store.evaluate();
  state.workspaces[0].archived = true;
  assert.ok("cancel" in await q.channels.get("checks")!.resolve(q.items[0] as never));
  const again = await store.add({ agentId: "a1", workspaceId: "ws1", prKey: "example/app#12", url: "", ms: 3600_000 });
  await store.answered(again.id, false); await store.evaluate();
  assert.equal(q.items.length, 1, "nothing enqueued after archive");
  assert.deepEqual(await store.list(), []);
});
