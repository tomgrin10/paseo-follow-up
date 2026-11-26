import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnboardingStore, ReadinessChecks, nativeAgentCount, type CheckDeps } from "../server/onboarding";
import { CHOICE_WRITES, autoSendWrites, checksSummary, classifyInstall, followWrites, offerVisible, providerChecks, providersReady, setupSteps, shownStep, initialOnboarding, OFFER_MS, sentenceStart, type Check, type GhResult } from "../shared/onboarding";
import { reviewerSettingsRpc, saveReviewersRpc, setFollowSettingsRpc, followSettingsRpc, prWorkflowRpc, setPrWorkflowRpc, setUpdatesRpc } from "../shared/contracts";
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
  gh: async () => ({ login: "demo-dev" }),
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

test("checks: GitHub is optional (works-without-github): missing or signed out is off, never a failure, and says how to turn it on", async () => {
  let gh = byId((await new ReadinessChecks(deps({ gh: async () => ({ error: "missing", message: "" }) })).run()).checks, "gh");
  assert.equal(gh.state, "off"); assert.match(gh.detail, /isn't installed/); assert.match(gh.detail, /Optional/); assert.match(gh.detail, /everything else works without it/); assert.match(gh.detail, /PR status/);
  assert.equal(gh.fix?.command, "gh auth login"); assert.equal(gh.fix?.url, "https://cli.github.com"); assert.match(gh.fix!.text, /picks it up on its own/);

  gh = byId((await new ReadinessChecks(deps({ gh: async () => ({ error: "signed-out", message: "" }) })).run()).checks, "gh");
  assert.equal(gh.state, "off"); assert.match(gh.detail, /isn't signed in/); assert.equal(gh.fix?.command, "gh auth login"); assert.equal(gh.fix?.url, undefined);

  const bad = Object.assign(new Error("GitHub refused the token (HTTP 401)"), { status: 401 });
  gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw bad; } })).run()).checks, "gh");
  assert.equal(gh.state, "off", "an expired token is signed out");

  const net = Object.assign(new Error("fetch failed"), { stderr: "dial tcp: lookup api.github.com: no such host" });
  gh = byId((await new ReadinessChecks(deps({ gh: async () => { throw net; } })).run()).checks, "gh");
  assert.equal(gh.state, "warn"); assert.match(gh.detail, /Couldn't reach GitHub/); assert.match(gh.fix!.text, /network/);

  const off = (await new ReadinessChecks(deps({ gh: async () => ({ error: "missing", message: "" }) })).run()).checks;
  assert.equal(checksSummary(off).state, "ok", "no GitHub alone leaves setup all set");
});

test("checks: a provider a helper uses is a failure; an unused one is optional; none at all says what to set up", async () => {
  let checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(false, true) })).run()).checks;
  const claude = byId(checks, "provider-claude");
  assert.equal(claude.state, "fail"); assert.match(claude.detail, /\. The Overseer, Summaries and AI priority won't run/);
  assert.equal(claude.fix?.settings, "agents", "Codex works, so offer to switch the helpers"); assert.equal(claude.fix?.command, "claude");

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(true, false) })).run()).checks;
  // A provider no helper uses and that isn't there gets no row (an-agent-on-any-provider-gets-follow-up).
  assert.equal(checks.find(c => c.id === "provider-codex"), undefined, "an unused missing provider is not listed");

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog(false, false), use: async () => ({ claude: ["the Overseer"], codex: ["AI priority"] }) })).run()).checks;
  // No provider at all is Paseo's next step, not Follow-up failing: a note that says what to set up.
  assert.equal(byId(checks, "providers").state, "warn"); assert.match(byId(checks, "providers").fix?.text ?? "", /Set one up in Paseo's settings/);
  // The one Agents row says what to set up; each provider row only says what it is, never a second alarm.
  assert.equal(checks.find(c => c.id === "provider-codex"), undefined, "the Agents row stands alone");
  assert.equal(checksSummary(checks).line, "Set up an agent provider in Paseo to start");
  assert.equal(checks.filter(c => c.state === "fail").length, 0);

  checks = (await new ReadinessChecks(deps({ catalog: async () => catalog("Still loading", true) })).run()).checks;
  assert.equal(byId(checks, "provider-claude").state, "pending");

  checks = (await new ReadinessChecks(deps({ catalog: async () => { throw new Error("Paseo isn't connected yet"); } })).run()).checks;
  assert.equal(byId(checks, "providers").state, "warn"); assert.match(byId(checks, "providers").detail, /isn't connected/);
});

test("checks: every sentence a check writes starts capitalised, a joined list of helpers included", async () => {
  // 2026-11-25 (the gh-optional renders): "Not available (Turned off in Paseo). the Overseer, Summaries and AI priority
  // won't run until it is." A list that starts a sentence goes through sentenceStart.
  assert.equal(sentenceStart("the Overseer and Summaries"), "The Overseer and Summaries");
  const ghs: Array<() => Promise<GhResult>> = [async () => ({ login: "demo-dev" }), async () => ({ error: "missing", message: "" }), async () => ({ error: "signed-out", message: "" }), async () => ({ error: "network", message: "" })];
  const catalogs = [catalog(true, true), catalog(false, true), catalog("Turned off in Paseo", true), catalog(false, false), catalog("Still loading", "Turned off in Paseo")];
  const uses: Array<Record<string, string[]>> = [{ claude: ["the Overseer", "Summaries", "AI priority"] }, { claude: ["the Overseer"], codex: ["AI priority"] }, { codex: ["the Overseer", "Summaries"] }, {}];
  const tools = [{ config: { daemon: { mcp: { enabled: true } } }, nativeAgents: 3, hookError: null }, { config: { daemon: { mcp: { enabled: false } } }, nativeAgents: 0, hookError: "x" }];
  let seen = 0;
  for (const gh of ghs) for (const c of catalogs) for (const use of uses) for (const t of tools) {
    const { checks } = await new ReadinessChecks(deps({ gh, catalog: async () => c, use: async () => use, tools: async () => t as never })).run();
    for (const row of checks) for (const text of [row.detail, row.fix?.text ?? ""]) {
      seen++;
      assert.doesNotMatch(text, /^[a-z]|[.!?] [a-z]/, `${row.id}: ${text}`);
    }
  }
  assert.ok(seen > 100);
});

test("checks: tools through the bridge, blocked by config, not seen yet, and hooks that failed", async () => {
  let tools = byId((await new ReadinessChecks(deps({ tools: async () => ({ config: { daemon: { mcp: { enabled: false } } }, nativeAgents: 0, hookError: null }) })).run()).checks, "tools");
  assert.equal(tools.state, "warn"); assert.match(tools.detail, /Paseo's MCP is off/); assert.match(tools.fix!.command!, /"mcp": \{ "enabled": true \}/);

  tools = byId((await new ReadinessChecks(deps({ tools: async () => ({ config: { agents: { providers: { claude: { paseoTools: { disabledTools: ["follow_merge"] } } } } }, nativeAgents: 2, hookError: null }) })).run()).checks, "tools");
  assert.equal(tools.state, "warn"); assert.match(tools.detail, /off for Claude/);

  // Before the first agent there's nothing to check or do: no row at all (the normal fresh state).
  assert.equal((await new ReadinessChecks(deps({ tools: async () => ({ config: null, nativeAgents: 0, hookError: null }) })).run()).checks.find(c => c.id === "tools"), undefined);

  const checks = (await new ReadinessChecks(deps({ tools: async () => ({ config: null, nativeAgents: 1, hookError: "x" }) })).run()).checks;
  assert.equal(byId(checks, "hooks").state, "warn");
  assert.equal(checksSummary(checks).line, "Ready, with 1 note");
});

test("checks: cached for a minute and run on demand only; Check again skips the cache", async () => {
  let calls = 0; let now = 1_000_000;
  const checks = new ReadinessChecks(deps({ gh: async () => { calls++; return { login: "demo-dev" }; }, now: () => now }));
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
  const settingsRpcs = new Set([setFollowSettingsRpc.name, saveReviewersRpc.name, setPrWorkflowRpc.name, setUpdatesRpc.name]);
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

test("shipping sits between defaults and reviewers; the tour is its own last step", async () => {
  const { ONBOARDING_STEPS } = await import("../shared/onboarding");
  assert.deepEqual([...ONBOARDING_STEPS], ["intro", "checks", "defaults", "shipping", "reviewers", "updates", "helpers", "tour"]);
});

test("updates step: writes what Settings → General writes; a fresh install's setup consents to automatic updates", async () => {
  const { updatesConsent } = await import("../shared/onboarding");
  assert.ok(setUpdatesRpc.input.safeParse({ mode: "auto" }).success);
  assert.ok(setUpdatesRpc.input.safeParse({ channel: "beta" }).success);
  const fresh = { install: "fresh" as const, settled: false };
  assert.equal(updatesConsent({ ...fresh, action: "step", from: "updates", to: "helpers" }), true, "Continue past the step");
  assert.equal(updatesConsent({ ...fresh, action: "step", from: "updates", to: "reviewers" }), false, "Back");
  assert.equal(updatesConsent({ ...fresh, action: "step", from: "reviewers", to: "updates" }), false, "arriving");
  assert.equal(updatesConsent({ ...fresh, action: "skip", from: "intro", to: null }), true, "Skip setup");
  assert.equal(updatesConsent({ ...fresh, action: "finish", from: "tour", to: null }), true);
  assert.equal(updatesConsent({ install: "existing", settled: false, action: "skip", from: "updates", to: null }), false, "existing installs never");
  assert.equal(updatesConsent({ install: "existing", settled: false, action: "step", from: "updates", to: "helpers" }), false);
  assert.equal(updatesConsent({ install: "fresh", settled: true, action: "skip", from: "intro", to: null }), false, "a restarted setup never");
  const flow = await readFile(new URL("../client/updates.tsx", import.meta.url), "utf8");
  assert.match(flow, /export function UpdatesStep[\s\S]*setUpdatesRpc/);
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

test("every setup step has something to do: GitHub-only steps go without the GitHub CLI, Updates without npm", () => {
  const all = ["intro", "checks", "defaults", "shipping", "reviewers", "updates", "helpers", "tour"];
  // Not known yet keeps every step (unknown is not off).
  assert.deepEqual(setupSteps({ github: null, repos: null, npm: null }), all);
  assert.deepEqual(setupSteps({ github: false, repos: null, npm: true }), ["intro", "checks", "defaults", "updates", "helpers", "tour"]);
  // Signed in, but no repository seen yet: nothing to pick for shipping; reviewers still have a default to set.
  assert.deepEqual(setupSteps({ github: true, repos: 0, npm: true }), ["intro", "checks", "defaults", "reviewers", "updates", "helpers", "tour"]);
  assert.deepEqual(setupSteps({ github: true, repos: 3, npm: false }), ["intro", "checks", "defaults", "shipping", "reviewers", "helpers", "tour"]);
  // A flow saved on a step this host doesn't show resumes on the next one that is.
  const steps = setupSteps({ github: false, repos: null, npm: false });
  assert.equal(shownStep("shipping", steps), "helpers");
  assert.equal(shownStep("defaults", steps), "defaults");
  // No provider in Paseo: no helper to pick a model for.
  assert.deepEqual(setupSteps({ github: false, repos: null, npm: false, providers: false }), ["intro", "checks", "defaults", "tour"]);
  assert.equal(providersReady([{ id: "providers", label: "Agents", state: "warn", detail: "", fix: null }]), false);
  assert.equal(providersReady([{ id: "provider-codex", label: "Codex", state: "pending", detail: "", fix: null }]), null);
  assert.equal(providersReady([{ id: "provider-codex", label: "Codex", state: "ok", detail: "", fix: null }]), true);
});

test("checks: a provider Paseo is still loading, or lists but can't reach yet, is never \"no provider\"", () => {
  const slow = providerChecks({ providers: [{ id: "codex", label: "Codex", available: false, reason: "Timed out initializing Codex app-server" }, { id: "claude", label: "Claude", available: false, reason: "Not installed" }], error: null }, { claude: ["the Overseer"] });
  assert.equal(slow.find(r => r.id === "providers"), undefined);
  assert.equal(slow.find(r => r.id === "provider-codex")?.state, "pending");
  const rows = providerChecks({ providers: [{ id: "claude", label: "Claude", available: false, reason: "Still loading" }, { id: "codex", label: "Codex", available: false, reason: "Not installed" }], error: null }, { claude: ["the Overseer"] });
  assert.equal(rows.find(r => r.id === "providers"), undefined);
  assert.equal(rows.find(r => r.id === "provider-claude")?.state, "pending");
  assert.notEqual(checksSummary(rows).state, "fail");
});

test("checks: with no provider at all, the Agents row stands alone, even for providers no helper uses", () => {
  const rows = providerChecks({ providers: [{ id: "claude", label: "Claude", available: false, reason: "Not installed" }, { id: "codex", label: "Codex", available: false, reason: "Not installed" }], error: null }, { claude: ["the Overseer"] });
  assert.deepEqual(rows.map(r => r.id), ["providers"]);
});

test("checks: another provider runs the helpers, so a missing Claude only costs AI priority and never reads as broken", () => {
  const catalog = { providers: [{ id: "claude", label: "Claude", available: false, reason: "Not installed" }, { id: "codex", label: "Codex", available: false, reason: "Not installed" }, { id: "acme", label: "Acme agent", available: true, reason: null }], error: null };
  const rows = providerChecks(catalog, { claude: ["AI priority"], acme: ["the Overseer", "Summaries"] });
  const claude = rows.find(r => r.id === "provider-claude")!;
  assert.equal(claude.state, "off");
  assert.match(claude.detail, /^Not installed\. Optional: AI priority runs only on Claude Code, Codex, OpenCode or Pi\.$/);
  // AI priority can't move to Acme, so the fix never offers to.
  assert.doesNotMatch(claude.fix?.text ?? "", /switch/i);
  assert.equal(checksSummary(rows).state, "ok");
  // A helper that can move still makes it a thing to fix, and only that helper is offered the switch.
  const mixed = providerChecks(catalog, { claude: ["the Overseer", "AI priority"], acme: ["Summaries"] }).find(r => r.id === "provider-claude")!;
  assert.equal(mixed.state, "fail");
  assert.match(mixed.fix?.text ?? "", /Or switch the Overseer to Acme agent in Settings → Agents\./);
});
