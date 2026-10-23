import test from "node:test";
import assert from "node:assert/strict";
import { excludeStack } from "../server/exclusions";
import { applyHistory, extractHistory } from "../server/discovery";
import { workspace, pr } from "./fixtures";

test("scope exclusion preserves evidence and suppresses rediscovery of historical references", () => {
  const external = pr({ stack: "Unrelated work" });
  const owned = pr({ key: "example/app#2", number: 2, stack: "Actual goal" });
  const w = workspace({ prs: [external, owned], obligations: [{ id: "external-rollout", title: "Deploy unrelated work", status: "waiting", afterPrs: [external.key], evidence: "Existing record", enable_follow_up: true, revision: 1 }, { id: "related", title: "Verify actual rollout", status: "pending", afterPrs: [owned.key], evidence: "", enable_follow_up: false, revision: 0 }], inventory: { revision: 1, syncedRevision: 1, candidates: [], historyComplete: true, historyError: null, scannedMessageAt: null } });
  excludeStack(w, external.stack, "Developer confirmed it is outside this workspace", [], "2026-01-01T11:00:00Z");
  assert.deepEqual(w.prs.map(p => p.key), [owned.key]); assert.deepEqual(w.obligations.map(o => o.id), ["related"]);
  assert.deepEqual(w.excludedStacks[0].prs, [external]); assert.equal(w.excludedStacks[0].obligations[0].evidence, "Existing record");
  applyHistory(w, extractHistory([{ type: "user_message", text: "Reference https://github.com/example/app/pull/1" }]), "new-message");
  assert.equal(w.inventory!.revision, 1); assert.equal(w.mainAgentId, "main-agent");
  excludeStack(w, external.stack, "Repeated correction", [], "2026-01-01T12:00:00Z"); assert.equal(w.excludedStacks.length, 1);
});
test("cross-stack parentage must be reconciled before excluding owned dependencies", () => {
  const parent = pr({ stack: "Parent" });
  const child = pr({ key: "example/app#2", number: 2, stack: "Child", parent: parent.key });
  const w = workspace({ prs: [parent, child] });
  assert.throws(() => excludeStack(w, "Parent", "Outside scope", [], "now"), /dependent PRs/);
  assert.equal(w.prs.length, 2); assert.equal(w.excludedStacks.length, 0);
});
