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
import { harnessEnv } from "./harness-env.mjs";
import { openHome as openHomeAt, homeRow } from "./ui-home.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
// What's new reinstalls the plugin as 2.0.0-rc.0, so it goes last: every other shot shows the version under test.
const SHOTS = ["setup", "home", "panel", "questions", "pill", "pr-sheet", "phone", "context-menu", "linked-items", "notes-home", "notes-panel", "whats-new"];
const only = arg("--only") ? arg("--only").split(",").map(s => s.trim()).filter(Boolean) : SHOTS;
for (const name of only) if (!SHOTS.includes(name)) fail(`unknown shot "${name}" (known: ${SHOTS.join(", ")})`);
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
if (!paseoVersion || !/(^|\D)0\.15\.\d+/.test(paseoVersion)) fail(`needs the Paseo CLI 0.15.x on PATH (found ${paseoVersion ?? "none"}); run through harness-slot or put ~/paseo-harness/cli/0.15.4/bin first`);
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
/** What the fake `gh` answers for example/app, by PR number. */
function pulls() {
  return {
    141: { title: "Add the retry schedule table", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
    142: { title: "Retry failed charges with exponential backoff", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [failed("test"), ok("lint"), ok("typecheck")] },
    143: { title: "Send the dunning email after the last retry", state: "OPEN", author: "dana", base: "branch-142", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint"), ok("typecheck")] },
    151: { title: "Saved search filters", state: "OPEN", author: "dana", approved: true, reviewed: ["ravi"], checks: [ok("test"), ok("lint")] },
    160: { title: "Welcome email template", state: "OPEN", author: "dana", conflict: true, threads: 2, reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    170: { title: "Sign webhook payloads", state: "OPEN", author: "dana", reviewers: ["ravi"], checks: [ok("test"), ok("lint")] },
    181: { title: "Dark mode color tokens", state: "MERGED", author: "dana", checks: [ok("test"), ok("lint")] },
  };
}
/** A fake `gh`: GraphQL PR reads from the fixture file, `[]` for everything else (branch rules, auth). */
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
  repository[m[1]] = { number: n, title: p.title, url: "https://github.com/example/app/pull/" + n, state: p.state, headRefName: "branch-" + n, headRefOid: "0f3c9a" + n, baseRefName: base,
    isDraft: false, mergeable: p.conflict ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: p.conflict ? "DIRTY" : "CLEAN", reviewDecision: p.approved ? "APPROVED" : "REVIEW_REQUIRED",
    mergedAt: p.state === "MERGED" ? "2026-03-04T08:00:00Z" : null, mergeCommit: p.state === "MERGED" ? { oid: "9a1b2c" + n } : null, isInMergeQueue: false, autoMergeRequest: null,
    author: { login: p.author },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: (p.reviewers ?? []).map(l => ({ requestedReviewer: user(l) })) },
    latestReviews: { pageInfo: { hasNextPage: false }, nodes: (p.reviewed ?? []).map(l => ({ state: "APPROVED", author: user(l) })) },
    baseRef: { branchProtectionRule: base === "main" ? { requiredStatusCheckContexts: ["test", "lint"] } : null, associatedPullRequests: { nodes: base === "main" ? [] : [{ number: Number(base.slice(7)), headRefName: base, state: d[Number(base.slice(7))]?.state ?? "OPEN", headRepository: { nameWithOwner: "example/app" } }] } },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: p.threads ?? 0 }, (_, i) => ({ id: "thread-" + n + "-" + i, isResolved: false, comments: { nodes: [{ updatedAt: "2026-03-04T08:30:00Z" }] } })) },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: p.checks ?? [] } } } }] } };
}
console.log(JSON.stringify({ data: { repository } }));
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
  { key: "theme", title: "Dark mode tokens", minute: 0, prompt: "WEB-9: move the dashboard to the new color tokens and ship it.",
    steps: [rpc("follow.enroll", { goal: "WEB-9 Dark mode color tokens" }), rpc("follow.register-pr", { repo: "example/app", number: 181, stack: "Dark mode tokens" }),
      bash("pnpm test --filter dashboard", "pass 128"), msg("Shipped in example/app#181. The dashboard uses the new tokens in both themes.")],
    done: "Dark mode tokens shipped in #181 and checked in both themes" },
  { key: "webhooks", title: "Webhook signing", minute: 25, prompt: "APP-160: sign outgoing webhook payloads with HMAC and document the header.",
    steps: [rpc("follow.enroll", { goal: "APP-160 Sign webhook payloads" }), rpc("follow.register-pr", { repo: "example/app", number: 170, stack: "Webhook signing" }),
      bash("pnpm test webhooks", "pass 36"), msg("Opened example/app#170 and asked Ravi for review. The signature header is documented in docs/webhooks.md.")] },
  { key: "email", title: "Onboarding email", minute: 50, prompt: "APP-155: add the welcome email template and send it after sign-up.",
    steps: [rpc("follow.enroll", { goal: "APP-155 Welcome email after sign-up" }), rpc("follow.register-pr", { repo: "example/app", number: 160, stack: "Onboarding email" }),
      msg("Opened example/app#160 with the welcome template.")] },
  { key: "search", title: "Search filters", minute: 80, prompt: "WEB-17: saved search filters. Run the staging migration when the PR is green.",
    steps: [rpc("follow.enroll", { goal: "WEB-17 Saved search filters" }), rpc("follow.register-pr", { repo: "example/app", number: 151, stack: "Search filters" }),
      bash("pnpm test search", "pass 54"), msg("The filters save and load, and tests pass. The new column needs migration 0042 on staging first."),
      { permission: { name: "Bash", title: "Run the staging migration", input: { command: "pnpm db:migrate --env staging --to 0042" } } }],
    waitFor: "permission" },
  { key: "audit", title: "Audit log export", minute: 120, prompt: "WEB-21: export the audit log as CSV, streamed, with a date range.",
    steps: [rpc("follow.enroll", { goal: "WEB-21 Audit log CSV export" }), think("Stream rows so large ranges don't buffer in memory."), bash("pnpm test audit", "pass 12"), { hold: true }],
    waitFor: "running" },
  { key: "billing", title: "Billing retries", minute: 140, prompt: "APP-142: retry failed charges with exponential backoff, then send the dunning email after the last retry.",
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
    ] },
];

async function seed({ call, home }) {
  // A fixed (empty) project folder: Paseo derives the project's avatar color from it, so a random temp path would
  // recolor the sidebar on every run.
  const repo = join(tmpdir(), "follow-up-shots-fixture", "app"); await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(join(home, "fixture-scripts.json"), JSON.stringify(Object.fromEntries(WORKSPACES.map(w => [w.prompt, w.steps]))));
  const workspaces = [];
  for (const spec of WORKSPACES) {
    await setDaemonClock(at(spec.minute));
    const w = await api.workspaces.create({ title: spec.title, source: { kind: "directory", path: repo } });
    const agent = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: spec.title });
    await call("follow.activate", { workspaceId: w.id });
    await call("follow.control", { workspaceId: w.id, enable_auto_sends: false });
    await client.sendMessage(agent.id, spec.prompt, { messageId: `shots-${spec.key}` });
    const last = [...spec.steps].reverse().find(s => s.item?.type === "assistant_message")?.item.text;
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
    await setDaemonClock(at(spec.minute) + 61_000);
    if (spec.waitFor !== "running") await until(`${spec.key} inbox flag`, async () => (await call("follow.inbox-list", {})).rows.some(r => r.agentId === agent.id && r.needs), { tries: 120, every: 500 });
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
  // One item the developer added by hand ("Added by you" in the Linked list).
  const billing = workspaces.find(w => w.key === "billing");
  await call("follow.set-linked-items", { workspaceId: billing.workspaceId, action: "add", ref: "APP-151" });
  await call("follow.refresh", {});
  // The inbox loop folds PR, CI and review state into each brief; let it run on the snapshots before the clock moves.
  await inboxTicks(home, 2);
  return { workspaces };
}

/** Waits for `n` more runs of the worker's inbox loop (its tick stamps inbox.json's lastSeen). */
async function inboxTicks(home, n) {
  const lastSeen = () => fs.readFile(join(home, "plugin-data/follow-up/inbox.json"), "utf8").then(t => JSON.parse(t).lastSeen ?? null, () => null);
  for (let i = 0; i < n; i++) { const before = await lastSeen(); await until("an inbox tick", async () => (await lastSeen()) !== before, { tries: 160, every: 250 }); }
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
function makeShooter({ browser, port, out, scheme: forced, optimiser, results }) {
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
  const guard = work => async (name, ...rest) => { try { await work(name, ...rest); } catch (error) { failures.push(name); console.error(`[shots] ${name} FAILED: ${error.message.split("\n")[0]} (see ${join(out, `${name}-failed.png`)})`); } };
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

/** No spinners or skeletons on screen, fonts loaded, and two quiet frames. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Getting started's step indicator is a progressbar too ("Step 1 of N"), but not a loading state.
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(n => n.getBoundingClientRect().width > 0 && !/^Step \d+ of \d+$/.test(n.getAttribute("aria-label") ?? "")), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** A workspace's agent chat, opened from Paseo's sidebar like a person would (deep links land before the host is known). */
async function openChat(page, title, prompt) {
  await page.getByText(title, { exact: true }).first().click({ timeout: 30000 });
  await page.getByText(prompt).first().waitFor();
}

async function shootAll({ shoot, seeded, plugin, home, cli, call }) {
  const billing = WORKSPACES.find(w => w.key === "billing");
  for (const name of SHOTS) {
    if (!only.includes(name) || name === "setup") continue;
    if (name === "home") await shoot("home", DESKTOP, "dark", async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click();
      await page.getByText("Only network failures").first().waitFor();
    });
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
    if (name === "context-menu") await shoot("context-menu", DESKTOP, "dark", async page => {
      await openHome(page);
      await (await homeRow(page, "Billing retries")).click();
      await page.getByText("Only network failures").first().waitFor();
      await (await homeRow(page, "Billing retries")).click({ button: "right", position: { x: 160, y: 18 } });
      const menu = page.getByRole("menu", { name: "Actions for Billing retries" });
      await menu.waitFor();
      await menu.getByRole("menuitem", { name: /^Answer Q1/ }).first().waitFor();
      await menu.getByRole("menuitem", { name: /^Copy \d* ?PR links?/ }).first().waitFor();
    });
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
  await fs.writeFile(join(home, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false }, browserTools: { enabled: false } }, features: { webUi: { enabled: true } } }));
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
  await fs.writeFile(join(home, "linear-fixture.json"), JSON.stringify(linearIssues()));
  await fs.writeFile(join(bin, "mcpproxy"), fakeMcpproxy(join(home, "linear-fixture.json"))); await fs.chmod(join(bin, "mcpproxy"), 0o700);
  // Real speed while the daemon starts and the plugin installs; seeding and shooting crawl (setDaemonClock).
  // It starts ten minutes before BASE, so the clock only ever moves forward.
  await fs.writeFile(clockFile, JSON.stringify({ fake: at(-10), real: Date.now(), rate: 1 }));

  const env = harnessEnv(root, { home, set: { PASEO_DAEMON_URL: url, PASEO_SERVER_ID: "srv_followupshots", PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true", PATH: `${bin}:${process.env.PATH}`, FOLLOW_SHOTS_CLOCK: clockFile, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${join(root, "clock.cjs")}`.trim(), TZ: "UTC" } });
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1 << 22 })).stdout);
  const daemonLog = openSync(join(root, "daemon.log"), "a");
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", daemonLog, daemonLog] });
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
  const shoot = makeShooter({ browser, port, out, scheme, optimiser, results });

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
  process.exitCode = 1;
} finally {
  await stopDaemon();
  if (process.exitCode) log(`kept ${root} for the daemon log`); else await fs.rm(root, { recursive: true, force: true });
}
