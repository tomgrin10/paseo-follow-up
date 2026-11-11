import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAINTENANCE, UNWRITTEN, VERIFIED, compare, gitSource, hasNotes, releaseBody, releaseNotes } from "../scripts/release-body.mjs";
import { plan } from "../scripts/backfill-release-notes.mjs";

// Tom: "the beta releases on github don't display release notes, make sure every github release displays proper clean
// release notes in the same format". Every GitHub release body comes from scripts/release-body.mjs: betas render their
// own fragments, a stable or a major's rc its curated CHANGELOG.md section.

/** A scratch repository with tagged commits; `files` per tag is what the tree holds at that tag. */
function repo(t: TestContext, tags: [string, Record<string, string | null>][]) {
  const dir = mkdtempSync(join(tmpdir(), "release-body-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]); git(["config", "user.email", "test@example.com"]); git(["config", "user.name", "Test"]); git(["config", "commit.gpgsign", "false"]);
  for (const [tag, files] of tags) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) { rmSync(join(dir, path), { force: true }); continue; }
      mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content);
    }
    git(["add", "-A"]); git(["commit", "-q", "--allow-empty", "-m", tag]); git(["tag", tag]);
  }
  return gitSource(git);
}
const manifest = (paseo: string) => JSON.stringify({ id: "follow-up", requirements: { paseo } });

test("a beta's body is its own fragments in the shared format, never boilerplate only", t => {
  const src = repo(t, [
    ["v1.0.1", { "paseo-plugin.json": manifest(">=0.15.0"), "CHANGELOG.md": "# R\n\n## 1.0.1\n\n- Old.\n", "changes/README.md": "rules" }],
    ["v1.1.0-beta.0", { "changes/feat-a.md": "- Home has a search box.\n" }],
    ["v1.1.0-beta.1", { "changes/fix-b.md": "- A row no longer flickers.\n- Undo works twice.\n" }],
    ["v1.1.0-beta.2", {}],
  ]);
  const b1 = releaseBody("v1.1.0-beta.1", src);
  assert.equal(b1, [
    "**Install:** `paseo plugin install npm:paseo-follow-up@1.1.0-beta.1` (needs Paseo 0.15.0 or newer).",
    "", "## What's new", "", "- A row no longer flickers.", "- Undo works twice.",
    "", "## Install", "",
    "`paseo plugin install npm:paseo-follow-up@1.1.0-beta.1`, or `paseo plugin update follow-up --version 1.1.0-beta.1` if it's installed. Prereleases are on npm's `beta` dist-tag. The stable release is 1.0.1. Needs Paseo 0.15.0 or newer.",
    "", VERIFIED, "",
  ].join("\n"), "only the fragments added since the previous tag, rendered as written");
  assert.doesNotMatch(b1, /Home has a search box/, "an earlier beta's fragment stays with that beta");
  assert.match(releaseBody("v1.1.0-beta.2", src), new RegExp(`## What's new\\n\\n${MAINTENANCE}\\n`), "no fragments says so in one line");
  for (const tag of ["v1.1.0-beta.0", "v1.1.0-beta.1", "v1.1.0-beta.2"]) assert.ok(hasNotes(releaseBody(tag, src)), `${tag} has notes`);
});

test("a stable version and a major's rc carry the curated section, full changelog included; betas before fragments say so", t => {
  const curated = "Follow-up is a plugin.\n\n![Home](https://example.com/h.png)\n\n### One list\n\nHome lists everything.\n\n<details><summary>Full changelog since 1.0.1</summary>\n\n### Fixes\n\n- A fix.\n\n</details>";
  const src = repo(t, [
    ["v1.0.1", { "paseo-plugin.json": manifest(">=0.14.0"), "CHANGELOG.md": "# R\n\n## 1.0.1\n\n- Old.\n" }],
    ["v1.1.0-beta.0", {}],
    ["v2.0.0-rc.0", { "paseo-plugin.json": manifest(">=0.15.0"), "CHANGELOG.md": `# R\n\n## 2.0.0 (2026-11-11)\n\n<!-- a comment -->\n${curated}\n\n## 1.0.1\n\n- Old.\n`, "changes/README.md": "rules", "changes/x.md": "- Raw fragment.\n" }],
    ["v2.0.0", {}],
  ]);
  const rc = releaseBody("v2.0.0-rc.0", src);
  assert.ok(rc.includes(`## What's new\n\n${curated}\n\n## Install`), "the curated section as written, never the fragment list");
  assert.doesNotMatch(rc, /Raw fragment|a comment/);
  assert.match(rc, /^\*\*Install:\*\* `paseo plugin install npm:paseo-follow-up@2\.0\.0-rc\.0`/);
  const stable = releaseBody("v2.0.0", src);
  assert.match(stable, /^\*\*Install:\*\* `paseo plugin install npm:paseo-follow-up` \(needs Paseo 0\.15\.0 or newer\)\./, "stable installs from npm's latest, with the npm: prefix");
  assert.match(stable, /`paseo plugin update follow-up` if it's installed/);
  assert.equal(releaseNotes("v1.1.0-beta.0", src).notes, UNWRITTEN, "a beta from before changes/ existed, with no section, says no notes were written");
  assert.throws(() => releaseNotes("v1.0.1", repo(t, [["v1.0.1", { "CHANGELOG.md": "# R\n" }]])), /no 1\.0\.1 section/, "a stable without its section never renders boilerplate");
});

test("the publish workflow writes every GitHub release body with scripts/release-body.mjs", () => {
  const workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  const release = workflow.slice(workflow.indexOf("\n  release:"));
  assert.match(release, /node scripts\/release-body\.mjs "\$RELEASE_TAG"/, "the body comes from the shared renderer");
  assert.match(release, /fetch-depth: 0/, "with the tags it needs for the previous tag and the fragments");
  assert.match(release, /--notes-file/);
  assert.doesNotMatch(release, /Track workspace pull requests|INSTALL_LINE|<<'NOTES'/, "no hand-written boilerplate body");
});

test("backfill: only releases without notes are rewritten, in version order; ones it can't render are skipped", t => {
  const src = repo(t, [
    ["v1.0.1", { "paseo-plugin.json": manifest(">=0.14.0"), "changes/README.md": "rules" }],
    ["v1.1.0-beta.0", { "changes/a.md": "- A.\n" }],
    ["v1.1.0-beta.1", {}],
  ]);
  const boilerplate = "Track workspace pull requests.\n\nInstall with: `paseo plugin update x --version 1` (beta).\n\nThis release passed plugin verification.";
  const steps = plan([
    { tagName: "v1.1.0-beta.1", body: boilerplate },
    { tagName: "v1.0.1", body: "Follow-up 1.0.1 fixes things.\n\n## Fixed\n\n- **Closed agents stay closed.**" },
    { tagName: "v1.1.0-beta.0", body: boilerplate },
  ], src);
  assert.deepEqual(steps.map(s => [s.tag, s.action]), [["v1.0.1", "keep"], ["v1.1.0-beta.0", "write"], ["v1.1.0-beta.1", "write"]]);
  assert.match(steps[1]!.body!, /## What's new\n\n- A\.\n/);
  assert.match(steps[2]!.body!, new RegExp(MAINTENANCE));
  assert.equal(hasNotes(boilerplate), false, "the old boilerplate counts as no notes");
  assert.equal(plan([{ tagName: "v1.0.1", body: boilerplate }], src)[0]!.action, "skip", "a stable with no section is skipped, not given boilerplate");
  assert.ok(compare("1.4.0-beta.10", "1.4.0-beta.9") > 0 && compare("2.0.0", "2.0.0-rc.0") > 0);
});
