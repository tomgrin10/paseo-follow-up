import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checksState, prPresentation, compactPrStatus, CHECKS_NOT_STARTED } from "../shared/pr-status";
import { nowOf, type AgentFacts } from "../shared/now";
import { liveLine } from "../shared/attention";
import { prChip } from "../shared/home";
import { mergeBlockers } from "../shared/pr-actions";
import { INVARIANTS } from "../shared/status-invariants";
import { clock, pr, snapshot, workspace } from "./fixtures";

// 2026-11-27, the developer: the panel's agent line read "Waiting on CI for #9602". That PR is an upstream fork PR with
// no check runs at all: the upstream repository's required checks never start for it. server/github.ts sets
// checksPending when a required check is missing or running (right for merge blocking), and every display read it as
// "running". Invariant 136 (`checks-say-what-they-are-doing`): one helper, checksState, says what the checks are doing.

const ROOT = join(import.meta.dirname, "..");
const main: AgentFacts = { agentId: "main-agent", role: "main", status: "idle" };
const neverRan = snapshot({ checksPending: true, checksRunning: false });
const running = snapshot({ checksPending: true, checksRunning: true });

test("checksState: failed, running, not started, passed", () => {
  assert.equal(checksState(snapshot({ failedChecks: ["lint"], checksPending: true, checksRunning: true })), "failed");
  assert.equal(checksState(running), "running");
  assert.equal(checksState(neverRan), "not-started");
  assert.equal(checksState(snapshot()), "passed");
  // A snapshot stored before checksRunning existed reads as before until its next read.
  assert.equal(checksState(snapshot({ checksPending: true })), "running");
});

test("a required check that never reported is never \"running\" or \"waiting on CI\"", () => {
  const w = workspace({ prs: [pr({ snapshot: neverRan })] });
  const line = nowOf(w, main, clock);
  assert.doesNotMatch(line.state.text, /CI|running/i, "the agent line says nothing about CI");
  assert.equal(line.waitingOn, null);
  assert.equal(prPresentation(w.prs[0]!).label, CHECKS_NOT_STARTED);
  assert.equal(compactPrStatus(w.prs[0]!).label, CHECKS_NOT_STARTED);
  assert.doesNotMatch(liveLine(w, clock).text, /running/i);
  assert.doesNotMatch(prChip(w)?.checks?.text ?? "", /checking/i);
  // Merge blocking keeps checksPending: the PR still can't merge, and says why in plain words.
  assert.ok(mergeBlockers(w.prs[0]!).includes("Required checks not started"));
  // Running checks still read as running.
  const r = workspace({ prs: [pr({ snapshot: running })] });
  assert.equal(nowOf(r, main, clock).state.text, "Waiting on CI for #1");
  assert.equal(prPresentation(r.prs[0]!).label, "Checks running");
});

test("the invariant catches a row that calls never-run checks running", () => {
  const inv = INVARIANTS.find(i => i.id === "checks-say-what-they-are-doing")!;
  assert.equal(inv.check(workspace({ prs: [pr({ snapshot: neverRan })] }), clock), null);
  assert.equal(inv.check(workspace({ prs: [pr({ snapshot: running })] }), clock), null);
});

test("no display reads checksPending as running: every surface asks checksState", async () => {
  for (const f of ["shared/now.ts", "shared/pr-status.ts", "client/stacks.tsx", "client/pr-sheet.tsx", "shared/home.ts", "shared/brief.ts", "shared/attention.ts"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    assert.ok(src.includes("checksState("), `${f} uses checksState`);
    for (const line of src.split("\n")) if (!line.includes("checksRunning ??") && /running|Waiting on CI|Spinner|Checking|PR_CHECKING_WORD/.test(line) && /\.checksPending\b/.test(line)) assert.fail(`${f} reads checksPending as running: ${line.trim()}`);
  }
});
