import test from "node:test";
import assert from "node:assert/strict";
import { orderedStacks, prPresentation, settledForDisplay } from "../shared/presentation";
import { pr, snapshot } from "./fixtures";

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
