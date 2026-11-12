import test from "node:test";
import assert from "node:assert/strict";
import { versionMark, type UpdatesView } from "../shared/updates";

// The version marker at the top of Home and the panel shows the running version and nothing else: no word and no dot
// for the update state, whatever it is. Settings → General, which it opens, shows the state; the label still says it.
const at = (phase: UpdatesView["phase"]) => versionMark({ version: "1.4.0-beta.34", phase });

test("the version marker: only the version, in every update state; the accessibility label names the state", () => {
  assert.deepEqual(at({ kind: "current" }), { version: "v1.4.0-beta.34", label: "Follow-up version 1.4.0-beta.34" });
  const cases: [UpdatesView["phase"], string][] = [
    [{ kind: "available", version: "1.4.0-beta.35", publishedAt: null }, "update available"],
    [{ kind: "waiting", version: "1.4.0-beta.35", busy: null, idleAt: null, capAt: 0, capped: false }, "update on its way"],
    [{ kind: "installing", version: "1.4.0-beta.35", since: 0 }, "update on its way"],
    [{ kind: "install-failed", version: "1.4.0-beta.35", reason: "x", at: 0 }, "the last update needs a look"],
    [{ kind: "rolled-back", version: "1.4.0-beta.35", from: "1.4.0-beta.34", reason: "x", at: 0 }, "the last update needs a look"],
    [{ kind: "untrusted", version: "1.4.0-beta.35", reason: "x" }, "the last update needs a look"],
  ];
  for (const [phase, said] of cases) {
    assert.deepEqual(Object.keys(at(phase)).sort(), ["label", "version"], `${phase.kind}: nothing but the version and its label`);
    assert.equal(at(phase).version, "v1.4.0-beta.34", phase.kind);
    assert.equal(at(phase).label, `Follow-up version 1.4.0-beta.34, ${said}`, phase.kind);
  }
});
