import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LABEL, missingNote } from "../scripts/check-release-note.mjs";

// 2026-11-12: three user-visible fixes merged without a changes/ fragment, so v2.0.1-beta.0's generated notes said
// "no user-visible changes" (scripts/check-release-note.mjs).
test("user-visible-change-has-a-note: a code change needs a changes/ fragment or the no-release-note label", () => {
  assert.match(missingNote(["server/daemon.ts", "tests/x.test.ts"], []) ?? "", /adds no release note/, "the #125 shape fails");
  assert.match(missingNote(["index.server.ts"], []) ?? "", /index\.server\.ts/, "the entry files count");
  assert.match(missingNote(["shared/model.ts", "changes/README.md"], []) ?? "", /adds no release note/, "the rules file isn't a note");
  assert.equal(missingNote(["server/daemon.ts", "changes/fix-observe-io.md"], []), null, "with a fragment");
  assert.equal(missingNote(["client/app.tsx"], [LABEL]), null, "a labelled refactor");
  assert.equal(missingNote(["tests/x.test.ts", "scripts/y.mjs", "docs/z.md"], []), null, "tests, scripts and docs need none");
});

test("user-visible-change-has-a-note: CI runs the check on every pull request and re-runs it when labels change", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /run: node scripts\/check-release-note\.mjs/);
  assert.match(ci, /types: \[[^\]]*\blabeled\b[^\]]*\bunlabeled\b[^\]]*\]/);
  assert.match(ci, /fetch-depth: 0/, "the diff needs the base branch");
});
