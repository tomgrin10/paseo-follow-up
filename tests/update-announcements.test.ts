import test from "node:test";
import assert from "node:assert/strict";
import { announcesUpdate, parseChangelog, recentUpdate, whatsNew } from "../shared/changelog";
import { compareVersions } from "../shared/version";

// Invariant (update-announcements-major-only): Follow-up prompts about its own updates only for a new major version.
// Every other update (beta, minor, patch) is recorded quietly. announcesUpdate in shared/changelog.ts is the one rule;
// What's new and every update notice go through it. The grid below fails if any non-major update would open a sheet.

const VERSIONS = ["1.3.0", "1.4.0-beta.0", "1.4.0-beta.28", "1.4.0-beta.29", "1.4.0", "1.4.1", "1.5.0", "2.0.0-beta.0", "2.0.0-beta.1", "2.0.0", "2.0.1", "2.1.0-beta.0", "3.0.0"];
// Every version ships notes, the worst case: notes alone must never be enough to pop the sheet.
const notes = parseChangelog(VERSIONS.map(v => `## ${v} (2026-11-10)\n\n- Note for ${v}.`).join("\n\n"));

test("fixture (2026-11-10): beta.28 to beta.29 opens no What's new sheet", () => {
  const d = whatsNew({ installed: "1.4.0-beta.29", deviceSeen: "1.4.0-beta.28", previous: "1.4.0-beta.28", onboarding: false, notes });
  assert.deepEqual(d, { show: false, reason: "not-major", record: "1.4.0-beta.29" }, "recorded silently");
});

test("grid: a sheet opens only when a new major version is released", () => {
  for (const from of VERSIONS) for (const to of VERSIONS) {
    const d = whatsNew({ installed: to, deviceSeen: from, previous: from, onboarding: false, notes });
    const major = announcesUpdate(from, to);
    assert.equal(d.show, major, `${from} -> ${to}`);
    if (!d.show && compareVersions(to, from) !== 0) assert.equal(d.record, to, `${from} -> ${to} is recorded`);
  }
});

test("announcesUpdate: a major counts when it is released, so beta-channel users still see 2.0", () => {
  assert.equal(announcesUpdate("1.4.0-beta.29", "2.0.0"), true);
  assert.equal(announcesUpdate("1.4.0", "2.0.0-beta.0"), false, "a 2.0 beta is not 2.0 yet");
  assert.equal(announcesUpdate("2.0.0-beta.1", "2.0.0"), true, "the 2.0 beta channel still gets the 2.0 sheet");
  assert.equal(announcesUpdate("2.0.0", "2.1.0-beta.0"), false);
  assert.equal(announcesUpdate("1.4.0", "1.5.0"), false);
  assert.equal(announcesUpdate("2.0.0", "1.4.0"), false, "a downgrade");
  assert.equal(announcesUpdate(null, "2.0.0"), false, "a first install");
});

test("Home's 'Updated to X · What's new' needs notes of X's own", () => {
  const view = { version: "1.4.0-beta.30", previous: "1.4.0-beta.29", updatedAt: 0, notes };
  assert.equal(recentUpdate(view, 1), false, "a beta without its own notes says plain 'Follow-up X · Release notes'");
  assert.equal(recentUpdate({ ...view, version: "2.0.0" }, 1), true);
});
