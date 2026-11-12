import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../shared/legacy.ts";

/**
 * The one env builder for every harness script that spawns a Paseo daemon, the Paseo CLI or a plugin
 * (scripts/check-*.mjs, screenshots, scale). Everything a daemon's plugins could write as "the user" lands inside the
 * temp root: HOME, XDG_CONFIG_HOME, PASEO_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME. The running session's own variables
 * (Paseo agent ids and password, Claude/Codex session ids and config dirs, Follow-up's) are stripped, so a check run
 * from inside a live agent can't reach that agent's real account.
 *
 * 2026-11-10: a check script that built this env by hand missed CLAUDE_CONFIG_DIR; its daemon's Follow-up installed
 * hooks into the real account's settings.json. tests/harness-env.test.ts fails when a check script spawns without it.
 *
 * `set` adds or overrides variables (PASEO_DAEMON_URL, PATH, NODE_OPTIONS…); it can't move an isolated dir outside
 * the root. `strip` removes extra keys.
 *
 * 2026-11-11: dictation and voice mode are off by default. A fresh PASEO_HOME made every harness daemon download and
 * bzip2-unpack the sherpa-onnx speech model; harness-slot exports these as "false", but the session-key strip drops
 * them, so they're set here. A caller's `set` wins.
 *
 * 2026-11-11: FOLLOW_UP_GITHUB_API defaults to a closed local port, so a harness daemon never reads the real
 * api.github.com with whatever token the host has. A script that wants GitHub sets it (scripts/fake-github.mjs).
 *
 * 2026-11-12: a realistic scale run's ranker shelled out to the host's real `mcpproxy` (Linear and Slack reads as the
 * developer); it failed only because the harness HOME had no proxy config. Every tool the plugin, its AI jobs or a
 * daemon provider could reach on the host (STUBBED_TOOLS) resolves to a stub in <root>/.harness-stubs that exits 127.
 * The stubs sit after any PATH entries inside the root (a script's own fake gh or mcpproxy still wins) and before the
 * host's dirs. The Paseo CLI stays real. tests/harness-env.test.ts fails when one resolves outside the root.
 * `real` keeps named tools unstubbed: only the opt-in live-model check (check-wait, `claude`) passes it.
 *
 * 2026-11-12: a phone render showed the VM's real hostname in Paseo's header (Paseo labels its host with os.hostname(),
 * with no setting to override it), and renders go into this public repo's PRs and README. Every harness process
 * preloads scripts/harness-hostname.cjs (first on NODE_OPTIONS, after a caller's set and strip), so os.hostname() and
 * HOSTNAME read HARNESS_HOST. tests/harness-env.test.ts fails when a harness daemon can read the real one; the
 * screenshot run fails a shot whose page text contains it.
 */
export const STUBBED_TOOLS = ["mcpproxy", "gh", "gt", "gcloud", "claude", "codex"];
/**
 * The stubbed tools that are also Paseo agent providers, by provider id. 2026-11-12: with codex stubbed but its provider
 * on, a browser's provider refresh wrote to the dead stub and 0.15.4's worker crashed on the EPIPE, so every shot after
 * the first landed on the welcome screen. harnessConfig turns off exactly the providers whose tool is stubbed.
 */
export const PROVIDER_TOOLS = { claude: "claude", codex: "codex" };
/** The tools a run stubs: all of STUBBED_TOOLS but the `real` ones. One list for the stubs and the providers. */
export const stubbedTools = (real = []) => STUBBED_TOOLS.filter(t => !real.includes(t));
export const HARNESS_DEFAULTS = { PASEO_DICTATION_ENABLED: "false", PASEO_VOICE_MODE_ENABLED: "false", FOLLOW_UP_GITHUB_API: "http://127.0.0.1:9" };
/** The host name every harness process reports (os.hostname(), HOSTNAME, Paseo's host label). */
export const HARNESS_HOST = "dev-box";
const HOSTNAME_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "harness-hostname.cjs");
export const SESSION_KEYS = new RegExp(`^(PASEO_|CODEX_|${ENV_PREFIX}|${LEGACY_ENV_PREFIX})|^CLAUDE_(CONFIG_DIR|SESSION_ID|PROJECT_DIR|CODE_ENTRYPOINT|CODE_SSE_PORT)$|^CLAUDECODE$`);
const ISOLATED = ["HOME", "XDG_CONFIG_HOME", "PASEO_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

export function harnessEnv(root, { home = join(root, "home"), paseoHome = home, set = {}, strip = [], base = process.env, real = [] } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !SESSION_KEYS.test(key) && !strip.includes(key)) env[key] = value;
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: paseoHome, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") }, HARNESS_DEFAULTS, set);
  for (const key of strip) delete env[key];
  Object.assign(env, { HOSTNAME: HARNESS_HOST, HARNESS_HOSTNAME: HARNESS_HOST });
  env.NODE_OPTIONS = [`--require "${HOSTNAME_PRELOAD}"`, env.NODE_OPTIONS].filter(Boolean).join(" ");
  const top = resolve(root);
  env.PATH = stubbedPath(top, env.PATH ?? "", stubbedTools(real));
  for (const key of ISOLATED) {
    const r = relative(top, resolve(env[key]));
    if (r.startsWith("..") || isAbsolute(r)) throw new Error(`harnessEnv: ${key}=${env[key]} is outside the harness root ${top}`);
  }
  return env;
}

/**
 * The one config.json for every harness daemon (scripts/check-*.mjs, screenshots, scale, poll-cost, preview): local
 * listen, no relay or browser tools, and every provider whose tool is stubbed turned off. Pass the same `real` as to
 * harnessEnv (check-wait keeps claude, so its provider stays on). `mcp` injects Paseo's agent MCP; `webUi` serves the
 * web app; `extra` adds top-level keys (plugins…). tests/harness-env.test.ts fails when a script writes its own.
 */
export function harnessConfig({ port, mcp = false, webUi = false, real = [], extra = {} }) {
  const off = stubbedTools(real).filter(t => t in PROVIDER_TOOLS).map(t => [PROVIDER_TOOLS[t], { enabled: false }]);
  return {
    pluginsEnabled: true,
    daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: mcp ? { enabled: true, injectIntoAgents: true } : { enabled: false }, browserTools: { enabled: false } },
    ...(webUi ? { features: { webUi: { enabled: true } } } : {}),
    agents: { providers: Object.fromEntries(off) },
    ...extra,
  };
}

/**
 * The lines of a harness daemon's log that say its worker died: an uncaught exception, or the supervisor restarting a
 * crashed worker. A browser run checks this after each shot and fails with the line, rather than timing out later on
 * the welcome screen a restart leaves behind.
 */
export function daemonCrashes(log) {
  return log.split("\n").filter(l => /Uncaught exception|Worker crashed|Restarting worker/.test(l)).map(l => {
    try { const d = JSON.parse(l); return `${d.msg}${d.err?.message ? `: ${d.err.message}` : ""}`; } catch { return l.trim(); }
  });
}

/** PATH with the stub dir after the entries inside the root and before everything else. */
function stubbedPath(top, path, tools) {
  const stubs = join(top, ".harness-stubs");
  mkdirSync(stubs, { recursive: true });
  rmSync(stubs, { recursive: true, force: true }); mkdirSync(stubs, { recursive: true });
  for (const tool of tools) writeFileSync(join(stubs, tool), `#!/bin/sh\necho "harness: ${tool} is stubbed; a harness run never reaches the host's real ${tool} (scripts/harness-env.mjs)" >&2\nexit 127\n`, { mode: 0o755 });
  const entries = path.split(delimiter).filter(e => e && e !== stubs);
  const inside = e => { const r = relative(top, resolve(e)); return !r.startsWith("..") && !isAbsolute(r); };
  return [...entries.filter(inside), stubs, ...entries.filter(e => !inside(e))].join(delimiter);
}

/** For scripts that run the daemon in-process: make process.env exactly `env`. */
export function applyEnv(env, target = process.env) {
  for (const key of Object.keys(target)) if (!(key in env)) delete target[key];
  Object.assign(target, env);
}
