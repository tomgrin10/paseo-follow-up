import { z } from "zod";
import { ROLE_INFO, guardedProvider, needsGuard, providerName, providerSettling as unsettled, type AgentRole } from "./agent-settings";
import { GITHUB_ADDS, GITHUB_CLI_URL, GITHUB_LOGIN_COMMAND } from "./github-setup";

/**
 * Getting started (1.4.0-beta.10). A first-run setup that takes a fresh install from "what is this?" to a configured
 * Follow-up in about two minutes. Pure, so install detection, the offer, the checks' copy and resume are testable.
 *
 * Every choice the flow offers writes through the RPC or settings document the Settings screen already uses
 * (see `CHOICE_WRITES`); the flow keeps only its own progress in `plugin-data/follow-up/onboarding.json`.
 */

export const ONBOARDING_STEPS = ["intro", "checks", "defaults", "shipping", "reviewers", "updates", "helpers", "tour"] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export const isStep = (v: unknown): v is OnboardingStep => typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);

/**
 * What this host has, for the steps that only mean something with it. `null` is not known yet, which keeps the step
 * (unknown is not off, invariant 7).
 */
export type StepFacts = { github: boolean | null; repos: number | null; npm: boolean | null; providers?: boolean | null };
/**
 * The steps a developer walks on this host (every-setup-step-has-something-to-do): without the GitHub CLI signed in
 * there's no PR to ship or review, so Shipping and Reviewers go; with no repository seen yet Shipping has nothing to
 * pick; a copy not installed from npm updates from its checkout, so Updates goes; with no provider in Paseo there's no
 * helper to pick a model for, so Helper agents goes (the checks step says what to set up). Everything a skipped step
 * sets stays in Settings.
 */
export function setupSteps(facts: StepFacts): OnboardingStep[] {
  return ONBOARDING_STEPS.filter(step => {
    if (step === "shipping") return facts.github !== false && facts.repos !== 0;
    if (step === "reviewers") return facts.github !== false;
    if (step === "updates") return facts.npm !== false;
    if (step === "helpers") return facts.providers !== false;
    return true;
  });
}
/** Whether Paseo has a provider ready, from the checks: the "Agents" row means none; any ready provider means yes. */
export function providersReady(checks: readonly Check[] | null | undefined): boolean | null {
  if (!checks) return null;
  if (checks.some(c => c.id === "providers" && c.state !== "pending")) return false;
  return checks.some(c => c.id.startsWith("provider-") && c.state === "ok") ? true : null;
}
/** Where a resumed or Back-ed flow lands when its saved step isn't shown here: the next one that is. */
export function shownStep(step: OnboardingStep, steps: readonly OnboardingStep[]): OnboardingStep {
  if (steps.includes(step)) return step;
  const at = ONBOARDING_STEPS.indexOf(step);
  return steps.find(s => ONBOARDING_STEPS.indexOf(s) > at) ?? steps.at(-1) ?? step;
}

/**
 * - `fresh`: no Follow-up data on this host when the worker first started with onboarding.
 * - `existing`: Follow-up ran here before (state, inbox, reviewers or agent settings on disk). Never forced on them.
 */
export const INSTALL_KINDS = ["fresh", "existing"] as const;
export type InstallKind = typeof INSTALL_KINDS[number];
/**
 * - `new`: fresh install, not opened yet. Home shows the flow.
 * - `active`: in progress (also after "Set up Follow-up again"). Home shows the flow at `step`.
 * - `done` / `skipped`: finished or dismissed. Home is Home.
 * - `idle`: an existing install that hasn't asked for it. Home may show the quiet offer.
 */
export const ONBOARDING_STATUSES = ["new", "active", "done", "skipped", "idle"] as const;
export type OnboardingStatus = typeof ONBOARDING_STATUSES[number];

export const onboardingFileSchema = z.object({
  version: z.literal(1),
  install: z.enum(INSTALL_KINDS),
  status: z.enum(ONBOARDING_STATUSES),
  step: z.enum(ONBOARDING_STEPS).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string().nullable().default(null),
  /** When the existing-install offer was first shown; it disappears a day later. */
  offeredAt: z.string().nullable().default(null),
  offerDismissed: z.boolean().default(false),
  /** When a fresh install first finished or skipped setup. Auto-send is held until then; a later restart doesn't hold it again. */
  settledAt: z.string().nullable().default(null),
});
export type OnboardingFile = z.infer<typeof onboardingFileSchema>;

/** What the client sees. `show` is the flow in place of Home; `offer` is the existing-install line. */
export const onboardingViewSchema = z.object({
  install: z.enum(INSTALL_KINDS),
  status: z.enum(ONBOARDING_STATUSES),
  step: z.enum(ONBOARDING_STEPS),
  show: z.boolean(),
  offer: z.boolean(),
  /** Auto-send waits until setup is finished or skipped (fresh install only). */
  holdsAutoSends: z.boolean().default(false),
});
export type OnboardingView = z.infer<typeof onboardingViewSchema>;

/** Files that only exist once Follow-up has run on this host. Any one of them means an existing install. */
export const EXISTING_INSTALL_FILES = ["state.json", "inbox.json", "reviewers.json", "agents.json", "brief.json"] as const;

/** An existing install is one with any Follow-up data already on disk. */
export function classifyInstall(present: readonly string[]): InstallKind {
  return present.some(name => (EXISTING_INSTALL_FILES as readonly string[]).includes(name)) ? "existing" : "fresh";
}

export function initialOnboarding(install: InstallKind, now: Date): OnboardingFile {
  return { version: 1, install, status: install === "fresh" ? "new" : "idle", step: null, createdAt: now.toISOString(), updatedAt: null, offeredAt: null, offerDismissed: false, settledAt: null };
}

/**
 * Auto-send waits on a fresh install until setup is finished or skipped, so nothing goes to an agent before the
 * developer has seen the switch. Existing installs, and a fresh one that already settled, keep sending as before.
 */
export function holdsAutoSends(file: OnboardingFile | null): boolean {
  return !!file && file.install === "fresh" && !file.settledAt && (file.status === "new" || file.status === "active");
}

export const OFFER_MS = 24 * 3600_000;

/** The existing-install offer: once, for a day from when it first showed, until dismissed or taken. */
export function offerVisible(file: OnboardingFile, now: number): boolean {
  if (file.install !== "existing" || file.status !== "idle" || file.offerDismissed) return false;
  return !file.offeredAt || now - Date.parse(file.offeredAt) < OFFER_MS;
}

/**
 * "Set up Follow-up again" in Settings → General: what it
 * says and does for where setup stands. `resume` opens the flow where it was left instead of from the top.
 */
export type SetupEntry = { label: string; hint: string; line: string; action: string; resume: boolean };
const SETUP_WHAT = "Checks the helper agents and GitHub (optional), and shows what Follow-up does on its own. About two minutes.";
export function setupEntry(view: Pick<OnboardingView, "status" | "step"> | null | undefined): SetupEntry {
  const label = "Set up Follow-up again";
  switch (view?.status) {
    case "new": case "active": {
      const at = `Step ${ONBOARDING_STEPS.indexOf(view.step) + 1} of ${ONBOARDING_STEPS.length}`;
      return { label: "Continue setup", hint: `In progress, ${at.toLowerCase()}. ${SETUP_WHAT}`, line: `In progress, ${at.toLowerCase()}`, action: "Continue", resume: true };
    }
    case "done": return { label, hint: `Done. Run it again to recheck GitHub and the helper agents, or to change what Follow-up does on its own.`, line: "Finished. Run it again any time", action: "Open setup", resume: false };
    case "skipped": return { label, hint: `Skipped. ${SETUP_WHAT}`, line: "Skipped. About two minutes", action: "Open setup", resume: false };
    default: return { label, hint: SETUP_WHAT, line: "About two minutes", action: "Open setup", resume: false };
  }
}

export function onboardingView(file: OnboardingFile, now: number): OnboardingView {
  return { install: file.install, status: file.status, step: file.step ?? "intro", show: file.status === "new" || file.status === "active", offer: offerVisible(file, now), holdsAutoSends: holdsAutoSends(file) };
}

export const ONBOARDING_ACTIONS = ["start", "step", "finish", "skip", "restart", "dismiss-offer"] as const;
export type OnboardingAction = typeof ONBOARDING_ACTIONS[number];

/** The flow's state machine. Pure: the server stores what this returns. */
export function applyOnboarding(file: OnboardingFile, action: OnboardingAction, step: OnboardingStep | null, now: Date): OnboardingFile {
  const at = now.toISOString();
  const next = { ...file, updatedAt: at };
  switch (action) {
    case "start": return { ...next, status: "active", step: file.status === "active" ? file.step ?? "intro" : "intro" };
    case "step": return { ...next, status: file.status === "new" || file.status === "idle" ? "active" : file.status, step: step ?? file.step };
    case "finish": return { ...next, status: "done", settledAt: file.settledAt ?? at };
    case "skip": return { ...next, status: "skipped", offerDismissed: true, settledAt: file.settledAt ?? at };
    // "Set up Follow-up again" from Settings or ⌘K: always from the start, any install kind.
    case "restart": return { ...next, status: "active", step: "intro", offerDismissed: true };
    case "dismiss-offer": return { ...next, offerDismissed: true };
  }
}

// ---------- readiness checks ----------

export const CHECK_STATES = ["ok", "warn", "fail", "pending", "off"] as const;
export type CheckState = typeof CHECK_STATES[number];
export const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(CHECK_STATES),
  detail: z.string(),
  /** How to fix it: a sentence, an optional command to copy, an optional Settings category to open. */
  fix: z.object({ text: z.string(), command: z.string().nullable(), settings: z.string().nullable(), url: z.string().nullable().optional() }).nullable(),
});
export type Check = z.infer<typeof checkSchema>;
export const checksSchema = z.object({ checks: z.array(checkSchema), checkedAt: z.string() });
export type Checks = z.infer<typeof checksSchema>;
const fix = (text: string, command: string | null = null, settings: string | null = null, url: string | null = null) => ({ text, command, settings, ...(url ? { url } : {}) });

/** `gh api user` on the daemon host: its login, or how it failed. */
export type GhResult = { login: string } | { error: "missing" | "signed-out" | "network"; message: string };
export function classifyGhError(error: unknown): GhResult {
  const e = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const message = String(e?.stderr || e?.message || error || "").trim().slice(0, 200);
  if (e?.code === "ENOENT") return { error: "missing", message };
  if (/auth login|not logged|logged in to no|HTTP 401|Bad credentials|authentication|GH_TOKEN/i.test(message)) return { error: "signed-out", message };
  return { error: "network", message };
}
export function ghCheck(r: GhResult): Check {
  const label = "GitHub";
  if ("login" in r) return { id: "gh", label, state: "ok", detail: r.login ? `Signed in as ${r.login}` : "Signed in", fix: null };
  // Optional (works-without-github): never a failure. Without it, everything but GitHub's own parts works.
  const optional = `Optional: everything else works without it. Adds ${GITHUB_ADDS}.`;
  if (r.error === "missing") return { id: "gh", label, state: "off", detail: `The GitHub CLI isn't installed. ${optional}`, fix: fix("To turn it on, install the GitHub CLI on the computer running Paseo, then sign in there. Follow-up picks it up on its own.", GITHUB_LOGIN_COMMAND, null, GITHUB_CLI_URL) };
  if (r.error === "signed-out") return { id: "gh", label, state: "off", detail: `The GitHub CLI isn't signed in. ${optional}`, fix: fix("To turn it on, sign in on the computer running Paseo. Follow-up picks it up on its own.", GITHUB_LOGIN_COMMAND) };
  return { id: "gh", label, state: "warn", detail: `Couldn't reach GitHub${r.message ? `: ${r.message}` : "."}`, fix: fix("Check that computer's network, then check again.") };
}

export type ProviderInfo = { id: string; label: string; available: boolean; reason: string | null };
/** Which providers the helper roles use right now, e.g. { claude: ["Overseer", "Summaries"] }. */
export type ProviderUse = Record<string, string[]>;
const PROVIDER_FIX: Record<string, { text: string; command: string | null }> = {
  claude: { text: "Install Claude Code on the computer running Paseo and sign in.", command: "claude" },
  codex: { text: "Install Codex on the computer running Paseo and sign in.", command: "codex login" },
};
const joinNames = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
/** Text that starts a sentence starts capitalised ("the Overseer, …" after a stop reads "The Overseer, …"). */
export const sentenceStart = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The order rows and switch offers prefer among providers that are there. No provider gets a row for being on this
 * list: a provider no helper uses and that isn't ready isn't shown (an-agent-on-any-provider-gets-follow-up), so a
 * developer with only Pi sees Pi, never Claude and Codex as missing.
 */
const PREFERRED = ["claude", "codex"];
const nameOf = (catalog: { providers: ProviderInfo[] }, id: string) => providerName(id, catalog.providers.find(p => p.id === id)?.label);

/**
 * One row per provider a helper uses (any provider id), plus a quiet row for each other provider that's ready. A
 * provider no helper uses and that isn't there gets no row. A missing provider's fix offers to switch its helpers to
 * one that's ready, preferring Claude, then Codex, then the catalog's order.
 */
export function providerChecks(catalog: { providers: ProviderInfo[]; error: string | null } | null, use: ProviderUse): Check[] {
  if (!catalog || (catalog.error && !catalog.providers.length)) return [{ id: "providers", label: "Helper agents", state: "warn", detail: catalog?.error ?? "Couldn't read Paseo's providers.", fix: fix("Check again in a moment.") }];
  const ready = catalog.providers.filter(p => p.available).map(p => p.id).sort((x, y) => rank(x) - rank(y));
  // A provider Paseo is still checking keeps its row: it may be the one the developer has.
  const checking = catalog.providers.filter(p => !p.available && (p.reason === "Still loading" || unsettled(p))).map(p => p.id);
  const ids = [...new Set([...ready, ...checking, ...Object.keys(use).filter(id => use[id]?.length).sort((x, y) => rank(x) - rank(y))])];
  const rows: Check[] = [];
  const pendingAny = catalog.providers.some(unsettled);
  for (const id of ids) {
    const p = catalog.providers.find(x => x.id === id);
    const label = nameOf(catalog, id);
    const users = use[id] ?? [];
    const usedBy = users.length ? `Used by ${joinNames(users)}.` : "Not used by any helper right now.";
    if (p?.available) { rows.push({ id: `provider-${id}`, label, state: "ok", detail: `Available. ${usedBy}`, fix: null }); continue; }
    if (p?.reason === "Still loading") { rows.push({ id: `provider-${id}`, label, state: "pending", detail: "Paseo is still checking this provider.", fix: fix("Check again in a few seconds.") }); continue; }
    // Installed but not answering yet (a slow start, a timeout): not missing. Never "no provider", never optional.
    if (p && unsettled(p)) { rows.push({ id: `provider-${id}`, label, state: "pending", detail: `Paseo couldn't reach it yet${p.reason ? ` (${p.reason})` : ""}.`, fix: fix("Check again in a moment. If it stays, check it in Paseo's settings.") }); continue; }
    // Paseo's own reason when it gives one ("Not installed", "Turned off in Paseo"), said as the sentence it is.
    const why = p?.reason ? sentenceStart(p.reason) : p ? "Not available" : "Paseo doesn't have it";
    // No provider at all: the one "Agents" row says what to set up, so no provider gets a row of its own (never a second alarm).
    if (!ready.length && !pendingAny) continue;
    if (!users.length) { rows.push({ id: `provider-${id}`, label, state: "off", detail: `${why}. Optional: no helper uses it.`, fix: null }); continue; }
    const setup = PROVIDER_FIX[id] ?? { text: `Set up ${label} on the computer running Paseo, then check again.`, command: null };
    // A job that runs only where it can have no tools (AI priority) never moves to a provider that can't promise that.
    const guarded = users.filter(u => GUARDED_TITLES.includes(u));
    const movable = users.filter(u => !GUARDED_TITLES.includes(u));
    const other = ready.find(x => x !== id && (guarded.length && !movable.length ? guardedProvider(x) : true));
    // Another provider runs everything else and only a read-only job (AI priority) is left on this one: the helpers
    // step already says why it can't run here and what to install, so no row names a provider the developer lacks.
    if (!movable.length && ready.length && !ready.some(guardedProvider)) continue;
    const switchable = guarded.length && other && !guardedProvider(other) ? movable : users;
    rows.push({ id: `provider-${id}`, label, state: "fail", detail: `${why}. ${sentenceStart(joinNames(users))} won't run until it is.`,
      fix: other && switchable.length ? fix(`${setup.text} Or switch ${switchable.length === users.length ? "those helpers" : joinNames(switchable)} to ${nameOf(catalog, other)} in Settings → Agents.`, setup.command, "agents") : fix(setup.text, setup.command) });
  }
  // A provider Paseo is still loading isn't missing: the rows say "still checking" and the step checks again.
  if (rows.some(r => r.state === "pending")) return rows;
  // None at all: Paseo itself has nothing to run agents on yet. Said as the next step, not as a failure of Follow-up.
  if (!ready.length) rows.unshift({ id: "providers", label: "Agents", state: "warn", detail: "Paseo has no agent provider set up yet, so there are no agents to follow and the helper agents can't run.", fix: fix("Set one up in Paseo's settings (Claude Code, Codex or any other provider Paseo runs), then check again.") });
  return rows;
}
const GUARDED_TITLES = (Object.keys(ROLE_INFO) as AgentRole[]).filter(needsGuard).map(r => ROLE_INFO[r].title);
const rank = (id: string) => { const i = PREFERRED.indexOf(id); return i < 0 ? PREFERRED.length : i; };

export type ToolsInput = {
  /** Paseo's config.json (or null when unreadable). */
  config: { daemon?: { mcp?: { enabled?: boolean; injectIntoAgents?: boolean } }; agents?: { providers?: Record<string, { paseoTools?: { enabled?: boolean; disabledTools?: string[] } }> } } | null;
  /** Agents that got Follow-up's tools through Paseo's own MCP since install. */
  nativeAgents: number;
  hookError: string | null;
};
/** Whether Follow-up's tools reach agents: through Paseo's MCP, or a small bridge per agent; and its hooks. */
export function toolsCheck({ config, nativeAgents, hookError }: ToolsInput): Check[] {
  const label = "Agent tools";
  const mcpOff = config?.daemon?.mcp?.enabled === false || config?.daemon?.mcp?.injectIntoAgents === false;
  const blocked = Object.keys(config?.agents?.providers ?? {}).filter(id => { const p = config?.agents?.providers?.[id]?.paseoTools; return p?.enabled === false || !!p?.disabledTools?.some(n => n.startsWith("follow_")); });
  const seen = nativeAgents ? ` Seen on ${nativeAgents} agent${nativeAgents === 1 ? "" : "s"} so far.` : "";
  let row: Check;
  if (mcpOff || blocked.length) {
    const why = mcpOff ? "Paseo's MCP is off" : `Paseo's tools are off for ${joinNames(blocked.map(b => providerName(b)))}`;
    row = { id: "tools", label, state: "warn", detail: `${why}, so each agent gets Follow-up's tools through a small extra process. It works, and uses a little more memory.`,
      fix: mcpOff ? fix("Optional. To serve them through Paseo instead, set this in Paseo's config.json (in Paseo's home folder) and restart Paseo.", `"daemon": { "mcp": { "enabled": true } }`) : fix("Optional. Turn Paseo tools back on for that provider in Paseo's config.json, under agents.providers.") };
  } else if (!nativeAgents) {
    // Nothing to check or do until the first agent starts: no row (every row on the checks step says something).
    return hookError ? [hooksRow(hookError)] : [];
  } else row = { id: "tools", label, state: "ok", detail: `Agents get Follow-up's tools through Paseo.${seen}`, fix: null };
  const rows = [row];
  if (hookError) rows.push(hooksRow(hookError));
  return rows;
}
const hooksRow = (_error: string): Check => ({ id: "hooks", label: "Agent instructions", state: "warn", detail: "Follow-up couldn't add its instructions for every provider. Following still works; agents just aren't reminded to report PRs.", fix: fix("Check your providers' hook settings (Claude Code and Codex have them), then restart Follow-up from Paseo's plugin settings.") });

/** The rows the checks step leads with: the worst state first is the one to fix. */
export function checksSummary(checks: readonly Check[]): { state: CheckState; line: string } {
  const fails = checks.filter(c => c.state === "fail").length;
  const warns = checks.filter(c => c.state === "warn").length;
  if (checks.some(c => c.id === "providers")) return { state: "warn", line: "Set up an agent provider in Paseo to start" };
  if (fails) return { state: "fail", line: warns ? `${fails} to fix, ${warns} to look at` : `${fails} thing${fails === 1 ? "" : "s"} to fix` };
  if (warns) return { state: "warn", line: `Ready, with ${warns} note${warns === 1 ? "" : "s"}` };
  if (checks.some(c => c.state === "pending")) return { state: "pending", line: "Ready so far" };
  return { state: "ok", line: "All set" };
}

// ---------- choices ----------

/**
 * Where each choice is saved: the RPC or settings document (and field) Settings uses for the same control.
 * The client calls exactly these; tests hold them to the Settings screen's own.
 */
export const CHOICE_WRITES = {
  followEvery: { rpc: "follow.set-follow-settings", field: "enable_follow_every" },
  followWorkspace: { rpc: "follow.set-follow-settings", field: "workspace.follow" },
  autoSendDefault: { rpc: "follow.set-follow-settings", field: "enable_auto_sends_default" },
  autoSendWorkspace: { rpc: "follow.set-follow-settings", field: "workspace.enable_auto_sends" },
  reviewers: { rpc: "follow.save-reviewers", field: "reviewers" },
  shipping: { rpc: "follow.set-pr-workflow", field: "setting" },
  overseer: { settings: "display", field: "enable_overseer" },
  ranker: { settings: "display", field: "enable_ranker" },
  trustBypass: { settings: "display", field: "enable_trust_bypass" },
  newSidebarRow: { settings: "display", field: "enable_new_sidebar_row" },
  updatesMode: { rpc: "follow.set-updates", field: "mode" },
  updatesChannel: { rpc: "follow.set-updates", field: "channel" },
} as const;

/**
 * A fresh install's setup is its consent to automatic updates: passing the Updates step without picking, or skipping
 * setup, saves Install automatically (when nothing was chosen yet). An existing install never gets this: its setup
 * shows the mode it already has, and its default stays Tell me.
 */
export function updatesConsent(input: { install: InstallKind; settled: boolean; action: OnboardingAction; from: OnboardingStep | null; to: OnboardingStep | null }): boolean {
  if (input.install !== "fresh" || input.settled) return false;
  if (input.action === "skip" || input.action === "finish") return true;
  if (input.action !== "step" || !input.to) return false;
  const at = ONBOARDING_STEPS.indexOf("updates");
  return input.from === "updates" && ONBOARDING_STEPS.indexOf(input.to) > at;
}

type FollowRow = { id: string; enable_tracking: boolean; enable_auto_sends: boolean; optedOut: boolean };
/**
 * "Send repairs automatically" in setup: the default for new workspaces, and the same switch for each workspace
 * already followed whose value differs (Settings' per-workspace switch). Returns the inputs for set-follow-settings.
 */
export function autoSendWrites(value: boolean, workspaces: readonly FollowRow[]): { enable_auto_sends_default?: boolean; workspace?: { workspaceId: string; enable_auto_sends: boolean } }[] {
  return [{ enable_auto_sends_default: value }, ...workspaces.filter(w => w.enable_tracking && !w.optedOut && w.enable_auto_sends !== value).map(w => ({ workspace: { workspaceId: w.id, enable_auto_sends: value } }))];
}
/** "Choose workspaces": follow or stop following each one whose state differs from what was picked. */
export function followWrites(picked: ReadonlySet<string>, workspaces: readonly FollowRow[]): { workspace: { workspaceId: string; follow: boolean } }[] {
  return workspaces.flatMap(w => {
    const following = w.enable_tracking && !w.optedOut;
    const want = picked.has(w.id);
    return following === want ? [] : [{ workspace: { workspaceId: w.id, follow: want } }];
  });
}
