import test from "node:test";
import assert from "node:assert/strict";
import { versionMark, type UpdatesView } from "../shared/updates";

// The version marker at the top of Home and the panel: the running version, a quiet word for the update state, and
// the warning dot only when something needs the developer (the Settings tab's needsLook), never for an update that's
// already on its way.
const at = (phase: UpdatesView["phase"], patch: Partial<Pick<UpdatesView, "installKind" | "mode">> = {}) =>
  versionMark({ version: "1.4.0-beta.34", installKind: "npm", mode: "notify", phase, ...patch });

test("the version marker: version first, then the update state; the dot only when it needs a look", () => {
  assert.deepEqual(at({ kind: "current" }), { version: "v1.4.0-beta.34", suffix: null, dot: false, label: "Follow-up version 1.4.0-beta.34" });
  assert.deepEqual(at({ kind: "available", version: "1.4.0-beta.35", publishedAt: null }),
    { version: "v1.4.0-beta.34", suffix: "update", dot: true, label: "Follow-up version 1.4.0-beta.34, update available" });
  assert.equal(at({ kind: "available", version: "1.4.0-beta.35", publishedAt: null }, { mode: "auto" }).dot, false, "auto installs it: nothing to do");
  for (const phase of [{ kind: "waiting", version: "1.4.0-beta.35", busy: null, idleAt: null, capAt: 0, capped: false }, { kind: "installing", version: "1.4.0-beta.35", since: 0 }] as const)
    assert.deepEqual([at(phase).suffix, at(phase).dot], ["updating", false], phase.kind);
  for (const phase of [{ kind: "install-failed", version: "1.4.0-beta.35", reason: "x", at: 0 }, { kind: "rolled-back", version: "1.4.0-beta.35", from: "1.4.0-beta.34", reason: "x", at: 0 }, { kind: "untrusted", version: "1.4.0-beta.35", reason: "x" }] as const) {
    assert.deepEqual([at(phase).suffix, at(phase).dot], ["check", true], phase.kind);
    assert.match(at(phase).label, /needs a look$/);
  }
  assert.deepEqual(at({ kind: "current" }, { installKind: "directory" }), at({ kind: "current" }), "a checkout shows its version, nothing more");
});
