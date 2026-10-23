import test from "node:test";
import assert from "node:assert/strict";
import { Graphite, mergeScheduling } from "../server/graphite";
import { pr } from "./fixtures";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Graphite scheduled merges differ from ready PRs and unknown statuses", () => {
  for (const status of ["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"]) assert.equal(mergeScheduling(status), "on");
  for (const status of ["READY_TO_MERGE", "READY_TO_MERGE_AS_STACK", "NEEDS_APPROVALS", "RUNNING", "WAITING_ON_DOWNSTACK"]) assert.equal(mergeScheduling(status), "off");
  for (const status of [undefined, null, "NEW_STATUS", "HARD_BLOCKED"]) assert.equal(mergeScheduling(status), "unknown");
});

test("Graphite batches every owned stack by repo, caches briefly, and replaces failures with unknown", async () => {
  let now = 0; let fail = false;
  const calls: { repo: string; numbers: number[] }[] = [];
  const graphite = new Graphite(async (repo, numbers) => {
    calls.push({ repo, numbers });
    if (fail) throw new Error("Secret transport detail must stay private");
    return { mergeabilityStatuses: numbers.map(prNumber => ({ prNumber, mergeabilityStatus: prNumber === 1 ? "WAITING_TO_MERGE" : "READY_TO_MERGE" })) };
  }, () => now);
  const prs = [pr(), pr({ key: "example/app#2", number: 2, stack: "Another stack" }), pr({ repo: "other/repo", key: "other/repo#1" })];
  let result = await graphite.observe(prs);
  assert.equal(result.get(prs[0].key), "on"); assert.equal(result.get(prs[1].key), "off");
  assert.deepEqual(calls, [{ repo: "example/app", numbers: [1, 2] }, { repo: "other/repo", numbers: [1] }]);
  await graphite.observe(prs); assert.equal(calls.length, 2);
  now = 30_000; fail = true; result = await graphite.observe(prs);
  assert.ok([...result.values()].every(state => state === "unknown"));
});

test("missing and duplicate Graphite observations cannot be displayed as off", async () => {
  const graphite = new Graphite(async () => ({ mergeabilityStatuses: [{ prNumber: 1, mergeabilityStatus: "READY_TO_MERGE" }, { prNumber: 1, mergeabilityStatus: "QUEUED_TO_MERGE" }] }));
  const result = await graphite.observe([pr(), pr({ key: "example/app#2", number: 2 })]);
  assert.deepEqual([...result.values()], ["unknown", "unknown"]);
});

test("saved CLI authentication is used only for the read-only scheduling route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-graphite-"));
  const savedConfig = process.env.XDG_CONFIG_HOME; const savedFetch = globalThis.fetch;
  try {
    await mkdir(join(directory, "graphite"));
    await writeFile(join(directory, "graphite/auth"), JSON.stringify({ authToken: "synthetic-cli-token" }), { mode: 0o600 });
    process.env.XDG_CONFIG_HOME = directory;
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, "https://api.graphite.com/v1/graphite/mergeability-status");
      assert.equal(options?.method, "POST"); assert.equal(options?.redirect, "error");
      assert.equal(new Headers(options?.headers).get("authorization"), "token synthetic-cli-token");
      assert.deepEqual(JSON.parse(String(options?.body)), { repoOwner: "example", repoName: "app", prNumbers: [1] });
      return new Response(JSON.stringify({ mergeabilityStatuses: [{ prNumber: 1, mergeabilityStatus: "QUEUED_TO_MERGE" }] }));
    }) as typeof fetch;
    assert.equal((await new Graphite().observe([pr()])).get("example/app#1"), "on");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
