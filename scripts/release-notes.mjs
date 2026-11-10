#!/usr/bin/env node
// Release notes: `node scripts/release-notes.mjs <version> [--date yyyy-mm-dd] [--allow-empty]` moves changes/*.md
// under a new `## <version> (<date>)` heading at the top of CHANGELOG.md and deletes those fragments. Betas (any
// version with a prerelease part) get no section: the fragments stay in changes/ for the next stable release.
// A release candidate of a major (2.0.0-rc.0) is not a beta: it writes or requires that major's section (`## 2.0.0`),
// the one the rc and the final 2.0.0 both carry. When that section already exists (written by hand, or by an earlier
// rc), new fragments are appended to it; `--curated` deletes them instead, for notes already folded into the section.
// `node scripts/release-notes.mjs --check` validates CHANGELOG.md and pending fragments without writing.
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CHANGES = join(ROOT, "changes");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

/** Style rules for user-facing notes; returns the problems with one bullet. */
export function lintBullet(text) {
  const problems = [];
  if (/—/.test(text)) problems.push("em dash");
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push("emoji");
  if (/(^|\s)#\d+\b|\bPRs? ?#\d|\bpull request #/i.test(text)) problems.push("PR jargon");
  if (text.length > 240) problems.push("longer than 240 characters");
  if (!text.trim()) problems.push("empty");
  return problems;
}

/** Bullets from one fragment, with continuation lines joined. Throws on anything that isn't a bullet. */
export function fragmentBullets(name, text) {
  const out = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) out.push(bullet[1].trim());
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += ` ${line.trim()}`;
    else throw new Error(`${name}: only "- " bullets are allowed, found: ${line}`);
  }
  if (!out.length) throw new Error(`${name}: no bullets`);
  return out;
}

async function fragments() {
  const names = (await readdir(CHANGES).catch(() => [])).filter(n => n.endsWith(".md") && n !== "README.md").sort();
  return Promise.all(names.map(async name => ({ name, bullets: fragmentBullets(name, await readFile(join(CHANGES, name), "utf8")) })));
}

function versionsIn(changelog) {
  return changelog.split("\n").map(l => HEADING.exec(l)?.[1]).filter(Boolean);
}

/** The section a version carries: X.0.0-rc.N carries X.0.0's (see notesVersion in shared/changelog.ts). */
export function notesVersion(version) {
  const m = /^(\d+)\.0\.0-rc\.\d+$/.exec(version);
  return m ? `${m[1]}.0.0` : version;
}
/** Betas (any prerelease that isn't a major's rc) get no notes. */
export const isBeta = version => isPrerelease(version) && notesVersion(version) === version;

async function check() {
  const problems = [];
  const changelog = await readFile(CHANGELOG, "utf8");
  const seen = new Set();
  let current = null;
  for (const line of changelog.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      if (!SEMVER.test(h[1])) problems.push(`CHANGELOG.md: bad version heading "${line}"`);
      if (seen.has(h[1])) problems.push(`CHANGELOG.md: ${h[1]} appears twice`);
      seen.add(h[1]); current = h[1]; continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b && current) for (const p of lintBullet(b[1])) problems.push(`CHANGELOG.md ${current}: ${p}: ${b[1]}`);
  }
  let pending = [];
  try { pending = await fragments(); } catch (e) { problems.push(e.message); }
  for (const f of pending) for (const b of f.bullets) for (const p of lintBullet(b)) problems.push(`changes/${f.name}: ${p}: ${b}`);
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  if (!pkg.files.includes("CHANGELOG.md")) problems.push("package.json files must include CHANGELOG.md");
  // A stable bump without its notes would ship an empty "What's new". Run release:notes before bumping. Betas have
  // no notes of their own; their changes ship in the next stable release's section.
  const needs = notesVersion(pkg.version);
  if (!isBeta(pkg.version) && !seen.has(needs)) problems.push(`CHANGELOG.md has no section for ${needs === pkg.version ? `package.json's ${needs}` : `${needs}, which package.json's ${pkg.version} carries`}. Run npm run release:notes ${pkg.version} before the bump.`);
  return problems;
}

export const isPrerelease = version => /^\d+\.\d+\.\d+-/.test(version);

export async function release(version, date, allowEmpty, { curated = false } = {}) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  if (isBeta(version)) return { version, date, skipped: true, fragments: (await fragments()).map(f => f.name) };
  const target = notesVersion(version);
  const changelog = await readFile(CHANGELOG, "utf8");
  const pending = await fragments();
  if (versionsIn(changelog).includes(target)) {
    if (!/^\d+\.0\.0$/.test(target)) throw new Error(`CHANGELOG.md already has ${version}`);
    // The major's section exists (hand-written, or from an earlier rc): add new fragments to it, or with --curated
    // drop them because the section already says it. A stable release of an rc'd major needs nothing else.
    if (curated || !pending.length) { await Promise.all(pending.map(f => unlink(join(CHANGES, f.name)))); return { version, target, date, existing: true, bullets: 0, fragments: pending.map(f => f.name) }; }
    const bullets = pending.flatMap(f => f.bullets);
    for (const b of bullets) { const p = lintBullet(b); if (p.length) throw new Error(`${p.join(", ")}: ${b}`); }
    const lines = changelog.split("\n");
    const at = lines.findIndex(l => HEADING.exec(l)?.[1] === target);
    let end = at + 1;
    while (end < lines.length && !HEADING.test(lines[end]) && !/^\s*<details/i.test(lines[end]) && !/^#{1,2}\s/.test(lines[end])) end++;
    let last = end; while (last > at + 1 && !lines[last - 1].trim()) last--;
    lines.splice(last, 0, ...bullets.map(b => `- ${b}`));
    await writeFile(CHANGELOG, lines.join("\n"));
    await Promise.all(pending.map(f => unlink(join(CHANGES, f.name))));
    return { version, target, date, existing: true, bullets: bullets.length, fragments: pending.map(f => f.name) };
  }
  version = target;
  const bullets = pending.flatMap(f => f.bullets);
  if (!bullets.length && !allowEmpty) throw new Error("No release note fragments in changes/. Add one, or pass --allow-empty for a release with no user-facing change.");
  const lines = bullets.length ? bullets : ["Small fixes and improvements."];
  for (const b of lines) { const p = lintBullet(b); if (p.length) throw new Error(`${p.join(", ")}: ${b}`); }
  const section = `## ${version} (${date})\n\n${lines.map(b => `- ${b}`).join("\n")}\n\n`;
  const at = changelog.search(/^##\s/m);
  const next = at < 0 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, at) + section + changelog.slice(at);
  await writeFile(CHANGELOG, next);
  await Promise.all(pending.map(f => unlink(join(CHANGES, f.name))));
  return { version, date, bullets: lines.length, fragments: pending.map(f => f.name) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--check")) {
      const problems = await check();
      if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
      console.log("release notes ok");
    } else {
      const version = args.find(a => !a.startsWith("--"));
      if (!version) throw new Error("Usage: npm run release:notes <version> [-- --date yyyy-mm-dd] [--allow-empty]");
      const di = args.indexOf("--date");
      const date = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("--date must be yyyy-mm-dd");
      const result = await release(version, date, args.includes("--allow-empty"), { curated: args.includes("--curated") });
      if (result.existing) console.log(`CHANGELOG.md: ${result.target} already has its section; ${result.bullets ? `added ${result.bullets} note(s) from` : "consumed"} ${result.fragments.length} fragment(s).`);
      else if (result.skipped) console.log(`${result.version} is a beta: no release notes. ${result.fragments.length} fragment(s) stay in changes/ for the next stable release.`);
      else console.log(`CHANGELOG.md: ${result.version} (${result.date}), ${result.bullets} note(s) from ${result.fragments.length} fragment(s)`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
