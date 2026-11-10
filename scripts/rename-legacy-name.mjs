// The mechanical half of 2.0's rename: the product's old internal name becomes "Follow-up" everywhere it's written,
// in every tracked file except CHANGELOG.md (history stays as written) and the legacy module (shared/legacy.ts), which
// is the one place that still recognises what 1.x left behind. Hand-written code (shared/legacy.ts, the data move,
// the hook and MCP cleanup) never relies on this script; it uses the helpers in shared/legacy.ts.
//
// Re-runnable on any base: `node scripts/rename-legacy-name.mjs` rewrites in place and prints what changed;
// `--check` changes nothing and exits 1 if anything would change. tests/no-legacy-name.test.ts is the invariant.
//
// This file spells the old name only in pieces, so the scan test can cover it too.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const F = "follow", T = "through";
/** Files the scan and the rewrite skip. Keep in sync with tests/no-legacy-name.test.ts. */
export const EXEMPT = ["CHANGELOG.md", "shared/legacy.ts"];
/** Binary or generated files the rewrite never edits (the scan still reads text ones). */
const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pen|tgz|zip|pdf)$/i;

/**
 * Ordered: the specific spellings first, so prose and identifiers each get their own form.
 * Every rule maps an old spelling to the 2.0 one; none of them can produce the old name again.
 */
export const RULES = [
  [new RegExp(`${F.toUpperCase()}_${T.toUpperCase()}_`, "g"), "FOLLOW_UP_"],
  [new RegExp(`${F.toUpperCase()}_${T.toUpperCase()}`, "g"), "FOLLOW_UP"],
  [new RegExp(`Workspace ${F}-${T} batch`, "g"), "Workspace Follow-up batch"],
  [new RegExp(`${F[0].toUpperCase()}${F.slice(1)}-${T}`, "g"), "Follow-up"],
  [new RegExp(`${F[0].toUpperCase()}${F.slice(1)} ${T}`, "g"), "Follow up"],
  [new RegExp(`${F}${T}-fixture`, "g"), "followup-fixture"],
  [new RegExp(`${F}${T}`, "g"), "followup"],
  [new RegExp(`${F}_${T}`, "g"), "follow_up"],
  [new RegExp(`${F}-${T}`, "g"), "follow-up"],
  [new RegExp(`${F} ${T}`, "g"), "follow up"],
];
/** The scan pattern (tests/no-legacy-name.test.ts uses the same one). */
export const LEGACY = new RegExp(`${F}[-_ ]?${T}`, "i");

export function rewrite(text) {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

export function trackedFiles(cwd = process.cwd()) {
  return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const changed = [];
  for (const file of trackedFiles()) {
    if (EXEMPT.includes(file) || SKIP.test(file) || !existsSync(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = rewrite(before);
    const target = rewrite(file);
    if (after === before && target === file) continue;
    changed.push(target === file ? file : `${file} -> ${target}`);
    if (check) continue;
    if (target !== file) {
      mkdirSync(dirname(target), { recursive: true });
      execFileSync("git", ["mv", file, target]);
    }
    writeFileSync(target, after);
  }
  for (const line of changed) console.log(line);
  console.log(`${changed.length} file(s) ${check ? "would change" : "changed"}`);
  if (check && changed.length) process.exit(1);
}
