#!/usr/bin/env node
// Release notes: `node scripts/release-notes.mjs <version> [--date yyyy-mm-dd] [--allow-empty]` moves changes/*.md
// under a new `## <version> (<date>)` heading at the top of CHANGELOG.md and deletes those fragments.
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
  // A version bump without its notes would ship an empty "What's new". Run release:notes before bumping.
  if (!seen.has(pkg.version)) problems.push(`CHANGELOG.md has no section for package.json's ${pkg.version}. Run npm run release:notes ${pkg.version} before the bump.`);
  return problems;
}

async function release(version, date, allowEmpty) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  const changelog = await readFile(CHANGELOG, "utf8");
  if (versionsIn(changelog).includes(version)) throw new Error(`CHANGELOG.md already has ${version}`);
  const pending = await fragments();
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
      const result = await release(version, date, args.includes("--allow-empty"));
      console.log(`CHANGELOG.md: ${result.version} (${result.date}), ${result.bullets} note(s) from ${result.fragments.length} fragment(s)`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
