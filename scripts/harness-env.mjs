import { join, relative, isAbsolute, resolve } from "node:path";

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
 */
export const SESSION_KEYS = /^(PASEO_|CODEX_|FOLLOW_THROUGH_|FOLLOW_UP_)|^CLAUDE_(CONFIG_DIR|SESSION_ID|PROJECT_DIR|CODE_ENTRYPOINT|CODE_SSE_PORT)$|^CLAUDECODE$/;
const ISOLATED = ["HOME", "XDG_CONFIG_HOME", "PASEO_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

export function harnessEnv(root, { home = join(root, "home"), paseoHome = home, set = {}, strip = [], base = process.env } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !SESSION_KEYS.test(key) && !strip.includes(key)) env[key] = value;
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PASEO_HOME: paseoHome, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") }, set);
  for (const key of strip) delete env[key];
  const top = resolve(root);
  for (const key of ISOLATED) {
    const r = relative(top, resolve(env[key]));
    if (r.startsWith("..") || isAbsolute(r)) throw new Error(`harnessEnv: ${key}=${env[key]} is outside the harness root ${top}`);
  }
  return env;
}

/** For scripts that run the daemon in-process: make process.env exactly `env`. */
export function applyEnv(env, target = process.env) {
  for (const key of Object.keys(target)) if (!(key in env)) delete target[key];
  Object.assign(target, env);
}
