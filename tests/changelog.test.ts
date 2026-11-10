import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LEGACY_BASELINE, announcesUpdate, notesSince, notesVersion, parseChangelog, recentNotes, recentUpdate, whatsNew } from "../shared/changelog";
// @ts-expect-error plain ESM script without types
import { fragmentBullets, lintBullet } from "../scripts/release-notes.mjs";

const exec = promisify(execFile);
const SAMPLE = `# Release notes

Preamble text that is not a note.
- not a note either

## 1.4.0-beta.3 (2026-11-10)

- Third.
- A long note that
  wraps onto a second line.

## v1.4.0-beta.10 (2026-11-12)

- Tenth.

## Not a version

- ignored

## 1.4.0-beta.2

* Second, no date.
`;

test("changelog: headings, dates, bullets, continuation lines; newest first by version, not file order", () => {
  const notes = parseChangelog(SAMPLE);
  assert.deepEqual(notes.map(n => n.version), ["1.4.0-beta.10", "1.4.0-beta.3", "1.4.0-beta.2"]);
  assert.deepEqual(notes[1], { version: "1.4.0-beta.3", date: "2026-11-10", items: ["Third.", "A long note that wraps onto a second line."] });
  assert.equal(notes[2]!.date, null);
  assert.deepEqual(notes[2]!.items, ["Second, no date."]);
});

test("changelog: the shipped CHANGELOG.md parses, covers 1.4.0-beta.0 to beta.22, and every entry has notes", async () => {
  const notes = parseChangelog(await readFile("CHANGELOG.md", "utf8"));
  for (let i = 0; i <= 22; i++) assert.ok(notes.some(n => n.version === `1.4.0-beta.${i}`), `beta.${i}`);
  for (const n of notes) { assert.ok(n.items.length, n.version); for (const i of n.items) assert.deepEqual(lintBullet(i), [], `${n.version}: ${i}`); }
});

const notes = parseChangelog(["# R", ...[14, 13, 12, 11, 10].map(n => `## 1.4.0-beta.${n} (2026-11-1${n % 10})\n\n- Note ${n}.`)].join("\n\n"));

test("since last seen: every version after it up to the installed one, newest first", () => {
  assert.deepEqual(notesSince(notes, "1.4.0-beta.10", "1.4.0-beta.13").map(n => n.version), ["1.4.0-beta.13", "1.4.0-beta.12", "1.4.0-beta.11"]);
  assert.deepEqual(notesSince(notes, "1.4.0-beta.13", "1.4.0-beta.13"), []);
  assert.deepEqual(notesSince(notes, null, "1.4.0-beta.13"), []);
});

test("what's new: shows once, after a major update, from the device's record or the daemon's previous version", () => {
  const majors = parseChangelog(["2.1.0", "2.0.0", "1.5.0", "1.4.0"].map(v => `## ${v} (2026-11-10)\n\n- Note ${v}.`).join("\n\n"));
  const base = { installed: "2.1.0", onboarding: false, notes: majors };
  const shown = whatsNew({ ...base, deviceSeen: "1.4.0", previous: "1.5.0" });
  assert.ok(shown.show && shown.notes.map(n => n.version).join() === "2.1.0,2.0.0,1.5.0", "device record wins: it missed three versions");
  const newDevice = whatsNew({ ...base, deviceSeen: null, previous: "1.5.0" });
  assert.ok(newDevice.show && newDevice.notes.length === 2);
  assert.deepEqual(whatsNew({ ...base, deviceSeen: "2.1.0", previous: "1.5.0" }), { show: false, reason: "seen", record: null }, "once per device per version");
  assert.deepEqual(whatsNew({ ...base, installed: "1.5.0", deviceSeen: "2.1.0", previous: null }), { show: false, reason: "older", record: "1.5.0" }, "a rollback shows nothing and lowers the record");
  assert.deepEqual(whatsNew({ ...base, installed: "1.4.0-beta.14", deviceSeen: "1.4.0-beta.12", previous: "1.4.0-beta.13", notes }), { show: false, reason: "not-major", record: "1.4.0-beta.14" }, "a beta is recorded quietly");
});

test("what's new: no popup on first install, and never on top of onboarding", () => {
  assert.deepEqual(whatsNew({ installed: "1.4.0-beta.14", deviceSeen: null, previous: null, onboarding: false, notes }), { show: false, reason: "first-run", record: "1.4.0-beta.14" });
  assert.deepEqual(whatsNew({ installed: "1.4.0-beta.14", deviceSeen: "1.4.0-beta.10", previous: "1.4.0-beta.13", onboarding: true, notes }), { show: false, reason: "onboarding", record: null }, "nothing recorded, so it shows once onboarding ends");
  assert.equal(LEGACY_BASELINE, "1.4.0-beta.22");
});

test("release notes script: lints style; a stable release moves fragments under a dated heading, a beta leaves them", async () => {
  assert.deepEqual(lintBullet("Settings has a new tab — Updates"), ["em dash"]);
  assert.deepEqual(lintBullet("Fixes #42"), ["PR jargon"]);
  assert.deepEqual(lintBullet("PR #42 is fixed"), ["PR jargon"]);
  assert.deepEqual(lintBullet("The PR sheet shows checks."), []);
  assert.deepEqual(lintBullet("Party \u{1F389}"), ["emoji"]);
  assert.throws(() => fragmentBullets("x.md", "Not a bullet"), /only "- " bullets/);
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  await mkdir(join(dir, "scripts")); await mkdir(join(dir, "changes"));
  await cp("scripts/release-notes.mjs", join(dir, "scripts/release-notes.mjs"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ files: ["CHANGELOG.md"] }));
  await writeFile(join(dir, "CHANGELOG.md"), "# Release notes\n\nIntro.\n\n## 1.0.0 (2026-01-01)\n\n- Old.\n");
  await writeFile(join(dir, "changes/b-second.md"), "- Second.\n");
  await writeFile(join(dir, "changes/a-first.md"), "- First.\n");
  await writeFile(join(dir, "changes/README.md"), "kept");
  const run = (...a: string[]) => exec("node", [join(dir, "scripts/release-notes.mjs"), ...a]);
  const before = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  assert.match((await run("1.1.0-beta.0", "--date", "2026-11-09")).stdout, /is a beta: no release notes\. 2 fragment\(s\) stay/);
  assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), before, "a beta writes no section");
  assert.deepEqual((await readdir(join(dir, "changes"))).sort(), ["README.md", "a-first.md", "b-second.md"], "and its fragments wait");
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.1.0-beta.0", files: ["CHANGELOG.md"] }));
  await run("--check");
  await run("1.1.0", "--date", "2026-11-09");
  const out = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  assert.equal(out, "# Release notes\n\nIntro.\n\n## 1.1.0 (2026-11-09)\n\n- First.\n- Second.\n\n## 1.0.0 (2026-01-01)\n\n- Old.\n", "the next stable collects every beta's fragments");
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.2.0", files: ["CHANGELOG.md"] }));
  await assert.rejects(run("--check"), /no section for package\.json's 1\.2\.0/, "a stable without notes still fails");
  await assert.rejects(run("1.1.0"), /already has/);
  await assert.rejects(run("1.1.1"), /No release note fragments/);
  await run("1.1.1", "--allow-empty", "--date", "2026-11-10");
  assert.match(await readFile(join(dir, "CHANGELOG.md"), "utf8"), /## 1\.1\.1 \(2026-11-10\)\n\n- Small fixes and improvements\./);
  assert.equal(await readFile(join(dir, "changes/README.md"), "utf8"), "kept");
});

test("release notes script: an rc of a major writes the major's section, consumes fragments, and the final release reuses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-rc-"));
  await mkdir(join(dir, "scripts")); await mkdir(join(dir, "changes"));
  await cp("scripts/release-notes.mjs", join(dir, "scripts/release-notes.mjs"));
  const pkg = (version: string) => writeFile(join(dir, "package.json"), JSON.stringify({ version, files: ["CHANGELOG.md"] }));
  const run = (...a: string[]) => exec("node", [join(dir, "scripts/release-notes.mjs"), ...a]);
  const changelog = () => readFile(join(dir, "CHANGELOG.md"), "utf8");
  await writeFile(join(dir, "CHANGELOG.md"), "# Release notes\n\n## 1.0.1 (2026-01-02)\n\n- Old.\n");
  await writeFile(join(dir, "changes/a.md"), "- Beta work.\n");
  // Betas stay note-less, even betas of the next major.
  await run("2.0.0-beta.3", "--date", "2026-11-10");
  assert.doesNotMatch(await changelog(), /2\.0\.0/);
  await pkg("2.0.0-beta.3"); await run("--check");
  // The rc needs the major's section.
  await pkg("2.0.0-rc.0");
  await assert.rejects(run("--check"), /no section for 2\.0\.0, which package\.json's 2\.0\.0-rc\.0 carries/);
  assert.match((await run("2.0.0-rc.0", "--date", "2026-11-11")).stdout, /CHANGELOG\.md: 2\.0\.0 \(2026-11-11\), 1 note/);
  assert.equal(await changelog(), "# Release notes\n\n## 2.0.0 (2026-11-11)\n\n- Beta work.\n\n## 1.0.1 (2026-01-02)\n\n- Old.\n", "## 2.0.0, not ## 2.0.0-rc.0");
  assert.deepEqual(await readdir(join(dir, "changes")), [], "fragments consumed");
  await run("--check");
  // A later rc adds new fragments to the same section; --curated drops them because the section already covers them.
  await writeFile(join(dir, "changes/b.md"), "- Rc fix.\n");
  await run("2.0.0-rc.1"); assert.match(await changelog(), /- Beta work\.\n- Rc fix\.\n\n## 1\.0\.1/);
  await writeFile(join(dir, "changes/c.md"), "- Folded in by hand.\n");
  await run("2.0.0-rc.2", "--curated");
  assert.doesNotMatch(await changelog(), /Folded in/); assert.deepEqual(await readdir(join(dir, "changes")), []);
  // The stable release carries the same section: nothing new to write, and --check passes.
  await run("2.0.0"); await pkg("2.0.0"); await run("--check");
  assert.equal((await changelog()).match(/^## 2\.0\.0/gm)?.length, 1);
});

test("changelog: a <details> archive below the notes never reaches What's new; image lines are skipped", () => {
  const text = "# R\n\n## 2.0.0 (2026-11-11)\n\n![Home](https://example.com/home.png)\n\n- Home.\n\n<details><summary>1.1-1.4 betas</summary>\n\n## 1.4.0-beta.2 (2026-11-09)\n\n- Old beta.\n\n</details>\n";
  assert.deepEqual(parseChangelog(text), [{ version: "2.0.0", date: "2026-11-11", items: ["Home."] }]);
});

test("what's new: 1.x to 2.0.0-rc.0 shows 2.0's notes once; later rcs and 2.0.0 itself don't pop again", () => {
  const majors = parseChangelog("## 2.0.0 (2026-11-11)\n\n- Two.\n\n## 1.0.1 (2026-01-02)\n\n- Old.\n");
  const at = (installed: string, seen: string) => whatsNew({ installed, deviceSeen: seen, previous: null, onboarding: false, notes: majors });
  const first = at("2.0.0-rc.0", "1.4.0-beta.32");
  assert.ok(first.show && first.notes.map(n => n.version).join() === "2.0.0", "the rc carries 2.0.0's section, and only it");
  assert.ok(at("2.0.0-rc.0", "1.0.1").show, "from the last stable too");
  assert.deepEqual(at("2.0.0-rc.1", "2.0.0-rc.0"), { show: false, reason: "not-major", record: "2.0.0-rc.1" });
  assert.deepEqual(at("2.0.0", "2.0.0-rc.1"), { show: false, reason: "not-major", record: "2.0.0" }, "the final 2.0.0 doesn't pop again");
  assert.ok(at("2.0.0", "1.4.0-beta.32").show, "but someone skipping the rc still sees 2.0 once");
  assert.deepEqual(at("2.0.0-beta.1", "1.4.0-beta.32"), { show: false, reason: "not-major", record: "2.0.0-beta.1" }, "a beta of 2.0 is still 1.x");
  assert.equal(notesVersion("2.0.0-rc.3"), "2.0.0"); assert.equal(notesVersion("2.0.0-beta.1"), "2.0.0-beta.1"); assert.equal(notesVersion("2.1.0-rc.0"), "2.1.0-rc.0");
  assert.equal(announcesUpdate("2.0.0-rc.0", "2.0.0"), false); assert.equal(announcesUpdate("1.4.0-beta.32", "2.0.0-rc.0"), true);
  assert.deepEqual(recentNotes({ version: "2.0.0-rc.0", previous: "2.0.0-rc.0", notes: majors }).map(n => n.version), ["2.0.0"], "opened by hand, the rc shows 2.0's notes");
  assert.equal(recentUpdate({ version: "2.0.0-rc.0", previous: "1.4.0-beta.32", updatedAt: 1, notes: majors }, 2), true, "Home's Updated to 2.0.0-rc.0 · What's new line");
});
