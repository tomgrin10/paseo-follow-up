#!/usr/bin/env node
// Release notes: `node scripts/release-notes.mjs <version> [--date yyyy-mm-dd] [--allow-empty]` moves changes/*.md
// under a new `## <version> (<date>)` heading at the top of CHANGELOG.md and deletes those fragments. Betas (any
// version with a prerelease part) get no section: the fragments stay in changes/ for the next stable release.
// A release candidate of a major (2.0.0-rc.0) is not a beta: it writes or requires that major's section (`## 2.0.0`),
// the one the rc and the final 2.0.0 both carry. When that section already exists (written by hand, or by an earlier
// rc), its text stays as written and new fragments join its "Full changelog" list.
// `node scripts/release-notes.mjs --check` validates CHANGELOG.md and pending fragments without writing.
//
// Two tiers. A beta's notes are its fragments, rendered as they are on its GitHub release (scripts/release-body.mjs in
// the publish workflow). A stable version or a major's rc is CURATED: a short, hand-written section grouped by what a
// user gets, which What's new shows. release:notes writes a DRAFT of it (the fragments, under DRAFT_MARKER) plus the
// generated "Full changelog" (every fragment, grouped by area, inside <details>), and check:notes fails while the
// version's section still carries the marker. Curating means rewriting the draft and deleting the marker line.
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CHANGES = join(ROOT, "changes");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

/** The line release:notes puts in a stable or rc section it drafted from fragments. check:notes refuses it. */
export const DRAFT_MARKER = "<!-- DRAFT: curate this section (group by what a user gets, lead with what matters), then delete this line -->";

/**
 * The full list's areas, in order, each with the words that put a note in it. A note goes to the first area that
 * matches; "Fixes" catches what reads as a fix ("no longer", "now shows"), and "More" the rest.
 */
export const AREAS = [
  ["Fixes", /\bno longer\b|\bnever (?:shows|says|clears|sends)|\bnow (?:shows|says|updates|agree)|\bwrongly\b|\bfixed\b|\bgarbles?\b/i],
  ["Home and Needs you", /\bhome\b|needs you|needs-you|\binbox\b|sign(?:s|ed)? off|\blater\b|snooz|search|\bsort\b|sidebar|\bpill\b|status strip|right-click|long-press|row menu|undo/i],
  ["Questions and answers", /question|answer|\bcard\b|option|something else|cmd\+enter|ctrl\+enter|\bbrief/i],
  ["Repairs and PRs", /repair|\bbatch|auto-send|\bchecks?\b|\bmerge|review|graphite|github|conflict|deploy|\bdone\b|\bPRs?\b/i],
  ["The Overseer and AI priority", /overseer|priority|rank/i],
  ["Summary and Linked items", /summary|summaries|linked|linear|slack|what's this about/i],
  ["Providers and helper agents", /provider|\bmodel|helper|settings → agents|recovery/i],
  ["Agents and tools", /\btools?\b|\bwait\b|background|main agent|trust bypass|permission|hook/i],
  ["Setup, Settings and updates", /setup|getting started|settings|update|what's new|version|release notes/i],
  ["Performance", /\bload\b|lighter|memory|polling|process|less\b/i],
  ["Phone", /phone/i],
];
/** Every note grouped by area (### headings), deduplicated; the markdown inside a "Full changelog" <details>. */
export function groupByArea(bullets) {
  const seen = new Set(); const groups = new Map([...AREAS.map(([name]) => [name, []]), ["More", []]]);
  for (const b of bullets) {
    const key = b.toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) continue; seen.add(key);
    groups.get(AREAS.find(([, re]) => re.test(b))?.[0] ?? "More").push(b);
  }
  // Fixes match first (a fix to Home is a fix) but read last.
  const order = [...groups].filter(([name]) => name !== "Fixes").concat([["Fixes", groups.get("Fixes")]]);
  return order.filter(([, list]) => list.length).map(([name, list]) => `### ${name}\n\n${list.map(b => `- ${b}`).join("\n")}`).join("\n\n");
}
/** The collapsible full list that follows a curated section. */
export const fullBlock = (since, bullets) => `<details><summary>Full changelog since ${since}</summary>\n\n${groupByArea(bullets)}\n\n</details>`;

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
  if (!isBeta(pkg.version) && seen.has(needs) && draftIn(changelog, needs)) problems.push(`CHANGELOG.md ${needs} is still the draft release:notes wrote. Curate it (group by what a user gets, lead with what matters, cut internal fixes), then delete the DRAFT line.`);
  if (!isBeta(pkg.version) && !seen.has(needs)) problems.push(`CHANGELOG.md has no section for ${needs === pkg.version ? `package.json's ${needs}` : `${needs}, which package.json's ${pkg.version} carries`}. Run npm run release:notes ${pkg.version} before the bump.`);
  return problems;
}

/** Whether a version's section (up to the next heading) still has the draft marker. */
export function draftIn(changelog, version) {
  const lines = changelog.split("\n");
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === version);
  if (at < 0) return false;
  for (let i = at + 1; i < lines.length && !HEADING.test(lines[i]); i++) if (lines[i].includes("<!-- DRAFT:")) return true;
  return false;
}

export const isPrerelease = version => /^\d+\.\d+\.\d+-/.test(version);

export async function release(version, date, allowEmpty, { since = null } = {}) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  if (isBeta(version)) return { version, date, skipped: true, fragments: (await fragments()).map(f => f.name) };
  const target = notesVersion(version);
  let changelog = await readFile(CHANGELOG, "utf8");
  const pending = await fragments();
  const bullets = pending.flatMap(f => f.bullets);
  for (const b of bullets) { const p = lintBullet(b); if (p.length) throw new Error(`${p.join(", ")}: ${b}`); }
  const lines = changelog.split("\n");
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === target);
  const from = since ?? lines.map(l => HEADING.exec(l)?.[1]).find(v => v && v !== target && !isPrerelease(v)) ?? "the last release";
  if (at >= 0) {
    if (!/^\d+\.0\.0$/.test(target)) throw new Error(`CHANGELOG.md already has ${version}`);
    // The major's section exists (curated by hand, or by an earlier rc). Its text stays as written; the new fragments
    // join the full list under it.
    let end = at + 1;
    while (end < lines.length && !HEADING.test(lines[end]) && !/^#{1,2}\s/.test(lines[end])) end++;
    const block = lines.slice(at + 1, end).join("\n");
    const open = block.search(/^<details><summary>Full changelog/m);
    let curated = open >= 0 ? block.slice(0, open) : block, old = [];
    if (open >= 0) old = block.slice(open).split("\n").map(l => /^[-*]\s+(.*)$/.exec(l)?.[1]).filter(Boolean);
    if (bullets.length || open >= 0) curated = `${curated.trimEnd()}\n\n${fullBlock(from, [...old, ...bullets])}\n`;
    lines.splice(at + 1, end - at - 1, ...`${curated.trimEnd()}\n`.split("\n"));
    await writeFile(CHANGELOG, lines.join("\n"));
    await Promise.all(pending.map(f => unlink(join(CHANGES, f.name))));
    return { version, target, date, existing: true, bullets: bullets.length, fragments: pending.map(f => f.name) };
  }
  if (!bullets.length && !allowEmpty) throw new Error("No release note fragments in changes/. Add one, or pass --allow-empty for a release with no user-facing change.");
  // A draft to curate: the fragments as starting material, the marker check:notes refuses, and the full list.
  const body = bullets.length ? `${DRAFT_MARKER}\n\n${bullets.map(b => `- ${b}`).join("\n")}\n\n${fullBlock(from, bullets)}` : "- Small fixes and improvements.";
  const section = `## ${target} (${date})\n\n${body}\n\n`;
  const first = changelog.search(/^##\s/m);
  changelog = first < 0 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, first) + section + changelog.slice(first);
  await writeFile(CHANGELOG, changelog);
  await Promise.all(pending.map(f => unlink(join(CHANGES, f.name))));
  return { version: target, date, bullets: bullets.length, draft: bullets.length > 0, fragments: pending.map(f => f.name) };
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
      const si = args.indexOf("--since");
      const result = await release(version, date, args.includes("--allow-empty"), { since: si >= 0 ? args[si + 1] : null });
      if (result.existing) console.log(`CHANGELOG.md: ${result.target} already has its section; ${result.bullets ? `added ${result.bullets} note(s) to its full changelog from` : "consumed"} ${result.fragments.length} fragment(s).`);
      else if (result.skipped) console.log(`${result.version} is a beta: no release notes. ${result.fragments.length} fragment(s) stay in changes/ for the next stable release.`);
      else console.log(`CHANGELOG.md: ${result.version} (${result.date}), ${result.bullets} note(s) from ${result.fragments.length} fragment(s)${result.draft ? ". It's a DRAFT: curate it and delete the DRAFT line; check:notes refuses it until then." : ""}`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
