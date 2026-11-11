// The GitHub release body for a tag: `node scripts/release-body.mjs v2.0.1-beta.3` prints it.
// Every release (beta, rc, stable) has the same shape:
//
//   **Install:** `paseo plugin install npm:paseo-follow-up[@X]`
//
//   ## What's new
//   <notes>
//
//   ## Install
//   Already installed: `paseo plugin update <id of that release> [--version X]`. <dist-tag note> Needs Paseo F or newer.
//
//   <verification sentence, only when that tag's publish workflow ran those checks>
//
// Only the notes differ. A stable version or a major's rc gets its CURATED CHANGELOG.md section (an rc carries the
// major's, see notesVersion), including the collapsed "Full changelog" under it. A beta renders the changes/
// fragments added since the previous tag, as they are; they stay in changes/ for the next stable or rc. Betas from
// before fragments existed use their own CHANGELOG.md section where one was written. This is the GitHub page only:
// What's new in the app stays major-only.
// Everything is read from git at the tag (CHANGELOG.md, paseo-plugin.json, changes/), so it renders old tags too.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fragmentBullets, isBeta, notesVersion } from "./release-notes.mjs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;
export const VERIFIED = "This release passed plugin verification, isolated packed installation checks, and npm registry integrity verification before these notes were published.";
/** The same claim for a page written after the fact (the backfill): the checks ran before npm, not before these notes. */
export const VERIFIED_BEFORE_NPM = "This release passed plugin verification, isolated packed installation checks, and npm registry integrity verification before it was published to npm.";
export const NO_NOTES = "No notes were written for this release.";
export const LATEST = "https://github.com/tomgrin10/paseo-follow-up/releases/latest";
export const MAINTENANCE = "Maintenance release; no user-visible changes.";
export const UNWRITTEN = "No notes were written for this beta. What it added is in the next stable release's notes.";
/** The last tag whose CHANGELOG.md still had the per-beta sections (1.4.0-beta.0 to beta.29). */
export const BETA_SECTIONS_REF = "v1.4.0-beta.68";

/** semver order; prerelease identifiers compare numerically where both are numbers. */
export function compare(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] - +y[i];
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split("."), q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1; if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]) ? +p[i] - +q[i] : p[i].localeCompare(q[i]);
    if (n) return n;
  }
  return 0;
}
const isPre = v => !!SEMVER.exec(v)?.[4];

/**
 * The body of a version's `## <version>` section up to the next `## ` heading, with the draft marker and other
 * comment lines dropped; null when there is none. `full: false` also stops at `<details>` (the old beta archive).
 */
export function section(changelog, version, { full = true } = {}) {
  if (!changelog) return null;
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex(l => HEADING.exec(l)?.[1] === version);
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]) && (full || !/^\s*<\/?details/i.test(lines[end]))) end++;
  const body = lines.slice(at + 1, end).filter(l => !/^\s*<!--.*-->\s*$/.test(l)).join("\n").trim();
  return body || null;
}

/** Git at a ref, through a `git(args)` runner, so tests can use a scratch repository. */
export function gitSource(git) {
  const show = (ref, path) => { try { return git(["show", `${ref}:${path}`]); } catch { return null; } };
  return {
    tags: () => git(["tag", "-l", "v*"]).split("\n").map(t => t.trim()).filter(t => SEMVER.test(t.slice(1))),
    file: show,
    added: (from, to) => git(["diff", "--name-only", "--diff-filter=A", `${from}..${to}`, "--", "changes/"]).split("\n").map(s => s.trim())
      .filter(n => n.endsWith(".md") && !n.endsWith("/README.md")).sort(),
  };
}

const versions = src => src.tags().map(t => t.slice(1));
/** The tag just before `version` in semver order, or null. */
export const previousTag = (src, version) => { const v = versions(src).filter(x => compare(x, version) < 0).sort(compare); return v.length ? `v${v[v.length - 1]}` : null; };

/** The notes for a tag: `{ notes, source }`. */
export function releaseNotes(tag, src) {
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) throw new Error(`Not a version tag: ${tag}`);
  if (!isBeta(version)) {
    const target = notesVersion(version);
    const notes = section(src.file(tag, "CHANGELOG.md"), target);
    if (!notes) throw new Error(`${tag}: CHANGELOG.md at the tag has no ${target} section`);
    return { notes, source: `CHANGELOG.md ${target} (curated)` };
  }
  const own = section(src.file(tag, "CHANGELOG.md"), version, { full: false }) ?? section(src.file(BETA_SECTIONS_REF, "CHANGELOG.md"), version, { full: false });
  if (own) return { notes: own, source: `CHANGELOG.md ${version}` };
  const prev = previousTag(src, version);
  const names = prev ? src.added(prev, tag) : [];
  const bullets = names.flatMap(name => fragmentBullets(name, src.file(tag, name) ?? ""));
  if (bullets.length) return { notes: bullets.map(b => `- ${b}`).join("\n"), source: `${names.length} fragment(s) since ${prev}` };
  // Fragments start with the betas after 1.4.0-beta.29. Before that, a beta without its own section has no notes at all.
  const hadFragments = src.file(tag, "changes/README.md") !== null;
  return { notes: hadFragments ? MAINTENANCE : UNWRITTEN, source: hadFragments ? `no fragments since ${prev}` : "no notes source" };
}

/**
 * The install parts. The plugin id (it was different in 1.x) and the Paseo floor come from paseo-plugin.json at the tag.
 * `pinned`: the fresh-install command names the version (always for a prerelease, and for any page written later).
 */
export function install(tag, src, { pinned = false } = {}) {
  const version = tag.replace(/^v/, "");
  const manifest = JSON.parse(src.file(tag, "paseo-plugin.json") ?? "{}");
  const id = manifest.id ?? "follow-up";
  const floor = String(manifest.requirements?.paseo ?? "").replace(/^\D+/, "") || null;
  const pre = isPre(version);
  const cmd = pre || pinned ? `paseo plugin install npm:paseo-follow-up@${version}` : "paseo plugin install npm:paseo-follow-up";
  const update = pre || pinned ? `paseo plugin update ${id} --version ${version}` : `paseo plugin update ${id}`;
  const parts = [`Already installed: \`${update}\`.`];
  if (pre) parts.push(`Prereleases are on npm's \`beta\` dist-tag; the current stable release is on the [Releases page](${LATEST}).`);
  if (floor) parts.push(`Needs Paseo ${floor} or newer.`);
  return { cmd, line: parts.join(" ") };
}

/** Whether the publish workflow at the tag ran what the verification sentence claims. */
export function verifiedAtTag(tag, src) {
  const wf = src.file(tag, ".github/workflows/publish-npm.yml") ?? "";
  return /npm run verify/.test(wf) && /test:install/.test(wf) && /integrity/i.test(wf);
}

/**
 * The body for a tag. `notes` overrides the notes (the backfill passes a page's own hand-written text);
 * `backfill` marks a page written after the release (pinned install, and the verification claim says "before npm").
 */
export function releaseBody(tag, src, { notes = null, backfill = false } = {}) {
  const text = notes ?? releaseNotes(tag, src).notes;
  const i = install(tag, src, { pinned: backfill });
  const verified = verifiedAtTag(tag, src) ? `\n\n${backfill ? VERIFIED_BEFORE_NPM : VERIFIED}` : "";
  return `**Install:** \`${i.cmd}\`\n\n## What's new\n\n${text}\n\n## Install\n\n${i.line}${verified}\n`;
}

/** The sentences the frame replaces: the Paseo floor, the install id, install or update commands, generic check claims. */
const BOILERPLATE = [
  /^Requires Paseo\b/i, /installation ID\b/i, /^Install with\b/i, /^Already installed\b/i, /^(Validated|Verified) with\b/i,
  /registry integrity\b/i, /^This release passed\b/i, /^Return to stable\b/i, /^Install:/i, /^Install or update\b/i, /^npm publication\b/i,
  // The lead line of the body the publish workflow wrote before every page had notes.
  /^Track workspace pull requests, queue follow-up work, and verify completion in Paseo\.$/,
];
/**
 * A hand-written page's own notes, for the frame. Every paragraph is kept verbatim, except that the old install and
 * verification paragraphs lose their boilerplate sentences (the frame says those); whatever else they say stays.
 * The page's own install section and `## What's new` heading go, and its other `## ` headings move one level down
 * under the frame's. Returns the kept text and every sentence or block it replaced.
 */
export function ownNotes(body) {
  const blocks = (body ?? "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  const kept = [], replaced = [];
  let inInstall = false;
  for (const block of blocks) {
    const b = block.trim();
    const heading = /^##\s+(.*)$/.exec(b);
    if (heading) {
      inInstall = /^install$/i.test(heading[1].trim());
      if (inInstall || /^what's new$/i.test(heading[1].trim())) { replaced.push(block); continue; }
    }
    if (/^```/.test(b) && /paseo plugin (install|update)/.test(b)) { replaced.push(block); continue; }
    if (!heading && !/^[-*#]/.test(b)) {
      const sentences = b.split(/(?<=[.!?])\s+(?=\S)/);
      const keep = sentences.filter(x => !BOILERPLATE.some(re => re.test(x.trim())));
      if (keep.length < sentences.length) {
        replaced.push(...sentences.filter(x => !keep.includes(x)));
        if (keep.length) kept.push(keep.join(" "));
        continue;
      }
    }
    if (inInstall) { replaced.push(block); continue; }
    kept.push(block.replace(/^##(\s)/gm, "###$1"));
  }
  return { text: kept.join("\n\n").trim(), replaced };
}

/** Whether a page body has hand-written notes: a bullet or a section heading. */
export const hasNotes = body => /^\s*[-*]\s+\S/m.test(body ?? "") || /^#{2,3}\s+\S/m.test(body ?? "");
/** Whether a page body is already in this format. */
export const framed = body => /^\*\*Install:\*\* `/.test(body ?? "") && /^## What's new$/m.test(body ?? "") && /^## Install$/m.test(body ?? "");

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const tag = process.argv[2];
  if (!tag) { console.error("Usage: node scripts/release-body.mjs <tag>"); process.exit(1); }
  try {
    const git = args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });
    process.stdout.write(releaseBody(tag, gitSource(git)));
  } catch (e) { console.error(e.message); process.exit(1); }
}
