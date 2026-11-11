// Plan #2 (Paseo 0.16): the host tracks background shell jobs and wakes the agent itself, so Wait retires there.
// On a host that advertises features.agentBackgroundWork, Wait attaches no tools and doesn't set
// CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0; the hook tells the agent to run long work in the background and end its turn.
// Paseo 0.15 doesn't advertise it, and Wait stays exactly as it is.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { Wait, WAIT_TOOLS, waitStatus } from "../server/wait";
import { hostFeature } from "../server/host-features";
import { backgroundWorkInstruction, waitInstruction } from "../server/mcp.mjs";
import { WAIT_HINT, WAIT_HOST_HINT, WAIT_HOST_NOTE, WAIT_HOST_TITLE, WAIT_TITLE, waitNote, waitSwitchCopy } from "../shared/wait";

async function dir(t: { after: (f: () => Promise<void>) => void }, prefix = "follow-wait-host-") {
  const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const request = (cwd: string, patch: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest => ({
  agentId: "synthetic", provider: "claude", cwd, workspaceId: null, title: null, labels: {}, tools: [], mcpServers: {},
  reason: "create", purpose: "interactive", env: { KEEP: "yes" }, ...patch,
});

test("the host feature: only an explicit true counts; the first real answer is kept, a failed read isn't", async () => {
  let reads = 0;
  const on = hostFeature("agentBackgroundWork", async () => { reads++; return { features: { agentBackgroundWork: true } }; });
  assert.equal(await on(), true); assert.equal(await on(), true); assert.equal(reads, 1);
  const old = hostFeature("agentBackgroundWork", async () => ({ features: { providerSubagents: true } }));
  assert.equal(await old(), false, "Paseo 0.15: not advertised");
  let fail = true;
  const flaky = hostFeature("agentBackgroundWork", async () => { if (fail) throw new Error("offline"); return { features: { agentBackgroundWork: true } }; });
  assert.equal(await flaky(), false, "unknown keeps Wait as on 0.15");
  fail = false; assert.equal(await flaky(), true, "and is asked again");
  let info: { features: Record<string, unknown> } | null = null;
  const early = hostFeature("agentBackgroundWork", async () => info);
  assert.equal(await early(), false, "no server_info yet");
  info = { features: { agentBackgroundWork: true } }; assert.equal(await early(), true);
});

test("on a 0.16 host Wait attaches no tools and leaves Claude's MCP auto-background alone", async t => {
  const root = await dir(t);
  let host = true;
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null, hostBackgroundWork: async () => host }); t.after(() => wait.close());
  const next = await wait.open(request(root));
  assert.deepEqual(next.tools, [], "no wait_* tools");
  assert.equal(next.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, undefined);
  assert.equal(next.env.FOLLOW_UP_WAIT, undefined);
  assert.equal(next.env.FOLLOW_UP_BACKGROUND_WORK, "1", "the hook gives the background-work guidance instead");
  assert.equal(next.env.KEEP, "yes");
  // The same opt-outs still mean nothing at all.
  for (const patch of [{ purpose: "history" }, { provider: "codex" }, { labels: { "follow-up-wait/enabled": "false" } }] as Partial<PluginSessionOpenRequest>[]) {
    const r = request(root, patch); assert.equal(await wait.open(r), r, JSON.stringify(patch));
  }
  host = false;
  const old = await wait.open(request(root));
  assert.deepEqual(old.tools.map(t => t.name).sort(), [...WAIT_TOOLS].sort(), "0.15: Wait as before");
  assert.equal(old.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, "0"); assert.equal(old.env.FOLLOW_UP_BACKGROUND_WORK, undefined);
});

test("Settings says why Wait isn't attached on a 0.16 host", () => {
  const status = waitStatus(true, null, true);
  assert.deepEqual(status, { enable_wait: true, active: false, reason: "host", host: true });
  assert.equal(waitNote(status), WAIT_HOST_NOTE);
  assert.deepEqual(waitStatus(false, null, true).reason, "off", "the switch still wins");
  assert.equal(waitStatus(true, null).active, true, "0.15 unchanged");
  // The switch is named for what it controls on each host; the 0.16 statement never names Wait.
  assert.deepEqual(waitSwitchCopy(status), { title: WAIT_HOST_TITLE, hint: WAIT_HOST_HINT });
  assert.deepEqual(waitSwitchCopy(waitStatus(true, null)), { title: WAIT_TITLE, hint: WAIT_HINT });
  assert.deepEqual(waitSwitchCopy(undefined), { title: WAIT_TITLE, hint: WAIT_HINT }, "loading: 0.15 copy");
  const off = waitStatus(false, null, true);
  assert.equal(off.host, true, "switched off on 0.16: the card still says Paseo runs the jobs");
  assert.deepEqual(waitSwitchCopy(off), { title: WAIT_HOST_TITLE, hint: WAIT_HOST_HINT }, "and keeps the 0.16 switch copy");
  for (const copy of [WAIT_HOST_NOTE, WAIT_HOST_TITLE, WAIT_HOST_HINT]) assert.doesNotMatch(copy, /\bWait\b|wait_/, copy);
});

test("the hook's 0.16 guidance: background, end the turn, no Wait tools", async t => {
  const root = await dir(t, "follow-wait-host-hook-");
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  for (const file of ["agent-hook.mjs", "mcp.mjs"]) await writeFile(join(directory, file), await readFile(resolve("server", file), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  const fire = (env: Record<string, string>) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: "sub", FOLLOW_UP_BRIEF: "", FOLLOW_UP_RECOVERY: "", FOLLOW_UP_TOOLS: "", FOLLOW_UP_ROOT: "", FOLLOW_UP_OVERSEER: "", FOLLOW_UP_WAIT: "", FOLLOW_UP_BACKGROUND_WORK: "", ...env } });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }));
  });
  const text = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : "";
  assert.equal(text(await fire({ FOLLOW_UP_BACKGROUND_WORK: "1" })), backgroundWorkInstruction);
  assert.equal(text(await fire({ FOLLOW_UP_WAIT: "1" })), waitInstruction, "0.15 unchanged");
  assert.match(backgroundWorkInstruction, /run_in_background/);
  assert.match(backgroundWorkInstruction, /end your turn/);
  assert.doesNotMatch(backgroundWorkInstruction, /wait_(prepare|for|get)_job/);
});
