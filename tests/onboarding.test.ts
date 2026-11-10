import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnboardingStore, ReadinessChecks, nativeAgentCount, type CheckDeps } from "../server/onboarding";
import { CHOICE_WRITES, autoSendWrites, checksSummary, classifyInstall, followWrites, offerVisible, initialOnboarding, OFFER_MS, type Check } from "../shared/onboarding";
import { reviewerSettingsRpc, saveReviewersRpc, setFollowSettingsRpc, followSettingsRpc, prWorkflowRpc, setPrWorkflowRpc } from "../shared/contracts";
import { displayPreferences } from "../shared/display";

const tmp = async (t: TestContext) => { const d = await mkdtemp(join(tmpdir(), "follow-onboarding-")); t.after(() => rm(d, { recursive: true, force: true })); return d; };
const at = (iso: string) => () => new Date(iso);

// ---------- first-run detection ----------

test("first run: an empty data folder is a fresh install and Home shows the flow", async t => {
  const dir = await tmp(t);
  // What the worker has written before ready runs: the tools instance and hook-state. Neither means "used before".
  await mkdir(join(dir, "hook-state")); await writeFile(join(dir, "tools-instance.json"), "{}");
  const store = new OnboardingStore(dir, at("2026-11-09T10:00:00Z"));
  assert.equal((await store.init()).install, "fresh");
  const view = await store.view();
  assert.deepEqual(view, { install: "fresh", status: "new", step: "intro", show: true, offer: false, holdsAutoSends: true });
});

test("first run: any Follow-up data on disk is an existing install, never shown the flow", async t => {
  for (const file of ["state.json", "inbox.json", "reviewers.json", "agents.json", "brief.json"]) {
    const dir = await tmp(t);
    await writeFile(join(dir, file), "{}");
    const store = new OnboardingStore(dir, at("2026-11-09T10:00:00Z"));
    await store.init();
    const view = await store.view();
    assert.equal(view.install, "existing", file);
    assert.equal(view.show, false, `${file}: never forced on an existing install`);
    assert.equal(view.offer, true, `${file}: offered quietly instead`);
  }
});

test("first run: decided once; state.json written later doesn't turn a fresh install into an existing one", async t => {
  const dir = await tmp(t);
  await new OnboardingStore(dir, at("2026-11-09T10:00:00Z")).init();
  await writeFile(join(dir, "state.json"), "{}");
  const again = new OnboardingStore(dir, at("2026-11-09T10:05:00Z"));
  assert.equal((await again.init()).install, "fresh");
  assert.equal((await again.view()).show, true);
});

test("first run: an unreadable onboarding.json never forces the flow", async t => {
  const dir = await tmp(t);
  await writeFile(join(dir, "onboarding.json"), "{not json");
  const view = await new OnboardingStore(dir).view();
  assert.equal(view.show, false); assert.equal(view.offer, false);
});

test("classifyInstall only counts Follow-up's own data files", () => {
  assert.equal(classifyInstall([]), "fresh");
  assert.equal(classifyInstall(["hook-state", "tools-instance.json", "mcp.mjs", "worker.lock"]), "fresh");
  assert.equal(classifyInstall(["mcp.mjs", "state.json"]), "existing");
});

test("existing-install offer: shown for a day from first showing, gone once dismissed, taken or skipped", async t => {
  const dir = await tmp(t);
  await writeFile(join(dir, "state.json"), "{}");
  let now = new Date("2026-11-09T10:00:00Z");
  const store = new OnboardingStore(dir, () => now);
  await store.init();
  assert.equal((await store.view()).offer, true);
  now = new Date(now.getTime() + OFFER_MS - 60_000);
  assert.equal((await store.view()).offer, true, "still within the day");
  now = new Date(now.getTime() + 120_000);
  assert.equal((await store.view()).offer, false, "a day after it first showed, it's gone for good");

  const file = { ...initialOnboarding("existing", new Date(0)) };
  assert.equal(offerVisible({ ...file, offerDismissed: true }, 0), false);
  assert.equal(offerVisible({ ...file, status: "active" }, 0), false);
  assert.equal(offerVisible({ ...file, status: "done" }, 0), false);
  assert.equal(offerVisible(initialOnboarding("fresh", new Date(0)), 0), false, "a fresh install gets the flow, not the offer");
});

test("existing install: dismissing the offer never brings it or the flow back", async t => {
  const dir = await tmp(t);
  await writeFile(join(dir, "state.json"), "{}");
  const store = new OnboardingStore(dir);
  await store.init();
  const view = await store.act("dismiss-offer");
  assert.deepEqual([view.show, view.offer], [false, false]);
  const reloaded = await new OnboardingStore(dir).view();
  assert.deepEqual([reloaded.show, reloaded.offer], [false, false]);
});

test("Set up Follow-up again starts from the beginning on any install, and finish or skip ends it", async t => {
  const dir = await tmp(t);
  await writeFile(join(dir, "state.json"), "{}");
  const store = new OnboardingStore(dir);
  await store.init();
  let view = await store.act("restart");
  assert.deepEqual([view.show, view.step, view.offer], [true, "intro", false]);
  view = await store.act("step", "reviewers");
  view = await store.act("finish");
  assert.deepEqual([view.show, view.status], [false, "done"]);
  view = await store.act("restart");
  assert.equal(view.step, "intro");
  view = await store.act("skip");
  assert.deepEqual([view.show, view.status], [false, "skipped"]);
});

// ---------- resume ----------

test("resume: the step survives a reload (a new store over the same folder) and a fresh install stays in the flow", async t => {
  const dir = await tmp(t);
  const first = new OnboardingStore(dir);
  await first.init();
  await first.act("start");
  await first.act("step", "defaults");
  await first.act("step", "helpers");
  const saved = JSON.parse(await readFile(join(dir, "onboarding.json"), "utf8"));
  assert.equal(saved.step, "helpers");
  const reloaded = new OnboardingStore(dir);
  const view = await reloaded.view();
  assert.deepEqual([view.show, view.status, view.step], [true, "active", "helpers"]);
  // Start again on an active flow keeps the place (e.g. Home and the setup screen both open it).
  assert.equal((await reloaded.act("start")).step, "helpers");
});

test("resume: going to a step on a fresh install marks it in progress", async t => {
  const dir = await tmp(t);
  const store = new OnboardingStore(dir);
  await store.init();
  const view = await store.act("step", "checks");
  assert.deepEqual([view.status, view.step, view.show], ["active", "checks", true]);
});

// ---------- readiness checks ----------

const catalog = (claude: boolean | string, codex: boolean | string) => ({ error: null, providers: [
  { id: "claude", label: "Claude", available: claude === true, reason: claude === true ? null : typeof claude === "string" ? claude : "Not installed" },
  { id: "codex", label: "Codex", available: codex === true, reason: codex === true ? null : typeof codex === "string" ? codex : "Not installed" },
] });
const deps = (patch: Partial<CheckDeps> = {}): CheckDeps => ({
  gh: async () => "demo-dev\n",
  catalog: async () => catalog(true, true),
  use: async () => ({ claude: ["the Overseer", "Summaries", "AI priority"] }),
  tools: async () => ({ config: { daemon: { mcp: { enabled: true } } }, nativeAgents: 3, hookError: null }),
  ...patch,
});
const byId = (checks: Check[], id: string) => { const c = checks.find(x => x.id === id); assert.ok(c, `no ${id} check`); return c; };

test("checks: everything ready", async () => {
  const { checks } = await new ReadinessChecks(deps()).run();
  assert.equal(byId(checks, "gh").state, "ok"); assert.match(byId(checks, "gh").detail, /Signed in as demo-dev/);
  assert.equal(byId(checks, "provider-claude").state, "ok"); assert.match(byId(checks, "provider-claude").detail, /Overseer/);
  assert.equal(byId(checks, "provider-codex").state, "ok"); assert.match(byId(checks, "provider-codex").detail, /Not used by any helper/);
  assert.equal(byId(checks, "tools").state, "ok"); assert.match(byId(checks, "tools").detail, /3 agents/);
  assert.equal(checksSummary(checks).line, "All set");
});

test("checks: gh missing, signed out and unreachable each say how to fix it", async () => {
  const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  let gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw missing; } })).run()).checks, "gh");
  assert.equal(gh.state, "fail"); assert.match(gh.detail, /isn't installed/); assert.equal(gh.fix?.command, "gh auth login"); assert.match(gh.fix!.text, /cli\.github\.com/);

  const out = Object.assign(new Error("exit 4"), { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" });
  gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw out; } })).run()).checks, "gh");
  assert.equal(gh.state, "fail"); assert.match(gh.detail, /isn't signed in/); assert.equal(gh.fix?.command, "gh auth login");

  const bad = Object.assign(new Error("exit 1"), { code: 1, stderr: "HTTP 401: Bad credentials (https://api.github.com/user)" });
  gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw bad; } })).run()).checks, "gh");
  assert.equal(gh.state, "fail", "an expired token is signed out");

  const net = Object.assign(new Error("exit 1"), { code: 1, stderr: "dial tcp: lookup api.github.com: no such host" });
  gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw net; } })).run()).checks, "gh");
  assert.equal(gh.state, "warn"); assert.match(gh.detail, /Couldn't reach GitHub/); assert.match(gh.fix!.text, /network/);

  gh = byId((await new ReadinessChecks(deps({ gh: async () => "  \n" })).run()).checks, "gh");
  assert.equal(gh.state, "fail", "no login printed is not signed in");
});

test("checks: a provider a helper uses is a failure; an unused one is optional; both missing says what still works", async () => {
  let checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(false, true) })).run()).checks;
  const claude = byId(checks, "provider-claude");
  assert.equal(claude.state, "fail"); assert.match(claude.detail, /the Overseer, Summaries and AI priority won't run/);
  assert.equal(claude.fix?.settings, "agents", "Codex works, so offer to switch the helpers"); assert.equal(claude.fix?.command, "claude");

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(true, false) })).run()).checks;
  assert.equal(byId(checks, "provider-codex").state, "off"); assert.equal(byId(checks, "provider-codex").fix, null);

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(false, false), use: async () => ({ claude: ["the Overseer"], codex: ["AI priority"] }) })).run()).checks;
  assert.equal(byId(checks, "providers").state, "fail"); assert.match(byId(checks, "providers").detail, /Following PRs and Needs you still work/);
  assert.equal(byId(checks, "provider-codex").state, "fail"); assert.equal(byId(checks, "provider-codex").fix?.command, "codex login");
  assert.equal(byId(checks, "provider-claude").fix?.settings, null, "nothing to switch to");

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog("Still loading", true) })).run()).checks;
  assert.equal(byId(checks, "provider-claude").state, "pending");

  checks = (await new ReadinessChecks(deps({ catalog: async () => { throw new Error("Paseo isn't connected yet"); } })).run()).checks;
  assert.equal(byId(checks, "providers").state, "warn"); assert.match(byId(checks, "providers").detail, /isn't connected/);
});

test("checks: tools through the bridge, blocked by config, not seen yet, and hooks that failed", async () => {
  let tools = byId((await new ReadinessChecks(deps({ tools: async () => ({ config: { daemon: { mcp: { enabled: false } } }, nativeAgents: 0, hookError: null }) })).run()).checks, "tools");
  assert.equal(tools.state, "warn"); assert.match(tools.detail, /Paseo's MCP is off/); assert.match(tools.fix!.command!, /"mcp": \{ "enabled": true \}/);

  tools = byId((await new ReadinessChecks(deps({ tools: async () => ({ config: { agents: { providers: { claude: { paseoTools: { disabledTools: ["follow_merge"] } } } } }, nativeAgents: 2, hookError: null }) })).run()).checks, "tools");
  assert.equal(tools.state, "warn"); assert.match(tools.detail, /off for Claude/);

  tools = byId((await new ReadinessChecks(deps({ tools: async () => ({ config: null, nativeAgents: 0, hookError: null }) })).run()).checks, "tools");
  assert.equal(tools.state, "pending"); assert.equal(tools.fix, null, "the normal fresh state is not a failure");

  const checks = (await new ReadinessChecks(deps({ tools: async () => ({ config: null, nativeAgents: 1, hookError: "x" }) })).run()).checks;
  assert.equal(byId(checks, "hooks").state, "warn");
  assert.equal(checksSummary(checks).line, "Ready, with 1 note");
});

test("checks: cached for a minute and run on demand only; Check again skips the cache", async () => {
  let calls = 0; let now = 1_000_000;
  const checks = new ReadinessChecks(deps({ gh: async () => { calls++; return "demo-dev"; }, now: () => now }));
  await checks.run(); await checks.run();
  assert.equal(calls, 1);
  await checks.run(true);
  assert.equal(calls, 2, "Check again");
  now += 61_000; await checks.run();
  assert.equal(calls, 3, "stale after a minute");
});

test("nativeAgentCount counts native-<agent>.json only", async t => {
  const dir = await tmp(t);
  assert.equal(await nativeAgentCount(dir), 0);
  await mkdir(join(dir, "hook-state"));
  for (const n of ["native-a1.json", "native-b2.json", "overseer-seen-a1.json", "native-x.json.tmp"]) await writeFile(join(dir, "hook-state", n), "{}");
  assert.equal(await nativeAgentCount(dir), 2);
});

// ---------- choices write what Settings writes ----------

test("choices: every write is a Settings RPC or display-settings field, never a parallel config", () => {
  const settingsRpcs = new Set([setFollowSettingsRpc.name, saveReviewersRpc.name, setPrWorkflowRpc.name]);
  const displayFields = new Set(Object.keys(displayPreferences.schema.shape));
  for (const [choice, target] of Object.entries(CHOICE_WRITES)) {
    if ("rpc" in target) assert.ok(settingsRpcs.has(target.rpc), `${choice} → ${target.rpc}`);
    else { assert.equal(target.settings, displayPreferences.id, choice); assert.ok(displayFields.has(target.field), `${choice} → display.${target.field}`); }
  }
  // The RPC inputs accept exactly what the flow sends.
  assert.ok(setFollowSettingsRpc.input.safeParse({ enable_follow_every: true }).success);
  assert.ok(setFollowSettingsRpc.input.safeParse({ enable_auto_sends_default: false }).success);
  assert.ok(setFollowSettingsRpc.input.safeParse({ workspace: { workspaceId: "w1", follow: false } }).success);
  assert.ok(setFollowSettingsRpc.input.safeParse({ workspace: { workspaceId: "w1", enable_auto_sends: false } }).success);
  assert.ok(saveReviewersRpc.input.safeParse({ repo: null, reviewers: [{ login: "ana-reviews", name: null }] }).success);
  // shipping writes follow.set-pr-workflow, the RPC Settings' Shipping PRs uses.
  assert.ok(setPrWorkflowRpc.input.safeParse({ repo: "acme/api", setting: "github" }).success);
  assert.ok(followSettingsRpc && reviewerSettingsRpc && prWorkflowRpc);
});

test("shipping sits between defaults and reviewers", async () => {
  const { ONBOARDING_STEPS } = await import("../shared/onboarding");
  assert.deepEqual([...ONBOARDING_STEPS], ["intro", "checks", "defaults", "shipping", "reviewers", "helpers"]);
});

test("choices: the setup client calls the same contracts and settings document as the Settings screen", async () => {
  const flow = await readFile(new URL("../client/onboarding.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../client/settings.tsx", import.meta.url), "utf8");
  const display = await readFile(new URL("../client/display.tsx", import.meta.url), "utf8");
  for (const name of ["followSettingsRpc", "setFollowSettingsRpc"]) { assert.match(settings, new RegExp(`\\b${name}\\b`)); assert.match(flow, new RegExp(`\\b${name}\\b`), name); }
  assert.match(flow, /\bReviewerSettings\b/, "reviewers reuse Settings' own editor");
  assert.match(display, /useSettings\(displayPreferences\)/); assert.match(flow, /useSettings\(displayPreferences\)/);
  assert.doesNotMatch(flow, /writeFile|localStorage\.setItem\(["'`]follow-up\.onboarding/, "no parallel config");
});

const rows = [
  { id: "a", enable_tracking: true, enable_auto_sends: true, optedOut: false },
  { id: "b", enable_tracking: true, enable_auto_sends: false, optedOut: false },
  { id: "c", enable_tracking: false, enable_auto_sends: true, optedOut: true },
];
test("choices: auto-send sets the default and each followed workspace that differs", () => {
  assert.deepEqual(autoSendWrites(false, rows), [{ enable_auto_sends_default: false }, { workspace: { workspaceId: "a", enable_auto_sends: false } }]);
  assert.deepEqual(autoSendWrites(true, rows), [{ enable_auto_sends_default: true }, { workspace: { workspaceId: "b", enable_auto_sends: true } }]);
});
test("choices: picking workspaces only writes the ones that change", () => {
  assert.deepEqual(followWrites(new Set(["a", "c"]), rows), [{ workspace: { workspaceId: "b", follow: false } }, { workspace: { workspaceId: "c", follow: true } }]);
  assert.deepEqual(followWrites(new Set(["a", "b"]), rows), []);
});

// ---------- auto-send hold ----------

test("auto-send hold: a fresh install holds until setup is finished or skipped; existing installs never hold", async t => {
  const fresh = new OnboardingStore(await tmp(t), at("2026-11-09T10:00:00Z"));
  await fresh.init(); assert.equal(fresh.holdsAutoSends(), true);
  await fresh.act("step", "defaults"); assert.equal(fresh.holdsAutoSends(), true, "still mid-setup");
  await fresh.act("finish"); assert.equal(fresh.holdsAutoSends(), false);
  await fresh.act("restart"); assert.equal(fresh.holdsAutoSends(), false, "setting up again later doesn't hold");

  const skipped = new OnboardingStore(await tmp(t), at("2026-11-09T10:00:00Z"));
  await skipped.init(); await skipped.act("skip"); assert.equal(skipped.holdsAutoSends(), false);

  const existing = new OnboardingStore(await tmp(t), at("2026-11-09T10:00:00Z"));
  await existing.init(["state.json"]); assert.equal(existing.holdsAutoSends(), false);
  await existing.act("restart"); assert.equal(existing.holdsAutoSends(), false);
});

test("auto-send hold: survives a reload mid-setup and lifts after it", async t => {
  const dir = await tmp(t);
  const first = new OnboardingStore(dir, at("2026-11-09T10:00:00Z"));
  await first.init(); await first.act("step", "checks");
  const reloaded = new OnboardingStore(dir, at("2026-11-09T10:05:00Z"));
  await reloaded.init(); assert.equal(reloaded.holdsAutoSends(), true);
  await reloaded.act("finish");
  const again = new OnboardingStore(dir, at("2026-11-09T10:06:00Z"));
  await again.init(); assert.equal(again.holdsAutoSends(), false);
});

test("auto-send hold: unknown or unreadable onboarding state never holds", async t => {
  assert.equal(new OnboardingStore(await tmp(t)).holdsAutoSends(), false, "before init");
  const dir = await tmp(t); await writeFile(join(dir, "onboarding.json"), "not json");
  const store = new OnboardingStore(dir); await store.init(); assert.equal(store.holdsAutoSends(), false);
});

test("auto-send hold: the worker wires the engine to the onboarding store", async () => {
  const source = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(source, /engine\.autoSendsHeld = \(\) => onboarding\.holdsAutoSends\(\)/);
});
