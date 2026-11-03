import test from "node:test";
import assert from "node:assert/strict";
import { compactPrStatus, orderedStacks, prPresentation, settledForDisplay } from "../shared/presentation";
import { tasksFor } from "../server/tasks";
import { pr, snapshot, workspace } from "./fixtures";

test("active and actionable stacks precede settled history without losing parent order", () => {
  const past = pr({ stack: "Shipped", snapshot: snapshot({ state: "MERGED" }) });
  const waiting = pr({ key: "example/app#2", number: 2, stack: "Ready", snapshot: snapshot({ reviewDecision: "APPROVED" }) });
  const issue = pr({ key: "example/app#3", number: 3, stack: "Repair", snapshot: snapshot({ conflict: true }) });
  assert.deepEqual(orderedStacks([past, waiting, issue]).map(s => s.name), ["Repair", "Ready", "Shipped"]);
  const unexplained = pr({ stack: "Closed but unresolved", snapshot: snapshot({ state: "CLOSED" }) });
  assert.equal(settledForDisplay(unexplained), false);
  assert.equal(settledForDisplay({ ...unexplained, disposition: "Superseded with evidence" }), true);
  assert.equal(settledForDisplay({ ...past, error: "Cannot refresh status" }), false);
});
test("merged and approved have distinct tones, and failed checks cannot look approved", () => {
  assert.equal(prPresentation(pr({ snapshot: snapshot({ state: "MERGED", reviewDecision: "APPROVED" }) })).tone, "merged");
  assert.equal(prPresentation(pr({ snapshot: snapshot({ reviewDecision: "APPROVED" }) })).tone, "approved");
  assert.deepEqual(prPresentation(pr({ snapshot: snapshot({ reviewDecision: "APPROVED", failedChecks: ["Required test"] }) })), { label: "Checks failed", tone: "warning" });
});

test("optional CI failures are visible without implying required CI failed or scheduling repairs", () => {
  for (const reviewDecision of ["", "APPROVED"]) {
    for (const otherFailedChecks of [["demo-approver"], ["demo-approver", "preview"]]) {
      const optional = pr({ snapshot: snapshot({ reviewDecision, failedChecks: [], otherFailedChecks }) });
      const expected = { label: otherFailedChecks.length === 1 ? "Optional check failed" : "Optional checks failed", tone: "warning" };
      assert.deepEqual(prPresentation(optional), expected);
      assert.deepEqual(compactPrStatus(optional), expected);
      assert.deepEqual(tasksFor(workspace({ prs: [optional] })), []);
      const required = { ...optional, snapshot: { ...optional.snapshot!, failedChecks: ["Required test"] } };
      assert.deepEqual(compactPrStatus(required), { label: "Checks failed", tone: "warning" });
      assert.deepEqual(tasksFor(workspace({ prs: [required] })).map(t => t.title), ["Fix required checks on example/app#1: Required test"]);
    }
  }
  const bad = pr({ stack: "Failing CI", snapshot: snapshot({ otherFailedChecks: ["backend-prek"] }) });
  const good = pr({ stack: "Passing CI", snapshot: snapshot({ reviewDecision: "APPROVED" }) });
  assert.deepEqual(orderedStacks([good, bad]).map(s => s.name), ["Failing CI", "Passing CI"]);
});
