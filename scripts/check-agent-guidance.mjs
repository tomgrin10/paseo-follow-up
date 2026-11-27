// Follow-up's agent guidance on real agents (one-place-for-agent-text, one-turn-end-decision), Paseo 0.17.
//
// Packs Follow-up and installs it into an isolated in-process Paseo daemon (its own PASEO_HOME, HOME, CLAUDE_CONFIG_DIR
// and CODEX_HOME; the agent MCP on), with real Claude (Haiku) and, with --codex, real Codex (its smallest model). For
// each provider, one main agent in its own tracked synthetic workspace (fictional names), and three items:
//   1. instructions  the session's system prompt carries Follow-up's workspace text (FOLLOW_UP_SYSTEM_PROMPT names
//                    `workspace`), SessionStart adds none of it, and the agent quotes its first sentence.
//   2. turn-end      a turn that edits a file without sync_workspace or needs_you gets the Stop hook's block: the
//                    one-line sync reminder (not the whole text) and the needs_you nudge.
//   3. resume        after a plugin reload the session reopens; its transcript holds no second copy of the workspace
//                    text, SessionStart adds none, and the agent still quotes the sentence.
//
// Claude runs as check-wait's does: the real claude CLI reading the developer's credentials from its own config dir,
// read-only (the provider's env, never a copy), settingSources [] and only Follow-up's installed hooks, each through a
// logging shim that records what the hook printed. Codex runs on a harness-only login (~/paseo-harness/logins/codex,
// made once by harness-codex-login.sh), used in place as the Codex agent's CODEX_HOME and never copied; never the live
// ~/.codex. Follow-up's installed hooks.json is mirrored into it for the run (the same shim) and the original put back.
// Without that login the Codex case is skipped with a "no harness login" line. Every JSON-RPC line Paseo writes to
// `codex app-server` is logged through a wrapper around the real codex (thread/start carries developerInstructions).
//
//   HARNESS_PASEO=system ~/paseo-harness/tools/harness-slot node scripts/check-agent-guidance.mjs \
//     [--codex] [--codex-model gpt-6-luna] [--out <dir>]
// Writes report.json, the hook log and the transcripts to --out (default: a temp dir it prints). Real model calls:
// a few cents. Never touches the live daemon, ~/.paseo or a live plugin.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, copyFile, cp } from "node:fs/promises";
import { join, dirname, delimiter, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { harness, onShutdown, waitUntil } from "./harness.mjs";
import { harnessEnv, applyEnv, harnessConfig, harnessDaemonProviders, assertProviderStubsUnused } from "./harness-env.mjs";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const withCodex = process.argv.includes("--codex");
const codexModel = arg("--codex-model", "gpt-6-luna");
const liveClaude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const harnessCodexLogin = join(homedir(), "paseo-harness", "logins", "codex");
const exists = path => access(path).then(() => true, () => false);
if (!await exists(join(liveClaude, ".credentials.json")) && !process.env.ANTHROPIC_API_KEY) { console.error(`FAIL check-agent-guidance: no Claude credentials in ${liveClaude}`); process.exit(1); }
const codexLogin = withCodex && await exists(join(harnessCodexLogin, "auth.json"));

await harness();
let cli;
for (const directory of (process.env.PATH ?? "").split(delimiter)) { try { cli = await realpath(join(directory, "paseo")); break; } catch {} }
if (!cli) throw new Error("The installed Paseo CLI is required");
let realCodex = null;
for (const directory of (process.env.PATH ?? "").split(delimiter)) { try { realCodex = await realpath(join(directory, "codex")); break; } catch {} }
const requireInstalled = createRequire(cli);
const load = async name => import(pathToFileURL(requireInstalled.resolve(name)).href);
const { createPaseoDaemon } = await load("@getpaseo/server");
const { BUILTIN_PROVIDER_IDS } = await load("@getpaseo/protocol/provider-manifest");
const { DaemonClient } = await load("@getpaseo/client/internal/daemon-client");
const serverRoot = dirname(requireInstalled.resolve("@getpaseo/server"));
const { ClaudeAgentClient } = await import(pathToFileURL(join(serverRoot, "agent/providers/claude/agent.js")).href);
const { query } = await load("@anthropic-ai/claude-agent-sdk");
const { default: pino } = await load("pino");
const paseoVersion = (await exec("paseo", ["--version"], { timeout: 30000 })).stdout.trim();

const root = await mkdtemp(join(tmpdir(), "follow-guidance-"));
const out = resolve(arg("--out", join(root, "evidence")));
const home = join(root, "paseo"); const userHome = join(root, "user"); const packedDirectory = join(root, "plugin"); const bin = join(root, "bin");
await Promise.all([home, userHome, packedDirectory, bin, out].map(path => mkdir(path, { recursive: true })));
const hookLog = join(out, "hooks.jsonl"); const codexLog = join(out, "codex-rpc.jsonl");
const original = { ...process.env };
const reservation = createServer(); await new Promise(r => reservation.listen(0, "127.0.0.1", r)); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const url = `ws://127.0.0.1:${port}/ws`;
const pluginId = "follow-up";
const REAL = codexLogin ? ["claude", "codex"] : ["claude"];
const log = (name, data = {}) => console.log(JSON.stringify({ event: name, ...data }));
const pause = ms => new Promise(r => setTimeout(r, ms));
const report = { paseo: paseoVersion, codex: null, providers: {}, anyProvider: "run separately: scripts/check-any-provider.mjs", out };
let daemon, client; let codexHooksBackup;
onShutdown(async () => { await client?.close().catch(() => {}); await daemon?.stop().catch(() => {}); });

// The workspace text's first sentence (shared/agent-text.mjs workspaceText, main agent) and a line from its middle,
// which nothing but the full text carries (the quote the agent writes back holds only the first sentence).
const { workspaceText, syncCall, nudgeReason, stopReason } = await import(pathToFileURL(join(source, "shared/agent-text.mjs")).href);
const FIRST = workspaceText({ native: true, clientEntry: "x", bridge: "y" }).split("\n")[0].replace(/(?<=\.)\s.*$/, "");
const BODY = "Tasks come due by themselves";
const norm = s => String(s ?? "").replace(/[`*_>"“”]/g, "").replace(/\s+/g, " ").toLowerCase();
const quotes = text => norm(text).includes(norm(FIRST).replace(/\.$/, ""));
const count = (text, needle) => text.split(needle).length - 1;

// Logs what each Follow-up hook printed, then passes it on unchanged: the production hook, observed.
await writeFile(join(bin, "hook-shim.mjs"), `import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs";
let input = ""; for await (const c of process.stdin) input += c;
const child = spawn(process.execPath, [process.argv[2]], { stdio: ["pipe", "pipe", "inherit"] });
let output = ""; child.stdout.on("data", d => { output += d; }); child.stdin.end(input);
child.on("close", code => { let e = {}; try { e = JSON.parse(input); } catch {}
  appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ at: Date.now(), agentId: process.env.PASEO_AGENT_ID, provider: process.env.FOLLOW_UP_PROVIDER ?? null, event: e.hook_event_name, source: e.source ?? null, systemPrompt: process.env.FOLLOW_UP_SYSTEM_PROMPT ?? null, output, code }) + "\\n");
  process.stdout.write(output); process.exit(code ?? 0); });
`);
// Codex, observed: every JSON-RPC line Paseo writes to `codex app-server` (thread/start carries developerInstructions).
if (codexLogin && realCodex) await writeFile(join(bin, "codex"), `#!${process.execPath}
import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs";
const child = spawn(${JSON.stringify(realCodex)}, process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"] });
const note = line => { try { appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2), systemPrompt: process.env.FOLLOW_UP_SYSTEM_PROMPT ?? null, line }) + "\\n"); } catch {} };
let buffer = ""; process.stdin.on("data", d => { child.stdin.write(d); buffer += d; let i; while ((i = buffer.indexOf("\\n")) >= 0) { note(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`, { mode: 0o755 });

const launches = new Map();
const items = agentId => daemon.agentManager.getTimeline(agentId) ?? [];
const replyAfter = (agentId, from) => items(agentId).slice(from).filter(i => i.type === "assistant_message").map(i => i.text).join("\n");
/** Sends one prompt and waits for the turn (with any Stop-hook continuation) to end and stay ended. */
async function turn(agentId, text, label) {
  const from = items(agentId).length;
  await client.sendMessage(agentId, text);
  let quietSince = 0;
  await waitUntil(`${label}: the turn ends`, () => {
    const agent = daemon.agentManager.getAgent(agentId);
    if (agent?.lastError) throw new Error(`${label}: ${agent.lastError}`);
    const done = agent?.lifecycle !== "running" && items(agentId).length > from;
    if (!done) { quietSince = 0; return false; }
    quietSince ||= Date.now();
    return Date.now() - quietSince > 5000;
  }, { baseMs: 240_000 });
  return { from, reply: replyAfter(agentId, from) };
}
const hooks = async () => (await readFile(hookLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l));
const stopBlocks = async (agentId, since) => (await hooks()).filter(h => h.agentId === agentId && h.event === "Stop" && h.at >= since && h.output.trim()).map(h => JSON.parse(h.output));
const sessionStarts = async (agentId, since = 0) => (await hooks()).filter(h => h.agentId === agentId && h.event === "SessionStart" && h.at >= since);

/** The provider's transcript files for this run (Claude: its config dir's project folder for the cwd; Codex: rollouts). */
async function transcript(provider, cwd) {
  const files = [];
  const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith(".jsonl")) files.push(p); } };
  if (provider === "claude") await walk(join(liveClaude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")));
  else await walk(join(harnessCodexLogin, "sessions"));
  const text = (await Promise.all(files.map(f => readFile(f, "utf8")))).join("\n");
  // Claude Code logs its own system prompt (prompt_snapshot, api-request-shape): not something the session was sent.
  const conversation = text.split("\n").filter(l => !/"type":"(api-request-shape|prompt_snapshot)"/.test(l)).join("\n");
  return { files, text, conversation };
}

async function runProvider(provider) {
  const r = report.providers[provider] = { items: {} };
  const cwd = join(root, "projects", `acme-checkout-${provider}`); await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Acme checkout\n\nA synthetic project for a harness check.\n");
  const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd }, title: `Acme checkout (${provider})` });
  const workspaceId = workspace.workspace.id;
  const agent = await client.createAgent({ provider, ...(provider === "claude" ? { model: "haiku" } : { model: codexModel }), modeId: provider === "claude" ? "bypassPermissions" : "full-access", cwd, workspaceId, title: `Checkout agent (${provider})` });
  r.agentId = agent.id;
  const start = Date.now();
  const noTools = "This is an isolated synthetic check: do not call any tools in this turn, Follow-up's included.";

  // 1. Instructions arrive.
  let first;
  try { first = await turn(agent.id, `${noTools} Your system prompt holds Follow-up's instructions for this tracked workspace. Quote, word for word, the first sentence of those workspace instructions between <quote> and </quote>. If you have none, write <quote>NONE</quote>.`, `${provider} quote`); }
  catch (error) { r.items.instructions = { verdict: "FAIL", error: error.message }; }
  const opened = (launches.get(agent.id) ?? [])[0];
  const rpc = provider === "codex" ? (await readFile(codexLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  const threadStart = rpc.map(x => { try { return JSON.parse(x.line); } catch { return null; } }).find(m => m?.method === "thread/start");
  const prompt = provider === "claude" ? opened?.systemPrompt?.append ?? "" : threadStart?.params?.developerInstructions ?? "";
  const envParts = provider === "claude" ? opened?.env?.FOLLOW_UP_SYSTEM_PROMPT : rpc.find(x => x.systemPrompt)?.systemPrompt ?? (await sessionStarts(agent.id))[0]?.systemPrompt;
  const firstStarts = await sessionStarts(agent.id);
  const delivered = { inSystemPrompt: prompt.includes(FIRST) && prompt.includes(BODY), systemPromptParts: envParts ?? null, sessionStartAddsWorkspace: firstStarts.some(h => h.output.includes(BODY) || h.output.includes(FIRST)), sessionStarts: firstStarts.length, sessionStartOutput: firstStarts.map(h => h.output.trim().slice(0, 300)) };
  if (first) {
    const m = first.reply.match(/<quote>([\s\S]*?)<\/quote>/);
    const quoted = m?.[1]?.trim() ?? first.reply.slice(0, 400);
    const pass = delivered.inSystemPrompt && /(^|,)workspace(,|$)/.test(delivered.systemPromptParts ?? "") && !delivered.sessionStartAddsWorkspace && quotes(quoted);
    r.items.instructions = { verdict: pass ? "PASS" : "FAIL", expected: FIRST, quoted, ...delivered };
  } else Object.assign(r.items.instructions, delivered);
  log("instructions", { provider, ...r.items.instructions });
  if (!first) return r;

  // 2. Turn-end nudges: an edit, no sync_workspace, no needs_you. The Stop hook blocks once, with both.
  const editAt = Date.now();
  const edit = await turn(agent.id, `Synthetic check, step 2: create the file notes.txt in the current directory containing the single line "acme checkout notes", using your file or shell tool. Do not call sync_workspace, needs_you or any other Follow-up tool unless something tells you to after this. Then reply EDITED.`, `${provider} edit`);
  const blocks = await stopBlocks(agent.id, editAt);
  const reason = blocks[0]?.reason ?? "";
  const calls = items(agent.id).slice(edit.from).filter(i => i.type === "tool_call").map(i => i.name);
  const sync = `${stopReason}`; const nudgeStart = nudgeReason.slice(0, 40);
  r.items.turnEnd = {
    stopBlocks: blocks.length, reason,
    syncReminder: reason.includes(sync) && /sync_workspace with a short summary/.test(reason), nudge: reason.includes(nudgeStart.replace("needs_you", "follow_needs_you")) || reason.includes(nudgeStart),
    wholeTextResent: reason.includes(FIRST) || reason.includes(BODY), reasonChars: reason.length,
    fileWritten: await exists(join(cwd, "notes.txt")), toolCallsAfter: calls,
  };
  r.items.turnEnd.verdict = r.items.turnEnd.stopBlocks >= 1 && r.items.turnEnd.syncReminder && r.items.turnEnd.nudge && !r.items.turnEnd.wholeTextResent && r.items.turnEnd.fileWritten ? "PASS" : "FAIL";
  log("turn-end", { provider, ...r.items.turnEnd });

  // 3. Nothing re-sent on resume: a plugin reload, then the next message reopens the session.
  const before = await transcript(provider, cwd);
  const opensBefore = (launches.get(agent.id) ?? []).length;
  const reloadAt = Date.now();
  assert.equal((await client.reloadPlugin(pluginId)).status, "running");
  await waitUntil("Follow-up's worker after the reload", async () => { try { await client.invokePluginRpc(pluginId, "follow.agent-settings", {}); return true; } catch { return false; } }, { baseMs: 30_000 });
  const again = await turn(agent.id, `${noTools} Quote again, word for word, the first sentence of Follow-up's workspace instructions in your system prompt, between <quote> and </quote>.`, `${provider} after reload`);
  let reopened = provider === "claude" ? (launches.get(agent.id) ?? []).length > opensBefore : (await readFile(codexLog, "utf8").catch(() => "")).split("\n").filter(Boolean).some(l => { const x = JSON.parse(l); return x.at >= reloadAt && /"method":"thread\/(resume|start)"/.test(x.line); });
  let refreshed = null;
  if (!reopened) {
    // The reload didn't reopen the session on this host: refresh it directly, then ask again.
    await daemon.agentManager.reloadAgentSession(agent.id);
    refreshed = await turn(agent.id, `${noTools} Once more: the first sentence of Follow-up's workspace instructions, between <quote> and </quote>.`, `${provider} after refresh`);
    reopened = provider === "claude" ? (launches.get(agent.id) ?? []).length > opensBefore : true;
  }
  const after = await transcript(provider, cwd);
  const latest = refreshed ?? again;
  const resumeStarts = await sessionStarts(agent.id, reloadAt);
  r.items.resume = {
    reopened, how: refreshed ? "agentManager.reloadAgentSession" : "plugin reload, next message",
    resumedWith: provider === "claude" ? (launches.get(agent.id) ?? []).slice(opensBefore).map(l => ({ resume: !!l.resume, workspaceInPrompt: (l.systemPrompt?.append ?? "").includes(BODY) })) : null,
    transcriptFiles: after.files.length, bodyCopiesBefore: count(before.text, BODY), bodyCopiesAfter: count(after.text, BODY),
    conversationCopiesBefore: count(before.conversation, BODY), conversationCopiesAfter: count(after.conversation, BODY),
    sessionStartsAfter: resumeStarts.length, sessionStartAddsWorkspace: resumeStarts.some(h => h.output.includes(BODY) || h.output.includes(FIRST)),
    stillQuotes: quotes(latest.reply.match(/<quote>([\s\S]*?)<\/quote>/)?.[1] ?? latest.reply),
  };
  r.items.resume.verdict = reopened && r.items.resume.bodyCopiesAfter <= Math.max(1, r.items.resume.bodyCopiesBefore) && r.items.resume.bodyCopiesAfter === r.items.resume.bodyCopiesBefore && r.items.resume.conversationCopiesAfter === r.items.resume.conversationCopiesBefore && !r.items.resume.sessionStartAddsWorkspace && r.items.resume.stillQuotes ? "PASS" : "FAIL";
  log("resume", { provider, ...r.items.resume });
  // Keep the transcripts with the evidence; Claude's live in its real config dir, so they move out of it.
  await mkdir(join(out, `transcripts-${provider}`), { recursive: true });
  for (const file of after.files) await copyFile(file, join(out, `transcripts-${provider}`, file.split("/").pop()));
  if (provider === "claude") await rm(join(liveClaude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
  r.elapsedMs = Date.now() - start;
  return r;
}

try {
  applyEnv(harnessEnv(root, { home: userHome, paseoHome: home, set: { PASEO_DAEMON_URL: url, PATH: [bin, process.env.PATH].join(delimiter) }, real: REAL }));
  if (withCodex) report.codex = codexLogin
    ? { cli: (await exec("codex", ["--version"], { timeout: 30000 }).then(r => r.stdout.trim(), () => null)), login: "harness-only, in place", model: codexModel }
    : { skipped: `no harness login (${harnessCodexLogin}/auth.json missing): run ~/paseo-harness/tools/harness-codex-login.sh once` };
  if (withCodex && !codexLogin) log("codex_skipped", report.codex);
  await writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, mcp: true, real: REAL, extra: { plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true } } } })));
  const packageInfo = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { cwd: source, timeout: 120000, maxBuffer: 2 ** 22 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packageInfo.filename), "--strip-components=1", "-C", packedDirectory]);
  const logger = pino({ level: "warn" }, pino.destination(join(root, "daemon.log")));
  const settingsFile = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  // Follow-up's installed hooks (server/agent-hooks.ts), each run through the shim.
  const shim = hooks => { const shimmed = {}; for (const [event, groups] of Object.entries(hooks ?? {})) shimmed[event] = groups.map(g => ({ ...g, hooks: g.hooks.map(h => { const script = h.command?.match(/node '([^']+agent-hook\.mjs)'/)?.[1]; return script ? { ...h, command: `node '${join(bin, "hook-shim.mjs")}' '${script}'` } : h; }) })); return shimmed; };
  const installedHooks = async () => shim(JSON.parse(await readFile(settingsFile, "utf8")).hooks);
  const providerConfig = harnessDaemonProviders({ builtinProviderIds: BUILTIN_PROVIDER_IDS, real: REAL, settings: { claude: { env: { CLAUDE_CONFIG_DIR: liveClaude } }, codex: { env: { CODEX_HOME: harnessCodexLogin } } } });
  const claude = new ClaudeAgentClient({ logger, runtimeSettings: providerConfig.agentProviderSettings.claude, queryFactory(input) {
    const id = input.options.env?.PASEO_AGENT_ID;
    if (id) launches.set(id, [...(launches.get(id) ?? []), { at: Date.now(), env: input.options.env, systemPrompt: input.options.systemPrompt, resume: input.options.resume ?? null }]);
    const preset = input.options.systemPrompt && typeof input.options.systemPrompt === "object" ? input.options.systemPrompt : { type: "preset", preset: "claude_code" };
    const note = "This is an isolated synthetic test. Do only what each message asks; do not inspect unrelated files, modify configuration, or create agents.";
    return query({ ...input, options: { ...input.options, settingSources: [], strictMcpConfig: true, hooks: undefined, settings: { hooks: hooksNow },
      systemPrompt: { ...preset, append: [preset.append, note].filter(Boolean).join("\n\n") } } });
  } });
  let hooksNow = {};
  daemon = await createPaseoDaemon({ ...providerConfig, listen: `127.0.0.1:${port}`, paseoHome: home, daemonVersion: paseoVersion.replace(/^\D+/, ""), corsAllowedOrigins: [], hostnames: true, mcpEnabled: true, mcpInjectIntoAgents: true, browserToolsEnabled: false, relayEnabled: false, staticDir: root, mcpDebug: false, agentStoragePath: join(home, "agents"), agentClients: { claude }, providerCatalogRefreshTimeoutMs: 5000, metadataGeneration: { providers: [] }, pluginsEnabled: true, plugins: { [pluginId]: { source: "directory", path: packedDirectory, enabled: true } } }, logger);
  await daemon.start();
  client = new DaemonClient({ url, clientId: "follow-guidance-isolated-test", clientType: "cli", appVersion: paseoVersion, reconnect: { enabled: false } });
  await client.connect(); await client.fetchAgents({ subscribe: {} });
  await client.refreshProvidersSnapshot();
  assertProviderStubsUnused(root);
  const installed = (await client.listPlugins()).find(p => p.id === pluginId);
  assert.equal(installed?.status, "running", JSON.stringify(installed));
  await waitUntil("Follow-up installs its Claude hooks", async () => { try { const h = await installedHooks(); return ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].every(e => JSON.stringify(h[e] ?? "").includes("hook-shim")); } catch { return false; } }, { baseMs: 60_000 });
  hooksNow = await installedHooks();
  report.hooks = Object.keys(hooksNow);
  if (codexLogin) {
    // The Codex agent reads hooks from its CODEX_HOME, the login dir: mirror Follow-up's (shimmed) for this run only.
    const codexHooks = await waitUntil("Follow-up installs its Codex hooks", async () => { try { return JSON.parse(await readFile(join(process.env.CODEX_HOME, "hooks.json"), "utf8")); } catch { return null; } }, { baseMs: 60_000 });
    codexHooksBackup = await readFile(join(harnessCodexLogin, "hooks.json"), "utf8").catch(() => null);
    await writeFile(join(harnessCodexLogin, "hooks.json"), JSON.stringify({ ...codexHooks, hooks: shim(codexHooks.hooks) }, null, 2));
  }
  await runProvider("claude");
  if (codexLogin) await runProvider("codex");
  assertProviderStubsUnused(root);
  const verdicts = Object.entries(report.providers).flatMap(([p, r]) => Object.entries(r.items).map(([k, v]) => `${p}.${k}=${v.verdict}`));
  log(verdicts.some(v => v.endsWith("FAIL")) ? "FAIL" : "DONE", { verdicts });
  if (verdicts.some(v => v.endsWith("FAIL"))) process.exitCode = 1;
} catch (error) {
  report.error = error.stack; log("FAIL", { message: error.message, root }); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {}); await daemon?.stop().catch(error => { report.cleanupError = error.message; });
  if (codexLogin) {
    if (codexHooksBackup === null) await rm(join(harnessCodexLogin, "hooks.json"), { force: true });
    else if (codexHooksBackup !== undefined) await writeFile(join(harnessCodexLogin, "hooks.json"), codexHooksBackup);
  }
  applyEnv(original);
  await cp(join(root, "daemon.log"), join(out, "daemon.log")).catch(() => {});
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  log("evidence", { directory: out });
  if (!report.error && !out.startsWith(root + "/")) await rm(root, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
