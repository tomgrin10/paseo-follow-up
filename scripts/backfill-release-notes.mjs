// One-shot: puts every existing GitHub release page in the format a new release gets (scripts/release-body.mjs).
// - A page with no notes gets that release's rendered notes, or "No notes were written for this release."
// - A beta page with hand-written notes keeps its text verbatim under ## What's new; only its old install and
//   verification paragraphs are replaced by the frame's (ownNotes, listed in the dry run).
// - A stable or rc page with notes of its own is curated and left exactly as it is.
// - A page already in the format, or named in --except, is left alone.
// Every page's current body is saved first as <tag>.before.md and in backup.json, so it can be restored.
//   node scripts/backfill-release-notes.mjs [--out <dir>] [--only a,b] [--except v2.0.0-rc.0]   dry run, edits nothing
//   node scripts/backfill-release-notes.mjs --apply [same flags]                                runs `gh release edit`
// Needs the tags fetched (`git fetch --tags`) and `gh` signed in to an account that can edit the repository's releases.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NO_NOTES, compare, framed, gitSource, ownNotes, releaseBody, releaseNotes } from "./release-body.mjs";

/**
 * What to do with each release: `{ tag, action: "write" | "keep", reason, body?, replaced? }`. Pure apart from `src`,
 * so tests can drive it.
 */
export function plan(releases, src, { only = null, except = [] } = {}) {
  return releases
    .filter(r => (!only || only.includes(r.tagName)) && !except.includes(r.tagName))
    .sort((a, b) => compare(a.tagName.slice(1), b.tagName.slice(1)))
    .map(r => {
      if (framed(r.body)) return { tag: r.tagName, action: "keep", reason: "already in the format" };
      // Anything a person wrote on the page (whatever survives the boilerplate filter) is kept.
      const own = ownNotes(r.body);
      // A stable or rc page with notes of its own was curated: kept as it is, install paragraph and all
      // (backfill-keeps-curated-notes; 2026-11-12, rc.0's page told 1.x users the old id to update).
      if (own.text && !/-beta\./.test(r.tagName)) return { tag: r.tagName, action: "keep", reason: "curated notes kept as they are" };
      if (own.text) {
        return { tag: r.tagName, action: "write", reason: `own notes kept, ${own.replaced.length} install/verification paragraph(s) replaced`, body: releaseBody(r.tagName, src, { notes: own.text || NO_NOTES, backfill: true }), replaced: own.replaced };
      }
      try {
        const { source } = releaseNotes(r.tagName, src);
        return { tag: r.tagName, action: "write", reason: source, body: releaseBody(r.tagName, src, { backfill: true }) };
      } catch { return { tag: r.tagName, action: "write", reason: "no notes source", body: releaseBody(r.tagName, src, { notes: NO_NOTES, backfill: true }) }; }
    });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const apply = args.includes("--apply");
  const list = name => arg(name)?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
  const only = list("--only"), except = list("--except") ?? [];
  const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  const src = gitSource(a => run("git", a));
  const tags = JSON.parse(run("gh", ["release", "list", "--limit", "500", "--json", "tagName"]));
  const releases = tags.map(({ tagName }) => ({ tagName, body: JSON.parse(run("gh", ["release", "view", tagName, "--json", "body"])).body }));
  const steps = plan(releases, src, { only, except });
  const out = arg("--out") ?? mkdtempSync(join(tmpdir(), "release-bodies-"));
  mkdirSync(out, { recursive: true });
  // The backup comes first, for every page, whatever happens next.
  writeFileSync(join(out, "backup.json"), JSON.stringify(releases, null, 2));
  for (const r of releases) writeFileSync(join(out, `${r.tagName}.before.md`), r.body ?? "");
  for (const s of steps) {
    if (s.action === "write") {
      const file = join(out, `${s.tag}.md`);
      writeFileSync(file, s.body);
      if (apply) run("gh", ["release", "edit", s.tag, "--notes-file", file]);
    }
    console.log(`${s.tag.padEnd(18)} ${s.action === "write" ? (apply ? "edited" : "would edit") : s.action.padEnd(10)}  ${s.reason}`);
    for (const p of s.replaced ?? []) console.log(`${"".padEnd(18)}   replaced: ${p.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const n = steps.filter(s => s.action === "write").length;
  console.log(`\n${n} release(s) ${apply ? "edited" : "to edit (dry run; bodies in " + out + ")"}, ${steps.filter(s => s.action === "keep").length} kept; backups of every page in ${out}.`);
}
