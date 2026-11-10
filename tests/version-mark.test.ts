import test from "node:test";
import assert from "node:assert/strict";
import { versionMark } from "../shared/updates";

// Home's and the panel's header marker: the running version, a quiet "update" while a newer one is on offer.
test("the version marker shows the running version, and says update only while one is on offer", () => {
  assert.deepEqual(versionMark({ version: "1.4.0-beta.34", phase: { kind: "current" } }), { text: "v1.4.0-beta.34", update: false, label: "Follow-up version 1.4.0-beta.34" });
  for (const phase of [{ kind: "available", version: "1.4.0-beta.35", publishedAt: null }, { kind: "waiting", version: "1.4.0-beta.35", busy: null, idleAt: null, capAt: 0, capped: false }] as const)
    assert.deepEqual(versionMark({ version: "1.4.0-beta.34", phase }), { text: "v1.4.0-beta.34 · update", update: true, label: "Follow-up version 1.4.0-beta.34, update available" });
  for (const phase of [{ kind: "installing", version: "1.4.0-beta.35", since: 0 }, { kind: "install-failed", version: "1.4.0-beta.35", reason: "x", at: 0 }] as const)
    assert.equal(versionMark({ version: "1.4.0-beta.34", phase }).update, false, `${phase.kind}: Settings → General explains it`);
});
