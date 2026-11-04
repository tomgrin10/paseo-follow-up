import test from "node:test";
import assert from "node:assert/strict";
import { activity, duration } from "../shared/activity";
import { clock, pr, snapshot, workspace } from "./fixtures";

test("the activity log lists what happened newest first, with how long repairs and answers took", () => {
  const w = workspace({
    prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: "2026-01-01T12:00:00Z", title: "Retry backoff" }) })],
    batches: [{ id: "b1", tasks: [{ key: "k", kind: "conflict", target: "example/app#1", title: "Resolve merge conflicts on example/app#1", fingerprint: "f" }], state: "completed", createdAt: "2026-01-01T09:00:00Z", sentAt: "2026-01-01T09:05:00Z", settledAt: "2026-01-01T09:47:00Z", messageId: "m", attempts: 1, result: "Rebased onto main", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] }],
    questions: [{ id: "Q1", title: "Retry window", question: "How long?", options: [{ letter: "A", label: "An hour" }], recommend: "A", big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: "2026-01-01T10:00:00Z", mode: "work-around", answer: { choice: "A", at: "2026-01-01T11:30:00Z", by: "developer", delivery: { state: "sent", to: "main-agent", messageId: "x", at: "2026-01-01T11:30:00Z", reason: null } }, closed: null }],
    completion: { summary: "Shipped", declaredAt: "2026-01-01T13:00:00Z" },
  });
  const rows = activity(w);
  assert.deepEqual(rows.map(r => r.text), ["Main agent declared Done", "#1 merged", "Q1 answered: A · An hour", "Q1 asked: Retry window", "Main agent finished 1 repair", "Sent 1 repair to the main agent"]);
  assert.equal(rows.find(r => r.key === "done:b1")!.took, "42m");
  assert.equal(rows.find(r => r.key === "answered:Q1")!.took, "1h 30m");
  assert.equal(rows.find(r => r.key === "sent:b1")!.detail, "Resolve merge conflicts on #1");
  assert.equal(duration("2026-01-01T00:00:00Z", "2026-01-03T05:00:00Z"), "2d");
  assert.equal(duration(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(activity(workspace({ prs: [] })).length, 0);
  void clock;
});
