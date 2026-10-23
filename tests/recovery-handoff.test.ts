import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHandoff } from "../server/recovery-handoff";
import { batchSchema } from "../shared/model";
import { workspace } from "./fixtures";
import type { Agent, Daemon } from "../server/daemon";

function fixture() {
  const batch = batchSchema.parse({ id: "recovery", messageId: "message", tasks: [{ key: "inventory:workspace", kind: "inventory", target: "workspace", title: "Inventory", fingerprint: "1" }], state: "blocked", createdAt: "2026-01-01T10:00:00Z", sentAt: "2026-01-01T10:00:01Z", settledAt: null, attempts: 1, result: "", recipientAgentId: "old-helper", contextPath: "/evidence.json" });
  const w = workspace({ batches: [batch] });
  const caller = { id: "replacement", workspaceId: w.id, labels: {}, createdAt: "2026-01-01T10:01:00Z" } as Agent;
  const prior = { id: "old-helper", workspaceId: w.id, archivedAt: "2026-01-01T10:01:00Z" } as Agent;
  const task = "Follow-through recovery recovery\n\nRead /evidence.json and reconcile ownership";
  const histories = new Map<string, unknown[]>([[caller.id, [{ type: "user_message", text: task }]], [prior.id, [{ type: "user_message", text: task }]]]);
  const client = { fetchAgent: async () => ({ agent: prior }), fetchAgentTimeline: async (id: string) => ({ entries: (histories.get(id) ?? []).map((item, i) => ({ seqStart: i, item })), hasOlder: false, error: null, gap: false, staleCursor: false }) } as unknown as Daemon;
  return { client, w, caller, prior, histories, task };
}

test("an exact initial recovery task can follow an archived recipient into another provider", async () => {
  const f = fixture(); f.caller.provider = "codex"; f.prior.provider = "claude";
  assert.deepEqual(await recoveryHandoff(f.client, f.w, f.caller), { batchId: "recovery", fromAgentId: "old-helper" });
  assert.equal(f.w.mainAgentId, "main-agent"); assert.equal(f.w.batches[0].recipientAgentId, "old-helper", "evidence lookup itself does not mutate ownership");
});
test("recovery handoff refuses active recipients, other workspaces, quotes, and completed work", async () => {
  let f = fixture(); f.prior.archivedAt = null; assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
  f = fixture(); f.caller.workspaceId = "different"; assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
  f = fixture(); f.histories.set(f.caller.id, [{ type: "assistant_message", text: f.task }]); assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
  f = fixture(); f.histories.set(f.caller.id, [{ type: "user_message", text: `Historical task: ${f.task}` }]); assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
  f = fixture(); f.w.batches[0].settledAt = "2026-01-01T10:01:00Z"; assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
  f = fixture(); f.w.batches[0].recipientAgentId = f.w.mainAgentId; assert.equal(await recoveryHandoff(f.client, f.w, f.caller), null);
});
