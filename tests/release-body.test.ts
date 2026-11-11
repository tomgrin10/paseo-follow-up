import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LATEST, MAINTENANCE, NO_NOTES, UNWRITTEN, VERIFIED, VERIFIED_BEFORE_NPM, compare, framed, gitSource, hasNotes, ownNotes, releaseBody, releaseNotes, sizedImages } from "../scripts/release-body.mjs";
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
const manifest = (paseo: string, id = "follow-up") => JSON.stringify({ id, requirements: { paseo } });
/** A publish workflow that ran the checks the verification sentence claims. */
const CHECKED = "steps:\n  - run: npm run verify\n  - run: npm run test:install\n  - run: echo registry integrity verified\n";

test("a beta's body is its own fragments in the shared format, never boilerplate only", t => {
  const src = repo(t, [
    ["v1.0.1", { "paseo-plugin.json": manifest(">=0.15.0"), "CHANGELOG.md": "# R\n\n## 1.0.1\n\n- Old.\n", "changes/README.md": "rules", ".github/workflows/publish-npm.yml": CHECKED }],
    ["v1.1.0-beta.0", { "changes/feat-a.md": "- Home has a search box.\n" }],
    ["v1.1.0-beta.1", { "changes/fix-b.md": "- A row no longer flickers.\n- Undo works twice.\n" }],
    ["v1.1.0-beta.2", {}],
  ]);
  const b1 = releaseBody("v1.1.0-beta.1", src);
  assert.equal(b1, [
    "**Install:** `paseo plugin install npm:paseo-follow-up@1.1.0-beta.1`",
    "", "## What's new", "", "- A row no longer flickers.", "- Undo works twice.",
    "", "## Install", "",
    `Already installed: \`paseo plugin update follow-up --version 1.1.0-beta.1\`. Prereleases are on npm's \`beta\` dist-tag; the current stable release is on the [Releases page](${LATEST}). Needs Paseo 0.15.0 or newer.`,
    "", VERIFIED, "",
  ].join("\n"), "only the fragments added since the previous tag, the install command once, no hard-coded stable version");
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
  assert.match(rc, /^\*\*Install:\*\* `paseo plugin install npm:paseo-follow-up@2\.0\.0-rc\.0`\n/);
  assert.doesNotMatch(rc, /This release passed/, "no verification claim where the tag's workflow didn't run those checks");
  const stable = releaseBody("v2.0.0", src);
  assert.match(stable, /^\*\*Install:\*\* `paseo plugin install npm:paseo-follow-up`\n/, "stable installs from npm's latest, with the npm: prefix");
  assert.match(stable, /## Install\n\nAlready installed: `paseo plugin update follow-up`\. Needs Paseo 0\.15\.0 or newer\.\n$/);
  assert.equal((stable.match(/paseo plugin install/g) ?? []).length, 1, "the install command appears once");
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

test("backfill: every page gets the frame; hand-written text is kept, only its install and check boilerplate goes", t => {
  const src = repo(t, [
    ["v0.3.0", { "paseo-plugin.json": manifest(">=0.14.0", "old-id"), ".github/workflows/publish-npm.yml": CHECKED }],
    ["v1.0.1", { "changes/README.md": "rules" }],
    ["v1.1.0-beta.0", { "changes/a.md": "- A.\n" }],
    ["v1.1.0-beta.1", {}],
  ]);
  const boilerplate = "Track workspace pull requests, queue follow-up work, and verify completion in Paseo.\n\nInstall with: `paseo plugin update x --version 1` (beta). Return to stable with `paseo plugin update x --version 1.0.1` on Paseo 0.14.0 or newer.\n\nThe installation ID remains `x` to preserve saved work and settings.\nThis release passed plugin verification, isolated packed installation checks,\nand npm registry integrity verification before these notes were published.";
  const handWritten = "Follow-up 1.0.1 fixes things.\n\n## Fixed\n\n- **Closed agents stay closed.**\n\n## Install\n\n```\npaseo plugin install paseo-follow-up\n```\n\nAlready installed: `paseo plugin update old-id`. Requires Paseo 0.14.0 or newer. No data changes.";
  const old = "Adds a thing.\n\nRequires Paseo 0.14.0 or newer. Optional integration requires Companion 2.1.0.\n\nValidated with 138 checks. A replay recovered all 12 PRs. npm registry integrity matches main.";
  const steps = plan([
    { tagName: "v1.1.0-beta.1", body: boilerplate },
    { tagName: "v1.0.1", body: handWritten },
    { tagName: "v1.1.0-beta.0", body: boilerplate },
    { tagName: "v0.3.0", body: old },
    { tagName: "v2.0.0-rc.0", body: "set by hand" },
  ], src, { except: ["v2.0.0-rc.0"] });
  assert.deepEqual(steps.map(s => [s.tag, s.action]), [["v0.3.0", "write"], ["v1.0.1", "write"], ["v1.1.0-beta.0", "write"], ["v1.1.0-beta.1", "write"]], "--except is left alone");
  const [b030, b101, b0, b1] = steps.map(s => s.body!);
  assert.equal(b030, [
    "**Install:** `paseo plugin install npm:paseo-follow-up@0.3.0`", "", "## What's new", "",
    "Adds a thing.", "", "Optional integration requires Companion 2.1.0.", "", "A replay recovered all 12 PRs.",
    "", "## Install", "", "Already installed: `paseo plugin update old-id --version 0.3.0`. Needs Paseo 0.14.0 or newer.", "", VERIFIED_BEFORE_NPM, "",
  ].join("\n"), "every hand-written fact stays; the era's id, a pinned install, and the claim as it was true then");
  assert.match(b101, /## What's new\n\nFollow-up 1\.0\.1 fixes things\.\n\n### Fixed\n\n- \*\*Closed agents stay closed\.\*\*\n\nNo data changes\.\n\n## Install/, "its own headings move under the frame's");
  assert.doesNotMatch(b101, /```/);
  assert.match(b0, /## What's new\n\n- A\.\n/);
  assert.match(b1, new RegExp(MAINTENANCE));
  assert.ok(steps.every(s => framed(s.body)), "every page ends in the one format");
  assert.equal(plan([{ tagName: "v1.0.1", body: b101 }], src)[0]!.action, "keep", "running it again changes nothing");
  assert.match(plan([{ tagName: "v1.0.1", body: boilerplate }], src)[0]!.body!, new RegExp(NO_NOTES), "a stable with no notes anywhere says so");
  assert.equal(hasNotes(boilerplate), false);
  assert.deepEqual(ownNotes("Plain text only.").replaced, []);
  assert.ok(compare("1.4.0-beta.10", "1.4.0-beta.9") > 0 && compare("2.0.0", "2.0.0-rc.0") > 0);
});

test("a screenshot on the GitHub page is never drawn larger than its CSS size: #WxH becomes <img width=W>", () => {
  assert.equal(sizedImages("Intro.\n\n![Home \"list\"](https://x.test/a/h.png#1120x680)\n\n![raw](https://x.test/r.png)\n"),
    'Intro.\n\n<img src="https://x.test/a/h.png" width="1120" alt="Home &quot;list&quot;">\n\n![raw](https://x.test/r.png)\n', "an unsized image stays markdown");
  assert.equal(sizedImages("text ![a](https://x.test/i.png#2x1) inline"), "text ![a](https://x.test/i.png#2x1) inline", "only an image alone on its line");
});
