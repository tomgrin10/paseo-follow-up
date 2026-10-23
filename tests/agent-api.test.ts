import test from "node:test";
import assert from "node:assert/strict";
import { obligationRpc, registerPrRpc, agentStatusRpc, acknowledgeRpc } from "../shared/contracts";
import { updateObligation } from "../server/obligations";
import { workspace } from "./fixtures";

test("agent RPCs reject invented fields at every scheduling level", () => {
  const base = { agentId: "main-agent", title: "Recheck behavior", status: "waiting" };
  assert.equal(obligationRpc.input.safeParse({ ...base, dependsOnPrs: [1] }).success, false);
  assert.equal(obligationRpc.input.safeParse({ ...base, trigger: { event: "deploy", delayWeeks: 2 } }).success, false);
  assert.equal(obligationRpc.input.safeParse({ ...base, communication: { threadUrl: "https://example.slack.com/archives/C123/p1767261600000000", recipient: "Requester", permitted: true } }).success, false);
  assert.equal(registerPrRpc.input.safeParse({ agentId: "main-agent", repo: "example/app", number: 1, stack: "Fix", parent: 2 }).success, false);
  assert.equal(agentStatusRpc.input.safeParse({ agentId: "main-agent", workspaceId: "other" }).success, false);
  assert.equal(acknowledgeRpc.input.safeParse({ agentId: "main-agent", batchId: "batch", outcome: "completed", result: "Checked", force: true }).success, false);
});
test("ordinary agent edits preserve dependencies, evidence and explicit timing; completion needs fresh results", () => {
  const w = workspace();
  const o = updateObligation(w, { title: "Recheck behavior", status: "waiting", afterPrs: [w.prs[0].key], evidence: "Baseline evidence", trigger: { event: "deploy", delayDays: 14 } });
  const input = obligationRpc.input.parse({ agentId: "main-agent", id: o.id, title: o.title, status: "waiting" });
  updateObligation(w, input);
  assert.deepEqual(o.afterPrs, [w.prs[0].key]); assert.equal(o.evidence, "Baseline evidence"); assert.deepEqual(o.trigger, { event: "deploy", delayDays: 14 });
  assert.throws(() => updateObligation(w, { ...input, status: "done" }), /result evidence/);
  updateObligation(w, { ...input, status: "done", evidence: "Verified the actual result" }); assert.equal(o.status, "done");
});
test("partial reply metadata preserves existing authorization, purpose and sent receipts", () => {
  const w=workspace();
  const communication={threadUrl:"https://example.slack.com/archives/C123/p1767261600000000",recipient:"Requester",purpose:"verified" as const,authorization:"Developer explicitly requested this reply",replyUrl:null};
  const o=updateObligation(w,{title:"Verify and reply",status:"waiting",communication,evidence:"Current evidence"});
  const edit=obligationRpc.input.parse({agentId:"main-agent",id:o.id,title:o.title,status:"waiting",communication:{threadUrl:communication.threadUrl,recipient:communication.recipient}});
  updateObligation(w,edit);assert.deepEqual(o.communication,communication);assert.equal(o.evidence,"Current evidence");
});
