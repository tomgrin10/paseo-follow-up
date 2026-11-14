import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, cp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LEGACY_BASELINE, announcesUpdate, imageBlock, notesSince, notesVersion, parseChangelog, recentNotes, recentUpdate, whatsNew } from "../shared/changelog";
// @ts-expect-error plain ESM script without types
import { DRAFT_MARKER, fragmentBullets, lintBullet } from "../scripts/release-notes.mjs";

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

test("changelog: the shipped CHANGELOG.md shows only curated stable sections in the app, 2.0.0's as shipped; the full lists stay below <details>, all lint-clean", async () => {
  const text = await readFile("CHANGELOG.md", "utf8");
  const notes = parseChangelog(text);
  // A section is found by its version, never by its place: each stable release adds one on top (2.0.1, 2026-11-14).
  const versions = notes.map(n => n.version);
  assert.ok(versions.every(v => /^\d+\.\d+\.\d+$/.test(v)), `What's new and the release notes see stable sections only: ${versions.join(", ")}`);
  assert.equal(versions.at(-1), "2.0.0", "2.0.0 is the oldest section the app sees; 1.x stays below <details>");
  for (const n of notes) {
    const headings = (n.blocks ?? []).filter(b => b.kind === "heading").length;
    assert.ok(headings >= 3 && headings <= 8, `${n.version}: a handful of pillars (${headings})`);
    assert.match(text, new RegExp(`<details><summary>Full changelog since ${n.version === "2.0.0" ? "1\\.0\\.1" : "\\d+\\.\\d+\\.\\d+"}</summary>`));
  }
  const blocks = notes.find(n => n.version === "2.0.0")!.blocks ?? [];
  assert.ok(blocks.filter(b => b.kind === "heading").length >= 3 && blocks.filter(b => b.kind === "heading").length <= 8, "a handful of pillars");
  assert.ok(blocks.every(b => !/1\.x|upgrad|roll ?back|0\.15/i.test(b.text)), "no upgrade or Paseo version talk in the curated notes");
  assert.ok(text.split("\n").map(l => /^[-*]\s+(.*)$/.exec(l)?.[1]).filter(Boolean).every(b => !lintBullet(b!).length), "every bullet, full list included, is lint-clean");
  assert.match(text, /<details><summary>Full changelog since 1\.0\.1<\/summary>/);
  // Tom, testing rc.0's sheet: no "is a Paseo plugin that" lead, and screenshots in it, Home first, the panel second.
  assert.equal(blocks[0]!.kind, "text"); assert.match(blocks[0]!.text, /^Follow-up keeps track of every workspace/);
  const images = blocks.filter(b => b.kind === "image");
  assert.deepEqual(images.map(b => b.kind === "image" && b.url.split("/").pop()), ["follow-up-notes-home.png", "follow-up-notes-panel.png"]);
  assert.equal(blocks[1]!.kind, "image", "Home right after the intro");
  assert.ok(images.every(b => b.kind === "image" && b.text.length > 20 && b.aspect), "alt text for screen readers and a shape to reserve");
  assert.ok(blocks.at(-2)!.kind === "rule" && /Progress.*Better Paseo/.test(blocks.at(-1)!.text), "credits last, as the quiet footnote");
});

/** The PNG's own width and height (IHDR). */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)] as const;
const git = (args: string[], encoding: BufferEncoding | "buffer" = "utf8") => exec("git", args, { encoding: encoding as "utf8", maxBuffer: 1 << 26 });

test("changelog: a screenshot is never drawn larger than its CSS size: the sheet caps it at the URL's width", async () => {
  const sheet = await readFile("client/release-notes.tsx", "utf8");
  assert.match(sheet, /maxWidth: block\.width/, "NoteImage never stretches past #W");
});

test("changelog: every image in the notes loads from a commit on this branch that holds it, at the shape the URL says", async t => {
  // Notes that ship must never change after release: an image URL names a commit (never main or a branch), that
  // commit is in this branch's history (so a rebase or squash that drops it fails here, not on users' phones), and
  // the #WxH shape the sheet reserves matches the PNG. CI checks out full history for this (ci.yml fetch-depth 0).
  if ((await git(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true") return t.skip("shallow clone: no history to check pins against");
  const text = await readFile("CHANGELOG.md", "utf8");
  const lines = text.split("\n").filter(l => /^\s*!\[/.test(l));
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const m = /\]\((https:\/\/raw\.githubusercontent\.com\/tomgrin10\/paseo-follow-up\/([0-9a-f]{40})\/(\S+?)(?:#(\d+)x(\d+))?)\)\s*$/.exec(line);
    assert.ok(m, `pinned to a full commit hash on raw.githubusercontent.com: ${line}`);
    const [, url, sha, path, w, h] = m;
    await git(["merge-base", "--is-ancestor", sha!, "HEAD"]).catch(() => assert.fail(`${sha} isn't in this branch's history (rebased or squashed?): re-pin ${path}`));
    const png = (await exec("git", ["show", `${sha}:${path}`], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const [pw, ph] = pngSize(png);
    assert.ok(w && h, `${url}: a #WxH shape`);
    assert.ok(Math.abs(pw / ph - +w! / +h!) < 0.01, `${path}: the URL's ${w}x${h} matches the PNG's ${pw}x${ph}`);
    // #WxH is the CSS size: the PNG is a 2x or 3x shot of it, so the sheet (which never draws wider than W) and the
    // GitHub page (<img width=W>) show the screenshot at most at the size of the UI it shows, and sharp.
    assert.ok(pw / +w! >= 2 && Number.isInteger(pw / +w!), `${path}: ${pw}px is a 2x or 3x shot of ${w} CSS px`);
  }
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
  assert.match((await run("1.1.0-beta.0", "--date", "2026-11-09")).stdout, /is a beta: no CHANGELOG\.md section\. Its GitHub release notes are rendered from the fragments since the last tag \(scripts\/release-body\.mjs\); 2 fragment\(s\) stay/);
  assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), before, "a beta writes no section");
  assert.deepEqual((await readdir(join(dir, "changes"))).sort(), ["README.md", "a-first.md", "b-second.md"], "and its fragments wait");
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.1.0-beta.0", files: ["CHANGELOG.md"] }));
  await run("--check");
  assert.match((await run("1.1.0", "--date", "2026-11-09")).stdout, /DRAFT: curate it/);
  const out = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  assert.equal(out, `# Release notes\n\nIntro.\n\n## 1.1.0 (2026-11-09)\n\n${DRAFT_MARKER}\n\n- First.\n- Second.\n\n<details><summary>Full changelog since 1.0.0</summary>\n\n### More\n\n- First.\n- Second.\n\n</details>\n\n## 1.0.0 (2026-01-01)\n\n- Old.\n`,
    "the next stable drafts its curated notes from every beta's fragments, with the full list under them");
  // Curation is the default path: the draft can't ship until someone rewrites it and drops the marker.
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.1.0", files: ["CHANGELOG.md"] }));
  await assert.rejects(run("--check"), /1\.1\.0 is still the draft release:notes wrote/);
  await writeFile(join(dir, "CHANGELOG.md"), out.replace(`${DRAFT_MARKER}\n\n- First.\n- Second.`, "- First and second, in one line."));
  await run("--check");
  assert.deepEqual(parseChangelog(await readFile(join(dir, "CHANGELOG.md"), "utf8"))[0]!.items, ["First and second, in one line."], "What's new shows the curated part only");
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
  assert.match((await run("2.0.0-rc.0", "--date", "2026-11-11")).stdout, /CHANGELOG\.md: 2\.0\.0 \(2026-11-11\), 1 note.*DRAFT/);
  assert.match(await changelog(), /^## 2\.0\.0 \(2026-11-11\)\n\n<!-- DRAFT/m, "## 2.0.0, not ## 2.0.0-rc.0");
  assert.deepEqual(await readdir(join(dir, "changes")), [], "fragments consumed");
  await assert.rejects(run("--check"), /2\.0\.0 is still the draft/, "an rc can't ship a draft either");
  await writeFile(join(dir, "CHANGELOG.md"), "# Release notes\n\n## 2.0.0 (2026-11-11)\n\nFollow-up is a plugin.\n\n### Home\n\nOne list.\n\n<details><summary>Full changelog since 1.0.1</summary>\n\n### More\n\n- Beta work.\n\n</details>\n\n## 1.0.1 (2026-01-02)\n\n- Old.\n");
  await run("--check");
  // A later rc keeps the curated text as written; its fragment joins the full list in a group of its own.
  await writeFile(join(dir, "changes/b.md"), "- Rc fix that no longer drops a row.\n");
  await run("2.0.0-rc.1");
  const after = await changelog();
  assert.match(after, /Follow-up is a plugin\.\n\n### Home\n\nOne list\.\n\n<details><summary>Full changelog since 1\.0\.1<\/summary>\n\n### More\n\n- Beta work\.\n\n### Fixes\n\n- Rc fix that no longer drops a row\.\n\n<\/details>\n\n## 1\.0\.1/);
  assert.deepEqual(await readdir(join(dir, "changes")), []);
  assert.deepEqual(parseChangelog(after).find(n => n.version === "2.0.0")!.blocks, [{ kind: "text", text: "Follow-up is a plugin." }, { kind: "heading", text: "Home" }, { kind: "text", text: "One list." }]);
  // The stable release carries the same section: nothing new to write, and --check passes.
  await run("2.0.0"); await pkg("2.0.0"); await run("--check");
  assert.equal((await changelog()).match(/^## 2\.0\.0/gm)?.length, 1);
});

test("release notes script: a curated section is never regrouped or relabeled; 0 fragments is a no-op, 1 adds one line", async () => {
  // The bug: release:notes on a curated 2.0.0 with no fragments rebuilt its full list with the area classifier,
  // moving hand-placed lines between groups and changing the summary. release-fu runs it for every release.
  const dir = await mkdtemp(join(tmpdir(), "notes-curated-"));
  await mkdir(join(dir, "scripts")); await mkdir(join(dir, "changes"));
  await cp("scripts/release-notes.mjs", join(dir, "scripts/release-notes.mjs"));
  await cp("CHANGELOG.md", join(dir, "CHANGELOG.md")); // the shipped, hand-curated one
  const run = (...a: string[]) => exec("node", [join(dir, "scripts/release-notes.mjs"), ...a]);
  const before = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  for (const v of ["2.0.0-rc.0", "2.0.0-rc.1", "2.0.0"]) {
    await run(v, "--date", "2026-12-01");
    assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), before, `${v} with no fragments leaves CHANGELOG.md byte-identical`);
  }
  await writeFile(join(dir, "changes/x.md"), "- A workspace no longer flickers between groups.\n");
  await run("2.0.0-rc.1");
  const after = (await readFile(join(dir, "CHANGELOG.md"), "utf8")).split("\n");
  const added = after.filter(l => !before.split("\n").includes(l));
  assert.deepEqual(added, ["- A workspace no longer flickers between groups."], "one new line, nothing else changes");
  assert.deepEqual(after.filter(l => l !== added[0]), before.split("\n"), "every existing line keeps its place, headings and summary included");
  // Within 2.0.0's own section: a later stable section above it has its own "### Fixes" and </details>.
  const section = after.findIndex(l => /^## 2\.0\.0\b/.test(l));
  const fixes = after.indexOf("### Fixes", section), line = after.indexOf(added[0]!);
  assert.ok(section >= 0 && fixes > section && line > fixes && line < after.indexOf("</details>", section), "it joins its own area's group");
  await writeFile(join(dir, "changes/y.md"), "- A workspace no longer flickers between groups.\n");
  await run("2.0.0");
  assert.equal(after.join("\n"), await readFile(join(dir, "CHANGELOG.md"), "utf8"), "a note already in the list isn't added twice");
});

test("changelog: a <details> full list ends only its own section; every stable section above and below it still reaches the app", () => {
  // 2026-11-14, stable 2.0.1: the parser stopped at the first <details>, so a second stable section (each carries its
  // own "Full changelog" list) hid every older version from Home's notes and from "since last seen".
  const text = "# R\n\n## 2.0.1 (2026-11-14)\n\nLighter.\n\n### Tasks\n\n- Tasks.\n\n<details><summary>Full changelog since 2.0.0</summary>\n\n### Fixes\n\n- Hidden fix.\n\n## 9.9.9 (2026-01-01)\n\n- Inside the list.\n\n</details>\n\n## 2.0.0 (2026-11-11)\n\n- Home.\n\n<details><summary>Full changelog since 1.0.1</summary>\n\n- Old.\n\n</details>\n";
  const notes = parseChangelog(text);
  assert.deepEqual(notes.map(n => n.version), ["2.0.1", "2.0.0"], "both stable sections, nothing from inside a <details> list");
  assert.deepEqual(notes[0]!.items, ["Tasks."], "a section's full list never reaches What's new");
  assert.deepEqual(notes[1]!.items, ["Home."]);
});

test("changelog: a <details> archive below the notes never reaches What's new; image lines become image blocks", () => {
  const text = "# R\n\n## 2.0.0 (2026-11-11)\n\n![Home](https://example.com/home.png)\n\n- Home.\n\n<details><summary>1.1-1.4 betas</summary>\n\n## 1.4.0-beta.2 (2026-11-09)\n\n- Old beta.\n\n</details>\n";
  assert.deepEqual(parseChangelog(text), [{ version: "2.0.0", date: "2026-11-11", items: ["Home."], blocks: [
    { kind: "image", text: "Home", url: "https://example.com/home.png", aspect: null, width: null }, { kind: "bullet", text: "Home." }] }]);
});

test("changelog: a curated section's ### headings and paragraphs reach What's new as blocks, inline markdown as text, images and rules as their own blocks", () => {
  const text = "## 2.0.0 (2026-11-11)\n\nFollow-up is a [Paseo](https://paseo.sh) plugin\nthat keeps track of `workspaces`.\n\n![Home **list**](https://example.com/h.png#1600x1000)\n\n### One list\n\nHome lists **every** workspace.\n\n- A bullet\n  that wraps.\n\n---\n\nThanks.\n\n![relative](docs/x.png)\n\n<details><summary>Full changelog</summary>\n\n### Fixes\n\n- Hidden.\n\n</details>\n";
  const [note] = parseChangelog(text);
  assert.deepEqual(note!.items, ["A bullet that wraps."]);
  assert.deepEqual(note!.blocks, [
    { kind: "text", text: "Follow-up is a Paseo plugin that keeps track of workspaces." },
    { kind: "image", text: "Home list", url: "https://example.com/h.png", aspect: 1.6, width: 1600 },
    { kind: "heading", text: "One list" },
    { kind: "text", text: "Home lists every workspace." },
    { kind: "bullet", text: "A bullet that wraps." },
    { kind: "rule", text: "" },
    { kind: "text", text: "Thanks." },
  ], "a relative image path means nothing to the app and is dropped");
  assert.deepEqual(imageBlock("![a](https://x.test/i.png#16x9)"), { kind: "image", text: "a", url: "https://x.test/i.png", aspect: 16 / 9, width: 16 });
  assert.equal(imageBlock("text ![a](https://x.test/i.png)"), null, "only an image alone on its line");
  assert.equal(parseChangelog("## 1.0.1\n\n- Only bullets.\n")[0]!.blocks, undefined, "a bullets-only note stays items");
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
