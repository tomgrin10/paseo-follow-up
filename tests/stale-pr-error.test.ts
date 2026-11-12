import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { Github } from "../server/github";
import type { GithubApi } from "../server/github-api";
import { compactPrStatus, prPresentation, settledForDisplay, orderedStacks, staleHint } from "../shared/presentation";
import { liveLine, prTone } from "../shared/attention";
import { summary } from "../shared/model";
import { violations } from "../shared/status-invariants";
import { clock, pr, snapshot, workspace } from "./fixtures";

/**
 * 2026-11-12, live 2.0.1-beta.1: 13 merged PRs in three workspaces kept "Unknown" for good. Each had a complete MERGED
 * snapshot (observed 2026-11-09) and an `error` that 2.0.1-beta.0's RATE_LIMIT failures had persisted. The panel let
 * the error win over the snapshot, and merged-is-final (#127) skipped the read only for error-free PRs, while the
 * workspaces were dormant and never observed, so nothing cleared it. Invariant a-github-limit-never-blanks-a-known-pr.
 */
const ERROR = "GitHub status unavailable; check gh authentication and repository access";
const live = () => pr({ key: "example/app#1284", number: 1284, snapshot: snapshot({ state: "MERGED", observedAt: "2025-12-29T10:00:00.000Z" }), error: ERROR });

test("a-github-limit-never-blanks-a-known-pr: a complete snapshot shows its own status whatever error a later read left", () => {
  const merged = live();
  assert.equal(prPresentation(merged).label, "Merged");
  assert.equal(compactPrStatus(merged).label, "Merged");
  assert.equal(prTone(merged), "merged");
  assert.equal(settledForDisplay(merged), true, "a merged PR folds as settled");
  assert.equal(staleHint(merged, () => "3d ago"), "Last checked 3d ago", "the error adds at most a quiet hint");
  const open = pr({ snapshot: snapshot({ state: "OPEN", reviewDecision: "APPROVED" }), error: ERROR });
  assert.equal(prPresentation(open).label, "Approved", "an open PR keeps its last known status too");
  const w = workspace({ prs: [merged, open] });
  assert.doesNotMatch(liveLine(w, clock).text, /unavailable/i);
  assert.doesNotMatch(summary(w, clock).reason, /unavailable/i);
  assert.equal(orderedStacks([merged]).length, 1);
  // Only a PR with no complete read says so.
  assert.equal(prPresentation(pr({ snapshot: null, error: ERROR })).label, "Status unavailable");
  assert.equal(compactPrStatus(pr({ snapshot: snapshot({ complete: false }), error: null })).label, "Unknown");
});

test("a-github-limit-never-blanks-a-known-pr: the merged-is-final skip clears a stored error without a read", async () => {
  let graphql = 0;
  const api: GithubApi = { graphql: async () => { graphql++; return { data: { repository: null } }; }, rest: async () => [] };
  const github = new Github(undefined, undefined, undefined, api, () => clock);
  const merged = live();
  for (const o of [{}, { background: true }]) {
    const result = await github.observe([merged], o);
    assert.equal(graphql, 0, "merged is final: no read");
    assert.equal(result.get(merged.key)!.error, null, "the skip reports no error, so the engine clears it");
    assert.equal(result.get(merged.key)!.snapshot?.state, "MERGED");
  }
});

test("a-github-limit-never-blanks-a-known-pr: loading state.json heals a merged PR's persisted error (no Refresh)", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The live shape, on disk as beta.1 wrote it, in a dormant workspace the engine never observes.
  const open = pr({ key: "example/app#1290", number: 1290, snapshot: snapshot({ state: "OPEN" }), error: ERROR });
  await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, workspaces: [workspace({ dormant: true, prs: [live(), open] })] }));
  const w = (await new Store(root).snapshot()).workspaces[0];
  assert.equal(w.prs[0].error, null, "a merged PR with a complete snapshot loads without its stale error");
  assert.equal(w.prs[1].error, ERROR, "an open PR keeps its error: its status can still move, and the next read decides");
  assert.equal(prPresentation(w.prs[0]).label, "Merged");
  assert.deepEqual(violations(w, clock).filter(v => v.id === "a-github-limit-never-blanks-a-known-pr"), []);
});

test("a-github-limit-never-blanks-a-known-pr: the invariant flags the shape that blanked PRs", () => {
  const w = workspace({ prs: [live()] });
  assert.ok(violations(w, clock).some(v => v.id === "a-github-limit-never-blanks-a-known-pr"), "a merged, complete PR still carrying an error is a violation");
});

test("a-github-limit-never-blanks-a-known-pr: the developer's Refresh of a dormant workspace reads its PRs and clears errors", async t => {
  const { Engine } = await import("../server/engine");
  const root = await mkdtemp(join(tmpdir(), "follow-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An open PR in the same dormant workspace: the error a later read can clear only if Refresh reads it at all.
  const open = pr({ key: "example/app#1324", number: 1324, snapshot: snapshot({ state: "OPEN" }), error: ERROR });
  const store = new Store(root); await store.mutate(s => { s.workspaces.push(workspace({ id: "dormant", dormant: true, prs: [live(), open] })); });
  const read: string[][] = []; const runtimes: string[] = [];
  const github = { observe: async (prs: any[]) => { read.push(prs.map(p => p.key)); return new Map(prs.map(p => [p.key, { snapshot: { ...p.snapshot, observedAt: new Date(clock).toISOString() }, error: null }])); } };
  const gateway = { observe: async (w: any) => { runtimes.push(w.id); return { busy: false, reason: null, archived: false }; }, send: async () => {}, label: async () => {}, prepareRecovery: async () => ({ agentId: "recovery-agent", contextPath: "/fixture/recovery.json" }) };
  const engine = new Engine(store, github as never, gateway as never, () => clock);
  await engine.tick({ background: true });
  assert.deepEqual(read, [], "a background tick never reads a dormant workspace");
  await engine.tick({ workspaceId: "dormant" });
  assert.deepEqual(read, [["example/app#1284", "example/app#1324"]], "Refresh reads the dormant workspace's PRs");
  assert.deepEqual(runtimes, [], "and only its PRs: the dormant agent isn't observed");
  const w = (await store.snapshot()).workspaces[0];
  assert.deepEqual(w.prs.map(p => p.error), [null, null]);
});
