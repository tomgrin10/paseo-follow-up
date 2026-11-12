// user-visible-change-has-a-note: a PR that changes the plugin's code (server/, client/, shared/ or the entry files)
// adds a changes/ fragment, or carries the `no-release-note` label (pure refactors, tests). 2026-11-12: three
// user-visible fixes (the worker's CPU, disk reads and daemon connections) merged without one, and v2.0.1-beta.0's
// generated notes said "no user-visible changes".
// CI runs it on pull requests: `node scripts/check-release-note.mjs` (base from GITHUB_BASE_REF, labels from the event).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LABEL = "no-release-note";
const CODE = /^(server|client|shared)\/|^index\.(server|client)\.tsx?$/;
const FRAGMENT = /^changes\/(?!README\.md$)[^/]+\.md$/;

/** null when the PR is fine, else what's missing. */
export function missingNote(files, labels) {
  const code = files.filter(f => CODE.test(f));
  if (!code.length || labels.includes(LABEL) || files.some(f => FRAGMENT.test(f))) return null;
  return `This PR changes ${code.slice(0, 3).join(", ")}${code.length > 3 ? ` and ${code.length - 3} more` : ""} but adds no release note. ` +
    `Add changes/<branch>.md (see changes/README.md), or the "${LABEL}" label if users can't see or feel the change.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) { console.log("Not a pull request: no release note check."); process.exit(0); }
  const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=AMR", `origin/${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const labels = (event.pull_request?.labels ?? []).map(l => l.name);
  const missing = missingNote(files, labels);
  if (missing) { console.error(`::error::${missing}`); process.exit(1); }
  console.log("Release note check passed.");
}
