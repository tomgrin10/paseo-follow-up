// Re-shoots every README image from the current UI: `npm run shots` (through ~/paseo-harness/tools/harness-slot).
// Usage: node scripts/screenshots.mjs [--out <dir>] [--only home,panel,...] [--scheme dark|light] [--scale <n>]
//                                     [--whats-new-changelog <CHANGELOG.md>] [--whats-new-all] [--notes-review]
//                                     [--whats-new-review] [--keep]
//                                     [--as-version <X.Y.Z>]
// `--as-version` installs the packed plugin under that version, so Home and the panel read "vX.Y.Z" (stable notes
// and README images never show an rc). The notes shots set their own scale: notes-home 2x, notes-panel 3x.
//
// One isolated daemon (temp HOME and PASEO_HOME, the packed plugin, the fixture provider from
// scripts/fixture-provider.ts, the web UI, a fake `gh` and a fake `mcpproxy` for Linear on PATH), seeded through Follow-up's own RPCs and fixture agents
// with synthetic data only: example/app, made-up people (Dana, Ravi) and Linear-style keys (APP-142, WEB-17).
// Each shot is written as follow-up-<shot>.png.
//
// Deterministic: fixed seed data, and fixed clocks. The daemon and the plugin worker run with a Date preload that reads
// a shifted clock from a file, so everything is created at fixed times after BASE; the browser's clock is frozen with
// Playwright's page.clock. Ages and times don't drift between runs. Every wait is on a real UI state, not a sleep.
//
// Theme: dark for desktop product shots (Paseo's default), light for the phone shot. `--scheme` overrides both.
// Size (aim: under ~300 KB each): deviceScaleFactor 2, then pngquant (lossy palette) or oxipng when one is on PATH.
// Without either, desktop shots use deviceScaleFactor 1.25 instead (the phone shot stays at 2) and keep Playwright's
// own PNG. `--scale <n>` sets the desktop factor.
//
// Needs PLAYWRIGHT_CORE (a playwright-core directory) and CHROMIUM (a Chromium or headless-shell binary), and the
// Paseo CLI 0.15.x on PATH (harness-slot puts it first).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertNoRealNames } from "./real-names.mjs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { fontWeightProblem } from "./font-weights.mjs";
import { PROVIDER_TOOLS, daemonCrashes, harnessEnv, harnessConfig } from "./harness-env.mjs";
import { fakeGithub } from "./fake-github.mjs";
// shared/onboarding.ts imports without extensions, which plain node can't load: read its step list as text.
const ONBOARDING_STEPS = JSON.parse((await fs.readFile(new URL("../shared/onboarding.ts", import.meta.url), "utf8")).match(/ONBOARDING_STEPS = (\[[^\]]*\])/)[1]);
import { openHome as openHomeAt, homeRow, homeUrl } from "./ui-home.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
// What's new reinstalls the plugin as the CHANGELOG's newest stable, so it goes last: every other shot shows the version under test.
const SHOTS = ["setup", "home", "sidebar", "panel", "questions", "pill", "pr-sheet", "phone", "linked-items", "notes-home", "notes-panel", "tasks", "tasks-sheet", "tasks-phone", "whats-new"];
/** Opt-in review sets, never part of the README run: they seed extra workspaces of their own. */
const REVIEW_SHOTS = ["menu-bounds", "tasks-view", "settings-tabs", "dictation", "local-titles", "shortcut", "search-focus", "split", "rowchips", "needs-you-states", "own-answer", "dock-in-view", "done-brief", "pick-notes", "review-mode", "deploy-check", "feeds", "put-in-chat", "sending", "pr-link", "merge-click", "reviewers-click", "catch-up", "icon", "home-keys", "more-context", "dismiss", "layout-search", "pr-scale", "paged-lists", "pr-stats-settings", "morning-brief", "older-briefs", "new", "pr-stats", "pr-stats-off", "archive", "paste-images", "attach-images", "compass", "compass-suggest", "compass-readers", "batch-churn", "scheduled-tasks", "your-questions", "now-line", "peek", "pr-now", "panel-folds", "question-links", "gallery", "frames", "onboarding", "setup-popup", "advanced"];
/** Pasted images and their Add image button share one harness setup (an Overseer and the fixture provider taking images). */
const PASTE_LIKE = only => only.includes("paste-images") || only.includes("attach-images");
const only = arg("--only") ? arg("--only").split(",").map(s => s.trim()).filter(Boolean) : SHOTS;
for (const name of only) if (![...SHOTS, ...REVIEW_SHOTS].includes(name)) fail(`unknown shot "${name}" (known: ${[...SHOTS, ...REVIEW_SHOTS].join(", ")})`);
const scheme = arg("--scheme");
if (scheme && !["dark", "light"].includes(scheme)) fail("--scheme is dark or light");
const out = resolve(arg("--out", "docs/screenshots"));
const changelogArg = arg("--whats-new-changelog");
const keep = argv.includes("--keep");
const asVersion = arg("--as-version");
if (asVersion && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(asVersion)) fail("--as-version is a version like 2.0.0");
const log = (...a) => console.log("[shots]", ...a);
/**
 * `--only onboarding --variant <v>`: a stranger's first run, setup's every step from a packed tarball on a fresh
 * PASEO_HOME with no mcpproxy (no Linear, Slack or Compass sources). One variant per run, because what the host has
 * (gh, providers) is fixed when the daemon starts. `gh`: the fake signed-in gh, or none on PATH at all. `providers`:
 * which Paseo providers can run (`claude` and `codex` are stand-in binaries Paseo finds on PATH; `fixture` is the
 * plugin provider, standing in for any other provider such as an ACP one).
 */
const ONBOARDING_VARIANTS = {
  "no-gh": { gh: false, providers: ["claude"] },
  "claude": { gh: true, providers: ["claude"] },
  "codex": { gh: true, providers: ["codex"] },
  "other": { gh: true, providers: ["fixture"] },
  "none": { gh: false, providers: [] },
};
const variantName = arg("--variant", "no-gh");
const variant = only.includes("onboarding") ? ONBOARDING_VARIANTS[variantName] ?? fail(`unknown --variant "${variantName}" (known: ${Object.keys(ONBOARDING_VARIANTS).join(", ")})`) : null;
function fail(message) { console.error(`screenshots: ${message}`); process.exit(1); }

// ---------- preflight ----------
if (!process.env.PLAYWRIGHT_CORE || !existsSync(join(process.env.PLAYWRIGHT_CORE, "package.json"))) fail("set PLAYWRIGHT_CORE to a playwright-core directory (e.g. ~/paseo-switcher/node_modules/playwright-core)");
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) fail("set CHROMIUM to a Chromium or chrome-headless-shell binary");
const paseoVersion = await exec("paseo", ["--version"], { timeout: 30000 }).then(r => r.stdout.trim(), () => null);
// The sidebar shot and --sidebar-review need sidebar views, which arrive in Paseo 0.16 (HARNESS_PASEO=0.16 runs the
// global CLI, 0.16 or later); every other shot stays on 0.15.x.
const paseo016 = /(^|\D)0\.1[6-9]\.\d+/.test(paseoVersion ?? "");
if (only.includes("sidebar") && only.some(n => n !== "sidebar")) fail("shoot --only sidebar on its own, with HARNESS_PASEO=0.16");
if (only.includes("sidebar") && !paseo016) fail(`the sidebar shot needs the Paseo CLI 0.16.x (found ${paseoVersion ?? "none"}); run with HARNESS_PASEO=0.16`);
if (only.includes("feeds") && only.length > 1) fail("run --only feeds on its own (npm run test:feeds)");
const paseoOk = only.includes("menu-bounds") || only.includes("settings-tabs") || only.includes("new") || only.includes("onboarding") || PASTE_LIKE(only) || only.includes("gallery") || only.includes("search-focus") || only.includes("frames") || only.includes("your-questions") || only.includes("peek") ? /(^|\D)0\.1[5-7]\.\d+/ : only.includes("sidebar") || only.includes("feeds") || only.includes("put-in-chat") || argv.includes("--sidebar-review") || argv.includes("--overseer-review") || argv.includes("--keys-review") || argv.includes("--rank-review") || argv.includes("--sortfoot-review") || argv.includes("--secsearch-review") || argv.includes("--github-wait-review") ? /(^|\D)0\.1[56]\.\d+/ : /(^|\D)0\.15\.\d+/;
if (!paseoVersion || !paseoOk.test(paseoVersion)) fail(`needs the Paseo CLI 0.15.x on PATH (found ${paseoVersion ?? "none"}); run through harness-slot or put ~/paseo-harness/cli/0.15.4/bin first`);
if (changelogArg && !existsSync(changelogArg)) fail(`--whats-new-changelog: no file at ${changelogArg}`);
const optimiser = await findOptimiser();
await harness();
const desktopScale = Number(arg("--scale", optimiser ? 2 : 1.25));
if (!(desktopScale >= 1 && desktopScale <= 3)) fail("--scale is between 1 and 3");

// ---------- fixed clock ----------
/** Every seeded record is created at a fixed offset after BASE (fake time), and the browser shows BASE + VIEW. */
const BASE = Date.parse("2026-03-04T09:00:00.000Z");
const VIEW = 3 * 3600_000;
const at = minutes => BASE + minutes * 60_000;
const CLOCK_PRELOAD = `
const fs = require("node:fs"); const file = process.env.FOLLOW_SHOTS_CLOCK; const RealDate = Date; const realNow = RealDate.now.bind(RealDate);
// The clock file is {fake, real, rate}: "now" is fake + (real time since real) * rate.
let clock = { fake: realNow(), real: realNow(), rate: 1 };
const read = () => { try { clock = JSON.parse(fs.readFileSync(file, "utf8")); } catch {} }; read();
setInterval(read, 100).unref();
const now = () => Math.round(clock.fake + (realNow() - clock.real) * clock.rate);
class ShiftedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } }
globalThis.Date = ShiftedDate;
// The resource governor reads host-wide pressure, CPU and Paseo's cgroup memory. On a shared VM those move at random:
// they pause polling and print a live "Paseo memory · CPU" meter on Home. This isolated daemon can't read them, which
// the governor treats as unknown (never "over budget") and Home shows no meter.
const fsp = require("node:fs/promises"); const readFile = fsp.readFile;
const hidden = path => { if (typeof path !== "string") return false; const leaf = path.split("/").pop(); return path.startsWith("/proc/pressure/") || path === "/proc/stat" || path.startsWith("/sys/fs/cgroup/") && (leaf.startsWith("memory.") || leaf.startsWith("cpu.")); };
// The sending review set alone gives the governor a fake cgroup (FOLLOW_SHOTS_CGROUP: {high, current}), so Home can
// show the auto-send hold on cue; every other shot keeps it unreadable.
const fakeCgroup = path => { const f = process.env.FOLLOW_SHOTS_CGROUP; if (!f || typeof path !== "string" || !path.startsWith("/sys/fs/cgroup/")) return null;
  let v; try { v = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
  const leaf = path.split("/").pop(); return leaf === "memory.high" ? String(v.high) : leaf === "memory.current" ? String(v.current) : leaf === "memory.stat" ? "" : null; };
fsp.readFile = function (path, ...rest) { const fake = fakeCgroup(path); if (fake !== null) return Promise.resolve(fake); return hidden(path) ? Promise.reject(Object.assign(new Error("ENOENT: hidden by scripts/screenshots.mjs"), { code: "ENOENT" })) : readFile.call(this, path, ...rest); };
// Paseo colours a project's avatar from a hash of its server id and project id. The server id is fixed through
// PASEO_SERVER_ID; project and workspace ids come from a counter here, so the avatar is the same colour every run.
const crypto = require("node:crypto"); const randomBytes = crypto.randomBytes; let idCount = 0;
crypto.randomBytes = function (size, ...rest) {
  if (rest.length || !String(new Error().stack).includes("workspace-registry-model")) return randomBytes.call(this, size, ...rest);
  const bytes = Buffer.alloc(size); crypto.createHash("sha256").update("follow-up-shots:" + idCount++).digest().copy(bytes); return bytes;
};
require("node:module").syncBuiltinESMExports();
`;

// ---------- fixture data (synthetic only: this is a public repo) ----------
const ok = name => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });
const failed = name => ({ name, status: "COMPLETED", conclusion: "FAILURE" });
const running = name => ({ name, status: "IN_PROGRESS", conclusion: null });
/** What the fake `gh` answers, by PR number (numbers are unique across example/app and example/web). */
function pulls() {
  return {
    141: { title: "Add the retry schedule table", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    142: { title: "Retry failed charges with exponential backoff", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [failed("test"), ok("lint"), ok("typecheck")] },
    143: { title: "Send the dunning email after the last retry", state: "OPEN", author: "dana", base: "branch-142", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint"), ok("typecheck")] },
    // merge-click only: a three-PR stack, every PR approved and green, so one click merges all three.
    250: { title: "Add the export filter model", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    251: { title: "Filter exports by date range", state: "OPEN", author: "dana", base: "branch-250", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    252: { title: "Show export filters in the admin page", state: "OPEN", author: "dana", base: "branch-251", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    // reviewers-click only: five open PRs per workspace, none with reviewers yet.
    ...Object.fromEntries(REVIEWERS_CLICK_STATES.flatMap(w => w.prs.map(([n, title]) => [n, { title, state: "OPEN", author: "dana", checks: [ok("test"), ok("lint")] }]))),
    255: { title: "Attach PDF receipts to invoice emails", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    256: { title: "Send a weekly invoice digest", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    151: { repo: "example/web", title: "Saved search filters", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    247: { title: "Checkout button copy", state: "OPEN", author: "dana", conflict: true, threads: 1, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    248: { title: "Refund reason codes", state: "OPEN", author: "dana", conflict: true, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    // sending only (invariant 133): Tax rates' repair runs on its own while Coupon codes' waits for a free turn.
    244: { title: "Read tax rates from the rates table", state: "OPEN", author: "dana", conflict: true, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    245: { title: "One coupon code per checkout", state: "OPEN", author: "dana", conflict: true, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    160: { title: "Welcome email template", state: "OPEN", author: "dana", conflict: true, threads: 2, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    170: { title: "APP-160: Sign webhook payloads", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    181: { repo: "example/web", title: "Dark mode color tokens", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    // The README lead shot's other groups (2.0.x): Waiting, Fixing, Later.
    188: { title: "Render invoices as PDF", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [failed("test"), ok("lint"), ok("e2e")] },
    191: { title: "Team invite links", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [running("test"), ok("lint")] },
    195: { title: "Add the SAML provider", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    196: { title: "SSO login button", state: "OPEN", author: "dana", base: "branch-195", checks: [ok("test"), ok("lint")] },
    205: { repo: "example/web", title: "Saved dashboard views", state: "OPEN", author: "dana", conflict: true, changes: ["ravi"], threads: 1, checks: [ok("test"), ok("lint")] },
    212: { repo: "example/web", title: "Usage dashboard charts", state: "OPEN", author: "dana", draft: true, checks: [ok("test"), ok("lint")] },
    218: { repo: "example/web", title: "Push notification settings", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    224: { repo: "example/web", title: "Import contacts from CSV", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    246: { title: "Export the audit log as CSV", state: "OPEN", author: "dana", checks: [running("test"), ok("lint")] },
    240: { title: "Stream large invoice exports", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    232: { title: "Usage alert thresholds", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    // needs-you-states' person item: a stale CHANGES_REQUESTED, no open threads, nothing left in the code.
    262: { title: "Retry failed invoice webhooks", state: "OPEN", author: "dana", changes: ["ravi"], checks: [ok("test"), ok("lint")] },
    // batch-churn only: a review that keeps moving (#270; batchChurnShots adds threads and replies) and a PR that later
    // gets a conflict (#271). `replies`: a thread's last comment time, by index (default 08:30).
    270: { title: "Sign outgoing webhook payloads", state: "OPEN", author: "dana", changes: ["sam"], threads: 2, checks: [ok("test"), ok("lint")] },
    271: { title: "Document webhook signature checks", state: "OPEN", author: "dana", reviewers: ["sam"], checks: [ok("test"), ok("lint")] },
    // question-links only (checks-say-what-they-are-doing): an upstream fork PR whose required checks never start.
    ...(only.includes("question-links") ? { 8811: { title: "Cap retries for forked builds", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [] } } : {}),
    ...(only.includes("pr-now") ? Object.fromEntries([8801, 8802, 8803, 8804].map(number => [number, { repo: number > 8802 ? "acme/widgets" : "example/app", title: number % 2 ? "Review the retry cap" : "Check the retry cap", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [number % 2 ? ok("test") : running("test"), ok("lint")] }])) : {}),
  };
}
/**
 * pr-scale only (pr-scale-lists-batch-not-throw): one 120-PR stack in example/app (#1001 at the bottom, #1120 on top),
 * twice the 50-item cap that failed on 2026-11-22, plus three short stacks in example/web. Made-up titles; a few PRs
 * carry failing checks, review threads or an approval so the rail isn't one colour.
 */
const PR_SCALE = { bottom: 1001, size: 120 };
const PR_SCALE_TOP = PR_SCALE.bottom + PR_SCALE.size - 1;
const PR_SCALE_WEB = [{ stack: "Settings redesign", numbers: [1201, 1202, 1203] }, { stack: "Search chips", numbers: [1211, 1212] }, { stack: "Footer links", numbers: [1221] }];
function prScalePulls() {
  const areas = ["ledger entries", "journal lines", "account balances", "currency rates", "posting rules", "period close", "audit trail", "reconciliation", "invoice links", "payout batches"];
  const verbs = ["Move", "Index", "Validate", "Backfill", "Split", "Rename", "Cache", "Test", "Document", "Stream"];
  const out = {};
  for (let i = 0; i < PR_SCALE.size; i++) {
    const n = PR_SCALE.bottom + i;
    out[n] = { title: `${verbs[i % verbs.length]} ${areas[Math.floor(i / verbs.length) % areas.length]} (step ${i + 1} of ${PR_SCALE.size})`, state: "OPEN", author: "dana",
      ...(i ? { base: `branch-${n - 1}` } : {}), ...(i < 3 ? { approved: true, reviewed: ["ravi"] } : { reviewers: ["ravi"] }),
      ...(i % 37 === 36 ? { threads: 1 } : {}), checks: [i % 29 === 28 ? failed("test") : i === PR_SCALE.size - 1 ? running("test") : ok("test"), ok("lint")] };
  }
  const webTitles = { 1201: "Settings page layout grid", 1202: "Move notification toggles", 1203: "Settings search box", 1211: "Filter chips component", 1212: "Chips in the search bar", 1221: "Footer links to the status page" };
  for (const { numbers } of PR_SCALE_WEB) numbers.forEach((n, i) => { out[n] = { repo: "example/web", title: webTitles[n], state: "OPEN", author: "dana", reviewers: ["ravi"], ...(i ? { base: `branch-${numbers[i - 1]}` } : {}), checks: [ok("test"), ok("lint")] }; });
  return out;
}
/** A fake `gh`: GraphQL PR reads from the fixture file, `[]` for everything else (branch rules, auth). fakeGithub serves it over HTTP. */
function fakeGh(file) {
  return `#!/usr/bin/env node
const d = JSON.parse(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));
// gh pr merge: succeed after a beat, so the merge-click shots can catch "Merging…", and leave the PR merged, as GitHub does.
if (process.argv[2] === "pr" && process.argv[3] === "merge") setTimeout(() => {
  const n = Number(process.argv[4]);
  if (d[n] && !process.argv.includes("--auto") && !process.argv.includes("--disable-auto")) { d[n].state = "MERGED"; d[n].mergedAt = new Date().toISOString(); require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(d)); }
  process.exit(0);
}, 6000);
// gh api POST …/requested_reviewers (reviewers-click): GitHub answers after a beat, so the shots catch "Requesting…",
// then the PR shows the reviewers. Five run at once, so each re-reads the file and adds only its own PR's reviewers.
else if (process.argv[2] === "api" && process.argv.includes("POST") && /pulls\\/\\d+\\/requested_reviewers$/.test(process.argv.find(a => a.includes("requested_reviewers")) || "")) setTimeout(() => {
  const n = Number(/pulls\\/(\\d+)\\//.exec(process.argv.find(a => a.includes("requested_reviewers")))[1]);
  const now = JSON.parse(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));
  if (now[n]) { now[n].reviewers = process.argv.filter(a => a.startsWith("reviewers[]=")).map(a => a.slice(12)); require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(now)); }
  console.log("{}"); process.exit(0);
}, 3500);
else {
if (process.argv[3] !== "graphql") { console.log("[]"); process.exit(0); }
const query = process.argv.find(a => a.startsWith("query=")) || "";
const repository = { defaultBranchRef: { name: "main", branchProtectionRule: { requiredStatusCheckContexts: ["test", "lint"] } }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH", mergeQueue: null };
const user = login => ({ __typename: "User", login });
for (const m of query.matchAll(/(p\\d+):pullRequest\\(number:(\\d+)\\)/g)) {
  const n = Number(m[2]); const p = d[n];
  if (!p) { repository[m[1]] = null; continue; }
  const base = p.base ?? "main";
  repository[m[1]] = { number: n, title: p.title, url: "https://github.com/" + (p.repo ?? "example/app") + "/pull/" + n, state: p.state, headRefName: "branch-" + n, headRefOid: "0f3c9a" + n, baseRefName: base,
    isDraft: !!p.draft, mergeable: p.conflict ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: p.conflict ? "DIRTY" : p.draft ? "DRAFT" : "CLEAN", reviewDecision: p.changes ? "CHANGES_REQUESTED" : p.approved ? "APPROVED" : "REVIEW_REQUIRED",
    mergedAt: p.state === "MERGED" ? p.mergedAt ?? "2026-03-04T08:00:00Z" : null, mergeCommit: p.state === "MERGED" ? { oid: "9a1b2c" + n } : null, isInMergeQueue: false, autoMergeRequest: null,
    author: { login: p.author },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: (p.reviewers ?? []).map(l => ({ requestedReviewer: user(l) })) },
    latestReviews: { pageInfo: { hasNextPage: false }, nodes: [...(p.reviewed ?? []).map(l => ({ state: "APPROVED", author: user(l) })), ...(p.changes ?? []).map(l => ({ state: "CHANGES_REQUESTED", author: user(l) }))] },
    baseRef: { branchProtectionRule: base === "main" ? { requiredStatusCheckContexts: ["test", "lint"] } : null, associatedPullRequests: { nodes: base === "main" ? [] : [{ number: Number(base.slice(7)), headRefName: base, state: d[Number(base.slice(7))]?.state ?? "OPEN", headRepository: { nameWithOwner: p.repo ?? "example/app" } }] } },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: p.threads ?? 0 }, (_, i) => ({ id: "thread-" + n + "-" + i, isResolved: false, comments: { nodes: [{ updatedAt: (p.replies && p.replies[i]) || "2026-03-04T08:30:00Z" }] } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: p.checks ?? [] } } } }] } };
}
// pr-stats-settings: the opt-in sheet's estimate (search issueCount + repository id, with GitHub's rateLimit).
const stats = query.includes("search(") ? { search: { issueCount: d._statsSearch ?? 0 }, rateLimit: d._rate ?? { cost: 1, remaining: 4800, resetAt: new Date(Date.now() + 3600000).toISOString(), limit: 5000 } } : {};
if (stats.search) repository.id = "R_kgDOexample";
// --github-wait-review: the fixture's _rate is GitHub's rateLimit answer (a budget under Follow-up's reserve).
console.log(JSON.stringify({ data: { ...(d._rate ? { rateLimit: d._rate } : {}), repository, ...stats } }));
}
`;
}

/**
 * A fake `claude` for Rename title with AI's review shots (--rename-review): it answers only the rename prompt, as
 * `claude -p --output-format json` does, and the mode file picks the state: ready, slow (still suggesting) or fail.
 */
/**
 * A fake `claude` for the Ask shots only: Ask's plan call gets one read of the fictional tracker, its items call two
 * items from that read. Anything else fails at once, as an unlogged-in CLI does.
 */
/** Compass's extraction (fictional): the notes a fast model would make from dana's message, quoting it word for word. */
function fakeCompassClaude() {
  return `#!/usr/bin/env node
if (!process.argv.some(a => a.startsWith("You read messages for one developer"))) { process.stderr.write("not logged in"); process.exit(1); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  // A doc place (Compass PR 5): its new blocks come as [d1], [d2]…; the "!" line is the urgent one.
  const doc = /\\[(d\\d+)\\][^\\n]*\\n?[^\\[]*renewal deck/.exec(input);
  if (doc) {
    const value = { notes: [{ item: doc[1], what: "The acme renewal deck", keys: [], kind: "customer", strength: "high", untilWords: null, until: null, quote: "renewal deck for acme" }], retracts: [], nothing: false };
    process.stdout.write(JSON.stringify({ result: JSON.stringify(value), total_cost_usd: 0.0002, usage: { input_tokens: 400, output_tokens: 40 } }));
    return;
  }
  const item = (/\\[(m\\d+)\\] dana[^\\n]*\\n?[^\\[]*APP-142 retries/.exec(input) || /\\[(m\\d+)\\] dana/.exec(input) || [])[1] || "m2";
  const value = { notes: [
    { item, what: "APP-142 retries before the acme demo", keys: ["APP-142"], kind: "issue", strength: "high", untilWords: "Thursday", until: null, quote: "APP-142 retries are really important, the acme demo is Thursday" },
    { item, what: "Search filters", keys: [], kind: "feature", strength: "low", untilWords: "next week", until: null, quote: "Search filters can wait until next week" },
  ], retracts: [], nothing: false };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(value), total_cost_usd: 0.0003, usage: { input_tokens: 700, output_tokens: 90 } }));
});
`;
}

function fakeAskClaude() {
  return `#!/usr/bin/env node
const plan = process.argv.some(a => a.startsWith("You plan read-only lookups"));
const items = process.argv.some(a => a.startsWith("You turn read-only lookup results"));
const compass = process.argv.some(a => a.startsWith("You read messages for one developer"));
if (!plan && !items && !compass) { process.stderr.write("not logged in"); process.exit(1); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  const value = compass ? { notes: [], retracts: [], nothing: true } : plan ? { calls: [{ tool: "search_tickets", args: { query: "waiting on me", limit: "10" } }] }
    : { items: [
      { title: "T-7: review the retry limits for soft declines", why: "Waiting on your review, due tomorrow", url: "https://tracker.example/T-7", due: "2026-03-03" },
      { title: "T-12: bob asked about the refund export", why: "A question waiting on you since yesterday", url: "https://tracker.example/T-12", due: null },
    ] };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(value), total_cost_usd: 0.0004, usage: { input_tokens: 900, output_tokens: 80 } }));
});
`;
}

function fakeClaude(modeFile) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
// Anything but the rename job (its own system prompt) fails at once, as an unlogged-in CLI does, without reading stdin.
if (!process.argv.some(a => a.startsWith("You name software workspaces"))) { process.stderr.write("not logged in"); process.exit(1); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  const mode = (() => { try { return fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim(); } catch { return "ready"; } })();
  if (mode === "fail") { process.stdout.write(JSON.stringify({ is_error: true, subtype: "error_during_execution" })); process.exit(0); }
  const name = mode === "repair" ? '\"Add UNLINKED-99 backoff for soft card declines in billing after failures.\"' : mode === "unusable" ? "feat/retry-backoff" : "Add APP-142 backoff for soft card declines";
  const reply = () => process.stdout.write(JSON.stringify({ result: JSON.stringify({ name }), total_cost_usd: 0.0004, usage: { input_tokens: 420, output_tokens: 14 } }));
  if (mode === "slow") setTimeout(reply, 20000); else reply();
});
`;
}

/**
 * What the fake `mcpproxy` knows of Linear. Linked items only show a Linear key once Linear confirms it, and the worker
 * asks through `mcpproxy call tool-read` for the server whose tools look like Linear's; these answer it. Any other key is "not found",
 * so keys extracted from the other workspaces' goals are rejected and never render (whenever the linked loop runs).
 */
function linearIssues() {
  return {
    "APP-142": { title: "Retry failed charges with exponential backoff", status: "In Progress" },
    "APP-139": { title: "Customers charged twice after a gateway timeout", status: "Done" },
    "APP-151": { title: "Dunning email copy for failed renewals", status: "Todo" },
  };
}
/**
 * New's list (`--only new`): the developer's open issues, newest update first, as Linear's list_issues answers them
 * (issues[], hasNextPage, cursor). Fictional keys and titles; `minute` is after BASE.
 */
function newIssues() {
  const issue = (key, title, status, statusType, minute, description = "") => ({ id: key, title, url: "https://linear.app/example/issue/" + key, gitBranchName: `dana/${key.toLowerCase()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/-+$/, "")}`,
    status, statusType, team: key.startsWith("APP") ? "App" : key.startsWith("WEB") ? "Web" : "Ops", updatedAt: new Date(at(minute)).toISOString(), priority: { value: 2, name: "High" }, assignee: "Dana", description });
  return [
    issue("APP-151", "Dunning email copy for failed renewals", "Todo", "unstarted", 175, "The dunning email after the last retry still says \"your card was declined\". Rewrite it for failed renewals and link the billing page."),
    issue("APP-142", "Retry failed charges with exponential backoff", "In Progress", "started", 160, "Charges that fail with a network error are retried once. Retry up to 4 times with backoff."),
    issue("WEB-31", "Invoice PDF rounds VAT wrong for CHF totals", "In Progress", "started", 120, "CHF totals round VAT per line instead of per invoice."),
    issue("OPS-12", "Rotate the staging database password", "Todo", "unstarted", 90, "Rotate it and update the deploy secret."),
    issue("APP-163", "Rate-limit webhook retries per endpoint", "Todo", "unstarted", 30, "One slow endpoint holds every retry."),
    // Taken by a tracked PR's title, not a link (Webhook signing's #170 "APP-160: …"): New folds it with APP-142.
    issue("APP-160", "Sign webhook payloads", "In Review", "started", 60, "Sign every webhook payload with the endpoint's secret."),
  ];
}
/**
 * A fake `mcpproxy` with fictional servers (found by their tools, as on a real host): an issue tracker, a chat, a
 * calendar and a database with no recipe. Linear's get_issue and list_teams come from the fixture file;
 * `sources-fixture.json` beside it can change a server's state (a sign-in needed, turned off) for the Sources renders.
 */
function fakeMcpproxy(file, listFile) {
  return `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const issues = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
let list = []; try { list = JSON.parse(fs.readFileSync(${JSON.stringify(listFile)}, "utf8")); } catch {}
let mode = "ok"; try { mode = fs.readFileSync(${JSON.stringify(file + ".mode")}, "utf8").trim(); } catch {}
const flag = name => (process.argv.find(a => a.startsWith("--" + name + "=")) || "").slice(name.length + 3);
const qualified = flag("tool-name"); const tool = qualified.slice(qualified.indexOf(":") + 1); let args = {}; try { args = JSON.parse(flag("json_args") || "{}"); } catch {}
const reply = (text, isError = false) => { console.log(JSON.stringify({ content: [{ type: "text", text }], isError })); process.exit(0); };
let over = {}; try { over = JSON.parse(fs.readFileSync(path.join(path.dirname(${JSON.stringify(file)}), "sources-fixture.json"), "utf8")); } catch {}
const t = (server_name, name, props, description = "") => ({ server_name, name, description, annotations: { readOnlyHint: true }, schema: { type: "object", properties: Object.fromEntries(props.map(p => [p, { type: "string" }])) } });
if (process.argv[2] === "tools" && process.argv[3] === "list") {
  console.log(JSON.stringify([
    t("issues", "list_issues", ["assignee", "state", "orderBy", "limit", "fields", "cursor", "query"]), t("issues", "get_issue", ["id", "fields"]), t("issues", "get_user", ["query"]), t("issues", "list_teams", []),
    t("team-chat", "search_public_and_private", ["keywords", "filters", "natural_language_query", "sort", "sort_dir", "limit", "include_context", "response_format"], "Search messages. Current logged in user's user_id is UALICE0001."),
    t("team-chat", "search_users", ["keywords", "natural_language_query", "limit", "response_format"]), t("team-chat", "search_channels", ["keywords", "natural_language_query", "limit", "channel_types", "response_format"]),
    t("calendar", "list-events", ["timeMin", "timeMax", "timeZone"], "List the user's events."),
    t("warehouse", "run_query", ["sql"]), t("warehouse", "list_tables", []),
    // An Ask source (no recipe fits): a ticket tracker, shown only in the Ask shots (over.ask).
    ...(over.ask ? [t("tracker", "search_tickets", ["query", "limit"], "Search tickets."), t("tracker", "get_ticket", ["id"], "One ticket.")] : []),
    ...(over.mail ? [t("mailbox", "search_emails", ["query", "limit"], "Search the user's email inbox.")] : []),
    // Compass (--only compass): the chat's history read, by conversation id and oldest time.
    ...(over.compass ? [t("team-chat", "read_channel", ["channel_id", "oldest", "limit", "cursor", "response_format"], "Reads a conversation's messages, newest first.")] : []),
    // Compass's doc places (--only compass-readers): a docs server found by its read and search tools.
    ...(over.docs ? [t("notes", "notes-fetch", ["id"], "Fetch a page or doc by its id."), t("notes", "notes-search", ["query"], "Search pages and docs in the workspace.")] : []),
  ]));
  process.exit(0);
}
if (process.argv[2] === "upstream" && process.argv[3] === "list") {
  const up = name => ({ name, enabled: true, connected: true, authenticated: true, oauth: null, quarantined: false, tool_count: 4, health: { level: "healthy", summary: "Connected", action: null }, ...(over.upstreams || {})[name] });
  console.log(JSON.stringify(["issues", "team-chat", "calendar", "warehouse", "notes", ...(over.mail ? ["mailbox"] : []), ...(over.ask ? ["tracker"] : [])].map(up)));
  process.exit(0);
}
// The morning sweep, only for the Sources shots (over.linear): an empty queue, so the card reads Linear as fine. Other
// shots seed their queue and must not have it replaced by a sweep.
if (over.linear && tool === "list_issues") reply(JSON.stringify({ issues: [], hasNextPage: false }));
if (over.linear && tool === "get_user") reply(JSON.stringify({ id: "user-alice", name: "alice" }));
if (tool === "list_teams") reply(JSON.stringify({ teams: [{ key: "APP", name: "App" }, { key: "WEB", name: "Web" }] }));
// New's list (--only new): the fixture list, filtered by the search words; .mode makes Linear down or absent.
if (mode === "missing") { console.error("server linear not found"); process.exit(1); }
if (mode === "error") { console.error("Linear API timed out"); process.exit(1); }
if (tool === "list_issues") {
  const q = (args.query || "").toLowerCase();
  const found = q ? list.filter(i => (i.id + " " + i.title).toLowerCase().includes(q)) : list;
  reply(JSON.stringify({ issues: found, hasNextPage: false, cursor: null }));
}
if (tool === "get_issue") {
  const listed = list.find(i => i.id === args.id);
  if (listed) reply(JSON.stringify(listed));
  const i = issues[args.id];
  reply(i ? JSON.stringify({ id: args.id, identifier: args.id, title: i.title, status: i.status, url: "https://linear.app/example/issue/" + args.id }) : "Issue not found");
}
// Settings → Morning brief's chat search (fictional): the reply chat-fixture.json says, the pickers' fixed results.
if (/search_public_and_private$/.test(tool)) {
  let chat = {}; try { chat = JSON.parse(require("fs").readFileSync(require("path").join(require("path").dirname(${JSON.stringify(file)}), "chat-fixture.json"), "utf8")); } catch {}
  if (chat.error) { console.error("Command failed: chat search timed out"); process.exit(1); }
  reply(JSON.stringify({ results: chat.messages || "No results found.", pagination_info: "" }));
}
// Compass's history read (fictional): what dana (product) said in her DM with alice, the developer.
if (tool === "read_channel") {
  const ago = h => new Date(Date.now() - h * 3600_000);
  const m = (name, id, h, text) => "=== Message from " + name + " (" + id + ") at " + ago(h).toISOString().replace("T", " ").slice(0, 19) + " UTC === \\nMessage TS: " + (ago(h).getTime() / 1000).toFixed(6) + "\\n" + text;
  reply(JSON.stringify({ messages: "Channel: DM (DDANA00001)\\n\\n" + [
    m("alice", "UALICE0001", 1, "on it"),
    m("dana", "UDANA00001", 2, "APP-142 retries are really important, the acme demo is Thursday. Search filters can wait until next week."),
    m("dana", "UDANA00001", 26, "This week's plan: <https://claude.ai/artifact/0a1b2c3d-week-plan?share=K|roadmap>"),
  ].join("\\n\\n"), pagination_info: "" }));
}
// The Ask shots' tracker (fictional): two tickets waiting on the developer.
if (tool === "search_tickets") reply(JSON.stringify({ tickets: [
  { id: "T-7", title: "Review the retry limits for soft declines", status: "Waiting on alice", url: "https://tracker.example/T-7", due: "2026-03-03" },
  { id: "T-12", title: "Answer bob's question on the refund export", status: "Waiting on alice", url: "https://tracker.example/T-12" },
] }));
if (/search_users$/.test(tool)) reply(JSON.stringify({ results: "1. **alice** (UALICE0001)\\n2. **alicia** (UALICIA001)" }));
if (/search_channels$/.test(tool)) reply(JSON.stringify({ results: "- #planning (CPLAN00001)\\n- #plans-archive (CPLAN00002)\\n- #product-planning (CPLAN00003)" }));
// Compass's calendar place (over.calendar): the next days' meetings, one about tracked work, one that isn't.
if (/list-events$/.test(tool)) reply(JSON.stringify({ events: over.calendar ? [
  { summary: "acme demo: APP-142 retries", start: { dateTime: new Date(Date.now() + 2 * 86400_000).toISOString() }, attendees: [{ email: "dana@example.com" }, { email: "alice@example.com", self: true }, { email: "ops@acme.example" }] },
  { summary: "Team lunch", start: { dateTime: new Date(Date.now() + 86400_000).toISOString() }, attendees: [{ email: "dana@example.com" }, { email: "alice@example.com", self: true }] },
] : [] }));
if (tool === "notes-search") reply(JSON.stringify({ results: [{ id: "page-now", title: "Now", url: "https://notes.example/page-now" }, { id: "page-roadmap", title: "Q4 roadmap", url: "https://notes.example/page-roadmap" }] }));
if (tool === "notes-fetch") reply(JSON.stringify({ markdown: "# This week\\n\\n- ! renewal deck for acme\\n\\n# Later\\n\\nclean up the backlog" }));
reply("not available in the screenshot fixture", true);
`;
}

const msg = text => ({ item: { type: "assistant_message", text } });
const think = text => ({ item: { type: "reasoning", text } });
const bash = (command, output) => ({ item: { type: "tool_call", callId: `call-${command.length}-${output.length}`, name: "Bash", status: "completed", error: null, detail: { type: "shell", command, output } } });
const rpc = (name, input) => ({ rpc: name, input });

/**
 * The synthetic workspaces, oldest first. `minute` is when (after BASE) the workspace and its turn are created; the
 * browser shows BASE + VIEW. `prompt` is the developer's message; `steps` is the fixture agent's turn.
 */
const WORKSPACES = [
  { key: "theme", project: "web", after: "signoff", title: "Dark mode tokens", minute: 0, prompt: "WEB-9: move the dashboard to the new color tokens and ship it.",
    steps: [rpc("follow.enroll", { goal: "WEB-9 Dark mode color tokens" }), rpc("follow.register-pr", { repo: "example/web", number: 181, stack: "Dark mode tokens" }),
      bash("pnpm test --filter dashboard", "pass 128"), msg("Shipped in example/web#181. The dashboard uses the new tokens in both themes.")],
    done: "Dark mode tokens shipped in #181 and checked in both themes" },
  { key: "webhooks", project: "app", title: "Webhook signing", minute: 25, prompt: "APP-160: sign outgoing webhook payloads with HMAC and document the header.",
    steps: [rpc("follow.enroll", { goal: "APP-160 Sign webhook payloads" }), rpc("follow.register-pr", { repo: "example/app", number: 170, stack: "Webhook signing" }),
      bash("pnpm test webhooks", "pass 36"), msg("Opened example/app#170 and asked Ravi for review. The signature header is documented in docs/webhooks.md."),
      rpc("follow.needs-you", { kind: "review", ask: "Read the signature header docs in #170 before it merges" })] },
  { key: "email", project: "app", title: "Onboarding email", minute: 50, prompt: "APP-155: add the welcome email template and send it after sign-up.",
    steps: [rpc("follow.enroll", { goal: "APP-155 Welcome email after sign-up" }), rpc("follow.register-pr", { repo: "example/app", number: 160, stack: "Onboarding email" }),
      msg("Opened example/app#160 with the welcome template.")] },
  { key: "search", project: "web", title: "Search filters", minute: 80, prompt: "WEB-17: saved search filters. Run the staging migration when the PR is green.",
    steps: [rpc("follow.enroll", { goal: "WEB-17 Saved search filters" }), rpc("follow.register-pr", { repo: "example/web", number: 151, stack: "Search filters" }),
      bash("pnpm test search", "pass 54"), msg("The filters save and load, and tests pass. The new column needs migration 0042 on staging first."),
      { permission: { name: "Bash", title: "Run the staging migration", input: { command: "pnpm db:migrate --env staging --to 0042" } } }],
    waitFor: "permission" },
  { key: "audit", project: "web", title: "Audit log export", minute: 120, prompt: "WEB-21: export the audit log as CSV, streamed, with a date range.",
    steps: [rpc("follow.enroll", { goal: "WEB-21 Audit log CSV export" }), think("Stream rows so large ranges don't buffer in memory."), bash("pnpm test audit", "pass 12"), { hold: true }],
    waitFor: "running" },
  { key: "billing", project: "app", title: "Billing retries", minute: 140, prompt: "APP-142: retry failed charges with exponential backoff, then send the dunning email after the last retry.",
    steps: [
      rpc("follow.enroll", { goal: "APP-142 Retry failed charges with backoff and send the dunning email" }),
      rpc("follow.register-pr", { repo: "example/app", number: 141, stack: "Billing retries" }),
      rpc("follow.register-pr", { repo: "example/app", number: 142, stack: "Billing retries" }),
      rpc("follow.register-pr", { repo: "example/app", number: 143, stack: "Billing retries", parentNumber: 142 }),
      rpc("follow.obligation", { title: "Check retries in staging after the deploy", status: "waiting", afterPrs: ["example/app#143"] }),
      rpc("follow.obligation", { title: "Watch the dunning email rate for a day after the deploy", status: "waiting", afterPrs: ["example/app#143"] }),
      // Linked items: a spec and what the agent linked, each with why (Linear keys are confirmed by the fake mcpproxy).
      rpc("follow.set-spec", { url: "https://example.com/docs/billing/retry-spec", title: "Charge retry spec" }),
      rpc("follow.link-item", { ref: "APP-142", why: "The issue this workspace delivers" }),
      rpc("follow.link-item", { ref: "APP-139", why: "Retries must not double-charge; this was the last time they did" }),
      rpc("follow.link-item", { ref: "https://example.slack.com/archives/C0BILLING1/p1772614800000100", title: "#billing: which declines are soft?", why: "Where support asked for declined-card retries" }),
      rpc("follow.link-item", { ref: "https://example.com/docs/billing/retries", title: "Retry notes", why: "The backoff schedule and its limits" }),
      bash("pnpm test billing", "pass 87"),
      rpc("follow.ask-question", { title: "fail with card_declined retry", question: "Should charges that fail with card_declined retry, or only network failures?",
        options: [{ letter: "A", label: "Only network failures", consequence: "Today's behavior. Declined cards go straight to the dunning email." },
          { letter: "B", label: "Retry card_declined once after 24 hours", consequence: "Recovers some soft declines for one extra charge attempt per invoice." },
          { letter: "C", label: "Retry every failure with the same backoff", consequence: "Highest recovery, but card networks can flag repeated declines." }],
        recommend: "A", background: "card_declined is about 30% of failed charges. Soft declines often clear within a day; hard declines don't.",
        links: [{ path: "docs/billing/retries.md", label: "Retry notes" }], pr: "example/app#142" }),
      msg("The backoff is in example/app#142 and the dunning email in #143. Q1 asks whether declined cards should retry."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick whether declined cards retry", questions: ["Q1"] }),
      { gate: "billing" },
    ], worked: 4 },
  // The README lead shot's other groups: Waiting (signed off, PRs out), Later (snoozed), Fixing (a repair batch sent and
  // the agent on it). `after` runs once every PR snapshot is in.
  { key: "usage", project: "web", after: "signoff", title: "Usage dashboard", minute: 8, prompt: "WEB-30: charts for the usage dashboard. Keep the PR a draft until the design review.",
    steps: [rpc("follow.enroll", { goal: "WEB-30 Usage dashboard charts" }), rpc("follow.register-pr", { repo: "example/web", number: 212, stack: "Usage dashboard" }),
      msg("Opened example/web#212 as a draft until the design review.")] },
  { key: "invites", project: "app", after: "signoff", title: "Team invites", minute: 15, prompt: "APP-171: invite links for teams, valid for 7 days.",
    steps: [rpc("follow.enroll", { goal: "APP-171 Team invite links" }), rpc("follow.register-pr", { repo: "example/app", number: 191, stack: "Team invites" }),
      bash("pnpm test invites", "pass 41"), msg("Opened example/app#191. CI is running.")] },
  { key: "sso", project: "app", after: "signoff", title: "SSO login", minute: 35, prompt: "APP-176: SAML single sign-on. The provider first, then the login button.",
    steps: [rpc("follow.enroll", { goal: "APP-176 SAML single sign-on" }), rpc("follow.register-pr", { repo: "example/app", number: 195, stack: "SSO login" }),
      rpc("follow.register-pr", { repo: "example/app", number: 196, stack: "SSO login", parentNumber: 195 }),
      rpc("follow.obligation", { title: "Try the login on staging after the deploy", status: "waiting", afterPrs: ["example/app#196"] }),
      // A declared wait absorbs a finish that states no ask (in-flight-reads-waiting), so the row never flags: wait for
      // the turn only. Waiting on the flag raced the wait's refresh and timed out once it lost.
      msg("Opened example/app#195 and #196 for review.")], flag: false },
  { key: "push", project: "web", after: "snooze", title: "Push settings", minute: 60, prompt: "WEB-34: let people pick which push notifications they get.",
    steps: [rpc("follow.enroll", { goal: "WEB-34 Push notification settings" }), rpc("follow.register-pr", { repo: "example/web", number: 218, stack: "Push settings" }),
      rpc("follow.ask-question", { title: "Default for new accounts?", question: "Should new accounts start with every push notification on, or only mentions?",
        options: [{ letter: "A", label: "Only mentions", consequence: "Quiet by default; people opt in to the rest." }, { letter: "B", label: "Everything on", consequence: "Nothing missed, but more people turn push off entirely." }],
        recommend: "A", pr: "example/web#218" }),
      msg("example/web#218 is up. Q1 asks the default for new accounts."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick the default for new accounts", questions: ["Q1"] })] },
  { key: "csv", project: "web", title: "Contact import", minute: 95, prompt: "WEB-38: import contacts from a CSV, with a preview before saving.",
    steps: [rpc("follow.enroll", { goal: "WEB-38 Import contacts from CSV" }), rpc("follow.register-pr", { repo: "example/web", number: 224, stack: "Contact import" }),
      rpc("follow.ask-question", { title: "When a CSV row matches an existing contact", question: "When a CSV row matches an existing contact by email, should it update that contact or be skipped?",
        options: [{ letter: "A", label: "Update the existing contact", consequence: "The CSV wins; old values are overwritten." }, { letter: "B", label: "Skip the row", consequence: "Existing contacts never change; the preview lists what was skipped." }],
        recommend: "B", pr: "example/web#224" }),
      msg("The preview works in example/web#224. Q1 asks what to do with duplicates.")] },
  { key: "invoices", project: "app", after: "fix", title: "Invoice PDFs", minute: 105, prompt: "APP-182: render invoices as PDF and attach them to the receipt email.",
    steps: [rpc("follow.enroll", { goal: "APP-182 Invoice PDFs on the receipt email" }), rpc("follow.register-pr", { repo: "example/app", number: 188, stack: "Invoice PDFs" }),
      // The deploy frame's task: Invoice PDFs shows a repair going back to its agent and a task that waits on the deploy.
      rpc("follow.obligation", { title: "Send a test receipt from staging after the deploy", status: "waiting", afterPrs: ["example/app#188"] }),
      msg("Opened example/app#188.")] },
  { key: "views", project: "web", after: "fix", title: "Saved views", minute: 112, prompt: "WEB-41: save dashboard layouts as named views.",
    steps: [rpc("follow.enroll", { goal: "WEB-41 Saved dashboard views" }), rpc("follow.register-pr", { repo: "example/web", number: 205, stack: "Saved views" }),
      msg("Opened example/web#205.")] },
].sort((a, b) => a.minute - b.minute);

/**
 * sending only (Q51): an agent still mid-turn whose PR has a conflict and a thread, so its tasks wait in Sending for
 * the turn to end; Send now queues them for its end (Q96 = A). Saved views and Invoice PDFs are out with their agents; Onboarding email's tasks
 * wait on the developer (Needs you).
 */
const SENDING_STATES = [
  { key: "sd-busy", title: "Checkout copy", minute: 146, prompt: "APP-188: tighten the checkout button copy and keep the old string for the A/B test.", flag: false, waitFor: "running",
    steps: [rpc("follow.enroll", { goal: "APP-188 Checkout button copy" }), rpc("follow.register-pr", { repo: "example/app", number: 247, stack: "Checkout copy" }),
      think("Keep the old string behind the experiment flag."), bash("pnpm test checkout", "pass 18"), { hold: true }] },
  // Q96 = A: the main agent waits on a permission prompt, so its repair says so and offers Send now.
  { key: "sd-perm", title: "Refund reasons", minute: 148, prompt: "APP-190: add reason codes to refunds and backfill the old ones.", flag: false, waitFor: "permission",
    steps: [rpc("follow.enroll", { goal: "APP-190 Refund reason codes" }), rpc("follow.register-pr", { repo: "example/app", number: 248, stack: "Refund reasons" }),
      msg("Opened example/app#248. The backfill needs a one-off script on staging."),
      { permission: { name: "Bash", title: "Run the refund backfill on staging", input: { command: "pnpm refunds:backfill --env staging" } } }] },
  // Invariant 133: with Repairs at once at 1, Tax rates' agent works on the repair Auto-send sent (its turn held open),
  // so Coupon codes' repair waits for that turn.
  { key: "sd-hold", title: "Tax rates", minute: 149, prompt: "APP-192: read tax rates from the new rates table.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-192 Tax rates table" }), rpc("follow.register-pr", { repo: "example/app", number: 244, stack: "Tax rates" }), msg("Opened example/app#244.")] },
  { key: "sd-limit", title: "Coupon codes", minute: 152, prompt: "APP-194: let customers apply one coupon code at checkout.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-194 Coupon codes" }), rpc("follow.register-pr", { repo: "example/app", number: 245, stack: "Coupon codes" }), msg("Opened example/app#245.")] },
];

/**
 * batch-churn only (a-changed-review-updates-never-cancels): one workspace whose review keeps moving. batchChurnShots
 * drives it through the churn, the agent's "already on it" and the healed records an older release left.
 */
const BATCH_CHURN_STATES = [
  { key: "bc-review", title: "Webhook signatures", minute: 160, prompt: "APP-205: sign outgoing webhook payloads and document how receivers check them.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-205 Signed webhooks" }), rpc("follow.register-pr", { repo: "example/app", number: 270, stack: "Webhook signatures" }),
      rpc("follow.register-pr", { repo: "example/app", number: 271, stack: "Webhook docs" }), msg("Opened example/app#270 and #271. Sam is reviewing #270.")] },
];

/**
 * needs-you-states only (an-open-question-renders-once-per-surface, task asks): one workspace per Needs you state.
 * Billing retries above is the brief pointing at its own question.
 */
const ask = (title, question, options, recommend = "A") => rpc("follow.ask-question", { title, question, options: options.map((label, i) => ({ letter: "ABC"[i], label })), recommend });
const NEEDS_YOU_STATES = [
  { key: "ny-other", title: "Invoice exports", minute: 150, prompt: "APP-171: export invoices as a spreadsheet from the billing page.",
    steps: [rpc("follow.enroll", { goal: "APP-171 Invoice exports" }),
      ask("Export format", "Which format should the invoice export use?", ["CSV", "XLSX"]),
      msg("The export runs. Q1 asks which format; the bucket for large exports needs your approval."),
      rpc("follow.needs-you", { kind: "action", ask: "Approve the staging export bucket", context: "Large exports stream to a private bucket. It needs an owner's approval in the cloud console before the first run." })] },
  { key: "ny-two", title: "Rate limits", minute: 156, prompt: "APP-176: rate-limit the public API per API key.",
    steps: [rpc("follow.enroll", { goal: "APP-176 Rate-limit the public API" }),
      ask("Limit scope", "Should the limit apply per tenant or per API key?", ["Per tenant", "Per API key"]),
      ask("Over-limit response", "What should a request over the limit get?", ["429 with Retry-After", "Queue it for up to 5 seconds"]),
      msg("The limiter is in place behind a flag. Two choices decide how it behaves."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick how the rate limit applies", questions: ["Q1", "Q2"], context: "Both choices change what customers see when they hit the limit, so they go out together." })] },
  { key: "ny-lone", title: "Locale fallback", minute: 162, prompt: "WEB-30: fall back to the base language when a regional translation is missing.", flag: false,
    steps: [rpc("follow.enroll", { goal: "WEB-30 Locale fallback" }),
      ask("Missing keys", "When a key is missing in both the regional and the base language, what should show?", ["The English text", "The key itself"]),
      msg("The fallback chain is wired; Q1 is open.")] },
  { key: "ny-answered", title: "Receipt emails", minute: 168, prompt: "APP-180: send a receipt email after each successful charge.",
    steps: [rpc("follow.enroll", { goal: "APP-180 Receipt emails" }),
      ask("Receipt sender", "Which address should receipts come from?", ["billing@", "no-reply@"]),
      msg("The receipt template is ready. Q1 asks which sender."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick the receipt sender", questions: ["Q1"] })], answer: { questionId: "Q1", choice: "A" } },
  { key: "ny-tasks", title: "Usage alerts", minute: 174, prompt: "APP-185: email workspace admins when usage passes 80% of the plan.",
    steps: [rpc("follow.enroll", { goal: "APP-185 Usage alerts" }),
      rpc("follow.register-pr", { repo: "example/app", number: 232, stack: "Usage alerts" }),
      rpc("follow.obligation", { title: "Pick who gets usage alerts", status: "blocked", ask: "Should usage alerts go to the workspace owner only, or to every admin?", enable_follow_up: false }),
      rpc("follow.obligation", { title: "Wire alert thresholds", status: "blocked", evidence: "Waits for #232's review before the thresholds move to config", enable_follow_up: false }),
      rpc("follow.obligation", { title: "Check alert emails in staging", status: "waiting", afterPrs: ["example/app#232"] }),
      // due-by-fact: a task with no PRs says its re-check date (3 days out by default), and one past it reads Due.
      rpc("follow.obligation", { title: "Watch the next nightly usage roll-up", status: "pending" }),
      rpc("follow.obligation", { title: "Confirm the usage export with billing", status: "waiting", recheck: "2026-01-01", evidence: "Ask billing whether the CSV matches their ledger, then close this with their reply." }),
      // tasks-are-the-agent-s: one due task with the agent's note, and finished ones (they live in Activity).
      rpc("follow.obligation", { title: "Backfill alert history for existing plans", status: "pending", recheck: "2026-02-28", evidence: "Run the backfill once billing confirms the plan list; it takes about ten minutes." }),
      rpc("follow.obligation", { title: "Add the usage alert email template", status: "done", evidence: "The template is live in staging." }),
      rpc("follow.obligation", { title: "Drop the old usage banner", status: "waived", evidence: "Superseded by the alert emails." }),
      msg("Thresholds are in #232. One task needs your call on who gets the alerts.")], flag: false },
  // one-ask-one-item: a task blocked on something the developer does and reports back, and the turn's Action brief
  // about it: one Done card, carrying the brief's context, never a brief beside a "write the decision" card.
  { key: "ny-action", title: "Export layouts", minute: 186, prompt: "WEB-44: ship the export layout the design lead picks.",
    steps: [rpc("follow.enroll", { goal: "WEB-44 Export layouts" }),
      rpc("follow.obligation", { title: "Get alice's pick of the export layout", status: "blocked", ask: "Share the layout preview with alice and tell me when they've picked; I read the choice from the page.", enable_follow_up: false }),
      msg("Both layouts are on the preview page; the export ships whichever alice picks."),
      rpc("follow.needs-you", { kind: "action", ask: "Still needed: alice's pick on the layout preview", context: "Both layouts are built. Share the preview with alice; once they pick, the export ships that layout." })] },
  { key: "ny-person", title: "Webhook retries", minute: 180, prompt: "APP-195: retry failed invoice webhooks with backoff.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-195 Retry failed invoice webhooks" }),
      rpc("follow.register-pr", { repo: "example/app", number: 262, stack: "Webhook retries" }),
      msg("Retries with backoff are in #262.")] },
];

/**
 * scheduled-tasks only (a-scheduled-task-arrives-once-at-its-time): a workspace waiting on things Follow-up can't see,
 * each task with its own check-back time: one still to send, one sent and one that couldn't go (the start-up edit in
 * scheduledShots marks those two, as the worker would have).
 */
const SCHEDULED_STATES = [
  { key: "sc-registry", title: "Registry publish", minute: 178, prompt: "PKG-31: publish 1.4.0 and confirm the CDN serves it.", flag: false,
    steps: [rpc("follow.enroll", { goal: "PKG-31 Publish 1.4.0" }),
      rpc("follow.obligation", { title: "Recheck the CDN serves 1.4.0", status: "waiting", evidence: "Published 1.4.0 to the registry; the CDN usually lags 30-60 minutes.", trigger: { event: "at", inMinutes: 45 } }),
      rpc("follow.obligation", { title: "Tell the docs team 1.4.0 is out", status: "pending", trigger: { event: "at", inMinutes: 120 } }),
      rpc("follow.obligation", { title: "Rerun the smoke test on the mirror", status: "waiting", trigger: { event: "at", inMinutes: 240 } }),
      msg("1.4.0 is on the registry. I'll check the CDN at the scheduled time.")] },
];

/**
 * now-line only (the-line-takes-its-first-source): two running agents that stated what they're working on through
 * sync_workspace's milestone, one with its steps before and after ("2 of 4") and one without. The default set already
 * has the other two states: Invoice PDFs works on the repair Follow-up sent (after: "fix"), and Audit log export runs
 * without having stated anything.
 */
const NOW_LINE_STATES = [
  { key: "nl-steps", project: "app", title: "Charge retries", minute: 150, prompt: "APP-171: cap the gap between charge retries so a flaky gateway can't double-charge.", waitFor: "running",
    steps: [rpc("follow.enroll", { goal: "APP-171 Cap the retry gap" }),
      rpc("follow.sync", { summary: "Goal set; starting on the cap.", milestone: { now: "Capping the retry gap", done: ["Reading the gateway logs"], next: ["Shipping the fix", "Verifying in staging"] } }),
      think("Cap the gap at 45 s and test the boundary."), bash("pnpm test retry-policy", "pass 22"), { hold: true }] },
  { key: "nl-plain", project: "web", title: "Release train", minute: 155, prompt: "WEB-50: tag the beta and publish it.", waitFor: "running",
    steps: [rpc("follow.enroll", { goal: "WEB-50 Publish the beta" }), rpc("follow.sync", { summary: "Tagging the beta.", milestone: { now: "Releasing the beta" } }),
      bash("pnpm release --tag beta", "tagged v3.2.0-beta.1"), { hold: true }] },
];

/**
 * peek only (a-peek-is-bounded-and-never-wakes): agents whose turn the peek shows. A live run with a running step, a
 * waiting permission, and a finished turn with a failed step. Fictional repositories only.
 */
const tool = (name, detail, status = "completed") => ({ item: { type: "tool_call", callId: `call-${name}-${JSON.stringify(detail).length}-${status}`, name, status, error: status === "failed" ? { message: "exit 1" } : null, detail } });
const PEEK_STATES = [
  { key: "pk-live", project: "app", title: "Retry cap", minute: 160, prompt: "APP-212: cap the gap between charge retries in example/app.", waitFor: "running",
    steps: [rpc("follow.enroll", { goal: "APP-212 Cap the retry gap" }), rpc("follow.sync", { summary: "Capping the gap.", milestone: { now: "Capping the retry gap", next: ["Verifying in staging"] } }),
      think("The gap comes from the gateway's backoff; cap it at 45 s."), tool("Read", { type: "read", filePath: "src/billing/retry-policy.ts" }), tool("Grep", { type: "search", query: "maxBackoff" }),
      tool("Edit", { type: "edit", filePath: "src/billing/retry-policy.ts" }), bash("pnpm test retry-policy", "pass 22"), msg("The cap holds in unit tests. Running the gateway suite next."),
      tool("Bash", { type: "shell", command: "pnpm test gateway --runInBand --reporter=dot" }, "running"), { hold: true }] },
  { key: "pk-perm", project: "web", title: "Widget build", minute: 161, prompt: "WEB-61: rebuild the widgets bundle for acme/widgets.", waitFor: "permission",
    steps: [rpc("follow.enroll", { goal: "WEB-61 Rebuild the widgets bundle" }), rpc("follow.sync", { summary: "Rebuilding.", milestone: { now: "Rebuilding the bundle" } }),
      tool("Read", { type: "read", filePath: "packages/widgets/package.json" }), { permission: { kind: "tool", name: "Bash", title: "Run a command", input: { command: "rm -rf packages/widgets/dist && pnpm --filter @acme/widgets build" } } }] },
  { key: "pk-done", project: "app", title: "Flaky test", minute: 162, prompt: "APP-215: fix the flaky invoice test in example/app.",
    steps: [rpc("follow.enroll", { goal: "APP-215 Fix the flaky invoice test" }), rpc("follow.sync", { summary: "Fixed.", milestone: { now: "Fixing the flaky test" } }),
      tool("Bash", { type: "shell", command: "pnpm test invoices" }, "failed"), think("The test races the timer."), tool("Edit", { type: "edit", filePath: "src/invoices/invoice.test.ts" }),
      bash("pnpm test invoices", "pass 31"), msg("Fixed: the test now waits for the timer instead of racing it. 31 tests pass.")] },
];

/** PR fallback review: own and other repositories, in review and checking (invariant 128). */
const PR_NOW_STATES = [8801, 8802, 8803, 8804].map((number, i) => ({
  key: `pr-now-${number}`, project: "app", title: ["Review retry cap", "Check retry cap", "Review widget retry", "Check widget retry"][i],
  minute: 150 + i, prompt: `Follow the retry change ${number}.`, flag: false, waitFor: "running",
  steps: [rpc("follow.enroll", { goal: "Ship the retry cap" }),
    rpc("follow.register-pr", { repo: number > 8802 ? "acme/widgets" : "example/app", number, stack: "Retry cap" }), think("Following the open PR while its checks and review proceed."), bash("git status --short", "clean"), { hold: true }],
}));

/**
 * question-links only (one-answer-flow-for-every-question, checks-say-what-they-are-doing): a needs_you that points at
 * three questions with the agent's note and links (the timeline card shows them as the panel does), one whose card a
 * newer card replaced ("Show original"), and an upstream fork PR whose required checks never started.
 */
const QL_PAGE = { label: "Sidebar design page", url: "https://claude.ai/artifact/acme-sidebar-design" };
const qlAsk = (title, question, background, links, options) => rpc("follow.ask-question", { title, question, background, links, options: options.map((label, i) => ({ letter: "ABC"[i], label })), recommend: "A" });
const QL_STATES = [
  { key: "ql-sidebar", title: "Sidebar redesign", minute: 190, prompt: "WEB-61: redesign the workspace sidebar.",
    steps: [rpc("follow.enroll", { goal: "WEB-61 Sidebar redesign" }),
      qlAsk("Sidebar density", "Which density should the sidebar ship with? Both are on the design page (page below).", "My review adds: the compact rows fit 14 workspaces on a laptop; the roomy ones fit 9.", [QL_PAGE], ["Compact", "Roomy"]),
      qlAsk("Badge placement", "Where should the Needs you badge sit on a row?", "My review adds: the right edge lines up with the time column.", [QL_PAGE, { label: "Badge spec", url: "https://example.com/acme/badge-spec" }], ["Right edge", "Before the title"]),
      qlAsk("Archived rows", "Should archived workspaces stay in the sidebar, folded at the bottom?", "My review adds: folding keeps search working on them.", [QL_PAGE], ["Fold them", "Hide them"]),
      msg("The sidebar redesign is drafted. Three calls decide how it ships."),
      rpc("follow.needs-you", { kind: "decision", ask: "Three calls on the sidebar redesign", questions: ["Q1", "Q2", "Q3"] })] },
  { key: "ql-replaced", title: "Sidebar copy", minute: 192, prompt: "WEB-62: rewrite the sidebar's empty states.",
    steps: [rpc("follow.enroll", { goal: "WEB-62 Sidebar copy" }),
      qlAsk("Empty state tone", "Which tone should the empty sidebar use? The drafts are on the design page (page below).", "My review adds: the plain draft tested better with new users.", [QL_PAGE], ["Plain", "Playful"]),
      msg("Two drafts of the empty state are up."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick the empty state's tone", questions: ["Q1"] })] },
  { key: "ql-fork", title: "Forked build retries", minute: 194, flag: false, prompt: "Upstream the retry cap for forked builds.",
    steps: [rpc("follow.enroll", { goal: "Upstream the retry cap" }),
      rpc("follow.register-pr", { repo: "example/app", number: 8811, stack: "Retry cap" }),
      msg("Opened #8811 upstream from the fork.")] },
];

/** pick-notes only (task 32deeb27): decision cards with no tracked question, one decision and two. */
const PICK_NOTES = [
  { key: "pn-one", title: "Export encoding", minute: 176, prompt: "APP-190: export invoices as a spreadsheet finance can open.",
    steps: [rpc("follow.enroll", { goal: "APP-190 Spreadsheet invoice export" }),
      msg("The export writes a spreadsheet. One call on the encoding."),
      rpc("follow.needs-you", { kind: "decision", ask: "Which encoding should the export use?", decisions: [{ question: "Which encoding should the export use?", recommend: 0,
        options: [{ label: "UTF-8", consequence: "Every spreadsheet app opens it; Excel needs the BOM to guess right." }, { label: "Latin-1", consequence: "Matches the legacy importer, loses non-Latin names." }] }] })] },
  { key: "pn-two", title: "Export delivery", minute: 178, prompt: "APP-191: deliver large invoice exports without blocking the page.",
    steps: [rpc("follow.enroll", { goal: "APP-191 Large invoice exports" }),
      msg("Large exports run in the background now. Two calls decide the format and where it lands."),
      rpc("follow.needs-you", { kind: "decision", ask: "Two calls on the invoice export", decisions: [
        { question: "Which encoding should the export use?", recommend: 0, options: [{ label: "UTF-8", consequence: "Every spreadsheet app opens it." }, { label: "Latin-1", consequence: "Matches the legacy importer." }] },
        { question: "Where should the export land?", recommend: 0, options: [{ label: "The reports bucket" }, { label: "A download link in the email" }] }] })] },
];

/** pr-scale's workspace: the agent registers all of them, each stack chained through parentNumber. */
const PR_SCALE_STATES = [
  { key: "ps-ledger", title: "Ledger rewrite", minute: 182, flag: false, prompt: "APP-300: rewrite the ledger as a stack of small PRs, one table at a time.",
    steps: [rpc("follow.enroll", { goal: "APP-300 Ledger rewrite" }),
      ...Array.from({ length: PR_SCALE.size }, (_, i) => rpc("follow.register-pr", { repo: "example/app", number: PR_SCALE.bottom + i, stack: "Ledger rewrite", ...(i ? { parentNumber: PR_SCALE.bottom + i - 1 } : {}) })),
      ...PR_SCALE_WEB.flatMap(({ stack, numbers }) => numbers.map((n, i) => rpc("follow.register-pr", { repo: "example/web", number: n, stack, ...(i ? { parentNumber: numbers[i - 1] } : {}) }))),
      msg(`Opened example/app#${PR_SCALE.bottom} through #${PR_SCALE_TOP} as one stack, and three small stacks in example/web.`)] },
];

/**
 * paged-lists only (every list pages, pr-scale-lists-batch-not-throw): a busy workspace's history. The agent asks
 * PAGED_QUESTIONS questions and answers each in chat (two timeline rows each), finishes PAGED_TASKS_DONE tasks and
 * keeps PAGED_TASKS_OPEN open, so Activity, its Questions tab and the Tasks card each run to several pages.
 */
const PAGED_QUESTIONS = 140, PAGED_TASKS_DONE = 60, PAGED_TASKS_OPEN = 40;
const PAGED_TOPICS = ["invoice retries", "webhook signatures", "export formats", "ledger rounding", "refund windows", "tax rounding", "receipt layout", "dunning emails", "currency display", "card updates", "proration", "trial ends", "seat limits", "usage alerts"];
const PAGED_STATES = [
  { key: "pl-billing", title: "Billing platform", minute: 183, flag: false, prompt: "APP-400: keep the billing platform moving; ask me whenever a call is mine.",
    steps: [rpc("follow.enroll", { goal: "APP-400 Billing platform" }),
      ...Array.from({ length: PAGED_QUESTIONS }, (_, i) => [
        rpc("follow.ask-question", { title: `${PAGED_TOPICS[i % PAGED_TOPICS.length]}: call ${i + 1}`, question: `For ${PAGED_TOPICS[i % PAGED_TOPICS.length]} (case ${i + 1}), should the job retry once or fail fast?`, options: [{ letter: "A", label: "Retry once" }, { letter: "B", label: "Fail fast" }], recommend: "A" }),
        rpc("follow.record-answer", { id: `Q${i + 1}`, choice: i % 3 ? "A" : "B" }),
      ]).flat(),
      ...Array.from({ length: PAGED_TASKS_DONE }, (_, i) => rpc("follow.obligation", { title: `Check ${PAGED_TOPICS[i % PAGED_TOPICS.length]} on staging, run ${i + 1}`, status: "done", evidence: "Ran it on staging; the numbers match.", new: true })),
      ...Array.from({ length: PAGED_TASKS_OPEN }, (_, i) => rpc("follow.obligation", { title: `Backfill ${PAGED_TOPICS[i % PAGED_TOPICS.length]} for account group ${i + 1}`, status: "pending", new: true })),
      msg(`Answered ${PAGED_QUESTIONS} calls in chat and finished ${PAGED_TASKS_DONE} checks; ${PAGED_TASKS_OPEN} backfills are next.`)] },
];

/** review-mode only (a-no-review-repo-never-asks-for-review-or-merge): a PR with no reviewers in a reviewed repository. */
const REVIEW_MODE_STATES = [
  { key: "rm-audit", title: "Audit log export", minute: 180, prompt: "APP-190: export the audit log as CSV from the admin page.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-190 Audit log export" }), rpc("follow.register-pr", { repo: "example/app", number: 246, stack: "Audit export" }),
      msg("Opened example/app#246; checks are running.")] },
];

/** reviewers-click only (a-click-on-add-reviewers-asks): four workspaces of five PRs without reviewers, one per theme and size. */
const REVIEWERS_CLICK_STATES = [
  ["rc-panel-light", "Invoice exports", 280], ["rc-panel-dark", "Webhook retries", 285], ["rc-phone-light", "Admin search", 290], ["rc-phone-dark", "Usage alerts", 295],
].map(([key, title, first], i) => {
  const prs = ["Add the model", "Wire the API route", "Add the admin view", "Write the docs page", "Add the e2e test"].map((t, j) => [first + j, `${title}: ${t.toLowerCase()}`]);
  return { key, title, minute: 170 + i, prompt: `APP-${210 + i}: ${title.toLowerCase()}, split into five small PRs.`, flag: false, prs,
    steps: [rpc("follow.enroll", { goal: `APP-${210 + i} ${title}` }), ...prs.map(([n]) => rpc("follow.register-pr", { repo: "example/app", number: n, stack: `${title} ${n}` })),
      msg(`Opened example/app#${first} through #${first + 4}; each is ready for review.`)] };
});

/** merge-click only (a-click-on-merge-merges): a three-PR stack, all approved, so its top PR's Merge names all three. */
const MERGE_CLICK_STATES = [
  { key: "mc-stack", title: "Export filters", minute: 178, prompt: "APP-198: filter invoice exports by date range in the admin page.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-198 Export filters" }), rpc("follow.register-pr", { repo: "example/app", number: 250, stack: "Export filters" }),
      rpc("follow.register-pr", { repo: "example/app", number: 251, stack: "Export filters", parentNumber: 250 }),
      rpc("follow.register-pr", { repo: "example/app", number: 252, stack: "Export filters", parentNumber: 251 }),
      msg("Opened example/app#250, #251 and #252; all three are approved.")] },
  // The light panel's click: one approved PR, so its done shot shows the header, row and Activity agreeing.
  { key: "mc-receipts", title: "Receipt PDFs", minute: 179, prompt: "APP-201: attach a PDF receipt to every paid invoice email.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-201 Receipt PDFs" }), rpc("follow.register-pr", { repo: "example/app", number: 255, stack: "Receipt PDFs" }),
      msg("Opened example/app#255; it's approved and green.")] },
  // The dark phone's click: Home's detail pane drops the ask with the toast.
  { key: "mc-digest", title: "Invoice digest", minute: 180, prompt: "APP-202: send a weekly digest of paid invoices.", flag: false,
    steps: [rpc("follow.enroll", { goal: "APP-202 Invoice digest" }), rpc("follow.register-pr", { repo: "example/app", number: 256, stack: "Invoice digest" }),
      msg("Opened example/app#256; it's approved and green.")] },
];

/** done-brief only (a-done-brief-is-never-an-ask): the agent's turn ends "nothing needed" while its PR's merge flags the row. */
const DONE_BRIEF = [
  { key: "db-merged", title: "Export streaming", minute: 177, prompt: "APP-195: stream large invoice exports instead of building them in memory.",
    steps: [rpc("follow.enroll", { goal: "APP-195 Stream large invoice exports" }), rpc("follow.register-pr", { repo: "example/app", number: 240, stack: "Export streaming" }),
      msg("#240 is merged: large exports stream now."),
      rpc("follow.needs-you", { kind: "done", ask: "Nothing needed: #240 is merged and exports stream." })] },
];

async function seed({ call, home }) {
  // A fixed (empty) project folder: Paseo derives the project's avatar color from it, so a random temp path would
  // recolor the sidebar on every run.
  // Two projects, so the sidebar and Quiet's folds don't read as one repo.
  const repos = {};
  // New (`--only new`) starts worktrees, so its projects are Git repositories on main, in folders of their own.
  for (const name of ["app", "web"]) {
    repos[name] = join(tmpdir(), only.includes("pr-now") ? "follow-up-shots-fixture-pr-now" : only.includes("new") ? "follow-up-shots-fixture-new" : "follow-up-shots-fixture", name); await fs.mkdir(repos[name], { recursive: true });
    if ((only.includes("new") || only.includes("pr-now")) && !existsSync(join(repos[name], ".git"))) {
      const git = (...a) => exec("git", ["-C", repos[name], ...a], { timeout: 30000 });
      await git("init", "-q", "-b", "main");
      if (only.includes("pr-now")) await git("remote", "add", "origin", `https://github.com/example/${name}.git`); await fs.writeFile(join(repos[name], "README.md"), `# example/${name}\n`);
      await git("add", "."); await git("-c", "user.name=Dana", "-c", "user.email=dana@example.com", "commit", "-q", "-m", "init");
    }
  }
  // review-mode: someone reviews example/app, so its PR without reviewers asks for them.
  if (only.includes("review-mode") || only.includes("pr-link")) await call("follow.save-reviewers", { repo: "example/app", reviewers: [{ login: "ravi", name: "Ravi" }] });
  // reviewers-click: Ravi and Mina review example/app, so each PR's row reads "Add reviewers to #N: Ravi and Mina".
  if (only.includes("reviewers-click")) await call("follow.save-reviewers", { repo: "example/app", reviewers: [{ login: "ravi", name: "Ravi" }, { login: "mina", name: "Mina" }] });
  const specs = [...WORKSPACES.filter(w => !only.includes("pr-now") || ["audit", "billing"].includes(w.key)).filter(w => !(argv.includes("--rename-fixup-review") || only.includes("local-titles")) || ["audit", "billing"].includes(w.key)), ...(only.includes("needs-you-states") || only.includes("panel-folds") || only.includes("tasks-view") || only.includes("own-answer") || only.includes("more-context") || only.includes("dismiss") || only.includes("dock-in-view") || only.includes("catch-up") || only.includes("dictation") || PASTE_LIKE(only) ? NEEDS_YOU_STATES : []), ...(only.includes("done-brief") ? DONE_BRIEF : []), ...(only.includes("pick-notes") || only.includes("dock-in-view") || only.includes("catch-up") || only.includes("dictation") ? PICK_NOTES : []), ...(only.includes("review-mode") || only.includes("pr-link") ? REVIEW_MODE_STATES : []), ...(only.includes("sending") ? SENDING_STATES : []), ...(only.includes("merge-click") || only.includes("dismiss") ? MERGE_CLICK_STATES : []), ...(only.includes("reviewers-click") ? REVIEWERS_CLICK_STATES : []), ...(only.includes("pr-scale") ? PR_SCALE_STATES : []), ...(only.includes("batch-churn") ? BATCH_CHURN_STATES : []), ...(only.includes("scheduled-tasks") ? SCHEDULED_STATES : []), ...(only.includes("paged-lists") ? PAGED_STATES : []), ...(only.includes("now-line") ? NOW_LINE_STATES : []), ...(only.includes("peek") ? PEEK_STATES : []), ...(only.includes("pr-now") ? PR_NOW_STATES : []), ...(only.includes("question-links") ? QL_STATES : [])];
  // Geometry checks need one question, one repair and one permission row, not the full README inventory.
  if (only.includes("menu-bounds")) specs.splice(0, specs.length, ...specs.filter(w => ["billing", "email", "search"].includes(w.key)));
  if (only.includes("layout-search")) {
    specs.splice(0, specs.length, ...specs.filter(w => ["audit", "billing"].includes(w.key)));
    specs.push(
      { key: "smart", flag: false, project: "app", title: "Smart Session", minute: 0, prompt: "Keep the session working", steps: [rpc("follow.enroll", { goal: "Keep the session working" }), msg("Waiting for review.")] },
      { key: "invoice", flag: false, project: "app", title: "Invoice exports", minute: 1, prompt: "Export invoices", steps: [rpc("follow.enroll", { goal: "Export invoices" }), msg("Waiting for review.")] });
  }
  await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(Object.fromEntries(specs.map(w => [w.prompt, w.steps]))));
  const workspaces = [];
  for (const spec of specs) {
    await setDaemonClock(at(spec.minute));
    const w = await api.workspaces.create({ title: spec.title, source: { kind: "directory", path: repos[spec.project ?? "app"] } });
    const agent = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: spec.title });
    // Discovery can miss an agent created a moment ago on a loaded machine: retry that one error for up to 20 s.
    for (let tries = 0; ; tries++) {
      try { await call("follow.activate", { workspaceId: w.id }); break; }
      catch (error) { if (tries >= 20 || !/no available main agent/.test(String(error?.message))) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
    await call("follow.control", { workspaceId: w.id, enable_auto_sends: false });
    await client.sendMessage(agent.id, spec.prompt, { messageId: `shots-${spec.key}` });
    const last = [...spec.steps].reverse().find(s => s.item?.type === "assistant_message")?.item.text;
    // `worked`: the turn spans that many minutes of the clock (the chat's "Worked for"), held at its gate meanwhile.
    const gate = spec.steps.find(s => s.gate)?.gate;
    if (gate) {
      await until(`${spec.key} at its gate`, () => fs.access(join(home, `fixture-gated-${gate}`)).then(() => true, () => false));
      await setDaemonClock(at(spec.minute + (spec.worked ?? 0)));
      await fs.writeFile(join(home, `fixture-gate-${gate}`), "");
    }
    await until(`${spec.key} turn`, async () => {
      const entries = (await client.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 50 })).entries;
      const failure = entries.find(e => e.item.type === "assistant_message" && /\[System Error\]/.test(e.item.text));
      if (failure) throw new Error(`${spec.key}: ${failure.item.text}`);
      if (spec.waitFor === "running") return entries.some(e => e.item.type === "tool_call");
      if (spec.waitFor === "permission") return (await client.fetchAgent(agent.id)).agent?.pendingPermissions?.length > 0 || entries.some(e => e.item.type === "assistant_message" && e.item.text === last) && await new Promise(r => setTimeout(() => r(true), 500));
      return (await client.fetchAgent(agent.id)).agent?.status === "idle" && entries.some(e => e.item.type === "assistant_message" && e.item.text === last);
    });
    // Settle this workspace inside its own phase. Under the crawling clock, Date-based caches (the daemon directory) and
    // settle windows (a permission's 30 s) only pass when the clock moves, so step it a minute and wait for the row and
    // two inbox ticks (every 15 s, real time). Otherwise they settle in whichever later phase comes first.
    await setDaemonClock(at(spec.minute + (spec.worked ?? 0)) + 61_000);
    if (spec.waitFor !== "running" && spec.flag !== false) await until(`${spec.key} inbox flag`, async () => (await call("follow.inbox-list", {})).rows.some(r => r.agentId === agent.id && r.needs), { tries: 120, every: 500 });
    await inboxTicks(home, 2);
    workspaces.push({ key: spec.key, title: spec.title, workspaceId: w.id, agentId: agent.id });
  }
  // AI priority off: the ranker would call a real model (and Home would show its spinner). Through the agent tool,
  // planned then confirmed, like any agent would.
  const caller = (workspaces.find(w => w.key === "audit") ?? workspaces[0]).agentId;
  await actPlanned(call, caller, "set_display", { values: { enable_ranker: false } });
  // PR snapshots from the fake gh, then Done for the shipped workspace.
  let missing = [];
  await until(() => `PR snapshots (missing ${missing.join(", ")})`, async () => {
    await call("follow.refresh", {});
    missing = (await call("follow.list", {})).workspaces.flatMap(w => w.prs).filter(p => !p.snapshot).map(p => p.error ? `${p.key}: ${p.error}` : p.key);
    return !missing.length;
  }, { tries: 120, every: 500 });
  for (const spec of specs.filter(s => s.done)) {
    const w = workspaces.find(x => x.key === spec.key);
    const done = await call("follow.done", { agentId: w.agentId, summary: spec.done });
    if (done.blockers.length) throw new Error(`${spec.key} could not be Done: ${done.blockers.join("; ")}`);
  }
  // The developer's moves: sign a turn off (its PRs then wait on others), put a question off until tomorrow, or send a
  // repair batch the agent is now working on (Fixing). The agent holds that turn open, so it stays Fixing.
  const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8"));
  for (const spec of specs.filter(s => s.after)) {
    const w = workspaces.find(x => x.key === spec.key);
    if (spec.after === "snooze") { await call("follow.inbox-act", { action: "snooze", agentIds: [w.agentId], until: "2026-03-05T09:00:00.000Z" }); continue; }
    await call("follow.inbox-act", { action: "sign_off", agentIds: [w.agentId] });
    if (spec.after !== "fix") continue;
    let batch = null;
    await until(`${spec.key} repair batch`, async () => {
      await call("follow.refresh", {});
      batch = (await call("follow.list", {})).workspaces.find(x => x.id === w.workspaceId)?.batches.find(b => b.state === "pending");
      return !!batch;
    }, { tries: 120, every: 500 });
    scripts[`agent:${w.agentId}`] = [think("Reproduce the failure locally first, then fix it at the source."), { hold: true }];
    await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
    await call("follow.send", { workspaceId: w.workspaceId, batchId: batch.id });
    await until(`${spec.key} fixing`, async () => (await client.fetchAgent(w.agentId)).agent?.status === "running", { tries: 120, every: 500 });
  }
  // needs-you-states' person item (a-human-only-outcome-is-a-human-item): the review repair goes out, and the agent
  // acknowledges it blocked with humanOnly, as an agent does when only the reviewer can clear a stale review.
  if (only.includes("needs-you-states")) {
    const w = workspaces.find(x => x.key === "ny-person");
    let batch = null;
    await until("ny-person repair batch", async () => {
      await call("follow.refresh", {});
      batch = (await call("follow.list", {})).workspaces.find(x => x.id === w.workspaceId)?.batches.find(b => b.state === "pending");
      return !!batch;
    }, { tries: 120, every: 500 });
    scripts[`agent:${w.agentId}`] = [msg("Nothing to fix: the changes-requested review predates the fix.")];
    await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
    await call("follow.send", { workspaceId: w.workspaceId, batchId: batch.id });
    await until("ny-person sent", async () => ["sent", "sending"].includes((await call("follow.list", {})).workspaces.find(x => x.id === w.workspaceId)?.batches.find(b => b.id === batch.id)?.state), { tries: 120, every: 500 });
    await call("follow.acknowledge", { agentId: w.agentId, batchId: batch.id, outcome: "blocked", humanOnly: true,
      result: "No change on #262 since the last two messages: 0 unresolved threads. Changes requested is ravi's review from before the fix, which is already in. Needs ravi to re-review or dismiss it; nothing for an agent to fix." });
    await call("follow.refresh", {});
  }
  // One item the developer added by hand ("Added by you" in the Linked list).
  const billing = workspaces.find(w => w.key === "billing");
  await call("follow.set-linked-items", { workspaceId: billing.workspaceId, action: "add", ref: "APP-151" });
  if (only.includes("local-titles")) {
    await call("follow.workspace-spec", { workspaceId: billing.workspaceId, action: "set", url: "https://claude.ai/artifact/charge-retry-spec", title: "Charge retry spec" });
    await call("follow.set-linked-items", { workspaceId: billing.workspaceId, action: "add", ref: "https://claude.ai/artifact/retry-rollout", title: "Retry rollout checklist" });
    await call("follow.link-item", { agentId: billing.agentId, ref: "https://claude.ai/artifact/example-untitled" });
  }
  // needs-you-states: the developer answers, so the question and its brief leave every surface.
  for (const spec of specs.filter(s => s.answer)) await call("follow.answer-question", { workspaceId: workspaces.find(w => w.key === spec.key).workspaceId, ...spec.answer, action: "send" });
  await call("follow.refresh", {});
  // The inbox loop folds PR, CI and review state into each brief; let it run on the snapshots before the clock moves.
  await inboxTicks(home, 2);
  return { workspaces };
}

/**
 * Waits for `n` more runs of the worker's inbox loop, which runs every 15 s of real time (a real setTimeout, not the
 * crawling clock). Not by watching inbox.json: since #123 (store-writes-only-real-changes) a lastSeen-only change is
 * written at most every LAST_SEEN_WRITE_MS of the clock, and the fake clock crawls, so it is never written during a run
 * and a wait on the file times out ("timed out waiting for an inbox tick").
 */
async function inboxTicks(_home, n) {
  await new Promise(r => setTimeout(r, n * 15_000 + 2_000));
}

async function until(label, check, { tries = 120, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise(r => setTimeout(r, every)); }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

// ---------- shooting ----------
const INIT = ({ seen }) => {
  try {
    localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "2026-03-04T09:00:00.000Z" }));
    if (seen) localStorage.setItem("follow-up.whats-new.seen", seen);
  } catch {}
};

// ---------- reaching Home (scripts/ui-home.mjs) ----------
let ORIGIN = null; let SERVER_ID = null;
/**
 * The header button's Needs-you dot is drawn whole (follow-up-has-one-mark): the amber box in a screenshot of the
 * button is as tall as it is wide, within 1 px. Paseo clips a header icon to its 16 px box, and 2026-11-16 the dot
 * drew flat-topped (7 wide, 6 tall). Measures pixels, so it catches any clipper, not one known style.
 */
async function checkNeedDot(page) {
  const dot = page.getByTestId("follow-up-need-dot").first();
  await dot.waitFor();
  if (await page.getByTestId("follow-up-need-dot").count() !== 1) throw new Error("expected one header Needs-you dot");
  // Geometry first, exact: the dot lies inside every ancestor that clips (a 0.2 px cut can hide in anti-aliasing).
  const cut = await dot.evaluate(el => {
    const d = el.getBoundingClientRect();
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).overflow === "visible") continue;
      const r = a.getBoundingClientRect();
      if (d.left < r.left - 0.01 || d.top < r.top - 0.01 || d.right > r.right + 0.01 || d.bottom > r.bottom + 0.01) return { dot: [d.left, d.top, d.right, d.bottom], clipper: [r.left, r.top, r.right, r.bottom] };
    }
    return null;
  });
  if (cut) throw new Error(`the header's Needs-you dot pokes out of a clipping box: ${JSON.stringify(cut)}`);
  const color = await dot.evaluate(el => getComputedStyle(el).backgroundColor);
  const b = await dot.boundingBox();
  const clip = { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 };
  const png = (await page.screenshot({ clip })).toString("base64");
  const box = await page.evaluate(async ({ png, color }) => {
    const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const [r0, g0, b0] = color.match(/\d+/g).map(Number); const px = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 60) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? null : { width: x1 - x0 + 1, height: y1 - y0 + 1, image: img.width };
  }, { png, color });
  const dpr = box ? box.image / clip.width : 1; // device px per css px
  const w = box && box.width / dpr, h = box && box.height / dpr;
  if (!box || Math.abs(w - h) > 1) throw new Error(`the header's Needs-you dot is clipped: amber box ${JSON.stringify({ w, h })} css px`);
  if (w < 5 || w > 9) throw new Error(`the amber box isn't the 7 px dot: ${w.toFixed(1)} x ${h.toFixed(1)} css px`);
  log(`need dot ok: ${w.toFixed(1)} x ${h.toFixed(1)} css px`);
}

/** Follow-up Home by URL, asserted (scripts/ui-home.mjs); `keepDialogs` leaves Getting started or What's new open. */
const openHome = (page, { keepDialogs = false } = {}) => openHomeAt(page, { origin: ORIGIN, serverId: SERVER_ID, keepDialogs });

/**
 * Renders go into this public repo's PRs and README. harnessEnv pins every harness process's hostname to HARNESS_HOST;
 * this is the backstop: a shot whose page text or title names the real machine (its full name or first label, as a
 * truncated header shows it), its user or the company fails instead of being saved (scripts/real-names.mjs).
 */
async function noRealHost(page) {
  assertNoRealNames(await page.evaluate(() => `${document.title}\n${document.body.innerText}`), "the page");
}

const failures = [];
function makeShooter({ browser, port, out, scheme: forced, optimiser, results, crashed }) {
  /** Opens the web app in a fresh context, runs `drive`, and returns the PNG (optionally clipped to what drive returns). */
  async function capture(name, viewport, theme, drive, { seen = null, scale = null, init = null, ws = null } = {}) {
    const colorScheme = forced ?? theme;
    // Always open at desktop width: on a phone Paseo's sidebar is a drawer, so phone frames open Home first, then narrow.
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme, deviceScaleFactor: scale ?? (viewport.width < 768 ? 2 : desktopScale), reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
    try {
      await context.addInitScript(INIT, { seen });
      if (init) await context.addInitScript(init);
      // A stand-in for one daemon reply or descriptor (the archive review), every other frame passed through as is.
      if (ws) await context.routeWebSocket(/.*/, ws);
      const page = await context.newPage();
      // SHOTS_CONSOLE=1 prints the page's errors, to tell a real bug from a flaky frame.
      if (process.env.SHOTS_CONSOLE) { page.on("console", m => { if (m.type() === "error" || (process.env.SHOTS_CONSOLE === "all" && m.type() === "warning")) log(`${name} console:`, m.text().slice(0, 600)); }); page.on("pageerror", e => log(`${name} pageerror:`, e.message.slice(0, 600))); }
      await page.clock.setFixedTime(BASE + VIEW);
      page.setDefaultTimeout(30000);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByText("Follow-up", { exact: true }).first().waitFor();
      const clip = await drive(page);
      if (!page.keepPointer) await page.mouse.move(1, viewport.height - 1);
      // A focused field draws a focus ring only some of the time (it depends on how the last key event landed).
      // The keyboard walk's shots keep it: their focus ring is the point (page.keepFocus, set by the drive).
      if (!page.keepFocus) await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await settle(page);
      await noRealHost(page);
      // Spinners and other endless animations stop at their first frame, and the caret is hidden.
      return { png: await page.screenshot({ ...(clip ? { clip } : {}), animations: "disabled", caret: "hide" }), colorScheme };
    } catch (error) {
      const page = context.pages()[0];
      if (page) await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {});
      throw new Error(`shot ${name}: ${error.message}`);
    } finally { await context.close(); }
  }
  async function save(name, png, colorScheme) {
    const path = join(out, `follow-up-${name}.png`);
    await fs.writeFile(path, png);
    const bytes = await optimise(path, optimiser);
    results.push({ name, path, bytes, scheme: colorScheme });
    log(`${name}: ${path} (${Math.round(bytes / 1024)} KB, ${colorScheme})`);
  }
  /** One failed shot is logged and counted; the rest still run, and the script exits non-zero at the end. */
  // A crashed daemon worker fails the run at once with its log line: after a restart every later shot only times out.
  const guard = work => async (name, ...rest) => {
    try { await work(name, ...rest); } catch (error) { failures.push(name); console.error(`[shots] ${name} FAILED: ${error.message.split("\n")[0]} (see ${join(out, `${name}-failed.png`)})`); }
    const crash = await crashed();
    if (crash) throw new Error(`the harness daemon crashed during ${name}: ${crash}`);
  };
  // --shot <regex>: render only the matching shots of the chosen set (a quick re-render of a few).
  const shotFilter = argv.includes("--shot") ? new RegExp(argv[argv.indexOf("--shot") + 1]) : null;
  const shoot = guard(async (name, viewport, theme, drive, options) => { if (shotFilter && !shotFilter.test(name)) return; const { png, colorScheme } = await capture(name, viewport, theme, drive, options); await save(name, png, colorScheme); });
  /** A frame taken mid-drive (merge-click's "Merging…"), saved like a shot. */
  shoot.now = async (name, page, theme) => save(name, await page.screenshot({ animations: "disabled" }), forced ?? theme);
  /** Several captures side by side on one canvas (the phone shot: the list and a detail). */
  shoot.side = guard(async (name, theme, frames) => {
    const shots = [];
    for (const [i, f] of frames.entries()) shots.push(await capture(`${name}-${i + 1}`, f.viewport, theme, f.drive));
    const colorScheme = shots[0].colorScheme;
    const width = frames.reduce((sum, f) => sum + f.viewport.width, 0) + 24 * (frames.length + 1);
    const height = Math.max(...frames.map(f => f.viewport.height)) + 48;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage();
      const bg = colorScheme === "light" ? "#e9e9e7" : "#0b0b0c";
      await page.setContent(`<body style="margin:0;background:${bg};display:flex;gap:24px;padding:24px;align-items:flex-start">${shots.map((s, i) => `<img style="width:${frames[i].viewport.width}px;height:${frames[i].viewport.height}px;border-radius:18px;box-shadow:0 1px 3px rgba(0,0,0,.18)" src="data:image/png;base64,${s.png.toString("base64")}">`).join("")}</body>`);
      await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
      await save(name, await page.screenshot({ animations: "disabled" }), colorScheme);
    } finally { await context.close(); }
  });
  return shoot;
}

// ---------- feeds (npm run test:feeds) ----------
/**
 * Plan item 6's end-to-end check (invariant idle-client-makes-at-most-one-rpc-a-minute keeps the client quiet; this keeps
 * it correct). Home, a workspace's panel and a chat's collapsed pill are open, each its own client. State changes on the
 * worker's side (an agent's turn ends with a question, an agent sets the sort, a priorities write, Smart Session writes
 * its usage file), and each surface must show it within 5 s (usage: the watch debounce plus 2 s) with no poll RPC in between. Then the worker is reloaded,
 * killed, and the daemon restarted under the open pages: after each, a change must still show within 5 s, with no page
 * reload. On Paseo 0.15 (no subscriptions) the same cases run and record how long the polls take; they pass within the
 * poll interval. Writes feeds.json to --out.
 */
const POLL_RPCS = /"(follow\.(list|inbox-list|overseer-status|priorities|rank-status|usage)|settings\.display\.read)"/;
async function checkFeeds({ seeded, call, cli, home }) {
  const live = paseo016;
  const BUDGET = live ? 5_000 : 75_000;
  // Usage lands after the worker's watch debounce (shared/usage.ts, read here so the two can't drift), plus 2 s.
  const debounce = Number((await fs.readFile("shared/usage.ts", "utf8")).match(/USAGE_WATCH_DEBOUNCE_MS = ([\d_]+)/)?.[1].replaceAll("_", ""));
  if (!debounce) throw new Error("feeds: no USAGE_WATCH_DEBOUNCE_MS in shared/usage.ts");
  const USAGE_BUDGET = live ? debounce + 2_000 : BUDGET;
  // 0.15 polls follow.usage, which answers from a cache with a USAGE_POLL_MS TTL on the worker's clock. The harness
  // crawls that clock (1 s a real 1000 s), so the cache never expires here; in real time it is at most two polls.
  const USAGE_ON_015 = "0.15 reads usage through follow.usage's 60 s cache, timed on the worker's clock, which the harness crawls; not measurable here";
  const WAIT = live ? 15_000 : 90_000;
  const ws = key => seeded.workspaces.find(w => w.key === key);
  const spec = key => WORKSPACES.find(w => w.key === key);
  const polls = [];
  const rows = [];
  const fail = [];
  const context = await browser.newContext({ viewport: DESKTOP, colorScheme: "dark", reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
  await context.addInitScript(INIT, { seen: null });
  const open = async (label, drive) => {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("websocket", socket => socket.on("framesent", f => {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString("utf8");
      if (!text.includes("plugin.rpc.invoke")) return;
      const m = text.match(POLL_RPCS);
      if (m) polls.push({ at: Date.now(), page: label, name: m[1] });
    }));
    await page.clock.setFixedTime(BASE + VIEW);
    await page.goto(ORIGIN);
    await page.getByText("Follow-up", { exact: true }).first().waitFor();
    await drive(page);
    await page.evaluate(() => { window.__followFeedsMark = "kept"; });
    return page;
  };
  // A usage file the worker can watch: Smart Session's directory exists before anyone subscribes.
  const smart = join(home, "plugin-data", "smart-session"); await fs.mkdir(smart, { recursive: true });
  const daemonNow = async () => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); return c.fake + (Date.now() - c.real) * c.rate; };
  const writeUsage = async pct => {
    const now = new Date(await daemonNow());
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const row = { accountId: "claude-main", family: "claude", fetchedAt: now.toISOString(), windows: { five_hour: { pct, resetsAt: new Date(now.getTime() + 3 * 3600_000).toISOString() }, seven_day: { pct: 20, resetsAt: new Date(now.getTime() + 4 * 86400_000).toISOString() } } };
    await fs.appendFile(join(smart, `accounts-${month}.jsonl`), JSON.stringify(row) + "\n");
  };
  await writeUsage(30);
  const caller = ws("audit").agentId;
  const agentAct = (tool, args) => actPlanned(call, caller, tool, args);
  /** An agent's next turn ends with `ask`: Needs you flags it when the turn ends (agent.turn_ended), not on a tick. */
  const ask = async (key, text) => {
    const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8"));
    scripts[`agent:${ws(key).agentId}`] = [think("Checking before I go on."), { item: { type: "assistant_message", text } }];
    await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
    await client.sendMessage(ws(key).agentId, `Feeds check: ${text}`, { messageId: `feeds-${key}-${Date.now()}` });
  };
  const needsCount = async page => {
    const label = await page.getByRole("toolbar", { name: "Status", exact: true }).getByRole("button", { name: /^Needs you, \d+/ }).first().getAttribute("aria-label", { timeout: 5_000 }).catch(() => null);
    return label ? Number(label.match(/^Needs you, (\d+)/)[1]) : 0;
  };
  /** Runs `change`, then times each surface until it shows it; counts the poll RPCs every open page made meanwhile. */
  const fresh = async (name, change, surfaces, { note = "", budget = BUDGET, only016 = null } = {}) => {
    if (only016 && !live) {
      rows.push({ case: name, surface: surfaces.map(s => s[0]).join(", "), ms: null, skipped: only016, ok: true });
      log(`feeds SKIP ${name} on ${paseoVersion}: ${only016}`);
      return;
    }
    const t0 = Date.now();
    await change();
    const changed = Date.now();
    await Promise.all(surfaces.map(async ([surface, page, shown]) => {
      let ms = null;
      try { await shown(page, WAIT); ms = Date.now() - changed; } catch { /* not shown within WAIT */ }
      const between = polls.filter(p => p.at >= t0 && p.at <= (ms === null ? Date.now() : changed + ms));
      const kept = await page.evaluate(() => window.__followFeedsMark === "kept").catch(() => false);
      const ok = ms !== null && ms <= budget && kept && (!live || between.length === 0);
      const row = { case: name, surface, ms, budgetMs: budget, polls: between.length, pollNames: [...new Set(between.map(p => p.name))], pageReloaded: !kept, ok, note };
      rows.push(row);
      log(`feeds ${ok ? "PASS" : "FAIL"} ${name} / ${surface}: ${ms === null ? `not shown in ${WAIT / 1000} s` : `${ms} ms`}, ${between.length} poll RPC(s)${row.pollNames.length ? ` (${row.pollNames.join(", ")})` : ""}${kept ? "" : ", PAGE RELOADED"}${note ? ` [${note}]` : ""}`);
      if (!ok) fail.push(`${name} / ${surface}`);
    }));
  };
  const text = (t, opts = {}) => (page, timeout) => page.getByText(t, opts).first().waitFor({ state: "visible", timeout });
  const label = re => (page, timeout) => page.getByRole("button", { name: re }).first().waitFor({ state: "visible", timeout });
  const workerUp = async () => { for (let i = 0; i < 240; i++) { try { await call("follow.inbox-list", {}); return; } catch { await new Promise(r => setTimeout(r, 250)); } } throw new Error("the worker did not come back"); };
  const quiet = ms => new Promise(r => setTimeout(r, ms));
  try {
    // The flagged workspace's own chat: its panel and, in another tab, its collapsed pill.
    const homePage = await open("home", page => openHome(page));
    const panelPage = await open("panel", async page => {
      await openChat(page, spec("invites").title, spec("invites").prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    });
    const pillPage = await open("pill", page => openChat(page, spec("invites").title, spec("invites").prompt));
    const pillBefore = await pillPage.getByRole("button", { name: /^Follow-up · / }).last().getAttribute("aria-label").catch(() => null);
    // Idle first: the opening reads are over, and every client is on its feeds.
    await quiet(20_000);
    const idleFrom = Date.now(); await quiet(60_000);
    const idle = polls.filter(p => p.at >= idleFrom).length;
    log(`feeds idle: ${idle} poll RPC(s) in 60 s across Home, the panel and the pill`);

    const n0 = await needsCount(homePage);
    const question = "Should invite links expire after 7 days or 30?";
    await fresh("Needs-you flag (an agent's turn ends with a question)", () => ask("invites", question), [
      ["Home: Needs you count", homePage, async (page, timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await needsCount(page) > n0) return; await quiet(100); } throw new Error("count"); }],
      ["panel: the ask", panelPage, text(question)],
      ["pill (collapsed): its label", pillPage, async (page, timeout) => { await page.waitForFunction(before => [...document.querySelectorAll('[aria-label^="Follow-up · "]')].some(el => el.getAttribute("aria-label") !== before), pillBefore, { timeout }); }],
    ], { note: "includes the fixture agent's turn" });
    await fresh("Sort set by another client (set_display home_sort)", () => agentAct("set_display", { values: { home_sort: "name" } }), [
      ["Home: sort button", homePage, label(/^Sort: Name/)],
    ]);
    await fresh("Sort set back by another client", () => agentAct("set_display", { values: { home_sort: "priority" } }), [
      ["Home: sort button", homePage, label(/^Sort: Priority/)],
    ]);
    await fresh("Priorities written (the ranker's store write, via set_priorities)", () => agentAct("set_priorities", { priorities: [{ workspace: ws("billing").workspaceId, score: 90, reason: "Feeds check: first priority" }], replace: false }), [
      ["Home: the priority line", homePage, text("Feeds check: first priority")],
    ]);
    await fresh("Usage file written (Smart Session)", () => writeUsage(63), [
      ["Home: usage meter", homePage, label(/5h 63%/)],
    ], { budget: USAGE_BUDGET, note: `${debounce} ms watch debounce`, only016: USAGE_ON_015 });

    // The worker restarts under the open pages: Paseo closes every subscription, the client polls and resubscribes.
    await cli("plugin", "reload", "follow-up");
    await workerUp(); await quiet(3_000);
    await fresh("After a plugin reload", () => agentAct("set_priorities", { priorities: [{ workspace: ws("billing").workspaceId, score: 91, reason: "Feeds check: after the reload" }], replace: false }), [
      ["Home: the priority line", homePage, text("Feeds check: after the reload")],
    ]);
    await fresh("After a plugin reload: a new flag", () => ask("usage", "Should the usage chart default to 30 days?"), [
      ["Home: Needs you count", homePage, async (page, timeout) => { const n = await needsCount(page); const end = Date.now() + timeout; while (Date.now() < end) { if (await needsCount(page) !== n) return; await quiet(100); } throw new Error("count"); }],
    ], { note: "includes the fixture agent's turn" });

    // A crash: the worker process is killed. Paseo restarts it, or (if it doesn't) a reload does.
    // The worker's pid is in the lock it holds.
    const worker = Number((await fs.readFile(join(home, "plugin-data", "follow-up", "worker.lock"), "utf8").catch(() => "")).split(":")[0]) || 0;
    let crashNote = "no worker.lock";
    if (worker) {
      process.kill(worker, "SIGKILL");
      crashNote = "Paseo restarted the worker";
      try { await quiet(1_000); await Promise.race([workerUp(), quiet(30_000).then(() => { throw new Error("late"); })]); }
      catch { crashNote = "Paseo did not restart the worker within 30 s; reloaded"; await cli("plugin", "reload", "follow-up"); await workerUp(); }
      await quiet(3_000);
    }
    await fresh("After the worker is killed", () => agentAct("set_priorities", { priorities: [{ workspace: ws("billing").workspaceId, score: 92, reason: "Feeds check: after the crash" }], replace: false }), [
      ["Home: the priority line", homePage, text("Feeds check: after the crash")],
    ], { note: crashNote });

    // The daemon restarts: every page's websocket drops and reconnects; the host replays its subscriptions.
    // The change waits for Home's page to reconnect (a frame from the new daemon): until then nothing can reach it, push or poll,
    // and the app's own reconnect backoff is Paseo's, not Follow-up's.
    let heard = 0;
    homePage.on("websocket", socket => socket.on("framereceived", () => { heard = Date.now(); }));
    daemon.kill("SIGTERM");
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await quiet(100);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    const restartAt = Date.now();
    await respawnDaemon(); await workerUp();
    const daemonBack = Date.now();
    for (let i = 0; heard <= daemonBack; i++) { if (i > 1800) throw new Error("Home's page did not reconnect within 180 s"); await quiet(100); }
    const pageBack = Date.now();
    await quiet(3_000);
    await fresh("After a daemon restart (websocket reconnect)", () => agentAct("set_priorities", { priorities: [{ workspace: ws("billing").workspaceId, score: 93, reason: "Feeds check: after the daemon restart" }], replace: false }), [
      ["Home: the priority line", homePage, text("Feeds check: after the daemon restart")],
    ], { note: `daemon back after ${Math.round((daemonBack - restartAt) / 1000)} s, Home's page reconnected ${Math.round((pageBack - daemonBack) / 1000)} s later` });
    await fresh("After a daemon restart: usage", () => writeUsage(71), [
      ["Home: usage meter", homePage, label(/5h 71%/)],
    ], { budget: USAGE_BUDGET, note: `${debounce} ms watch debounce`, only016: USAGE_ON_015 });
    await fs.writeFile(join(out, "feeds.json"), JSON.stringify({ paseo: paseoVersion, budgetMs: BUDGET, idlePollsPerMinute: idle, rows }, null, 2));
    if (fail.length) throw new Error(`feeds: ${fail.length} case(s) failed: ${fail.join("; ")}`);
    log(`feeds: all ${rows.length} passed on ${paseoVersion}`);
  } catch (error) {
    await fs.writeFile(join(out, "feeds.json"), JSON.stringify({ paseo: paseoVersion, budgetMs: BUDGET, rows, error: String(error?.message ?? error) }, null, 2)).catch(() => {});
    for (const [i, page] of context.pages().entries()) await page.screenshot({ path: join(out, `feeds-failed-${i}.png`) }).catch(() => {});
    failures.push("feeds");
    throw error;
  } finally { await context.close().catch(() => {}); }
}

/** No spinners or skeletons on screen, fonts loaded, and two quiet frames. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Getting started's step indicator is a progressbar too ("Step 1 of N"), but not a loading state.
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(n => n.getBoundingClientRect().width > 0 && !/^Step \d+ of \d+$/.test(n.getAttribute("aria-label") ?? "")), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** Paseo 0.16+ draws Follow-up's settings categories as its own tabs, one screen each (client/settings-screens.ts). */
const nativeSettingsTabs = !/(^|\D)0\.15\.\d+/.test(paseoVersion ?? "");
const SETTINGS_SCREENS = { general: "projects", following: "following", reviewers: "reviewers", agents: "agents", new: "new", display: "display", brief: "brief" };
const SETTINGS_TITLES = { general: "General", following: "Following", reviewers: "Reviewers", agents: "Agents", new: "New work", display: "Inbox & display", brief: "Compass" };
/** Settings → Follow-up → a category, on either host: 0.16+ opens its screen; 0.15 picks Follow-up's own tab (phone: its row). */
async function openSettingsAt(page, category, vp = page.viewportSize()) {
  if (nativeSettingsTabs) {
    await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/${SETTINGS_SCREENS[category]}`);
    await page.locator(`[data-testid="plugin-settings-tab-${SETTINGS_SCREENS[category]}"]`).filter({ visible: true }).first().waitFor();
    return;
  }
  await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/projects`);
  const title = SETTINGS_TITLES[category];
  await (vp.width >= 768 ? page.getByRole("tab", { name: new RegExp(`^${title}`) }) : page.getByRole("button", { name: title, exact: true })).filter({ visible: true }).first().click();
}
/** The sidebar shot's window: every group of the fixture fits, down to Quiet, and the chat beside it lays out whole. */
const SIDEBAR = { width: 960, height: 1060 };
/**
 * The phone detail pane scrolls under a dock pinned to the bottom. Where the dock's top edge cuts a bordered block (an
 * option card, a button), the shot shows a sliver of it above the dock. Scroll the pane just enough that the cut block
 * shows whole, so the dock's edge falls in the gap after it.
 */
async function clearDock(page, inPane, dockButton) {
  const dockTop = await page.getByRole("button", { name: dockButton }).first().evaluate(el => el.getBoundingClientRect().top);
  await page.getByText(inPane).first().evaluate((el, edge) => {
    let pane = el.parentElement;
    while (pane && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
    if (!pane) return;
    const blocks = [...pane.querySelectorAll("*")].map(e => ({ e, r: e.getBoundingClientRect(), s: getComputedStyle(e) }))
      .filter(({ r, s }) => r.height > 24 && r.width > 120 && (parseFloat(s.borderTopWidth) > 0 || s.backgroundColor !== "rgba(0, 0, 0, 0)"));
    const cut = blocks.filter(({ r }) => r.top < edge && r.bottom > edge - 12).sort((a, b) => b.r.top - a.r.top)[0];
    if (cut && cut.r.bottom - edge + 12 < 240) pane.scrollTop += cut.r.bottom - edge + 12;
  }, dockTop);
}
/**
 * Opens a workspace's chat from Paseo's sidebar like a person would (deep links land before the host is known). The sidebar shows a project's first rows and folds the rest under
 * "Show more", and the order moves as earlier shots touch workspaces: a later pass found "Billing retries" folded and
 * timed out (ny-brief-same-q-panel-dark, 2026-11-13). Unfold every project until the row is there, then click it.
 */
async function openChat(page, title, prompt) {
  const row = page.getByText(title, { exact: true }).first();
  for (let i = 0; i < 4 && !await row.isVisible().catch(() => false); i++) {
    const more = page.getByText("Show more", { exact: true }).filter({ visible: true }).first();
    if (!await more.isVisible().catch(() => false)) break;
    await more.click();
  }
  await row.click({ timeout: 30000 });
  await page.getByText(prompt).first().waitFor();
}

/**
 * Put in chat (plan #9, Paseo 0.16: run with HARNESS_PASEO=0.16): the question's actions row (Send · Put in chat, Copy as
 * an icon with the hover title "Copy answer") on the question dialog (desktop), Home's detail pane (phone) and the dialog
 * the pill's Answer opens, light and dark; then answers waiting to be sent (in-chat, copied), Sign off as the escape
 * hatch, and the waiting row's one-click Send.
 */
async function putInChatShots({ shoot, seeded, call, billing }) {
  const pickAnswer = async page => {
    await page.getByText("Retry card_declined once after 24 hours").last().click();
    const note = page.getByPlaceholder(/note for the agent/i).last();
    if (await note.isVisible().catch(() => false)) await note.fill("Only for soft declines. Hard declines still go straight to dunning.");
  };
  const dialog = async page => {
    await openChat(page, "Billing retries", billing.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await page.getByRole("tab", { name: /^Questions/ }).first().click();
    await page.getByRole("button", { name: /^Q1,/ }).first().click();
    await page.getByText("Should charges that fail with card_declined retry").last().waitFor();
  };
  const phone = async page => {
    await openHome(page); await page.setViewportSize(PHONE);
    await (await homeRow(page, "Billing retries")).click();
    await page.getByText("Retry card_declined once after 24 hours").first().waitFor();
  };
  const actionsRow = async page => {
    await page.getByRole("button", { name: /^Put your Q1 answer in the agent's chat/ }).last().waitFor();
    if (!await page.locator('[title="Copy answer"]').count()) throw new Error("the Copy icon has no hover title");
  };
  for (const theme of ["light", "dark"]) {
    await shoot(`pic-dialog-${theme}`, DESKTOP, theme, async page => { await dialog(page); await pickAnswer(page); await actionsRow(page);
      await page.getByText("Send delivers it now, even mid-turn. Put in chat adds it to your message box to edit first.").last().waitFor(); });
    await shoot(`pic-phone-${theme}`, PHONE, theme, async page => { await phone(page); await pickAnswer(page);
      const put = page.getByRole("button", { name: /^Put your Q1 answer in the agent's chat/ }).last();
      await put.evaluate(el => el.scrollIntoView({ block: "center" }));
      if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("scrolls sideways");
      await page.getByText("Send delivers it now, even mid-turn. Put in chat adds it to your message box to edit first.").locator("visible=true").first().waitFor(); });
    await shoot(`pic-pill-${theme}`, DESKTOP, theme, async page => { await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: /^Follow-up · / }).last().click();
      // The pill's row has one action, Answer, which opens the same dialog: same buttons.
      await page.getByRole("button", { name: /^Answer .*Retry declined cards\?/ }).last().click();
      await page.getByText("Should charges that fail with card_declined retry").last().waitFor(); await pickAnswer(page); await actionsRow(page); });
  }
  // Waiting to be sent (an-answer-leaves-needs-you-only-when-delivered): Billing's Q1 put in the agent's chat, Contact
  // import's Q1 copied. Both stay in Needs you, on Home's detail pane (desktop and phone) and in the dialog.
  const ws = key => seeded.workspaces.find(w => w.key === key);
  // On the phone, from Follow-up's own screen (no agent composer on it): Put in chat must take the developer to the
  // agent's chat with the answer in its box, and Copy (an icon, no hover on a phone) must say it copied. These taps
  // record Billing's answer as in-chat and Contact import's as copied for the waiting states below.
  await shoot("pic-phone-after-put-in-chat-light", PHONE, "light", async page => { await phone(page); await pickAnswer(page);
    await page.getByRole("button", { name: /^Put your Q1 answer in the agent's chat/ }).last().click();
    await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some(t => t.offsetParent && t.value.includes("Follow-up answer Q1 (")), null, { timeout: 15000 });
    if (await page.getByText("Couldn't open the agent's chat").count()) throw new Error("fell back to Copy");
    // The chat's card says where the answer is, not Answered (answerStatus).
    await page.getByText("In your message box · not sent yet").locator("visible=true").first().waitFor(); });
  await shoot("pic-phone-copy-light", PHONE, "light", async page => {
    await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, "Contact import")).click();
    await page.getByText("Update the existing contact").first().click();
    const copy = page.getByRole("button", { name: "Copy answer", exact: true }).last();
    await copy.click();
    await page.getByText(/^Copied the Q1 answer/).last().waitFor(); });
  // Fallbacks, so the waiting states below don't depend on the taps (a refusal means the tap already recorded it).
  await call("follow.answer-question", { workspaceId: ws("billing").workspaceId, questionId: "Q1", choice: "B", words: "Only for soft declines. Hard declines still go straight to dunning.", action: "chat" }).catch(e => log(`put-in-chat: billing already answered (${e.message ?? e})`));
  await call("follow.answer-question", { workspaceId: ws("csv").workspaceId, questionId: "Q1", choice: "A", action: "copy" }).catch(e => log(`put-in-chat: csv already answered (${e.message ?? e})`));
  const detail = (title, wait) => async page => { await openHome(page); await (await homeRow(page, title)).click(); await page.getByText(wait).first().waitFor(); };
  const detailPhone = (title, wait) => async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, title)).click(); await page.getByText(wait).locator("visible=true").first().waitFor(); };
  for (const theme of ["light", "dark"]) {
    await shoot(`pic-wait-in-chat-home-${theme}`, DESKTOP, theme, detail("Billing retries", "Your Q1 answer isn't sent yet"));
    // a-brief-without-an-ask-never-sits-beside-needs-you: Contact import's "No ask stated" brief isn't drawn beside it.
    await shoot(`pic-wait-copied-home-${theme}`, DESKTOP, theme, async page => { await detail("Contact import", "Your Q1 answer isn't sent yet")(page);
      if (await page.getByText(/^No ask stated/).locator("visible=true").count()) throw new Error("No ask stated beside a Needs-you item"); });
    await shoot(`pic-wait-in-chat-phone-${theme}`, PHONE, theme, detailPhone("Billing retries", "Your Q1 answer isn't sent yet"));
    await shoot(`pic-in-chat-dialog-${theme}`, DESKTOP, theme, async page => { await dialog(page); await page.getByText(/^Put in .*'s chat/).last().waitFor(); });
  }
  // The chat's own card for each answer, desktop and phone: never "Answered" before it is delivered.
  const card = (title, prompt, says, size) => async page => {
    await openChat(page, title, prompt);
    if (size) await page.setViewportSize(size);
    await page.getByText(says).locator("visible=true").first().waitFor();
    if (await page.getByText(/^Answered \d/).locator("visible=true").count()) throw new Error(`${title}: Answered before it was delivered`);
  };
  // Contact import's chat card is a "No ask stated" brief (no needs_you call), so the copied card is Push settings':
  // its brief points at its Q1, copied here.
  await call("follow.answer-question", { workspaceId: ws("push").workspaceId, questionId: "Q1", choice: "A", action: "copy" });
  const pushPrompt = WORKSPACES.find(w => w.key === "push").prompt;
  for (const theme of ["light", "dark"]) {
    await shoot(`pic-card-in-chat-${theme}`, DESKTOP, theme, card("Billing retries", billing.prompt, "In your message box · not sent yet"));
    await shoot(`pic-card-copied-${theme}`, DESKTOP, theme, card("Push settings", pushPrompt, "Copied · not sent yet"));
  }
  await shoot("pic-card-in-chat-phone-light", DESKTOP, "light", card("Billing retries", billing.prompt, "In your message box · not sent yet", PHONE));
  await shoot("pic-card-copied-phone-light", DESKTOP, "light", card("Push settings", pushPrompt, "Copied · not sent yet", PHONE));
  // The escape hatch: the developer edited the marker away, so Follow-up never saw it arrive; signing the agent's row
  // off settles it. Contact import after Sign off: gone from Needs you, and the question says so.
  const signed = await call("follow.inbox-act", { action: "sign_off", agentIds: [ws("csv").agentId] });
  log(`put-in-chat: sign off Contact import -> ${JSON.stringify(signed)}`);
  for (const theme of ["light", "dark"]) {
    await shoot(`pic-signed-off-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await (await homeRow(page, "Contact import")).click(); await page.waitForTimeout(1500);
      if (await page.getByText("Your Q1 answer isn't sent yet").count()) throw new Error("still waiting after Sign off"); });
    await shoot(`pic-signed-off-dialog-${theme}`, DESKTOP, theme, async page => {
      await openChat(page, "Contact import", WORKSPACES.find(w => w.key === "csv").prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("tab", { name: /^Questions/ }).first().click();
      await page.getByRole("button", { name: /^Q1, Duplicate contacts\?/ }).first().click();
      await page.getByText(/^You signed it off/).last().waitFor(); });
  }
  // The waiting row's Send delivers the recorded answer in one click (Billing's, put in chat above): the row leaves
  // Needs you and the toast says what happened.
  await shoot("pic-sent-from-row-light", DESKTOP, "light", async page => { await detail("Billing retries", "Your Q1 answer isn't sent yet")(page);
    await page.getByRole("button", { name: /^Send your Q1 answer to / }).last().click();
    await page.getByText(/^(Sent your Q1 answer to|Answer saved;|Paseo didn't confirm)/).last().waitFor();
    await page.getByText("Your Q1 answer isn't sent yet").waitFor({ state: "detached" }); });
  // Delivered: the same card now reads Answered (sending flips to sent once Paseo confirms).
  // The answer steers the agent, so Paseo folds the turn's earlier items (the card among them) into its "Ran N
  // command" group under the new reply: open the group, as a person would, to see the card.
  const delivered = size => async page => { await openChat(page, "Billing retries", billing.prompt); if (size) await page.setViewportSize(size);
    const answered = page.getByText(/^Answered \d/).locator("visible=true").first();
    await page.getByText(/^Ran \d+ commands?$/).locator("visible=true").first().click().catch(() => undefined);
    await answered.waitFor({ timeout: 60000 });
    await answered.evaluate(el => el.scrollIntoView({ block: "center" })); };
  for (const theme of ["light", "dark"]) await shoot(`pic-card-delivered-${theme}`, DESKTOP, theme, delivered(null));
  await shoot("pic-card-delivered-phone-light", DESKTOP, "light", delivered(PHONE));
}

async function shootAll({ shoot, seeded, plugin, home, cli, call }) {
  if (only.includes("layout-search")) {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await shoot(`layout-search-${device}-${theme}`, viewport, theme, async page => {
        await openHome(page);
        await page.setViewportSize(viewport);
        const field = page.getByRole("textbox", { name: /^(Search workspaces, branches, PRs|Search, or ask the Overseer|Search or ask the Overseer)$/ }).first();
        await field.fill("דצשרא דקדדןםמ");
        await page.getByText(/Showing results for.*smart session/).waitFor();
        if (await field.inputValue() !== "דצשרא דקדדןםמ") throw new Error("search rewrote the query");
        await page.getByText("Smart Session", { exact: true }).first().waitFor();
        
      });
    }
    await shoot("layout-search-physical-desktop-dark", DESKTOP, "dark", async page => {
      await openHome(page);
      const field = page.getByRole("textbox", { name: /^(Search workspaces, branches, PRs|Search, or ask the Overseer|Search or ask the Overseer)$/ }).first();
      await field.fill(""); await field.focus();
      const latin = "smart session", greek = "σμαρτ σεσσιον";
      for (const [i, key] of [...greek].entries()) {
        const code = latin[i] === " " ? "Space" : `Key${latin[i].toUpperCase()}`;
        await field.evaluate((el, e) => el.dispatchEvent(new KeyboardEvent("keydown", { ...e, bubbles: true })), { key, code });
        await page.keyboard.insertText(key);
      }
      await page.getByText(/Showing results for.*smart session/).waitFor();
      await page.keyboard.press("Backspace");
      await page.getByText(/Showing results for.*smart sessio[”\u2069]/).waitFor();
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await page.getByText(/Showing results for.*smart sessio[”\u2069]/).waitFor({ state: "hidden" });
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      // Restore a trustworthy fresh sequence for the evidence image.
      await field.fill(""); await field.focus();
      for (const [i, key] of [...greek].entries()) {
        const code = latin[i] === " " ? "Space" : `Key${latin[i].toUpperCase()}`;
        await field.evaluate((el, e) => el.dispatchEvent(new KeyboardEvent("keydown", { ...e, bubbles: true })), { key, code });
        await page.keyboard.insertText(key);
      }
      await page.getByText(/Showing results for.*smart session/).waitFor();
    });
    return;
  }
  if (only.includes("menu-bounds")) return menuBoundsShots({ shoot });
  if (only.includes("feeds")) return checkFeeds({ seeded, call, cli, home });
  if (argv.includes("--whats-new-review")) return whatsNewReview({ shoot, seeded, plugin, home, cli, call });
  const billing = WORKSPACES.find(w => w.key === "billing");
  // Review evidence for Rename title with AI (not README images): the row menu item, the panel's More button and menu, the
  // dialog suggesting, ready, edited and failed, the toast with Undo and the Undo link; desktop and phone, dark and light.
  if (argv.includes("--rename-review")) {
    const mode = m => fs.writeFile(join(home, "claude-mode"), m);
    // One state can't hold the harness slot: each shot gets 90 s, then fails on its own and the run moves on.
    // --rename-only a,b: a subset of these shots (the rest are skipped).
    const pick = arg("--rename-only")?.split(",").map(x => x.trim());
    const bounded = async (name, ...rest) => {
      if (pick && !pick.includes(name)) return;
      let timer;
      const late = new Promise(r => { timer = setTimeout(() => { failures.push(`${name} (timed out)`); r(); }, 90_000); });
      try { await Promise.race([shoot(name, ...rest), late]); } finally { clearTimeout(timer); }
    };
    const billingId = seeded.workspaces.find(w => w.key === "billing").workspaceId;
    const rowMenuAt = async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click({ button: "right", position: { x: 160, y: 18 } });
      const menu = page.getByRole("menu", { name: "Actions for Billing retries" });
      await menu.getByRole("menuitem", { name: "Rename title with AI…" }).waitFor();
      return menu;
    };
    const dialog = (vp, wait) => async page => {
      await (await rowMenuAt(page)).getByRole("menuitem", { name: "Rename title with AI…" }).click();
      if (vp !== DESKTOP) await page.setViewportSize(vp);
      await wait(page);
    };
    const ready = page => page.getByRole("textbox", { name: "New name" }).last().evaluate(el => el.value.length > 0 || Promise.reject(new Error("empty"))).catch(async () => { await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="New name"]')].some(el => el.value)); });
    if (argv.includes("--rename-fixup-review")) {
      await mode("repair");
      for (const scheme of ["light", "dark"]) await bounded(`rename-fixed-${scheme}`, DESKTOP, scheme, dialog(DESKTOP, async page => {
        await ready(page);
        const name = await page.getByRole("textbox", { name: "New name" }).last().inputValue();
        if (name !== "Add backoff for soft card declines in billing") throw new Error("repairable model reply was not normalized");
        if (!await page.getByRole("button", { name: "Rename", exact: true }).last().isEnabled()) throw new Error("repaired suggestion cannot be renamed");
      }));
      await mode("unusable");
      for (const scheme of ["light", "dark"]) await bounded(`rename-editable-${scheme}`, DESKTOP, scheme, dialog(DESKTOP, async page => {
        await ready(page);
        await page.getByText("Use words, not a branch name.", { exact: true }).last().waitFor();
        if (await page.getByText("Couldn't suggest a name. Type one, or try again.", { exact: true }).count()) throw new Error("unusable model reply was shown as a provider failure");
        if (await page.getByRole("button", { name: "Rename", exact: true }).last().isEnabled()) throw new Error("an invalid candidate can bypass the name rule");
      }));
      return;
    }
    const panelOpen = async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: "More actions for this workspace" }).first().waitFor();
    };
    await bounded("rename-menu", DESKTOP, "dark", async page => { await rowMenuAt(page); });
    await bounded("rename-panel-header", DESKTOP, "light", async page => { await panelOpen(page); });
    await bounded("rename-panel-more", DESKTOP, "dark", async page => {
      await panelOpen(page);
      await page.getByRole("button", { name: "More actions for this workspace" }).first().click();
      await page.getByRole("menuitem", { name: "Rename title with AI…" }).waitFor();
    });
    await mode("slow");
    for (const [n, vp, sc] of [["rename-suggesting", DESKTOP, "dark"], ["rename-suggesting-phone-light", PHONE, "light"]])
      await bounded(n, vp, sc, dialog(vp, page => page.getByText("Suggesting a name…").last().waitFor()));
    // Let the slow replies drain from the job queue (one at a time) before the next state.
    await new Promise(r => setTimeout(r, 42000));
    await mode("fail");
    for (const [n, vp, sc] of [["rename-error", DESKTOP, "dark"], ["rename-error-phone-light", PHONE, "light"]])
      await bounded(n, vp, sc, dialog(vp, page => page.getByText(/Couldn't suggest a name/).last().waitFor()));
    await mode("ready");
    for (const [n, vp, sc] of [["rename-ready", DESKTOP, "dark"], ["rename-ready-light", DESKTOP, "light"], ["rename-ready-phone", PHONE, "dark"], ["rename-ready-phone-light", PHONE, "light"]])
      await bounded(n, vp, sc, dialog(vp, ready));
    await bounded("rename-invalid", DESKTOP, "dark", dialog(DESKTOP, async page => {
      await ready(page);
      await page.getByRole("textbox", { name: "New name" }).last().fill("feat/retry-soft-declines");
      await page.getByText("Use words, not a branch name.").last().waitFor();
    }));
    await bounded("rename-toast", DESKTOP, "dark", dialog(DESKTOP, async page => {
      await ready(page);
      await page.getByRole("button", { name: "Rename" }).last().click();
      await page.getByText(/^Renamed to Add APP-142 backoff for soft card declines/).last().waitFor();
      // The toast lasts 10 s (held under the pointer): shoot it now, with the pointer resting on it.
      await page.getByText(/^Renamed to Add APP-142/).last().hover();
      await page.screenshot({ path: join(out, "follow-up-rename-toast-live.png"), animations: "disabled", caret: "hide" });
    }));
    await bounded("rename-undo-link", DESKTOP, "light", async page => {
      await openHome(page);
      await (await homeRow(page, "Add APP-142 backoff for soft card declines")).click({ button: "right", position: { x: 160, y: 18 } });
      await page.getByRole("menuitem", { name: "Rename title with AI…" }).click();
      await page.getByRole("button", { name: "Undo last rename" }).last().waitFor();
      await page.getByText("Suggesting a name…").last().waitFor({ state: "detached" });
    });
    await call("follow.rename-workspace", { workspaceId: billingId, undo: true }).catch(error => log(`undo after review: ${error.message}`));
  }
  // The sort menu's footer (--sortfoot-review, Paseo 0.16): only when the ranking last ran. The ranker is turned on so
  // the menu has Re-rank now, with ranker.json's last run in the future so the schedule never calls a real model.
  // Never ran first (no priorities: "Not ranked yet"), then priorities set through the agent tool ("Ranked …"), on
  // the sidebar view's menu and on Home's. Everything is put back after.
  if (argv.includes("--sortfoot-review")) {
    const rankerFile = join(home, "plugin-data", "follow-up", "ranker.json");
    await fs.writeFile(rankerFile, JSON.stringify({ version: 1, lastHash: null, lastRunAt: "2099-01-01T00:00:00.000Z", lastModelAt: null, day: null, runsToday: 0, health: {}, notStarted: [], last: null, slackSince: null, planning: null, prev: {}, model: null }));
    const caller = seeded.workspaces.find(w => w.key === "audit").agentId;
    await actPlanned(call, caller, "set_display", { values: { enable_ranker: true } });
    const sidebarMenu = async page => {
      await page.goto(`${ORIGIN}/settings/sidebar`);
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      await openHome(page);
      const view = page.getByTestId("plugin-sidebar-view");
      await view.getByRole("button", { name: /^Sort: / }).first().click();
      await view.getByRole("menuitem", { name: /Re-rank now/ }).first().waitFor({ timeout: 60000 });
      return view;
    };
    const footer = async (scope, text) => { await scope.getByText(text).first().waitFor({ timeout: 30000 }); log(`sortfoot: footer reads "${await scope.getByText(text).first().textContent()}"`); };
    await shoot("sortfoot-never-ran-dark", SIDEBAR, "dark", async page => { await footer(await sidebarMenu(page), "Not ranked yet"); });
    await actPlanned(call, caller, "set_priorities", { priorities: [{ workspace: seeded.workspaces.find(w => w.key === "billing").workspaceId, score: 90, reason: "Declines are piling up" }, { workspace: seeded.workspaces.find(w => w.key === "csv").workspaceId, score: 70, reason: "Waiting on one answer" }], replace: true });
    await shoot("sortfoot-sidebar-light", SIDEBAR, "light", async page => { await footer(await sidebarMenu(page), /^Ranked /); });
    await shoot("sortfoot-home-dark", SIDEBAR, "dark", async page => {
      await openHome(page);
      // Home's own sort button, not the sidebar view's beside it.
      for (const b of await page.getByRole("button", { name: /^Sort: / }).all()) if (!await b.evaluate(e => !!e.closest('[data-testid="plugin-sidebar-view"]'))) { await b.click(); break; }
      await page.getByRole("menuitem", { name: /Re-rank now/ }).first().waitFor({ timeout: 30000 });
      await footer(page, /^Ranked /);
    });
    await actPlanned(call, caller, "set_display", { values: { enable_ranker: false } });
    await fs.rm(rankerFile, { force: true });
  }
  // Section search (--secsearch-review, Paseo 0.16): the panel's Pull requests, Tasks and Activity searched in place, on
  // Billing retries with five more tasks (three done, so the "done" fold holds them). Each section light and dark (the
  // other cards show the icon at rest), a no-match, and the phone (the larger view at 390) in light.
  if (argv.includes("--secsearch-review")) {
    const ws = seeded.workspaces.find(w => w.key === "billing");
    const tasks = [
      ["Backfill retry_count for open invoices", "pending", ""],
      ["Watch the dunning email bounce rate for a week", "waiting", ""],
      ["Cap retries at four attempts", "done", "Retries stop after the fourth charge attempt, and the dunning email goes out after it."],
      ["Log each retry with the invoice id", "done", "Every retry writes the invoice id and the attempt number to the billing log."],
      ["Skip retries for hard declines", "done", "stolen_card and lost_card go straight to the dunning email; only soft declines retry."],
    ];
    for (const [title, status, evidence] of tasks) await call("follow.obligation", { agentId: ws.agentId, title, status, ...(evidence ? { evidence } : {}) });
    const panel = async page => {
      await openChat(page, billing.title, billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor({ timeout: 60000 });
    };
    /** Opens a section's search, types the query, and brings that card to the top of the panel. */
    const searchIn = (placeholder, query, wait) => async page => {
      await page.getByRole("button", { name: placeholder, exact: true }).last().click();
      const field = page.getByPlaceholder(placeholder).last();
      await field.fill(query);
      await wait(page);
      await field.evaluate(el => el.scrollIntoView({ block: "center" }));
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    const tasksDunning = searchIn("Search tasks", "dunning", page => page.getByText(/^Evidence · /).last().waitFor());
    const shots = [
      ["secsearch-tasks", "light", async page => { await panel(page); await tasksDunning(page); }],
      ["secsearch-tasks", "dark", async page => { await panel(page); await tasksDunning(page); }],
      // A merged PR from the "merged below" fold, found by its title.
      ["secsearch-prs", "light", async page => { await panel(page); await searchIn("Search pull requests", "schedule", p => p.getByText("1 of 3").last().waitFor())(page); }],
      // A failing check's name: line 2 becomes "Check · test".
      ["secsearch-prs", "dark", async page => { await panel(page); await searchIn("Search pull requests", "test", p => p.getByText(/^Check · /).last().waitFor())(page); }],
      ["secsearch-activity", "light", async page => { await panel(page); await searchIn("Search activity", "declined", p => p.getByRole("tab", { name: /^Questions, 1/ }).last().waitFor())(page); }],
      ["secsearch-activity-questions", "dark", async page => {
        await panel(page);
        await searchIn("Search activity", "declined", p => p.getByRole("tab", { name: /^Questions, 1/ }).last().waitFor())(page);
        await page.getByRole("tab", { name: /^Questions, 1/ }).last().click();
        await page.getByRole("button", { name: /^Q1, Retry declined cards\?/ }).last().waitFor();
      }],
      ["secsearch-nomatch", "dark", async page => { await panel(page); await searchIn("Search tasks", "zebra", p => p.getByText("No tasks match ‘zebra’").last().waitFor())(page); }],
    ];
    for (const [name, scheme, drive] of shots) await shoot(`${name}-${scheme}`, DESKTOP, scheme, drive);
    await shoot("secsearch-phone-light", PHONE, "light", async page => {
      await panel(page);
      await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await page.getByRole("button", { name: "Search tasks", exact: true }).last().waitFor({ timeout: 60000 });
      await page.setViewportSize(PHONE);
      await tasksDunning(page);
      if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("secsearch-phone scrolls sideways");
    });
  }
  // GitHub limit low (--github-wait-review): the account's GraphQL budget under Follow-up's 20 % reserve, so its PR
  // reads wait for the reset and the panel's Pull requests card says until when (Workspace.githubWait). Billing retries'
  // panel, desktop light and dark, and the larger view at 390 light and dark.
  if (argv.includes("--github-wait-review")) {
    const fixture = join(home, "gh-fixture.json");
    const clock = JSON.parse(await fs.readFile(clockFile, "utf8"));
    const resetAt = new Date(Math.max(clock.fake + (Date.now() - clock.real) * clock.rate, BASE + VIEW) + 25 * 60_000).toISOString();
    const d = JSON.parse(await fs.readFile(fixture, "utf8"));
    await fs.writeFile(fixture, JSON.stringify({ ...d, _rate: { cost: 1, remaining: 640, limit: 5000, resetAt } }));
    const panel = async page => {
      await openChat(page, billing.title, billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByText(/^GitHub limit low · updates again at /).last().waitFor({ timeout: 90000 });
    };
    for (const scheme of ["light", "dark"]) await shoot(`github-wait-${scheme}`, DESKTOP, scheme, async page => {
      await panel(page);
      await page.getByText(/^GitHub limit low/).last().evaluate(el => el.scrollIntoView({ block: "center" }));
    });
    for (const scheme of ["light", "dark"]) await shoot(`github-wait-phone-${scheme}`, PHONE, scheme, async page => {
      await panel(page);
      await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await page.setViewportSize(PHONE);
      const line = page.getByText(/^GitHub limit low/).last();
      await line.waitFor({ timeout: 60000 });
      await line.evaluate(el => el.scrollIntoView({ block: "center" }));
      if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("github-wait-phone scrolls sideways");
    });
    await fs.writeFile(fixture, JSON.stringify(d));
  }
  // The filter's ranking (--rank-review, Paseo 0.16): two workspaces renamed so "staging" is in their titles, while it
  // stays in other rows' second lines (Search filters' permission, SSO login's next step). Inside each group the title
  // matches come first, in the list's order; the second-line matches follow. Renames are undone after.
  if (argv.includes("--rank-review")) {
    const renamed = [["webhooks", "Webhook signing on staging"], ["email", "Staging onboarding email"]]
      .map(([key, title]) => ({ id: seeded.workspaces.find(w => w.key === key).workspaceId, title }));
    for (const r of renamed) await call("follow.rename-workspace", { workspaceId: r.id, title: r.title });
    for (const scheme of ["light", "dark"]) {
      await shoot(`rank-filter-${scheme}`, SIDEBAR, scheme, async page => {
        await page.goto(`${ORIGIN}/settings/sidebar`);
        await page.getByText("Default view", { exact: true }).first().click();
        await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
        await openHome(page);
        const view = page.getByTestId("plugin-sidebar-view");
        await view.getByRole("button", { name: /^Staging onboarding email/ }).first().waitFor({ timeout: 60000 });
        await view.getByPlaceholder("Filter workspaces").fill("staging");
        await view.getByRole("button", { name: /^SSO login/ }).first().waitFor();
        const order = await view.getByRole("button", { name: /^(Webhook signing on staging|Staging onboarding email|Search filters|SSO login)/ }).evaluateAll(els => els.map(e => (e.getAttribute("aria-label") ?? "").split(".")[0]));
        log(`rank: filter "staging" draws ${order.join(" · ")}`);
      });
    }
    for (const r of renamed) await call("follow.rename-workspace", { workspaceId: r.id, undo: true }).catch(error => log(`undo after rank review: ${error.message}`));
  }
  // Review evidence for the sidebar view's row menu (Paseo 0.16+, HARNESS_PASEO=0.16): Follow-up's view picked in
  // Settings → Sidebar, then a row's menu from a right-click and from Shift+F10; dark and light. On a host without
  // sidebar views this fails at "Follow-up: Needs you" (the option doesn't exist).
  if (argv.includes("--sidebar-review")) {
    const sidebarRow = async page => {
      await page.goto(`${ORIGIN}/settings/sidebar`);
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      await openHome(page);
      const view = page.getByTestId("plugin-sidebar-view");
      const row = view.getByRole("button", { name: /^Billing retries/ }).first();
      await row.waitFor();
      return { view, row };
    };
    const menuOpen = page => page.getByRole("menu", { name: "Actions for Billing retries" }).getByRole("menuitem", { name: "Rename title with AI…" }).waitFor();
    // --rename-only also picks among these (sidebar-menu-click-dark, sidebar-menu-key-light, …).
    const pick = arg("--rename-only")?.split(",").map(x => x.trim());
    const pickShot = (name, ...rest) => !pick || pick.includes(name) ? shoot(name, ...rest) : undefined;
    for (const scheme of ["dark", "light"]) {
      await pickShot(`sidebar-menu-click-${scheme}`, DESKTOP, scheme, async page => {
        const { row } = await sidebarRow(page);
        await row.click({ button: "right", position: { x: 60, y: 12 } });
        await menuOpen(page);
        // Ask the Overseer needs Home's omnibox, so it isn't in this menu at all.
        if (await page.getByRole("menuitem", { name: /Ask the Overseer/ }).count()) throw new Error("Ask the Overseer shown in the sidebar view");
      });
      await pickShot(`sidebar-menu-key-${scheme}`, DESKTOP, scheme, async page => {
        const { row } = await sidebarRow(page);
        await row.focus();
        await page.keyboard.press("Shift+F10");
        await menuOpen(page);
      });
    }
  }
  // Review evidence for the Overseer row in the sidebar view (Paseo 0.16+, HARNESS_PASEO=0.16): real states, set up
  // the way a developer gets them. Start is the fixture's own (on, never started); asks is the started Overseer asking a
  // decision (its fixture script calls needs_you); error is a restart that failed (overseer.json's error, as
  // server/overseer.ts saves it). Dense desktop, touch, and a filter that keeps the row and marks its match.
  // The keyboard walk (--keys-review, Paseo 0.16): real key presses. Home's selection follows ↑/↓ with the focus ring on
  // it; in the sidebar view the ring moves alone and Enter opens the chat, which then wears the selected row.
  if (argv.includes("--keys-review")) {
    const keysView = async page => {
      await page.goto(`${ORIGIN}/settings/sidebar`);
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      await openHome(page);
      const view = page.getByTestId("plugin-sidebar-view");
      await view.getByRole("button", { name: /^Contact import/ }).first().waitFor({ timeout: 60000 });
      page.keepFocus = true;
      return view;
    };
    // The focused row, by name and surface (Home and the sidebar view draw the same rows side by side).
    const ringOn = async (page, name, where) => page.waitForFunction(([n, w]) => { const a = document.activeElement; return !!a && a.matches(":focus-visible") && (a.getAttribute("aria-label") ?? "").startsWith(n)
      && !!a.closest('[data-testid="plugin-sidebar-view"]') === (w === "sidebar"); }, [name, where], { timeout: 15000 });
    for (const scheme of ["light", "dark"]) {
      // Home, nothing focused: ↓ three times walks brief → Overseer → Search filters → Contact import; its detail follows.
      await shoot(`keys-home-${scheme}`, SIDEBAR, scheme, async page => {
        await keysView(page);
        await page.evaluate(() => (document.activeElement)?.blur?.());
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
        await ringOn(page, "Contact import", "home");
      });
      // The sidebar view: ↓ from the filter enters the list, Enter opens Contact import's chat, then j moves the ring on.
      await shoot(`keys-sidebar-${scheme}`, SIDEBAR, scheme, async page => {
        const view = await keysView(page);
        await view.getByPlaceholder("Filter workspaces").click();
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
        await ringOn(page, "Contact import", "sidebar");
        await page.keyboard.press("Enter");
        await page.getByText("WEB-38: import contacts", { exact: false }).first().waitFor();
        await page.waitForTimeout(2500);
        // Where Paseo leaves focus after opening a chat from a plugin sidebar row (the PR text reports this line).
        const after = await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? "body" : `${a.tagName.toLowerCase()} ${a.getAttribute("aria-label") ?? a.getAttribute("placeholder") ?? ""}${a.closest('[data-testid="plugin-sidebar-view"]') ? " (sidebar view)" : ""}`; });
        log(`keys: focus after Enter opened the chat: ${after}`);
        // On the row: j walks on. Elsewhere (the composer keeps it): ↓ from the filter re-enters the list at its top.
        if (after.endsWith("(sidebar view)")) await page.keyboard.press("j");
        else { await view.getByPlaceholder("Filter workspaces").click(); for (const key of ["ArrowDown", "j", "j", "j"]) await page.keyboard.press(key); }
        await ringOn(page, "Billing retries", "sidebar");
      });
    }
    // With the filter on, ↓ enters at the first match.
    await shoot("keys-sidebar-filter-dark", SIDEBAR, "dark", async page => {
      const view = await keysView(page);
      await view.getByPlaceholder("Filter workspaces").fill("retries");
      await view.getByRole("button", { name: /^Billing retries/ }).first().waitFor();
      await page.keyboard.press("ArrowDown");
      await ringOn(page, "Billing retries", "sidebar");
    });
  }
  if (argv.includes("--overseer-review")) {
    const sidebarView = async (page, line, touch) => {
      await page.goto(`${ORIGIN}/settings/sidebar`);
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      await openHome(page);
      if (touch) {
        await page.setViewportSize(PHONE);
        // Paseo's phone layout: back to its start screen, whose menu button (same corner) opens the sidebar drawer.
        const back = page.getByRole("button", { name: /^(back|go back|open (menu|sidebar|navigation)|menu)$/i }).first();
        if (await back.count()) await back.click(); else await page.mouse.click(34, 36);
        await page.waitForTimeout(500);
        await page.mouse.click(34, 36);
      }
      const view = page.getByTestId("plugin-sidebar-view");
      await view.getByRole("button", { name: new RegExp(`^Overseer\\. ${line}`) }).first().waitFor({ timeout: 60000 });
      return view;
    };
    await shoot("sidebar-overseer-start-light", SIDEBAR, "light", async page => { await sidebarView(page, "Ask about any workspace or agent\\. Start it once", false); });
    const started = await call("follow.overseer-start", {});
    const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8"));
    const ask = "Ship the billing retries before the invoice PDFs?";
    scripts[`agent:${started.agentId}`] = [{ rpc: "follow.needs-you", input: { kind: "decision", ask,
      decisions: [{ question: ask, options: [{ label: "Billing retries first" }, { label: "Invoice PDFs first" }], recommend: 0 }] } }];
    await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
    await call("follow.overseer-ask", { text: "Which ships first, billing retries or the invoice PDFs?" });
    // The ask lands in the Overseer's inbox entry when its turn ends. Then step the crawling clock past the inbox list's
    // freshness window (LIST_FRESH_MS, 3 s), so the list re-reads Paseo's agents and carries the new Overseer agent.
    const inboxFile = join(home, "plugin-data", "follow-up", "inbox.json");
    for (let i = 0; !(await fs.readFile(inboxFile, "utf8").catch(() => "")).includes(ask); i++) { if (i > 120) throw new Error("the Overseer's ask never reached the inbox"); await new Promise(r => setTimeout(r, 250)); }
    await setDaemonClock(BASE + VIEW + 10_000);
    for (const scheme of ["light", "dark"]) await shoot(`sidebar-overseer-asks-${scheme}`, SIDEBAR, scheme, async page => { await sidebarView(page, "Asks you", false); });
    await shoot("sidebar-overseer-asks-touch-light", DESKTOP, "light", async page => { await sidebarView(page, "Asks you", true); });
    // "billing" is in the Overseer's ask: the row stays, its match marked like Billing retries' title.
    await shoot("sidebar-overseer-filter-kept-dark", SIDEBAR, "dark", async page => {
      const view = await sidebarView(page, "Asks you", false);
      await view.getByPlaceholder("Filter workspaces").fill("billing");
      await view.getByRole("button", { name: /^Billing retries/ }).first().waitFor();
      await view.getByRole("button", { name: /^Overseer\. / }).first().waitFor();
    });
    const file = join(home, "plugin-data", "follow-up", "overseer.json");
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), error: "the agent was archived" }));
    await shoot("sidebar-overseer-error-dark", SIDEBAR, "dark", async page => { await sidebarView(page, "Couldn't bring it back", false); });
  }
  if (only.includes("gallery") || only.includes("frames")) await galleryShots({ shoot, call, home, billing });
  for (const name of [...SHOTS, "local-titles"]) {
    if (!only.includes(name) || name === "setup") continue;
    if (name === "home") await shoot("home", DESKTOP, "dark", async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click();
      await page.getByText("Only network failures").first().waitFor();
    });
    // Paseo 0.16's sidebar with Follow-up in it (each workspace's status and subline, the Needs-you badge), cropped
    // to the sidebar plus the edge of Home. 0.15 has no workspace rows to decorate; Follow-up feature-detects 0.16.
    if (name === "sidebar") await shoot("sidebar", SIDEBAR, "dark", async page => {
      await openHome(page);
      await homeRow(page, "Billing retries");
      // Settings → Sidebar → View → Follow-up's, as a developer picks it.
      await page.getByRole("button", { name: /^Settings$/i }).last().click();
      await page.getByText("Sidebar", { exact: true }).first().click();
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      // Escape closes the picker and then Settings; Back is there only if Settings is still open.
      await page.keyboard.press("Escape").catch(() => {});
      const back = page.getByText("Back", { exact: true }).first();
      if (await back.isVisible().catch(() => false)) await back.click();
      const view = page.getByTestId("plugin-sidebar-view");
      await view.getByText("Billing retries").first().waitFor();
      // Tall enough for every group down to Quiet, so nothing reads as cut off. A row opens its workspace's chat beside
      // it: the context, and a near-square frame that still reads when a chat app scales it down.
      await page.setViewportSize(SIDEBAR);
      await view.getByText("Billing retries").first().click();
      await page.getByText("Only network failures").first().waitFor();
      return null;
    }, { scale: 2 });
    if (name === "panel") await shoot("panel", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor();
      await checkNeedDot(page);
    });
    // Repairs (Q49, Q141): Onboarding email's PR #160 has a conflict and review threads. With Auto on, the strip
    // says who gets the next message, when and why; the crawling clock keeps it inside the settle, so nothing sends.
    if (name === "tasks" || name === "tasks-sheet" || name === "tasks-phone") {
      const email = seeded.workspaces.find(w => w.key === "email");
      await call("follow.control", { workspaceId: email.workspaceId, enable_auto_sends: true });
      const spec = WORKSPACES.find(w => w.key === "email");
      const open = async page => {
        await openChat(page, spec.title, spec.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        const strip = page.getByText(/^Next message to /).first();
        await strip.waitFor({ timeout: 60000 });
        await strip.scrollIntoViewIfNeeded();
      };
      if (name === "tasks") await shoot("tasks", DESKTOP, "dark", open);
      if (name === "tasks-sheet") await shoot("tasks-sheet", DESKTOP, "dark", async page => {
        await open(page);
        await page.getByRole("button", { name: /^Repair: Resolve merge conflicts/ }).first().click();
        await page.getByText("Next message", { exact: true }).last().waitFor();
      });
      // Phones see a workspace's Tasks in the larger view (a Paseo screen; Home's phone focus view has no Tasks):
      // open it from the panel at desktop size, then narrow to the phone.
      if (name === "tasks-phone") await shoot("tasks-phone", PHONE, "light", async page => {
        await open(page);
        await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
        await page.getByText(/^Next message to /).last().waitFor({ timeout: 60000 });
        await page.setViewportSize(PHONE);
        const strip = page.getByText(/^Next message to /).last();
        await strip.waitFor({ timeout: 60000 });
        await strip.evaluate(el => el.scrollIntoView({ block: "center" }));
        if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("tasks-phone scrolls sideways");
      });
    }
    if (name === "questions") await shoot("questions", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("tab", { name: /^Questions/ }).first().click();
      await page.getByRole("button", { name: /^Q1,/ }).first().click();
      await page.getByText("Retry card_declined once after 24 hours").last().click();
      await page.getByRole("button", { name: "Add a note for the agent about Q1", exact: true }).last().click();
      await page.getByPlaceholder(/note for the agent/i).last().fill("Only for soft declines. Hard declines still go straight to dunning.");
      await page.getByText("Should charges that fail with card_declined retry").last().waitFor();
    });
    if (name === "pill") await shoot("pill", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: /^Follow-up · / }).last().click();
      await page.getByText("fail with card_declined retry").last().waitFor();
    });
    if (name === "pr-sheet") await shoot("pr-sheet", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: /^Pull request 142: / }).first().click();
      await page.getByText("Pull request #142").first().waitFor();
      await page.getByText(/check.*failed.*test/i).first().waitFor();
    });
    if (name === "phone") await shoot.side("phone", "light", [
      { viewport: PHONE, drive: async page => { await openHome(page); await page.setViewportSize(PHONE); await homeRow(page, "Billing retries"); } },
      { viewport: PHONE, drive: async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, "Billing retries")).click(); await page.getByText("Only network failures").first().waitFor(); await clearDock(page, "Only network failures", "Sign off"); } },
    ]);
    if (name === "linked-items") await shoot("linked-items", DESKTOP, "dark", async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click();
      await page.getByRole("button", { name: /^Linked: / }).first().click();
      const sheet = page.getByRole("dialog").last();
      await sheet.getByText("Retry failed charges with exponential backoff").first().waitFor();
      await sheet.getByText("#billing: which declines are soft?").first().waitFor();
      await sheet.getByText("Added by you").first().waitFor();
      // Desktop focuses the filter field once the sheet opens; wait for it, so capture's blur clears the focus ring.
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Filter, or paste a link or key");
    });
    if (name === "local-titles") {
      await shoot("local-titles-spec", DESKTOP, "dark", async page => {
        await openHome(page);
        await (await homeRow(page, "Billing retries")).click();
        await page.getByRole("link", { name: "Open the spec: Charge retry spec" }).first().waitFor();
      });
      await shoot("local-titles-linked", DESKTOP, "dark", async page => {
        await openHome(page);
        await (await homeRow(page, "Billing retries")).click();
        await page.getByRole("button", { name: /^Linked: / }).first().click();
        const sheet = page.getByRole("dialog").last();
        await sheet.getByText("Retry rollout checklist", { exact: true }).waitFor();
        await sheet.getByText("Claude artifact", { exact: true }).waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Filter, or paste a link or key");
      });
    }
    // The 2.0.0 notes' two images (What's new and the GitHub page): the same scenes as home and panel, cropped to what
    // a ~500px sheet can show legibly. Home without Paseo's own sidebar; the panel at its real width (320), its head (tab,
    // status line, stack bar, Auto-send) and the question card under it. Shoot notes-panel with --scale 3: the sheet and
    // the GitHub page draw it at most 320 wide (#WxH), so it stays sharp and never larger than the UI.
    // The rectangles are CSS pixels of the 1440x900 DESKTOP viewport. CHANGELOG.md pins them to a commit, never main.
    if (name === "notes-home") await shoot("notes-home", DESKTOP, "dark", async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click();
      await page.getByText("Only network failures").first().waitFor();
      return { x: 320, y: 0, width: 1120, height: 680 };
    }, { scale: 2 });
    if (name === "notes-panel") await shoot("notes-panel", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor();
      // A taller window shows more of the panel; it stays 320 CSS px wide (its real width at 1440), shot at 3x.
      await page.setViewportSize({ width: DESKTOP.width, height: 1400 });
      await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor();
      return { x: 1120, y: 0, width: 320, height: Number(process.env.NOTES_PANEL_HEIGHT ?? 910) };
    }, { scale: 3 });
    if (name === "whats-new") {
      // The packed copy Paseo runs: the path its plugin list reports (the unpacked folder for a directory install).
      const installed = (await cli("plugin", "ls")).find(row => row.id === "follow-up")?.path ?? plugin;
      const pkgPath = join(installed, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      const changelog = await whatsNewChangelog();
      const stables = whatsNewStables(changelog);
      // The update case: the newest stable over the one before it. The sheet lists every stable, so OLDER is a version
      // a scroll down (the scrolled shots) and PENDING a made-up next minor the updater offers (the Installed pill
      // sits under it). Synthetic: the notes say nothing about any real release.
      [WHATS_NEW_TO, WHATS_NEW_FROM] = stables;
      const older = stables[Math.min(3, stables.length - 1)];
      await fs.writeFile(pkgPath, JSON.stringify({ ...pkg, version: WHATS_NEW_TO }, null, 2));
      await fs.writeFile(join(installed, "CHANGELOG.md"), changelog);
      await fs.writeFile(join(home, "plugin-data/follow-up/versions.json"), JSON.stringify({ running: WHATS_NEW_FROM, previous: null, startedAt: null, hostSeen: WHATS_NEW_FROM }));
      await cli("plugin", "reload", "follow-up");
      let seenVersion = null;
      await until(() => `the ${WHATS_NEW_TO} worker (it reports ${seenVersion})`, async () => (seenVersion = (await call("follow.release-notes", {}).catch(e => ({ version: `error: ${e.message.split("\n")[0]}` }))).version) === WHATS_NEW_TO, { tries: 120, every: 500 });
      const header = version => page => page.getByRole("heading", { name: new RegExp(`^${version.replace(/\./g, "\\.")}(,|$)`) }).last();
      const sheet = phone => async page => {
        await openHome(page, { keepDialogs: true });
        if (phone) await page.setViewportSize(PHONE);
        await page.getByText("What's new in Follow-up", { exact: true }).last().waitFor();
        await header(WHATS_NEW_TO)(page).waitFor();
        // It opens at the newest version, with the Installed pill on it.
        if (!/, installed,/.test(await header(WHATS_NEW_TO)(page).getAttribute("aria-label") ?? "")) throw new Error(`${WHATS_NEW_TO} is not marked installed`);
        // The notes' screenshots load by URL: wait until each has loaded or failed (a failed one is left out).
        await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
      };
      /** The same sheet scrolled so `version`'s header row is at the top: an older version, a scroll away. */
      const sheetAt = (phone, version) => async page => {
        await sheet(phone)(page);
        // Scroll only the notes' own body (scrollIntoView would move the phone's sheet too), leaving a little air above.
        await header(version)(page).evaluate(el => {
          const scroller = el.closest("[data-follow-up-notes-scroll]");
          if (!scroller) throw new Error("the version header is outside the notes' scroll body");
          scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
        });
        await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
      };
      /**
       * Settings → General's Release notes with an update out: the updater's pending notes (a demo override, read when
       * Settings loads the updates view) sit above the installed version, which keeps the Installed pill.
       */
      const PENDING = (() => { const [major, minor] = WHATS_NEW_TO.split(".").map(Number); return `${major}.${minor + 1}.0`; })();
      const pendingAt = phone => async page => {
        // Settings → Plugins → Follow-up → General → Release notes, See all (as --notes-review's releaseNotesAt).
        if (phone) await page.setViewportSize(PHONE);
        await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/projects`);
        // The phone lists Follow-up's settings tabs first: open General, whose card holds Release notes.
        const seeAll = page.getByRole("button", { name: "See all" }).filter({ visible: true }).first();
        const general = page.getByText("General", { exact: true }).filter({ visible: true }).last();
        await seeAll.or(general).first().waitFor({ state: "visible" });
        if (phone && !(await seeAll.isVisible())) await general.click();
        await seeAll.click();
        await header(PENDING)(page).waitFor();
        if (/installed/.test(await header(PENDING)(page).getAttribute("aria-label") ?? "")) throw new Error(`${PENDING} is pending, not installed`);
        if (!/, installed,/.test(await header(WHATS_NEW_TO)(page).getAttribute("aria-label") ?? "")) throw new Error(`${WHATS_NEW_TO} lost its Installed pill`);
        await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
      };
      /** The same sheet scrolled to its end: the last section and the credits. */
      const sheetEnd = phone => async page => {
        await sheet(phone)(page);
        // The phone's bottom sheet has no dialog role: wheel over the middle of the screen, where the sheet's body is.
        const box = await page.getByRole("dialog").last().boundingBox({ timeout: 3000 }).catch(() => null);
        const vp = page.viewportSize();
        await page.mouse.move(box ? box.x + box.width / 2 : vp.width / 2, box ? box.y + box.height / 2 : vp.height * 0.6);
        for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 1200);
        await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
      };
      await shoot("whats-new", DESKTOP, "dark", sheet(false), { seen: WHATS_NEW_FROM });
      // Review evidence for the sheet itself (not README images): light and dark, desktop and the phone's bottom sheet;
      // the update case, an older version a scroll down, the end, and the Installed pill under an update that's out.
      if (argv.includes("--whats-new-all")) {
        await shoot("whats-new-light", DESKTOP, "light", sheet(false), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone", PHONE, "light", sheet(true), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone-dark", PHONE, "dark", sheet(true), { seen: WHATS_NEW_FROM });
        for (const [scheme, sfx] of [["dark", ""], ["light", "-light"]]) {
          await shoot(`whats-new-older${sfx}`, DESKTOP, scheme, sheetAt(false, older), { seen: WHATS_NEW_FROM });
          await shoot(`whats-new-phone-older${sfx}`, PHONE, scheme, sheetAt(true, older), { seen: WHATS_NEW_FROM });
        }
        await shoot("whats-new-end", DESKTOP, "dark", sheetEnd(false), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone-end", PHONE, "light", sheetEnd(true), { seen: WHATS_NEW_FROM });
        await fs.writeFile(join(home, "plugin-data/follow-up/updates-demo.json"), JSON.stringify({ pendingNotes: [{ version: PENDING, date: "2026-11-30", items: [
          "**A made-up next release:** stands in for an update that is out but not installed.",
          "**The Installed pill stays on yours:** the versions above it are what the update brings.",
        ] }] }));
        for (const [scheme, sfx] of [["dark", ""], ["light", "-light"]]) {
          await shoot(`whats-new-pending${sfx}`, DESKTOP, scheme, pendingAt(false), { seen: WHATS_NEW_TO });
          await shoot(`whats-new-phone-pending${sfx}`, PHONE, scheme, pendingAt(true), { seen: WHATS_NEW_TO });
        }
        await fs.rm(join(home, "plugin-data/follow-up/updates-demo.json"), { force: true });
      }
      // Review evidence for the notes dialog (one reading column at every window size) and the image viewer, both entry points.
      if (argv.includes("--notes-review")) {
        const BIG = { width: 2560, height: 1440 }; const NARROW = { width: 1180, height: 800 };
        const HOME_ALT = /^Follow-up Home: every workspace/; const PANEL_ALT = /^The Follow-up panel on a workspace/;
        const images = page => page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
        const whatsNewAt = vp => async page => {
          await openHome(page, { keepDialogs: true });
          await page.setViewportSize(vp);
          await page.getByText("What's new in Follow-up", { exact: true }).last().waitFor();
          await images(page);
        };
        /** Settings → Plugins → Follow-up → General → Release notes, See all. */
        const releaseNotesAt = vp => async page => {
          await page.setViewportSize(vp);
          await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/projects`);
          await page.getByRole("button", { name: "See all" }).first().click();
          await page.getByText("What's new in Follow-up", { exact: true }).last().waitFor();
          await images(page);
        };
        const viewer = (base, alt) => async page => {
          await base(page);
          await page.getByRole("button", { name: alt }).first().click();
          await page.getByRole("button", { name: "Close image" }).waitFor();
          await images(page);
          // The viewer covers the window, not the dialog: its X sits in the window's top-right corner.
          const x = await page.getByRole("button", { name: "Close image" }).boundingBox(); const vp = page.viewportSize();
          if (!x || x.x + x.width < vp.width - 24 || x.y > 24) throw new Error(`the viewer is boxed in: its X is at ${JSON.stringify(x)} in ${vp.width}x${vp.height}`);
        };
        /** The notes' scroll container carries the scoped scrollbar style and shows a bar at rest (it takes width). */
        const scrollbar = async page => {
          const r = await page.evaluate(() => { const el = document.querySelector("[data-follow-up-notes-scroll]"); if (!el) return null; const s = getComputedStyle(el); return { gutter: el.offsetWidth - el.clientWidth, overflows: el.scrollHeight > el.clientHeight, styled: !!document.getElementById("follow-up-notes-scrollbar")?.textContent?.includes("::-webkit-scrollbar"), overflowY: s.overflowY }; });
          if (!r || !r.styled || !r.overflows || r.gutter < 8) throw new Error(`the notes' scrollbar is not showing at rest: ${JSON.stringify(r)}`);
        };
        /** Esc closes the viewer, then the notes; a click on the viewer closes it. Throws (a failed shot) if not. */
        const escOrder = base => async page => {
          await viewer(base, HOME_ALT)(page);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Close image" }).waitFor({ state: "detached", timeout: 3000 });
          if (!(await page.getByRole("button", { name: HOME_ALT }).first().isVisible())) throw new Error("Esc closed the notes along with the viewer");
          const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
          if (!/^Follow-up Home/.test(focused)) throw new Error(`focus did not return to the screenshot (it is on "${focused}")`);
          await page.getByRole("button", { name: HOME_ALT }).first().click();
          await page.getByRole("button", { name: "Close image" }).waitFor();
          await page.mouse.click(20, 20);
          await page.getByRole("button", { name: "Close image" }).waitFor({ state: "detached", timeout: 3000 });
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: HOME_ALT }).first().waitFor({ state: "detached", timeout: 3000 });
        };
        const viewerOnly = argv.includes("--viewer-only");
        if (argv.includes("--scrollbar-only")) {
          for (const scheme of ["dark", "light"]) {
            const sfx = scheme === "light" ? "-light" : "";
            await shoot(`notes-1440${sfx}`, DESKTOP, scheme, async page => { await whatsNewAt(DESKTOP)(page); await scrollbar(page); }, { seen: WHATS_NEW_FROM });
            await shoot(`release-notes-1440${sfx}`, DESKTOP, scheme, async page => { await releaseNotesAt(DESKTOP)(page); await scrollbar(page); }, { seen: WHATS_NEW_TO });
          }
          await shoot("notes-1180", NARROW, "dark", async page => { await whatsNewAt(NARROW)(page); await scrollbar(page); }, { seen: WHATS_NEW_FROM });
          return;
        }
        for (const scheme of viewerOnly ? [] : ["dark", "light"]) {
          const sfx = scheme === "light" ? "-light" : "";
          await shoot(`notes-2560${sfx}`, BIG, scheme, whatsNewAt(BIG), { seen: WHATS_NEW_FROM });
          await shoot(`notes-1440${sfx}`, DESKTOP, scheme, async page => { await whatsNewAt(DESKTOP)(page); await scrollbar(page); }, { seen: WHATS_NEW_FROM });
          await shoot(`release-notes-2560${sfx}`, BIG, scheme, releaseNotesAt(BIG), { seen: WHATS_NEW_TO });
          await shoot(`release-notes-1440${sfx}`, DESKTOP, scheme, async page => { await releaseNotesAt(DESKTOP)(page); await scrollbar(page); }, { seen: WHATS_NEW_TO });
          await shoot(`notes-phone${sfx}`, PHONE, scheme, sheet(true), { seen: WHATS_NEW_FROM });
          await shoot(`viewer-2560${sfx}`, BIG, scheme, viewer(whatsNewAt(BIG), HOME_ALT), { seen: WHATS_NEW_FROM });
          await shoot(`viewer-phone${sfx}`, PHONE, scheme, viewer(sheet(true), PANEL_ALT), { seen: WHATS_NEW_FROM });
        }
        if (viewerOnly) for (const scheme of ["dark", "light"]) {
          const sfx = scheme === "light" ? "-light" : "";
          await shoot(`viewer-2560${sfx}`, BIG, scheme, viewer(whatsNewAt(BIG), HOME_ALT), { seen: WHATS_NEW_FROM });
          await shoot(`viewer-phone${sfx}`, PHONE, scheme, viewer(sheet(true), PANEL_ALT), { seen: WHATS_NEW_FROM });
        }
        await shoot("viewer-1440-panel", DESKTOP, "dark", viewer(whatsNewAt(DESKTOP), PANEL_ALT), { seen: WHATS_NEW_FROM });
        await shoot("viewer-release-notes-1440", DESKTOP, "dark", viewer(releaseNotesAt(DESKTOP), HOME_ALT), { seen: WHATS_NEW_TO });
        // A narrower window: the same dialog, with the viewer inside its focus scope.
        if (!viewerOnly) await shoot("notes-1180", NARROW, "dark", whatsNewAt(NARROW), { seen: WHATS_NEW_FROM });
        await shoot("viewer-1180", NARROW, "dark", viewer(whatsNewAt(NARROW), HOME_ALT), { seen: WHATS_NEW_FROM });
        await shoot("esc-order-1440", DESKTOP, "dark", escOrder(whatsNewAt(DESKTOP)), { seen: WHATS_NEW_FROM });
        await shoot("esc-order-1180", NARROW, "dark", escOrder(whatsNewAt(NARROW)), { seen: WHATS_NEW_FROM });
      }
    }
  }
  if (only.includes("review-mode")) await reviewModeShots({ shoot, call });
  if (only.includes("deploy-check")) await deployCheckShots({ shoot, call });
  if (only.includes("pr-link")) await prLinkShots({ shoot, billing });
  if (only.includes("merge-click")) await mergeClickShots({ shoot, billing });
  if (only.includes("reviewers-click")) await reviewersClickShots({ shoot });
  if (only.includes("catch-up")) await catchUpShots({ shoot, call, out });
  if (only.includes("dictation")) await dictationShots({ shoot });
  if (only.includes("icon")) await iconShots({ shoot, billing });
  if (only.includes("split")) await splitShots({ shoot, seeded, call, out });
  if (only.includes("settings-tabs")) await settingsTabsShots({ shoot, out });
  if (only.includes("morning-brief")) await morningBriefShots({ shoot, call, home });
  if (only.includes("compass")) await compassShots({ shoot, call, home, seeded });
  if (only.includes("compass-suggest")) await compassSuggestShots({ shoot, call, home, seeded });
  if (only.includes("compass-readers")) await compassReadersShots({ shoot, call, home });
  if (only.includes("shortcut")) await shortcutShots({ shoot, seeded, call, out, billing });
  if (only.includes("search-focus")) await searchFocusChecks({ shoot, seeded, call, out, billing });
  if (only.includes("new")) await newShots({ shoot, call, out, home, billing });
  if (only.includes("home-keys")) await homeKeysShots({ shoot, out });
  if (only.includes("rowchips")) await rowChipShots({ shoot, out });
  if (only.includes("pr-scale")) await prScaleShots({ shoot });
  if (only.includes("paged-lists")) await pagedListShots({ shoot });
  if (only.includes("pr-stats-settings")) await prStatsSettingsShots({ shoot, call, home });
  if (only.includes("pr-stats")) await prStatsShots({ shoot });
  if (only.includes("pr-stats-off")) await prStatsOffShots({ shoot });
  if (only.includes("archive")) await archiveShots({ shoot, call });
  if (only.includes("put-in-chat")) await putInChatShots({ shoot, seeded, call, billing });
  if (only.includes("sending")) await sendingShots({ shoot, seeded, call, home });
  if (only.includes("advanced")) await advancedShots({ shoot });
  if (only.includes("batch-churn")) await batchChurnShots({ shoot, seeded, call, home, cli });
  if (only.includes("needs-you-states")) {
    // One Needs you block per surface: each state on the panel (desktop) and Home's detail pane (desktop and phone),
    // light and dark. Tall panel frames so the block, Tasks and their neighbours all fit.
    const states = [
      { state: "brief-same-q", title: "Billing retries", prompt: billing.prompt, wait: "fail with card_declined retry" },
      { state: "brief-other-q", ...pick("ny-other"), wait: "Approve the staging export bucket" },
      { state: "two-qs", ...pick("ny-two"), wait: "Limit scope" },
      { state: "q-no-brief", ...pick("ny-lone"), wait: "Missing keys" },
      { state: "just-answered", ...pick("ny-answered"), wait: null },
      { state: "tasks", ...pick("ny-tasks"), wait: "Agent's tasks", homeToo: false },
      { state: "person", ...pick("ny-person"), wait: "#262 waits on its reviewer" },
      { state: "task-action", ...pick("ny-action"), wait: "A task waits on this. The agent works on the rest" },
    ];
    const stepClock = async ms => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); await setDaemonClock(Math.round(c.fake + (Date.now() - c.real) * c.rate) + ms); };
  const runningNotFinished = async label => {
    await stepClock(5_000);
    let row = null;
    await until(`${label}: Webhook signatures working, not finished`, async () => {
      row = (await call("follow.inbox-list", {})).rows.find(r => r.agentId === w.agentId);
      return row?.status === "running" && !row.needs?.reasons.some(r => r.reason === "finished");
    }, { tries: 120, every: 500 }).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ status: row?.status, turnStartedAt: row?.turnStartedAt, needs: row?.needs, brief: row?.brief && { kind: row.brief.kind, source: row.brief.source, state: row.brief.state } })}`); });
  };

  const TALL = { width: DESKTOP.width, height: 1300 };
    for (const s of states) for (const theme of ["light", "dark"]) {
      const settleOn = async page => { if (s.wait) await page.getByText(s.wait).filter({ visible: true }).first().waitFor(); else await page.waitForTimeout(1500); };
      await shoot(`ny-${s.state}-panel-${theme}`, TALL, theme, async page => {
        await page.setViewportSize(TALL);
        await openChat(page, s.title, s.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await settleOn(page);
      });
      // due-by-fact: phones read a workspace's Tasks in the larger view (as tasks-phone): what moves each task.
      if (s.state === "tasks") await shoot(`ny-tasks-phone-${theme}`, PHONE, theme, async page => {
        await openChat(page, s.title, s.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
        { const f = page.getByRole("button", { name: /^Agent's tasks, / }).last(); await f.waitFor({ timeout: 60000 }); if (await f.getAttribute("aria-expanded") !== "true") await f.click(); }
        const due = page.getByText(/^Due since /).last();
        await due.waitFor({ timeout: 60000 });
        await page.setViewportSize(PHONE);
        await due.evaluate(el => el.scrollIntoView({ block: "center" }));
        if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("ny-tasks-phone scrolls sideways");
      });
      if (s.homeToo === false) continue;
      await shoot(`ny-${s.state}-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await (await homeRow(page, s.title)).click(); await settleOn(page); });
      await shoot(`ny-${s.state}-home-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, s.title)).click(); await settleOn(page); });
    }
  }
  if (only.includes("older-briefs")) {
    // briefs-from-closed-agents: four days on, after a daemon restart closed every agent (Paseo reads unloaded agents as
    // closed). A closed agent's flag that asks nothing leaves Needs you; its real ask folds into Older, out of the
    // count; one whose workspace still has a live item (an open question) stays. Home desktop and phone, light and
    // dark, Older folded and opened.
    daemon.kill("SIGTERM");
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    await respawnDaemon();
    for (let i = 0; ; i++) { try { await call("follow.inbox-list", {}); break; } catch { if (i > 240) throw new Error("the worker did not come back"); await new Promise(r => setTimeout(r, 250)); } }
    const LATER = BASE + VIEW + 4 * 24 * 3600_000;
    await setDaemonClock(LATER);
    // Home's model runs in the page, on the page's clock: four days on there too.
    const home = async page => { await page.clock.setFixedTime(LATER); await openHome(page); };
    const older = page => page.getByRole("button", { name: /^Older, \d+\. (Expand|Collapse)$/ }).first();
    for (const theme of ["light", "dark"]) {
      await shoot(`older-briefs-home-${theme}`, DESKTOP, theme, async page => { await home(page); await older(page).waitFor({ timeout: 60_000 }); });
      await shoot(`older-briefs-home-open-${theme}`, DESKTOP, theme, async page => { await home(page); await older(page).click(); await page.getByRole("button", { name: /^Older, \d+\. Collapse$/ }).first().waitFor(); });
      await shoot(`older-briefs-home-phone-${theme}`, PHONE, theme, async page => { await home(page); await page.setViewportSize(PHONE); await older(page).waitFor(); await page.waitForTimeout(500); await older(page).click(); await page.getByText("Closed agents with nothing new").first().scrollIntoViewIfNeeded(); });
    }
  }
  if (only.includes("tasks-view")) {
    // tasks-are-the-agent-s: Agent's tasks folded to one line ("6 open · 2 due · 1 stale", stale alone amber), then
    // open (stale and due first, each with the agent's note; a row says what moves it), a row opened in place, the
    // phone's larger view, and the action card (ask first; Tasks says "In Needs you", Activity "Action · …").
    // Stale needs two nudges the agent didn't answer: the hook's receipt says so, and the worker reads it at start.
    const usage = seeded.workspaces.find(w => w.key === "ny-tasks");
    const { workspace } = await call("follow.get", { workspaceId: usage.workspaceId });
    const billing = workspace.obligations.find(o => o.title === "Confirm the usage export with billing");
    const nudged = { key: `recheck:${billing.recheckAt}`, revision: billing.revision, count: 2, at: new Date(BASE).toISOString() };
    await fs.mkdir(join(home, "plugin-data", "follow-up", "hook-state"), { recursive: true });
    await fs.writeFile(join(home, "plugin-data", "follow-up", "hook-state", `task-nudges-${usage.workspaceId}.json`), JSON.stringify({ [billing.id]: nudged }));
    daemon.kill("SIGTERM");
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    await respawnDaemon();
    for (let i = 0; ; i++) { try { await call("follow.inbox-list", {}); break; } catch { if (i > 240) throw new Error("the worker did not come back"); await new Promise(r => setTimeout(r, 250)); } }
    for (let i = 0; ; i++) {
      const read = await call("follow.get", { workspaceId: usage.workspaceId }).catch(() => null);
      if (read?.workspace?.obligations.find(o => o.id === billing.id)?.nudged?.count === 2) break;
      if (i > 240) throw new Error("the worker didn't read the nudge receipt"); await new Promise(r => setTimeout(r, 250));
    }
    const spec = NEEDS_YOU_STATES.find(w => w.key === "ny-tasks");
    const action = NEEDS_YOU_STATES.find(w => w.key === "ny-action");
    const stepClock = async ms => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); await setDaemonClock(Math.round(c.fake + (Date.now() - c.real) * c.rate) + ms); };
  const runningNotFinished = async label => {
    await stepClock(5_000);
    let row = null;
    await until(`${label}: Webhook signatures working, not finished`, async () => {
      row = (await call("follow.inbox-list", {})).rows.find(r => r.agentId === w.agentId);
      return row?.status === "running" && !row.needs?.reasons.some(r => r.reason === "finished");
    }, { tries: 120, every: 500 }).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ status: row?.status, turnStartedAt: row?.turnStartedAt, needs: row?.needs, brief: row?.brief && { kind: row.brief.kind, source: row.brief.source, state: row.brief.state } })}`); });
  };

  const TALL = { width: DESKTOP.width, height: 1300 };
    const fold = page => page.getByRole("button", { name: /^Agent's tasks, / }).filter({ visible: true }).last();
    const panel = async page => {
      await page.setViewportSize(TALL);
      await openChat(page, spec.title, spec.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await fold(page).waitFor({ timeout: 60_000 });
    };
    // Each shot sets the fold it shows instead of toggling it, so no shot depends on the one before (folded is the default).
    const setFold = async (page, open) => { const f = fold(page); if ((await f.getAttribute("aria-expanded")) !== String(open)) await f.click(); await page.waitForFunction(([want]) => [...document.querySelectorAll('[aria-expanded]')].some(el => /^Agent's tasks, /.test(el.getAttribute("aria-label") ?? "") && el.getAttribute("aria-expanded") === want), [String(open)]); };
    const expand = async page => { await setFold(page, true); await page.getByText(/^Stale/).filter({ visible: true }).first().waitFor({ timeout: 30_000 }); };
    for (const theme of ["light", "dark"]) {
      await shoot(`tv-panel-${theme}`, TALL, theme, async page => { await panel(page); await setFold(page, false); });
      await shoot(`tv-panel-open-${theme}`, TALL, theme, async page => { await panel(page); await expand(page); });
      await shoot(`tv-row-open-${theme}`, TALL, theme, async page => {
        await panel(page); await expand(page);
        await page.getByRole("button", { name: /^Task: Backfill alert history/ }).first().click();
        await page.getByText("Send on a schedule…").filter({ visible: true }).first().waitFor();
      });
      await shoot(`tv-phone-${theme}`, PHONE, theme, async page => {
        await openChat(page, spec.title, spec.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
        await fold(page).waitFor({ timeout: 60_000 });
        await page.setViewportSize(PHONE);
        await setFold(page, true);
        const stale = page.getByText(/^Stale/).filter({ visible: true }).last();
        await stale.waitFor({ timeout: 30_000 });
        await fold(page).evaluate(el => el.scrollIntoView({ block: "start" }));
        if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("tv-phone scrolls sideways");
      });
      await shoot(`tv-action-panel-${theme}`, TALL, theme, async page => {
        await page.setViewportSize(TALL);
        await openChat(page, action.title, action.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByText("A task waits on this. The agent works on the rest").filter({ visible: true }).first().waitFor({ timeout: 60_000 });
        // Folded, as the developer first sees it: "1 open · in Needs you" (the row is the Needs you card above).
        await setFold(page, false);
        await page.getByText("1 open · in Needs you").filter({ visible: true }).first().waitFor();
      });
    }
  }
  if (only.includes("scheduled-tasks")) await scheduledShots({ shoot, seeded, call, cli });
  if (only.includes("now-line")) await nowLineShots({ shoot });
  if (only.includes("peek")) await peekShots({ shoot });
  if (only.includes("pr-now")) await prNowShots({ shoot, call, seeded });
  if (only.includes("panel-folds")) await panelFoldShots({ shoot });
  if (only.includes("question-links")) await questionLinksShots({ shoot, call, seeded, home });
  if (only.includes("own-answer")) await ownAnswerShots({ shoot });
  if (only.includes("more-context")) await moreContextShots({ shoot, call });
  if (only.includes("your-questions")) await yourQuestionsShots({ shoot, call, seeded, home, cli });
  if (only.includes("paste-images")) await pasteImagesShots({ shoot, call });
  if (only.includes("attach-images")) await attachImagesShots({ shoot, call });
  if (only.includes("dismiss")) await dismissShots({ shoot, call });
  if (only.includes("dock-in-view")) await dockInViewShots({ shoot });
  if (only.includes("pick-notes")) {
    // Decision cards with a note (a-pick-note-reaches-the-agent): one decision and two; the note link closed, then
    // open with text.
    const NOTE = "Keep the BOM off; the finance team's parser chokes on it.";
    const TALL = { width: DESKTOP.width, height: 1100 };
    const write = async (page, decision) => {
      await page.getByRole("button", { name: decision ? `Add note to decision ${decision}` : "Add note", exact: true }).filter({ visible: true }).first().click();
      const field = page.getByLabel(decision ? `Note for the agent on decision ${decision}, optional` : "Note for the agent, optional").filter({ visible: true }).first();
      await field.fill(NOTE);
      return field;
    };
    // The note survives an inbox tick (the card refetches and re-renders) with the caret still in it.
    const survives = async (page, field, name) => {
      await page.waitForTimeout(17_000);
      const ok = await field.evaluate((el, text) => document.activeElement === el && el.value === text, NOTE).catch(() => false);
      if (!ok) failures.push(`${name}: the note or its focus didn't survive a refresh`); else log(`${name}: note and focus kept across a refresh`);
    };
    const pickAll = async page => { for (const name of ["A: UTF-8 (recommended)", "A: The reports bucket (recommended)"]) await page.getByRole("radio", { name, exact: true }).filter({ visible: true }).first().click(); };
    // needs_you decisions are tracked as questions, so Home and the panel ask them as question cards (their own note
    // field); the chat's decision card is where "Add note" lives: desktop and phone, light and dark.
    for (const s of [{ state: "one", ...pick("pn-one"), wait: "Which encoding should the export use?" }, { state: "two", ...pick("pn-two"), wait: "2. Where should the export land?" }]) {
      for (const theme of ["light", "dark"]) for (const [size, frame] of [["", TALL], ["-phone", PHONE]]) {
        const open = async page => { await page.setViewportSize(TALL); await openChat(page, s.title, s.prompt); if (frame === PHONE) await page.setViewportSize(PHONE); await page.getByText(s.wait).filter({ visible: true }).first().waitFor(); };
        await shoot(`pn-${s.state}-chat${size}-${theme}`, frame, theme, open);
        await shoot(`pn-${s.state}-chat${size}-note-${theme}`, frame, theme, async page => {
          await open(page); if (s.state === "two") await pickAll(page);
          const f = await write(page, s.state === "two" ? 1 : 0);
          if (theme === "light" && !size) await survives(page, f, `pn-${s.state}-chat`);
        });
      }
    }
  }
  if (only.includes("done-brief")) {
    // A done brief on a row flagged by a merged PR: the panel and Home's detail pane, desktop light and phone dark (the
    // reported view). Needs you shows the merge, or nothing; never "Nothing needed" counted as 1.
    const w = DONE_BRIEF[0]; const TALL = { width: DESKTOP.width, height: 1100 };
    const settle = async page => { await page.getByText("#240").filter({ visible: true }).first().waitFor(); await page.waitForTimeout(1500); };
    for (const [theme, size, frame] of [["light", "", TALL], ["dark", "-phone", PHONE]]) {
      await shoot(`db-panel${size}-${theme}`, frame, theme, async page => {
        await page.setViewportSize(TALL); await openChat(page, w.title, w.prompt);
        // On a phone the tab strip is off screen: shoot the flag pill's sheet, which carries the same Needs-you list.
        if (frame === PHONE) { await page.setViewportSize(PHONE); await page.getByRole("button", { name: /^Follow-up · / }).last().click(); }
        else await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await settle(page);
      });
      await shoot(`db-home${size}-${theme}`, frame, theme, async page => { await openHome(page); if (frame === PHONE) await page.setViewportSize(PHONE); await (await homeRow(page, w.title)).click(); await settle(page); });
    }
  }
}
/**
 * pr-link (a-row-that-names-a-pr-opens-it-in-one-click): Search filters' "#151 is approved" merge row and Audit log export's
 * reviewers row, each with its Open #N link; the panel on desktop, Home's detail pane on desktop and phone.
 */
/**
 * split (side-panes-are-resizable): Home's divider idle, on hover, mid-drag, keyboard-focused, at the pane's minimum and
 * at its maximum (dark; light for idle, drag and focus), and the drag check: a real mouse drag (down, moves, up) on
 * the handle must widen the pane by what it moved, the share must survive a reload and a fresh browser, the arrow keys
 * must move it, and an agent's set_display must reach Home. Writes split.json to --out; any failed check fails the run.
 */
/**
 * row-chips-never-cover-the-time: at a 1024 window, every Home row's visible chips (badges, PR chip) and its time
 * column, measured as CDP box models at list widths 320, 360 and 400, never overlap; the time stays inside its row.
 * The list is narrowed by widening the right pane's element. A chip the rail clipped away has no visible box.
 * Writes rowchips.json.
 */
/**
 * pr-scale (pr-scale-lists-batch-not-throw): Ledger rewrite's 120-PR stack and three example/web stacks. The panel's
 * Pull requests card at its top, scrolled to the middle of the stack and at its end; Home with the workspace selected
 * (desktop and 390x844); the PR sheet of the top failing PR (#1116; #1120 is folded), desktop and phone (opened from the panel, then narrowed); the
 * first "+N in review" fold closed and expanded; the stack bar cropped close; the panel's larger view on a phone; the
 * chat's brief card beside the panel and on a phone (never "No ask stated"); and Billing retries (3 PRs) on the same
 * surfaces, with no fold. Light and dark. Each shot fails on a schema error's text ("Too big", "expected array") or, on
 * a phone, a page that scrolls sideways.
 */
/**
 * Archive workspace… in the row menu (--only archive): last in tidy on a working row, first in triage on a row ready to
 * archive, the confirm step (a directory workspace, and a worktree with uncommitted changes, unpushed commits and an
 * agent at work), Paseo refusing, and a real archive whose row then shows under Archived in search. Desktop (right-click)
 * and phone (long-press), light and dark, 2x. The worktree facts and the refusal are stand-ins on the page's daemon
 * socket (the harness seeds directory workspaces); the real archive goes to the harness daemon.
 */
async function archiveShots({ shoot, call }) {
  const working = "Billing retries"; const done = "Dark mode tokens"; const real = "Onboarding email";
  const proxy = ({ worktree = null, refuse = null } = {}) => ws => {
    const server = ws.connectToServer();
    const walk = o => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (worktree && "workspaceKind" in o && (o.title === worktree || o.name === worktree)) {
        Object.assign(o, { workspaceKind: "worktree", status: "running", diffStat: { additions: 12, deletions: 3 } });
        o.gitRuntime = { ...(o.gitRuntime ?? {}), isPaseoOwnedWorktree: true, isDirty: true, aheadOfOrigin: 2 };
      }
      for (const v of Object.values(o)) walk(v);
    };
    server.onMessage(m => { if (typeof m !== "string" || !worktree) { ws.send(m); return; } try { const j = JSON.parse(m); walk(j); ws.send(JSON.stringify(j)); } catch { ws.send(m); } });
    ws.onMessage(m => {
      if (refuse && typeof m === "string" && m.includes("archive_workspace_request")) {
        const r = JSON.parse(m).message;
        ws.send(JSON.stringify({ type: "session", message: { type: "archive_workspace_response", payload: { requestId: r.requestId, workspaceId: r.workspaceId, archivedAt: null, error: refuse } } }));
        return;
      }
      server.send(m);
    });
  };
  /** A real touch (CDP), held for `ms`: a long-press opens the row's sheet, a short one taps. */
  const touch = async (page, x, y, ms) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    // The page's clock is fixed: move it a second on, or the sheet's guard (no pick within 350 ms of the lift) never arms.
    page.archiveClock = (page.archiveClock ?? BASE + VIEW) + 1000;
    await page.clock.setFixedTime(page.archiveClock);
    await page.waitForTimeout(400);
  };
  // The done row sits in Quiet, folded by default: open the fold first.
  const rowOf = async (page, title) => {
    if (title === done) { const fold = page.getByRole("button", { name: /^Quiet, \d+\. (Expand|Collapse)$/i }).filter({ visible: true }).first(); await fold.waitFor(); if (await fold.getAttribute("aria-expanded") !== "true") await fold.click(); await page.waitForTimeout(300);
      const project = page.getByRole("button", { name: /^web, \d+\. Expand$/ }).filter({ visible: true }).first();
      if (await project.count()) { await project.click(); await page.waitForTimeout(300); } }
    const row = await homeRow(page, title); await row.scrollIntoViewIfNeeded(); return row;
  };
  const open = async (page, vp, title) => {
    await openHome(page);
    if (vp === PHONE) {
      await page.setViewportSize(PHONE);
      const row = await rowOf(page, title); const b = await row.boundingBox();
      await touch(page, b.x + 80, b.y + b.height / 2, 900);
      await page.waitForTimeout(500);
    } else await (await rowOf(page, title)).click({ button: "right", position: { x: 160, y: 18 } });
    const item = page.getByRole("menuitem", { name: "Archive workspace…" }).filter({ visible: true }).first();
    await item.waitFor();
    await item.scrollIntoViewIfNeeded();
    // A phone taps (touch events, so the sheet sees the long-press lift); desktop clicks.
    return { click: async () => { if (vp !== PHONE) { await item.click(); return; } await page.waitForTimeout(400); const b = await item.boundingBox(); await touch(page, b.x + b.width / 2, b.y + b.height / 2, 60); } };
  };
  const confirmButton = page => page.getByRole("button", { name: "Archive workspace", exact: true }).filter({ visible: true }).first();
  const press = async (page, vp, el) => { if (vp !== PHONE) { await el.click(); return; } const b = await el.boundingBox(); await touch(page, b.x + b.width / 2, b.y + b.height / 2, 60); };
  const opts = (o = {}) => ({ scale: 2, ...o });
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await shoot(`archive-tidy-${size}-${theme}`, vp, theme, async page => { await open(page, vp, working); }, opts());
    // Desktop: a tall window, so Quiet (where the done row sits) is on screen.
    const tall = vp === PHONE ? vp : { width: DESKTOP.width, height: 1400 };
    await shoot(`archive-triage-${size}-${theme}`, tall, theme, async page => { if (tall !== vp) await page.setViewportSize(tall); await open(page, vp, done); }, opts());
    await shoot(`archive-confirm-${size}-${theme}`, vp, theme, async page => { await (await open(page, vp, working)).click(); await confirmButton(page).waitFor(); }, opts());
    await shoot(`archive-confirm-worktree-${size}-${theme}`, vp, theme, async page => {
      await (await open(page, vp, working)).click(); await confirmButton(page).waitFor();
      await page.getByText(/Uncommitted changes \(12 added lines, 3 deleted lines\) are lost/).filter({ visible: true }).first().waitFor();
    }, opts({ ws: proxy({ worktree: working }) }));
    await shoot(`archive-error-${size}-${theme}`, vp, theme, async page => {
      await (await open(page, vp, working)).click(); await confirmButton(page).waitFor(); await press(page, vp, confirmButton(page));
      await page.getByText(/Couldn't archive Billing retries/).filter({ visible: true }).first().waitFor();
      await (await homeRow(page, working)).waitFor();
    }, opts({ ws: proxy({ refuse: "Worktree teardown failed: example teardown exited 1" }) }));
    // Keyboard on desktop: the menu key opens the menu, Enter on Archive opens the confirm, Esc goes back to the menu.
    if (size === "desktop") await shoot(`archive-keys-${theme}`, vp, theme, async page => {
      await openHome(page);
      const row = await homeRow(page, working); await row.focus(); await page.waitForTimeout(500);
      // With no menu open the list keeps its keys: j steps the focus off the row and k brings it back.
      const focusedId = () => page.evaluate(() => document.activeElement?.id ?? "");
      const start = await focusedId();
      await page.keyboard.press("j"); await page.waitForTimeout(300);
      const moved = await focusedId();
      if (!start || moved === start) throw new Error(`archive-keys: j didn't move the selection (${start} -> ${moved})`);
      await page.keyboard.press("k"); await page.waitForTimeout(300);
      if (await focusedId() !== start) throw new Error("archive-keys: k didn't step back to the row");
      await page.keyboard.press("Shift+F10");
      const menu = page.getByRole("menu", { name: `Actions for ${working}` });
      await menu.waitFor();
      for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Archive workspace…")); i++) await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      await page.getByRole("alertdialog").waitFor();
      await page.keyboard.press("Escape");
      await menu.waitFor();
      await page.keyboard.press("Enter");
      await page.getByRole("alertdialog").waitFor();
      page.keepFocus = true;
    }, opts());
  }
  // The real thing, last: Paseo archives Onboarding email, the toast says so, the row leaves Home and search shows it
  // under Archived.
  await shoot("archive-done-desktop-dark", DESKTOP, "dark", async page => {
    await (await open(page, DESKTOP, real)).click(); await confirmButton(page).click();
    await page.getByText(`Archived ${real}`).filter({ visible: true }).first().waitFor({ timeout: 60000 });
    const rows = page.getByRole("button", { name: new RegExp(`^${real}`) });
    for (let i = 0; i < 60 && await rows.count(); i++) await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    const field = page.getByRole("textbox", { name: /^(Search workspaces, branches, PRs|Search, or ask the Overseer|Search or ask the Overseer)$/ }).first();
    await field.fill("onboarding");
    await page.getByText("Archived", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  }, opts());
}

/**
 * pr-stats-settings only: stats.json before the daemon starts, one repository in each state Settings words differently.
 * Every repository that's on synced "tomorrow" on the shots' clock, so none is due and no sync touches the fixture.
 */
async function seedPrStatsSettings(dir) {
  const s = ms => Math.floor(ms / 1000), day = 86_400_000, later = s(BASE + day);
  const status = o => ({ records: 0, coveredTo: null, backfillDone: true, lastSyncAt: later, lastCost: 1, waiting: null, error: null, cappedTo: null, ...o });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "stats.json"), JSON.stringify({ repos: {
    "example/app": { enable_stats: true, windowDays: 90, team: { kind: "people", logins: ["dana", "ravi", "mei", "tomas"] }, ignore: ["deploy-robot", "release-*"], enabledAt: s(BASE - 20 * day), estimate: { prs: 3250, points: 143, at: s(BASE - 20 * day) },
      status: status({ records: 3250, coveredTo: s(BASE - 90 * day) }) },
    "example/web": { enable_stats: true, windowDays: 180, team: { kind: "everyone" }, ignore: [], enabledAt: s(BASE - day), estimate: { prs: 4100, points: 181, at: s(BASE - day) },
      status: status({ records: 1240, coveredTo: s(BASE - 40 * day), backfillDone: false, waiting: { reason: "budget", until: s(BASE + 3600_000) } }) },
    "example/api": { enable_stats: false, windowDays: 90, team: { kind: "everyone" }, ignore: [], enabledAt: s(BASE - 60 * day), estimate: null,
      status: status({ records: 812, coveredTo: s(BASE - 90 * day), lastSyncAt: s(BASE - 12 * day) }) },
    "example/docs": { enable_stats: true, windowDays: 30, team: { kind: "github", team: "example/writers" }, ignore: [], enabledAt: s(BASE - 3 * day), estimate: { prs: 96, points: 5, at: s(BASE - 3 * day) },
      status: status({ records: 96, coveredTo: s(BASE - 30 * day), error: { message: "not found or no access", status: 404, at: s(BASE - 3600_000) }, teamMembers: { team: "example/writers", logins: null, error: "not visible to this token", at: s(BASE - 3600_000) } }) },
  }, slice: 0.05, clock: "calendar", enable_stack_aware: true, // A Friday–Saturday-weekend zone, no saved schedule: the Clock row says Sun–Thu.
    timeZone: "Africa/Cairo", hours: null, weekStart: null }));
}
/**
 * pr-stats only: four fictional repositories' records and stats.json in a Friday–Saturday-weekend zone (Africa/Cairo),
 * so This week starts on Sunday. example/app: 8 people over 90 days; example/web: its first read, two days in, waiting
 * on GitHub's limit; example/docs: GitHub refused it and nothing happened this week; example/solo: one person. Every
 * repository synced two minutes before the browser's time, so nothing is due while the shots run.
 */
async function seedPrStats(dir) {
  const s = ms => Math.floor(ms / 1000), H = 3600, D = 86_400, now = s(BASE + VIEW), synced = now - 120;
  const PEOPLE = ["alice", "bob", "carol", "dan", "erin", "frank", "grace", "heidi"];
  const WEIGHT = [7, 5, 4, 3, 2, 2, 1, 1];
  const WAIT_H = [2.5, 9, 20, 1.5, 6, 14, 4, 3];
  const TITLES = ["Add audit events for role changes", "Split the roles migration", "Rename the permissions table", "Add a role column to members", "Move invoice exports to the background queue",
    "Cache the plan lookup", "Fix the empty state on invoices", "Retry webhook deliveries once", "Show the billing contact in settings", "Drop the old export endpoint", "Batch the usage writes", "Tidy the onboarding copy"];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = () => { let r = rnd() * WEIGHT.reduce((a, b) => a + b, 0); for (let i = 0; i < WEIGHT.length; i++) { r -= WEIGHT[i]; if (r < 0) return i; } return 0; };
  const make = ({ count, from, to, first, people = PEOPLE.length, reviews = true }) => {
    const out = [];
    for (let k = 0; k < count; k++) {
      const ai = Math.min(pick(), people - 1), a = PEOPLE[ai];
      const c = Math.round(to - (k + rnd() * 0.6) * (to - from) / count);
      const ask = c + 600;
      const ri = reviews ? (ai + 1 + Math.floor(rnd() * (PEOPLE.length - 1))) % PEOPLE.length : -1;
      const wait = Math.round(WAIT_H[ai] * H * (0.4 + rnd() * 1.3));
      const reviewed = reviews && ask + wait < now - 300;
      const at = reviewed ? ask + wait : null;
      const merged = at && at + 4 * H < now && rnd() < 0.85 ? at + Math.round((2 + rnd() * 20) * H) : null;
      const m = merged && merged < now ? merged : null;
      const n = first + count - k;
      const stacked = k > 0 && k % 9 === 0;
      const rv = at ? [[PEOPLE[ri], "A", at]] : [];
      const fc = [];
      out.push({ n, a, t: TITLES[n % TITLES.length], c, u: Math.min(now - 60, Math.max(c, at ?? c, m ?? c)), r: c, k: ask, m, x: m, s: m ? "M" : "O", d: false,
        add: Math.round(20 + rnd() * 400), del: Math.round(rnd() * 120), f: 1 + Math.floor(rnd() * 9), b: stacked ? `${a}/change-${n + 1}` : "main", h: `${a}/change-${n}`,
        rq: ri >= 0 ? [[PEOPLE[ri], ask]] : [], rv, fc });
    }
    return out;
  };
  const meta = (repo, o = {}) => ({ repo, defaultBranch: "main", highWater: synced, incremental: null, backfill: { after: null, done: true, coveredTo: now - 90 * D }, page: 25, windowDays: 90, pendingReviews: [],
    lastSyncAt: synced, lastCost: 1, lastPages: 1, waiting: null, error: null, cappedTo: null, ...o });
  const repos = {
    "example/app": { records: make({ count: 720, from: now - 90 * D, to: now - 1800, first: 1000 }), meta: meta("example/app") },
    "example/web": { records: make({ count: 40, from: now - 2 * D, to: now - 3600, first: 4000 }), meta: meta("example/web", { backfill: { after: "cursor-70", done: false, coveredTo: now - 2 * D }, waiting: { reason: "budget", until: now + 40 * 60 } }) },
    "example/docs": { records: make({ count: 14, from: now - 60 * D, to: now - 40 * D, first: 200 }), meta: meta("example/docs", { error: { message: "not found or no access", status: 404, at: now - H } }) },
    "example/solo": { records: make({ count: 6, from: now - 3 * D, to: now - 2 * H, first: 30, people: 1, reviews: false }), meta: meta("example/solo") },
  };
  await fs.mkdir(join(dir, "stats", "example"), { recursive: true });
  for (const [repo, { records, meta: m }] of Object.entries(repos)) await fs.writeFile(join(dir, "stats", `${repo}.json`), JSON.stringify({ v: 1, meta: m, records }));
  const status = (repo, o = {}) => { const { records, meta: m } = repos[repo]; return { records: records.length, coveredTo: m.backfill.coveredTo, backfillDone: m.backfill.done, lastSyncAt: m.lastSyncAt, lastCost: 1, waiting: m.waiting, error: m.error, cappedTo: null, ...o }; };
  const on = (repo, o = {}) => ({ enable_stats: true, windowDays: 90, team: { kind: "everyone" }, ignore: [], enabledAt: now - 30 * D, estimate: null, status: status(repo), ...o });
  await fs.writeFile(join(dir, "stats.json"), JSON.stringify({ repos: {
    "example/app": on("example/app"), "example/web": on("example/web", { estimate: { prs: 280, points: 13, at: now - 2 * D } }),
    "example/docs": on("example/docs"), "example/solo": on("example/solo"),
  }, slice: 0.05, clock: "calendar", enable_stack_aware: true, timeZone: "Africa/Cairo", hours: null, weekStart: null }));
}
/** pr-stats only: the page from Home's icon (and ⌘K), its sort, a person, and each state, both sizes and themes. */
async function prStatsShots({ shoot }) {
  const TALL = { width: DESKTOP.width, height: 1100 }, PHONE_TALL = { width: PHONE.width, height: 1500 };
  const healthy = async (page, vp) => {
    const body = await page.evaluate(() => document.body.innerText);
    const bad = body.match(/Something went wrong|Invalid input|Couldn't read PR stats|expected/i);
    if (bad) throw new Error(`pr-stats: the page shows "${bad[0]}"`);
    if (vp.width === PHONE.width && await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("pr-stats: the phone page scrolls sideways");
    return body;
  };
  const open = async (page, vp) => {
    await page.setViewportSize(vp); await openHome(page);
    await page.getByRole("button", { name: "PR stats", exact: true }).filter({ visible: true }).first().click({ timeout: 30_000 });
    await page.getByText("alice", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    const body = await healthy(page, vp);
    // Africa/Cairo's week (Friday–Saturday weekend, nothing saved) starts on Sunday: invariant 75.
    if (!body.includes("Sun, Mar 1 – now")) throw new Error("pr-stats: This week doesn't start on the zone's Sunday");
  };
  const repo = async (page, vp, name, wait) => {
    await open(page, vp);
    await page.getByRole("button", { name: /^Repository example\/app, change/ }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name }).filter({ visible: true }).last().click();
    await page.getByText(wait).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await healthy(page, vp);
  };
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", TALL], ["phone", PHONE_TALL]]) {
    const phone = size === "phone";
    await shoot(`pst-board-${size}-${theme}`, vp, theme, async page => { await open(page, vp); });
    await shoot(`pst-sort-wait-${size}-${theme}`, vp, theme, async page => {
      await open(page, vp);
      if (phone) { await page.getByRole("button", { name: /^Sorted by PRs opened/ }).filter({ visible: true }).first().click(); await page.getByRole("radio", { name: /Median wait for a first review/ }).filter({ visible: true }).last().click(); }
      else await page.getByRole("button", { name: /^Sort by Median wait for a first review/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(400); await healthy(page, vp);
    });
    await shoot(`pst-person-${size}-${theme}`, phone ? PHONE : DESKTOP, theme, async page => {
      await open(page, vp);
      await page.getByRole("button", { name: /^alice: / }).filter({ visible: true }).first().click();
      await page.getByText("Opened by alice").filter({ visible: true }).first().waitFor({ timeout: 30_000 });
      await page.setViewportSize(phone ? PHONE : DESKTOP); await page.waitForTimeout(400); await healthy(page, phone ? PHONE : DESKTOP);
    });
    await shoot(`pst-reading-${size}-${theme}`, vp, theme, async page => { await repo(page, vp, /^example\/web/, /Partly read/); });
    await shoot(`pst-refused-${size}-${theme}`, vp, theme, async page => { await repo(page, vp, /^example\/docs/, /GitHub returned 404/); await page.getByText(/No PRs opened or reviewed this week/).first().waitFor(); });
    await shoot(`pst-solo-${size}-${theme}`, vp, theme, async page => { await repo(page, vp, /^example\/solo/, /Opened by alice/); });
  }
}
/** pr-stats-off only (no stats seeded): the page from ⌘K before any repository is on; Home shows no icon. */
async function prStatsOffShots({ shoot }) {
  // Desktop only: with nothing on, a phone has no way in (no command palette, no Home icon, no Settings link). On a
  // phone the same section is Settings' PR statistics, rendered by pr-stats-settings.
  for (const theme of ["light", "dark"]) {
    await shoot(`pst-off-desktop-${theme}`, DESKTOP, theme, async page => {
      await page.setViewportSize(DESKTOP); await openHome(page);
      if (await page.getByRole("button", { name: "PR stats", exact: true }).filter({ visible: true }).count()) throw new Error("pr-stats-off: Home shows the PR stats icon with nothing on");
      await page.keyboard.press("Control+k"); await page.waitForTimeout(400);
      await page.keyboard.type("Follow-up: PR stats"); await page.waitForTimeout(500); await page.keyboard.press("Enter");
      await page.getByText(/See who opens, merges/).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    });
  }
}
/** pr-stats-settings only: Settings → Following → PR statistics, its options fold and the opt-in sheet, both sizes and themes. */
async function prStatsSettingsShots({ shoot, call, home }) {
  const TALL = { width: DESKTOP.width, height: 1400 }, PHONE_TALL = { width: PHONE.width, height: 1800 };
  const section = async (page, vp) => {
    await page.setViewportSize(vp);
    await openSettingsAt(page, "following", vp);
    const heading = page.getByText("PR statistics", { exact: true }).filter({ visible: true }).first();
    await heading.waitFor({ timeout: 30_000 });
    await page.getByText("example/docs", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await heading.evaluate(el => el.scrollIntoView({ block: "start" }));
    const body = await page.evaluate(() => document.body.innerText);
    const bad = body.match(/Something went wrong|Invalid input|Couldn't load PR statistics/i);
    if (bad) throw new Error(`pr-stats-settings: the page shows "${bad[0]}"`);
    // No saved schedule in a Friday–Saturday-weekend zone: the Clock row names the zone's own week.
    if (!body.includes("Sun–Thu 9–18, Africa/Cairo")) throw new Error("pr-stats-settings: the Clock row doesn't say the zone's week (Sun–Thu 9–18, Africa/Cairo)");
    if (vp.width === PHONE.width && await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("pr-stats-settings: the phone page scrolls sideways");
  };
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", TALL], ["phone", PHONE_TALL]]) {
    await shoot(`pss-section-${size}-${theme}`, vp, theme, async page => { await section(page, vp); });
    await shoot(`pss-options-${size}-${theme}`, vp, theme, async page => {
      await section(page, vp);
      const fold = page.getByRole("button", { name: /^example\/app options, 90 days · 4 people/ }).filter({ visible: true }).first();
      await fold.click(); await page.getByText("History", { exact: true }).filter({ visible: true }).first().waitFor();
      // Nothing edited yet: both Saves are off (a Save that saves nothing is a dead invitation).
      const live = await page.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).evaluateAll(els => els.filter(e => e.getAttribute("aria-disabled") !== "true" && !e.hasAttribute("disabled")).length);
      if (live) throw new Error(`pr-stats-settings: ${live} Save button(s) enabled before any edit`);
      await fold.evaluate(el => el.scrollIntoView({ block: "start" }));
    });
    await shoot(`pss-clock-${size}-${theme}`, size === "phone" ? PHONE : DESKTOP, theme, async page => {
      await section(page, vp);
      await page.setViewportSize(size === "phone" ? PHONE : DESKTOP);
      await page.getByText("All repositories", { exact: true }).filter({ visible: true }).first().evaluate(el => el.scrollIntoView({ block: "center" }));
    });
    await shoot(`pss-optin-${size}-${theme}`, size === "phone" ? PHONE : DESKTOP, theme, async page => {
      await section(page, vp);
      await page.getByLabel("Another repository, owner/repo").filter({ visible: true }).first().fill("example/mobile");
      await page.getByRole("button", { name: /^Add/ }).filter({ visible: true }).first().click();
      await page.getByText("Turn on PR stats for example/mobile?").filter({ visible: true }).first().waitFor();
      await page.getByText(/1,840/).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
      await page.setViewportSize(size === "phone" ? PHONE : DESKTOP);
    });
  }
  // a-read-the-developer-starts-never-waits-on-the-governor (invariant 106): the sheet while the machine is busy (the
  // count still loads, Turn on live) and with GitHub's limit low (no count, why and when in plain words, Turn on live).
  // Desktop light and 390×844 dark.
  const sheet = async (page, vp, repo, wait) => {
    await section(page, vp);
    await page.getByLabel("Another repository, owner/repo").filter({ visible: true }).first().fill(repo);
    await page.getByRole("button", { name: /^Add/ }).filter({ visible: true }).first().click();
    await page.getByText(`Turn on PR stats for ${repo}?`).filter({ visible: true }).first().waitFor();
    await page.getByText(wait).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    const body = await page.evaluate(() => document.body.innerText);
    if (/machine is busy/i.test(body)) throw new Error("pr-stats-settings: the sheet says the machine is busy");
    const off = await page.getByRole("button", { name: "Turn on", exact: true }).filter({ visible: true }).last().evaluate(e => e.getAttribute("aria-disabled") === "true" || e.hasAttribute("disabled"));
    if (off) throw new Error(`pr-stats-settings: Turn on is off in the ${repo} sheet`);
    await page.setViewportSize(vp.width === PHONE.width ? PHONE : DESKTOP);
    if (vp.width === PHONE.width && await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("pr-stats-settings: the phone sheet scrolls sideways");
  };
  const pairs = [["desktop", TALL, "light"], ["phone", PHONE_TALL, "dark"]];
  await fs.writeFile(process.env.FOLLOW_SHOTS_CGROUP, JSON.stringify({ high: 1000, current: 780 }));
  await until("the governor holds background work", async () => (await call("follow.usage", {})).resources?.level === "constrained", { tries: 120, every: 500 });
  for (const [size, vp, theme] of pairs) await shoot(`pss-optin-busy-${size}-${theme}`, vp, theme, async page => { await sheet(page, vp, "example/mobile", /1,840/); });
  await fs.writeFile(process.env.FOLLOW_SHOTS_CGROUP, JSON.stringify({ high: 1000, current: 100 }));
  const fixture = join(home, "gh-fixture.json");
  const d = JSON.parse(await fs.readFile(fixture, "utf8"));
  // GitHub's reset 40 minutes ahead on the daemon's (fake) clock, as --github-wait-review does.
  const c = JSON.parse(await fs.readFile(clockFile, "utf8"));
  const resetAt = new Date(c.fake + (Date.now() - c.real) * c.rate + 40 * 60_000).toISOString();
  await fs.writeFile(fixture, JSON.stringify({ ...d, _rate: { cost: 1, remaining: 640, limit: 5000, resetAt } }));
  await until("stats see GitHub's limit low", async () => (await call("follow.pr-stats-settings", { repo: "example/mobile", estimate: true })).estimate?.wait?.reason === "budget", { tries: 120, every: 1000 });
  for (const [size, vp, theme] of pairs) await shoot(`pss-optin-low-${size}-${theme}`, vp, theme, async page => {
    await sheet(page, vp, "example/mobile", /Less than 40% of your GitHub limit is left/);
    // The reason line says the 40% rule; the pause fact doesn't repeat it.
    if (await page.getByText(/^Stats pause whenever/).filter({ visible: true }).count()) throw new Error("pr-stats-settings: the budget-low sheet says the 40% rule twice");
  });
  await fs.writeFile(fixture, JSON.stringify(d));
}
/**
 * paged-lists (every list pages): PAGED_STATES' workspace. The panel's Activity folded, then its first page and a later
 * one after Show all, the Questions tab's second page, a search's paged hits, and the Tasks card opened with its pager;
 * the larger view on a phone, first and later page; light and dark. A shot fails on more rows than a page, a pager
 * that doesn't say where it is, or a phone page that scrolls sideways.
 */
async function pagedListShots({ shoot }) {
  const spec = PAGED_STATES[0];
  const TALL = { width: DESKTOP.width, height: 1300 };
  const activity = page => page.getByRole("button", { name: /^Show Show all \d+$/ }).filter({ visible: true }).first();
  const check = async (page, vp, label) => {
    const body = await page.evaluate(() => document.body.innerText);
    const bad = body.match(/Too big|expected array|Invalid input|Something went wrong/i);
    if (bad) throw new Error(`paged-lists: the page shows "${bad[0]}"`);
    if (vp?.width === PHONE.width && await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("paged-lists: the phone page scrolls sideways");
    if (label && !(await page.getByText(label, { exact: true }).filter({ visible: true }).count())) throw new Error(`paged-lists: no pager reading "${label}"`);
  };
  const panel = async page => {
    await page.setViewportSize(TALL); await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await activity(page).waitFor({ timeout: 90_000 });
  };
  const next = async (page, times) => { for (let i = 0; i < times; i++) { await page.getByRole("button", { name: "Next page", exact: true }).filter({ visible: true }).last().click(); await page.waitForTimeout(300); } };
  const pager = page => page.getByText(/^\d+–\d+ of \d+$/).filter({ visible: true }).last();
  const showAll = async page => { const b = activity(page); await b.click(); await pager(page).waitFor(); };
  const into = async (page, loc) => { await loc.evaluate(el => el.scrollIntoView({ block: "center" })); await page.waitForTimeout(200); };
  for (const theme of ["light", "dark"]) {
    await shoot(`pl-activity-folded-${theme}`, TALL, theme, async page => { await panel(page); await into(page, activity(page)); await check(page); });
    await shoot(`pl-activity-page1-${theme}`, TALL, theme, async page => { await panel(page); await showAll(page); await into(page, pager(page)); await check(page, null, await pager(page).innerText()); });
    await shoot(`pl-activity-page4-${theme}`, TALL, theme, async page => { await panel(page); await showAll(page); await next(page, 3); await into(page, pager(page)); const l = await pager(page).innerText(); if (!l.startsWith("76–100")) throw new Error(`paged-lists: page 4 reads ${l}`); await check(page, null, l); });
    await shoot(`pl-questions-page2-${theme}`, TALL, theme, async page => {
      await panel(page); await page.getByRole("tab", { name: /^Questions/ }).filter({ visible: true }).first().click(); await showAll(page); await next(page, 1);
      await into(page, pager(page)); await check(page, null, await pager(page).innerText());
    });
    await shoot(`pl-search-${theme}`, TALL, theme, async page => {
      await panel(page); await page.getByRole("button", { name: "Search activity", exact: true }).filter({ visible: true }).first().click();
      await page.keyboard.type("staging"); await page.waitForTimeout(800); await into(page, pager(page)); await check(page);
    });
    await shoot(`pl-tasks-${theme}`, TALL, theme, async page => {
      await panel(page); { const f = page.getByRole("button", { name: /^Agent's tasks, / }).filter({ visible: true }).first(); await f.waitFor({ timeout: 60000 }); if (await f.getAttribute("aria-expanded") !== "true") await f.click(); } await pager(page).waitFor();
      await next(page, 1); await into(page, pager(page)); await check(page, null, await pager(page).innerText());
    });
    const phone = async page => {
      await panel(page); await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await activity(page).waitFor({ timeout: 60_000 }); await page.setViewportSize(PHONE); await activity(page).waitFor({ timeout: 60_000 });
    };
    await shoot(`pl-phone-page1-${theme}`, PHONE, theme, async page => { await phone(page); await showAll(page); await into(page, pager(page)); await check(page, PHONE, await pager(page).innerText()); });
    await shoot(`pl-phone-page3-${theme}`, PHONE, theme, async page => { await phone(page); await showAll(page); await next(page, 2); await into(page, pager(page)); await check(page, PHONE, await pager(page).innerText()); });
  }
}

async function prScaleShots({ shoot }) {
  const spec = PR_SCALE_STATES[0];
  const TALL = { width: DESKTOP.width, height: 1100 };
  const healthy = async (page, vp) => {
    const body = await page.evaluate(() => document.body.innerText);
    const bad = body.match(/Too big|Too small|expected array|Invalid input|Something went wrong/i);
    if (bad) throw new Error(`pr-scale: the page shows "${bad[0]}"`);
    if (vp?.width === PHONE.width && await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("pr-scale: the phone page scrolls sideways");
  };
  const row = (page, n) => page.getByRole("button", { name: new RegExp(`^Pull request ${n}: `) }).filter({ visible: true }).first();
  const panel = async page => {
    await page.setViewportSize(TALL); await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await fold(page).waitFor({ timeout: 60_000 });
  };
  // The top PR (#1120) sits in the first "+4 in review" fold (a-long-stack-shows-its-problems): shots that need a row
  // on screen use #1116, the top failing PR, which keeps its row.
  const SHOWN = 1116;
  const fold = page => page.getByRole("button", { name: /^Show \d+ PRs in review, / }).filter({ visible: true }).first();
  const home = async (page, vp) => { await openHome(page); if (vp) await page.setViewportSize(vp); await (await homeRow(page, spec.title)).click(); await page.getByText(spec.title).filter({ visible: true }).first().waitFor(); };
  for (const theme of ["light", "dark"]) {
    await shoot(`ps-panel-top-${theme}`, TALL, theme, async page => { await panel(page); await healthy(page); });
    await shoot(`ps-panel-middle-${theme}`, TALL, theme, async page => { await panel(page); const r = row(page, 1058); await r.evaluate(el => el.scrollIntoView({ block: "center" })); await healthy(page); });
    await shoot(`ps-panel-end-${theme}`, TALL, theme, async page => {
      await panel(page);
      const r = row(page, PR_SCALE.bottom); await r.evaluate(el => el.scrollIntoView({ block: "center" }));
      const web = page.getByRole("button", { name: /^Pull request 1221: / }).filter({ visible: true }).first();
      if (await web.isVisible().catch(() => false)) await web.evaluate(el => el.scrollIntoView({ block: "end" }));
      await healthy(page);
    });
    await shoot(`ps-home-${theme}`, DESKTOP, theme, async page => { await home(page); await healthy(page); });
    await shoot(`ps-home-phone-${theme}`, PHONE, theme, async page => { await home(page, PHONE); await healthy(page, PHONE); });
    await shoot(`ps-sheet-${theme}`, TALL, theme, async page => {
      await panel(page); await row(page, SHOWN).click();
      await page.getByText(`Pull request #${SHOWN}`).first().waitFor();
      await page.waitForTimeout(500); await healthy(page);
    });
    await shoot(`ps-sheet-phone-${theme}`, PHONE, theme, async page => {
      // Home's phone pane lists no PRs: open the sheet from the panel, then narrow to the phone (as tasks-phone does).
      await panel(page); await row(page, SHOWN).click();
      await page.getByText(`Pull request #${SHOWN}`).first().waitFor();
      await page.setViewportSize(PHONE); await page.getByText(`Pull request #${SHOWN}`).filter({ visible: true }).first().waitFor();
      await page.waitForTimeout(500); await healthy(page, PHONE);
    });
    // The quiet fold (a-long-stack-shows-its-problems): its first "+N in review" row closed, then expanded in place.
    await shoot(`ps-fold-closed-${theme}`, TALL, theme, async page => { await panel(page); await fold(page).evaluate(el => el.scrollIntoView({ block: "center" })); await healthy(page); });
    await shoot(`ps-fold-open-${theme}`, TALL, theme, async page => {
      await panel(page); const f = fold(page); const name = await f.getAttribute("aria-label"); await f.click();
      const hide = page.getByRole("button", { name: name.replace(/^Show/, "Hide") }).filter({ visible: true }).first();
      await hide.waitFor(); await hide.evaluate(el => el.scrollIntoView({ block: "start" })); await healthy(page);
    });
    // The stack bar (stack-bar-reads-at-any-size), cropped close at 2x so each mark can be read.
    const barClip = async page => {
      const bar = page.getByRole("progressbar", { name: /PRs merged$/ }).filter({ visible: true }).first();
      await bar.waitFor(); const b = await bar.boundingBox();
      return { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 64), width: b.width + 48, height: b.height + 96 };
    };
    await shoot(`ps-bar-${theme}`, TALL, theme, async page => { await panel(page); await healthy(page); return barClip(page); }, { scale: 2 });
    // The panel on a phone: the larger view (Paseo's screen), opened at desktop then narrowed.
    const phonePanel = async page => {
      await panel(page); await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await row(page, SHOWN).waitFor({ timeout: 60_000 }); await page.setViewportSize(PHONE); await row(page, SHOWN).waitFor({ timeout: 60_000 });
    };
    await shoot(`ps-panel-phone-${theme}`, PHONE, theme, async page => { await phonePanel(page); await page.evaluate(() => window.scrollTo(0, 0)); await healthy(page, PHONE); });
    await shoot(`ps-fold-phone-${theme}`, PHONE, theme, async page => { await phonePanel(page); await fold(page).evaluate(el => el.scrollIntoView({ block: "center" })); await healthy(page, PHONE); });
    await shoot(`ps-bar-phone-${theme}`, PHONE, theme, async page => { await phonePanel(page); await healthy(page, PHONE); return barClip(page); }, { scale: 3 });
    // The chat's brief card beside the panel (a-brief-without-an-ask-never-sits-beside-needs-you): it points at Needs
    // you, never "No ask stated". Desktop with the panel open, and the phone's chat.
    const card = page => page.getByText(/^(Needs you: |Waiting on your answer to |No ask stated)/).filter({ visible: true }).last();
    const noBareCard = async page => { if (await page.getByText("No ask stated", { exact: true }).filter({ visible: true }).count()) throw new Error("pr-scale: the chat card says No ask stated beside Needs you"); };
    await shoot(`ps-chat-${theme}`, TALL, theme, async page => { await panel(page); await card(page).waitFor({ timeout: 60_000 }); await card(page).evaluate(el => el.scrollIntoView({ block: "center" })); await noBareCard(page); await healthy(page); });
    await shoot(`ps-chat-phone-${theme}`, PHONE, theme, async page => {
      await page.setViewportSize(TALL); await openChat(page, spec.title, spec.prompt); await page.setViewportSize(PHONE);
      await card(page).waitFor({ timeout: 60_000 }); await card(page).evaluate(el => el.scrollIntoView({ block: "center" })); await noBareCard(page); await healthy(page, PHONE);
    });
    // A normal 3-PR workspace (Billing retries) on the same surfaces, so small stacks don't regress: one mark per PR,
    // no fold, the chip and the sheet as before.
    const small = WORKSPACES.find(w => w.key === "billing");
    const smallPanel = async page => { await page.setViewportSize(TALL); await openChat(page, small.title, small.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await row(page, 142).waitFor({ timeout: 60_000 }); };
    const noFold = async page => { if (await fold(page).count()) throw new Error("pr-scale: a 3-PR stack shows a quiet fold"); };
    await shoot(`ps-small-panel-${theme}`, TALL, theme, async page => { await smallPanel(page); await noFold(page); await healthy(page); });
    await shoot(`ps-small-bar-${theme}`, TALL, theme, async page => { await smallPanel(page); return barClip(page); }, { scale: 2 });
    await shoot(`ps-small-panel-phone-${theme}`, PHONE, theme, async page => {
      await smallPanel(page); await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await row(page, 142).waitFor({ timeout: 60_000 }); await page.setViewportSize(PHONE); await row(page, 142).waitFor({ timeout: 60_000 }); await noFold(page); await healthy(page, PHONE);
    });
    const smallHome = async (page, vp) => { await openHome(page); if (vp) await page.setViewportSize(vp); await (await homeRow(page, small.title)).click(); await page.getByText("Only network failures").filter({ visible: true }).first().waitFor(); };
    await shoot(`ps-small-home-${theme}`, DESKTOP, theme, async page => { await smallHome(page); await healthy(page); });
    await shoot(`ps-small-home-phone-${theme}`, PHONE, theme, async page => { await smallHome(page, PHONE); await healthy(page, PHONE); });
    await shoot(`ps-small-sheet-${theme}`, TALL, theme, async page => { await smallPanel(page); await row(page, 142).click(); await page.getByText("Pull request #142").first().waitFor(); await page.waitForTimeout(500); await healthy(page); });
    await shoot(`ps-small-sheet-phone-${theme}`, PHONE, theme, async page => {
      await smallPanel(page); await row(page, 142).click(); await page.getByText("Pull request #142").first().waitFor();
      await page.setViewportSize(PHONE); await page.getByText("Pull request #142").filter({ visible: true }).first().waitFor(); await page.waitForTimeout(500); await healthy(page, PHONE);
    });
  }
}

async function rowChipShots({ shoot, out }) {
  const checks = [];
  const check = (name, okay, detail) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`rowchips: ${name}`); log(`rowchips check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const NARROW = { width: 1024, height: 760 };
  /** Every row's chip and time boxes, from CDP's DOM.getBoxModel (border box, CSS px). */
  const measure = async page => {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const box = async nodeId => {
        const m = await cdp.send("DOM.getBoxModel", { nodeId }).catch(() => null);
        if (!m) return null;
        const q = m.model.border; const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
        return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
      };
      const all = async (nodeId, selector) => (await cdp.send("DOM.querySelectorAll", { nodeId, selector })).nodeIds;
      const rows = [];
      for (const row of await all(root.nodeId, '[id^="follow-up-row-"]')) {
        const [time] = await all(row, '[data-testid="follow-up-row-time"]');
        const chips = await all(row, '[data-testid="follow-up-row-chip"]');
        if (!time || !chips.length) continue;
        const [rail] = await all(row, '[data-testid="follow-up-row-chips"]');
        const clip = rail ? await box(rail) : null;
        const visible = [];
        for (const chip of chips) {
          const b = await box(chip); if (!b) continue;
          // What the rail's overflow clip leaves of the chip (no rail: the whole chip).
          const v = clip ? { x1: Math.max(b.x1, clip.x1), y1: Math.max(b.y1, clip.y1), x2: Math.min(b.x2, clip.x2), y2: Math.min(b.y2, clip.y2) } : b;
          if (v.x2 - v.x1 > 0.5 && v.y2 - v.y1 > 0.5) visible.push(v);
        }
        rows.push({ row: await box(row), time: await box(time), chips: visible, total: chips.length });
      }
      return rows;
    } finally { await cdp.detach().catch(() => {}); }
  };
  const narrowTo = async (page, list) => {
    const split = await page.locator('[data-testid="follow-up-home-split"]').boundingBox();
    await page.locator('[data-testid="follow-up-home-split-side"]').evaluate((el, w) => el.style.setProperty("width", `${w}px`, "important"), Math.round(split.width - list));
    await page.waitForTimeout(400);
    const side = await page.locator('[data-testid="follow-up-home-split-side"]').boundingBox();
    return Math.round(split.width - side.width);
  };
  const overlaps = (a, b) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0.5;
  await shoot("rowchips-check", NARROW, "dark", async page => {
    await openHome(page); await page.setViewportSize(NARROW); check("the window is 1024 px wide", (await page.evaluate(() => window.innerWidth)) === 1024, {}); await page.waitForTimeout(600);
    for (const list of [400, 360, 320]) {
      const got = await narrowTo(page, list);
      const rows = await measure(page);
      const bad = rows.filter(r => r.chips.some(ch => overlaps(ch, r.time)) || r.time.x2 > r.row.x2 + 0.5)
        .map(r => ({ time: [Math.round(r.time.x1), Math.round(r.time.x2)], chips: r.chips.map(ch => [Math.round(ch.x1), Math.round(ch.x2)]) }));
      check(`list ${list} px: no row's chips cover its time`, rows.length > 0 && Math.abs(got - list) <= 2 && bad.length === 0, { list: got, rows: rows.length, bad });
      check(`list ${list} px: every chipped row still shows a chip`, rows.length > 0 && rows.every(r => r.chips.length > 0), { shown: rows.map(r => `${r.chips.length}/${r.total}`) });
      if (list === 320) await shoot.now("rowchips-list320-dark", page, "dark");
    }
  });
  // The renders: a 1024 window as it opens, and a wide window with the list at its minimum (480).
  await shoot("rowchips-1024-dark", NARROW, "dark", async page => { await openHome(page); await page.setViewportSize(NARROW); await page.waitForTimeout(600); });
  await shoot("rowchips-list480-check", DESKTOP, "dark", async page => {
    await openHome(page); const handle = page.getByRole("separator", { name: "Resize the detail pane" }); await handle.waitFor(); await page.waitForTimeout(600);
    await handle.focus(); await page.keyboard.press("End"); await page.waitForTimeout(500); await handle.blur();
    const split = await page.locator('[data-testid="follow-up-home-split"]').boundingBox();
    const side = await page.locator('[data-testid="follow-up-home-split-side"]').boundingBox();
    check("the list's minimum is 480 px", Math.abs(split.width - side.width - 480) <= 2, { list: Math.round(split.width - side.width) });
    await shoot.now("rowchips-list480-dark", page, "dark");
    // Back to the default share for any later shot.
    await handle.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  });
  await fs.writeFile(join(out, "rowchips.json"), JSON.stringify(checks, null, 2));
  log(`rowchips: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
}

async function splitShots({ shoot, seeded, call, out }) {
  const checks = [];
  const check = (name, okay, detail) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`split: ${name}`); log(`split check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const handle = page => page.getByRole("separator", { name: "Resize the detail pane" });
  const box = async page => {
    const split = await page.locator('[data-testid="follow-up-home-split"]').boundingBox();
    const h = await handle(page).boundingBox();
    return { total: split.width, pane: Math.round(split.x + split.width - (h.x + h.width / 2)), x: h.x + h.width / 2, y: h.y + h.height / 2 };
  };
  const ready = async page => { await openHome(page); await handle(page).waitFor(); await page.waitForTimeout(400); return box(page); };
  const agent = seeded.workspaces.find(w => w.key === "audit").agentId;
  const display = async () => (await actPlanned(call, agent, "display_settings", {})).values;
  // Starts from the default share.
  await actPlanned(call, agent, "set_display", { values: { home_detail_fraction: 0.42 } });
  for (const theme of ["dark", "light"]) {
    await shoot(`split-idle-${theme}`, DESKTOP, theme, async page => { await ready(page); });
    await shoot(`split-hover-${theme}`, DESKTOP, theme, async page => { const b = await ready(page); await page.mouse.move(b.x, b.y); await page.waitForTimeout(200); page.keepPointer = true; });
    await shoot(`split-focus-${theme}`, DESKTOP, theme, async page => { await ready(page); await handle(page).focus(); page.keepFocus = true; await page.waitForTimeout(200); });
    // Mid-drag: the frame is taken with the button still down.
    await shoot(`split-dropped-${theme}`, DESKTOP, theme, async page => {
      const b = await ready(page);
      await page.mouse.move(b.x, b.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(b.x - i * 20, b.y, { steps: 2 });
      await page.waitForTimeout(150);
      await shoot.now(`split-drag-${theme}`, page, theme);
      await page.mouse.up();
      // Back to the default for the next theme's shots.
      await page.waitForTimeout(800);
      await actPlanned(call, agent, "set_display", { values: { home_detail_fraction: 0.42 } });
    });
  }
  for (const theme of ["dark"]) {
    await shoot(`split-min-${theme}`, DESKTOP, theme, async page => { await ready(page); await handle(page).focus(); await page.keyboard.press("Home"); await page.waitForTimeout(300); const b = await box(page); check("Home on the handle takes the pane to its minimum", Math.abs(b.pane - 360) <= 2, { pane: b.pane }); await page.mouse.move(b.x, b.y); page.keepPointer = true; });
    await shoot(`split-max-${theme}`, DESKTOP, theme, async page => { await ready(page); await handle(page).focus(); await page.keyboard.press("End"); await page.waitForTimeout(300); const b = await box(page); check("End on the handle takes the pane to its maximum, leaving the list its minimum", Math.abs(b.total - b.pane - 480) <= 2, { pane: b.pane, total: b.total }); await page.mouse.move(b.x, b.y); page.keepPointer = true; });
  }
  await actPlanned(call, agent, "set_display", { values: { home_detail_fraction: 0.42 } });

  // The drag check, in one browser: drag, reload, then a fresh context.
  await shoot("split-check", DESKTOP, "dark", async page => {
    const before = await ready(page);
    check("default share drawn", Math.abs(before.pane - Math.round(0.42 * before.total)) <= 3, { pane: before.pane, total: before.total });
    await page.mouse.move(before.x, before.y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(before.x - i * 15, before.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const dragged = await box(page);
    check("a drag widens the pane by what it moved", Math.abs(dragged.pane - before.pane - 150) <= 4, { before: before.pane, after: dragged.pane });
    const want = Math.round(dragged.pane / dragged.total * 1000) / 1000;
    let saved; for (let i = 0; i < 20; i++) { saved = (await display()).home_detail_fraction; if (Math.abs(saved - want) <= 0.002) break; await new Promise(r => setTimeout(r, 250)); }
    check("the drag saved its share once, on release", Math.abs(saved - want) <= 0.002, { saved, want });
    await page.reload();
    const reloaded = await ready(page);
    check("the share survives a reload", Math.abs(reloaded.pane - dragged.pane) <= 3, { dragged: dragged.pane, reloaded: reloaded.pane });
    await handle(page).focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(300);
    const key = await box(page);
    check("ArrowRight narrows the pane by 2%", Math.abs(reloaded.pane - key.pane - Math.round(0.02 * key.total)) <= 3, { before: reloaded.pane, after: key.pane });
    await page.keyboard.press("Enter"); await page.waitForTimeout(600);
    const reset = await box(page);
    check("Enter resets to the default share", Math.abs(reset.pane - Math.round(0.42 * reset.total)) <= 3, { pane: reset.pane });
  });
  await actPlanned(call, agent, "set_display", { values: { home_detail_fraction: 0.55 } });
  await shoot("split-agent-set", DESKTOP, "dark", async page => {
    const b = await ready(page);
    check("an agent's set_display reaches Home", Math.abs(b.pane - Math.round(0.55 * b.total)) <= 3, { pane: b.pane, total: b.total });
  });
  // A narrow desktop window keeps both minimums; a phone draws no handle.
  await shoot("split-narrow-dark", { width: 1024, height: 760 }, "dark", async page => {
    await page.setViewportSize({ width: 1024, height: 760 }); await openHome(page); await page.waitForTimeout(600);
    const split = await page.locator('[data-testid="follow-up-home-split"]').boundingBox();
    const side = await page.locator('[data-testid="follow-up-home-split-side"]').boundingBox();
    // 704 px can't hold both minimums (360 + 480): the shortfall is shared and the divider has no handle.
    check("a narrow window shares the shortfall and keeps the list's share", split.width - side.width >= Math.floor(split.width * 480 / 840) - 1, { pane: side.width, total: split.width });
    check("a divider with nowhere to go draws no handle", (await handle(page).count()) === 0, {});
  });
  await shoot("split-phone-dark", PHONE, "dark", async page => {
    await openHome(page); await page.setViewportSize(PHONE); await page.waitForTimeout(500);
    check("phones draw no handle", (await handle(page).count()) === 0, {});
  });
  await actPlanned(call, agent, "set_display", { values: { home_detail_fraction: 0.42 } });
  await fs.writeFile(join(out, "split.json"), JSON.stringify(checks, null, 2));
  log(`split: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
}

/**
 * shortcut (every-shortcut-is-configurable-and-never-paseo-s): the search-from-anywhere key, end to end. Headless
 * Chromium on Linux is "not a Mac", so the default is Ctrl+Shift+K. From an agent chat with the cursor in the composer it
 * opens Home with the cursor in Home's search; on Home it only moves the cursor; with Paseo's sidebar collapsed (its own
 * Ctrl+B) it still works; None does nothing; Ctrl+Shift+K works by default and Ctrl+/ does nothing, also after a
 * reload. Renders: Settings → Inbox & display's Keyboard row, Home's search chip and the ⌘K row, light and dark.
 * Writes shortcut.json; any failed check fails the run.
 */
/**
 * the-selected-workspace-opens-with-enter (AGENTS.md invariant 57): every way of selecting a workspace on Home, then
 * Enter (or O), lands in its chat; Enter on another control stays that control's; S toggles the keys sheet. Renders:
 * Home after a search pick (the selection and Open full's ↵ hint), and the keys sheet, light and dark. Writes
 * `home-keys.json`.
 */
async function homeKeysShots({ shoot, out }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`home-keys: ${name}`); log(`home-keys check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const TITLE = "Contact import";
  const onHome = page => page.url().includes("/surface/follow-up");
  const settle = async (page, ok) => { for (let i = 0; i < 20; i++) { if (await ok()) return true; await page.waitForTimeout(150); } return false; };
  const search = page => page.getByRole("textbox", { name: /^(Search, or ask the Overseer|Search workspaces, branches, PRs)$/ }).filter({ visible: true }).first();
  const paneShows = page => page.getByRole("button", { name: "Open full" }).filter({ visible: true }).count().then(n => n > 0);
  const searchPick = async page => {
    await openHome(page);
    await page.keyboard.press("/");
    await search(page).fill(TITLE);
    await page.getByText(TITLE).filter({ visible: true }).first().waitFor();
    await page.keyboard.press("Enter");
    return settle(page, () => paneShows(page));
  };
  const leftForChat = async (page, before) => settle(page, async () => !onHome(page) || page.url() !== before);
  await shoot("home-keys-check", DESKTOP, "dark", async page => {
    // The search path: / (or ⌘⇧K), type, Enter shows it, Enter again opens it.
    check("search: the first Enter shows the result in the pane", await searchPick(page));
    const at = page.url();
    const where = () => page.evaluate(() => { const a = document.activeElement; return a === document.body ? "body" : `${a?.tagName}:${a?.getAttribute("aria-label") ?? a?.id ?? ""}`; });
    check("search: the first Enter stays on Home", onHome(page), { url: at, focus: await where() });
    await page.keyboard.press("Enter");
    check("search: Enter again opens the workspace's chat", await leftForChat(page, at), { url: page.url() });
    // Esc out of the search (clear, then leave): Enter opens the selection.
    await searchPick(page);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    const esc = page.url();
    check("search: Esc twice leaves the selection on Home", onHome(page) && await paneShows(page), { url: esc, focus: await where(), query: await search(page).inputValue() });
    await page.keyboard.press("Enter");
    check("after Esc out of the search, Enter opens the selection", await leftForChat(page, esc), { url: page.url() });
    // A click on the row, then Enter; and O.
    for (const key of ["Enter", "o"]) {
      await openHome(page);
      await (await homeRow(page, TITLE)).click(); await page.waitForTimeout(300);
      const before = page.url();
      await page.keyboard.press(key);
      check(`a clicked row opens with ${key}`, await leftForChat(page, before), { url: page.url() });
    }
    // Coming back to Home with a selection and nothing focused (Paseo's sidebar, or Home's own title).
    await openHome(page);
    await (await homeRow(page, TITLE)).click(); await page.waitForTimeout(300);
    await page.evaluate(() => (document.activeElement)?.blur?.());
    const body = page.url();
    await page.keyboard.press("Enter");
    check("with nothing focused, Enter opens the selection", await leftForChat(page, body), { url: page.url() });
    // Enter on another control stays that control's: the sort button opens its menu, Home stays.
    await openHome(page);
    await (await homeRow(page, TITLE)).click(); await page.waitForTimeout(300);
    const sort = page.getByRole("button", { name: /^Sort: / }).filter({ visible: true }).first();
    await sort.focus(); const stay = page.url();
    await page.keyboard.press("Enter"); await page.waitForTimeout(600);
    check("Enter on the sort button opens its menu and stays on Home", page.url() === stay && await page.getByRole("menu").filter({ visible: true }).count() > 0, { url: page.url() });
    await page.keyboard.press("Escape");
    // S toggles the keys sheet; S typed in the search types.
    await openHome(page); await page.waitForTimeout(300);
    await page.evaluate(() => (document.activeElement)?.blur?.());
    const sheet = () => page.getByRole("dialog", { name: "Home keys" }).filter({ visible: true }).count();
    await page.keyboard.press("s");
    check("S shows the keys", await settle(page, async () => await sheet() === 1));
    await page.keyboard.press("s");
    check("S again hides them", await settle(page, async () => await sheet() === 0));
    await page.keyboard.press("/"); await page.keyboard.type("s");
    check("S in the search types", await search(page).inputValue() === "s" && await sheet() === 0);
  });
  for (const theme of ["light", "dark"]) {
    await shoot(`home-keys-picked-${theme}`, DESKTOP, theme, async page => { await searchPick(page); page.keepFocus = true; });
    await shoot(`home-keys-sheet-${theme}`, DESKTOP, theme, async page => {
      await openHome(page); await (await homeRow(page, TITLE)).click(); await page.waitForTimeout(300);
      await page.evaluate(() => (document.activeElement)?.blur?.());
      await page.keyboard.press("s");
      await page.getByRole("dialog", { name: "Home keys" }).filter({ visible: true }).first().waitFor();
    });
  }
  // A run filtered to the renders (--shot '^home-keys-sheet') runs no checks: it leaves an earlier home-keys.json alone
  // rather than overwriting its record with an empty list.
  if (checks.length) await fs.writeFile(join(out, "home-keys.json"), JSON.stringify(checks, null, 2));
}

/**
 * New (`--only new`, docs/dispatch.md#the-dialog): every state of the dialog, desktop and phone, light and dark, from
 * the fake Linear list (newIssues); the four ways in (Home's + New, ⌘K, the sidebar row, the key in a browser tab and
 * in the desktop app); the Display setting; Home's row with Undo. Dispatches run on this harness daemon only, into
 * Git projects of its own. Writes new.json with every check.
 */
/**
 * Setup as a stranger meets it (`--only onboarding --variant <v>`, ONBOARDING_VARIANTS): every step at desktop and
 * 390x844, light and dark, the top of the step and, when it scrolls, its end. Checks on every frame: the step's
 * title and a live Continue or Finish (nothing dead-ends), no horizontal overflow, and no text that reads as a bug.
 * Writes onboarding-<variant>.json.
 */
async function shootOnboarding({ shoot, call }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`onboarding: ${name}`); log(`onboarding check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  // What the host looks like to setup, in the run's log and JSON: the evidence for each variant's frames.
  const host = await call("follow.onboarding-checks", { fresh: true });
  log("onboarding host:", host.checks.map(r => `${r.id}=${r.state}`).join(" "));
  checks.push({ name: "host", ok: true, rows: host.checks.map(r => ({ id: r.id, state: r.state, detail: r.detail })) });
  // The steps this host shows (shared/onboarding.ts setupSteps), from the same facts the client reads.
  const ghRow = host.checks.find(r => r.id === "gh");
  const repos = (await call("follow.pr-workflow", {})).repos.length;
  const npm = (await call("follow.updates", {})).installKind === "npm";
  const github = ghRow?.state === "ok" ? true : ghRow?.state === "off" ? false : null;
  const noProvider = host.checks.some(r => r.id === "providers");
  const steps = ONBOARDING_STEPS.filter(step => step === "shipping" ? github !== false && repos !== 0 : step === "reviewers" ? github !== false : step === "updates" ? npm : step === "helpers" ? !noProvider : true);
  log("onboarding steps:", steps.join(" "));
  checks.push({ name: "steps", ok: true, steps });
  const BROKEN = /undefined|NaN|\[object|null\b|Error:|TypeError|Something went wrong|Couldn't read Paseo/;
  for (const [i, step] of steps.entries()) {
    for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) for (const theme of ["light", "dark"]) {
      const name = `onb-${variantName}-${i + 1}-${step}-${device}-${theme}`;
      let end = null;
      await shoot(name, vp, theme, async page => {
        await call("follow.set-onboarding", { action: "step", step });
        await openHome(page, { keepDialogs: true });
        if (vp.width < 768) await page.setViewportSize(vp);
        // Setup is one popup (setup-is-one-popup): the intro is its welcome page, then the steps count from 1 without it.
        if (i === 0) await page.getByText("Welcome to Follow-up").first().waitFor();
        else await page.getByRole("progressbar", { name: `Step ${i} of ${steps.length - 1}` }).first().waitFor();
        // The checks step reads the host once; wait for its answers, never the "Checking…" placeholder.
        if (step === "checks") await page.getByText("Checking…").first().waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(600);
        const last = i === steps.length - 1;
        const move = i === 0 ? "Set up Follow-up" : last ? "Finish" : /^Continue( anyway)?$/;
        const go = page.getByRole("button", { name: move }).filter({ visible: true });
        check(`${name}: ${i === 0 ? "Set up Follow-up" : last ? "Finish" : "Continue"} is there and live`, await go.count() === 1 && await go.isEnabled());
        const text = await page.evaluate(() => document.body.innerText);
        const bad = text.match(BROKEN);
        check(`${name}: nothing reads as a bug`, !bad, bad ? { found: bad[0], near: text.slice(Math.max(0, bad.index - 80), bad.index + 80) } : {});
        const wide = await page.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth]);
        check(`${name}: no horizontal overflow`, wide[0] <= wide[1], { wide });
        // Does the step scroll? Its title's nearest scrolling ancestor.
        end = await page.evaluate(() => {
          const h = [...document.querySelectorAll('[role="heading"]')].find(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).fontSize === "20px");
          let el = h?.parentElement;
          while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          return el ? el.scrollHeight - el.clientHeight : 0;
        });
      });
      if (end > 40) await shoot(`${name}-end`, vp, theme, async page => {
        await call("follow.set-onboarding", { action: "step", step });
        await openHome(page, { keepDialogs: true });
        if (vp.width < 768) await page.setViewportSize(vp);
        if (i === 0) await page.getByText("Welcome to Follow-up").first().waitFor();
        else await page.getByRole("progressbar", { name: `Step ${i} of ${steps.length - 1}` }).first().waitFor();
        if (step === "checks") await page.getByText("Checking…").first().waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(600);
        await page.evaluate(() => {
          const h = [...document.querySelectorAll('[role="heading"]')].find(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).fontSize === "20px");
          let el = h?.parentElement;
          while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          el?.scrollTo(0, el.scrollHeight);
        });
        await page.waitForTimeout(300);
      });
    }
  }
  // Finish from the last step: Home, with nothing that reads broken.
  await shoot(`onb-${variantName}-9-home-desktop-light`, DESKTOP, "light", async page => {
    await call("follow.set-onboarding", { action: "finish" });
    await openHome(page);
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.body.innerText);
    const bad = text.match(BROKEN);
    check(`home after setup: nothing reads as a bug`, !bad, bad ? { found: bad[0] } : {});
  });
  await fs.writeFile(join(out, `onboarding-${variantName}.json`), JSON.stringify(checks, null, 2));
}

async function newShots({ shoot, call, out, home, billing }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`new: ${name}`); log(`new check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const linear = mode => fs.writeFile(join(home, "linear-fixture.json.mode"), mode);
  // New's default agent copies the Overseer's (Settings → Agents → New work, "Same as the Overseer"): the fixture provider here.
  await call("follow.set-agent-setting", { role: "overseer", entry: { provider: "followup-fixture", model: "fixture" } });
  const settings = await call("follow.dispatch-settings", {});
  const project = name => settings.projects.find(p => p.name === name || p.name.endsWith(`/${name}`));
  if (project("web")) await call("follow.set-dispatch-settings", { rules: { WEB: project("web").id } });
  // An action whose agent can't start: the agent-failure state (the workspace is archived again).
  await call("follow.set-dispatch-actions", { change: { op: "upsert", action: { id: "elsewhere", name: "Try elsewhere", icon: "play", description: "On a provider this host lacks",
    instructions: "Work on {title}.", agent: { provider: "no-such-provider" }, workspace: "worktree", branch: "title", follow: { goalFromSource: false, specFromArtifact: false, askWhenPlanReady: false }, appliesTo: ["issue"], hidden: false } } });

  const FIELD = "Task";
  const dialog = page => page.locator('[role="dialog"][aria-label="Dispatch"]').filter({ visible: true }).first();
  const row = (page, name) => dialog(page).getByRole("button", { name }).filter({ visible: true }).first();
  // A preview is up: its instructions toggle, or (project still to pick) the line standing in for the fields.
  const preview = page => dialog(page).getByText(/^((Show|Hide) instructions|From, branch and agent fill in once you pick a project\.)$/).filter({ visible: true }).first().waitFor();
  const narrow = async (page, vp) => { if (vp.width < 768) { await page.setViewportSize(vp); await page.waitForTimeout(300); } };
  const openFromHome = async (page, vp, { list = true } = {}) => {
    await openHome(page); await narrow(page, vp);
    await page.getByRole("button", { name: /^Dispatch( \(.+\))?$/ }).filter({ visible: true }).last().click();
    await dialog(page).waitFor();
    if (list) await row(page, /^WEB-31 Invoice/).waitFor();
  };
  const type = async (page, text) => { const f = dialog(page).getByRole("textbox", { name: FIELD }).first(); await f.fill(text); await page.waitForTimeout(250); };
  /** Phones: a row opens the preview screen; desktop: it selects in place. */
  const pick = async (page, name) => { await row(page, name).click(); await preview(page); };
  const primary = (page, name) => dialog(page).getByRole("button", { name }).filter({ visible: true }).first();
  // The harness's Paseo makes a worktree in 30 s or more (0.15: slower each time), so a dispatch gets three minutes.
  const DISPATCH_WAIT = 180_000;
  const startWords = async (page, vp, words, action = /^Create PR/) => {
    // A worktree-failure shot saves a base that doesn't exist; a shot that died before clearing it must not fail the rest.
    if (project("app")) await call("follow.set-dispatch-settings", { bases: { [project("app").id]: null } });
    await openFromHome(page, vp); await type(page, words);
    if (vp.width < 768) await row(page, /^Start from your words/).click();
    await preview(page);
    // Words with no last project ask which project (two projects here): pick app, as a developer would.
    // (Once app has been used, words guess it and there's nothing to pick.)
    const app = dialog(page).getByRole("button", { name: "Start in app" });
    if (await app.count()) await app.first().click();
    await primary(page, action).waitFor();
    return action;
  };

  // Linear down and Linear missing first: a failed list is never cached, an answered one is (for the worker's minute).
  for (const theme of ["light", "dark"]) for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await linear("error");
    await shoot(`new-fail-linear-${device}-${theme}`, vp, theme, async page => { await openFromHome(page, vp, { list: false }); await dialog(page).getByText("Couldn't read Linear").waitFor(); });
    await linear("missing");
    await shoot(`new-no-linear-${device}-${theme}`, vp, theme, async page => { await openFromHome(page, vp, { list: false }); await dialog(page).getByText(/once Linear is connected/).waitFor(); });
  }
  await linear("ok");

  let n = 0;
  for (const theme of ["light", "dark"]) for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    const name = state => `new-${state}-${device}-${theme}`;
    const phone = vp.width < 768;
    await shoot(name("issues"), vp, theme, async page => {
      await openFromHome(page, vp);
      if (!phone) { await preview(page); check(`${device} ${theme}: the first issue that can start is preselected (not one with a live workspace)`, await dialog(page).getByText("Invoice PDF rounds VAT wrong for CHF totals").count() >= 2); }
      check(`${device} ${theme}: an unruled team's row asks which project`, await dialog(page).getByText("→ which project?").count() > 0);
    });
    await shoot(name("search"), vp, theme, async page => { await openFromHome(page, vp); await type(page, "webhook"); await row(page, /^Search all of Linear/).waitFor(); });
    await shoot(name("url"), vp, theme, async page => { await openFromHome(page, vp); await type(page, "https://linear.app/example/issue/WEB-31/invoice-pdf-rounds-vat");
      check(`${device} ${theme}: a pasted key in the list selects that row`, await dialog(page).getByText("From your link").count() > 0);
      if (phone) await pick(page, /^WEB-31 /); else await preview(page); });
    await shoot(name("text"), vp, theme, async page => { await startWords(page, vp, "Add a CSV export to the audit log page. The finance team asked for it."); });
    // A real task's worth of words: the field grows with them (to about seven lines), the preview stays put while
    // typing (preview-stays-while-typing) and its first message says the words once (a-prompt-says-each-thing-once).
    await shoot(name("long"), vp, theme, async page => {
      await startWords(page, vp, "Add a CSV export to the audit log page. The finance team asked for it for the quarterly review, so include the actor, the action, the target and the time in the workspace's zone. Keep the existing filters: whatever the page shows is what the file holds. Large exports should stream rather than build in memory, and the button should say how many rows it will write.");
      if (!phone) {
        const field = dialog(page).getByRole("textbox", { name: FIELD }).first();
        const box = await field.boundingBox();
        // Taller than its 96 px start, with every line in view (no scroll inside the field).
        const hidden = await field.evaluate(el => el.scrollHeight - el.clientHeight);
        check(`${theme} ${device}: the task field is wide and grew with the words`, !!box && box.width >= 600 && box.height > 96 && hidden <= 1, { box, hidden });
        await dialog(page).getByText("Show instructions", { exact: true }).filter({ visible: true }).first().click();
        const message = (await dialog(page).getByText(/^Work on the task below\./).allInnerTexts())[0] ?? "";
        check(`${theme} ${device}: the first message says the words once`, message.split("Add a CSV export to the audit log page").length === 2, { message });
      }
    });
    await shoot(name("github"), vp, theme, async page => { await openFromHome(page, vp); await type(page, "https://github.com/example/app/issues/77"); if (phone) await pick(page, /^Pasted/); else await preview(page); });
    await shoot(name("existing"), vp, theme, async page => { await openFromHome(page, vp); await row(page, /^\d+ issues? already ha(s|ve) a workspace/).click(); await pick(page, /^APP-142 /);
      check(`${device} ${theme}: a source with a workspace offers Open it`, await primary(page, /^Open it/).count() > 0); });
    await shoot(name("ambiguous"), vp, theme, async page => { await openFromHome(page, vp); await pick(page, /^OPS-12 /); await dialog(page).getByText("Which project for OPS?").first().waitFor();
      check(`${device} ${theme}: ambiguous blocks every action`, await dialog(page).getByText("Pick a project first; the actions start there.").count() > 0); });
    await shoot(name("instructions"), vp, theme, async page => { await openFromHome(page, vp); if (phone) await pick(page, /^WEB-31 /); else await preview(page);
      if (phone) { const show = dialog(page).getByText("Show instructions", { exact: true }).filter({ visible: true }).first(); await show.evaluate(el => el.scrollIntoView({ block: "center" })); await show.click(); } else await page.keyboard.press("Control+i");
      await dialog(page).getByText("Follow-up then adds its usual workspace instructions.").waitFor(); });
    // A dispatch: its steps, then created (Open workspace, Undo), from the developer's words (a new workspace each time).
    await shoot(name("created"), vp, theme, async page => {
      const action = await startWords(page, vp, `Add a CSV export to the audit log page (${++n}).`);
      await primary(page, action).click();
      await dialog(page).getByText(/^(Starting|Started) /).first().waitFor();
      await shoot.now(name("dispatching"), page, theme);
      await dialog(page).getByText(/^Started /).waitFor({ timeout: DISPATCH_WAIT });
      check(`${device} ${theme}: created offers Undo`, await primary(page, /^Undo/).count() > 0);
    });
    await shoot(name("fail-worktree"), vp, theme, async page => {
      const action = await startWords(page, vp, `Fix the export button's spacing (${++n}).`);
      { const b = dialog(page).getByRole("button", { name: /^Base branch main/ }).filter({ visible: true }).first(); await b.scrollIntoViewIfNeeded(); await b.click(); }
      const base = dialog(page).getByRole("textbox", { name: "Base branch" }); await base.fill("release/no-such-branch"); await base.press("Enter");
      await dialog(page).getByRole("button", { name: /^Base branch release\/no-such-branch/ }).waitFor();
      await primary(page, action).click();
      await dialog(page).getByText(/didn't start$/).waitFor({ timeout: DISPATCH_WAIT });
      check(`${device} ${theme}: a worktree failure says nothing was created`, await dialog(page).getByText("Nothing was created.").count() > 0);
      if (project("app")) await call("follow.set-dispatch-settings", { bases: { [project("app").id]: null } });
    });
    await shoot(name("fail-agent"), vp, theme, async page => {
      await startWords(page, vp, `Tidy the audit log filters (${++n}).`);
      await primary(page, /^More/).click(); await dialog(page).getByRole("button", { name: "Try elsewhere" }).click();
      await dialog(page).getByText(/didn't start$/).waitFor({ timeout: DISPATCH_WAIT });
      check(`${device} ${theme}: an agent failure archives the workspace again`, await dialog(page).getByText(/archived again/).count() > 0);
    });
    // Home's row for the dispatches just made: Undo inside the window.
    await shoot(name("home-row"), vp, theme, async page => { await openHome(page); await narrow(page, vp); await page.getByRole("button", { name: /^Undo / }).filter({ visible: true }).first().waitFor(); });
  }
  // a-taken-issue-is-not-a-suggestion: APP-142 (linked by Billing retries) and APP-160 (named by Webhook signing's PR
  // title) fold into one last row; opened, each is muted and names its workspace, and ↵ opens it. All taken: one line.
  for (const [device, vp, theme] of [["desktop", DESKTOP, "light"], ["phone", PHONE, "dark"]]) {
    const phone = vp.width < 768;
    const fold = page => row(page, /^\d+ issues? already ha(s|ve) a workspace/);
    await shoot(`new-taken-folded-${device}-${theme}`, vp, theme, async page => {
      await openFromHome(page, vp); await fold(page).waitFor();
      check(`${device} ${theme}: a taken issue is not listed until the fold opens`, !(await dialog(page).getByRole("button", { name: /^APP-142 / }).filter({ visible: true }).count()) && !(await dialog(page).getByRole("button", { name: /^APP-160 / }).filter({ visible: true }).count()));
      if (!phone) { await preview(page); check(`${device} ${theme}: ↵ starts a free issue, never a taken one`, !(await primary(page, /^Open it/).count())); }
    });
    await shoot(`new-taken-open-${device}-${theme}`, vp, theme, async page => {
      await openFromHome(page, vp); await fold(page).click();
      await dialog(page).getByText("Webhook signing · running").first().waitFor();
      check(`${device} ${theme}: the PR-named issue names its workspace`, true);
      // Phones keep the list in view (picking opens the preview screen, which new-existing renders).
      if (!phone) { await pick(page, /^APP-160 /); check(`${device} ${theme}: a taken issue's ↵ is Open it`, await primary(page, /^Open it/).count() > 0); }
    });
  }
  await fs.writeFile(join(home, "linear-list.json"), JSON.stringify(newIssues().filter(i => ["APP-142", "APP-160"].includes(i.id))));
  await call("follow.dispatch-sources", { fresh: true });
  for (const [device, vp, theme] of [["desktop", DESKTOP, "light"], ["phone", PHONE, "dark"]]) await shoot(`new-taken-all-${device}-${theme}`, vp, theme, async page => {
    await openFromHome(page, vp, { list: false }); await dialog(page).getByText("Nothing new to start.").waitFor();
    if (vp.width >= 768) check(`${device} ${theme}: all taken, the fold is selected and says what ↵ does`, await dialog(page).getByText("shows them").count() > 0);
  });
  await fs.writeFile(join(home, "linear-list.json"), JSON.stringify(newIssues()));
  await call("follow.dispatch-sources", { fresh: true });

  // The ways in (desktop): Home's + New, ⌘K, the sidebar row, the key in a browser tab (Ctrl+Shift+O) and in the
  // desktop app (Ctrl+Shift+N; Chrome keeps Ctrl+Shift+N for incognito, so only the app gets it).
  for (const theme of ["light", "dark"]) {
    await shoot(`new-entry-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await page.getByRole("button", { name: /^Dispatch \(Ctrl\+Shift\+O\)$/ }).click(); await dialog(page).waitFor(); });
    await shoot(`new-entry-cmdk-${theme}`, DESKTOP, theme, async page => {
      await openHome(page); await page.keyboard.press("Control+k"); await page.keyboard.type("new");
      const item = page.getByText("Follow-up: Dispatch… (Ctrl+Shift+O)", { exact: true }).filter({ visible: true }).first();
      await item.waitFor(); await shoot.now(`new-cmdk-row-${theme}`, page, theme);
      await item.click(); await dialog(page).waitFor();
    });
    await shoot(`new-entry-sidebar-${theme}`, DESKTOP, theme, async page => {
      await openChat(page, billing.title, billing.prompt);
      const side = page.getByRole("button", { name: "Dispatch", exact: true }).filter({ visible: true }).first();
      await side.waitFor(); await side.click(); await dialog(page).waitFor();
      check(`${theme}: the sidebar row opens New`, true);
    });
    await shoot(`new-entry-key-${theme}`, DESKTOP, theme, async page => {
      await openChat(page, billing.title, billing.prompt);
      const composer = page.locator("textarea").filter({ visible: true }).last(); await composer.click(); await composer.fill("draft");
      await page.keyboard.press("Control+Shift+N"); await page.waitForTimeout(800);
      check(`${theme}: Ctrl+Shift+N does nothing in a browser tab`, await dialog(page).count() === 0);
      await page.keyboard.press("Control+Shift+O"); await dialog(page).waitFor();
      check(`${theme}: Ctrl+Shift+O opens New from a chat's composer in a browser tab`, true);
      await page.keyboard.press("Control+Shift+O"); await page.waitForTimeout(500);
      check(`${theme}: the key again closes New`, await dialog(page).count() === 0);
      await page.keyboard.press("Control+Shift+O"); await dialog(page).waitFor();
    });
    await shoot(`new-entry-key-app-${theme}`, DESKTOP, theme, async page => {
      await openChat(page, billing.title, billing.prompt);
      const composer = page.locator("textarea").filter({ visible: true }).last(); await composer.click();
      await page.keyboard.press("Control+Shift+N"); await dialog(page).waitFor();
      check(`${theme}: Ctrl+Shift+N opens New in the desktop app`, true);
    }, { init: () => { const ua = navigator.userAgent; Object.defineProperty(navigator, "userAgent", { get: () => `${ua} Electron/38.0.0` }); } });
    await shoot(`new-settings-${theme}`, DESKTOP, theme, async page => {
      await openSettingsAt(page, "display", DESKTOP);
      const r = page.getByText("Dispatch from anywhere", { exact: true }).filter({ visible: true }).first(); await r.waitFor(); await r.evaluate(el => el.scrollIntoView({ block: "center" }));
    });
    // Settings → New work, whole (a tall window, so every section is in one frame), and Agents → New work.
    for (const [device, vp] of [["desktop", { width: 1440, height: 1700 }], ["phone", { width: 390, height: 2300 }]]) {
      await shoot(`new-work-settings-${device}-${theme}`, vp, theme, async page => {
        if (project("app")) await call("follow.set-dispatch-settings", { bases: { [project("app").id]: "develop" } });
        // Frames open at desktop size: size the window first (tall, so every section is in one frame).
        await page.setViewportSize(vp);
        await openSettingsAt(page, "new", vp);
        await page.getByText("Where work goes", { exact: true }).filter({ visible: true }).first().waitFor();
        await page.getByText("Create PR", { exact: true }).filter({ visible: true }).first().waitFor();
        check(`${theme} ${device}: Settings → New work lists the actions with their keys`, await page.getByText("⌥↵", { exact: true }).filter({ visible: true }).count() > 0);
        check(`${theme} ${device}: an added action says so`, await page.getByText("Try elsewhere", { exact: true }).filter({ visible: true }).count() > 0 && await page.getByText("Added", { exact: true }).filter({ visible: true }).count() > 0);
        // A name is never cut: Add a rule's "Pick a project" shows whole (it once rendered "Pi…" squeezed beside the key).
        const pick = page.getByText("Pick a project", { exact: true }).filter({ visible: true }).first();
        check(`${theme} ${device}: Add a rule's project select shows "Pick a project" whole`, await pick.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().width >= 60).catch(() => false));
        check(`${theme} ${device}: WEB's rule is listed`, await page.getByText("WEB issues", { exact: true }).filter({ visible: true }).count() > 0);
        check(`${theme} ${device}: the saved base shows`, await page.getByRole("textbox", { name: /^Base for .*app$/ }).filter({ visible: true }).first().inputValue().catch(() => "") === "develop");
        await page.evaluate(() => window.scrollTo(0, 0));
      });
      // The states a resting frame doesn't show: an edited built-in (Reset to built-in), Delete asked in place, a rule
      // being added (both fields), a base edited but not saved (Save).
      await shoot(`new-work-states-${device}-${theme}`, vp, theme, async page => {
        const pr = (await call("follow.dispatch-actions", {})).actions.find(a => a.id === "pr");
        const { builtin: _b, by: _by, ...edit } = pr;
        await call("follow.set-dispatch-actions", { change: { op: "upsert", action: { ...edit, instructions: pr.instructions + "\nRun the linter before the PR." } } });
        await page.setViewportSize(vp);
        await openSettingsAt(page, "new", vp);
        await page.getByText("Reset to built-in", { exact: true }).filter({ visible: true }).first().waitFor();
        check(`${theme} ${device}: an edited built-in says Edited and offers Reset`, await page.getByText("Edited", { exact: true }).filter({ visible: true }).count() > 0);
        await page.getByRole("button", { name: "Delete", exact: true }).filter({ visible: true }).first().click();
        check(`${theme} ${device}: Delete asks in place`, await page.getByRole("button", { name: "Keep it", exact: true }).filter({ visible: true }).count() > 0);
        await page.getByRole("textbox", { name: "Team key" }).filter({ visible: true }).first().fill("ops");
        const base = page.getByRole("textbox", { name: /^Base for .*app$/ }).filter({ visible: true }).first();
        await base.fill("release");
        check(`${theme} ${device}: an edited base offers Save`, await page.getByRole("button", { name: /^Save/ }).filter({ visible: true }).count() > 0);
        await page.evaluate(() => window.scrollTo(0, 0));
      });
      await call("follow.set-dispatch-actions", { change: { op: "reset", id: "pr" } });
      await shoot(`new-work-agent-${device}-${theme}`, device === "phone" ? PHONE : DESKTOP, theme, async page => {
        await page.setViewportSize(device === "phone" ? PHONE : DESKTOP);
        await openSettingsAt(page, "agents", device === "phone" ? PHONE : DESKTOP);
        // The row's title, not the tab of the same name.
        const r = page.getByText("Starts the work you begin from Dispatch", { exact: false }).filter({ visible: true }).first(); await r.waitFor(); await r.evaluate(el => el.scrollIntoView({ block: "center" }));
        check(`${theme} ${device}: Agents → New work copies the Overseer by default`, await page.getByText("Same as the Overseer").filter({ visible: true }).count() > 0);
      });
    }
    if (project("app")) await call("follow.set-dispatch-settings", { bases: { [project("app").id]: null } });
  }

  // The sidebar row is optional (new-row-is-optional, docs/dispatch.md#the-sidebar-row-is-optional): its switch and
  // the Paseo tip in Settings → Dispatch, the sidebar with the row off (Home's + Dispatch still opens
  // it), and on again. `--shot '^new-row'` runs only these.
  const rowSwitch = page => page.getByRole("switch", { name: "Dispatch in the sidebar" }).filter({ visible: true }).first();
  const sideRow = page => page.getByRole("button", { name: "Dispatch", exact: true }).filter({ visible: true });
  const tip = page => page.getByText(/Paseo's own New workspace row starts an empty workspace/).filter({ visible: true });
  for (const theme of ["light", "dark"]) {
    for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await shoot(`new-row-settings-${device}-${theme}`, vp, theme, async page => {
        await page.setViewportSize(vp); await openSettingsAt(page, "new", vp);
        await rowSwitch(page).waitFor();
        check(`${theme} ${device}: Settings → Dispatch shows the row's switch, on`, await rowSwitch(page).getAttribute("aria-checked") === "true");
        check(`${theme} ${device}: the tip names where to hide Paseo's New workspace`, await tip(page).count() > 0 && await page.getByText(/Paseo Settings → Sidebar → Header/).filter({ visible: true }).count() > 0);
        // The section is the tab's last; show it with the Bases above it.
        await rowSwitch(page).scrollIntoViewIfNeeded();
      });
    }
    await shoot(`new-row-off-${theme}`, DESKTOP, theme, async page => {
      await openSettingsAt(page, "new", DESKTOP);
      await rowSwitch(page).click();
      await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="Dispatch in the sidebar"][aria-checked="true"]'));
      check(`${theme}: off, the tip goes too`, await tip(page).count() === 0);
      await openHome(page); await openChat(page, billing.title, billing.prompt); await page.waitForTimeout(800);
      check(`${theme}: off, the sidebar has no Dispatch row`, await sideRow(page).count() === 0);
      await openHome(page); await page.getByRole("button", { name: /^Dispatch \(Ctrl\+Shift\+O\)$/ }).click(); await dialog(page).waitFor();
      check(`${theme}: off, Home's + Dispatch still opens Dispatch`, true);
      await page.keyboard.press("Escape");
    });
    await shoot(`new-row-on-${theme}`, DESKTOP, theme, async page => {
      await openSettingsAt(page, "new", DESKTOP);
      await rowSwitch(page).click();
      await page.waitForFunction(() => !!document.querySelector('[role="switch"][aria-label="Dispatch in the sidebar"][aria-checked="true"]'));
      await openHome(page); await openChat(page, billing.title, billing.prompt); await sideRow(page).first().waitFor();
      check(`${theme}: on again, one Dispatch row`, await sideRow(page).count() === 1);
    });
  }
  await fs.writeFile(join(out, "new.json"), JSON.stringify({ checks }, null, 2));
}

async function shortcutShots({ shoot, seeded, call, out, billing }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`shortcut: ${name}`); log(`shortcut check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const agent = seeded.workspaces.find(w => w.key === "audit").agentId;
  const setKey = value => actPlanned(call, agent, "set_display", { values: { search_shortcut: value } });
  const SEARCH = /^(Search, or ask the Overseer|Search workspaces, branches, PRs)$/;
  const onHome = page => page.url().includes("/surface/follow-up");
  const searchFocused = page => page.evaluate(() => { const a = document.activeElement; return !!a && /^(Search, or ask the Overseer|Search workspaces, branches, PRs)$/.test(a.getAttribute("aria-label") ?? a.getAttribute("placeholder") ?? ""); });
  const settle = async (page, ok) => { for (let i = 0; i < 20; i++) { if (await ok()) return true; await page.waitForTimeout(150); } return false; };
  const inComposer = async page => {
    await openChat(page, billing.title, billing.prompt);
    const composer = page.locator("textarea").filter({ visible: true }).last();
    await composer.click(); await composer.fill("draft");
    return composer;
  };
  await setKey("mod-shift-k");
  await shoot("shortcut-check", DESKTOP, "dark", async page => {
    await page.goto(ORIGIN); await page.getByText("Follow-up", { exact: true }).first().waitFor();
    await inComposer(page);
    const chatBefore = page.url();
    await page.keyboard.press("Control+/"); await page.waitForTimeout(800);
    check("Ctrl+/ does not open Home with the default key", page.url() === chatBefore && !await searchFocused(page));
    await page.keyboard.press("Control+Shift+K");
    check("Ctrl+Shift+K from the composer opens Home with the cursor in its search", await settle(page, async () => onHome(page) && await searchFocused(page)), { url: page.url() });
    // Already on Home, with the cursor elsewhere: only the cursor moves.
    await page.getByText("Morning brief", { exact: true }).first().click(); await page.waitForTimeout(300);
    const before = page.url();
    await page.keyboard.press("Control+Shift+K");
    check("on Home it only moves the cursor", await settle(page, () => searchFocused(page)) && page.url() === before, { before, after: page.url() });
    // Paseo's sidebar collapsed (its own Ctrl+B): the key needs no sidebar row.
    await inComposer(page);
    await page.keyboard.press("Control+b"); await page.waitForTimeout(400);
    const sidebarRow = await page.getByText("Follow-up", { exact: true }).filter({ visible: true }).count();
    await page.locator("textarea").filter({ visible: true }).last().click();
    await page.keyboard.press("Control+Shift+K");
    check("works with Paseo's sidebar collapsed", await settle(page, async () => onHome(page) && await searchFocused(page)), { sidebarRowsVisible: sidebarRow });
    await page.keyboard.press("Control+b"); await page.waitForTimeout(300);
    // None: nothing happens, and the composer keeps its draft.
    await setKey("none"); await page.reload();
    await inComposer(page);
    const chat = page.url();
    await page.keyboard.press("Control+Shift+K"); await page.waitForTimeout(800);
    check("None does nothing", page.url() === chat && !await searchFocused(page), { url: page.url() });
    // Ctrl+Shift+K: works, and Ctrl+/ no longer does; both after a reload too.
    await setKey("mod-shift-k"); await page.reload();
    for (const pass of ["after choosing it", "after a reload"]) {
      if (pass === "after a reload") await page.reload();
      await inComposer(page);
      const at = page.url();
      await page.keyboard.press("Control+/"); await page.waitForTimeout(800);
      check(`Ctrl+/ does nothing once Ctrl+Shift+K is chosen (${pass})`, page.url() === at, { url: page.url() });
      await page.keyboard.press("Control+Shift+K");
      check(`Ctrl+Shift+K opens Home's search (${pass})`, await settle(page, async () => onHome(page) && await searchFocused(page)), { url: page.url() });
    }
    await setKey("mod-shift-k");
  });
  // Renders: the settings row, Home's search chip, the ⌘K row; light and dark.
  for (const mac of [false, true]) for (const theme of ["light", "dark"]) {
    const suffix = `${mac ? "mac-" : ""}${theme}`;
    const label = mac ? "⌘⇧K" : "Ctrl+Shift+K";
    const options = mac ? { init: () => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }) } : {};
    await shoot(`shortcut-settings-${suffix}`, DESKTOP, theme, async page => {
      await openSettingsAt(page, "display", DESKTOP);
      const row = page.getByText("Search from anywhere", { exact: true }).filter({ visible: true }).first();
      await row.waitFor(); await row.evaluate(el => el.scrollIntoView({ block: "center" }));
      return { x: 400, y: 0, width: DESKTOP.width - 400, height: DESKTOP.height };
    }, options);
    await shoot(`shortcut-home-${suffix}`, DESKTOP, theme, async page => { await openHome(page); await page.getByRole("textbox", { name: SEARCH }).first().waitFor();
      const chip = page.getByText(label, { exact: true }).filter({ visible: true }).first();
      await chip.waitFor();
      const title = `${label} from anywhere · / on Home`;
      check(`${suffix}: Home hover title names both keys`, await page.getByTitle(title, { exact: true }).count() > 0);
      await page.getByTitle(title, { exact: true }).first().hover(); page.keepPointer = true;
      return { x: 320, y: 0, width: 840, height: 220 }; }, options);
    await shoot(`shortcut-cmdk-${suffix}`, DESKTOP, theme, async page => {
      await openHome(page); await page.keyboard.press(mac ? "Meta+k" : "Control+k");
      await page.keyboard.type("Follow-up: Search"); await page.getByText(`Follow-up: Search (${label})`, { exact: true }).first().waitFor();
    }, options);
  }
  await fs.writeFile(join(out, "shortcut.json"), JSON.stringify(checks, null, 2));
  log(`shortcut: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
}

/**
 * search-focus (every-search-request-lands-in-the-visible-search): every way to ask for Home's search (the
 * search-from-anywhere key, ⌘K "Follow-up: Search", `/`) ends with the caret in the search field the developer can
 * see, whatever was mounted, loading or focused before: Home closed, Home in the back history, Home open with focus on
 * a row, a pane button or the Overseer's reply box, Home still loading, Home also the sidebar view, Catch up, PR stats,
 * the queue, the log or Settings open, a second press, on a desktop window and at 390×844. Writes search-focus.json;
 * any failed check fails the run.
 */
async function searchFocusChecks({ shoot, out, billing }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`search-focus: ${name}`); log(`search-focus check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  // The search key as the platform sends it (Ctrl, or ⌘ in the Mac shots of section 12).
  let KEY = "Control+Shift+K";
  // The caret is in a Home search field that is on screen (hit-tested), not one kept mounted behind another screen.
  const state = page => page.evaluate(() => {
    const re = /^(Search, or ask the Overseer|Search or ask the Overseer|Search workspaces, branches, PRs)$/;
    const fields = [...document.querySelectorAll("input,textarea")].filter(e => re.test(e.getAttribute("aria-label") ?? e.getAttribute("placeholder") ?? ""));
    const shown = e => { const r = e.getBoundingClientRect(); if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false; const hit = document.elementFromPoint(r.left + Math.min(8, r.width / 2), r.top + r.height / 2); return !!hit && (hit === e || e.contains(hit) || hit.contains(e) || e.parentElement?.contains(hit)); };
    const a = document.activeElement;
    return { fields: fields.length, shownFields: fields.filter(shown).length, focusedSearch: fields.includes(a), focusedShown: fields.includes(a) && shown(a), value: fields.includes(a) ? a.value : null, active: a ? `${a.tagName}[${(a.getAttribute("aria-label") ?? a.getAttribute("placeholder") ?? "").slice(0, 40)}]` : null, url: location.pathname + location.search };
  });
  const landed = async page => { for (let i = 0; i < 25; i++) { const s = await state(page); if (s.focusedShown) return s; await page.waitForTimeout(120); } return state(page); };
  let vp = DESKTOP;
  // Navigation happens at desktop width (a phone's sidebar is a drawer); each press happens at the device's size.
  const press = async (page, name, how = "key") => {
    if (vp !== DESKTOP) { await page.setViewportSize(vp); await page.waitForTimeout(400); }
    if (how === "key") await page.keyboard.press(KEY);
    else if (how === "slash") await page.keyboard.press("/");
    else { await page.keyboard.press("Control+k"); await page.keyboard.type("Follow-up: Search"); await page.getByText(/^Follow-up: Search/).first().waitFor(); await page.keyboard.press("Enter"); }
    const s = await landed(page);
    check(name, s.focusedShown, s);
    if (vp !== DESKTOP) { await page.setViewportSize(DESKTOP); await page.waitForTimeout(300); }
    return s;
  };
  // A chat opened inside the app (Paseo's stack keeps what was before it mounted), the caret in its composer.
  const composer = async (page, keep = false) => { await openChat(page, billing.title, billing.prompt); if (vp !== DESKTOP && !keep) { await page.setViewportSize(vp); await page.waitForTimeout(300); } const c = page.locator("textarea").filter({ visible: true }).last(); await c.click(); await c.fill("draft"); if (vp !== DESKTOP && !keep) await page.setViewportSize(DESKTOP); };
  // Home opened inside the app: the sidebar's Follow-up row, never a page load.
  const appHome = async page => { await page.getByText("Follow-up", { exact: true }).filter({ visible: true }).first().click(); await page.getByRole("toolbar", { name: "Status", exact: true }).filter({ visible: true }).first().waitFor(); };
  for (const [device, size] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await shoot(`search-focus-${device}`, size, "dark", async page => {
      vp = size;
      // 1. Home closed: a fresh app, the caret in a chat's composer.
      await page.goto(ORIGIN); await page.getByText("Follow-up", { exact: true }).first().waitFor();
      await composer(page);
      await press(page, `${device}: from a chat with Home never opened`);
      // The caret in Home's search after the key from a chat, at the device's size (focus kept for the frame).
      if (vp !== DESKTOP) { await page.setViewportSize(vp); await page.waitForTimeout(400); }
      await shoot.now(`search-focus-caret-${device}`, page, "dark");
      if (vp !== DESKTOP) { await page.setViewportSize(DESKTOP); await page.waitForTimeout(300); }
      // 2. A second press with the caret moved away.
      await page.evaluate(() => document.activeElement?.blur?.());
      await press(page, `${device}: a second press on Home`);
      // 3. Home in the back history: Home and a chat, both opened inside the app.
      await appHome(page); await composer(page);
      await press(page, `${device}: from a chat with Home in the history`);
      // 4. Home twice in the history.
      await appHome(page); await composer(page);
      await press(page, `${device}: from a chat after Home was opened twice`);
      // 5. Home open, a row selected.
      await appHome(page);
      const row = page.getByText(billing.title, { exact: true }).filter({ visible: true }).last();
      if (await row.count()) { await row.click().catch(() => undefined); await page.waitForTimeout(400); }
      await press(page, `${device}: on Home with a row selected`);
      // 6. A button focused.
      await page.getByRole("button", { name: /^(Sort|Open full|Sign off)/ }).filter({ visible: true }).first().focus().catch(() => undefined);
      await press(page, `${device}: on Home with a button focused`);
      // 7. Catch up, PR stats, the queue and the log: Home's route with another view, opened inside the app (⌘K).
      for (const [view, command] of [["catchup", true], ["log", null], ["stats", null], ["queue", null]]) {
        // The palette highlights matches in spans, so pick its first row with Enter.
        if (command) { await page.keyboard.press("Control+k"); await page.keyboard.type("Follow-up: Catch up"); await page.waitForTimeout(600); await page.keyboard.press("Enter"); }
        else await page.goto(`${homeUrl(ORIGIN, SERVER_ID)}?param.view=${view}&param.n=${Date.now()}`);
        await page.waitForTimeout(1500);
        await press(page, `${device}: from ${view}`);
      }
      // 8. Settings.
      await openSettingsAt(page, "display", DESKTOP);
      await press(page, `${device}: from Follow-up settings`);
      // 9. Home still loading: the key the moment the app starts drawing Home.
      await page.goto(homeUrl(ORIGIN, SERVER_ID));
      await page.getByText("Follow-up", { exact: true }).first().waitFor({ state: "attached" });
      await press(page, `${device}: while Home is loading`);
      // 10. ⌘K "Follow-up: Search" from a chat with Home in the history, then `/` on Home.
      await composer(page);
      await press(page, `${device}: ⌘K Follow-up: Search from a chat`, "cmdk");
      await page.evaluate(() => document.activeElement?.blur?.());
      await press(page, `${device}: / on Home`, "slash");
      return null;
    });
  }
  // 11. Home is also the sidebar view (Paseo 0.16+): the key from a chat, with and without Home in the history.
  if (paseo016) await shoot("search-focus-sidebar", DESKTOP, "dark", async page => {
    vp = DESKTOP;
    await page.goto(`${ORIGIN}/settings/sidebar`);
    await page.getByText("Default view", { exact: true }).first().click();
    await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
    await page.goto(ORIGIN); await page.waitForTimeout(1500);
    await composer(page);
    await press(page, "sidebar view: from a chat");
    await composer(page);
    await press(page, "sidebar view: from a chat with Home in the history");
    return null;
  });
  // 12. The keys around the request (2026-11-26, 2.4.0-rc.0: "it goes to the follow up home but not focuses the search
  // box"), on a Mac (⌘, navigator.platform MacIntel) and elsewhere (Ctrl): the chord held past the key-repeat delay
  // (repeat keydowns, as a Mac sends while ⌘⇧K is held), a query typed the moment the key is pressed (it must end up in
  // the search), focus in a workspace's Follow-up panel, and Dispatch open on Home.
  for (const [os, mod] of [["mac", "Meta"], ["other", "Control"]]) await shoot(`search-focus-keys-${os}`, DESKTOP, "dark", async page => {
    vp = DESKTOP; KEY = `${mod}+Shift+K`;
    const hold = async () => {
      await page.keyboard.down(mod); await page.keyboard.down("Shift"); await page.keyboard.down("KeyK");
      for (let i = 0; i < 4; i++) { await page.waitForTimeout(35); await page.keyboard.down("KeyK"); }
      await page.keyboard.up("KeyK"); await page.keyboard.up("Shift"); await page.keyboard.up(mod);
    };
    const held = async name => { await hold(); const s = await landed(page); check(name, s.focusedShown, s); };
    await page.goto(ORIGIN); await page.getByText("Follow-up", { exact: true }).first().waitFor();
    await composer(page);
    await held(`${os}: the key held (auto-repeat) from a chat with Home never opened`);
    await shoot.now(`search-focus-caret-held-${os}`, page, "dark");
    await appHome(page); await composer(page);
    await held(`${os}: the key held from a chat with Home in the history`);
    // Type-ahead: the chord, then a query typed at once (before Home has drawn).
    for (const [where, before] of [["a chat with Home never opened", async () => { await page.goto(ORIGIN); await page.getByText("Follow-up", { exact: true }).first().waitFor(); await composer(page); }], ["a chat with Home in the history", async () => { await appHome(page); await composer(page); }]]) {
      await before();
      await page.keyboard.press(`${mod}+Shift+K`); await page.keyboard.type("acme");
      const s = await landed(page);
      check(`${os}: a query typed at once from ${where} lands in the search`, s.focusedShown && s.value === "acme", s);
      // The chat's draft kept its own words: nothing typed for the search went into it.
      await page.evaluate(() => document.activeElement?.blur?.());
    }
    // The developer's report (2026-11-26): a busy workspace's chat, its agent mid-turn, the caret in its composer.
    const busy = WORKSPACES.find(w => w.key === "audit");
    for (const [what, act] of [["held", hold], ["typed at once", async () => { await page.keyboard.press(`${mod}+Shift+K`); await page.keyboard.type("acme"); }]]) {
      await openChat(page, busy.title, busy.prompt);
      const c = page.locator("textarea").filter({ visible: true }).last(); await c.click(); await c.fill("draft");
      await act();
      const s = await landed(page);
      check(`${os}: the key ${what} from a running agent's chat composer`, s.focusedShown && (what === "held" || s.value === "acme"), s);
      if (what !== "held") await shoot.now(`search-focus-caret-typed-${os}`, page, "dark");
    }
    // A workspace's Follow-up panel, focus on a control inside it.
    await openChat(page, billing.title, billing.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const b = [...document.querySelectorAll('[role="button"],button')].filter(e => e.getBoundingClientRect().left > innerWidth / 2 && e.getBoundingClientRect().width > 0).pop(); b?.focus(); });
    await press(page, `${os}: from a workspace's Follow-up panel, a control in it focused`);
    // Dispatch open on Home: the request waits under the dialog, and lands when it closes.
    await appHome(page);
    await page.keyboard.press(`${mod}+Shift+O`);
    const dispatch = page.locator('[role="dialog"][aria-label="Dispatch"]').filter({ visible: true }).first();
    if (await dispatch.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      await page.keyboard.press(`${mod}+Shift+K`);
      await page.waitForTimeout(600);
      const under = await state(page);
      check(`${os}: with Dispatch open the caret stays in Dispatch`, !under.focusedSearch, under);
      await page.keyboard.press("Escape");
      await dispatch.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
      await press(page, `${os}: the key after Dispatch closed`);
    } else check(`${os}: Dispatch opened`, false);
    return null;
  }, os === "mac" ? { init: "Object.defineProperty(Navigator.prototype, 'platform', { get() { return 'MacIntel'; } });" } : undefined);
  await fs.writeFile(join(out, "search-focus.json"), JSON.stringify(checks, null, 2));
  log(`search-focus: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
}

/**
 * icon (follow-up-has-one-mark): every brand surface that draws FOLLOW_UP_ICON, cropped close so the glyph reads at its
 * real size: the sidebar row at 1x and 2x, the header button (with the Needs-you dot on the end dot), the panel tab, the
 * command center row, and the phone's sidebar drawer; light and dark. Committed to `docs/evidence/follow-up-icon/`.
 */
async function iconShots({ shoot, billing }) {
  const around = async (loc, pad) => {
    const b = await loc.boundingBox();
    if (!b) throw new Error("icon: the surface isn't on screen");
    const [l, t, r, d] = Array.isArray(pad) ? pad : [pad, pad, pad, pad];
    return { x: Math.max(0, b.x - l), y: Math.max(0, b.y - t), width: b.width + l + r, height: b.height + t + d };
  };
  const sidebarRow = page => page.getByText("Follow-up", { exact: true }).filter({ visible: true }).first();
  const openPanel = async page => {
    await openChat(page, "Billing retries", billing.prompt);
    const header = page.getByRole("button", { name: "Follow-up", exact: true }).last();
    await header.waitFor();
    return header;
  };
  for (const theme of ["light", "dark"]) {
    for (const scale of [1, 2]) await shoot(`icon-sidebar-${theme}-${scale}x`, DESKTOP, theme, async page => {
      await openHome(page); const row = sidebarRow(page); await row.waitFor();
      return around(row, [44, 70, 200, 70]);
    }, { scale });
    await shoot(`icon-header-${theme}`, DESKTOP, theme, async page => {
      const header = await openPanel(page); await checkNeedDot(page);
      return around(header, [24, 12, 24, 12]);
    }, { scale: 2 });
    await shoot(`icon-panel-${theme}`, DESKTOP, theme, async page => {
      const header = await openPanel(page); await header.click();
      await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor();
      const tab = page.getByText("Follow-up", { exact: true }).filter({ visible: true }).last();
      return around(tab, [180, 14, 80, 14]);
    }, { scale: 2 });
    await shoot(`icon-cmdk-${theme}`, DESKTOP, theme, async page => {
      await openPanel(page); await page.keyboard.press("Control+k");
      await page.keyboard.type("follow-up");
      const item = page.getByText(/open for this workspace/).filter({ visible: true }).first();
      await item.waitFor();
      return around(item, [180, 60, 320, 120]);
    }, { scale: 2 });
    await shoot(`icon-phone-${theme}`, PHONE, theme, async page => {
      await openHome(page); await page.setViewportSize(PHONE);
      // On a phone Home is full screen: its back arrow (top left) leaves Home for a Paseo page whose menu button (same
      // spot) opens the sidebar drawer.
      const home = page.getByText("Morning brief", { exact: true }).filter({ visible: true }).first();
      await home.waitFor();
      await page.mouse.click(28, 36);
      await home.waitFor({ state: "hidden" }); // Paseo's start page or new-workspace page, both with the menu button
      await page.mouse.click(28, 36);
      const row = sidebarRow(page); await row.waitFor();
      return { x: 0, y: Math.max(0, (await row.boundingBox()).y - 160), width: PHONE.width, height: 360 };
    });
  }
}

async function prLinkShots({ shoot, billing }) {
  const rows = [
    // Billing's #143 sits on #142, whose checks fail, so it has no Merge row (one Merge per ready stack): Search filters' #151.
    { key: "merge", title: "Search filters", prompt: WORKSPACES.find(w => w.key === "search").prompt, link: "Open pull request #151" },
    { key: "reviewers", title: REVIEW_MODE_STATES[0].title, prompt: REVIEW_MODE_STATES[0].prompt, link: "Open pull request #246" },
  ];
  const stepClock = async ms => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); await setDaemonClock(Math.round(c.fake + (Date.now() - c.real) * c.rate) + ms); };
  const runningNotFinished = async label => {
    await stepClock(5_000);
    let row = null;
    await until(`${label}: Webhook signatures working, not finished`, async () => {
      row = (await call("follow.inbox-list", {})).rows.find(r => r.agentId === w.agentId);
      return row?.status === "running" && !row.needs?.reasons.some(r => r.reason === "finished");
    }, { tries: 120, every: 500 }).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ status: row?.status, turnStartedAt: row?.turnStartedAt, needs: row?.needs, brief: row?.brief && { kind: row.brief.kind, source: row.brief.source, state: row.brief.state } })}`); });
  };

  const TALL = { width: DESKTOP.width, height: 1300 };
  for (const r of rows) for (const theme of ["light", "dark"]) {
    // The row may sit below the fold on a phone: bring it on screen.
    const settle = async page => { const link = page.getByRole("link", { name: r.link }).filter({ visible: true }).first(); await link.waitFor(); await link.scrollIntoViewIfNeeded(); };
    await shoot(`pl-${r.key}-panel-${theme}`, TALL, theme, async page => {
      await page.setViewportSize(TALL); await openChat(page, r.title, r.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await settle(page);
    });
    await shoot(`pl-${r.key}-home-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, r.title)).click(); await settle(page); });
  }
}

/**
 * merge-click (a-click-on-merge-merges): Search filters' "#151 is approved" row before the click, while it merges
 * (the fake gh takes 6 s) and after (the toast); Export filters' stack row, "Merge 3 PRs". The panel on desktop and
 * Home's detail pane on phone, light and dark. A merge leaves #151 open in the fake, and Follow-up offers it again 30 s
 * after the submit, so each theme waits that out before clicking again.
 */
async function mergeClickShots({ shoot, billing }) {
  const TALL = { width: DESKTOP.width, height: 1100 };
  const single = { title: "Search filters", prompt: WORKSPACES.find(w => w.key === "search").prompt, button: "Merge pull request #151", merged: /Merged #151/, gone: true };
  const stackRow = { title: MERGE_CLICK_STATES[0].title, prompt: MERGE_CLICK_STATES[0].prompt, button: "Merge 3 pull requests in order: #250, #251, then #252", merged: /Merged #250, #251, then #252/, header: "3 of 3 PRs merged" };
  const button = (page, name) => page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const panel = async (page, r) => { await page.setViewportSize(TALL); await openChat(page, r.title, r.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await button(page, r.button).waitFor({ timeout: 60_000 }); };
  const phone = async (page, r) => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, r.title)).click(); await button(page, r.button).waitFor({ timeout: 60_000 }); };
  // Before the click: both rows, both themes, desktop panel and phone.
  for (const theme of ["light", "dark"]) for (const [r, key] of [[single, "single"], [stackRow, "stack"]]) {
    await shoot(`mc-${key}-panel-${theme}`, TALL, theme, page => panel(page, r));
    await shoot(`mc-${key}-home-phone-${theme}`, PHONE, theme, page => phone(page, r));
  }
  // Held: Billing's #143 is approved but sits on #142, whose checks fail, so it has no Merge row; the Pull requests card
  // and Home's detail pane say what holds it, both numbers linked.
  const held = async page => { const line = page.getByText("#143 approved · waits on #142 (checks failed)").filter({ visible: true }).first(); await line.waitFor({ timeout: 60_000 }); await line.scrollIntoViewIfNeeded(); };
  await shoot("mc-held-panel-light", TALL, "light", async page => { await page.setViewportSize(TALL); await openChat(page, billing.title, billing.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await held(page); });
  await shoot("mc-held-home-phone-dark", PHONE, "dark", async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, billing.title)).click(); await held(page); });
  // The click: "Merging…" while the fake gh runs, then the toast with the row gone. A submitted merge hides its row
  // (Follow-up waits for GitHub), so each click uses its own PR: #151 on a phone in light, the stack on the panel in dark.
  const click = (r, theme, open, size) => async page => {
    await open(page, r); await button(page, r.button).click();
    await page.getByText(/Merging…/).filter({ visible: true }).first().waitFor();
    await shoot.now(`mc-merging-${size}-${theme}`, page, theme);
    await page.getByText(r.merged).filter({ visible: true }).first().waitFor({ timeout: 90_000 });
    // The toast shows once the header and rows read the merge (a-merge-outcome-reads-the-same-everywhere): catch the
    // toast beside them before it closes, then the settled frame.
    if (r.header) await page.getByRole("progressbar", { name: r.header }).filter({ visible: true }).first().waitFor({ timeout: 2_000 });
    // Home's Needs you drops the ask with the toast (the live store holds the merge's read): no "is approved" row left.
    if (r.gone) await page.getByText(/ is approved/).filter({ visible: true }).first().waitFor({ state: "hidden", timeout: 2_000 });
    await shoot.now(`mc-toast-${size}-${theme}`, page, theme);
  };
  await shoot("mc-done-home-phone-light", PHONE, "light", click(single, "light", phone, "home-phone"));
  await shoot("mc-done-panel-dark", TALL, "dark", click(stackRow, "dark", panel, "panel"));
  const receipts = { title: MERGE_CLICK_STATES[1].title, prompt: MERGE_CLICK_STATES[1].prompt, button: "Merge pull request #255", merged: /Merged #255/, header: "1 of 1 PRs merged" };
  await shoot("mc-done-panel-light", TALL, "light", click(receipts, "light", panel, "panel"));
  const digest = { title: MERGE_CLICK_STATES[2].title, prompt: MERGE_CLICK_STATES[2].prompt, button: "Merge pull request #256", merged: /Merged #256/, gone: true };
  await shoot("mc-done-home-phone-dark", PHONE, "dark", click(digest, "dark", phone, "home-phone"));
}

/**
 * reviewers-click (a-click-on-add-reviewers-asks, a-clicked-row-holds-its-place): five "Add reviewers to #N: Ravi and
 * Mina" rows. Before; the first click mid-request ("Requesting…", "Sending…" on a phone; the fake gh answers in 3.5 s); all five clicked one
 * after another while the first ones are still out; then every row "Requested", still in its place. The panel on
 * desktop and Home's detail pane on a phone, light and dark, each on its own workspace (a request is one-shot).
 */
async function reviewersClickShots({ shoot }) {
  const TALL = { width: DESKTOP.width, height: 1100 };
  const label = n => `Ask Ravi and Mina to review pull request #${n}`;
  const button = (page, n) => page.getByRole("button", { name: label(n), exact: true }).filter({ visible: true }).first();
  const order = async page => page.evaluate(() => [...document.querySelectorAll('[aria-label*=" pull request #"][aria-label*="Ravi and Mina"]')].filter(e => e.offsetParent).map(e => Number(/#(\d+)$/.exec(e.getAttribute("aria-label"))[1])));
  const open = { panel: async (page, w) => { await page.setViewportSize(TALL); await openChat(page, w.title, w.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); },
    phone: async (page, w) => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, w.title)).click(); } };
  for (const w of REVIEWERS_CLICK_STATES) {
    const [, size, theme] = w.key.split("-");
    const numbers = w.prs.map(([n]) => n);
    await shoot(`rc-${size}-${theme}`, size === "panel" ? TALL : PHONE, theme, async page => {
      await open[size](page, w);
      await button(page, numbers[0]).waitFor({ timeout: 60_000 });
      await button(page, numbers[0]).scrollIntoViewIfNeeded();
      await shoot.now(`rc-before-${size}-${theme}`, page, theme);
      const before = await order(page);
      await button(page, numbers[0]).click();
      // A phone's button keeps one short word ("Asking…"); the panel says "Requesting…".
      await page.getByText(size === "phone" ? "Sending…" : "Requesting…").filter({ visible: true }).first().waitFor();
      await shoot.now(`rc-requesting-${size}-${theme}`, page, theme);
      // The other four, one after another, while the first is still out: each click lands on the row it aims at.
      for (const n of numbers.slice(1)) { await button(page, n).click(); await page.waitForTimeout(250); }
      await shoot.now(`rc-five-${size}-${theme}`, page, theme);
      for (const n of numbers) await page.getByRole("button", { name: `Requested Ravi and Mina on pull request #${n}`, exact: true }).filter({ visible: true }).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      const after = await order(page);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`reviewers-click: rows moved: ${before} -> ${after}`);
    });
  }
}

/**
 * The harness's stand-in for Paseo's usePaseoDictation (a proposed plugin API; the harness's Paseo has none): wraps the
 * page's eval so Follow-up's client bundle gets `@getpaseo/plugin/client` plus a fake hook driven by
 * `window.__dictation` ({ status, unavailable, error, volume }; `emit(text)` delivers a transcript). Harness only:
 * nothing in the plugin reads a global, and without this the shots show what a Paseo without the hook shows.
 */
const FAKE_DICTATION = () => {
  const host = window.__dictation = { status: "idle", unavailable: null, error: null, volume: 0.6, texts: new Set(), bumps: new Set(), emit(text) { for (const f of host.texts) f(text); host.status = "idle"; host.bump(); }, bump() { for (const f of host.bumps) f(); } };
  const realEval = globalThis.eval;
  globalThis.eval = function (src) {
    const out = realEval(src);
    if (typeof out !== "function" || typeof src !== "string" || !src.includes("usePaseoDictation")) return out;
    return require => out(name => {
      const mod = require(name);
      if (name !== "@getpaseo/plugin/client") return mod;
      const React = require("react");
      const usePaseoDictation = ({ onText }) => {
        const [, set] = React.useState(0);
        React.useEffect(() => { const b = () => set(x => x + 1); host.bumps.add(b); host.texts.add(onText); return () => { host.bumps.delete(b); host.texts.delete(onText); }; }, [onText]);
        return { unavailable: host.unavailable, status: host.status, volume: host.volume, error: host.error,
          start: async () => { host.status = "listening"; host.bump(); }, stop: async () => { host.status = "transcribing"; host.bump(); }, cancel: async () => { host.status = "idle"; host.bump(); } };
      };
      return { ...mod, usePaseoDictation };
    });
  };
};

/**
 * dictation (docs/needs-you.md#catch-up, invariant dictated-text-lands-in-the-field): Catch up's mic on a Paseo with
 * dictation (FAKE_DICTATION): idle, listening, transcribing, the words landed in the field, and unavailable saying why;
 * phone and desktop, light and dark. Plus the keys sheet with V, and the same card on a Paseo without the hook.
 */
async function dictationShots({ shoot }) {
  const card = "fail with card_declined retry";
  const enter = async (page, size) => {
    await openHome(page); if (size === PHONE) await page.setViewportSize(PHONE);
    await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
    await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().waitFor();
    for (let i = 0; !(await page.locator("[data-catch-up-card]").getByText(card).filter({ visible: true }).first().isVisible()); i++) {
      if (i > 30) throw new Error(`dictation: no card shows ${card}`);
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(250);
    }
    await page.locator("[data-catch-up-card]").getByRole("radio", { name: /^Something else/ }).filter({ visible: true }).first().click();
    await page.waitForTimeout(500);
  };
  const mic = page => page.locator("[data-catch-up-card] [data-dictate]").filter({ visible: true }).first();
  const field = page => page.getByLabel(/^Your answer.*required$/).filter({ visible: true }).first();
  const set = (page, state) => page.evaluate(s => { Object.assign(window.__dictation, s); window.__dictation.bump(); }, state);
  const states = {
    idle: async page => { await mic(page).waitFor(); },
    listening: async page => { await mic(page).getByRole("button").first().click(); await page.getByText(/^Listening ·/).filter({ visible: true }).first().waitFor(); },
    transcribing: async page => { await mic(page).getByRole("button").first().click(); await mic(page).getByRole("button").first().click(); await page.getByText("Writing it down…").filter({ visible: true }).first().waitFor(); },
    landed: async page => {
      await field(page).fill("Retry soft declines once after a day.");
      await field(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
      await mic(page).getByRole("button").first().click(); await mic(page).getByRole("button").first().click();
      await page.evaluate(() => window.__dictation.emit("Hard declines go straight to dunning, and email the customer."));
      await page.waitForTimeout(400);
    },
    unavailable: async page => { await set(page, { unavailable: { reason: "not_ready", message: null } }); await mic(page).getByRole("button").first().click(); await page.getByText(/^Can't dictate/).filter({ visible: true }).first().waitFor(); },
    failed: async page => { await set(page, { error: "Microphone permission was denied." }); await page.getByText(/^Couldn't dictate/).filter({ visible: true }).first().waitFor(); },
  };
  for (const [key, drive] of Object.entries(states)) for (const [size, tag] of [[PHONE, "phone"], [DESKTOP, "desktop"]]) for (const theme of ["light", "dark"]) {
    await shoot(`cu-dict-${key}-${tag}-${theme}`, size, theme, async page => { await enter(page, size); await drive(page); }, { init: FAKE_DICTATION });
  }
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-dict-keys-sheet-desktop-${theme}`, DESKTOP, theme, async page => { await enter(page, DESKTOP); await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press("s"); await page.getByRole("dialog", { name: "Catch up keys" }).waitFor(); }, { init: FAKE_DICTATION });
  }
  // V from the card with no field open: Something else opens and listening starts, focus on the mic (V again stops).
  await shoot("cu-dict-key-v-desktop-dark", DESKTOP, "dark", async page => {
    await enter(page, DESKTOP);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("v");
    await page.getByText(/^Listening ·/).filter({ visible: true }).first().waitFor();
    page.keepFocus = true;
  }, { init: FAKE_DICTATION });
  // A Paseo without usePaseoDictation: the same card, no mic, no line, no space.
  for (const [size, tag] of [[PHONE, "phone"], [DESKTOP, "desktop"]]) await shoot(`cu-dict-nohook-${tag}-light`, size, "light", page => enter(page, size));
}

/**
 * catch-up (docs/design/catch-up.md, docs/needs-you.md#catch-up): Catch up driven the way the developer drives it.
 * Home's "Catch up · N" opens it; Skip walks the deck to a card; More context asks the card's agent for real
 * (follow.context-ask through the screen), and the answer comes back through follow.context-reply as that agent, so the
 * deck parks the workspace and brings it back as the next card. Phone 390×844 and desktop, light and dark.
 */
async function catchUpShots({ shoot, call, out }) {
  const entry = /^Catch up on \d+ things? that need you/;
  const visible = (page, what) => page.getByText(what).filter({ visible: true }).first();
  const enter = async (page, size, find) => {
    await openHome(page); if (size === PHONE) await page.setViewportSize(PHONE);
    await page.getByRole("button", { name: entry }).filter({ visible: true }).first().click();
    await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().waitFor();
    // A card is found by what only the card shows (its question's words, or its header), never the rail's labels.
    const here = () => typeof find === "string" ? page.locator("[data-catch-up-card]").getByText(find).filter({ visible: true }).first() : page.getByRole("heading", { name: find }).filter({ visible: true }).first();
    if (find) for (let i = 0; !(await here().isVisible()); i++) {
      if (i > 30) throw new Error(`catch-up: no card shows ${find}`);
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
  };
  const skips = async (page, n) => { for (let i = 0; i < n; i++) { await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(200); } await page.waitForTimeout(1000); };
  const finish = async page => {
    for (let i = 0; !(await visible(page, /^(All caught up|End of the deck)$/).isVisible()); i++) {
      if (i > 80) throw new Error("catch-up: the deck never finished");
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);
  };
  const more = page => page.getByRole("button", { name: /^More context$/ }).filter({ visible: true }).first().click();
  await shoot("cu-entry-phone-light", PHONE, "light", async page => { await openHome(page); await page.setViewportSize(PHONE); await page.getByRole("button", { name: entry }).filter({ visible: true }).first().waitFor(); });
  await shoot("cu-entry-desktop-dark", DESKTOP, "dark", async page => { await openHome(page); await page.getByRole("button", { name: entry }).filter({ visible: true }).first().waitFor(); });
  // The first cards of the deck in order, on a phone: Home's Needs-you order and each kind of card.
  for (let i = 0; i < 6; i++) await shoot(`cu-deck-${String(i).padStart(2, "0")}-phone-light`, PHONE, "light", async page => { await enter(page, PHONE); await skips(page, i); });
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-question-phone-${theme}`, PHONE, theme, page => enter(page, PHONE, "fail with card_declined retry"));
    await shoot(`cu-rail-desktop-${theme}`, DESKTOP, theme, page => enter(page, DESKTOP, "fail with card_declined retry"));
  }
  await shoot("cu-merge-phone-dark", PHONE, "dark", page => enter(page, PHONE, /Search filters/));
  await shoot("cu-more-phone-light", PHONE, "light", async page => { await enter(page, PHONE, "fail with card_declined retry"); await more(page); await visible(page, "I don't get it").scrollIntoViewIfNeeded(); });
  await shoot("cu-more-desktop-dark", DESKTOP, "dark", async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await more(page); await visible(page, "I don't get it").scrollIntoViewIfNeeded(); });
  // The real round trip: ask the card's agent, the deck moves on ("1 getting context"), the agent answers with
  // context_reply, and the workspace comes back as the very next card with the answer on it.
  for (const [size, theme, tag] of [[DESKTOP, "dark", "desktop"], [PHONE, "light", "phone"]]) {
    const askAgent = async page => {
      await enter(page, size, "When a CSV row matches an existing contact"); await more(page);
      await page.getByRole("button", { name: /^Ask (?!the Overseer)/ }).filter({ visible: true }).first().click();
      await visible(page, /^1 getting context$/).waitFor();
    };
    await shoot(`cu-asked-${tag}-${theme}`, size, theme, askAgent);
    await shoot(`cu-arrived-${tag}-${theme}`, size, theme, async page => {
      // Asking again while the first ask is open returns that one, so this page parks the same request.
      await askAgent(page);
      const asked = (await call("follow.context-list", {})).requests.filter(r => r.state === "asking").at(-1);
      if (!asked) throw new Error("catch-up: the ask wasn't recorded");
      await call("follow.context-reply", { agentId: asked.askedOf, requestId: asked.id, text: "A CSV row and a contact match when their emails match, ignoring case. **Update** keeps one contact per person and overwrites its name and phone; **skip** leaves the old values and drops the row. Update is safer for re-imports of the same list." });
      await page.getByText(/^1 getting context$/).filter({ visible: true }).first().waitFor({ state: "hidden", timeout: 30000 });
      await skips(page, 1); // the card on screen stays put; the answered one is the very next card
      await visible(page, /emails match/).waitFor({ timeout: 30000 });
      await page.waitForTimeout(600);
    });
  }
  // The keys (desktop): S shows the sheet, B picks by key, R and ↓ walk the queue, M then 2 picks a More context ask.
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-keys-sheet-desktop-${theme}`, DESKTOP, theme, async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await page.keyboard.press("s"); await page.getByRole("dialog", { name: "Catch up keys" }).waitFor(); });
  }
  await shoot("cu-keys-pick-desktop-dark", DESKTOP, "dark", async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await page.keyboard.press("b"); await page.waitForTimeout(400); });
  await shoot("cu-keys-rail-desktop-light", DESKTOP, "light", async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await page.keyboard.press("r"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); page.keepFocus = true; await page.waitForTimeout(400); });
  await shoot("cu-keys-more-desktop-dark", DESKTOP, "dark", async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await page.keyboard.press("m"); await page.keyboard.press("2"); await page.waitForTimeout(700); });
  // Tom's notes on beta.3. Once a card has an answer, Send to agent is on the move bar too.
  const pickB = page => page.locator("[data-catch-up-card]").getByRole("radio", { name: /^B\. / }).filter({ visible: true }).first().click();
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-footer-send-phone-${theme}`, PHONE, theme, async page => { await enter(page, PHONE, "fail with card_declined retry"); await pickB(page); await page.waitForTimeout(500); });
    await shoot(`cu-footer-send-desktop-${theme}`, DESKTOP, theme, async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await pickB(page); await page.waitForTimeout(500); });
  }
  // a-move-bar-action-opens-in-view: More context and Later open where you are, a sheet above the phone's bar (the
  // keyboard down and up, the ask box focused) and a popover on the desktop button. Nothing scrolls them into view here.
  const KB_UP = { width: PHONE.width, height: 508 };
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-more-sheet-phone-${theme}`, PHONE, theme, async page => { await enter(page, PHONE, "fail with card_declined retry"); await more(page); page.keepFocus = true; await page.waitForTimeout(600); });
    await shoot(`cu-more-sheet-kb-up-phone-${theme}`, KB_UP, theme, async page => {
      await enter(page, PHONE, "fail with card_declined retry"); await more(page);
      await page.getByLabel("What do you want to know?").filter({ visible: true }).first().focus();
      page.keepFocus = true; await page.setViewportSize(KB_UP); await page.waitForTimeout(800);
    });
    await shoot(`cu-more-popover-desktop-${theme}`, DESKTOP, theme, async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await more(page); page.keepFocus = true; await page.waitForTimeout(600); });
  }
  await shoot("cu-later-sheet-phone-dark", PHONE, "dark", async page => { await enter(page, PHONE, "fail with card_declined retry"); await page.getByRole("button", { name: /^Later$/ }).filter({ visible: true }).first().click(); page.keepFocus = true; await page.waitForTimeout(600); });
  await shoot("cu-later-popover-desktop-light", DESKTOP, "light", async page => { await enter(page, DESKTOP, "fail with card_declined retry"); await page.keyboard.press("l"); page.keepFocus = true; await page.waitForTimeout(600); });
  // a-focused-field-and-its-send-stay-in-view: writing your own answer on a phone, the keyboard down (390x844) and up
  // (390x508, the page resized for it). The bar steps aside; the field and its Send stay in view.
  for (const theme of ["light", "dark"]) for (const [kb, frame] of [["kb-down", PHONE], ["kb-up", KB_UP]]) {
    await shoot(`cu-own-${kb}-phone-${theme}`, frame, theme, async page => {
      await enter(page, PHONE, "fail with card_declined retry");
      await page.locator("[data-catch-up-card]").getByRole("radio", { name: /^Something else/ }).filter({ visible: true }).first().click();
      await page.getByLabel(/^Your answer.*required$/).filter({ visible: true }).first().fill("Retry soft declines once after a day; hard declines go straight to dunning.");
      page.keepFocus = true; if (kb === "kb-up") await page.setViewportSize(KB_UP); await page.waitForTimeout(800);
    });
  }
  // every-catch-up-key-works-wherever-focus-is (Tom, beta.4: "The keyboard shortcuts on the catch up page in desktop
  // don't work consistently"): after each thing a developer does on the screen, J must move to the next card. A miss
  // records where focus was. Writes catch-up-keys.json; any miss fails the run.
  await shoot("cu-keys-check", DESKTOP, "light", async page => {
    const checks = [];
    const at = () => page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().textContent();
    const focus = () => page.evaluate(() => { const a = document.activeElement; if (!a) return "none"; const near = a.closest?.("[data-catch-up-card],[data-catch-up-rail],[data-catch-up-card-moves],[data-move-result]"); return `${a.tagName.toLowerCase()}${a.getAttribute("role") ? `[role=${a.getAttribute("role")}]` : ""}${a.getAttribute("aria-label") ? `[${a.getAttribute("aria-label").slice(0, 40)}]` : ""}${near ? ` in ${[...near.attributes].map(x => x.name).filter(n => n.startsWith("data-")).join(",")}` : ""}${a === document.body ? " (body)" : ""}; mounted cards ${document.querySelectorAll("[data-catch-up-card]").length}, visible ${[...document.querySelectorAll("[data-catch-up-card]")].filter(x => x.checkVisibility()).length}; lists ${document.querySelectorAll("[data-list-keys]").length}`; });
    const probe = async (after, key = "j") => {
      const before = await at(); const where = await focus();
      await page.keyboard.press(key); await page.waitForTimeout(350);
      const moved = (await at()) !== before;
      checks.push({ after, key, ok: moved, focus: where });
      if (!moved) failures.push(`catch-up keys: ${key} did nothing after ${after} (focus: ${where})`);
      log(`catch-up keys ${moved ? "ok" : "MISSED"}: ${key} after ${after} (focus: ${where})`);
    };
    // B and M act through the card's own controls: B picks option B, M opens More context, in the card on screen.
    const visibleCard = () => page.locator("[data-catch-up-card]").filter({ visible: true }).first();
    const probeIn = async (after, key, acted) => {
      const where = await focus();
      await page.keyboard.press(key); await page.waitForTimeout(400);
      const ok = await acted();
      checks.push({ after, key, ok, focus: where });
      if (!ok) failures.push(`catch-up keys: ${key} did nothing after ${after} (focus: ${where})`);
      log(`catch-up keys ${ok ? "ok" : "MISSED"}: ${key} after ${after} (focus: ${where})`);
    };
    const pickB = after => probeIn(after, "b", async () => (await visibleCard().getByRole("radio", { name: /^B\. / }).first().getAttribute("aria-checked")) === "true");
    const moreM = async after => { await probeIn(after, "m", () => page.locator("[data-catch-up-more]").filter({ visible: true }).first().isVisible()); await page.keyboard.press("m"); await page.waitForTimeout(300); };
    await enter(page, DESKTOP);
    await probe("the page opens");
    await probe("J", "j"); await probe("K", "k"); await probe("Shift+J", "Shift+J");
    await enter(page, DESKTOP, "fail with card_declined retry");
    await page.locator("[data-catch-up-card]").getByRole("radio", { name: /^B\. / }).filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await probe("clicking an option");
    await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(200);
    await probe("clicking the screen header");
    await page.mouse.click(700, 900); await page.waitForTimeout(200);
    await probe("clicking empty space under the card");
    await page.locator("[data-catch-up-rail] [role=button]").filter({ visible: true }).nth(4).click(); await page.waitForTimeout(300);
    await probe("clicking a rail row");
    await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await probe("clicking Skip");
    await page.getByRole("button", { name: /^Back/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await probe("clicking Back");
    await page.getByRole("button", { name: /^More context$/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(400);
    await page.getByRole("button", { name: /^More context$/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await probe("More context opened and closed with its button");
    await page.keyboard.press("l"); await page.waitForTimeout(400); await page.mouse.click(700, 900); await page.waitForTimeout(300);
    await probe("Later opened and closed with a click outside");
    await page.keyboard.press("s"); await page.waitForTimeout(300); await page.keyboard.press("s"); await page.waitForTimeout(300);
    await probe("the keys sheet opened and closed");
    await page.mouse.move(900, 500); await page.mouse.wheel(0, 400); await page.waitForTimeout(300);
    await probe("scrolling the card");
    await page.getByText("Workspaces", { exact: true }).filter({ visible: true }).first().click(); await page.waitForTimeout(300);
    await probe("clicking Paseo's sidebar, then pressing the key");
    const other = await page.context().newPage(); await other.bringToFront(); await page.waitForTimeout(200); await other.close(); await page.bringToFront(); await page.waitForTimeout(300);
    await probe("the window losing and regaining focus");
    // Leave Catch up for a workspace in Paseo's sidebar, come back to Home and open Catch up again: a surface Paseo kept
    // mounted must not take the keys (or the clicks) of the one on screen.
    await page.getByRole("button", { name: /^Leave Catch up/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(400);
    await enter(page, DESKTOP, "fail with card_declined retry");
    await pickB("opening Catch up again from Home");
    await moreM("opening Catch up again from Home");
    await page.locator("[data-catch-up-rail] [role=button]").filter({ visible: true }).nth(2).click(); await page.waitForTimeout(300);
    await enter(page, DESKTOP, "fail with card_declined retry");
    await pickB("walking back to the question card");
    await page.keyboard.press("Control+k"); await page.waitForTimeout(400);
    await page.keyboard.type("Catch up on what needs you"); await page.waitForTimeout(500); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
    await probe("opening Catch up from the command center");
    // Paseo keeps the first Catch up mounted behind the new one: walk the one on screen to a question card by key and
    // act on it there, with both mounted.
    for (let i = 0; !(await visibleCard().getByRole("radio", { name: /^B\. / }).first().isVisible().catch(() => false)); i++) {
      if (i > 20) throw new Error("catch-up keys: no question card reached by J");
      await page.keyboard.press("j"); await page.waitForTimeout(300);
    }
    await pickB("the command center's Catch up, with the first one still mounted");
    await moreM("the command center's Catch up, with the first one still mounted");
    await fs.writeFile(join(out, "catch-up-keys.json"), JSON.stringify(checks, null, 2));
    log(`catch-up keys: ${checks.filter(c => c.ok).length}/${checks.length} acted`);
  });
  // Tom's notes, round 2: two skips named apart, and the phone drag. A card whose workspace has more cards left shows
  // Skip workspace beside the card's Skip ("Skip question"); ⇧J moves past the whole workspace.
  const skipWs = page => page.getByRole("button", { name: /^Skip this workspace's/ }).filter({ visible: true }).first();
  const toMany = async (page, size) => {
    await enter(page, size);
    for (let i = 0; !(await skipWs(page).isVisible()); i++) {
      if (i > 30) throw new Error("catch-up: no workspace with more than one card");
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(800);
  };
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-skips-phone-${theme}`, PHONE, theme, page => toMany(page, PHONE));
    await shoot(`cu-skips-desktop-${theme}`, DESKTOP, theme, async page => { await toMany(page, DESKTOP); await skipWs(page).hover(); await page.waitForTimeout(900); });
  }
  await shoot("cu-skip-workspace-done-desktop-light", DESKTOP, "light", async page => { await toMany(page, DESKTOP); await page.keyboard.press("Shift+J"); await page.waitForTimeout(800); });
  // A drag held halfway: the real gesture (mouse down, move left half the card, still held), so the card follows the
  // finger and the next card's peek shows underneath.
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-drag-half-phone-${theme}`, PHONE, theme, async page => {
      // The harness renders with reduced motion, where the drag rightly doesn't follow the finger: this shot wants motion.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await enter(page, PHONE, "fail with card_declined retry");
      const box = await page.locator("[data-catch-up-drag]").filter({ visible: true }).first().boundingBox();
      if (!box) throw new Error("catch-up: no draggable card");
      const y = box.y + 150; const x0 = box.x + box.width * 0.8;
      await page.mouse.move(x0, y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 - (box.width * 0.45) * i / 12, y + i * 0.3); await page.waitForTimeout(16); }
      await page.waitForTimeout(400);
      // Still held: the capture must not park the pointer, which would carry the drag on to the screen's edge.
      page.keepPointer = true;
    });
  }
  for (const theme of ["light", "dark"]) {
    await shoot(`cu-finished-phone-${theme}`, PHONE, theme, async page => { await enter(page, PHONE); await finish(page); });
    await shoot(`cu-finished-desktop-${theme}`, DESKTOP, theme, async page => { await enter(page, DESKTOP); await finish(page); });
  }
}

async function sendingShots({ shoot, seeded, call, home }) {
  // Q51 Home "Sending", light, desktop and phone (phones filter to Sending with its strip chip).
  // 1. Checkout copy's tasks wait for its agent's turn (no Send now); Saved views and Invoice PDFs are out with their
  //    agents (the send glyph); Onboarding email's tasks wait on the developer (Auto off), in Needs you only, said once.
  const ws = key => seeded.workspaces.find(w => w.key === key);
  await call("follow.control", { workspaceId: ws("sd-busy").workspaceId, enable_auto_sends: true });
  await until("Checkout copy queued behind its turn", async () => {
    await call("follow.refresh", {});
    return (await call("follow.list", {})).workspaces.find(x => x.id === ws("sd-busy").workspaceId)?.batches.some(b => b.state === "pending");
  }, { tries: 120, every: 500 });
  const busyLine = /sends when the main agent's turn ends/;
  const shown = (wait, phone) => async page => {
    await openHome(page);
    if (phone) { await page.setViewportSize(PHONE); await page.getByRole("button", { name: /^Sending, \d+\. Show only these/ }).first().click(); }
    for (const w of wait) await page.getByText(w).filter({ visible: true }).first().waitFor({ timeout: 90000 });
  };
  await shoot("sending-home-light", DESKTOP, "light", shown([busyLine, "2 repairs ready · auto-send is off here"]));
  await shoot("sending-home-phone-light", PHONE, "light", shown([busyLine], true));
  // The phone strip on its own row, scrolled to its end: every chip reachable, nothing over it (the version moved to
  // the end of the list).
  await shoot("sending-strip-phone-light", PHONE, "light", async page => {
    await openHome(page); await page.setViewportSize(PHONE);
    // The strip re-renders after the resize, so scroll it in the page (no stale handle): the toolbar or its
    // scrolling ancestor goes to its end, where "Later" sits.
    await page.getByRole("toolbar", { name: "Status" }).first().getByText("Later").first().waitFor();
    await until("the strip scrolls to its end", () => page.evaluate(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Status"]');
      for (let el = bar; el; el = el.parentElement) if (el.scrollWidth > el.clientWidth + 1) { el.scrollLeft = el.scrollWidth; return el.scrollLeft > 0; }
      return false;
    }), { tries: 40, every: 250 });
    await page.waitForTimeout(300);
  });
  // Q96 = A: a waiting repair says what it waits for, the same words on Home's detail, the panel and a phone, light and
  // dark: the main agent's turn, its permission prompt, Auto-send off (Needs you's Send), and a message out (sent).
  await call("follow.control", { workspaceId: ws("sd-perm").workspaceId, enable_auto_sends: true });
  await until("Refund reasons queued behind its permission prompt", async () => {
    await call("follow.refresh", {});
    return (await call("follow.list", {})).workspaces.find(x => x.id === ws("sd-perm").workspaceId)?.batches.some(b => b.state === "pending");
  }, { tries: 120, every: 500 });
  const mainWaits = [
    ["busy", SENDING_STATES[0], busyLine],
    // Home and a phone show the permission itself (Needs you) for this row; the panel's Tasks strip says the repair waits on it.
    ["permission", SENDING_STATES[1], /main agent's permission prompt is answered/, /Run the refund backfill on staging/],
    ["auto-off", WORKSPACES.find(w => w.key === "email"), /auto-send is off here/],
    ["sent", WORKSPACES.find(w => w.key === "views"), /is working on \d+ repairs?/],
  ];
  const see = async (page, words) => { const el = page.getByText(words).filter({ visible: true }).first(); await el.waitFor({ timeout: 90000 }); await el.scrollIntoViewIfNeeded(); };
  // Every surface that shows the main agent's wait offers Send now (a-repair-goes-to-a-free-main-agent).
  const sendNowShown = page => page.getByRole("button", { name: /^Send 2 repairs to Checkout copy now$/ }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  const TALL_PANEL = { width: 1440, height: 1100 };
  for (const theme of ["light", "dark"]) for (const [state, spec, words, onHome = words] of mainWaits) {
    await shoot(`mw-${state}-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await (await homeRow(page, spec.title)).click(); await see(page, onHome); if (state === "busy") await sendNowShown(page); });
    await shoot(`mw-${state}-panel-${theme}`, TALL_PANEL, theme, async page => { await page.setViewportSize(TALL_PANEL); await openChat(page, spec.title, spec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await see(page, words); if (state === "busy") await sendNowShown(page); });
    await shoot(`mw-${state}-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, spec.title)).click(); await see(page, onHome); if (state === "busy") await sendNowShown(page); });
  }
  // 2. The machine-wide hold: Paseo's (fake) cgroup at 78% of memory.high pauses auto-sends; one hold line at the top
  //    of Sending, the same words on both widths. Onboarding email is signed off and its Auto turned on: its agent is
  //    idle (the fixture's isn't loaded), so its Send stays in Needs you, said once ("The agent is idle; …").
  await fs.writeFile(process.env.FOLLOW_SHOTS_CGROUP, JSON.stringify({ high: 1000, current: 780 }));
  await until("the governor holds auto-sends", async () => (await call("follow.usage", {})).resources?.level === "constrained", { tries: 120, every: 500 });
  await call("follow.inbox-act", { action: "sign_off", agentIds: [ws("email").agentId] });
  await call("follow.control", { workspaceId: ws("email").workspaceId, enable_auto_sends: true });
  const held = [/^Auto-sends are paused on this machine/, busyLine];
  await shoot("sending-hold-home-light", DESKTOP, "light", shown([...held, "You haven't messaged this agent lately, so it waits for you"]));
  await shoot("sending-hold-home-phone-light", PHONE, "light", shown(held, true));
  // Onboarding email's Auto goes back off first, so its repair doesn't take the one turn step 3 stages.
  await call("follow.control", { workspaceId: ws("email").workspaceId, enable_auto_sends: false });
  await fs.writeFile(process.env.FOLLOW_SHOTS_CGROUP, JSON.stringify({ high: 1000, current: 100 }));
  await until("the governor lets auto-sends go", async () => (await call("follow.usage", {})).resources?.level !== "constrained", { tries: 120, every: 500 });
  // 3. Invariant 133: Repairs at once at 1. Tax rates' repair goes out on its own and its agent keeps working on it, so
  //    Coupon codes' repair waits for that turn: Home's detail and the panel's Messages strip, light and dark, a phone dark.
  await call("follow.set-follow-settings", { maxAutoSends: 1 });
  const holder = ws("sd-hold"); const queued = ws("sd-limit");
  const scriptsFile = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8"));
  scripts[`agent:${holder.agentId}`] = [think("Rebase on main, then move the rate lookup to the new table."), { hold: true }];
  await fs.writeFile(scriptsFile, JSON.stringify(scripts));
  const record = async w => (await call("follow.list", {})).workspaces.find(x => x.id === w.workspaceId);
  await call("follow.control", { workspaceId: holder.workspaceId, enable_auto_sends: true });
  // The clock crawls in the harness, so step it past the queue's quiet window once the repair is queued.
  const stepClock = async ms => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); await setDaemonClock(Math.round(c.fake + (Date.now() - c.real) * c.rate) + ms); };
  await until("Tax rates' repair is queued on its own", async () => { await call("follow.refresh", {}); return (await record(holder))?.batches.some(b => b.automatic); }, { tries: 240, every: 500 });
  await stepClock(5 * 60_000);
  await until("Tax rates' repair goes out on its own", async () => { await call("follow.refresh", {}); return (await record(holder))?.batches.some(b => b.state === "sent" && b.automatic); }, { tries: 240, every: 500 });
  // Its turn ended without an ask, so it would sit in Needs you; signed off, its row shows in Sending.
  await call("follow.inbox-act", { action: "sign_off", agentIds: [queued.agentId] });
  await call("follow.control", { workspaceId: queued.workspaceId, enable_auto_sends: true });
  await until("Coupon codes waits for a free turn", async () => { await call("follow.refresh", {}); return (await record(queued))?.sendWait === "limit"; }, { tries: 240, every: 500 });
  const limitLine = /waits until another workspace's repair finishes/;
  const limitSpec = SENDING_STATES.find(w => w.key === "sd-limit");
  for (const theme of ["light", "dark"]) {
    await shoot(`limit-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await (await homeRow(page, limitSpec.title)).click(); await see(page, limitLine); });
    await shoot(`limit-panel-${theme}`, TALL_PANEL, theme, async page => { await page.setViewportSize(TALL_PANEL); await openChat(page, limitSpec.title, limitSpec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await see(page, limitLine); });
  }
  await shoot("limit-phone-dark", PHONE, "dark", async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, limitSpec.title)).click(); await see(page, limitLine); });
}
/**
 * advanced (Q177, invariant 133): Settings → Following's Advanced section (when Auto-send pauses, repairs at once),
 * desktop light and dark and a phone dark, scrolled to it. Desktop crops from Paseo's "Back to plugins" (0.16+), else
 * Follow-up's pane.
 */
async function advancedShots({ shoot }) {
  const pane = async (page, vp) => {
    await page.setViewportSize(vp);
    await openSettingsAt(page, "following", vp);
    const row = page.getByText("Repairs at once", { exact: true }).filter({ visible: true }).first();
    await row.waitFor();
    await row.evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    if (vp.width < 768) return undefined;
    const back = nativeSettingsTabs ? await page.getByText("Back to plugins").filter({ visible: true }).first().boundingBox({ timeout: 15000 }) : null;
    const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
    return { x, y: 0, width: vp.width - x, height: vp.height };
  };
  await shoot("advanced-desktop-light", DESKTOP, "light", page => pane(page, DESKTOP));
  await shoot("advanced-desktop-dark", DESKTOP, "dark", page => pane(page, DESKTOP));
  await shoot("advanced-phone-dark", PHONE, "dark", page => pane(page, PHONE));
}
/**
 * batch-churn (a-changed-review-updates-never-cancels): Webhook signatures in three states, each as the panel (Messages
 * to the agent, then Activity) and Home's detail (Needs you), desktop light and 390 dark.
 * a. churn: the agent answered the review blocked, then Sam added two threads and replied on one; the answer is kept
 *    (moved on: changed) and the next message, queued, says what moved.
 * b. on it: that message went out and the agent answered in_progress while it keeps working ("Sent · … is on it"); #271
 *    got a conflict, so a repair on another PR waits.
 * c. healed: records an older release left (a changed review cancelled "No longer needed", an answer a Retry rewrote as
 *    cancelled) are healed at start-up: the plugin is disabled, they are written to state.json, and it is enabled again.
 */
async function batchChurnShots({ shoot, seeded, call, home, cli }) {
  const w = seeded.workspaces.find(x => x.key === "bc-review");
  const spec = BATCH_CHURN_STATES[0];
  const ws = async () => (await call("follow.list", {})).workspaces.find(x => x.id === w.workspaceId);
  const pendingBatch = async (test = () => true) => {
    let batch = null;
    await until("Webhook signatures queued batch", async () => { await call("follow.refresh", {}); batch = (await ws())?.batches.find(b => b.state === "pending" && test(b)); return !!batch; }, { tries: 240, every: 500 });
    return batch;
  };
  const scriptsFile = join(home, "fixture-scripts.json");
  const agentSays = async steps => { const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8")); scripts[`agent:${w.agentId}`] = steps; await fs.writeFile(scriptsFile, JSON.stringify(scripts)); };
  const sendAndWait = async batch => {
    await call("follow.send", { workspaceId: w.workspaceId, batchId: batch.id });
    await until("Webhook signatures sent", async () => ["sent", "sending"].includes((await ws())?.batches.find(b => b.id === batch.id)?.state), { tries: 120, every: 500 });
  };
  const fixture = join(home, "gh-fixture.json");
  const editPr = async (n, change) => { const d = JSON.parse(await fs.readFile(fixture, "utf8")); d[n] = { ...d[n], ...change }; await fs.writeFile(fixture, JSON.stringify(d)); };

  // a. The first message goes out; the agent answers blocked. Then the review moves: two new threads, a reply on one.
  const first = await pendingBatch();
  await agentSays([msg("Thread 2 on #270 asks for key rotation, which needs Sam's call.")]);
  await sendAndWait(first);
  await call("follow.acknowledge", { agentId: w.agentId, batchId: first.id, outcome: "blocked",
    result: "Fixed thread 1 on #270. Thread 2 asks whether signing keys rotate; that needs Sam's call before I change the scheme.",
    // a-person-part-is-a-person-item: the part only Sam can move shows in Needs you, and the next message leaves it.
    waitingOn: "Thread 2 on #270: whether signing keys rotate is Sam's call." });
  await editPr(270, { threads: 4, replies: { 1: "2026-03-04T11:40:00Z" } });
  const second = await pendingBatch(b => b.id !== first.id);
  await until("the blocked answer moved on", async () => (await ws())?.batches.find(b => b.id === first.id)?.movedOn?.why === "changed", { tries: 120, every: 500 });

  const stepClock = async ms => { const c = JSON.parse(await fs.readFile(clockFile, "utf8")); await setDaemonClock(Math.round(c.fake + (Date.now() - c.real) * c.rate) + ms); };
  const runningNotFinished = async label => {
    await stepClock(5_000);
    let row = null;
    await until(`${label}: Webhook signatures working, not finished`, async () => {
      row = (await call("follow.inbox-list", {})).rows.find(r => r.agentId === w.agentId);
      return row?.status === "running" && !row.needs?.reasons.some(r => r.reason === "finished");
    }, { tries: 120, every: 500 }).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ status: row?.status, turnStartedAt: row?.turnStartedAt, needs: row?.needs, brief: row?.brief && { kind: row.brief.kind, source: row.brief.source, state: row.brief.state } })}`); });
  };

  const TALL = { width: DESKTOP.width, height: 1300 };
  // Activity folds after a few rows; the older (healed) ones sit behind "Show all N".
  const showAllActivity = async (page, scroll) => {
    if (scroll !== "Activity") return;
    await page.getByText("Activity", { exact: true }).filter({ visible: true }).last().waitFor({ timeout: 90000 });
    const more = page.getByText(/^Show all \d+$/).filter({ visible: true }).last();
    if (await more.isVisible().catch(() => false)) await more.click();
  };
  const panel = (scroll, words) => async page => {
    await page.setViewportSize(TALL);
    await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await showAllActivity(page, scroll);
    const el = page.getByText(words).filter({ visible: true }).first(); await el.waitFor({ timeout: 90000 });
    await page.getByText(scroll, { exact: true }).filter({ visible: true }).last().evaluate(e => e.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(400);
  };
  const panelPhone = (scroll, words) => async page => {
    await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
    await showAllActivity(page, scroll);
    await page.getByText(words).filter({ visible: true }).first().waitFor({ timeout: 90000 });
    await page.setViewportSize(PHONE);
    await page.getByText(scroll, { exact: true }).filter({ visible: true }).last().evaluate(e => e.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(400);
    if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error("batch-churn panel scrolls sideways at 390");
  };
  const homeShot = (words, phone) => async page => {
    await openHome(page);
    if (phone) await page.setViewportSize(PHONE);
    await (await homeRow(page, spec.title)).click();
    await page.getByText(words).filter({ visible: true }).first().waitFor({ timeout: 90000 });
    await page.waitForTimeout(400);
  };
  const state = async (name, words, extra) => {
    await shoot(`bc-${name}-panel-light`, TALL, "light", panel("Messages to the agent", words.panel));
    await shoot(`bc-${name}-activity-light`, TALL, "light", panel("Activity", words.activity));
    await shoot(`bc-${name}-home-light`, DESKTOP, "light", homeShot(words.home));
    await shoot(`bc-${name}-panel-phone-dark`, PHONE, "dark", panelPhone("Messages to the agent", words.panel));
    await shoot(`bc-${name}-activity-phone-dark`, PHONE, "dark", panelPhone("Activity", words.activity));
    await shoot(`bc-${name}-home-phone-dark`, PHONE, "dark", homeShot(words.home, true));
    if (extra) await extra();
  };
  const PART = /Part of #270 waits on its reviewer/;
  await state("churn", { panel: /Next message to Webhook signatures/, activity: /#270 changed on GitHub/, home: PART }, async () => {
    // The person part in the panel's Needs you.
    await shoot("bc-churn-needs-light", TALL, "light", panel("Needs you", PART));
    await shoot("bc-churn-needs-phone-dark", PHONE, "dark", panelPhone("Needs you", PART));
    // The queued message itself (Preview): the review line says what moved since the last message.
    for (const [theme, viewport] of [["light", DESKTOP], ["dark", PHONE]]) await shoot(`bc-churn-preview-${theme === "light" ? "light" : "phone-dark"}`, viewport, theme, async page => {
      await panel("Messages to the agent", /Next message to Webhook signatures/)(page);
      await page.getByRole("button", { name: /^Preview the next message/ }).filter({ visible: true }).first().click();
      await page.getByText(/since the last message: 2 new threads, 1 with new replies/).filter({ visible: true }).first().waitFor({ timeout: 60000 });
      await page.getByText(/Leave this part for a person: "Thread 2 on #270/).filter({ visible: true }).first().waitFor({ timeout: 60000 });
      if (viewport === PHONE) await page.setViewportSize(PHONE);
      await page.waitForTimeout(400);
    });
  });

  // b. The update goes out to an agent that keeps working; it answers in_progress. #271 gets a conflict meanwhile.
  await agentSays([think("A subagent is already going through the new threads on #270."), { hold: true }]);
  await sendAndWait(second);
  await until("Webhook signatures' agent at work", async () => (await client.fetchAgent(w.agentId)).agent?.status === "running", { tries: 120, every: 500 });
  await call("follow.acknowledge", { agentId: w.agentId, batchId: second.id, outcome: "in_progress", result: "Already on it: a subagent is working through the new threads on #270." });
  // Auto-send on, so the queued repair on #271 says what it waits for (not "auto-send is off").
  await call("follow.control", { workspaceId: w.workspaceId, enable_auto_sends: true });
  await editPr(271, { conflict: true });
  await pendingBatch(b => b.tasks.some(t => t.kind === "conflict"));
  // a-running-agent-is-not-finished: the agent is on a new turn, so its last finish (no ask) leaves Needs you. The inbox
  // reads Paseo's agent list through a cache timed on the crawling clock, so step the clock past it first.
  await runningNotFinished("on-it");
  await state("on-it", { panel: /is on it/, activity: /already on/, home: spec.title });

  // c. Records an older release left, healed at start-up.
  await cli("plugin", "disable", "follow-up");
  await new Promise(r => setTimeout(r, 4000));
  const stateFile = join(home, "plugin-data", "follow-up", "state.json");
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const stored = saved.workspaces.find(x => x.id === w.workspaceId);
  const review = stored.batches.find(b => b.id === first.id).tasks.find(t => t.kind === "review");
  const iso = minutes => new Date(BASE + minutes * 60_000).toISOString();
  const old = (id, minute, fingerprint, state, result, attempts = 1) => ({ id, messageId: `${id}-message`, tasks: [{ ...review, fingerprint, parts: undefined }], state, createdAt: iso(minute), sentAt: iso(minute + 1),
    settledAt: iso(minute + 4), attempts, result, recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] });
  stored.batches.unshift(
    // A changed review a release before the fix cancelled as gone.
    old("shots-old-churn", 120, "older-a", "cancelled", "No longer needed: GitHub no longer shows what it asked for."),
    // The agent's answer, then the developer's Retry, which rewrote the answer as cancelled.
    old("shots-old-answer", 140, "older-b", "cancelled", "Thread 1 needs Sam to confirm the header name before I rename it."),
    old("shots-old-retry", 150, "older-b", "completed", "Renamed the header to X-Signature after Sam confirmed it.", 2));
  await fs.writeFile(stateFile, JSON.stringify(saved));
  // Enabling compiles the worker again, which can outlast the CLI's 60 s request: wait for the worker instead.
  await cli("plugin", "enable", "follow-up").catch(error => { if (!/DAEMON_REQUEST_TIMEOUT/.test(`${error?.stdout ?? ""}${error?.message ?? ""}`)) throw error; });
  await until("Follow-up back after the heal", async () => {
    try { const b = (await ws())?.batches ?? []; return b.find(x => x.id === "shots-old-churn")?.movedOn?.why === "changed" && b.find(x => x.id === "shots-old-answer")?.movedOn?.why === "retried"; }
    catch { return false; }
  }, { tries: 600, every: 500 });
  await runningNotFinished("healed");
  const healed = (await ws()).batches;
  if (healed.find(x => x.id === "shots-old-answer").state !== "blocked") throw new Error("the answered batch wasn't restored as blocked");
  await state("healed", { panel: "Messages to the agent", activity: /sent again/, home: spec.title });
}
/** The PR fallback on both surfaces: project identity and observed status, with no horizontal overflow. */
async function prNowShots({ shoot, call, seeded }) {
  for (const spec of PR_NOW_STATES) {
    const w = seeded.workspaces.find(w => w.key === spec.key);
    await until(`${spec.key} repository`, async () => (await call("follow.get", { workspaceId: w.workspaceId })).workspace?.repo === "example/app");
  }
  const visible = (page, line) => page.getByText(line, { exact: true }).filter({ visible: true }).first();
  for (const theme of ["light", "dark"]) {
    for (const [i, spec] of PR_NOW_STATES.entries()) {
      if (argv.includes("--pr-now-revision") && ![1, 3].includes(i)) continue;
      const line = `${i < 2 ? "" : "acme/widgets"}#${8801 + i} · ${i % 2 ? "Checking" : "In review"}`;
      for (const [device, viewport] of [["desktop", { width: DESKTOP.width, height: 1000 }], ["phone", PHONE]]) {
        await shoot(`pr-now-panel-${8801 + i}-${device}-${theme}`, viewport, theme, async page => {
          await openChat(page, spec.title, spec.prompt);
          await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
          if (device === "phone") await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
          await page.setViewportSize(viewport);
          await visible(page, line).waitFor({ timeout: 60_000 });
          const row = page.getByRole("button", { name: new RegExp(`^Pull request ${8801 + i}: `) }).filter({ visible: true }).first();
          const words = await row.innerText();
          if (!words.includes(line.split(" · ")[0]) || !words.includes(line.split(" · ")[1])) throw new Error("PR row and agent line disagree");
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("PR line overflows");
        });
      }
    }
    for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      if (argv.includes("--pr-now-revision") && device === "phone" && theme === "light") continue;
      await shoot(`pr-now-home-${device}-${theme}`, viewport, theme, async page => {
        await openHome(page);
        await page.setViewportSize(viewport);
        const row = await homeRow(page, PR_NOW_STATES[2].title);
        await row.scrollIntoViewIfNeeded();
        if (!(await row.innerText()).includes("acme/widgets#8803 · In review")) throw new Error("Home omitted the PR fallback");
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Home overflows");
      });
    }
  }
}

/**
 * question-links (one-answer-flow-for-every-question, checks-say-what-they-are-doing): the chat's card for a needs_you
 * that points at three questions, with each question's note and links; a card a newer one replaced, opened with Show
 * original; and the panel's agent line and PR row for a fork PR whose required checks never ran. Desktop light and
 * dark, phone dark. Fails when the card drops a link or the line says the checks are running.
 */
async function questionLinksShots({ shoot, call, seeded, home }) {
  const ws = key => seeded.workspaces.find(w => w.key === key);
  const spec = key => QL_STATES.find(s => s.key === key);
  // A newer card for Sidebar copy: its next turn asks again, so the first card reads "Replaced by a newer card".
  const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8"));
  scripts[`agent:${ws("ql-replaced").agentId}`] = [msg("Both drafts are merged into one."), rpc("follow.needs-you", { kind: "action", ask: "Approve the merged empty-state copy on the design page" })];
  await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
  await client.sendMessage(ws("ql-replaced").agentId, "Merge the two drafts into one.", { messageId: `shots-ql-replaced-2` });
  await until("ql-replaced second card", async () => (await call("follow.inbox-list", {})).rows.some(r => r.agentId === ws("ql-replaced").agentId && /merged empty-state/.test(r.brief?.ask ?? "")), { tries: 120, every: 500 });
  const TALL = { width: DESKTOP.width, height: 1100 };
  const frames = [["desktop-light", "light", TALL], ["desktop-dark", "dark", TALL], ["phone-dark", "dark", PHONE]];
  const visible = (page, text) => page.getByText(text).filter({ visible: true });
  for (const [name, theme, frame] of frames) {
    await shoot(`ql-timeline-${name}`, frame, theme, async page => {
      await page.setViewportSize(TALL); await openChat(page, spec("ql-sidebar").title, spec("ql-sidebar").prompt);
      if (frame === PHONE) await page.setViewportSize(PHONE);
      await visible(page, "3. Should archived workspaces stay in the sidebar, folded at the bottom?").first().waitFor({ timeout: 60_000 });
      const links = await visible(page, QL_PAGE.label).count();
      if (links < 3) throw new Error(`the timeline card shows ${links} of 3 design page links`);
      if (!await visible(page, "Badge spec").count()) throw new Error("the timeline card drops Q2's own link");
      await visible(page, "3. Should archived workspaces stay in the sidebar, folded at the bottom?").first().scrollIntoViewIfNeeded();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("the card overflows");
    });
    // Phones: the header's ⓘ shows where the card's facts come from right under the header, in the first screen.
    if (frame === PHONE) for (const on of [false, true]) await shoot(`ql-info-${on ? "on" : "off"}-${name}`, frame, theme, async page => {
      await page.setViewportSize(TALL); await openChat(page, spec("ql-sidebar").title, spec("ql-sidebar").prompt);
      await page.setViewportSize(PHONE);
      const info = page.getByRole("button", { name: "Where this comes from", exact: true }).filter({ visible: true }).last();
      await info.waitFor({ timeout: 60_000 });
      // Scrolled up to the card's header, as the developer is when they tap ⓘ.
      // A real scroll upward (the chat keeps itself pinned to the bottom otherwise) until the ⓘ sits in the upper screen.
      await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
      for (let i = 0; i < 20; i++) {
        const box = await info.boundingBox();
        if (box && box.y > 140 && box.y < PHONE.height / 3) break;
        await page.mouse.wheel(0, box && box.y > PHONE.height / 3 ? 120 : -120); await page.waitForTimeout(150);
      }
      await page.waitForTimeout(500);
      const before = await info.boundingBox();
      if (!before || before.y < 0 || before.y > PHONE.height) throw new Error(`the ⓘ isn't on screen (${JSON.stringify(before)})`);
      if (on) {
        await info.click(); await page.waitForTimeout(500);
        const line = page.getByText("Stated by the agent.").filter({ visible: true }).last();
        await line.waitFor();
        const box = await line.boundingBox();
        if (!box || box.y < 0 || box.y + box.height > PHONE.height) throw new Error(`the ⓘ's line is off screen (${JSON.stringify(box)})`);
      }
    });
    await shoot(`ql-original-${name}`, frame, theme, async page => {
      await page.setViewportSize(TALL); await openChat(page, spec("ql-replaced").title, spec("ql-replaced").prompt);
      if (frame === PHONE) await page.setViewportSize(PHONE);
      // The developer's next message reads as the reply, so the past card offers Show full question; Show original (a card
      // replaced while open) opens the same read-only body.
      const reveal = page.getByRole("button", { name: /^Show (original|full question)$/ }).filter({ visible: true }).first();
      await reveal.waitFor({ timeout: 60_000 }); await reveal.click(); await page.mouse.move(DESKTOP.width - 20, 300);
      await visible(page, "My review adds: the plain draft tested better with new users.").first().waitFor();
      if (!await visible(page, QL_PAGE.label).count()) throw new Error("the original card drops its link");
      await visible(page, "My review adds: the plain draft tested better with new users.").first().scrollIntoViewIfNeeded();
    });
    await shoot(`ql-ci-${name}`, frame, theme, async page => {
      // Phones: Home's detail pane, which draws the same agent line and PR rows as the panel.
      if (frame === PHONE) { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, spec("ql-fork").title)).click(); }
      else {
        await page.setViewportSize(TALL); await openChat(page, spec("ql-fork").title, spec("ql-fork").prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByRole("button", { name: /^Pull request 8811: / }).filter({ visible: true }).first().waitFor({ timeout: 60_000 });
      }
      await visible(page, "Checks not started").first().waitFor({ timeout: 60_000 });
      if (await visible(page, /Waiting on CI|Checks running|Checking/).count()) throw new Error("a never-run check reads as running");
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("the panel overflows");
    });
  }
}

/**
 * What each agent is working on (`--only now-line`, the-line-takes-its-first-source): the panel's agent lines and Home's
 * rows for the four states (stated with its steps, stated without, Follow-up's repair, nothing stated), desktop and
 * phone, light and dark. Phones reach the panel through the larger view; nothing may scroll sideways.
 */
async function nowLineShots({ shoot }) {
  const TALL = { width: DESKTOP.width, height: 1000 };
  const states = [
    { name: "steps", spec: NOW_LINE_STATES[0], line: "Capping the retry gap" },
    { name: "plain", spec: NOW_LINE_STATES[1], line: "Releasing the beta" },
    { name: "follow-up", spec: WORKSPACES.find(w => w.key === "invoices"), line: /^(Fixing CI on|Repairing|Answering review on|Resolving conflicts on|Restacking) #/ },
    { name: "nothing", spec: WORKSPACES.find(w => w.key === "audit"), line: /^Main agent · working \S+$/ },
  ];
  const noSideways = name => async page => { if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error(`${name} scrolls sideways`); };
  const visible = (page, line) => page.getByText(line).filter({ visible: true }).first();
  for (const theme of ["light", "dark"]) {
    for (const st of states) {
      await shoot(`nl-panel-${st.name}-${theme}`, TALL, theme, async page => {
        await openChat(page, st.spec.title, st.spec.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await visible(page, st.line).waitFor({ timeout: 60_000 });
      });
      await shoot(`nl-panel-${st.name}-phone-${theme}`, PHONE, theme, async page => {
        await openChat(page, st.spec.title, st.spec.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
        await page.setViewportSize(PHONE);
        await visible(page, st.line).waitFor({ timeout: 60_000 });
        await noSideways(`nl-panel-${st.name}-phone`)(page);
      });
    }
    await shoot(`nl-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await visible(page, "Capping the retry gap").waitFor({ timeout: 60_000 }); });
    await shoot(`nl-home-phone-${theme}`, PHONE, theme, async page => {
      await openHome(page); await page.setViewportSize(PHONE);
      const line = page.getByText("Capping the retry gap").first(); await line.waitFor({ state: "attached", timeout: 60_000 });
      await line.evaluate(el => el.scrollIntoView({ block: "center" })); await noSideways("nl-home-phone")(page);
    });
  }
}
/**
 * Every panel section folds (`--only panel-folds`, panel-sections-fold): one workspace's panel with every section
 * open (also from the top), every one folded, and a mix, desktop light and dark, and the phone (larger view) dark.
 * Every fold arrow has one size, color and place. Enter folds and opens
 * a header, and a fold survives a reload. Folds are set by the header buttons' own aria-expanded.
 */
async function panelFoldShots({ shoot }) {
  const spec = NEEDS_YOU_STATES.find(s => s.key === "ny-tasks");
  const TALL = { width: DESKTOP.width, height: 1400 };
  const TITLES = ["Needs you", "Your questions", "Messages to the agent", "Pull requests", "Agent's tasks", "Activity", "Spec, agent and recovery"];
  const header = (page, title) => page.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}(,|$)`) }).filter({ visible: true }).first();
  const setFolds = async (page, want) => {
    for (const title of TITLES) {
      const h = header(page, title);
      if (!await h.count()) continue;
      const open = want[title] ?? want.all;
      if ((await h.getAttribute("aria-expanded")) !== String(open)) await h.click();
      await page.waitForFunction(([name, v]) => [...document.querySelectorAll("[aria-expanded]")].some(el => (el.getAttribute("aria-label") ?? "").startsWith(name) && el.getAttribute("aria-expanded") === v), [title, String(open)]);
    }
  };
  // capture opens every page at DESKTOP: the tall desktop shots resize here (the phone ones resize after).
  const panel = async page => {
    await page.setViewportSize(TALL);
    await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await header(page, "Needs you").waitFor({ timeout: 60_000 });
  };
  const noSideways = name => async page => { if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error(`${name} scrolls sideways`); };
  // Every fold arrow alike and in one place (panel-sections-fold): the same size and color, at the button's end, the
  // same distance from its right edge, so it sits just before any controls the section has (Activity's tabs).
  const sameArrows = name => async page => {
    const arrows = await page.evaluate(() => [...document.querySelectorAll('[data-fold-chevron="end"]')].filter(el => el.getClientRects().length).map(el => {
      const r = el.getBoundingClientRect(), b = el.closest("[aria-expanded]").getBoundingClientRect();
      return { label: el.closest("[aria-expanded]").getAttribute("aria-label"), w: r.width, h: r.height, gap: Math.round(b.right - r.right), color: getComputedStyle(el.querySelector("svg") ?? el).color + (el.querySelector("svg")?.getAttribute("stroke") ?? "") };
    }));
    const cut = await page.evaluate(() => [...document.querySelectorAll("[aria-expanded] div")].filter(el => el.getClientRects().length && el.closest('[aria-expanded]').querySelector('[data-fold-chevron="end"]') && !el.children.length && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).fontWeight === "600").map(el => el.textContent));
    // A title cut to "Acti…" by its header's controls (a summary may ellipsize by design).
    if (cut.length) throw new Error(`${name}: a fold header's title is cut: ${cut.join(", ")}`);
    if (arrows.length < 5) throw new Error(`${name}: only ${arrows.length} fold arrows`);
    for (const a of arrows) if (Math.abs(a.w - 14) > 0.5 || Math.abs(a.h - 14) > 0.5 || a.gap !== arrows[0].gap || a.color !== arrows[0].color)
      throw new Error(`${name}: ${a.label}'s arrow differs (${JSON.stringify(a)} vs ${JSON.stringify(arrows[0])})`);
  };
  // The panel from its top: its scroll area back to 0.
  const toTop = async page => {
    await page.evaluate(() => { for (let el = document.querySelector('[data-fold-chevron="end"]'); el; el = el.parentElement) if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = 0; });
    await page.waitForTimeout(300);
  };
  const MIX = { all: false, "Needs you": true, "Agent's tasks": true, "Pull requests": true };
  for (const theme of ["light", "dark"]) {
    await shoot(`pf-open-${theme}`, TALL, theme, async page => { await panel(page); await setFolds(page, { all: true }); await sameArrows("pf-open")(page); });
    // From the top, open: Needs you, Your questions and Pull requests.
    await shoot(`pf-open-top-${theme}`, TALL, theme, async page => {
      await panel(page); await setFolds(page, { all: true }); await toTop(page);
      for (const title of ["Needs you", "Your questions", "Pull requests"]) {
        const box = await header(page, title).boundingBox();
        if (!box || box.y < 0 || box.y + box.height > TALL.height) throw new Error(`pf-open-top: ${title} isn't in view (${JSON.stringify(box)})`);
      }
    });
    await shoot(`pf-folded-${theme}`, TALL, theme, async page => { await panel(page); await setFolds(page, { all: false }); });
    await shoot(`pf-mix-${theme}`, TALL, theme, async page => { await panel(page); await setFolds(page, MIX); await sameArrows("pf-mix")(page); });
  }
  await shoot("pf-phone-dark", PHONE, "dark", async page => {
    await panel(page);
    await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
    await page.setViewportSize(PHONE);
    await header(page, "Needs you").waitFor({ timeout: 60_000 });
    await setFolds(page, { all: true }); await sameArrows("pf-phone")(page);
    await setFolds(page, { all: false, "Needs you": true });
    await noSideways("pf-phone")(page);
  });
  await shoot("pf-phone-folded-dark", PHONE, "dark", async page => {
    await panel(page);
    await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
    await page.setViewportSize(PHONE);
    await header(page, "Needs you").waitFor({ timeout: 60_000 });
    await setFolds(page, { all: false });
    await noSideways("pf-phone-folded")(page);
  });
  // The keyboard: Enter folds Needs you and opens it again; a fold survives a reload.
  await shoot("pf-keys-light", TALL, "light", async page => {
    await panel(page); await setFolds(page, { all: true });
    const needs = header(page, "Needs you");
    const expanded = want => page.waitForFunction(v => [...document.querySelectorAll("[aria-expanded]")].some(el => (el.getAttribute("aria-label") ?? "").startsWith("Needs you") && el.getAttribute("aria-expanded") === v), want, { timeout: 5000 });
    const where = () => page.evaluate(() => { const a = document.activeElement; return `${a?.tagName} ${a?.getAttribute("aria-label")} expanded=${a?.getAttribute("aria-expanded")}`; });
    await needs.focus(); await page.keyboard.press("Enter");
    await expanded("false").catch(async e => { throw new Error(`Enter didn't fold Needs you (focus: ${await where()}): ${e.message}`); });
    await needs.focus(); await page.keyboard.press("Enter");
    await expanded("true").catch(async e => { throw new Error(`Enter didn't open Needs you again (focus: ${await where()}): ${e.message}`); });
    await setFolds(page, { all: true, "Pull requests": false });
    await page.reload();
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().waitFor({ timeout: 60_000 });
    if (!await header(page, "Needs you").count()) await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await header(page, "Pull requests").waitFor({ timeout: 60_000 });
    if ((await header(page, "Pull requests").getAttribute("aria-expanded")) !== "false") throw new Error("the Pull requests fold didn't survive a reload");
  });
}
/**
 * The agent peek (`--only peek`, invariant 137): the panel's agent line and Home's row, hovered for the 350 ms intent,
 * show the agent's turn; a permission shows Deny and Allow; a finished turn reads Idle; Home's selected row has no peek
 * (its pane shows the turn); a phone's tap opens the sheet with one Open chat. Light and dark.
 */
async function peekShots({ shoot }) {
  const TALL = { width: DESKTOP.width, height: 1000 };
  const peek = page => page.locator("[data-follow-peek]").first();
  const hoverOpen = async (page, target) => {
    await target.waitFor({ timeout: 60_000 });
    page.keepPointer = true; // the peek closes when the pointer leaves its line, as it should
    await target.hover();
    await peek(page).waitFor({ timeout: 15_000 }).catch(async error => {
      const seen = await page.evaluate(() => ({ floating: document.querySelectorAll("[data-floating-owner]").length, peek: document.querySelectorAll("[data-follow-peek]").length }));
      throw new Error(`no peek after hovering (${JSON.stringify(seen)}): ${error.message}`);
    });
    await page.waitForTimeout(1200);
    if (!await peek(page).isVisible()) throw new Error("the peek closed by itself while the pointer rested on its line");
  };
  const line = (page, text) => page.getByText(text).filter({ visible: true }).first();
  const panel = async (page, spec) => { await openChat(page, spec.title, spec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); };
  for (const theme of ["light", "dark"]) {
    await shoot(`peek-panel-live-${theme}`, TALL, theme, async page => { await panel(page, PEEK_STATES[0]); await hoverOpen(page, line(page, "Capping the retry gap")); });
    await shoot(`peek-panel-permission-${theme}`, TALL, theme, async page => {
      await panel(page, PEEK_STATES[1]); await hoverOpen(page, line(page, "Rebuilding the bundle"));
      await peek(page).getByText("Allow", { exact: true }).waitFor({ timeout: 30_000 });
    });
    await shoot(`peek-panel-done-${theme}`, TALL, theme, async page => { await panel(page, PEEK_STATES[2]); await hoverOpen(page, line(page, "Fixing the flaky test")); });
    await shoot(`peek-home-${theme}`, DESKTOP, theme, async page => {
      await openHome(page);
      await hoverOpen(page, await homeRow(page, PEEK_STATES[0].title));
    });
    await shoot(`peek-panel-phone-${theme}`, PHONE, theme, async page => {
      await panel(page, PEEK_STATES[0]);
      await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await page.setViewportSize(PHONE);
      const target = line(page, "Capping the retry gap"); await target.waitFor({ timeout: 60_000 }); await target.click();
      await page.getByRole("button", { name: "Open chat" }).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1200);
      if (await page.getByRole("button", { name: "Open chat" }).filter({ visible: true }).count() !== 1) throw new Error("the phone sheet shows Open chat more than once");
    });
  }
  // Q180 A: the selected row's pane already draws its turn, so hovering it opens nothing.
  await shoot("peek-home-selected-light", DESKTOP, "light", async page => {
    await openHome(page);
    const row = await homeRow(page, PEEK_STATES[0].title);
    await row.click(); await page.waitForTimeout(800); await row.hover(); await page.waitForTimeout(1200);
    if (await page.locator("[data-follow-peek]").count()) throw new Error("the selected row peeked although its pane shows its turn");
  });
}
/**
 * Scheduled tasks (`--only scheduled-tasks`, a-scheduled-task-arrives-once-at-its-time): the Tasks card with a time
 * still to send, one sent and one not sent (and why), the live line naming the check-back time; Send on a schedule's
 * At a time (opened on the task's time, and a time it refuses); Home's Waiting row. Desktop and phone, light and dark.
 * The sent and not-sent marks are written into state.json while the plugin is off, as the worker records them.
 */
async function scheduledShots({ shoot, seeded, call, cli }) {
  const spec = SCHEDULED_STATES[0];
  const w = seeded.workspaces.find(x => x.key === spec.key);
  await cli("plugin", "disable", "follow-up");
  await new Promise(r => setTimeout(r, 4000));
  const stateFile = join(home, "plugin-data", "follow-up", "state.json");
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const stored = saved.workspaces.find(x => x.id === w.workspaceId);
  const now = Date.parse(stored.updatedAt);
  const iso = ms => new Date(ms).toISOString();
  for (const o of stored.obligations) {
    if (o.title.startsWith("Tell the docs team")) o.trigger = { event: "at", delayDays: 0, at: iso(now - 50 * 60_000), queuedAt: iso(now - 50 * 60_000), sentAt: iso(now - 49 * 60_000) };
    if (o.title.startsWith("Rerun the smoke test")) o.trigger = { event: "at", delayDays: 0, at: iso(now - 20 * 60_000), notSent: "the agent was archived" };
  }
  await fs.writeFile(stateFile, JSON.stringify(saved));
  await cli("plugin", "enable", "follow-up").catch(error => { if (!/DAEMON_REQUEST_TIMEOUT/.test(`${error?.stdout ?? ""}${error?.message ?? ""}`)) throw error; });
  await until("Follow-up back with the scheduled marks", async () => {
    try { const r = await call("follow.get", { workspaceId: w.workspaceId }); return r.workspace.obligations.some(o => o.trigger?.notSent); } catch { return false; }
  }, { tries: 600, every: 500 });
  const TALL = { width: DESKTOP.width, height: 1100 };
  const fold = page => page.getByRole("button", { name: /^Agent's tasks, / }).filter({ visible: true }).last();
  const expand = async page => {
    await fold(page).waitFor({ timeout: 60_000 });
    if ((await fold(page).getAttribute("aria-expanded")) !== "true") await fold(page).click();
    await page.getByText(/^Didn't go out · /).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
  };
  const panel = async page => { await page.setViewportSize(TALL); await openChat(page, spec.title, spec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await expand(page); };
  const larger = async page => {
    await openChat(page, spec.title, spec.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
    await page.setViewportSize(PHONE); await expand(page);
  };
  const sheet = async page => {
    await page.getByRole("button", { name: /^Task: Recheck the CDN serves 1\.4\.0/ }).filter({ visible: true }).first().click();
    await page.getByText("Send on a schedule…").filter({ visible: true }).first().click();
    await page.getByRole("radio", { name: "At a time", exact: true }).filter({ visible: true }).first().waitFor();
    await page.getByText(/^Sends .*, your time$/).filter({ visible: true }).first().waitFor();
  };
  const refuse = async page => { await page.getByLabel("Send at, date and time").filter({ visible: true }).first().fill("next tuesday"); await page.getByText(/^Write a time like 14:30/).filter({ visible: true }).first().waitFor(); };
  const noSideways = name => async page => { if (await page.evaluate(() => document.documentElement.scrollWidth) > PHONE.width) throw new Error(`${name} scrolls sideways`); };
  for (const theme of ["light", "dark"]) {
    await shoot(`sc-panel-${theme}`, TALL, theme, async page => { await panel(page); await page.getByText(/checks back /).filter({ visible: true }).first().waitFor(); });
    await shoot(`sc-phone-${theme}`, PHONE, theme, async page => { await larger(page); await fold(page).evaluate(el => el.scrollIntoView({ block: "start" })); await noSideways("sc-phone")(page); });
    await shoot(`sc-sheet-${theme}`, TALL, theme, async page => { await panel(page); await sheet(page); });
    await shoot(`sc-sheet-refused-${theme}`, TALL, theme, async page => { await panel(page); await sheet(page); await refuse(page); });
    await shoot(`sc-sheet-phone-${theme}`, PHONE, theme, async page => { await larger(page); await sheet(page); await noSideways("sc-sheet-phone")(page); });
    await shoot(`sc-sheet-refused-phone-${theme}`, PHONE, theme, async page => { await larger(page); await sheet(page); await refuse(page); });
    await shoot(`sc-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await page.getByText(/Recheck the CDN serves 1\.4\.0 · checks back /).filter({ visible: true }).first().waitFor({ timeout: 60_000 }); });
    await shoot(`sc-home-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); const line = page.getByText(/checks back /).first(); await line.waitFor({ state: "attached", timeout: 60_000 }); await line.evaluate(el => el.scrollIntoView({ block: "center" })); await line.waitFor({ timeout: 10_000 }); await noSideways("sc-home-phone")(page); });
  }
}
/**
 * Settings, one tab per category (Paseo 0.16+, client/settings-screens.ts), or Follow-up's own tabs on 0.15: every
 * category on desktop and 390 px, light and dark, and the links into it (the version mark opens General; ⌘K's
 * "Follow-up: settings" reopens the category last shown). Run on each host: HARNESS_PASEO=0.15.4, 0.16, and 0.17 via
 * PATH. Writes settings-tabs.json; any failed check fails the run.
 */
/**
 * Settings → Morning brief (docs/morning-brief.md#settings), every state, desktop and phone, light and dark: the
 * Sources card (all read; one failed with Retry, one waiting for a sign-in, mail off until turned on), every plan state
 * (found, the channel picker open, not found, a failed search, a pasted link, off, nothing picked) and the Linear queue
 * section. The fake mcpproxy's servers are fictional and found by their tools (sources-fixture.json changes their state). Fictional only: alice, #planning, made-up artifact links. The chat search is the fake mcpproxy's
 * (chat-fixture.json); the plan's title and item count are seeded as the ranker's plan read (ranker.json), with its
 * last run in the future so no scheduled ranking calls a model.
 */
/**
 * Compass (docs/compass.md), desktop and phone, light and dark: the card with one source read (dana's DM, fictional),
 * its editor open, a new source's presets, the one line when the Summaries provider has no guard, and Home's AI-priority
 * reason line naming Compass. The fake mcpproxy's chat has a history read; the fake claude makes two notes quoting her.
 */
async function compassShots({ shoot, call, home, seeded }) {
  await fs.writeFile(join(home, "sources-fixture.json"), JSON.stringify({ compass: true }));
  await call("follow.brief-sources", { check: true });
  const states = async (name, drive, { phoneOnly = false } = {}) => {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      if (phoneOnly && device !== "phone") continue;
      await shoot(`compass-${name}-${device}-${theme}`, viewport, theme, async page => {
        await page.setViewportSize(viewport);
        await openSettingsAt(page, "brief", viewport);
        const head = page.getByText("What sets your priorities", { exact: true }).first();
        await head.waitFor();
        await head.evaluate(e => e.scrollIntoView({ block: "start" }));
        await drive?.(page);
        // The settings tab strip is wider than the column, so opening a tab can leave the page scrolled sideways.
        await head.evaluate(e => { for (let n = e.parentElement; n; n = n.parentElement) n.scrollLeft = 0; });
        await page.waitForTimeout(300);
        if (viewport.width < 768) return undefined;
        const back = await page.getByText(/Back to plugins/).first().boundingBox().catch(() => null);
        const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
        return { x, y: 0, width: viewport.width - x, height: viewport.height };
      });
    }
  };
  await states("empty", page => page.getByText("Nobody sets your priorities here yet").first().waitFor());
  await call("follow.set-compass", { source: { label: "Dana · product", who: { kind: "person", person: { id: "UDANA00001", name: "dana" } }, places: [{ kind: "conversation", sub: "dm", id: "UDANA00001", name: "dana" }],
    roles: ["priorities", "plan"], instructions: "P0 means today, P1 this week. A demo date is a deadline. Ignore hiring talk." } });
  await call("follow.set-compass", { instructions: "'The retry work' is APP-142. Customer asks wait for the plan unless they name a date.", glossary: [{ words: "the retry work", means: { issue: "APP-142" } }] });
  await call("follow.read-compass", {});
  await states("card", page => page.getByText(/2 notes live/).first().waitFor({ timeout: 30_000 }));
  await states("notes", async page => { await page.getByRole("button", { name: /Show Dana · product's notes/ }).first().click(); await page.getByText(/Until /).first().waitFor(); });
  await states("editor", async page => { await page.getByRole("button", { name: /Show Dana · product's notes/ }).first().click(); await page.getByRole("button", { name: "Edit Dana · product" }).first().click(); await page.getByText("How to read this", { exact: true }).first().waitFor(); });
  await states("add", async page => { await page.getByRole("button", { name: "Add a source" }).first().click(); await page.getByText("Start from", { exact: true }).first().waitFor(); }, { phoneOnly: true });
  // One place for priority inputs: the built-in inputs follow the sources in the same list, each with its role; the
  // Linear queue's states open behind its chevron.
  await states("inputs", async page => {
    const row = page.getByText("Your Linear queue", { exact: true }).first();
    await row.waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: /Show Your Linear queue's setting/ }).first().click();
    await page.getByText("Counts as the queue", { exact: true }).first().waitFor();
    await row.evaluate(e => e.scrollIntoView({ block: "start" }));
  });
  await states("when", async page => { const h = page.getByText("When", { exact: true }).first(); await h.waitFor(); await h.evaluate(e => e.scrollIntoView({ block: "start" })); });
  await call("follow.set-agent-setting", { role: "about", entry: { provider: "gemini", model: null } });
  await states("blocked", page => page.getByText(/Compass doesn't read on Gemini/).first().waitFor());
  await call("follow.set-agent-setting", { role: "about", entry: null });
  // Home's AI-priority reason line naming Compass (the ranker is off in the shots; the priorities write is its store's).
  const billing = seeded.workspaces.find(w => w.key === "billing");
  await actPlanned(call, billing.agentId, "set_display", { values: { home_sort: "priority" } });
  await actPlanned(call, billing.agentId, "set_priorities", { priorities: [{ workspace: billing.workspaceId, score: 96, reason: "Dana: acme demo Thu, APP-142 first", sources: [{ kind: "compass", label: "Dana · product" }] }], replace: false });
  // Pinned context on screen: a note pinned by hand joins the read's, so Why it matters folds one ("+1 more").
  await call("follow.compass-note", { action: "pin", workspace: billing.workspaceId, what: "client call Tue: retries must be in", strength: "high" });
  for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await shoot(`compass-reason-${device}-${theme}`, viewport, theme, async page => { await page.setViewportSize(viewport); await openHome(page); await page.getByText("Dana: acme demo Thu, APP-142 first").first().waitFor({ timeout: 20_000 }); });
  }
  // The panel's Why it matters (desktop: the panel beside the chat; phone: Home's detail), then its notes and ⋯ open.
  const why = page => page.getByText("Why it matters", { exact: true }).filter({ visible: true }).first();
  const openWhy = async (page, viewport) => {
    if (viewport.width < 768) {
      await openHome(page); await page.setViewportSize(viewport);
      await (await homeRow(page, "Billing retries")).click();
    } else {
      await openChat(page, "Billing retries", WORKSPACES.find(w => w.key === "billing").prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    }
    await why(page).waitFor({ timeout: 30_000 });
    // The panel's header is sticky: scroll the box's top just below it, never under it.
    await why(page).evaluate(e => { e.scrollIntoView({ block: "start" }); for (let n = e.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight && getComputedStyle(n).overflowY !== "visible") { n.scrollTop = Math.max(0, n.scrollTop - 24); break; } });
    await page.waitForTimeout(400);
  };
  for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await shoot(`compass-why-${device}-${theme}`, viewport, theme, page => openWhy(page, viewport));
    await shoot(`compass-why-open-${device}-${theme}`, viewport, theme, async page => {
      await openWhy(page, viewport);
      await page.getByRole("button", { name: /^\+\d+ more/ }).filter({ visible: true }).first().click();
      await page.getByRole("button", { name: "More actions for this note", exact: true }).filter({ visible: true }).first().click();
      await page.getByText("Tell the agent", { exact: true }).filter({ visible: true }).first().waitFor();
      await page.waitForTimeout(300);
    });
  }
  // Catch up: the billing card's head gains one muted Compass line.
  for (const [device, viewport, theme] of [["desktop", DESKTOP, "light"], ["phone", PHONE, "dark"]]) {
    await shoot(`compass-catchup-${device}-${theme}`, viewport, theme, async page => {
      await openHome(page); await page.setViewportSize(viewport);
      await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
      const line = () => page.getByText(/^Compass · /).filter({ visible: true }).first();
      for (let i = 0; !(await line().isVisible()); i++) {
        if (i > 30) throw new Error("compass: no Catch up card shows a Compass line");
        await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(800);
    });
  }
}

/**
 * Compass PR 5 (`--only compass-readers`, docs/compass.md#readers): every reader in Settings → Compass, desktop and
 * phone, light and dark. Sources of every kind in one list (a person's DM, everyone in a team channel, a Linear
 * project, a notes file on this machine, the calendar), the eight presets, the doc and file pickers, the tracker picker
 * over the queue's own projects, and Connections with a failing input. Fictional names only: Dana, #platform-team,
 * acme, a file under the harness's own home.
 */
async function compassReadersShots({ shoot, call, home }) {
  const data = join(home, "plugin-data", "follow-up");
  const queue = briefSinceQueue();
  for (const [key, project, milestone] of [["ACME-177", "Billing reliability", "Sprint 14"], ["ACME-142", "Billing reliability", "Sprint 14"], ["ACME-151", "Billing reliability", null], ["ACME-158", "Search", "Sprint 14"]]) Object.assign(queue.sweeps[0].issues[key], { project, milestone });
  await fs.writeFile(join(data, "linear-queue.json"), JSON.stringify(queue));
  const notesFile = join(home, "now.md");
  await fs.writeFile(notesFile, "# This week\n\n- ! renewal deck for acme\n\n# Later\n\nclean up the backlog\n");
  await fs.writeFile(join(home, "sources-fixture.json"), JSON.stringify({ compass: true, docs: true, calendar: true }));
  await call("follow.brief-sources", { check: true });
  const states = async (name, drive, { phoneOnly = false, at = "What sets your priorities" } = {}) => {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      if (phoneOnly && device !== "phone") continue;
      await shoot(`compass-readers-${name}-${device}-${theme}`, viewport, theme, async page => {
        await page.setViewportSize(viewport);
        await openSettingsAt(page, "brief", viewport);
        const head = page.getByText("What sets your priorities", { exact: true }).first();
        await head.waitFor();
        await head.evaluate(e => e.scrollIntoView({ block: "start" }));
        await drive?.(page);
        if (at !== "What sets your priorities") await page.getByText(at).last().evaluate(e => e.scrollIntoView({ block: "center" }));
        await head.evaluate(e => { for (let n = e.parentElement; n; n = n.parentElement) n.scrollLeft = 0; });
        await page.waitForTimeout(300);
        if (viewport.width < 768) return undefined;
        const back = await page.getByText(/Back to plugins/).first().boundingBox().catch(() => null);
        const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
        return { x, y: 0, width: viewport.width - x, height: viewport.height };
      });
    }
  };
  // The presets, all offered: a chat, a docs tool, the queue and a calendar are here.
  await states("add", async page => { await page.getByRole("button", { name: "Add a source" }).first().click(); await page.getByText("Start from", { exact: true }).first().waitFor(); });
  // A doc: the docs tool's search, and a file on this machine checked first.
  await states("doc", async page => {
    await page.getByRole("button", { name: "Add a source" }).first().click();
    await page.getByRole("radio", { name: "A doc or notes" }).first().click();
    await page.getByRole("button", { name: "A file on this machine" }).first().click();
    const field = page.getByLabel("File path").first();
    await field.fill(notesFile); await field.press("Enter");
    await page.getByText("A file on this machine", { exact: true }).nth(1).waitFor({ timeout: 20_000 });
  });
  await states("tracker", async page => {
    await page.getByRole("button", { name: "Add a source" }).first().click();
    await page.getByRole("radio", { name: "A tracker project" }).first().click();
    await page.getByRole("button", { name: "Pick a project or label" }).first().click();
    await page.getByLabel("Search trackers").first().fill("Bill");
    await page.getByText(/Linear project · 3 of your issues/).first().waitFor({ timeout: 20_000 });
  });
  const set = source => call("follow.set-compass", { source });
  // The compass shots, when they ran first in this harness, already added Dana.
  if (!only.includes("compass")) await set({ label: "Dana · product", who: { kind: "person", person: { id: "UDANA00001", name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: "UDANA00001", name: "Dana" }], roles: ["priorities", "plan"] });
  await set({ label: "Platform team", who: { kind: "anyone" }, places: [{ kind: "conversation", sub: "channel", id: "CPLAT00001", name: "platform-team" }], roles: ["priorities"], instructions: "Only the two leads, or messages with 'priority:'." });
  await set({ label: "Billing reliability", who: { kind: "anyone" }, places: [{ kind: "tracker", scope: "project", id: "linear:project:Billing reliability", name: "Billing reliability" }], roles: ["priorities"] });
  const file = (await call("follow.compass-find", { kind: "file", query: notesFile })).results[0].place;
  await set({ label: "Now", who: { kind: "me" }, places: [file], roles: ["self", "plan"], instructions: "A line starting with ! is urgent." });
  await set({ label: "Calendar deadlines", who: { kind: "me" }, places: [{ kind: "calendar", id: "primary", name: "Your calendar", filter: "with-guests" }], roles: ["deadlines"] });
  await call("follow.read-compass", {});
  await states("card", page => page.getByText(/Billing reliability · 3 notes live|3 notes live/).first().waitFor({ timeout: 30_000 }));
  await states("open", async page => { await page.getByRole("button", { name: /Show Billing reliability's notes/ }).first().click(); await page.getByText(/Webhook retries ignore/).first().waitFor(); });
  // Connections with a failing input: one count, the failure stays on its row above.
  await fs.writeFile(join(home, "sources-fixture.json"), JSON.stringify({ compass: true, docs: true, calendar: true, upstreams: { calendar: { connected: false, health: { level: "unhealthy", summary: "connection refused", action: null } } } }));
  await call("follow.brief-sources", { check: true });
  await new Promise(r => setTimeout(r, 1500));
  await states("connections", page => page.getByText(/needs? attention above/).first().waitFor({ timeout: 20_000 }), { at: /needs? attention above/ });
}

/**
 * Compass PR 4 (`--only compass-suggest`, docs/compass.md#suggestions-issues-nobodys-on): Nobody's on it in Needs you
 * (a raise and a Compass ask side by side), New's My issues with Compass's suggestions first, the brief's one Since
 * block, and Settings → Compass → When with the daytime read. The queue is briefSinceQueue's; compass.json is seeded
 * (readDay today, so no read replaces it). Fictional people and keys only.
 */
async function compassSuggestShots({ shoot, call, home, seeded }) {
  const data = join(home, "plugin-data", "follow-up");
  const now = BASE + VIEW;
  const iso = t => new Date(t).toISOString();
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  await fs.writeFile(join(home, "sources-fixture.json"), JSON.stringify({ compass: true }));
  await call("follow.brief-sources", { check: true });
  const view = await call("follow.set-compass", { source: { label: "Dana · product", who: { kind: "person", person: { id: "UDANA00001", name: "Dana" } }, places: [{ kind: "conversation", sub: "dm", id: "UDANA00001", name: "Dana" }], roles: ["priorities"] } });
  const src = view.settings.sources[0].id;
  await new Promise(r => setTimeout(r, 1500)); // the new place's first read lands before the seed replaces its notes
  const billing = seeded.workspaces.find(w => w.key === "billing");
  const at = iso(now - 3600_000);
  const n = (id, over) => ({ id, source: src, place: "conversation:UDANA00001", role: "priorities", by: { id: "UDANA00001", name: "Dana" }, at, link: "https://chat.example/archives/D1/p1", quote: null, what: "", keys: [], kind: "issue",
    strength: "normal", until: null, untilWords: null, state: "live", endedAt: null, supersededBy: null, match: { score: 0, how: "none" }, restatedAt: at, ...over });
  const notes = [
    n("n-renewal", { what: "acme renewal call", keys: ["ACME-177"], quote: "ACME-177 has to be fixed before the acme renewal call on Friday", strength: "high", until: day(now + 2 * 86_400_000), untilWords: "Friday", match: { issue: "ACME-177", score: 1, how: "key" } }),
    n("n-rotate", { what: "before the audit", keys: ["OPS-12"], quote: "OPS-12 should happen before the audit", match: { issue: "OPS-12", score: 1, how: "key" } }),
    n("n-sso", { what: "SSO for acme", keys: ["ACME-40"], quote: "acme keeps asking about SSO, ACME-40", strength: "low", match: { issue: "ACME-40", score: 1, how: "key" } }),
    n("n-billing", { kind: "workspace", what: "retries for the client call", quote: "the retry work is really important for the client call", strength: "high", until: day(now + 86_400_000), untilWords: "tomorrow", match: { workspace: billing.workspaceId, score: 0.7, how: "title" } }),
    n("n-okta", { what: "Okta SSO", state: "retracted", endedAt: iso(now - 1800_000), quote: "Okta SSO can wait" }),
    n("n-deck", { kind: "event", what: "the board deck", quote: "can you look at the board deck numbers" }),
  ];
  const seed = async () => {
    await fs.writeFile(join(data, "linear-queue.json"), JSON.stringify(briefSinceQueue()));
    await fs.writeFile(join(data, "compass.json"), JSON.stringify({ version: 1, cursors: {}, notes, day: null, readDay: day(now), lastRead: { at, trigger: "morning", ok: true, notes: 4, error: null }, refused: [], removed: [], dayReadAt: iso(now) }));
    await page0();
  };
  // A seed is read on the next read of each store; poke the home feed's answer so the push carries it.
  const page0 = () => call("follow.priorities", {}).catch(() => undefined);
  const each = async (name, drive, devices = [["desktop", DESKTOP], ["phone", PHONE]]) => {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of devices) {
      await seed();
      await shoot(`cs-${name}-${device}-${theme}`, viewport, theme, async page => {
        await page.setViewportSize(viewport);
        const clip = await drive(page, viewport.width < 768, viewport);
        await page.waitForTimeout(500);
        return clip;
      });
    }
  };
  // Needs you: the raise (ACME-142) and Dana's urgent ask (ACME-177), one row kind; hover reveals the x.
  await each("needs", async (page, phone) => {
    await openHome(page);
    const row = page.getByLabel(/^Needs you: ACME-177, nobody's on it/).filter({ visible: true }).first();
    await row.waitFor({ timeout: 30_000 });
    await page.getByLabel(/^Needs you: ACME-142, nobody's on it/).filter({ visible: true }).first().waitFor();
    if (!phone) await row.hover();
  });
  // The brief: one Since block, Compass's lines first.
  await each("since", async (page, phone) => {
    await openHome(page);
    if (phone) await page.getByText("Morning brief", { exact: true }).filter({ visible: true }).first().click();
    const head = page.getByText(/· Dana, your Linear queue$/).filter({ visible: true }).first();
    await head.waitFor({ timeout: 30_000 });
    await head.evaluate(e => e.scrollIntoView({ block: "start" }));
  });
  // New: My issues with OPS-12 moved up with its reason, ACME-177 and ACME-40 joining with the compass glyph.
  const dialog = page => page.locator('[role="dialog"][aria-label="Dispatch"]').filter({ visible: true }).first();
  await each("new", async (page, phone) => {
    await openHome(page);
    await page.getByRole("button", { name: /^Dispatch( \(.+\))?$/ }).filter({ visible: true }).last().click();
    await dialog(page).waitFor();
    await dialog(page).getByText("Dana: before the audit").filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    // Desktop: select OPS-12 (an issue the fake Linear has) so the preview shows its actions and {why}.
    if (!phone) await dialog(page).getByRole("button", { name: /^OPS-12 Rotate/ }).first().click();
  });
  // Settings → Compass → When: the morning read, then During the day and Issues nobody's on.
  await each("when", async (page, phone, viewport) => {
    await openSettingsAt(page, "brief", viewport);
    const h = page.getByText("During the day", { exact: true }).first();
    await h.waitFor({ timeout: 30_000 });
    await page.getByText("When", { exact: true }).first().evaluate(e => e.scrollIntoView({ block: "start" }));
    if (phone) return undefined;
    const back = await page.getByText(/Back to plugins/).first().boundingBox().catch(() => null);
    const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
    return { x, y: 0, width: viewport.width - x, height: viewport.height };
  });
}

async function morningBriefShots({ shoot, call, home }) {
  const A1 = "https://claude.ai/artifact/0a1b2c3d-week-plan", A2 = "https://claude.ai/artifact/7e6f5a4b-week-plan";
  const setChat = v => fs.writeFile(join(home, "chat-fixture.json"), JSON.stringify(v));
  const setSources = v => fs.writeFile(join(home, "sources-fixture.json"), JSON.stringify(v));
  let ranHealth = { health: {}, errors: {} };
  const seedRead = (url, title, items, ago = 2 * 3600_000) => fs.writeFile(join(home, "plugin-data", "follow-up", "ranker.json"), JSON.stringify({ version: 1, lastHash: null, lastRunAt: "2099-01-01T00:00:00.000Z", lastModelAt: null, day: null, runsToday: 0, ...ranHealth, notStarted: [], last: null, slackSince: null,
    planning: { url, at: new Date(BASE + VIEW - ago).toISOString(), value: { title, url, items: Array.from({ length: items }, (_, i) => ({ level: "milestone", title: `Milestone ${i + 1}`, keys: i < items - 3 ? [`ACME-${200 + i}`] : [] })) } }, prev: {}, model: null }));
  // Sources sit above the plan: the plan's states scroll to it; the Sources states stay at the top.
  const states = async (name, drive, { top = false } = {}) => {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await shoot(`mb-${name}-${device}-${theme}`, viewport, theme, async page => {
        await page.setViewportSize(viewport);
        await openSettingsAt(page, "brief", viewport);
        const plan = page.getByText("This week's plan", { exact: true }).first();
        await plan.waitFor();
        if (!top) await plan.evaluate(e => e.scrollIntoView({ block: "start" }));
        await drive?.(page);
        await page.waitForTimeout(300);
        // Desktop: only Follow-up's pane, from "Back to plugins" (the host's settings sidebar beside it isn't ours).
        if (viewport.width < 768) return undefined;
        const back = await page.getByText(/Back to plugins/).first().boundingBox().catch(() => null);
        const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
        return { x, y: 0, width: viewport.width - x, height: viewport.height };
      });
    }
  };
  // This week's plan comes from Compass: none until a source posts it; dana's DM (the fake history read) shares A1.
  await setSources({ compass: true });
  await states("plan-no-source", page => page.getByText("No source posts the plan").first().waitFor());
  await seedRead(A1, "Week of Mar 2", 18);
  await call("follow.set-compass", { source: { label: "Dana · product", who: { kind: "person", person: { id: "UDANA00001", name: "dana" } }, places: [{ kind: "conversation", sub: "dm", id: "UDANA00001", name: "dana" }], roles: ["priorities", "plan"] } });
  await call("follow.read-compass", {});
  await states("plan-found", page => page.getByText("Week of Mar 2").first().waitFor({ timeout: 30_000 }));
  // The plan's line under the source that posted it, at the top of the list.
  await states("plan-source", page => page.getByText(/Shared this week.s plan/).first().waitFor({ timeout: 30_000 }), { top: true });
  // The built-in inputs, in the same list: every source read (opening Settings asks the fake mcpproxy again).
  const sourcesReady = page => page.getByText(/^Checked /).first().waitFor({ timeout: 15_000 });
  const inputs = page => page.getByText("Your Linear queue", { exact: true }).first().evaluate(e => e.scrollIntoView({ block: "start" }));
  ranHealth = { health: { linear: "ok", slack: "ok", github: "ok", calendar: "ok", planning: "ok" }, errors: {} };
  await seedRead(A1, "Week of Mar 2", 18);
  await setSources({ compass: true, linear: true });
  await call("follow.sweep-queue", {});
  await states("sources", async page => { await sourcesReady(page); await inputs(page); }, { top: true });
  // One read failed (Retry), one server waiting for a sign-in, and mail there but off until turned on.
  ranHealth = { health: { linear: "ok", slack: "failed", github: "ok", planning: "ok" }, errors: { slack: "mcpproxy couldn't run the chat search." } };
  await seedRead(A1, "Week of Mar 2", 18);
  await setSources({ compass: true, linear: true, mail: true, upstreams: { calendar: { connected: false, authenticated: false, oauth: {} } } });
  await states("sources-failing", async page => { await sourcesReady(page); await page.getByText("mcpproxy couldn't run the chat search.").first().waitFor(); await inputs(page); }, { top: true });
  // Ask: a server no recipe fits (the tracker) shows Preview; the preview (the fake claude plans one read and sums it up)
  // shows what it would add, with Turn on.
  ranHealth = { health: { linear: "ok", slack: "ok", github: "ok", calendar: "ok", planning: "ok" }, errors: {} };
  await seedRead(A1, "Week of Mar 2", 18);
  await setSources({ compass: true, linear: true, ask: true });
  const trackerRow = page => page.getByText("tracker", { exact: true }).first().evaluate(e => e.scrollIntoView({ block: "center" }));
  await states("ask-off", async page => { await sourcesReady(page); await page.getByRole("button", { name: /Preview what Ask would read from tracker/ }).first().waitFor(); await trackerRow(page); }, { top: true });
  await call("follow.brief-sources", { check: true });
  await new Promise(r => setTimeout(r, 1500));
  await call("follow.set-brief-sources", { preview: "mcp:tracker" });
  await states("ask-preview", async page => { await sourcesReady(page); await page.getByText(/would add these 2 to today.s brief/).first().waitFor({ timeout: 30_000 }); await trackerRow(page); }, { top: true });
  await setSources({ compass: true });
  ranHealth = { health: {}, errors: {} };
  await call("follow.set-brief-plan", { link: A2, mode: "link" });
  // Read a minute after it was pasted (the daemon's clock is BASE + VIEW).
  await seedRead(A2, "Week 10 plan", 14, -60_000);
  await states("plan-pasted", page => page.getByText("Week 10 plan").first().waitFor());
  await call("follow.set-brief-plan", { mode: "off" });
  await states("plan-off", page => page.getByText("No plan", { exact: true }).first().waitFor());
  await states("when", async page => { const h = page.getByText("Workdays", { exact: true }).first(); await h.waitFor(); await h.scrollIntoViewIfNeeded(); await page.mouse.wheel(0, 600); });
  await briefSinceShots({ shoot, call, home });
}

/**
 * The brief's Since block, the queue screen and decision Q8's raised item (docs/morning-brief.md#in-the-brief), desktop
 * and phone, light and dark. The queue is seeded as linear-queue.json (the store reads a changed file again): a sweep
 * last Friday and one this morning, with the log between them, so "since" is Friday's sweep. Fictional keys only.
 */
function briefSinceQueue() {
  const now = BASE + VIEW, fri = now - 5 * 86_400_000, today = now - 3600_000;
  const iso = t => new Date(t).toISOString();
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const due = d => day(now + d * 86_400_000);
  const i = (key, title, priority, state, stateType, dueOn = null) => ({ key, title, priority, state, stateType, due: dueOn, team: "Acme", project: null, milestone: null, url: `https://linear.example/acme/issue/${key}`, updatedAt: iso(today) });
  const filler = Array.from({ length: 9 }, (_, n) => i(`ACME-${190 + n}`, ["Empty state for the reports list", "Sort invoices by due date", "Typo in the billing settings help text", "Export filters to CSV", "Keyboard focus ring on the date picker", "Paginate the audit log", "Trim whitespace in coupon codes", "Show the plan's renewal date", "Dark mode for the receipts page"][n], 4, "Backlog", "backlog"));
  const now_ = [
    i("ACME-177", "Webhook retries ignore the per-endpoint limit", 1, "Todo", "unstarted", due(2)),
    i("ACME-142", "Retry failed charges with exponential backoff", 2, "Todo", "unstarted"),
    i("ACME-151", "Export the audit log as CSV from the admin page", 2, "In Progress", "started", due(1)),
    i("ACME-158", "Search filters lose their state after Back", 3, "In Progress", "started"),
    i("APP-151", "Dunning email copy for failed renewals", 3, "Todo", "unstarted"),
    i("APP-139", "Rate-limit webhook retries per endpoint", 4, "Backlog", "backlog"),
    i("ACME-181", "Typo in the coupon help text", 4, "Backlog", "backlog"), i("ACME-182", "Empty state for the payouts list", 4, "Backlog", "backlog"), i("ACME-183", "Sort refunds by date", 4, "Backlog", "backlog"),
    ...filler,
    i("ACME-201", "Tidy the old billing feature flags", 0, "Backlog", "backlog"), i("ACME-202", "Rename the invoices table columns", 0, "Backlog", "backlog"),
  ];
  // Who opened each and when (the row's "opened by Dana · 12 days ago"): by you (the viewer, user-alice), by someone
  // else, no creator known (only the age), a due date plus a creator, and old issues that read as a date.
  const opened = {
    "ACME-177": [0.2, "Dana", "user-dana"], "ACME-142": [12, "Alice", "user-alice"], "ACME-151": [3, "Sam", "user-sam"], "ACME-158": [1, null, null],
    "APP-151": [40, "Dana", "user-dana"], "APP-139": [400, "Sam", "user-sam"], "ACME-201": [500, null, null], "ACME-202": [30, "Alice", "user-alice"],
  };
  for (const x of now_) { const [days, creator, creatorId] = opened[x.key] ?? [6, "Sam", "user-sam"]; Object.assign(x, { createdAt: iso(now - days * 86_400_000), creator, creatorId }); }
  const facts = x => ({ priority: x.priority, due: x.due, state: x.state });
  const before = now_.filter(x => !["ACME-177", "ACME-181", "ACME-182", "ACME-183"].includes(x.key)).map(x => x.key === "ACME-142" ? { ...x, priority: 4 } : x.key === "APP-139" ? { ...x, priority: 3 } : x.key === "ACME-151" ? { ...x, due: due(-1) } : x);
  before.push(i("ACME-120", "Retry receipts for refunded charges", 3, "In Progress", "started"), i("ACME-131", "Move the tax table to settings", 4, "Todo", "unstarted"));
  const byKey = list => Object.fromEntries(list.map(x => [x.key, x]));
  const prev = byKey(before);
  const log = [];
  for (const x of now_) { const b = prev[x.key]; if (!b) log.push({ at: iso(today), key: x.key, title: x.title, url: x.url, before: null, after: facts(x), left: null }); else if (JSON.stringify(facts(b)) !== JSON.stringify(facts(x))) log.push({ at: iso(today), key: x.key, title: x.title, url: x.url, before: facts(b), after: facts(x), left: null }); }
  log.push({ at: iso(today), key: "ACME-120", title: prev["ACME-120"].title, url: prev["ACME-120"].url, before: facts(prev["ACME-120"]), after: null, left: { cause: "done", state: "Done", to: null } });
  log.push({ at: iso(today), key: "ACME-131", title: prev["ACME-131"].title, url: prev["ACME-131"].url, before: facts(prev["ACME-131"]), after: null, left: { cause: "reassigned", state: null, to: "bob" } });
  return { version: 1, sweeps: [{ at: iso(today), complete: true, pages: 4, issues: byKey(now_) }, { at: iso(fri), complete: true, pages: 4, issues: prev }], log,
    last: { at: iso(today), trigger: "morning", ok: true, complete: true, pages: 4, reads: 2, durationMs: 4200, error: null, total: now_.length },
    seen: null, morningDay: day(now), viewer: "user-alice", dismissed: [] };
}
async function briefSinceShots({ shoot, call, home }) {
  const file = join(home, "plugin-data", "follow-up", "linear-queue.json");
  // Two issues already have a workspace (a linked Linear key; keys the fake Linear knows), so the queue shows its workspace chip, the filters'
  // counts differ, and the brief says "<workspace> has it".
  const { workspaces } = await call("follow.list", {});
  for (const [key, title] of [["APP-139", "Webhook signing"], ["APP-151", "Invoice PDFs"]]) {
    const w = workspaces.find(x => x.title === title);
    if (w) await call("follow.set-linked-items", { workspaceId: w.id, action: "add", ref: key }).catch(e => log(`brief-since: couldn't link ${key}: ${e.message}`));
  }
  const seed = () => fs.writeFile(file, JSON.stringify(briefSinceQueue()));
  const each = async (name, drive) => {
    for (const theme of ["light", "dark"]) for (const [device, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await seed();
      await shoot(`mb-${name}-${device}-${theme}`, viewport, theme, async page => {
        await page.setViewportSize(viewport);
        await openHome(page);
        await drive(page, viewport.width < 768);
        await page.waitForTimeout(400);
      });
    }
  };
  // Phones: the brief is its own row on Home's list; the Since block sits under the headline.
  const brief = async (page, phone) => {
    if (phone) await page.getByText("Morning brief", { exact: true }).filter({ visible: true }).first().click();
    const head = page.getByText(/your Linear queue$/).filter({ visible: true }).first();
    await head.waitFor({ timeout: 20_000 });
    await head.evaluate(e => e.scrollIntoView({ block: "start" }));
  };
  await each("since", brief);
  await each("queue-screen", async (page, phone) => {
    await brief(page, phone);
    await page.getByRole("link", { name: /Open your Linear queue/ }).filter({ visible: true }).first().click();
    await page.getByText("Your Linear queue", { exact: true }).filter({ visible: true }).first().waitFor();
    await page.getByText(/^Urgent · 1$/).filter({ visible: true }).first().waitFor();
  });
  // The raised issue is the first row of Needs you; hovering it reveals its x (invariant 59).
  await each("raised", async (page, phone) => {
    const row = page.getByLabel(/^Needs you: ACME-142, nobody's on it/).filter({ visible: true }).first();
    await row.waitFor({ timeout: 20_000 });
    if (!phone) await row.hover();
  });
}

async function settingsTabsShots({ shoot, out }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`settings-tabs: ${name}`); log(`settings-tabs check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const shape = page => page.evaluate(() => ({
    native: [...document.querySelectorAll('[data-testid^="plugin-settings-tab-"]')].filter(e => e.offsetParent).map(e => e.textContent.trim()),
    inner: [...document.querySelectorAll('[role="tablist"] [role="tab"]')].filter(e => e.offsetParent).map(e => e.textContent.trim()),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  const selected = page => page.evaluate(() => {
    const native = [...document.querySelectorAll('[data-testid^="plugin-settings-tab-"]')].find(e => e.offsetParent && (e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-checked") === "true" || e.closest("[aria-selected=true]")));
    const inner = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find(e => e.offsetParent);
    return (native ?? inner)?.textContent.trim() ?? null;
  });
  const order = Object.values(SETTINGS_TITLES);
  // 0.16+: from Paseo's plugin page's left edge ("Back to plugins"), so its tabs show whole; 0.15: Follow-up's pane.
  const settingsClip = async (page, vp) => {
    // Wait for the page: a missing anchor fails the shot rather than cropping at a guess.
    const back = nativeSettingsTabs ? await page.getByText("Back to plugins").filter({ visible: true }).first().boundingBox({ timeout: 15000 }) : null;
    if (nativeSettingsTabs && !back) throw new Error("settings-tabs: no \"Back to plugins\" to crop from");
    const x = back ? Math.max(0, Math.floor(back.x) - 32) : 400;
    return { x, y: 0, width: vp.width - x, height: vp.height };
  };
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) for (const category of Object.keys(SETTINGS_SCREENS)) {
    await shoot(`st-${category}-${size}-${theme}`, vp, theme, async page => {
      await page.setViewportSize(vp);
      await openSettingsAt(page, category, vp);
      await page.waitForTimeout(800);
      const got = await shape(page);
      if (nativeSettingsTabs) {
        check(`${size} ${theme} ${category}: Paseo's tabs are the five categories in order`, JSON.stringify(got.native) === JSON.stringify(order), got);
        check(`${size} ${theme} ${category}: Follow-up draws no tabs of its own`, got.inner.length === 0, got);
      } else if (vp.width >= 768) check(`${size} ${theme} ${category}: 0.15 keeps Follow-up's own tabs`, JSON.stringify(got.inner) === JSON.stringify(order), got);
      check(`${size} ${theme} ${category}: no horizontal page scroll`, !got.overflowX, got);
      // Only Follow-up's settings: the host settings sidebar beside it names the machine.
      return vp.width >= 768 ? await settingsClip(page, vp) : undefined;
    });
  }
  // Links into settings: the version mark on Home opens General, ⌘K reopens the last category (Reviewers here).
  await shoot("st-links-check", DESKTOP, "dark", async page => {
    await openSettingsAt(page, "reviewers", DESKTOP); await page.waitForTimeout(800);
    await openHome(page);
    await page.getByRole("button", { name: /^Follow-up version / }).filter({ visible: true }).first().click();
    await page.waitForTimeout(1500);
    check("the version mark opens General", /\/plugins\/follow-up\/projects$/.test(new URL(page.url()).pathname) && (!nativeSettingsTabs || await selected(page) === "General"), { url: new URL(page.url()).pathname, selected: await selected(page) });
    await openSettingsAt(page, "reviewers", DESKTOP); await page.waitForTimeout(800);
    await openHome(page);
    await page.keyboard.press("Control+k"); await page.waitForTimeout(400);
    await page.keyboard.type("Follow-up: settings"); await page.waitForTimeout(500); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
    const path = new URL(page.url()).pathname;
    check("⌘K Follow-up: settings reopens Reviewers", nativeSettingsTabs ? path.endsWith("/plugins/follow-up/reviewers") : await page.getByRole("tab", { name: /^Reviewers/, selected: true }).filter({ visible: true }).count() > 0, { url: path, selected: await selected(page) });
    return settingsClip(page, DESKTOP);
  });
  await fs.writeFile(join(out, "settings-tabs.json"), JSON.stringify(checks, null, 2));
  log(`settings-tabs: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
}
/** A fictional deploy check (Q55 mocks): the values live in host settings, set by an agent. */
const DEPLOY_FIXTURE = { gcpProject: "acme-prod", serviceLabel: "rollout-group=app", servicePrefix: "acme-service-app-", roles: ["backend", "web", "worker"], registry: "us-central1-docker.pkg.dev", imagePath: "acme-prod/acme-docker", images: ["prod-app-backend", "prod-app-web"] };
async function deployCheckShots({ shoot, call }) {
  // Settings → Following → PR workflow → Repositories → example/app, scrolled to its Deploy check row: set up, then not.
  const fold = async (page, vp) => {
    await page.setViewportSize(vp);
    await openSettingsAt(page, "following", vp);
    const header = page.getByRole("button", { name: /^example\/app, / }).filter({ visible: true }).first();
    await header.waitFor();
    if (await header.getAttribute("aria-expanded") !== "true") await header.click();
    const label = page.getByText("Deploy check", { exact: true }).filter({ visible: true }).first();
    await label.waitFor();
    await label.evaluate(el => el.scrollIntoView({ block: "center" }));
    // Only Follow-up's own pane: the host settings sidebar beside it names the machine.
    return vp.width >= 768 ? { x: 400, y: 0, width: vp.width - 400, height: vp.height } : undefined;
  };
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await call("follow.set-pr-workflow", { repo: "example/app", deploy: DEPLOY_FIXTURE });
    await shoot(`deploy-set-${size}-${theme}`, vp, theme, page => fold(page, vp));
    await call("follow.set-pr-workflow", { repo: "example/app", deploy: null });
    await shoot(`deploy-none-${size}-${theme}`, vp, theme, page => fold(page, vp));
  }
}
async function reviewModeShots({ shoot, call }) {
  // The Needs-you reviewers row with its quiet link, then the undo bar after it; the Settings fold with the Review menu
  // open on a No review repository. Desktop and phone, light and dark. Each shot puts example/app back to Team review.
  const title = REVIEW_MODE_STATES[0].title;
  const team = () => call("follow.set-pr-workflow", { repo: "example/app", review: null });
  const link = page => page.getByRole("button", { name: "Let the agent merge in example/app" }).filter({ visible: true }).first();
  const row = async (page, vp) => { await openHome(page); if (vp) await page.setViewportSize(vp); await (await homeRow(page, title)).click(); await link(page).waitFor(); };
  const fold = async (page, vp) => {
    await page.setViewportSize(vp);
    await openSettingsAt(page, "following", vp);
    const header = page.getByRole("button", { name: /^example\/app, / }).filter({ visible: true }).first();
    await header.waitFor();
    if (await header.getAttribute("aria-expanded") !== "true") await header.click();
    await page.getByRole("button", { name: /^Review for example\/app/ }).filter({ visible: true }).first().click();
    const menu = page.getByRole("menu", { name: "Review for example/app" }).first();
    await menu.waitFor();
    await menu.evaluate(el => el.scrollIntoView({ block: "center" }));
    // Only Follow-up's own pane: the host settings sidebar beside it names the machine.
    return vp.width >= 768 ? { x: 400, y: 0, width: vp.width - 400, height: vp.height } : undefined;
  };
  for (const theme of ["light", "dark"]) for (const [size, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await team();
    await shoot(`rm-row-${size}-${theme}`, vp, theme, page => row(page, vp));
    // The workspace panel (phone: the flag pill's sheet, the same Needs-you list): one reviewers ask, naming Ravi, count 1.
    await shoot(`rm-panel-${size}-${theme}`, vp, theme, async page => {
      await page.setViewportSize(DESKTOP); await openChat(page, title, REVIEW_MODE_STATES[0].prompt);
      if (size === "phone") { await page.setViewportSize(PHONE); await page.getByRole("button", { name: /^Follow-up · / }).last().click(); }
      else await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await link(page).waitFor();
    });
    // The undo bar lasts 10 s and settle() can take longer, so the drive captures it itself (rm-toast: the ask gone from
    // Needs you, the header and Home at once). Then it taps Undo, waits for the bar to leave and the ask to come back
    // (the inbox forgets the withdrawn reviewers key; the daemon re-asks on its next tick), and the shot is rm-undo.
    await shoot(`rm-undo-${size}-${theme}`, vp, theme, async page => {
      await row(page, vp); await link(page).click();
      const bar = page.getByText("example/app: no review. The agent merges its own PRs once checks pass.").filter({ visible: true }).first();
      await bar.waitFor();
      await link(page).waitFor({ state: "hidden", timeout: 5000 });
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300);
      await fs.writeFile(join(out, `follow-up-rm-toast-${size}-${theme}.png`), await page.screenshot({ animations: "disabled", caret: "hide" }));
      await page.getByRole("button", { name: /^Undo\b.*: example\/app: no review/ }).filter({ visible: true }).first().click();
      await bar.waitFor({ state: "hidden", timeout: 15000 });
      await link(page).waitFor({ timeout: 60000 });
      await page.getByText("Add reviewers to #246: Ravi").filter({ visible: true }).first().waitFor({ timeout: 60000 });
    });
    await team();
    await call("follow.set-pr-workflow", { repo: "example/app", review: "none" });
    await shoot(`rm-settings-${size}-${theme}`, { width: vp.width, height: size === "phone" ? 1100 : 1000 }, theme, page => fold(page, { width: vp.width, height: size === "phone" ? 1100 : 1000 }));
  }
  await team();
}
/**
 * own-answer (one-answer-flow-for-every-question): writing your own answer, and a note on a picked option, in the
 * panel and Home's Needs you (desktop and phone) and the dialog; plus the two-question card. Light and dark.
 * `--own-answer-before` drives the old form (a note field shown before any pick: type into it with nothing picked)
 * and prefixes each shot `before-`, for the PR's before and after.
 */
async function ownAnswerShots({ shoot }) {
  const before = argv.includes("--own-answer-before");
  const name = n => `${before ? "before-" : ""}oa-${n}`;
  const OWN = "Show the key itself, and log it so we add the translation.";
  const NOTE = "Only in production; staging should show the key.";
  const TALL = { width: DESKTOP.width, height: 1000 };
  const lone = pick("ny-lone"), two = pick("ny-two");
  const visible = l => l.filter({ visible: true }).first();
  const panel = (s, wait) => async page => { await page.setViewportSize(TALL); await openChat(page, s.title, s.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await visible(page.getByText(wait)).waitFor(); };
  const homePhone = (s, wait) => async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, s.title)).click(); await visible(page.getByText(wait)).waitFor(); };
  const dialog = (s, wait) => async page => {
    await panel(s, wait)(page);
    await visible(page.getByRole("tab", { name: /^Questions/ })).click();
    await visible(page.getByRole("button", { name: /^Q1, Missing keys/ })).click();
    await visible(page.getByRole("dialog")).waitFor();
  };
  const scope = page => page.getByRole("dialog").count().then(n => n ? page.getByRole("dialog").last() : page);
  const own = async page => {
    const root = await scope(page);
    if (before) { await visible(root.getByLabel("Note for the agent about Q1, optional")).fill(OWN); return; }
    await visible(root.getByRole("radio", { name: /^Something else/ })).click();
    await visible(root.getByLabel("Your answer to Q1, required")).fill(OWN);
  };
  const note = async page => {
    const root = await scope(page);
    await visible(root.getByRole("radio", { name: /^A\. The English text/ })).click();
    if (!before) await visible(root.getByRole("button", { name: "Add a note for the agent about Q1" })).click();
    await visible(root.getByLabel(before ? "Note for the agent about Q1, optional" : "Note for the agent, sent with A on Q1, optional")).fill(NOTE);
  };
  for (const theme of ["light", "dark"]) {
    await shoot(name(`own-panel-${theme}`), TALL, theme, async page => { await panel(lone, "Missing keys")(page); await own(page); });
    await shoot(name(`note-panel-${theme}`), TALL, theme, async page => { await panel(lone, "Missing keys")(page); await note(page); });
    if (!before) await shoot(name(`picked-panel-${theme}`), TALL, theme, async page => { await panel(lone, "Missing keys")(page); await visible(page.getByRole("radio", { name: /^A\. The English text/ })).click(); });
    await shoot(name(`own-home-phone-${theme}`), PHONE, theme, async page => { await homePhone(lone, "Missing keys")(page); await own(page); });
    await shoot(name(`note-home-phone-${theme}`), PHONE, theme, async page => { await homePhone(lone, "Missing keys")(page); await note(page); });
    await shoot(name(`own-dialog-${theme}`), DESKTOP, theme, async page => { await dialog(lone, "Missing keys")(page); await own(page); });
    await shoot(name(`two-panel-${theme}`), TALL, theme, panel(two, "Limit scope"));
    await shoot(name(`two-home-phone-${theme}`), PHONE, theme, homePhone(two, "Limit scope"));
  }
}

/**
 * more-context (more-context-is-the-same-on-every-surface): More context on a question outside Catch up, on the
 * panel's Needs you card (desktop), Home's detail pane (desktop) and Home on a phone, light and dark: closed (the quiet
 * link), open (I don't get it first, then your own words), pending (asked from the panel, shown everywhere) and replied
 * (the answer through follow.context-reply as the asked agent, shown everywhere).
 */
async function moreContextShots({ shoot, call }) {
  const TALL = { width: DESKTOP.width, height: 1000 };
  const lone = pick("ny-lone");
  const visible = l => l.filter({ visible: true }).first();
  const surfaces = {
    panel: [TALL, async page => { await page.setViewportSize(TALL); await openChat(page, lone.title, lone.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await visible(page.getByText("Missing keys")).waitFor(); }],
    home: [DESKTOP, async page => { await openHome(page); await (await homeRow(page, lone.title)).click(); await visible(page.getByText("Missing keys")).waitFor(); }],
    "home-phone": [PHONE, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, lone.title)).click(); await visible(page.getByText("Missing keys")).waitFor(); }],
  };
  const link = page => visible(page.getByRole("button", { name: "More context on Q1" }));
  const settle = async (page, l) => { await l.scrollIntoViewIfNeeded(); await page.waitForTimeout(500); };
  const each = async (state, then) => { for (const theme of ["light", "dark"]) for (const [where, [frame, open]] of Object.entries(surfaces)) await shoot(`mc-${state}-${where}-${theme}`, frame, theme, async page => { await open(page); await then(page); }); };
  await each("closed", async page => settle(page, await link(page)));
  await each("open", async page => { await (await link(page)).click(); await settle(page, visible(page.getByLabel("What do you want to know?"))); });
  // Asked once, from the panel: every surface shows it pending.
  await shoot("mc-ask-panel-dark", TALL, "dark", async page => {
    await surfaces.panel[1](page); await (await link(page)).click();
    await visible(page.getByRole("button", { name: /^Ask the agent/ })).click();
    await settle(page, visible(page.getByText(/the answer shows here when it comes/)));
  });
  const asked = (await call("follow.context-list", {})).requests.filter(r => r.state === "asking").at(-1);
  if (!asked) throw new Error("more-context: the ask from the panel wasn't recorded");
  if (!/^ws:.*\|Q1$/.test(asked.cardKey)) throw new Error(`more-context: the panel asked under ${asked.cardKey}, not the question's own card`);
  await each("pending", async page => settle(page, visible(page.getByText(/the answer shows here when it comes/))));
  await call("follow.context-reply", { agentId: asked.askedOf, requestId: asked.id, text: "Both languages are missing the key only for strings added this sprint. **The English text** keeps the page readable for customers; **the key itself** makes the gap obvious to translators but shows raw ids like checkout.total to users. Most teams show English in production and the key in staging." });
  await each("replied", async page => settle(page, visible(page.getByText(/Most teams show English in production/))));
}

/**
 * your-questions (docs/needs-you.md#your-questions): the Your questions card in the panel and Home's detail pane (an
 * answer to read, one still asking, the history), Reply's field, the history (in the card on desktop, a sheet on a
 * phone), Catch up's answer card and the chat's "Your question" chip, desktop and 390×844, light and dark. Seeded through
 * follow.context-ask as the developer and follow.context-reply as the asked agent: three answered and closed (two Done,
 * one a task), one to read, and one still asking.
 */
async function yourQuestionsShots({ shoot, call, seeded, home, cli }) {
  const billing = seeded.workspaces.find(w => w.key === "billing");
  const spec = WORKSPACES.find(w => w.key === "billing");
  const TALL = { width: DESKTOP.width, height: 1100 };
  const scriptsFile = join(home, "fixture-scripts.json");
  const agentSays = async steps => { const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8")); scripts[`agent:${billing.agentId}`] = steps; await fs.writeFile(scriptsFile, JSON.stringify(scripts)); };
  const question = async id => (await call("follow.context-list", { workspaceId: billing.workspaceId })).requests.find(r => r.id === id);
  const ask = async text => (await call("follow.context-ask", { workspaceId: billing.workspaceId, ask: text, via: "field" })).request;
  // The harness's crawling clock holds the queue's send, so each answer comes as the asked agent's context_reply (the
  // path a real agent takes), and the chat gets the question's own message straight from the CLI (what the queue sends).
  const answer = (r, text) => call("follow.context-reply", { agentId: r.askedOf, requestId: r.id, text });
  for (const [text, reply, then] of [
    ["Is the dead-letter queue shared with refunds?", "No. Refunds have their own queue (refunds-dlq); billing retries only ever write to charges-dlq.", "done"],
    ["What happens to a charge that fails after the third try?", "It stays declined, the dunning email goes out, and the charge moves to charges-dlq for a person to look at.", "task"],
    ["Which alert fires if the retry worker stops?", "RetryWorkerStalled, after 10 minutes without a heartbeat. It pages the billing on-call.", "done"],
  ]) {
    const r = await ask(text);
    await answer(r, reply);
    await call("follow.question-action", { id: r.id, action: then });
  }
  const A1 = "Because the payment gateway already retries for 60 s on its side. A fixed 30 s gap keeps us inside its idempotency window; exponential backoff would push the third try to 120 s, after the key expires, and could charge twice.\n\nIf you want exponential anyway, cap it at 45 s. That's a one-line change in `retry-policy.ts`.";
  const q1 = await ask("Why does the retry use a fixed 30 s gap instead of exponential backoff?");
  // The message agentQuestionPrompt writes for a developer's first question (shared/your-questions.ts; this script runs
  // under plain node, so it mirrors the one format here: keep the two in step).
  const prompt = r => `Your question (${r.id}) · answer with context_reply:\n${r.ask}`;
  await agentSays([{ item: { type: "assistant_message", text: A1 } }]);
  const promptFile = join(home, "yq-prompt.txt");
  await fs.writeFile(promptFile, prompt(q1));
  await cli("send", billing.agentId, "--prompt-file", promptFile, "--no-wait");
  await answer(q1, A1);
  // Still asking: queued behind the agent's turn.
  await ask("Does #143 need a data migration, or is the new column nullable?");
  const visible = l => l.filter({ visible: true }).first();
  const card = page => visible(page.locator("[data-your-questions]"));
  const ready = async page => { await visible(page.getByText(/fixed 30 s gap keeps us/)).waitFor({ timeout: 60_000 }); };
  const panel = async page => { await page.setViewportSize(TALL); await openChat(page, spec.title, spec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await ready(page); await card(page).scrollIntoViewIfNeeded(); };
  const panelPhone = async page => { await openChat(page, spec.title, spec.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click(); await page.setViewportSize(PHONE); await ready(page); await card(page).evaluate(el => el.scrollIntoView({ block: "start" })); };
  // `top`: Needs you's end above the card's start, so the pane's order shows (the workspace's own Needs you first).
  const homeAt = async (page, vp, { top = false } = {}) => { await openHome(page); if (vp !== DESKTOP) await page.setViewportSize(vp); await (await homeRow(page, spec.title)).click(); await ready(page); await card(page).evaluate((el, top) => { el.scrollIntoView({ block: "start" }); if (!top) return; let p = el.parentElement; while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement; if (p) p.scrollTop -= 360; }, top); };
  const noOverflow = async (page, name) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 1) throw new Error(`${name} scrolls sideways (${o}px)`); };
  // keepFocus: the reply field keeps its focus for the shot, so the pane shows what typing looks like (the dock steps
  // aside and the field with its Send scrolls into view, invariant 43).
  const reply = async page => { page.keepFocus = true; await visible(page.getByRole("button", { name: "Reply", exact: true })).click(); await visible(page.getByLabel("Your reply")).fill("Cap it at 45 s and open a PR"); await page.waitForTimeout(800); };
  // Desktop unfolds the history in the card: scroll so its row is at the top and the opened list shows under it.
  const history = async page => { const row = visible(page.getByRole("button", { name: /^History, \d+ questions?/ })); await row.click(); await visible(page.getByLabel("Search questions and answers")).waitFor(); if (page.viewportSize().width > PHONE.width) await row.evaluate(el => el.scrollIntoView({ block: "start" })); await page.waitForTimeout(400); };
  const catchUp = async (page, vp) => {
    await openHome(page); if (vp === PHONE) await page.setViewportSize(PHONE);
    await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
    await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().waitFor();
    for (let i = 0; !(await visible(page.locator("[data-catch-up-card]").getByText(/fixed 30 s gap keeps us/)).isVisible()); i++) {
      if (i > 40) throw new Error("your-questions: no Catch up card shows the answer");
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
  };
  // The question's message stays Paseo's own user row, so it starts its own turn and shows under "Collapse turns".
  const chat = async (page, vp) => { await openChat(page, spec.title, spec.prompt); if (vp === PHONE) await page.setViewportSize(PHONE); const msg = visible(page.getByText(/^Your question \(ctx-[0-9a-f]{8}\) · answer with context_reply:/)); await msg.waitFor({ timeout: 60_000 }); await msg.evaluate(el => el.scrollIntoView({ block: "center" })); await page.waitForTimeout(400); };
  for (const theme of ["light", "dark"]) {
    const each = async (name, vp, drive) => shoot(`yq-${name}-${theme}`, vp, theme, async page => { await drive(page); await noOverflow(page, name); });
    await each("panel-desktop", TALL, panel);
    await each("panel-phone", PHONE, panelPhone);
    await each("home-desktop", TALL, page => homeAt(page, TALL, { top: true }));
    await each("home-phone", PHONE, page => homeAt(page, PHONE));
    await each("reply-desktop", TALL, async page => { await panel(page); await reply(page); });
    await each("reply-phone", PHONE, async page => { await homeAt(page, PHONE); await reply(page); });
    await each("history-desktop", TALL, async page => { await panel(page); await history(page); });
    await each("history-phone", PHONE, async page => { await homeAt(page, PHONE); await history(page); });
    await each("catchup-desktop", DESKTOP, page => catchUp(page, DESKTOP));
    await each("catchup-phone", PHONE, page => catchUp(page, PHONE));
    await each("chat-desktop", DESKTOP, page => chat(page, DESKTOP));
    await each("chat-phone", PHONE, page => chat(page, PHONE));
  }
  // Last, since it changes the agent's state: the main agent mid-turn (a held turn), so Paseo's directory has the
  // workspace running and the still-queued question says why it waits.
  await agentSays([{ hold: true }]);
  const holdFile = join(home, "yq-hold.txt");
  await fs.writeFile(holdFile, "Carry on with the dunning email.");
  await cli("send", billing.agentId, "--prompt-file", holdFile, "--no-wait");
  for (const theme of ["light", "dark"]) await shoot(`yq-midturn-phone-${theme}`, PHONE, theme, async page => {
    await panelPhone(page);
    await visible(page.getByText(/· the agent is mid-turn$/)).waitFor({ timeout: 90_000 });
    await visible(page.getByText(/· the agent is mid-turn$/)).evaluate(el => el.scrollIntoView({ block: "center" }));
    await noOverflow(page, "midturn-phone");
  });
}

/**
 * paste-images (every-agent-field-takes-images, docs/client.md#pasted-images): New with two pasted images, the
 * Overseer's reply box with one, a question's own answer with one, and the refusal past the cap (seven at once), desktop
 * and 390x844, light and dark. The images are fake app screenshots drawn on a canvas in the page, never anything from
 * the machine; each paste is a real ClipboardEvent on the field. The fixture provider counts as taking images here
 * (FOLLOW_UP_HARNESS_IMAGE_PROVIDERS, honoured only under the temp dir). Writes paste-images.json with every check.
 */
/**
 * attach-images (every-agent-field-takes-images): the Add image button on every kind of field, desktop light and
 * 390×844 dark. New's task field (inline, before ⌘V), a question's own answer (under the field), then a real pick
 * through the browser's file chooser (Playwright answers it with a canvas-drawn screenshot) showing its thumbnail, and
 * the Overseer's reply box (beside Send) with Home's search asking the Overseer (at its end), six pasted and Add image
 * pressed at the cap. Checks: the chooser takes only image types, several at once; a pick adds a thumbnail to its own
 * field; at the cap no picker opens and the line says why; no horizontal overflow. Writes `attach-images.json`.
 */
async function attachImagesShots({ shoot, call }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`attach-images: ${name}`); log(`attach-images check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const visible = l => l.filter({ visible: true }).first();
  const lone = pick("ny-lone");
  const thumbs = page => page.getByRole("button", { name: /^Remove .+\.png$/ }).filter({ visible: true });
  const noOverflow = async (page, name) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check(`${name}: no horizontal overflow`, o <= 1, { overflow: o }); };
  /** A fake app screenshot, drawn on a canvas in the page, as the file the chooser hands over. */
  const screenshotFile = async (page, name) => ({ name, mimeType: "image/png", buffer: Buffer.from(await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 400; const g = c.getContext("2d");
    g.fillStyle = "#f6f7f9"; g.fillRect(0, 0, 640, 400); g.fillStyle = "hsl(152 45% 28%)"; g.fillRect(0, 0, 640, 44);
    g.fillStyle = "#fff"; g.font = "600 18px sans-serif"; g.fillText("acme · staging keys", 18, 28);
    for (let b = 0; b < 12; b++) { const h = 30 + ((b * 37) % 150); g.fillStyle = `hsl(152 60% ${50 + (b % 3) * 8}%)`; g.fillRect(180 + b * 35, 356 - h, 22, h); }
    return c.toDataURL("image/png").split(",")[1];
  }), "base64") });
  /** Clicks the Add image button and answers the browser's chooser; returns what the chooser asked for. */
  const pickThrough = async (page, button, name) => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
    const accept = await chooser.element().evaluate(el => el.getAttribute("accept"));
    await chooser.setFiles(await screenshotFile(page, name));
    return { accept, multiple: chooser.isMultiple() };
  };
  await call("follow.overseer-start", {});
  for (const [device, vp, theme] of [["desktop", DESKTOP, "light"], ["phone", PHONE, "dark"]]) {
    const phone = vp.width < 768;
    const name = state => `ai-${state}-${device}-${theme}`;
    await shoot(name("new"), vp, theme, async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await page.getByRole("button", { name: /^Dispatch( \(.+\))?$/ }).filter({ visible: true }).last().click();
      const dialog = visible(page.locator('[role="dialog"][aria-label="Dispatch"]'));
      await dialog.waitFor();
      check(`${device} ${theme}: New's task field has Add image`, await dialog.getByRole("button", { name: "Add image" }).filter({ visible: true }).count() === 1);
      await page.waitForTimeout(400); await noOverflow(page, name("new"));
    });
    await shoot(name("question"), vp, theme, async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await (await homeRow(page, lone.title)).click(); await visible(page.getByText("Missing keys")).waitFor();
      await visible(page.getByRole("radio", { name: /^Something else/ })).click();
      const field = visible(page.getByLabel("Your answer to Q1, required"));
      await field.fill("Show the key, like this screenshot from staging.");
      // The answer's own Add image (Home's search has one too while it asks the Overseer): the one in the field's form.
      const form = field.locator("xpath=ancestor::*[.//*[@role='button' and @aria-label='Add image']][1]");
      const add = form.getByRole("button", { name: "Add image" }).first();
      const asked = await pickThrough(page, add, "staging-keys.png");
      check(`${device} ${theme}: the chooser takes image types only, several at once`, asked.accept === "image/png,image/jpeg,image/gif,image/webp" && asked.multiple, asked);
      const x = form.getByRole("button", { name: "Remove staging-keys.png" });
      await x.waitFor();
      check(`${device} ${theme}: a pick adds its thumbnail to that field, and nowhere else`, await thumbs(page).count() === 1 && await form.getByRole("button", { name: /^Remove / }).count() === 1);
      await x.evaluate(el => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400); await noOverflow(page, name("question"));
    });
    await shoot(name("overseer"), vp, theme, async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await visible(page.getByRole("button", { name: /^Overseer\. / })).click();
      const reply = visible(page.getByRole("textbox", { name: "Reply to the Overseer" }));
      await reply.waitFor();
      const box = reply.locator("xpath=ancestor::*[.//*[@aria-label='Send']][1]");
      check(`${device} ${theme}: the Overseer's reply box has Add image beside Send`, await box.getByRole("button", { name: "Add image", exact: true }).count() === 1);
      if (!phone) check(`${device} ${theme}: Home's search asking the Overseer has Add image for the Overseer`, await page.getByRole("button", { name: "Add image for the Overseer" }).filter({ visible: true }).count() === 1);
      // At the cap: six pasted, then Add image opens no picker and says why on the box's line.
      await reply.fill("Six screenshots of the billing chart");
      await reply.evaluate(async el => {
        const data = new DataTransfer();
        for (let i = 0; i < 6; i++) {
          const c = document.createElement("canvas"); c.width = 320; c.height = 200; const g = c.getContext("2d");
          g.fillStyle = "#f6f7f9"; g.fillRect(0, 0, 320, 200); g.fillStyle = `hsl(${[214, 152, 28, 280, 350, 190][i]} 50% 45%)`; g.fillRect(0, 0, 320, 28);
          for (let b = 0; b < 8; b++) g.fillRect(40 + b * 32, 180 - (20 + ((b * 29 + i * 17) % 110)), 18, 20 + ((b * 29 + i * 17) % 110));
          data.items.add(new File([await new Promise(r => c.toBlob(r, "image/png"))], `billing-${i + 1}.png`, { type: "image/png" }));
        }
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      // The thumbnails and the line sit in the composer above the field's row (box is that row).
      await visible(page.getByRole("button", { name: "Remove billing-6.png" })).waitFor();
      let opened = false; page.once("filechooser", () => { opened = true; });
      await box.getByRole("button", { name: "Add image", exact: true }).click();
      const line = visible(page.getByText("6 images is the most one message takes. Nothing was added."));
      await line.waitFor();
      await page.waitForTimeout(300);
      check(`${device} ${theme}: Add image at the cap opens no picker and says why`, !opened && await line.isVisible());
      await page.waitForTimeout(400); await noOverflow(page, name("overseer"));
    });
  }
  await fs.writeFile(join(out, "attach-images.json"), JSON.stringify({ checks }, null, 2));
}

async function pasteImagesShots({ shoot, call }) {
  const checks = [];
  const check = (name, okay, detail = {}) => { checks.push({ name, ok: !!okay, ...detail }); if (!okay) failures.push(`paste-images: ${name}`); log(`paste-images check ${okay ? "ok" : "FAILED"}: ${name} ${JSON.stringify(detail)}`); };
  const visible = l => l.filter({ visible: true }).first();
  const lone = pick("ny-lone");
  /** Pastes fake app screenshots into the field: each a canvas-drawn dashboard (title bar, sidebar, cards, a chart). */
  const paste = (field, names) => field.evaluate(async (el, names) => {
    const shot = (i, name) => new Promise(resolve => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 400; const g = c.getContext("2d");
      const hue = [214, 152, 28, 280, 350, 190, 60][i % 7];
      g.fillStyle = "#f6f7f9"; g.fillRect(0, 0, 640, 400);
      g.fillStyle = `hsl(${hue} 45% 28%)`; g.fillRect(0, 0, 640, 44);
      g.fillStyle = "#fff"; g.font = "600 18px sans-serif"; g.fillText(`acme · ${name.replace(/\.png$/, "")}`, 18, 28);
      g.fillStyle = "#e3e6eb"; g.fillRect(0, 44, 140, 356);
      for (let r = 0; r < 6; r++) { g.fillStyle = r === 1 ? `hsl(${hue} 60% 85%)` : "#cfd4db"; g.fillRect(16, 66 + r * 34, 108, 14); }
      for (let k = 0; k < 3; k++) { g.fillStyle = "#fff"; g.fillRect(160 + k * 156, 64, 140, 72); g.fillStyle = `hsl(${hue} 55% ${40 + k * 10}%)`; g.font = "700 26px sans-serif"; g.fillText(String([128, 42, 7][k]), 176 + k * 156, 112); }
      g.fillStyle = "#fff"; g.fillRect(160, 152, 452, 224);
      for (let b = 0; b < 12; b++) { const h = 30 + ((b * 37 + i * 23) % 150); g.fillStyle = `hsl(${hue} 60% ${50 + (b % 3) * 8}%)`; g.fillRect(180 + b * 35, 356 - h, 22, h); }
      c.toBlob(resolve, "image/png");
    });
    const data = new DataTransfer();
    for (const [i, name] of names.entries()) data.items.add(new File([await shot(i, name)], name, { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, names);
  const thumbs = page => page.getByRole("button", { name: /^Remove .+\.png$/ }).filter({ visible: true });
  const noOverflow = async (page, name) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check(`${name}: no horizontal overflow`, o <= 1, { overflow: o }); };
  const settle = async page => { await page.waitForTimeout(600); };

  // The Overseer, started on the fixture provider: its pane's reply box.
  await call("follow.overseer-start", {});
  const NEW_FIELD = "Task";
  for (const theme of ["light", "dark"]) for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    const phone = vp.width < 768;
    const name = state => `pi-${state}-${device}-${theme}`;
    await shoot(name("new"), vp, theme, async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await page.getByRole("button", { name: /^Dispatch( \(.+\))?$/ }).filter({ visible: true }).last().click();
      const dialog = visible(page.locator('[role="dialog"][aria-label="Dispatch"]'));
      await dialog.waitFor();
      const field = visible(dialog.getByRole("textbox", { name: NEW_FIELD }));
      await field.fill("The revenue chart overlaps its legend at narrow widths. Screenshots attached.");
      await paste(field, ["revenue-chart.png", "legend-overlap.png"]);
      await visible(dialog.getByRole("button", { name: "Remove legend-overlap.png" })).waitFor();
      check(`${device} ${theme}: New shows both thumbnails`, await thumbs(page).count() === 2);
      // The source card (desktop) or the bar's line (phone) counts them once the plan re-renders.
      const counted = await page.getByText(/· 2 images/).filter({ visible: true }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      check(`${device} ${theme}: New's summary counts the images`, counted);
      await settle(page); await noOverflow(page, name("new"));
    });
    await shoot(name("overseer"), vp, theme, async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await visible(page.getByRole("button", { name: /^Overseer\. / })).click();
      const field = visible(page.getByRole("textbox", { name: "Reply to the Overseer" }));
      await field.waitFor();
      await field.fill("Ask the billing agent why the chart looks like this");
      await paste(field, ["billing-chart.png"]);
      await visible(page.getByRole("button", { name: "Remove billing-chart.png" })).waitFor();
      check(`${device} ${theme}: the Overseer's reply shows one thumbnail`, await thumbs(page).count() === 1);
      // A click on the thumbnail shows it larger; the X closes it and the image stays attached.
      await visible(page.getByRole("button", { name: /^View billing-chart\.png/ })).click();
      const viewer = page.getByRole("dialog", { name: /^billing-chart\.png/ });
      await viewer.waitFor();
      check(`${device} ${theme}: a thumbnail opens the viewer`, await viewer.count() > 0);
      await page.getByRole("button", { name: "Close image" }).click();
      await viewer.waitFor({ state: "detached" });
      check(`${device} ${theme}: closing the viewer keeps the image`, await thumbs(page).count() === 1);
      await settle(page); await noOverflow(page, name("overseer"));
    });
    const ownAnswer = async page => {
      await openHome(page); if (phone) { await page.setViewportSize(vp); await page.waitForTimeout(300); }
      await (await homeRow(page, lone.title)).click(); await visible(page.getByText("Missing keys")).waitFor();
      await visible(page.getByRole("radio", { name: /^Something else/ })).click();
      const field = visible(page.getByLabel("Your answer to Q1, required"));
      await field.fill("Show the key, like this screenshot from staging.");
      return field;
    };
    await shoot(name("question"), vp, theme, async page => {
      const field = await ownAnswer(page);
      await field.focus();
      await paste(field, ["staging-keys.png"]);
      const x = visible(page.getByRole("button", { name: "Remove staging-keys.png" }));
      await x.waitFor();
      // Centred: the phone dock covers the page's last rows, where the thumbnail would sit.
      await x.evaluate(el => el.scrollIntoView({ block: "center" }));
      check(`${device} ${theme}: the question's answer shows one thumbnail`, await thumbs(page).count() === 1);
      await settle(page); await noOverflow(page, name("question"));
    });
    await shoot(name("refusal"), vp, theme, async page => {
      const field = await ownAnswer(page);
      await field.focus();
      await paste(field, ["one.png", "two.png", "three.png", "four.png", "five.png", "six.png", "seven.png"]);
      const line = visible(page.getByText("6 images is the most one message takes."));
      await line.waitFor();
      // Centred, as a focused field sits: the phone dock covers the page's last rows.
      await line.evaluate(el => el.scrollIntoView({ block: "center" }));
      check(`${device} ${theme}: seven at once is refused with the reason, and none is added`, await thumbs(page).count() === 0);
      await settle(page); await noOverflow(page, name("refusal"));
    });
  }
  await fs.writeFile(join(out, "paste-images.json"), JSON.stringify({ checks }, null, 2));
}

/**
 * dismiss (dismissing-anything-in-needs-you-sends-the-agent-nothing): the small x on every Needs-you item. In the panel:
 * an agent's Action brief at rest (no x) and hovered (the x beside its age), the question card's x (no Dismiss link in
 * its quiet row), and a merge row's x; after Dismiss, the toast with Undo; Catch up's card with its x always shown; Home's
 * detail pane on a phone, x always there. Armed (the first click: the red Dismiss pill in place) on a merge row, a brief,
 * Catch up's card (⇧D) and a phone; after the second click, the toast with Undo. Light and dark. Every dismissal is undone through follow.dismiss before the
 * next shot, and the run fails if any dismissal queued a message.
 */
async function dismissShots({ shoot, call }) {
  const TALL = { width: DESKTOP.width, height: 1000 };
  const brief = pick("ny-other"), lone = pick("ny-lone"), merge = pick("mc-receipts");
  const visible = l => l.filter({ visible: true }).first();
  const list = async () => (await call("follow.list", {})).workspaces;
  const wsOf = async title => (await list()).find(w => w.title === title);
  const queued = async () => { let n = 0; for (const t of [brief.title, lone.title, merge.title]) n += (await call("follow.queue-list", { workspaceId: (await wsOf(t)).id })).items.length; return n; };
  const before = await queued();
  // Put back whatever a shot dismissed, so the next shot starts from the same Needs you.
  const restore = async () => {
    const q = (await wsOf(lone.title)).questions.find(q => q.id === "Q1");
    if (q.closed) await call("follow.dismiss", { workspaceId: (await wsOf(lone.title)).id, key: "question:Q1", undo: true });
    const m = await wsOf(merge.title);
    for (const d of m.dismissed ?? []) await call("follow.dismiss", { workspaceId: m.id, key: d.key, undo: true });
    const b = await wsOf(brief.title);
    await call("follow.dismiss", { agentId: b.mainAgentId, undo: true }).catch(() => undefined);
  };
  const panel = async (page, w, text) => { await page.setViewportSize(TALL); await openChat(page, w.title, w.prompt); await page.getByRole("button", { name: "Follow-up", exact: true }).last().click(); await visible(page.getByText(text)).waitFor(); };
  const x = (page, name) => visible(page.getByRole("button", { name }));
  const away = async page => { await page.mouse.move(2, 2); await page.waitForTimeout(400); };
  const BRIEF_X = /^Remove the agent's ask/, Q_X = /^Remove Q1/, MERGE_X = /^Remove #255/;
  for (const theme of ["light", "dark"]) {
    await shoot(`dx-brief-rest-${theme}`, TALL, theme, async page => { await panel(page, brief, "Approve the staging export bucket"); await away(page); });
    await shoot(`dx-brief-hover-${theme}`, TALL, theme, async page => { await panel(page, brief, "Approve the staging export bucket");
      // The panel's copy (the chat has the same card): point at its header, left of its x, so the x shows unhovered. The
      // x draws once the live check says the ask is still open, so wait for it.
      const box = await (await page.waitForFunction(min => { for (const e of document.querySelectorAll('[aria-label^="Remove the agent\'s ask"]')) { const r = e.getBoundingClientRect(); if (r.x > min) return { x: r.x, y: r.y, height: r.height }; } return null; }, TALL.width - 320)).jsonValue();
      await page.mouse.move(box.x - 150, box.y + box.height / 2); page.keepPointer = true; await page.waitForTimeout(400); });
    await shoot(`dx-question-${theme}`, TALL, theme, async page => { await panel(page, lone, "Missing keys"); await visible(page.getByText(/When a key is missing in both/)).hover(); await (await x(page, Q_X)).waitFor(); page.keepPointer = true; await page.waitForTimeout(300); });
    await shoot(`dx-merge-${theme}`, TALL, theme, async page => { await panel(page, merge, "#255 is approved"); await visible(page.getByText("#255 is approved")).hover(); await (await x(page, MERGE_X)).waitFor(); page.keepPointer = true; await page.waitForTimeout(300); });
    // Two clicks in place (dismiss-takes-two-clicks-in-place): the first arms the x into the red pill, the second
    // dismisses. The run fails if one click dismissed anything.
    const arm = async (page, name) => { await (await x(page, name)).click(); await visible(page.getByRole("button", { name: /^Keep / })).waitFor(); page.keepPointer = true; page.keepFocus = true; await page.waitForTimeout(300); };
    await shoot(`dx-merge-armed-${theme}`, TALL, theme, async page => { await panel(page, merge, "#255 is approved"); await visible(page.getByText("#255 is approved")).hover(); await arm(page, MERGE_X); });
    await shoot(`dx-brief-armed-${theme}`, TALL, theme, async page => { await panel(page, brief, "Approve the staging export bucket"); await visible(page.getByText("Approve the staging export bucket")).hover(); await arm(page, BRIEF_X); });
    await shoot(`dx-undo-${theme}`, TALL, theme, async page => {
      await panel(page, brief, "Approve the staging export bucket"); await visible(page.getByText("Approve the staging export bucket")).hover();
      await arm(page, BRIEF_X);
      if (await page.getByText(/^Removed the agent's ask\./).count()) throw new Error("dismiss: one click dismissed");
      await (await x(page, BRIEF_X)).click(); await visible(page.getByText(/^Removed the agent's ask\. The agent wasn't messaged\.$/)).waitFor(); await page.waitForTimeout(300);
    });
    await restore();
    await shoot(`dx-catch-up-${theme}`, DESKTOP, theme, async page => {
      await openHome(page);
      await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
      for (let i = 0; !(await page.locator("[data-catch-up-card]").getByText("#255 is approved").filter({ visible: true }).first().isVisible()); i++) {
        if (i > 40) throw new Error("dismiss: no Catch up card for #255");
        await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(250);
      }
      await away(page);
    });
    await shoot(`dx-catch-up-armed-${theme}`, DESKTOP, theme, async page => {
      await openHome(page);
      await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
      for (let i = 0; !(await page.locator("[data-catch-up-card]").getByText("#255 is approved").filter({ visible: true }).first().isVisible()); i++) {
        if (i > 40) throw new Error("dismiss: no Catch up card for #255");
        await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click(); await page.waitForTimeout(250);
      }
      // ⇧D presses the card's x: once arms it.
      await page.keyboard.press("Shift+D"); await visible(page.getByRole("button", { name: /^Keep / })).waitFor(); page.keepFocus = true; await page.waitForTimeout(300);
    });
    await shoot(`dx-phone-armed-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, brief.title)).click(); await (await x(page, BRIEF_X)).scrollIntoViewIfNeeded(); await arm(page, BRIEF_X); });
    await shoot(`dx-phone-undo-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, brief.title)).click(); await (await x(page, BRIEF_X)).scrollIntoViewIfNeeded(); await arm(page, BRIEF_X);
      await (await x(page, BRIEF_X)).click(); await visible(page.getByText(/^Removed the agent's ask\. The agent wasn't messaged\.$/)).waitFor(); await page.waitForTimeout(300); });
    await restore();
    await shoot(`dx-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, brief.title)).click(); await (await x(page, BRIEF_X)).scrollIntoViewIfNeeded(); await page.waitForTimeout(500); });
    await restore();
  }
  if (await queued() !== before) throw new Error("dismiss: a dismissal queued a message for an agent");
}

/**
 * dock-in-view (a-focused-field-and-its-send-stay-in-view): Home's detail pane on a phone while typing, the keyboard
 * down (390x844) and up (390x508: the page resized for it, as `interactive-widget=resizes-content` does). Writing your
 * own answer, a note on a picked option, and a decision card's Something else. The field keeps focus for the shot
 * (page.keepFocus), since the dock yields only while a field has it. `--dock-before` names the shots `before-`.
 */
async function dockInViewShots({ shoot }) {
  const before = argv.includes("--dock-before");
  const name = n => `${before ? "before-" : ""}dv-${n}`;
  const KB_UP = { width: PHONE.width, height: 508 };
  const lone = pick("ny-lone"), card = pick("pn-one");
  const visible = l => l.filter({ visible: true }).first();
  const open = (s, wait) => async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, s.title)).click(); await visible(page.getByText(wait)).waitFor(); };
  const keyboard = async (page, up) => { page.keepFocus = true; if (up) await page.setViewportSize(KB_UP); await page.waitForTimeout(800); };
  const own = async page => {
    await visible(page.getByRole("radio", { name: /^Something else/ })).click();
    await visible(page.getByLabel("Your answer to Q1, required")).fill("Show the key itself, and log it so we add the translation.");
  };
  const note = async page => {
    await visible(page.getByRole("radio", { name: /^A\. The English text/ })).click();
    await visible(page.getByRole("button", { name: "Add a note for the agent about Q1" })).click();
    await visible(page.getByLabel("Note for the agent, sent with A on Q1, optional")).fill("Only in production; staging should show the key.");
  };
  const cardOwn = async page => {
    await visible(page.getByRole("radio", { name: /^Something else/ })).click();
    await visible(page.getByLabel(/^Your answer.*required$/)).fill("Write UTF-8 with the BOM, so Excel opens it right.");
  };
  for (const theme of ["light", "dark"]) for (const [kb, frame] of [["kb-down", PHONE], ["kb-up", KB_UP]]) {
    await shoot(name(`own-${kb}-${theme}`), frame, theme, async page => { await open(lone, "Missing keys")(page); await own(page); await keyboard(page, kb === "kb-up"); });
    await shoot(name(`note-${kb}-${theme}`), frame, theme, async page => { await open(lone, "Missing keys")(page); await note(page); await keyboard(page, kb === "kb-up"); });
    await shoot(name(`card-${kb}-${theme}`), frame, theme, async page => { await open(card, "Which encoding should the export use?")(page); await cardOwn(page); await keyboard(page, kb === "kb-up"); });
  }
}

function pick(key) { const w = [...NEEDS_YOU_STATES, ...PICK_NOTES, ...MERGE_CLICK_STATES].find(x => x.key === key); return { title: w.title, prompt: w.prompt }; }

/**
 * gallery (docs/screenshots/gallery/, `npm run shots:gallery`): one current render of every main surface, desktop light
 * and 390×844 dark, under stable names (`gallery-<surface>-<device>-<theme>`; scripts/gallery-shots.sh drops the
 * prefixes and writes INDEX.md). Synthetic data only. The sidebar view needs Paseo 0.16+; on 0.15 it is skipped.
 *
 * frames (README images, `npm run shots:readme`): 16:9 frames of the app in context, Paseo's sidebar visible, as
 * light/dark pairs (`frame-<surface>-<theme>`: Home, the sidebar view, the Overseer, a task waiting on a deploy), the
 * the README's Catch up on a phone (`catch-up-phone-<theme>`), and the slide set's sources for scripts/cover.mjs
 * (`cover-home`, Home in dark, and the `slide-*` crops, all dark).
 */
const FRAME = { width: 1600, height: 900 };
async function galleryShots({ shoot, call, home, billing }) {
  const G = only.includes("gallery"), F = only.includes("frames");
  const pair = async (name, drive, vp = FRAME) => { if (F) for (const theme of ["light", "dark"]) await shoot(`frame-${name}-${theme}`, vp, theme, page => drive(page, vp)); };
  const both = async (surface, drive, { desktop = DESKTOP, phone = PHONE, phoneDrive = drive, desktopOnly = false, scale } = {}) => {
    if (!G) return;
    await shoot(`gallery-${surface}-desktop-light`, desktop, "light", page => drive(page, desktop), scale ? { scale } : undefined);
    if (!desktopOnly) await shoot(`gallery-${surface}-phone-dark`, phone, "dark", async page => {
      const clip = await phoneDrive(page, phone);
      if (await page.evaluate(() => document.documentElement.scrollWidth) > phone.width) throw new Error(`gallery-${surface}-phone scrolls sideways`);
      return clip;
    });
  };
  // Captures open at desktop size (Paseo's phone layout needs Home first); a drive narrows or resizes to its frame.
  const narrow = async (page, vp) => { if (vp.width !== DESKTOP.width || vp.height !== DESKTOP.height) await page.setViewportSize(vp); };
  /**
   * A slide's crop: from the element whose own text is `top` (exact match first) down to the first element after it whose
   * text holds `bottom`, as wide as `top`'s nearest ancestor at least `minWidth` wide, padded. Scrolls it into view.
   */
  // `lastBottom`: the last match of `bottom` (every row of a group, whatever order equal times sort in).
  // `last`: the last exact match of `top` (Home's "Sending" group header, not the "2 Sending" count above the list).
  const region = (page, top, bottom, { minWidth = 300, padTop = 16, padBottom = 16, padX = 12, last = false, lastBottom = false } = {}) => page.evaluate(([top, bottom, minWidth, padTop, padBottom, padX, last, lastBottom]) => {
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
    const shown = e => e.checkVisibility() && e.getClientRects().length;
    const all = [...document.querySelectorAll("body *")].filter(shown);
    const a = (last ? all.findLast(e => own(e) === top) : all.find(e => own(e) === top)) ?? all.find(e => own(e).includes(top));
    if (!a) throw new Error(`region: no visible "${top}"`);
    const after = all.filter(e => (a.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && own(e).includes(bottom));
    const b = lastBottom ? after.at(-1) : after[0];
    if (!b) throw new Error(`region: no visible "${bottom}" after "${top}"`);
    a.scrollIntoView({ block: "center" });
    let w = a; while (w.parentElement && w.getBoundingClientRect().width < minWidth) w = w.parentElement;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), rw = w.getBoundingClientRect();
    const x = Math.max(0, rw.left - padX), y = Math.max(0, ra.top - padTop);
    return { x, y, width: Math.min(innerWidth - x, rw.width + 2 * padX), height: Math.min(innerHeight - y, rb.bottom + padBottom - y) };
  }, [top, bottom, minWidth, padTop, padBottom, padX, last, lastBottom]);
  // The bordered card around `text` (the nearest ancestor at least minWidth wide with side borders), with even padding:
  // a slide shows a whole card, not a slice of one with its border lines at the edges.
  const cardAround = (page, text, { pad = 16, minWidth = 280 } = {}) => page.evaluate(([text, pad, minWidth]) => {
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
    const el = [...document.querySelectorAll("body *")].find(e => e.checkVisibility() && own(e) === text);
    if (!el) throw new Error(`cardAround: no visible "${text}"`);
    let c = el;
    const sided = e => { const st = getComputedStyle(e); return parseFloat(st.borderLeftWidth) > 0 && parseFloat(st.borderRightWidth) > 0; };
    while (c && !(c.getBoundingClientRect().width >= minWidth && sided(c))) c = c.parentElement;
    if (!c) throw new Error(`cardAround: no bordered card around "${text}"`);
    c.scrollIntoView({ block: "start" });
    const r = c.getBoundingClientRect();
    if (r.height + 2 * pad > innerHeight) throw new Error(`cardAround: "${text}"'s card is taller than the window`);
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
    return { x, y, width: Math.min(innerWidth - x, r.width + 2 * pad), height: r.height + 2 * pad };
  }, [text, pad, minWidth]);
  const openPanel = async page => {
    await openChat(page, "Billing retries", billing.prompt);
    await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
    await page.getByRole("button", { name: /^Pull request 142: / }).first().waitFor();
  };
  // Home: the list with Billing retries' question open beside it; on a phone, the list.
  const homeDrive = async (page, vp) => {
    await openHome(page); await narrow(page, vp);
    const row = await homeRow(page, "Billing retries");
    if (vp.width >= 768) { await row.click(); await page.getByText("Only network failures").first().waitFor(); }
  };
  await both("home", homeDrive);
  await pair("home", homeDrive);
  // The cover's Home: the Follow-up pane alone (Paseo's sidebar cropped off) in a 1280×1100 window, Billing retries'
  // question open beside the list, including Sending and Running below Needs you. At 4×, so the cover can show it larger than
  // 1:1 without stretching it, and its text still reads when the whole cover is scaled to a README column (about 830 px).
  const COVER = { width: 1280, height: 1100 };
  if (F) await shoot("cover-home", COVER, "dark", async page => {
    await homeDrive(page, COVER);
    const pane = await page.getByRole("textbox", { name: /^Search,? or ask the Overseer$/ }).first().evaluate(el => {
      for (let up = el.parentElement; up; up = up.parentElement) {
        const r = up.getBoundingClientRect();
        if (r.height >= innerHeight * 0.95 && r.right >= innerWidth - 2) return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return null;
    });
    if (!pane || pane.x < 100) throw new Error(`cover-home: no Follow-up pane: ${JSON.stringify(pane)}`);
    // Sending, Running and Waiting all show below Needs you; the decision pane stays whole.
    const waiting = await page.evaluate(() => {
      const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
      // The group header ("Waiting on others"), never the strip's "4 Waiting" count above the list.
      const header = [...document.querySelectorAll("body *")].find(e => e.checkVisibility() && /^Waiting on others$/i.test(own(e)));
      return header?.getBoundingClientRect().top ?? null;
    });
    if (waiting === null || waiting - pane.y < 500) throw new Error(`cover-home: no Waiting header below Sending and Running (${waiting})`);
    // The whole pane: the slide cuts it at its bottom edge, so the list runs off the slide through Waiting.
    return pane;
  }, { scale: 4 });
  // Slide sources: one element each, cropped tight at 8× so a slide can zoom it about 4× (filling the slide's sheet, as
  // Home fills the cover) and it still reads in Paseo's 288×180 media tile. Phone width where the element has a narrow form.
  const SLIDE = { scale: 8 };
  // A tall phone window, so the whole element fits above the bottom dock.
  const TALL = { width: PHONE.width, height: 1600 };
  // The decision as Home's pane shows it: the Needs you box, its Q1 card's question and lettered options, A marked
  // Recommended. (The chat folds its copy once Follow-up's turn-end check starts a new turn, and a folded card reads
  // without Recommended.) The card's context lines (the hold note, background, links) are hidden so the options fit.
  const DECISION = { width: 1920, height: 1300 };
  if (F) await shoot("slide-decision", DECISION, "dark", async page => {
    await homeDrive(page, DECISION);
    const question = "Should charges that fail with card_declined retry, or only network failures?";
    await page.getByText(question, { exact: true }).filter({ visible: true }).first().waitFor();
    await page.getByText("Recommended", { exact: true }).filter({ visible: true }).first().waitFor();
    return page.evaluate(question => {
      const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
      const all = [...document.querySelectorAll("body *")].filter(e => e.checkVisibility());
      const q = all.find(e => own(e) === question);
      if (!q) throw new Error("slide-decision: no question");
      let box = q; while (box && !/^Needs you/.test(box.innerText ?? "")) box = box.parentElement;
      if (!box) throw new Error("slide-decision: no Needs you box around the question");
      const keep = e => e.contains(q) || /Only network failures/.test(e.innerText);
      for (const start of [/^The agent holds/, /^card_declined is about/, /^Retry notes/, /^About/, /^More context/]) {
        const el = all.find(e => box.contains(e) && start.test(own(e)));
        if (!el) continue;
        let row = el; while (row.parentElement && !keep(row.parentElement)) row = row.parentElement;
        row.style.display = "none";
      }
      const c = [...box.querySelectorAll("*")].find(e => e.checkVisibility() && own(e).startsWith("Highest recovery"));
      if (!c) throw new Error("slide-decision: no option C");
      const rb = box.getBoundingClientRect();
      let opt = c; while (opt.parentElement && opt.getBoundingClientRect().width < rb.width * 0.9) opt = opt.parentElement;
      const pad = 10, x = Math.max(0, rb.left - pad), y = Math.max(0, rb.top - pad);
      return { x, y, width: Math.min(innerWidth - x, rb.width + 2 * pad), height: opt.getBoundingClientRect().bottom + 5 - y };
    }, question);
  }, { scale: 4.5 });
  // Automatic repairs: Home's Sending group, each workspace's main agent already working on the repairs sent to it.
  if (F) await shoot("slide-repairs", TALL, "dark", async page => {
    await openHome(page); await narrow(page, TALL); await homeRow(page, "Saved views");
    return region(page, "Sending", "Main agent is working on", { minWidth: 360, padBottom: 38, last: true, lastBottom: true });
  }, SLIDE);
  // Automatic follow-ups: Invoice PDFs, whose failed check went back to its agent (the chat shows the repair it got,
  // the panel what was sent) and whose next task waits on the deploy.
  const invoices = WORKSPACES.find(w => w.key === "invoices");
  // `task`: the task row to open; `billingPanel`: the slide's Billing retries panel instead of Invoice PDFs.
  const tasksDrive = async (page, vp, { task, billingPanel = false }) => {
    if (billingPanel) await openPanel(page);
    else {
      await openChat(page, "Invoice PDFs", invoices.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: /^Pull request 188: / }).first().waitFor();
    }
    await narrow(page, vp);
    // The Tasks card can start folded (invariant 89); open it if the task's own row (its "After #N deploys" line) is
    // not showing yet, so the row shows, not just the header's line.
    const rows = () => page.getByText(new RegExp(`^${task}`)).filter({ visible: true });
    const open = () => page.getByText(/^After #\d+ deploys/).filter({ visible: true }).count();
    if (!(await open())) await page.getByText("Agent's tasks", { exact: true }).last().click();
    for (let i = 0; !(await open()); i++) { if (i > 20) throw new Error("deploy: the Tasks card didn't open"); await page.waitForTimeout(250); }
    await rows().last().evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
  };
  const deployDrive = async (page, vp) => {
    await tasksDrive(page, vp, { task: "Send a test receipt from staging after the deploy" });
    // The frame is about the repair: hide Follow-up's card for the first turn's end above it (signed off, no ask), so
    // the chat reads prompt, reply, repair sent, agent on it.
    await page.evaluate(() => {
      const sent = [...document.querySelectorAll('[data-plugin-row="true"]')].find(r => r.textContent.includes("Follow-up sent a message"));
      for (const r of document.querySelectorAll('[data-plugin-row="true"]')) if (r !== sent && /No ask stated/.test(r.textContent) && (r.compareDocumentPosition(sent) & Node.DOCUMENT_POSITION_FOLLOWING)) r.style.display = "none";
    });
    await page.waitForTimeout(300);
  };
  await pair("deploy", deployDrive);
  if (F) await shoot("slide-deploy", DESKTOP, "dark", async page => { await tasksDrive(page, DESKTOP, { task: "Check retries in staging after the deploy", billingPanel: true }); return region(page, "Agent's tasks", "After #143 deploys", { minWidth: 280, padX: 10, padBottom: 34, lastBottom: true }); }, SLIDE);
  // The question as a decision card: Home's detail pane (desktop) and the phone's full-height detail.
  await both("decision-card", async (page, vp) => {
    await openHome(page); await narrow(page, vp);
    await (await homeRow(page, "Billing retries")).click();
    await page.getByText("Only network failures").first().waitFor();
    if (vp.width < 768) await clearDock(page, "Only network failures", "Sign off");
  }, { phoneDrive: async (page, vp) => { await openHome(page); await narrow(page, vp); await (await homeRow(page, "Billing retries")).click(); await page.getByText("Only network failures").first().waitFor(); await clearDock(page, "Only network failures", "Sign off"); } });
  // The workspace panel beside the chat; phones read a workspace in the larger view.
  await both("panel", async page => { await openPanel(page); }, { phoneDrive: async (page, vp) => {
    await openPanel(page);
    await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
    await page.getByRole("button", { name: /^Pull request 142: / }).last().waitFor();
    await page.setViewportSize(vp); await page.waitForTimeout(500);
  } });
  // The composer pill opened: the question and the workspace's other asks.
  await both("pill", async (page, vp) => {
    await openChat(page, "Billing retries", billing.prompt); await narrow(page, vp);
    await page.getByRole("button", { name: /^Follow-up · / }).last().click();
    await page.getByText("fail with card_declined retry").last().waitFor();
  });
  // The PR sheet for #142 (failed checks).
  await both("pr-sheet", async (page, vp) => {
    await openPanel(page);
    await page.getByRole("button", { name: /^Pull request 142: / }).first().click();
    await page.getByText("Pull request #142").first().waitFor();
    await narrow(page, vp); await page.waitForTimeout(400);
    await page.getByText(/check.*failed.*test/i).first().waitFor();
  });
  // Catch up, on the question card.
  const catchUp = async (page, vp) => {
    await openHome(page); await narrow(page, vp);
    await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
    await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().waitFor();
    const card = () => page.locator("[data-catch-up-card]").getByText("fail with card_declined retry").filter({ visible: true }).first();
    for (let i = 0; !(await card().isVisible()); i++) {
      if (i > 30) throw new Error("gallery catch-up: no card shows the billing question");
      await page.getByRole("button", { name: /^Skip this (?!workspace)/ }).filter({ visible: true }).first().click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
  };
  await both("catch-up", catchUp);
  // The README's Catch up phone image is a light/dark <picture> pair; slide 6 takes its own sharper render below.
  if (F) for (const theme of ["light", "dark"]) await shoot(`catch-up-phone-${theme}`, PHONE, theme, page => catchUp(page, PHONE));
  if (F) await shoot("slide-catch-up", PHONE, "dark", page => catchUp(page, PHONE), { scale: 5 });
  // Settings → General.
  await both("settings", async (page, vp) => { await narrow(page, vp); await openSettingsAt(page, "general", vp); await page.waitForTimeout(600); });
  // New, from Home: the Linear list and the first issue's preview.
  await both("new", async (page, vp) => {
    await openHome(page); await narrow(page, vp);
    await page.getByRole("button", { name: /^New( \(.+\))?$/ }).filter({ visible: true }).last().click();
    const dialog = page.locator('[role="dialog"][aria-label="New"]').filter({ visible: true }).first();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /^WEB-31 Invoice/ }).filter({ visible: true }).first().waitFor();
    await page.waitForTimeout(600);
  });
  // The sidebar view (Paseo 0.16+): Follow-up's list as Paseo's sidebar, with a chat beside it.
  const sidebarDrive = async (page, vp) => {
    await page.goto(`${ORIGIN}/settings/sidebar`);
    await page.getByText("Default view", { exact: true }).first().click();
    await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
    await openHome(page);
    const view = page.getByTestId("plugin-sidebar-view");
    await view.getByText("Billing retries").first().waitFor();
    await narrow(page, vp);
    await view.getByText("Billing retries").first().click();
    await page.getByText("Only network failures").first().waitFor();
  };
  if (!/(^|\D)0\.15\.\d+/.test(paseoVersion ?? "")) {
    if (G) await shoot("gallery-sidebar-desktop-light", SIDEBAR, "light", page => sidebarDrive(page, SIDEBAR));
    await pair("sidebar", sidebarDrive);
  }
  // The Overseer, asked from Home's search: the ask, its answer and the pinned row.
  const started = await call("follow.overseer-start", {});
  const answer = "Two workspaces wait on review. Billing retries: #142 failed its tests, so it needs a fix first. Onboarding email: #160 has a merge conflict and two open threads from Dana. Nothing else is blocked.";
  const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8").catch(() => "{}"));
  scripts[`agent:${started.agentId}`] = [{ item: { type: "assistant_message", text: answer } }];
  await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(scripts));
  const question = "What's blocked on review?";
  let asked = false;
  // The harness's Overseer runs on the fixture provider (a test label) and adds its home ("overseer-home") to Paseo's
  // sidebar. Show the model a developer would see and hide that one project, as scripts/demo-video.mjs does.
  const tidyOverseer = page => page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/Followup-fixture/i.test(n.data)) n.data = n.data.replace(/Followup-fixture · Fixture|Followup-fixture/gi, "Claude · Opus");
    for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
      if (!(row.textContent ?? "").includes("overseer-home")) continue;
      const key = row.getAttribute("data-testid").slice("sidebar-project-row-".length);
      let block = row;
      for (let up = row.parentElement; up && up.querySelectorAll('[data-testid^="sidebar-project-row-"]').length === 1; up = up.parentElement) block = up;
      block.style.display = "none";
      for (const list of document.querySelectorAll(`[data-testid="sidebar-workspace-list-${key}"]`)) list.style.display = "none";
    }
  });
  const overseerDrive = async (page, vp) => {
    await openHome(page); await narrow(page, vp);
    if (!asked) {
      const search = page.getByPlaceholder(/^Search/).filter({ visible: true }).first();
      await search.click(); await search.fill(question);
      await page.getByRole("button", { name: `Ask the Overseer: ${question}` }).filter({ visible: true }).first().click();
      asked = true;
    } else await page.getByRole("button", { name: /^Overseer\. / }).filter({ visible: true }).first().click();
    await page.getByText(/^Two workspaces wait on review/).filter({ visible: true }).first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(600);
    await tidyOverseer(page); await page.waitForTimeout(200);
  };
  await both("overseer", overseerDrive);
  await pair("overseer", overseerDrive);
  if (F) await shoot("slide-overseer", PHONE, "dark", async page => { await overseerDrive(page, PHONE); return region(page, question, "Two workspaces wait on review", { minWidth: 340, padTop: 44, padBottom: 28 }); }, SLIDE);
}

async function optimise(path, tool) {
  if (tool === "pngquant") await exec("pngquant", ["--force", "--skip-if-larger", "--quality", "70-95", "--strip", "--output", path, path]).catch(e => { if (e.code !== 98 && e.code !== 99) throw e; });
  if (tool === "oxipng") await exec("oxipng", ["-o", "4", "--strip", "safe", path]);
  return (await fs.stat(path)).size;
}

async function findOptimiser() {
  for (const tool of ["pngquant", "oxipng"]) if (await exec(tool, ["--version"], { timeout: 10000 }).then(() => true, () => false)) return tool;
  log("neither pngquant nor oxipng is on PATH; desktop shots use deviceScaleFactor 1.25 and Playwright's own PNGs");
  return null;
}

// ---------- What's new ----------
/** What's new is shot as an update to the CHANGELOG's newest stable from the stable before it (`whatsNewStables`). */
let WHATS_NEW_FROM = "1.4.0-beta.32";
let WHATS_NEW_TO = "2.0.0";
/** A stand-in `## 2.0.0` section, used when the CHANGELOG has none yet. */
const SAMPLE_2_0 = `## 2.0.0

- Home is one list of every workspace: what needs you first, then what Follow-up is fixing, what's running and what waits on others.
- Questions from agents come with lettered options and a recommendation. Your answer goes straight into the agent's chat.
- Follow-up sends review comments, conflicts and failed checks to the workspace's agent in one batch, and asks you only for decisions.
- The composer pill shows what needs you in the chat you're in.
- Getting started checks GitHub and the helper agents, and shows what Follow-up does on its own.
`;
/**
 * Review evidence for "What's new after every update" (not README images): the sheet after a minor update (2.0.1 to
 * 2.1.0, this repo's own 2.1.0 section) on desktop and phone, and Settings → General's switch on and off, desktop and
 * phone. The off state is set the way an agent would, through set_updates.
 */
async function whatsNewReview({ shoot, seeded, plugin, home, cli, call }) {
  const FROM = "2.0.1", TO = "2.1.0";
  const installed = (await cli("plugin", "ls")).find(row => row.id === "follow-up")?.path ?? plugin;
  const pkgPath = join(installed, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  await fs.writeFile(pkgPath, JSON.stringify({ ...pkg, version: TO }, null, 2));
  await fs.writeFile(join(installed, "CHANGELOG.md"), await fs.readFile("CHANGELOG.md", "utf8"));
  await fs.writeFile(join(home, "plugin-data/follow-up/versions.json"), JSON.stringify({ running: FROM, previous: null, startedAt: null, hostSeen: FROM }));
  await cli("plugin", "reload", "follow-up");
  let seenVersion = null;
  await until(() => `the ${TO} worker (it reports ${seenVersion})`, async () => (seenVersion = (await call("follow.release-notes", {}).catch(() => ({ version: null }))).version) === TO, { tries: 120, every: 500 });
  const sheet = phone => async page => {
    await openHome(page, { keepDialogs: true });
    if (phone) await page.setViewportSize(PHONE);
    await page.getByText("What's new in Follow-up", { exact: true }).last().waitFor();
    await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
  };
  await shoot("whats-new-minor", DESKTOP, "dark", sheet(false), { seen: FROM });
  await shoot("whats-new-minor-phone", PHONE, "light", sheet(true), { seen: FROM });
  const serverId = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
  const LABEL = "Show What's new after updates";
  const general = phone => async page => {
    await page.goto(`${new URL(page.url()).origin}/settings/hosts/${serverId}/plugins/follow-up/projects`);
    if (phone) {
      await page.setViewportSize(PHONE);
      const row = page.getByText("General", { exact: true }).filter({ visible: true });
      await row.or(page.getByText(LABEL)).first().waitFor({ state: "visible" });
      if (!(await page.getByText(LABEL).first().isVisible())) await row.first().click();
    }
    const label = page.getByText(LABEL).first();
    await label.waitFor();
    await label.evaluate(el => el.scrollIntoView({ block: "center" }));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error("horizontal overflow");
    return null;
  };
  await shoot("whats-new-setting-on", DESKTOP, "dark", general(false), { seen: TO });
  await shoot("whats-new-setting-on-phone", PHONE, "light", general(true), { seen: TO });
  await actPlanned(call, seeded.workspaces.find(w => w.key === "audit").agentId, "set_updates", { enable_whats_new: false });
  await shoot("whats-new-setting-off", DESKTOP, "dark", general(false), { seen: TO });
  await shoot("whats-new-setting-off-phone", PHONE, "light", general(true), { seen: TO });
}

/** The stable versions a CHANGELOG has sections for, newest first (betas ship none). */
function whatsNewStables(changelog) {
  const versions = [...changelog.matchAll(/^## v?(\d+)\.(\d+)\.(\d+)(?=[ \t(]|$)/gm)].map(m => [+m[1], +m[2], +m[3]]);
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const out = [...new Set(versions.map(v => v.join(".")))];
  if (out.length < 2) out.push(WHATS_NEW_FROM);
  return out;
}

/** The CHANGELOG for the What's new shot: --whats-new-changelog, else this repo's with a `## 2.0.0` section in front if it has none. */
async function whatsNewChangelog() {
  if (changelogArg) return fs.readFile(changelogArg, "utf8");
  const current = await fs.readFile("CHANGELOG.md", "utf8").catch(() => "# Release notes\n");
  if (/^## 2\.0\.0\b/m.test(current)) return current;
  const at = current.search(/^## /m);
  return at < 0 ? `${current.trimEnd()}\n\n${SAMPLE_2_0}` : `${current.slice(0, at)}${SAMPLE_2_0}\n${current.slice(at)}`;
}

// ---------- main ----------
const root = await fs.mkdtemp(join(tmpdir(), "follow-shots-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const fixture = join(root, "fixture"); const bin = join(root, "bin");
const clockFile = join(root, "clock-offset");
/**
 * An agent tool, planned then confirmed. The worker reads a moved clock up to a beat late under load, so a plan made on
 * the old time can already read as expired on the new one: plan again (a fresh dry run), at most three times.
 */
async function actPlanned(call, agentId, tool, args) {
  for (let attempt = 1; ; attempt++) {
    const plan = await call("follow.agent-act", { agentId, tool, args });
    if (!plan.planId) return plan;
    try { return await call("follow.agent-act", { agentId, tool, args: { ...args, confirm: true, planId: plan.planId } }); }
    catch (error) { if (attempt >= 3 || !/plan expired/i.test(String(error?.message))) throw error; await new Promise(r => setTimeout(r, 500)); }
  }
}
/**
 * Moves the daemon's clock to `fakeMs` and waits until the worker has read it. From then on it crawls (1 ms per real
 * second, `rate`), so everything a phase creates or updates gets the same time to the second, however long it takes.
 */
async function setDaemonClock(fakeMs, rate = 0.001) {
  await fs.writeFile(clockFile, JSON.stringify({ fake: fakeMs, real: Date.now(), rate }));
  await new Promise(r => setTimeout(r, 300));
  // The daemon closes connections whose lease looks expired after the clock moves, so start a fresh one each time.
  if (daemonUrl) await connect();
}

let daemon; let client; let api; let browser; let daemonUrl = null;
/** Starts the isolated daemon again on the same home and port (the feeds check's daemon restart). */
let respawnDaemon = null;
/** The first worker crash in the harness daemon's log, or null (set once the daemon starts). */
let crashed = async () => null;
/** The fake GitHub's HTTPS server: closed in stopDaemon, or its listening socket keeps the run (and its harness slot) alive after "done". */
let github = null;
/** (Re)connects `client` and `api` to the isolated daemon. */
async function connect() {
  await api?.dispose?.()?.catch?.(() => {}); await client?.close().catch(() => {});
  client = new DaemonClient({ url: daemonUrl, clientId: "follow-shots", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true });
  await client.connect();
  api = createPaseoApi(client);
}
const stopDaemon = async () => {
  await browser?.close().catch(() => {}); browser = null;
  await api?.dispose?.().catch?.(() => {}); await client?.close().catch(() => {}); client = null;
  await github?.close().catch(() => {}); github = null;
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    for (let i = 0; i < 40 && daemon.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stopDaemon().finally(() => fs.rm(root, { recursive: true, force: true }).finally(() => process.exit(130))); });

const results = [];
try {
  await Promise.all([home, plugin, fixture, bin, out].map(p => fs.mkdir(p, { recursive: true })));
  const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
  const url = `ws://127.0.0.1:${port}/ws`;
  // A stranger's Paseo has its defaults: the agent MCP on, and Claude and Codex on, found on PATH or not. Each points at
  // this run's own path (the stand-in, or nothing), so the host's real CLI is never found.
  // Claude and Codex stay on (`real`) because their command is this run's own, never the host's.
  const onboardingProviders = variant ? Object.keys(PROVIDER_TOOLS) : [];
  await fs.writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, webUi: true, mcp: !!variant, real: onboardingProviders,
    providers: Object.fromEntries(onboardingProviders.map(id => [id, { command: { mode: "replace", argv: [join(variant.providers.includes(id) ? bin : join(root, "not-installed"), id)] } }])) })));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 120000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  if (argv.includes("--menus-before")) {
    // Only the isolated packed copy changes: preserve main's original UI for before evidence while developing the fix.
    const archive = join(root, "menus-baseline.tar");
    await exec("git", ["archive", "--format=tar", `--output=${archive}`, arg("--menus-baseline-ref", "origin/main"), "client"]);
    await exec("tar", ["-xf", archive, "-C", plugin]);
  }
  if (asVersion) {
    const pkgPath = join(plugin, "package.json");
    await fs.writeFile(pkgPath, JSON.stringify({ ...JSON.parse(await fs.readFile(pkgPath, "utf8")), version: asVersion }, null, 2));
  }
  await fs.writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await fs.writeFile(join(fixture, "index.server.ts"), await fs.readFile("scripts/fixture-provider.ts", "utf8"));
  await fs.writeFile(join(root, "clock.cjs"), CLOCK_PRELOAD);
  await fs.writeFile(join(home, "gh-fixture.json"), JSON.stringify({ ...pulls(), ...(only.includes("pr-scale") ? prScalePulls() : {}), ...(only.includes("pr-stats-settings") ? { _statsSearch: 1840 } : {}) }));
  if (only.includes("pr-stats-settings")) await seedPrStatsSettings(join(home, "plugin-data", "follow-up"));
  if (only.includes("pr-stats")) await seedPrStats(join(home, "plugin-data", "follow-up"));
  if (!variant || variant.gh) { await fs.writeFile(join(bin, "gh"), fakeGh(join(home, "gh-fixture.json"))); await fs.chmod(join(bin, "gh"), 0o700); }
  // Stand-ins Paseo finds on PATH (it only checks the binary resolves): never the host's real CLI, and they never run a model.
  for (const id of (variant?.providers ?? []).filter(p => p === "claude" || p === "codex")) { await fs.writeFile(join(bin, id), `#!/bin/sh\ncase "$1" in --version|-v) echo "${id} 1.0.0 (stand-in)"; exit 0;; esac\nexec cat >/dev/null\n`); await fs.chmod(join(bin, id), 0o700); }
  // PR reads go over HTTPS (server/github-api.ts) to this fake, which answers with the same fixture gh.
  if (variant?.gh) {
    // A stranger's gh is signed in with an active account (gh auth token answers without --user) and knows who it is.
    await fs.rename(join(bin, "gh"), join(bin, "gh-fixture"));
    await fs.writeFile(join(bin, "gh"), `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"alice-example"}'; exit 0; fi\nexec ${JSON.stringify(join(bin, "gh-fixture"))} "$@"\n`); await fs.chmod(join(bin, "gh"), 0o700);
  }
  github = await fakeGithub({ dir: root, gh: join(bin, "gh"), ...(only.includes("pr-now") ? { owners: ["example", "acme"] } : {}), ...(variant?.gh ? { handle: ({ path }) => path === "user" ? { status: 200, body: { login: "alice-example" } } : null } : {}) });
  if (variant?.gh) await fs.writeFile(join(root, "gh-auth"), `#!/bin/sh\n[ "$1" = auth ] && [ "$2" = token ] && echo fixture-token-example && exit 0\nexit 1\n`);
  // No mcpproxy for a stranger: harnessEnv's stub, which exits like a missing tool.
  const noMcpproxy = !!variant;
  await fs.writeFile(join(home, "linear-fixture.json"), JSON.stringify(linearIssues()));
  await fs.writeFile(join(home, "linear-list.json"), JSON.stringify(only.includes("new") || only.includes("compass-suggest") || only.includes("gallery") || only.includes("frames") ? newIssues() : []));
  if (!noMcpproxy) {
    await fs.writeFile(join(bin, "mcpproxy"), fakeMcpproxy(join(home, "linear-fixture.json"), join(home, "linear-list.json"))); await fs.chmod(join(bin, "mcpproxy"), 0o700);
    // A slip in the fake's template (an escape that lands as a real newline) fails every tool call as "couldn't run the
    // read", far from its cause: check the fake parses before any shot uses it.
    await exec(process.execPath, ["--check", join(bin, "mcpproxy")]);
  }
  if (argv.includes("--rename-review")) { await fs.writeFile(join(bin, "claude"), fakeClaude(join(home, "claude-mode"))); await fs.chmod(join(bin, "claude"), 0o700); }
  else if (only.includes("morning-brief")) { await fs.writeFile(join(bin, "claude"), fakeAskClaude()); await fs.chmod(join(bin, "claude"), 0o700); }
  else if (only.includes("compass") || only.includes("compass-suggest") || only.includes("compass-readers")) { await fs.writeFile(join(bin, "claude"), fakeCompassClaude()); await fs.chmod(join(bin, "claude"), 0o700); }
  // Real speed while the daemon starts and the plugin installs; seeding and shooting crawl (setDaemonClock).
  // It starts ten minutes before BASE, so the clock only ever moves forward.
  await fs.writeFile(clockFile, JSON.stringify({ fake: at(-10), real: Date.now(), rate: 1 }));
  // sending only: a fake cgroup at 10% of memory.high from the start (the governor finds its cgroup once), raised later.
  if (only.includes("sending") || only.includes("pr-stats-settings")) { process.env.FOLLOW_SHOTS_CGROUP = join(root, "cgroup.json"); await fs.writeFile(process.env.FOLLOW_SHOTS_CGROUP, JSON.stringify({ high: 1000, current: 100 })); }

  const env = harnessEnv(root, { home, strip: github.strip, set: { ...github.env, ...(process.env.FOLLOW_SHOTS_CGROUP ? { FOLLOW_SHOTS_CGROUP: process.env.FOLLOW_SHOTS_CGROUP } : {}), ...(argv.includes("--overseer-review") || PASTE_LIKE(only) || only.includes("gallery") || only.includes("frames") ? { FOLLOW_UP_OVERSEER_PROVIDER: "followup-fixture/fixture" } : {}), ...(PASTE_LIKE(only) ? { FOLLOW_UP_HARNESS_IMAGE_PROVIDERS: "followup-fixture" } : {}), ...(only.includes("whats-new") ? { FOLLOW_UP_UPDATES_DEMO: "1" } : {}), PASEO_DAEMON_URL: url, PASEO_SERVER_ID: "srv_followupshots", FIXTURE_MODEL_LABEL: "Agent", PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true", PATH: `${bin}:${process.env.PATH}`, ...(variant && !variant.gh ? { FOLLOW_UP_GH_BIN: join(root, "no-such-dir", "gh") } : {}), FOLLOW_SHOTS_CLOCK: clockFile, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${join(root, "clock.cjs")}`.trim(), TZ: "UTC" } });
  // No gh at all: harnessEnv stubs it with an exit-127 script, and a stranger's host has none.
  if (variant && !variant.gh) await fs.rm(join(root, ".harness-stubs", "gh"), { force: true });
  // A plugin install builds the plugin, which takes minutes on a busy machine; everything else answers in seconds.
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: args[1] === "install" ? 600000 : 120000, maxBuffer: 1 << 22 })).stdout);
  const daemonLog = openSync(join(root, "daemon.log"), "a");
  crashed = async () => daemonCrashes(await fs.readFile(join(root, "daemon.log"), "utf8").catch(() => ""))[0] ?? null;
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", daemonLog, daemonLog] });
  respawnDaemon = async () => {
    daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", daemonLog, daemonLog] });
    for (let i = 0; ; i++) {
      try { await cli("workspace", "ls"); break; }
      catch { if (daemon.exitCode !== null || i > 240) throw new Error(`the restarted daemon did not come up; see ${join(root, "daemon.log")}`); await new Promise(r => setTimeout(r, 250)); }
    }
    await connect();
  };
  for (let i = 0; ; i++) {
    try { await cli("workspace", "ls"); break; }
    catch { if (daemon.exitCode !== null) throw new Error(`isolated daemon exited; see ${join(root, "daemon.log")}`); if (i > 120) throw new Error("isolated daemon did not start"); await new Promise(r => setTimeout(r, 250)); }
  }
  if (!variant || variant.providers.includes("fixture")) await cli("plugin", "install", fixture);
  await cli("plugin", "install", plugin);
  daemonUrl = url; await connect();
  // A plugin reload (What's new) can drop the connection too: Follow-up RPCs reconnect once.
  const call = async (method, input) => {
    try { return await client.invokePluginRpc("follow-up", method, input); }
    catch (error) {
      if (!/clos|connect|socket|lease|transport/i.test(String(error?.message))) throw error;
      await connect();
      return client.invokePluginRpc("follow-up", method, input);
    }
  };
  ORIGIN = `http://127.0.0.1:${port}`; SERVER_ID = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
  log(`isolated daemon on 127.0.0.1:${port} (${paseoVersion}), root ${root}`);

  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  // Headless Chromium hides scrollbars by default; the notes review shows them, as the notes' bar is part of the review.
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true, ...(argv.includes("--notes-review") ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}) });
  // A font without a bold face drew every semibold regular on the phone (invariant 120): refuse to render on one.
  const fontProblem = await fontWeightProblem(browser);
  if (fontProblem) throw new Error(fontProblem);
  const shoot = makeShooter({ browser, port, out, scheme, optimiser, results, crashed });

  // setup: setup's popup on this fresh install (its welcome page), before anything is seeded.
  if (only.includes("setup")) await shoot("setup", { width: 1440, height: 900 }, "dark", async page => {
    await openHome(page, { keepDialogs: true });
    // Under reduced motion (the context's) StepFade shows the page at once, so there is no fade to wait out.
    await page.getByText("Welcome to Follow-up").first().waitFor();
  });
  // setup-popup: setup's popup on this fresh install: the welcome page, two steps, the tour (the sidebar's new-row choice) and the done page,
  // desktop and 390x844, light and dark.
  if (only.includes("setup-popup")) {
    const frames = [["welcome", null], ["checks", "checks"], ["defaults", "defaults"], ["tour", "tour"], ["done", "tour"], ["closed", "defaults"]];
    for (const [frame, step] of frames) for (const [device, vp] of [["desktop", DESKTOP], ["phone", PHONE]]) for (const theme of ["light", "dark"]) {
      await shoot(`setup-popup-${frame}-${device}-${theme}`, vp, theme, async page => {
        await call("follow.set-onboarding", { action: "restart" });
        if (step) await call("follow.set-onboarding", { action: "step", step });
        await openHome(page, { keepDialogs: true });
        if (vp.width < 768) await page.setViewportSize(vp);
        if (frame === "welcome") await page.getByText("Welcome to Follow-up").first().waitFor();
        else await page.getByRole("progressbar").first().waitFor();
        if (step === "checks") await page.getByText("Checking…").first().waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        // The tour ends on the sidebar's Dispatch switch (NewRowChoice): scroll it into view.
        if (frame === "tour") await page.getByText(/^To hide Paseo/).filter({ visible: true }).last().scrollIntoViewIfNeeded();
        // Close: the popup goes away and Home keeps its one Finish setup line.
        if (frame === "closed") { await page.getByRole("button", { name: "Close" }).filter({ visible: true }).first().click(); await page.getByRole("button", { name: "Finish setup" }).filter({ visible: true }).first().waitFor(); }
        if (frame === "done") { await page.getByRole("button", { name: "Finish" }).filter({ visible: true }).click(); await page.getByText("You're set up").first().waitFor(); }
        await page.waitForTimeout(700);
      });
    }
    await call("follow.set-onboarding", { action: "restart" });
  }
  // The gallery's setup: the same welcome page, desktop light and phone dark.
  if (only.includes("gallery")) for (const [surface, vp, theme] of [["desktop-light", DESKTOP, "light"], ["phone-dark", PHONE, "dark"]]) await shoot(`gallery-setup-${surface}`, vp, theme, async page => {
    await openHome(page, { keepDialogs: true });
    if (vp.width < 768) await page.setViewportSize(vp);
    await page.getByText("Welcome to Follow-up").first().waitFor();
  });
  if (variant) await shootOnboarding({ shoot, call });
  else {
    await call("follow.set-onboarding", { action: "finish" });
    const seeded = await seed({ call, home });
    log(`seeded ${seeded.workspaces.length} synthetic workspaces`);
    if (keep) { console.log(JSON.stringify({ root, home, port, ...seeded })); log("--keep: daemon left running; Ctrl-C to stop it"); await new Promise(() => {}); }
    await setDaemonClock(BASE + VIEW);
    await shootAll({ shoot, seeded, call, plugin, home, cli });
  }
  if (failures.length) throw new Error(`${failures.length} shot(s) failed: ${failures.join(", ")}`);
  log(`done: ${results.length} image(s) in ${out}`);
} catch (error) {
  console.error(error?.stack ?? error);
  // Seeding against a crashed worker fails as a lost connection; name the crash.
  const crash = /the harness daemon crashed/.test(String(error?.message)) ? null : await crashed().catch(() => null);
  if (crash) console.error(`[shots] the harness daemon crashed: ${crash} (${join(root, "daemon.log")})`);
  process.exitCode = 1;
} finally {
  await stopDaemon();
  if (process.exitCode) log(`kept ${root} for the daemon log`); else await fs.rm(root, { recursive: true, force: true });
}
// Something (a held fixture turn's socket, the fake GitHub server) can keep the loop alive after the daemon is gone.
process.exit(process.exitCode ?? 0);

/** Menus at both sidebar edges, with host footer chrome present; --menus-before captures the regression. */
async function menuBoundsShots({ shoot }) {
  const results = [];
  for (const theme of ["light", "dark"]) for (const edge of ["bottom", "top"]) {
    await shoot(`menus-${argv.includes("--menus-before") ? "before" : "after"}-${edge}-${theme}`, { width: 1280, height: 720 }, theme, async page => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`${ORIGIN}/settings/sidebar`);
      await page.getByText("Default view", { exact: true }).first().click();
      await page.getByText("Follow-up: Needs you", { exact: true }).last().click();
      await openHome(page);
      const view = page.getByTestId("plugin-sidebar-view");
      const row = view.getByRole("button", { name: /^Billing retries/ }).first();
      await row.waitFor();
      await view.getByPlaceholder("Filter workspaces").fill("billing");
      await row.waitFor();
      // A synthetic footer sibling reserves the same space as a plugin footer, without installing another plugin.
      await view.evaluate(el => {
        const footer = document.createElement("div"); footer.dataset.menuTestFooter = "1";
        footer.textContent = "CPU 24%     RAM 48%     Disk 32%";
        footer.style.cssText = "height:64px;flex-shrink:0;position:relative;z-index:1;display:flex;align-items:center;justify-content:center;background:var(--unused, #777);color:white;font:12px system-ui";
        el.parentElement.appendChild(footer);
      });
      if (edge === "bottom") {
        await row.click({ button: "right", position: { x: 40, y: 12 } });
        const first = page.getByRole("menu", { name: "Actions for Billing retries" });
        await first.waitFor();
        const height = (await first.boundingBox()).height;
        await page.keyboard.press("Escape");
        await first.waitFor({ state: "hidden" });
        await page.clock.setFixedTime(BASE + VIEW + 1000); // A fresh gesture under this harness's frozen clock.
        await row.evaluate((el, height) => {
          const view = el.closest('[data-testid="plugin-sidebar-view"]').getBoundingClientRect();
          const r = el.getBoundingClientRect();
          // A real row click that fits in the window but whose old menu ran over the footer.
          const target = Math.min(view.bottom - 64, innerHeight - height - 24);
          el.style.marginTop = `${Math.max(0, target - r.y)}px`;
        }, height);
      }
      await row.scrollIntoViewIfNeeded();
      await row.click({ button: "right", position: { x: 40, y: 12 } });
      const menu = page.getByRole("menu", { name: "Actions for Billing retries" });
      await menu.waitFor();
      await page.waitForTimeout(200);
      const result = await menu.evaluate(el => {
        const r = el.getBoundingClientRect();
        const items = [...el.querySelectorAll('[role="menuitem"]')];
        return { rect: { x:r.x, y:r.y, right:r.right, bottom:r.bottom }, items: items.map(item => {
          const r = item.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
          return { label:item.textContent, reachable: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && item.contains(document.elementFromPoint(x,y)) };
        }) };
      });
      results.push({ theme, edge, ...result });
      page.keepFocus = true;
    });
  }
  if (!argv.includes("--menus-before")) {
    const bounded = async (page, popup, name) => {
      await popup.waitFor();
      await page.waitForFunction(el => {
        const r = el.getBoundingClientRect();
        return getComputedStyle(el).opacity === "1" && r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      }, await popup.elementHandle(), { timeout: 5000 });
      const r = await popup.boundingBox(); const vp = page.viewportSize();
      if (r.x < 0 || r.y < 0 || r.x + r.width > vp.width + 1 || r.y + r.height > vp.height + 1) throw new Error(`${name} overflows: ${JSON.stringify(r)}`);
      results.push({ name, rect: r });
    };
    await shoot("menus-resize-dark", { width: 1280, height: 720 }, "dark", async page => {
      await openHome(page);
      const row = await homeRow(page, "Billing retries");
      await row.click({ button: "right", position: { x: 40, y: 12 } });
      const menu = page.getByRole("menu", { name: "Actions for Billing retries" });
      await bounded(page, menu, "Home row");
      await menu.getByRole("menuitem", { name: "Later", exact: true }).click();
      await bounded(page, menu, "expanded Later");
      await page.setViewportSize({ width: 900, height: 300 });
      await page.waitForTimeout(200);
      await bounded(page, menu, "resized expanded menu");
      const archive = menu.getByRole("menuitem", { name: "Archive workspace…" });
      await archive.scrollIntoViewIfNeeded();
      await archive.click();
      const confirm = page.getByRole("alertdialog", { name: "Archive workspace" });
      await bounded(page, confirm, "archive confirm");
      await page.keyboard.press("Escape");
      await menu.waitFor(); // Escape backs out of confirmation, rather than dismissing the entire menu.
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await page.clock.setFixedTime(BASE + VIEW + 1000);
      await row.click({ button: "right", position: { x: 40, y: 12 } });
      await bounded(page, menu, "resized menu capture");
    });
    await shoot("menus-sort-light", { width: 1280, height: 720 }, "light", async page => {
      await openHome(page);
      await page.getByRole("button", { name: /^Sort:/ }).first().click();
      const sort = page.getByRole("menu", { name: "Sort workspaces" });
      await bounded(page, sort, "Home sort");
      await page.keyboard.press("Escape");
      await sort.waitFor({ state: "hidden" });
      const spec = WORKSPACES.find(w => w.key === "billing");
      await openChat(page, "Billing retries", spec.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("button", { name: "More actions for this workspace" }).first().click();
      await bounded(page, page.getByRole("menu", { name: "Actions for Billing retries" }), "panel More");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open the larger view", exact: true }).last().click();
      await page.getByRole("button", { name: "More actions for this workspace" }).filter({ visible: true }).first().click();
      await bounded(page, page.getByRole("menu", { name: "Actions for Billing retries" }), "main tab More");
      await page.keyboard.press("Escape");
      await openHome(page);
      await page.getByRole("button", { name: /^Sort:/ }).first().click();
      await bounded(page, page.getByRole("menu", { name: "Sort workspaces" }), "Home sort capture");
    });
    await shoot("menus-catch-up-dark", DESKTOP, "dark", async page => {
      await openHome(page);
      await page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }).filter({ visible: true }).first().click();
      await page.getByRole("heading", { name: /^Catch up/ }).filter({ visible: true }).first().waitFor();
      await page.getByRole("button", { name: "More context", exact: true }).filter({ visible: true }).first().click();
      await bounded(page, page.getByRole("dialog", { name: "More context", exact: true }), "Catch up More context");
      await page.keyboard.press("2");
      await page.waitForFunction(el => el.value === "Why does this matter, and what happens if it waits?",
        await page.getByLabel("What do you want to know?").elementHandle(), { timeout: 5000 });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Later (L)", exact: true }).click();
      await bounded(page, page.getByRole("dialog", { name: "Later", exact: true }), "Catch up Later");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Show the keys (S)", exact: true }).click();
      await bounded(page, page.getByRole("dialog", { name: "Catch up keys", exact: true }), "Catch up keys");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "More context", exact: true }).filter({ visible: true }).first().click();
      await bounded(page, page.getByRole("dialog", { name: "More context", exact: true }), "Catch up More context capture");
    });
    await shoot("menus-review-light", DESKTOP, "light", async page => {
      await openSettingsAt(page, "following", DESKTOP);
      const header = page.getByRole("button", { name: /^example\/app, / }).filter({ visible: true }).first();
      await header.waitFor();
      if (await header.getAttribute("aria-expanded") !== "true") await header.click();
      await page.getByRole("button", { name: /^Review for example\/app/ }).filter({ visible: true }).first().click();
      await bounded(page, page.getByRole("menu", { name: "Review for example/app" }), "settings review");
    });
  }
  await fs.writeFile(join(out, "menu-bounds.json"), JSON.stringify(results, null, 2));
  if (!argv.includes("--menus-before") && results.some(r => r.items?.some(i => !i.reachable))) throw new Error("a menu item is hidden by host chrome or outside the viewport; see menu-bounds.json");
}
