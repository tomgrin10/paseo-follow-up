/**
 * What Follow-up gives an agent on each provider (an-agent-on-any-provider-gets-follow-up): one capability model,
 * read by every feature instead of its own provider check. Paseo runs agents on many providers (Claude Code, Codex,
 * OpenCode, Pi, Oh My Pi, Copilot, Cursor, Kimi, Kiro, any ACP agent); every feature works on each one, and where a
 * provider can't give what a feature needs, it says so in one line.
 *
 * - Tools: every provider. Paseo serves plugin tools through its agent MCP to any provider that takes MCP servers.
 * - Instructions: Claude Code and Codex through the hook (or the system prompt on Paseo 0.17); OpenCode, Pi and other
 *   non-ACP providers through the system prompt (appendSystemPrompt); ACP agents through a tool (Paseo doesn't pass a
 *   plugin's system prompt to them yet): `follow_session_instructions`, which every tool description points at.
 * - Turn-end checks (the sync, needs_you and due-task reminders): Claude Code and Codex through the Stop hook; every
 *   other provider through Paseo's turn-end event (server/turn-end.ts): one message, only when something is due.
 * - Wait: every provider with a shell tool. Claude Code backgrounds the command itself; any other provider runs a
 *   command that detaches itself (server/wait-jobs.ts).
 * - Read-only jobs (a job that reads words other people wrote, sources-are-read-only): only where the provider itself
 *   guarantees the job has no tools. Claude Code (the job guard), Codex (read-only sandbox, no shell) and Pi
 *   (`--no-tools`) through their CLIs; OpenCode through a session whose every permission is denied. Nothing else
 *   guarantees it, so such a job never runs there.
 */

/** How a read-only job is guaranteed on a provider: its own CLI with no tools, or a Paseo session with every tool denied. */
export type JobGuard = "cli" | "session";
export type ProviderCaps = {
  /** Follow-up's hook is installed in this provider (server/agent-hooks.ts). */
  hooks: boolean;
  /** How Follow-up's instructions reach a session. */
  instructions: "hook" | "system-prompt" | "tool";
  /** Who runs the turn-end checks. */
  turnEnd: "hook" | "event";
  /** How Wait's command goes to the background: the provider's own background Bash, or a command that detaches itself. */
  wait: "background-bash" | "detached";
  /** How a read-only job is guaranteed here; null: it can't be, so a job that reads other people's words never runs here. */
  guard: JobGuard | null;
};

/** Providers Follow-up installs its hook into (server/agent-hooks.ts: Claude Code's settings.json, Codex's hooks.json). */
export const HOOK_PROVIDERS = ["claude", "codex"] as const;
/** Providers whose own CLI runs a one-shot job with no tools at all (server/ai-jobs.ts defaultRunner). */
export const CLI_GUARD_PROVIDERS = ["claude", "codex", "pi"] as const;
/** Providers whose Paseo session takes a permission rule denying every tool (server/job-agent.ts lockedConfig). */
export const SESSION_GUARD_PROVIDERS = ["opencode"] as const;
/** Paseo 0.17.4's ACP providers: their sessions don't take a plugin's system prompt. */
export const ACP_PROVIDERS = ["copilot", "cursor", "kimi", "kiro", "trae", "acp"] as const;

const has = (list: readonly string[], id: string) => list.includes(id);
export const hasHooks = (provider: string) => has(HOOK_PROVIDERS, provider);

type ProviderConfig = { agents?: { providers?: Record<string, { extends?: unknown } | null | undefined> } } | null | undefined;
/**
 * Whether Paseo runs this provider over ACP: one of its built-in ACP providers, or a provider in Paseo's config whose
 * `extends` chain reaches one (a generic ACP agent the developer added, under any id they chose). Decided from the
 * config, never from a list of ids alone.
 */
export function isAcp(provider: string, config?: ProviderConfig): boolean {
  const custom = config?.agents?.providers ?? {};
  const seen = new Set<string>();
  for (let id: unknown = provider; typeof id === "string" && !seen.has(id); id = custom[id]?.extends) {
    if (has(ACP_PROVIDERS, id)) return true;
    seen.add(id);
  }
  return false;
}

/**
 * The one capability model. `acp` overrides the config lookup when the caller already knows (Settings' catalog). A
 * custom provider id the developer added is guarded only when it *is* one of the guarded providers: an `extends`
 * chain can point at a different command, so nothing is assumed from it.
 */
export function providerCaps(provider: string, opts: { config?: ProviderConfig; acp?: boolean } = {}): ProviderCaps {
  const hooks = hasHooks(provider);
  const acp = opts.acp ?? isAcp(provider, opts.config);
  return {
    hooks,
    instructions: hooks ? "hook" : acp ? "tool" : "system-prompt",
    turnEnd: hooks ? "hook" : "event",
    wait: provider === "claude" ? "background-bash" : "detached",
    guard: has(CLI_GUARD_PROVIDERS, provider) ? "cli" : has(SESSION_GUARD_PROVIDERS, provider) ? "session" : null,
  };
}
/** Whether a job that reads other people's words can run on this provider (sources-are-read-only). */
export const guardedProvider = (provider: string) => providerCaps(provider).guard !== null;

const list = (names: string[], and = "and") => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;
/** The guarded providers' names, for "Install …" when none is there. */
const GUARDED_NAMES = ["Claude Code", "Codex", "OpenCode", "Pi"];
/** The guarded providers in one phrase, for every line that says where a read-only job runs. */
export const GUARDED_PHRASE = list(GUARDED_NAMES, "or");

type NoteProvider = { id: string; label: string; available: boolean; reason?: string | null; acp?: boolean };

/**
 * What to do to run a job that reads other people's words, from what Paseo has: use a guarded provider that is there,
 * turn one on when Paseo has it turned off, install one otherwise. Never "pick" a provider the developer can't pick.
 */
export function guardAction(providers: readonly NoteProvider[]): string {
  const guarded = providers.filter(p => guardedProvider(p.id));
  const ready = guarded.filter(p => p.available).map(p => p.label);
  if (ready.length) return `Use ${list(ready, "or")}`;
  const off = guarded.filter(p => /turned off/i.test(p.reason ?? "")).map(p => p.label);
  if (off.length) return `Turn on ${list(off, "or")} in Paseo`;
  return `Install ${list(GUARDED_NAMES, "or")}`;
}

/**
 * Settings → Agents' one block under the helper rows: only what a provider the developer has can't do, at most two
 * short lines. ACP agents read Follow-up's instructions through a tool (Paseo doesn't pass a plugin's system prompt to
 * them). `summariesOn` is the provider Summaries runs on: off a guarded provider it leaves out linked items, and
 * Compass and Ask read nothing (sources-are-read-only). Why AI priority can't run is on its row. Empty when every
 * feature works.
 */
export function providerNotes(providers: readonly NoteProvider[], summariesOn: string | null): string[] {
  const acp = providers.filter(p => p.available && !hasHooks(p.id) && (p.acp ?? isAcp(p.id))).map(p => p.label);
  const needs = summariesOn && !guardedProvider(summariesOn) ? ["Summaries' linked issues", "Compass", "Ask"] : [];
  return [
    acp.length ? `Paseo doesn't pass Follow-up's instructions to ${list(acp)} yet, so ${acp.length > 1 ? "they read them" : "it reads them"} through a tool at the start of each session.` : null,
    needs.length ? `${list(needs)} read other people's words, so they run only where Follow-up can take every tool away. ${guardAction(providers)} for Summaries to use them.` : null,
  ].filter((x): x is string => !!x);
}
