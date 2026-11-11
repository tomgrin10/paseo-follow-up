import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const { harnessEnv } = await import(resolve("scripts/harness-env.mjs"));

// 2026-11-10: scripts/check-move.mjs built its daemon env by hand, missed CLAUDE_CONFIG_DIR, and the isolated
// daemon's Follow-up installed hooks into the real account's settings. Every check script that spawns a daemon,
// a Paseo CLI or a plugin builds that env with the one shared helper.
// A script that spawns a daemon, or hands a child (the Paseo CLI, a bridge) an env built from the session's.
const handBuilt = /\{\s*\.\.\.process\.env\s*,/;
const spawns = new RegExp(`spawnDaemon\\(|createPaseoDaemon|\\(\\s*["']paseo["']\\s*,|${handBuilt.source}`);
test("every scripts/check-*.mjs (and screenshots, scale-check) that spawns a daemon, CLI or plugin builds its env with harnessEnv", async () => {
  const offenders: string[] = [];
  for (const name of (await readdir("scripts")).filter(n => /^(check-.*|screenshots|scale-check)\.mjs$/.test(n))) {
    const text = await readFile(join("scripts", name), "utf8");
    if (!spawns.test(text)) continue;
    if (!/from ["']\.\/harness-env\.mjs["']/.test(text) || !/harnessEnv\(/.test(text)) offenders.push(name);
    if (handBuilt.test(text)) offenders.push(`${name} (builds a child env from process.env by hand)`);
    if (/delete (\w*[eE]nv|process\.env)(\[key\]|\.(PASEO_|CLAUDE_|CODEX_))/.test(text)) offenders.push(`${name} (hand-rolled deny-list)`);
  }
  assert.deepEqual(offenders, []);
});
test("harnessEnv puts HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and PASEO_HOME inside the temp root and strips session vars", () => {
  const base = { PATH: "/bin", HOME: "/home/real", CLAUDE_CONFIG_DIR: "/home/real/.paseo/zerosub/homes/x", CODEX_HOME: "/home/real/.codex", PASEO_HOME: "/home/real/.paseo", PASEO_AGENT_ID: "a", PASEO_WORKSPACE_ID: "w", CLAUDE_SESSION_ID: "s", CODEX_THREAD_ID: "t", CLAUDECODE: "1", FOLLOW_UP_CLI: "x", ANTHROPIC_API_KEY: "keep" };
  const env = harnessEnv("/tmp/follow-x", { base, set: { PASEO_DAEMON_URL: "ws://127.0.0.1:1/ws" } });
  assert.equal(env.HOME, "/tmp/follow-x/home"); assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/follow-x/home/.claude"); assert.equal(env.CODEX_HOME, "/tmp/follow-x/home/.codex"); assert.equal(env.PASEO_HOME, "/tmp/follow-x/home");
  for (const key of ["PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDECODE", "FOLLOW_UP_CLI"]) assert.equal(env[key], undefined, key);
  assert.equal(env.PASEO_DAEMON_URL, "ws://127.0.0.1:1/ws"); assert.equal(env.ANTHROPIC_API_KEY, "keep"); assert.equal(env.PATH, "/bin");
  assert.throws(() => harnessEnv("/tmp/follow-x", { base, set: { CLAUDE_CONFIG_DIR: "/home/real/.claude" } }), /outside the harness root/);
  assert.throws(() => harnessEnv("/tmp/follow-x", { base, home: "/home/real" }), /outside the harness root/);
});
