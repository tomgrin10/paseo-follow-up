// Re-shoots every README image from the current UI: `npm run shots` (through ~/paseo-harness/tools/harness-slot).
// Usage: node scripts/screenshots.mjs [--out <dir>] [--only home,panel,...] [--scheme dark|light] [--scale <n>]
//                                     [--whats-new-changelog <CHANGELOG.md>] [--whats-new-all] [--notes-review] [--keep]
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
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon } from "./harness.mjs";
import { daemonCrashes, harnessEnv, harnessConfig } from "./harness-env.mjs";
import { fakeGithub } from "./fake-github.mjs";
import { openHome as openHomeAt, homeRow } from "./ui-home.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
// What's new reinstalls the plugin as 2.0.0-rc.0, so it goes last: every other shot shows the version under test.
const SHOTS = ["setup", "home", "sidebar", "panel", "questions", "pill", "pr-sheet", "phone", "linked-items", "notes-home", "notes-panel", "whats-new"];
/** Opt-in review sets, never part of the README run: they seed extra workspaces of their own. */
const REVIEW_SHOTS = ["needs-you-states", "done-brief", "feeds"];
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
function fail(message) { console.error(`screenshots: ${message}`); process.exit(1); }

// ---------- preflight ----------
if (!process.env.PLAYWRIGHT_CORE || !existsSync(join(process.env.PLAYWRIGHT_CORE, "package.json"))) fail("set PLAYWRIGHT_CORE to a playwright-core directory (e.g. ~/paseo-switcher/node_modules/playwright-core)");
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) fail("set CHROMIUM to a Chromium or chrome-headless-shell binary");
const paseoVersion = await exec("paseo", ["--version"], { timeout: 30000 }).then(r => r.stdout.trim(), () => null);
// The sidebar shot and --sidebar-review need sidebar views, which arrive in Paseo 0.16 (HARNESS_PASEO=0.16); every
// other shot stays on 0.15.x.
const paseo016 = /(^|\D)0\.16\.\d+/.test(paseoVersion ?? "");
if (only.includes("sidebar") && only.some(n => n !== "sidebar")) fail("shoot --only sidebar on its own, with HARNESS_PASEO=0.16");
if (only.includes("sidebar") && !paseo016) fail(`the sidebar shot needs the Paseo CLI 0.16.x (found ${paseoVersion ?? "none"}); run with HARNESS_PASEO=0.16`);
if (only.includes("feeds") && only.length > 1) fail("run --only feeds on its own (npm run test:feeds)");
const paseoOk = only.includes("sidebar") || only.includes("feeds") || argv.includes("--sidebar-review") ? /(^|\D)0\.1[56]\.\d+/ : /(^|\D)0\.15\.\d+/;
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
fsp.readFile = function (path, ...rest) { return hidden(path) ? Promise.reject(Object.assign(new Error("ENOENT: hidden by scripts/screenshots.mjs"), { code: "ENOENT" })) : readFile.call(this, path, ...rest); };
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
    151: { repo: "example/web", title: "Saved search filters", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    160: { title: "Welcome email template", state: "OPEN", author: "dana", conflict: true, threads: 2, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    170: { title: "Sign webhook payloads", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    181: { repo: "example/web", title: "Dark mode color tokens", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    // The README hero's other groups (2.0.x): Waiting, Fixing, Later.
    188: { title: "Render invoices as PDF", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [failed("test"), ok("lint"), ok("e2e")] },
    191: { title: "Team invite links", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [running("test"), ok("lint")] },
    195: { title: "Add the SAML provider", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    196: { title: "SSO login button", state: "OPEN", author: "dana", base: "branch-195", checks: [ok("test"), ok("lint")] },
    205: { repo: "example/web", title: "Saved dashboard views", state: "OPEN", author: "dana", conflict: true, changes: ["ravi"], threads: 1, checks: [ok("test"), ok("lint")] },
    212: { repo: "example/web", title: "Usage dashboard charts", state: "OPEN", author: "dana", draft: true, checks: [ok("test"), ok("lint")] },
    218: { repo: "example/web", title: "Push notification settings", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    224: { repo: "example/web", title: "Import contacts from CSV", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    240: { title: "Stream large invoice exports", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    232: { title: "Usage alert thresholds", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
  };
}
/** A fake `gh`: GraphQL PR reads from the fixture file, `[]` for everything else (branch rules, auth). fakeGithub serves it over HTTP. */
function fakeGh(file) {
  return `#!/usr/bin/env node
const d = JSON.parse(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));
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
    mergedAt: p.state === "MERGED" ? "2026-03-04T08:00:00Z" : null, mergeCommit: p.state === "MERGED" ? { oid: "9a1b2c" + n } : null, isInMergeQueue: false, autoMergeRequest: null,
    author: { login: p.author },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: (p.reviewers ?? []).map(l => ({ requestedReviewer: user(l) })) },
    latestReviews: { pageInfo: { hasNextPage: false }, nodes: [...(p.reviewed ?? []).map(l => ({ state: "APPROVED", author: user(l) })), ...(p.changes ?? []).map(l => ({ state: "CHANGES_REQUESTED", author: user(l) }))] },
    baseRef: { branchProtectionRule: base === "main" ? { requiredStatusCheckContexts: ["test", "lint"] } : null, associatedPullRequests: { nodes: base === "main" ? [] : [{ number: Number(base.slice(7)), headRefName: base, state: d[Number(base.slice(7))]?.state ?? "OPEN", headRepository: { nameWithOwner: p.repo ?? "example/app" } }] } },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: p.threads ?? 0 }, (_, i) => ({ id: "thread-" + n + "-" + i, isResolved: false, comments: { nodes: [{ updatedAt: "2026-03-04T08:30:00Z" }] } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: p.checks ?? [] } } } }] } };
}
console.log(JSON.stringify({ data: { repository } }));
`;
}

/**
 * A fake `claude` for Rename with AI's review shots (--rename-review): it answers only the rename prompt, as
 * `claude -p --output-format json` does, and the mode file picks the state: ready, slow (still suggesting) or fail.
 */
function fakeClaude(modeFile) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
// Anything but the rename job (its own system prompt) fails at once, as an unlogged-in CLI does, without reading stdin.
if (!process.argv.some(a => a.startsWith("You name software workspaces"))) { process.stderr.write("not logged in"); process.exit(1); }
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  const mode = (() => { try { return fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim(); } catch { return "ready"; } })();
  if (mode === "fail") { process.stdout.write(JSON.stringify({ is_error: true, subtype: "error_during_execution" })); process.exit(0); }
  const reply = () => process.stdout.write(JSON.stringify({ result: JSON.stringify({ name: "Add APP-142 backoff for soft card declines" }), total_cost_usd: 0.0004, usage: { input_tokens: 420, output_tokens: 14 } }));
  if (mode === "slow") setTimeout(reply, 20000); else reply();
});
`;
}

/**
 * What the fake `mcpproxy` knows of Linear. Linked items only show a Linear key once Linear confirms it, and the worker
 * asks through `mcpproxy call tool-read --tool-name=linear:get_issue`; these answer it. Any other key is "not found",
 * so keys extracted from the other workspaces' goals are rejected and never render (whenever the linked loop runs).
 */
function linearIssues() {
  return {
    "APP-142": { title: "Retry failed charges with exponential backoff", status: "In Progress" },
    "APP-139": { title: "Customers charged twice after a gateway timeout", status: "Done" },
    "APP-151": { title: "Dunning email copy for failed renewals", status: "Todo" },
  };
}
/** A fake `mcpproxy`: Linear's get_issue and list_teams from the fixture file, a tool error for everything else. */
function fakeMcpproxy(file) {
  return `#!/usr/bin/env node
const issues = JSON.parse(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));
const flag = name => (process.argv.find(a => a.startsWith("--" + name + "=")) || "").slice(name.length + 3);
const tool = flag("tool-name"); let args = {}; try { args = JSON.parse(flag("json_args") || "{}"); } catch {}
const reply = (text, isError = false) => { console.log(JSON.stringify({ content: [{ type: "text", text }], isError })); process.exit(0); };
if (tool === "linear:list_teams") reply(JSON.stringify({ teams: [{ key: "APP", name: "App" }, { key: "WEB", name: "Web" }] }));
if (tool === "linear:get_issue") {
  const i = issues[args.id];
  reply(i ? JSON.stringify({ identifier: args.id, title: i.title, status: i.status, url: "https://linear.app/example/issue/" + args.id }) : "Issue not found");
}
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
      // Linked items: a spec and what the agent linked, each with why (Linear keys are confirmed by the fake mcpproxy).
      rpc("follow.set-spec", { url: "https://example.com/docs/billing/retry-spec", title: "Charge retry spec" }),
      rpc("follow.link-item", { ref: "APP-142", why: "The issue this workspace delivers" }),
      rpc("follow.link-item", { ref: "APP-139", why: "Retries must not double-charge; this was the last time they did" }),
      rpc("follow.link-item", { ref: "https://example.slack.com/archives/C0BILLING1/p1772614800000100", title: "#billing: which declines are soft?", why: "Where support asked for declined-card retries" }),
      rpc("follow.link-item", { ref: "https://example.com/docs/billing/retries", title: "Retry notes", why: "The backoff schedule and its limits" }),
      bash("pnpm test billing", "pass 87"),
      rpc("follow.ask-question", { title: "Retry declined cards?", question: "Should charges that fail with card_declined retry, or only network failures?",
        options: [{ letter: "A", label: "Only network failures", consequence: "Today's behavior. Declined cards go straight to the dunning email." },
          { letter: "B", label: "Retry card_declined once after 24 hours", consequence: "Recovers some soft declines for one extra charge attempt per invoice." },
          { letter: "C", label: "Retry every failure with the same backoff", consequence: "Highest recovery, but card networks can flag repeated declines." }],
        recommend: "A", background: "card_declined is about 30% of failed charges. Soft declines often clear within a day; hard declines don't.",
        links: [{ path: "docs/billing/retries.md", label: "Retry notes" }], pr: "example/app#142" }),
      msg("The backoff is in example/app#142 and the dunning email in #143. Q1 asks whether declined cards should retry."),
      rpc("follow.needs-you", { kind: "decision", ask: "Pick whether declined cards retry", questions: ["Q1"] }),
      { gate: "billing" },
    ], worked: 4 },
  // The README hero's other groups: Waiting (signed off, PRs out), Later (snoozed), Fixing (a repair batch sent and
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
      rpc("follow.ask-question", { title: "Duplicate contacts?", question: "When a CSV row matches an existing contact by email, should it update that contact or be skipped?",
        options: [{ letter: "A", label: "Update the existing contact", consequence: "The CSV wins; old values are overwritten." }, { letter: "B", label: "Skip the row", consequence: "Existing contacts never change; the preview lists what was skipped." }],
        recommend: "B", pr: "example/web#224" }),
      msg("The preview works in example/web#224. Q1 asks what to do with duplicates.")] },
  { key: "invoices", project: "app", after: "fix", title: "Invoice PDFs", minute: 105, prompt: "APP-182: render invoices as PDF and attach them to the receipt email.",
    steps: [rpc("follow.enroll", { goal: "APP-182 Invoice PDFs on the receipt email" }), rpc("follow.register-pr", { repo: "example/app", number: 188, stack: "Invoice PDFs" }),
      msg("Opened example/app#188.")] },
  { key: "views", project: "web", after: "fix", title: "Saved views", minute: 112, prompt: "WEB-41: save dashboard layouts as named views.",
    steps: [rpc("follow.enroll", { goal: "WEB-41 Saved dashboard views" }), rpc("follow.register-pr", { repo: "example/web", number: 205, stack: "Saved views" }),
      msg("Opened example/web#205.")] },
].sort((a, b) => a.minute - b.minute);

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
      msg("Thresholds are in #232. One task needs your call on who gets the alerts.")], flag: false },
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
  for (const name of ["app", "web"]) { repos[name] = join(tmpdir(), "follow-up-shots-fixture", name); await fs.mkdir(repos[name], { recursive: true }); }
  const specs = [...WORKSPACES, ...(only.includes("needs-you-states") ? NEEDS_YOU_STATES : []), ...(only.includes("done-brief") ? DONE_BRIEF : [])];
  await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(Object.fromEntries(specs.map(w => [w.prompt, w.steps]))));
  const workspaces = [];
  for (const spec of specs) {
    await setDaemonClock(at(spec.minute));
    const w = await api.workspaces.create({ title: spec.title, source: { kind: "directory", path: repos[spec.project ?? "app"] } });
    const agent = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: spec.title });
    await call("follow.activate", { workspaceId: w.id });
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
  const caller = workspaces.find(w => w.key === "audit").agentId;
  const plan = await call("follow.agent-act", { agentId: caller, tool: "set_display", args: { values: { enable_ranker: false } } });
  if (plan.planId) await call("follow.agent-act", { agentId: caller, tool: "set_display", args: { values: { enable_ranker: false }, confirm: true, planId: plan.planId } });
  // PR snapshots from the fake gh, then Done for the shipped workspace.
  let missing = [];
  await until(() => `PR snapshots (missing ${missing.join(", ")})`, async () => {
    await call("follow.refresh", {});
    missing = (await call("follow.list", {})).workspaces.flatMap(w => w.prs).filter(p => !p.snapshot).map(p => p.error ? `${p.key}: ${p.error}` : p.key);
    return !missing.length;
  }, { tries: 120, every: 500 });
  for (const spec of WORKSPACES.filter(s => s.done)) {
    const w = workspaces.find(x => x.key === spec.key);
    const done = await call("follow.done", { agentId: w.agentId, summary: spec.done });
    if (done.blockers.length) throw new Error(`${spec.key} could not be Done: ${done.blockers.join("; ")}`);
  }
  // The developer's moves: sign a turn off (its PRs then wait on others), put a question off until tomorrow, or send a
  // repair batch the agent is now working on (Fixing). The agent holds that turn open, so it stays Fixing.
  const scripts = JSON.parse(await fs.readFile(join(home, "fixture-scripts.json"), "utf8"));
  for (const spec of WORKSPACES.filter(s => s.after)) {
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
  // One item the developer added by hand ("Added by you" in the Linked list).
  const billing = workspaces.find(w => w.key === "billing");
  await call("follow.set-linked-items", { workspaceId: billing.workspaceId, action: "add", ref: "APP-151" });
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
/** Follow-up Home by URL, asserted (scripts/ui-home.mjs); `keepDialogs` leaves Getting started or What's new open. */
const openHome = (page, { keepDialogs = false } = {}) => openHomeAt(page, { origin: ORIGIN, serverId: SERVER_ID, keepDialogs });

const failures = [];
function makeShooter({ browser, port, out, scheme: forced, optimiser, results, crashed }) {
  /** Opens the web app in a fresh context, runs `drive`, and returns the PNG (optionally clipped to what drive returns). */
  async function capture(name, viewport, theme, drive, { seen = null, scale = null } = {}) {
    const colorScheme = forced ?? theme;
    // Always open at desktop width: on a phone Paseo's sidebar is a drawer, so phone frames open Home first, then narrow.
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme, deviceScaleFactor: scale ?? (viewport.width < 768 ? 2 : desktopScale), reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
    try {
      await context.addInitScript(INIT, { seen });
      const page = await context.newPage();
      await page.clock.setFixedTime(BASE + VIEW);
      page.setDefaultTimeout(30000);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByText("Follow-up", { exact: true }).first().waitFor();
      const clip = await drive(page);
      await page.mouse.move(1, viewport.height - 1);
      // A focused field draws a focus ring only some of the time (it depends on how the last key event landed).
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await settle(page);
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
  const shoot = guard(async (name, viewport, theme, drive, options) => { const { png, colorScheme } = await capture(name, viewport, theme, drive, options); await save(name, png, colorScheme); });
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
 * its usage file), and each surface must show it within 5 s with no poll RPC in between. Then the worker is reloaded,
 * killed, and the daemon restarted under the open pages: after each, a change must still show within 5 s, with no page
 * reload. On Paseo 0.15 (no subscriptions) the same cases run and record how long the polls take; they pass within the
 * poll interval. Writes feeds.json to --out.
 */
const POLL_RPCS = /"(follow\.(list|inbox-list|overseer-status|priorities|rank-status|usage)|settings\.display\.read)"/;
async function checkFeeds({ seeded, call, cli, home }) {
  const live = paseo016;
  const BUDGET = live ? 5_000 : 75_000;
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
  const agentAct = async (tool, args) => {
    const plan = await call("follow.agent-act", { agentId: caller, tool, args });
    if (plan.planId) return call("follow.agent-act", { agentId: caller, tool, args: { ...args, confirm: true, planId: plan.planId } });
    return plan;
  };
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
  const fresh = async (name, change, surfaces, { note = "" } = {}) => {
    const t0 = Date.now();
    await change();
    const changed = Date.now();
    await Promise.all(surfaces.map(async ([surface, page, shown]) => {
      let ms = null;
      try { await shown(page, WAIT); ms = Date.now() - changed; } catch { /* not shown within WAIT */ }
      const between = polls.filter(p => p.at >= t0 && p.at <= (ms === null ? Date.now() : changed + ms));
      const kept = await page.evaluate(() => window.__followFeedsMark === "kept").catch(() => false);
      const ok = ms !== null && ms <= BUDGET && kept && (!live || between.length === 0);
      const row = { case: name, surface, ms, polls: between.length, pollNames: [...new Set(between.map(p => p.name))], pageReloaded: !kept, ok, note };
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
    ]);

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
    daemon.kill("SIGTERM");
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await quiet(100);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    const restartAt = Date.now();
    await respawnDaemon(); await workerUp();
    await homePage.getByRole("toolbar", { name: "Status", exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
    await quiet(3_000);
    await fresh("After a daemon restart (websocket reconnect)", () => agentAct("set_priorities", { priorities: [{ workspace: ws("billing").workspaceId, score: 93, reason: "Feeds check: after the daemon restart" }], replace: false }), [
      ["Home: the priority line", homePage, text("Feeds check: after the daemon restart")],
    ], { note: `daemon back after ${Math.round((Date.now() - restartAt) / 1000)} s` });
    await fresh("After a daemon restart: usage", () => writeUsage(71), [
      ["Home: usage meter", homePage, label(/5h 71%/)],
    ]);
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
/** The sidebar shot's window: every group of the fixture fits, down to Quiet, and the chat beside it lays out whole. */
const SIDEBAR = { width: 960, height: 1060 };
/** A workspace's agent chat, opened from Paseo's sidebar like a person would (deep links land before the host is known). */
async function openChat(page, title, prompt) {
  await page.getByText(title, { exact: true }).first().click({ timeout: 30000 });
  await page.getByText(prompt).first().waitFor();
}

async function shootAll({ shoot, seeded, plugin, home, cli, call }) {
  if (only.includes("feeds")) return checkFeeds({ seeded, call, cli, home });
  const billing = WORKSPACES.find(w => w.key === "billing");
  // Review evidence for Rename with AI (not README images): the row menu item, the panel's More button and menu, the
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
      await menu.getByRole("menuitem", { name: "Rename with AI…" }).waitFor();
      return menu;
    };
    const dialog = (vp, wait) => async page => {
      await (await rowMenuAt(page)).getByRole("menuitem", { name: "Rename with AI…" }).click();
      if (vp !== DESKTOP) await page.setViewportSize(vp);
      await wait(page);
    };
    const ready = page => page.getByRole("textbox", { name: "New name" }).last().evaluate(el => el.value.length > 0 || Promise.reject(new Error("empty"))).catch(async () => { await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="New name"]')].some(el => el.value)); });
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
      await page.getByRole("menuitem", { name: "Rename with AI…" }).waitFor();
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
      await page.getByRole("menuitem", { name: "Rename with AI…" }).click();
      await page.getByRole("button", { name: "Undo last rename" }).last().waitFor();
      await page.getByText("Suggesting a name…").last().waitFor({ state: "detached" });
    });
    await call("follow.rename-workspace", { workspaceId: billingId, undo: true }).catch(error => log(`undo after review: ${error.message}`));
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
    const menuOpen = page => page.getByRole("menu", { name: "Actions for Billing retries" }).getByRole("menuitem", { name: "Rename with AI…" }).waitFor();
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
  for (const name of SHOTS) {
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
    });
    if (name === "questions") await shoot("questions", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
      await page.getByRole("tab", { name: /^Questions/ }).first().click();
      await page.getByRole("button", { name: /^Q1, Retry declined cards\?/ }).first().click();
      await page.getByText("Retry card_declined once after 24 hours").last().click();
      await page.getByPlaceholder(/note for the agent/i).last().fill("Only for soft declines. Hard declines still go straight to dunning.");
      await page.getByText("Should charges that fail with card_declined retry").last().waitFor();
    });
    if (name === "pill") await shoot("pill", DESKTOP, "dark", async page => {
      await openChat(page, "Billing retries", billing.prompt);
      await page.getByRole("button", { name: /^Follow-up · / }).last().click();
      await page.getByText("Retry declined cards?").last().waitFor();
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
      { viewport: PHONE, drive: async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, "Billing retries")).click(); await page.getByText("Only network failures").first().waitFor(); } },
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
      await fs.writeFile(pkgPath, JSON.stringify({ ...pkg, version: WHATS_NEW_TO }, null, 2));
      await fs.writeFile(join(installed, "CHANGELOG.md"), await whatsNewChangelog());
      await fs.writeFile(join(home, "plugin-data/follow-up/versions.json"), JSON.stringify({ running: WHATS_NEW_FROM, previous: null, startedAt: null, hostSeen: WHATS_NEW_FROM }));
      await cli("plugin", "reload", "follow-up");
      let seenVersion = null;
      await until(() => `the ${WHATS_NEW_TO} worker (it reports ${seenVersion})`, async () => (seenVersion = (await call("follow.release-notes", {}).catch(e => ({ version: `error: ${e.message.split("\n")[0]}` }))).version) === WHATS_NEW_TO, { tries: 120, every: 500 });
      const sheet = phone => async page => {
        await openHome(page, { keepDialogs: true });
        if (phone) await page.setViewportSize(PHONE);
        await page.getByRole("dialog").getByText("What's new in Follow-up 2.0.0").first().waitFor().catch(() => page.getByText("What's new in Follow-up 2.0.0").first().waitFor());
        // The notes' screenshots load by URL: wait until each has loaded or failed (a failed one is left out).
        await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
      };
      /** The same sheet scrolled so `heading` is at the top: the panel's section and its image. */
      const sheetAt = (phone, heading) => async page => {
        await sheet(phone)(page);
        await page.getByText(heading, { exact: true }).last().evaluate(el => el.scrollIntoView({ block: "start" }));
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
      // Review evidence for the sheet itself (not README images): light, and the phone's bottom sheet.
      if (argv.includes("--whats-new-all")) {
        await shoot("whats-new-light", DESKTOP, "light", sheet(false), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone", PHONE, "light", sheet(true), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone-dark", PHONE, "dark", sheet(true), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-mid", DESKTOP, "dark", sheetAt(false, "A panel on every workspace"), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone-mid", PHONE, "dark", sheetAt(true, "A panel on every workspace"), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-end", DESKTOP, "dark", sheetEnd(false), { seen: WHATS_NEW_FROM });
        await shoot("whats-new-phone-end", PHONE, "light", sheetEnd(true), { seen: WHATS_NEW_FROM });
      }
      // Review evidence for the wide notes dialog (from 1280px windows) and the image viewer, both entry points.
      if (argv.includes("--notes-review")) {
        const BIG = { width: 2560, height: 1440 }; const NARROW = { width: 1180, height: 800 };
        const HOME_ALT = /^Follow-up Home: every workspace/; const PANEL_ALT = /^The Follow-up panel on a workspace/;
        const images = page => page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 30000 });
        const whatsNewAt = vp => async page => {
          await openHome(page, { keepDialogs: true });
          await page.setViewportSize(vp);
          await page.getByText("What's new in Follow-up 2.0.0").first().waitFor();
          await images(page);
        };
        /** Settings → Plugins → Follow-up → General → Release notes, See all. */
        const releaseNotesAt = vp => async page => {
          await page.setViewportSize(vp);
          await page.goto(`${ORIGIN}/settings/hosts/${SERVER_ID}/plugins/follow-up/projects`);
          await page.getByRole("button", { name: "See all" }).first().click();
          await page.getByText("Follow-up release notes", { exact: true }).last().waitFor();
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
        // Below 1280 the host's own 520px dialog, with the viewer inside its focus scope.
        if (!viewerOnly) await shoot("notes-1180", NARROW, "dark", whatsNewAt(NARROW), { seen: WHATS_NEW_FROM });
        await shoot("viewer-1180", NARROW, "dark", viewer(whatsNewAt(NARROW), HOME_ALT), { seen: WHATS_NEW_FROM });
        await shoot("esc-order-1440", DESKTOP, "dark", escOrder(whatsNewAt(DESKTOP)), { seen: WHATS_NEW_FROM });
        await shoot("esc-order-1180", NARROW, "dark", escOrder(whatsNewAt(NARROW)), { seen: WHATS_NEW_FROM });
      }
    }
  }
  if (only.includes("needs-you-states")) {
    // One Needs you block per surface: each state on the panel (desktop) and Home's detail pane (desktop and phone),
    // light and dark. Tall panel frames so the block, Tasks and their neighbours all fit.
    const states = [
      { state: "brief-same-q", title: "Billing retries", prompt: billing.prompt, wait: "Retry declined cards?" },
      { state: "brief-other-q", ...pick("ny-other"), wait: "Approve the staging export bucket" },
      { state: "two-qs", ...pick("ny-two"), wait: "Limit scope" },
      { state: "q-no-brief", ...pick("ny-lone"), wait: "Missing keys" },
      { state: "just-answered", ...pick("ny-answered"), wait: null },
      { state: "tasks", ...pick("ny-tasks"), wait: "Wire alert thresholds", homeToo: false },
    ];
    const TALL = { width: DESKTOP.width, height: 1300 };
    for (const s of states) for (const theme of ["light", "dark"]) {
      const settleOn = async page => { if (s.wait) await page.getByText(s.wait).filter({ visible: true }).first().waitFor(); else await page.waitForTimeout(1500); };
      await shoot(`ny-${s.state}-panel-${theme}`, TALL, theme, async page => {
        await page.setViewportSize(TALL);
        await openChat(page, s.title, s.prompt);
        await page.getByRole("button", { name: "Follow-up", exact: true }).last().click();
        await settleOn(page);
      });
      if (s.homeToo === false) continue;
      await shoot(`ny-${s.state}-home-${theme}`, DESKTOP, theme, async page => { await openHome(page); await (await homeRow(page, s.title)).click(); await settleOn(page); });
      await shoot(`ny-${s.state}-home-phone-${theme}`, PHONE, theme, async page => { await openHome(page); await page.setViewportSize(PHONE); await (await homeRow(page, s.title)).click(); await settleOn(page); });
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
function pick(key) { const w = NEEDS_YOU_STATES.find(x => x.key === key); return { title: w.title, prompt: w.prompt }; }

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
const WHATS_NEW_FROM = "1.4.0-beta.32";
const WHATS_NEW_TO = "2.0.0-rc.0";
/** A stand-in `## 2.0.0` section, used when the CHANGELOG has none yet. */
const SAMPLE_2_0 = `## 2.0.0

- Home is one list of every workspace: what needs you first, then what Follow-up is fixing, what's running and what waits on others.
- Questions from agents come with lettered options and a recommendation. Your answer goes straight into the agent's chat.
- Follow-up sends review comments, conflicts and failed checks to the workspace's agent in one batch, and asks you only for decisions.
- The composer pill shows what needs you in the chat you're in.
- Getting started checks GitHub and the helper agents, and shows what Follow-up does on its own.
`;
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
  await fs.writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, webUi: true })));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 120000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  if (asVersion) {
    const pkgPath = join(plugin, "package.json");
    await fs.writeFile(pkgPath, JSON.stringify({ ...JSON.parse(await fs.readFile(pkgPath, "utf8")), version: asVersion }, null, 2));
  }
  await fs.writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await fs.writeFile(join(fixture, "index.server.ts"), await fs.readFile("scripts/fixture-provider.ts", "utf8"));
  await fs.writeFile(join(root, "clock.cjs"), CLOCK_PRELOAD);
  await fs.writeFile(join(home, "gh-fixture.json"), JSON.stringify(pulls()));
  await fs.writeFile(join(bin, "gh"), fakeGh(join(home, "gh-fixture.json"))); await fs.chmod(join(bin, "gh"), 0o700);
  // PR reads go over HTTPS (server/github-api.ts) to this fake, which answers with the same fixture gh.
  github = await fakeGithub({ dir: root, gh: join(bin, "gh") });
  await fs.writeFile(join(home, "linear-fixture.json"), JSON.stringify(linearIssues()));
  await fs.writeFile(join(bin, "mcpproxy"), fakeMcpproxy(join(home, "linear-fixture.json"))); await fs.chmod(join(bin, "mcpproxy"), 0o700);
  if (argv.includes("--rename-review")) { await fs.writeFile(join(bin, "claude"), fakeClaude(join(home, "claude-mode"))); await fs.chmod(join(bin, "claude"), 0o700); }
  // Real speed while the daemon starts and the plugin installs; seeding and shooting crawl (setDaemonClock).
  // It starts ten minutes before BASE, so the clock only ever moves forward.
  await fs.writeFile(clockFile, JSON.stringify({ fake: at(-10), real: Date.now(), rate: 1 }));

  const env = harnessEnv(root, { home, strip: github.strip, set: { ...github.env, PASEO_DAEMON_URL: url, PASEO_SERVER_ID: "srv_followupshots", FIXTURE_MODEL_LABEL: "Agent", PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true", PATH: `${bin}:${process.env.PATH}`, FOLLOW_SHOTS_CLOCK: clockFile, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${join(root, "clock.cjs")}`.trim(), TZ: "UTC" } });
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1 << 22 })).stdout);
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
  await cli("plugin", "install", fixture); await cli("plugin", "install", plugin);
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
  const shoot = makeShooter({ browser, port, out, scheme, optimiser, results, crashed });

  // setup: the first step of Getting started, on this fresh install, before anything is seeded.
  if (only.includes("setup")) await shoot("setup", { width: 1440, height: 900 }, "dark", async page => {
    await openHome(page, { keepDialogs: true });
    // The first step, by its progressbar ("Step 1 of N", N = ONBOARDING_STEPS.length): no hard-coded step count.
    // Under reduced motion (the context's) StepFade shows the step at once, so there is no fade to wait out.
    await page.getByRole("progressbar", { name: /^Step 1 of \d+$/ }).first().waitFor();
    await page.getByText("Follow-up keeps your agents' PRs moving").waitFor();
  });
  await call("follow.set-onboarding", { action: "finish" });
  const seeded = await seed({ call, home });
  log(`seeded ${seeded.workspaces.length} synthetic workspaces`);
  if (keep) { console.log(JSON.stringify({ root, home, port, ...seeded })); log("--keep: daemon left running; Ctrl-C to stop it"); await new Promise(() => {}); }
  await setDaemonClock(BASE + VIEW);
  await shootAll({ shoot, seeded, call, plugin, home, cli });
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
