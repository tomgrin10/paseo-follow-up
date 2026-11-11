// One-shot: gives every existing GitHub release that has no notes the same body a new release gets
// (scripts/release-body.mjs). A release whose body already has notes (a bullet or a heading) is left alone.
//   node scripts/backfill-release-notes.mjs [--out <dir>] [--only v1.4.0-beta.10,…]   dry run: writes <tag>.md, edits nothing
//   node scripts/backfill-release-notes.mjs --apply [--only …]                         runs `gh release edit <tag> --notes-file`
// Needs the tags fetched (`git fetch --tags`) and `gh` signed in to an account that can edit the repository's releases.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compare, gitSource, hasNotes, releaseBody, releaseNotes } from "./release-body.mjs";

/**
 * What to do with each release: `{ tag, action: "write" | "keep" | "skip", reason, body? }`. Pure apart from `src` and
 * the release list, so tests can drive it.
 */
export function plan(releases, src, only = null) {
  return releases
    .filter(r => !only || only.includes(r.tagName))
    .sort((a, b) => compare(a.tagName.slice(1), b.tagName.slice(1)))
    .map(r => {
      if (hasNotes(r.body)) return { tag: r.tagName, action: "keep", reason: "already has notes" };
      try {
        const { source } = releaseNotes(r.tagName, src);
        return { tag: r.tagName, action: "write", reason: source, body: releaseBody(r.tagName, src) };
      } catch (e) { return { tag: r.tagName, action: "skip", reason: e.message }; }
    });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const apply = args.includes("--apply");
  const only = arg("--only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
  const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  const src = gitSource(a => run("git", a));
  const list = JSON.parse(run("gh", ["release", "list", "--limit", "500", "--json", "tagName"]));
  const releases = list.map(({ tagName }) => ({ tagName, body: JSON.parse(run("gh", ["release", "view", tagName, "--json", "body"])).body }));
  const steps = plan(releases, src, only);
  const out = arg("--out") ?? mkdtempSync(join(tmpdir(), "release-bodies-"));
  mkdirSync(out, { recursive: true });
  for (const s of steps) {
    if (s.action === "write") {
      const file = join(out, `${s.tag}.md`);
      writeFileSync(file, s.body);
      if (apply) run("gh", ["release", "edit", s.tag, "--notes-file", file]);
    }
    console.log(`${s.tag.padEnd(18)} ${s.action === "write" ? (apply ? "edited" : "would edit") : s.action.padEnd(10)}  ${s.reason}`);
  }
  const n = steps.filter(s => s.action === "write").length;
  console.log(`\n${n} release(s) ${apply ? "edited" : "to edit (dry run; bodies in " + out + ")"}, ${steps.filter(s => s.action === "keep").length} kept, ${steps.filter(s => s.action === "skip").length} skipped.`);
}
