import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustBypass, plainToolPermission, summarize, type PermissionRequestShape } from "../server/trust-bypass";

// Shapes as Paseo 0.15.2's providers send them (claude/agent.js handlePermissionRequest, codex-app-server-agent.js).
const claudeBash: PermissionRequestShape = { id: "permission-1", kind: "tool", name: "Bash", input: { command: "cd ~/worktrees/app && git status", description: "Status" } };
const claudeEdit: PermissionRequestShape = { id: "permission-2", kind: "tool", name: "Write", input: { file_path: "/fixture/.claude/notes.md", content: "x" } };
const codexBash: PermissionRequestShape = { id: "codex-1", kind: "tool", name: "CodexBash", title: "Run command", input: { command: "git push" } };
const codexPatch: PermissionRequestShape = { id: "codex-2", kind: "tool", name: "CodexFileChange", title: "Apply file changes" };
const question: PermissionRequestShape = { id: "permission-3", kind: "question", name: "AskUserQuestion", input: { questions: [{ question: "Which?" }] } };
const plan: PermissionRequestShape = { id: "permission-4", kind: "plan", name: "ExitPlanMode", input: { plan: "1. Do it" }, actions: [{ intent: "implement" }, { intent: "dismiss" }] };
const elicitation: PermissionRequestShape = { id: "codex-3", kind: "tool", name: "CodexMcpElicitation", title: "MCP approval: linear" };
const codexQuestion: PermissionRequestShape = { id: "codex-4", kind: "question", name: "CodexQuestion" };

async function fixture(t: { after: (f: () => Promise<void>) => void }, modes: Record<string, string | null>, enabled = true, keep?: number) {
  const directory = await mkdtemp(join(tmpdir(), "trust-bypass-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const approved: string[] = []; const fetched: string[] = [];
  let on = enabled;
  const trust = new TrustBypass(directory, {
    enabled: async () => on,
    mode: async id => { fetched.push(id); return modes[id] ?? null; },
    approve: async (agentId, requestId) => { approved.push(`${agentId}:${requestId}`); },
    keep,
  });
  return { trust, directory, approved, fetched, set: (value: boolean) => { on = value; } };
}

test("bypass (Claude) and full-access (Codex) agents' plain tool prompts are approved, and logged", async t => {
  const f = await fixture(t, { claude: "bypassPermissions", codex: "full-access" });
  for (const [agent, request] of [["claude", claudeBash], ["claude", claudeEdit], ["codex", codexBash], ["codex", codexPatch]] as const)
    assert.deepEqual(await f.trust.handle({ id: agent }, request), { approved: true, mode: agent === "claude" ? "bypassPermissions" : "full-access" }, request.name);
  assert.deepEqual(f.approved, ["claude:permission-1", "claude:permission-2", "codex:codex-1", "codex:codex-2"]);
  const log = await f.trust.recent();
  assert.equal(log.today, 4);
  assert.equal(log.recent[3].summary, "Bash: cd ~/worktrees/app && git status");
  assert.equal(log.recent[0].tool, "CodexFileChange");
});

test("every other mode still prompts, read at request time", async t => {
  const f = await fixture(t, { a: "default", b: "acceptEdits", c: "auto", d: "plan", e: "read-only", f: null });
  for (const agent of ["a", "b", "c", "d", "e", "f", "unknown"]) assert.equal((await f.trust.handle({ id: agent }, claudeBash)).approved, false, agent);
  assert.deepEqual(f.approved, []);
  assert.equal(f.fetched.length, 7, "one mode read per request");
});

test("questions, plan approval, elicitation and non-tool requests are never answered, even in bypass", async t => {
  const f = await fixture(t, { x: "bypassPermissions" });
  for (const request of [question, plan, elicitation, codexQuestion, { id: "m", kind: "mode", name: "SetMode" }, { id: "o", kind: "other", name: "Bash" }, { ...claudeBash, id: "q", name: "AskUserQuestion" }, { ...claudeBash, id: "p", name: "ExitPlanMode" }, { id: "auth", kind: "tool", name: "McpOAuthLogin" }])
    assert.deepEqual(await f.trust.handle({ id: "x" }, request), { approved: false, reason: "not-a-tool" }, request.name);
  assert.deepEqual(f.approved, []);
  assert.deepEqual(f.fetched, [], "no mode read for a request it would never answer");
});

test("the setting off restores the prompt", async t => {
  const f = await fixture(t, { x: "bypassPermissions" }, false);
  assert.deepEqual(await f.trust.handle({ id: "x" }, claudeBash), { approved: false, reason: "off" });
  f.set(true);
  assert.equal((await f.trust.handle({ id: "x" }, claudeBash)).approved, true);
  assert.deepEqual(f.approved, ["x:permission-1"]);
});

test("a failed approval isn't logged as one", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trust-bypass-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const trust = new TrustBypass(directory, { enabled: async () => true, mode: async () => "bypassPermissions", approve: async () => { throw new Error("already answered"); } });
  assert.deepEqual(await trust.handle({ id: "x" }, claudeBash), { approved: false, reason: "error", mode: "bypassPermissions" });
  assert.equal((await trust.recent()).today, 0);
});

test("the audit log is capped and keeps the newest", async t => {
  const f = await fixture(t, { x: "bypassPermissions" }, true, 10);
  await Promise.all(Array.from({ length: 40 }, (_, i) => f.trust.handle({ id: "x" }, { ...claudeBash, id: `r${i}`, input: { command: `echo ${i}` } })));
  const lines = (await readFile(join(f.directory, "trust-bypass.jsonl"), "utf8")).trim().split("\n");
  assert.ok(lines.length <= 15, `${lines.length} lines`);
  assert.equal(JSON.parse(lines.at(-1)!).summary, "Bash: echo 39");
  assert.equal(f.approved.length, 40);
});

test("plain tool permissions and summaries", () => {
  assert.equal(plainToolPermission(claudeBash), true);
  assert.equal(plainToolPermission({ ...claudeBash, actions: [{ intent: "implement_resume" }] }), false);
  assert.equal(plainToolPermission({ id: "n", kind: "tool" }), false, "a tool with no name");
  assert.equal(summarize({ id: "s", kind: "tool", name: "Bash", input: { command: "python3 - <<'EOF'\nprint(1)\nEOF" } }), "Bash: python3 - <<'EOF' print(1) EOF");
  assert.equal(summarize({ id: "s", kind: "tool", name: "Bash", input: { command: "x".repeat(400) } }).length, 160);
});

test("the Settings line says how many were approved today, and the last one", async () => {
  const { trustCountText } = await import("../shared/display");
  assert.equal(trustCountText(undefined), null);
  assert.equal(trustCountText({ today: 0, recent: [] }), null);
  assert.equal(trustCountText({ today: 3, recent: [{ summary: "Bash: cd repo && git status" }] }), "3 approved today · last: Bash: cd repo && git status");
  assert.equal(trustCountText({ today: 0, recent: [{ summary: "Bash: ls" }] }), "0 approved today · last: Bash: ls");
});
