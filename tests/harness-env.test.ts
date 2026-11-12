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
  for (const name of (await readdir("scripts")).filter(n => /^(check-.*|screenshots|scale-check|poll-cost)\.mjs$/.test(n))) {
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
  assert.equal(env.PASEO_DAEMON_URL, "ws://127.0.0.1:1/ws"); assert.equal(env.ANTHROPIC_API_KEY, "keep"); assert.equal(env.PATH, "/tmp/follow-x/.harness-stubs:/bin");
  assert.throws(() => harnessEnv("/tmp/follow-x", { base, set: { CLAUDE_CONFIG_DIR: "/home/real/.claude" } }), /outside the harness root/);
  assert.throws(() => harnessEnv("/tmp/follow-x", { base, home: "/home/real" }), /outside the harness root/);
});
test("harnessEnv turns dictation and voice mode off for harness daemons unless the caller sets them", () => {
  // 2026-11-11: each fresh harness PASEO_HOME downloaded and unpacked the speech model; harness-slot's "false" was stripped.
  const base = { PATH: "/bin", PASEO_DICTATION_ENABLED: "true", PASEO_VOICE_MODE_ENABLED: "true" };
  const env = harnessEnv("/tmp/follow-x", { base });
  assert.equal(env.PASEO_DICTATION_ENABLED, "false"); assert.equal(env.PASEO_VOICE_MODE_ENABLED, "false");
  const on = harnessEnv("/tmp/follow-x", { base, set: { PASEO_DICTATION_ENABLED: "true", PASEO_VOICE_MODE_ENABLED: "true" } });
  assert.equal(on.PASEO_DICTATION_ENABLED, "true"); assert.equal(on.PASEO_VOICE_MODE_ENABLED, "true");
  assert.equal(harnessEnv("/tmp/follow-x", { base, strip: ["PASEO_VOICE_MODE_ENABLED"] }).PASEO_VOICE_MODE_ENABLED, undefined);
});
test("a harness daemon never reads the real GitHub: every script that fakes gh for a daemon also serves the HTTPS reads", async () => {
  // 2026-11-11: GitHub reads moved from gh to in-process HTTPS (#116). check-install's fake gh was bypassed, the packed
  // plugin asked api.github.com for example/app and the v2.0.0-rc.3 publish failed in test:install.
  assert.equal(harnessEnv("/tmp/follow-x", { base: { PATH: "/bin", FOLLOW_UP_GITHUB_API: "https://api.github.com" } }).FOLLOW_UP_GITHUB_API, "http://127.0.0.1:9");
  assert.equal(harnessEnv("/tmp/follow-x", { base: {}, set: { FOLLOW_UP_GITHUB_API: "http://127.0.0.1:5" } }).FOLLOW_UP_GITHUB_API, "http://127.0.0.1:5");
  const offenders: string[] = [];
  for (const name of (await readdir("scripts")).filter(n => n.endsWith(".mjs"))) {
    const text = await readFile(join("scripts", name), "utf8");
    const fakesGh = /graphql/.test(text) && /\bbin\b[^\n]*["'](bin\/)?gh["']/.test(text);
    if (fakesGh && /spawnDaemon\(/.test(text) && !/fakeGithub\(|FOLLOW_UP_GITHUB_API/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
test("fakeGithub answers reads through the fixture gh, only with the owner's own token", async () => {
  const { fakeGithub } = await import(resolve("scripts/fake-github.mjs"));
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "fake-github-"));
  const gh = join(dir, "gh");
  await writeFile(gh, `#!/usr/bin/env node\nif (process.env.GH_REPO !== "example/app") { console.error("wrong repo"); process.exit(1); }\nconsole.log(process.argv[3] === "graphql" ? JSON.stringify({ data: { repository: { p0: { number: 1 } } } }) : "[]");\n`); await chmod(gh, 0o700);
  const github = await fakeGithub({ dir, gh });
  try {
    const token = await new Promise<string>((ok, fail) => execFile(github.env.FOLLOW_UP_GH_BIN, ["auth", "token", "--user", "fixture-example"], (e, out) => e ? fail(e) : ok(out.trim())));
    const post = (auth: string, owner = "example") => fetch(`${github.url}/graphql`, { method: "POST", headers: { authorization: `bearer ${auth}` }, body: JSON.stringify({ query: "{}", variables: { owner, name: "app" } }) });
    assert.deepEqual(await (await post(token)).json(), { data: { repository: { p0: { number: 1 } } } });
    assert.equal((await post("fixture-token-other")).status, 401);
    assert.equal((await post("fixture-token-other", "other")).status, 502, "the fixture's own GH_REPO check still runs");
    assert.deepEqual(await (await fetch(`${github.url}/repos/example/app/rules/branches/main`, { headers: { authorization: `bearer ${token}` } })).json(), []);
    assert.match(await (await import("node:fs/promises")).readFile(github.env.GH_ACCOUNT_MAP, "utf8"), /^example fixture-example$/m);
  } finally { await github.close(); await rm(dir, { recursive: true, force: true }); }
});
test("harnessEnv resolves no external tool to a real binary outside the harness root; a script's own fake still wins", async () => {
  // 2026-11-12: the realistic scale run's ranker ran the host's real mcpproxy (Linear and Slack reads as the developer).
  const { STUBBED_TOOLS } = await import(resolve("scripts/harness-env.mjs"));
  const { mkdtemp, writeFile, chmod, rm, access, constants } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(join(tmpdir(), "follow-stubs-"));
  try {
    const which = async (tool: string, path: string) => { for (const d of path.split(":")) { try { await access(join(d, tool), constants.X_OK); return join(d, tool); } catch {} } return null; };
    // The host PATH (with whatever real mcpproxy, gh, claude… it has) and the session's own, as every script passes it.
    const env = harnessEnv(root, { base: process.env, set: { PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH}` } });
    for (const tool of STUBBED_TOOLS) {
      const found = await which(tool, env.PATH);
      assert.ok(found && found.startsWith(root + "/"), `${tool} resolves to ${found}`);
      await assert.rejects(promisify(execFile)(tool, ["--version"], { env }), (e: { code?: number; stderr?: string }) => e.code === 127 && /stubbed/.test(e.stderr ?? ""), tool);
    }
    // A fake inside the root, put first on PATH by the script, still answers.
    const bin = join(root, "bin"); await (await import("node:fs/promises")).mkdir(bin);
    await writeFile(join(bin, "gh"), "#!/bin/sh\necho fake\n"); await chmod(join(bin, "gh"), 0o755);
    const faked = harnessEnv(root, { base: process.env, set: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(await which("gh", faked.PATH), join(bin, "gh"));
    assert.equal(await which("paseo", faked.PATH), await which("paseo", process.env.PATH ?? ""), "the Paseo CLI stays the host's");
    // Only the live-model check opts out, and only of claude.
    const live = harnessEnv(root, { base: process.env, real: ["claude"] });
    assert.ok(!(await which("claude", live.PATH))?.startsWith(root), "real: claude stays the host's");
    assert.ok((await which("mcpproxy", live.PATH))?.startsWith(root), "everything else stays stubbed");
    const optOuts: string[] = [];
    for (const name of (await readdir("scripts")).filter(n => n.endsWith(".mjs") && n !== "harness-env.mjs")) if (/\breal:\s*\[/.test(await readFile(join("scripts", name), "utf8"))) optOuts.push(name);
    assert.deepEqual(optOuts, ["check-wait.mjs"], "only the opt-in live-model check keeps a real tool");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the codex stub keeps `codex app-server` connected, so a daemon's provider refresh never writes into a closed pipe", async () => {
  // 2026-11-12: the stub exited 127, Paseo 0.15.4's provider refresh wrote to it, hit EPIPE and crashed the shots' daemon.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "follow-stubs-"));
  try {
    const env = harnessEnv(root, { base: process.env });
    const child = spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>(done => child.on("exit", code => done(code)));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(child.exitCode, null, "still running after start");
    await new Promise<void>((done, fail) => child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', e => e ? fail(e) : done()));
    child.stdin.end();
    assert.equal(await exited, 0, "ends when the daemon closes its stdin");
  } finally { await rm(root, { recursive: true, force: true }); }
});
