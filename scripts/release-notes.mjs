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
    groups.get(areaOf(b)).push(b);
  }
  // Fixes match first (a fix to Home is a fix) but read last.
  const order = [...groups].filter(([name]) => name !== "Fixes").concat([["Fixes", groups.get("Fixes")]]);
  return order.filter(([, list]) => list.length).map(([name, list]) => `### ${name}\n\n${list.map(b => `- ${b}`).join("\n")}`).join("\n\n");
}
/** The area a note belongs to (see AREAS). */
export const areaOf = b => AREAS.find(([, re]) => re.test(b))?.[0] ?? "More";
/**
 * A section's lines with new notes added to its "Full changelog" <details>: each note goes after the last line of its
 * area's `###` group, or into a new group just before `</details>`. Existing lines, their order, the headings and the
 * summary are never touched. A section without the block gets one, holding only the new notes.
 */
export function appendToFull(sectionLines, since, bullets) {
  const out = [...sectionLines];
  const open = out.findIndex(l => /^<details><summary>Full changelog/.test(l));
  const close = open < 0 ? -1 : out.findIndex((l, i) => i > open && /^<\/details>/.test(l));
  if (open < 0 || close < 0) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return [...out, "", ...fullBlock(since, bullets).split("\n"), ""];
  }
  const known = new Set(out.slice(open, close).map(l => /^[-*]\s+(.*)$/.exec(l)?.[1]?.toLowerCase().replace(/\W+/g, " ").trim()).filter(Boolean));
  for (const b of bullets) {
    const key = b.toLowerCase().replace(/\W+/g, " ").trim();
    if (known.has(key)) continue; known.add(key);
    const end = out.findIndex((l, i) => i > open && /^<\/details>/.test(l));
    const head = out.findIndex((l, i) => i > open && i < end && l === `### ${areaOf(b)}`);
    if (head >= 0) {
      let last = head; for (let i = head + 1; i < end && !/^###\s/.test(out[i]); i++) if (/^[-*]\s/.test(out[i])) last = i;
      out.splice(last + 1, 0, `- ${b}`);
    } else {
      let at = end; while (at > open + 1 && !out[at - 1].trim()) at--;
      out.splice(at, 0, "", `### ${areaOf(b)}`, "", `- ${b}`);
    }
  }
  return out;
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

/**
 * Release notes are short (AGENTS.md, "Release notes"). A minor or patch section's curated part is one intro line and
 * at most CURATED_MAX_BULLETS bullets; a major's gets a few headed pillars instead. The full list stays in <details>.
 * 2026-11-14: 2.0.1 first shipped six headed groups and 24 bullets.
 */
export const CURATED_MAX_BULLETS = 6;
export const CURATED_MAX_CHARS = 1200;
export const isMajor = version => /^\d+\.0\.0$/.test(version);
/** The curated part of a version's section: its lines up to its <details> list or the next heading. */
export function curatedPart(changelog, version) {
  const lines = changelog.split("\n");
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === version);
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < lines.length && !HEADING.test(lines[i]) && !/^\s*<details/i.test(lines[i]); i++) out.push(lines[i]);
  return out.filter(l => l.trim() && !/^\s*<!--/.test(l));
}
/**
 * The next stable version, picked right before a release from what it carries (AGENTS.md, "Versioning"): a pending
 * `feat-*` note makes a minor, anything else a patch, counted from the newest stable section. A major is Tom's call.
 * Never inherited from the beta line: 2.0.1 kept its betas' number and shipped features as a patch (2026-11-14).
 */
export function nextVersion(changelog, names) {
  // Sections only: a heading inside a <details> list (an archive) isn't a release of its own.
  let folded = false; const sections = [];
  for (const line of changelog.split("\n")) {
    if (folded) { if (/<\/details>/i.test(line)) folded = false; continue; }
    if (/^\s*<details/i.test(line)) { folded = !/<\/details>/i.test(line); continue; }
    const h = HEADING.exec(line); if (h) sections.push(h[1]);
  }
  const last = sections.filter(v => SEMVER.test(v) && !isPrerelease(v)).sort((a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0];
  if (!last) throw new Error("CHANGELOG.md has no stable section to count from");
  const [major, minor, patch] = last.split(".").map(Number);
  const features = names.filter(n => n.startsWith("feat-"));
  const version = features.length ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  const reason = features.length ? `a minor: ${features.length} of ${names.length} pending note(s) are features (${features.join(", ")})` : names.length ? `a patch: ${names.length} pending note(s), none a feature` : "a patch: no pending notes";
  return { last, version, reason };
}
/**
 * Features ship in a minor (AGENTS.md, "Versioning"): a patch (x.y.Z, Z > 0) may carry fixes and speed-ups only.
 * Fragments are named after their branch, so a pending `feat-*.md` means a feature. 2026-11-14: 2.0.1 shipped
 * Rename with AI, Report a bug and No review as a patch.
 */
export function featuresInPatch(version, names) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || m[3] === "0") return null;
  const features = names.filter(n => n.startsWith("feat-"));
  return features.length ? `${version} is a patch, but ${features.length} pending note(s) are features (${features.join(", ")}). Features ship in a minor: release ${m[1]}.${+m[2] + 1}.0.` : null;
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
  for (const v of seen) {
    if (isPrerelease(v) || isMajor(v) || draftIn(changelog, v)) continue;
    const part = curatedPart(changelog, v);
    const bullets = part.filter(l => /^[-*]\s/.test(l)).length, chars = part.join(" ").length, headings = part.filter(l => /^#{3,6}\s/.test(l)).length;
    if (bullets > CURATED_MAX_BULLETS || chars > CURATED_MAX_CHARS || headings) problems.push(`CHANGELOG.md ${v}: a minor or patch's notes are one intro line and at most ${CURATED_MAX_BULLETS} bullets (${CURATED_MAX_CHARS} characters, no headings); this one has ${bullets} bullets, ${chars} characters, ${headings} headings. See AGENTS.md, "Release notes".`);
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

export async function release(version, date, allowEmpty, { since = null, allowFeatures = false } = {}) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  if (isBeta(version)) return { version, date, skipped: true, fragments: (await fragments()).map(f => f.name) };
  const target = notesVersion(version);
  let changelog = await readFile(CHANGELOG, "utf8");
  const pending = await fragments();
  const patchProblem = allowFeatures ? null : featuresInPatch(version, pending.map(f => f.name));
  if (patchProblem) throw new Error(`${patchProblem} (--allow-features only with Tom's OK for a patch.)`);
  const bullets = pending.flatMap(f => f.bullets);
  for (const b of bullets) { const p = lintBullet(b); if (p.length) throw new Error(`${p.join(", ")}: ${b}`); }
  const lines = changelog.split("\n");
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === target);
  const from = since ?? lines.map(l => HEADING.exec(l)?.[1]).find(v => v && v !== target && !isPrerelease(v)) ?? "the last release";
  if (at >= 0) {
    if (!/^\d+\.0\.0$/.test(target)) throw new Error(`CHANGELOG.md already has ${version}`);
    // The major's section exists (curated by hand, or by an earlier rc). Nothing in it is ever regrouped or
    // relabeled: with no new fragments the file is left as it is, byte for byte, and new fragments are only added
    // (appendToFull), each under its own area, after the lines already there.
    if (!bullets.length) return { version, target, date, existing: true, bullets: 0, fragments: [] };
    let end = at + 1;
    while (end < lines.length && !HEADING.test(lines[end]) && !/^#{1,2}\s/.test(lines[end])) end++;
    lines.splice(at + 1, end - at - 1, ...appendToFull(lines.slice(at + 1, end), from, bullets));
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
    if (args.includes("--next-version")) {
      const { last, version, reason } = nextVersion(await readFile(CHANGELOG, "utf8"), (await fragments()).map(f => f.name));
      console.log(`${version}  (${reason}; last stable ${last}. A major is Tom's call. Ask Tom for this exact version before releasing.)`);
    } else if (args.includes("--check")) {
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
      const result = await release(version, date, args.includes("--allow-empty"), { since: si >= 0 ? args[si + 1] : null, allowFeatures: args.includes("--allow-features") });
      if (result.existing) console.log(`CHANGELOG.md: ${result.target} already has its section; ${result.bullets ? `added ${result.bullets} note(s) to its full changelog from` : "consumed"} ${result.fragments.length} fragment(s).`);
      else if (result.skipped) console.log(`${result.version} is a beta: no CHANGELOG.md section. Its GitHub release notes are rendered from the fragments since the last tag (scripts/release-body.mjs); ${result.fragments.length} fragment(s) stay in changes/ for the next stable release.`);
      else console.log(`CHANGELOG.md: ${result.version} (${result.date}), ${result.bullets} note(s) from ${result.fragments.length} fragment(s)${result.draft ? ". It's a DRAFT: curate it and delete the DRAFT line; check:notes refuses it until then." : ""}`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
