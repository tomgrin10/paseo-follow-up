import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LEGACY_BASELINE, notesSince, parseChangelog, whatsNew } from "../shared/changelog";
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
