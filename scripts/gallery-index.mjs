// Writes docs/screenshots/gallery/INDEX.md: every gallery image, what it shows, and the commit and version it was shot
// at (read from each PNG's git state: a file changed since the last commit is "this working tree"). Run by
// scripts/gallery-shots.sh; safe to run by hand after copying a PR's own renders in.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const dir = process.argv[2] ?? "docs/screenshots/gallery";
/** What each surface shows. A new surface needs a line here, or INDEX.md says so. */
export const SURFACES = {
  home: "Home: every workspace grouped by what it needs from you, with agent work and PR status lines; the morning brief on the right (desktop), and the list (phone).",
  "decision-card": "A decision card: the agent's question with lettered options, the recommendation and what the agent does meanwhile, in Home's detail pane.",
  sidebar: "Follow-up's list as Paseo's sidebar view (Paseo 0.16+), with a workspace's chat beside it.",
  panel: "The workspace panel beside the chat: status, Needs you, pull requests and activity (desktop); the larger view (phone).",
  pill: "The composer pill opened above the chat: the open question and the workspace's other asks.",
  "pr-sheet": "The PR sheet for a PR whose checks failed: checks, reviewers and merge controls.",
  "catch-up": "Catch up: everything that needs you, one card at a time, on the question card.",
  overseer: "The Overseer, asked from Home's search box, answering about every workspace.",
  new: "New: start work from a Linear issue, a link or your own words.",
  settings: "Settings, General tab.",
  "whats-new": "What's new after an update.",
  setup: "The first step of setup on a fresh install.",
};
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return ""; } };
const head = git("rev-parse", "--short", "HEAD");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const files = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
const shotAt = file => {
  const path = join(dir, file);
  if (git("status", "--porcelain", "--", path)) return `this tree (on ${head}, ${version})`;
  const sha = git("log", "-1", "--format=%h", "--", path);
  const v = sha ? JSON.parse(git("show", `${sha}:package.json`) || "{}").version : "";
  return sha ? `${sha}${v ? ` (${v})` : ""}` : "unknown";
};
const rows = files.map(f => {
  const m = f.match(/^(.+)-(desktop|phone)-(light|dark)\.png$/);
  const surface = m?.[1] ?? f;
  const kb = Math.round(statSync(join(dir, f)).size / 1024);
  const png = readFileSync(join(dir, f));
  const px = `${png.readUInt32BE(16)}×${png.readUInt32BE(20)} px`;
  return `| [${f}](${f}) | ${SURFACES[surface] ?? "(no description: add one to scripts/gallery-index.mjs)"} | ${m ? `${m[2]} ${m[3]}, ` : ""}${px} | ${kb} KB | ${shotAt(f)} |`;
});
const missing = Object.keys(SURFACES).filter(s => !files.some(f => f.startsWith(`${s}-`)));
writeFileSync(join(dir, "INDEX.md"), `# Screenshot gallery

Current renders of every main surface, so there is always an up-to-date image to hand. Synthetic data only. Not part of
the npm package. Re-shoot with \`npm run shots:gallery\` (rules in [AGENTS.md](../../../AGENTS.md#screenshots-and-the-gallery)
and [docs/testing.md](../../testing.md#screenshots)); this file is rewritten by \`scripts/gallery-index.mjs\`.

| File | Shows | Device, theme, pixels | Size | Shot at |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
${missing.length ? `\nNot shot yet: ${missing.join(", ")}.\n` : ""}`);
console.log(`gallery index: ${files.length} images${missing.length ? `, missing ${missing.join(", ")}` : ""}`);
