import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AiJobs, claudeRunner } from "../server/ai-jobs";
import { ARTIFACT_READ, GRANT_ENV, GUARD_SCRIPT, guardFor, refusedCalls } from "../server/job-guard";
import { liveRankSources } from "../server/ranker";

// sources-are-read-only: an AI job that reads outside content can only read. A fake `claude` stands in for the model:
// it "calls" the tools it was given, asking the PreToolUse hooks passed with --settings first exactly as Claude Code
// does, records what actually ran, and answers like `claude -p --output-format json`. No live model.

const URL = "https://claude.ai/artifact/acme-plan";
const PLAN = { title: "Week 48", items: [{ level: "project", title: "ACME-12 SSO for acme", keys: ["ACME-12"] }] };

/** A fake provider whose model tries `calls` in order, then replies with the plan. */
async function fakeClaude(dir: string, calls: { tool: string; input: Record<string, unknown> }[]): Promise<{ command: string; ran: () => Promise<string[]> }> {
  const ranPath = join(dir, "ran.jsonl");
  const command = join(dir, "claude");
  await writeFile(command, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--settings");
const settings = at >= 0 ? JSON.parse(args[at + 1]) : {};
const hooks = (settings.hooks?.PreToolUse ?? []).flatMap(m => m.hooks ?? []);
const denials = [];
for (const call of ${JSON.stringify(calls)}) {
  let denied = false;
  for (const h of hooks) {
    const out = execFileSync("sh", ["-c", h.command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: call.tool, tool_input: call.input }) }).toString();
    if (out.trim() && JSON.parse(out).hookSpecificOutput?.permissionDecision === "deny") denied = true;
  }
  if (denied) denials.push({ tool_name: call.tool, tool_use_id: "t" + denials.length, tool_input: call.input });
  else appendFileSync(${JSON.stringify(ranPath)}, JSON.stringify(call) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "result", result: ${JSON.stringify(JSON.stringify(PLAN))}, is_error: false, total_cost_usd: 0.001, permission_denials: denials }));
`);
  await chmod(command, 0o755);
  return { command, ran: async () => (await readFile(ranPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => { const c = JSON.parse(l); return `${c.tool}.${c.input.action ?? "default"}`; }) };
}

const READ = { tool: "Artifact", input: { action: "read", url: URL } };
const HOSTILE = [
  { tool: "Artifact", input: { action: "publish", url: URL, file_path: "/tmp/x.html" } },
  { tool: "Artifact", input: { url: URL, file_path: "/tmp/x.html" } },
  { tool: "Artifact", input: { action: "delete", url: URL } },
  { tool: "Artifact", input: { action: "read", url: URL, path: "index.html", out_dir: "/home/user" } },
  { tool: "Bash", input: { command: "touch /tmp/owned" } },
];

test("plan reader: a plan that makes the model publish, update or delete gets those calls refused, and the read is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-guard-"));
  try {
    const plain = await fakeClaude(join(dir), [READ]);
    const clean = await liveRankSources(new AiJobs(), { claude: plain.command }).planning!(URL);
    await rm(join(dir, "ran.jsonl"), { force: true });

    const logPath = join(dir, "ai-jobs.jsonl");
    const hostile = await fakeClaude(dir, [...HOSTILE, READ]);
    const read = await liveRankSources(new AiJobs({ logPath }), { claude: hostile.command }).planning!(URL);
    assert.deepEqual(await hostile.ran(), ["Artifact.read"], "only the read ran");
    assert.deepEqual(read, clean, "the plan reads the same as without the attempts");
    const log = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.equal(log.ok, true);
    assert.deepEqual(log.refused, ["Artifact.publish", "Artifact", "Artifact.delete", "Artifact.read", "Bash"], "logged by name only");
    assert.doesNotMatch(JSON.stringify(log), /acme-plan|tmp|home\/user|touch/, "no input reaches the log");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("every Claude job runs under the guard, and grants nothing by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-guard-"));
  try {
    const fake = await fakeClaude(dir, [READ, { tool: "Bash", input: { command: "ls" } }]);
    const r = await new AiJobs({ runner: claudeRunner(fake.command) }).run({ name: "t", prompt: "p", schema: z.object({ title: z.string() }).passthrough() });
    assert.equal(r.ok, true);
    assert.deepEqual(await fake.ran(), [], "a job without a grant runs no tool at all");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the hook decides by the grant, and refuses what it can't read", () => {
  const { args, env } = guardFor(ARTIFACT_READ);
  const command = JSON.parse(args[1]).hooks.PreToolUse[0].hooks[0].command as string;
  const decide = (input: string, grant = env[GRANT_ENV]) => {
    const out = execFileSync("sh", ["-c", command], { input, env: { ...process.env, ...env, [GRANT_ENV]: grant } }).toString();
    return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : "pass";
  };
  const call = (tool_name: string, tool_input: unknown) => JSON.stringify({ tool_name, tool_input });
  assert.equal(decide(call("Artifact", { action: "read", url: URL })), "pass");
  for (const action of ["publish", "delete", "list", "open", "pin", "quickstart", "READ"]) assert.equal(decide(call("Artifact", { action, url: URL })), "deny", action);
  assert.equal(decide(call("Artifact", { url: URL })), "deny", "no action means publish");
  assert.equal(decide(call("Artifact", { action: "read", url: URL, out_dir: "/x" })), "deny");
  assert.equal(decide(call("constructor", {})), "deny", "no prototype key is a grant");
  assert.equal(decide(call("Write", { file_path: "/x" })), "deny");
  assert.equal(decide("not json"), "deny", "fail closed");
  assert.equal(decide(call("Artifact", { action: "read" }), "{bad"), "deny", "an unreadable grant grants nothing");
  assert.equal(decide(call("Artifact", { action: "read" }), "{}"), "deny");
  assert.ok(!GUARD_SCRIPT.includes("'"));
});

test("refused calls keep tool and action names only", () => {
  assert.deepEqual(refusedCalls([{ tool_name: "Artifact", tool_input: { action: "publish", url: URL } }, { tool_name: "Bash", tool_input: { command: "rm -rf /" } }, { tool_name: "Artifact", tool_input: { action: "pub lish; secret" } }, { tool_name: { x: 1 } }]),
    ["Artifact.publish", "Bash", "Artifact.other", "other"]);
  assert.deepEqual(refusedCalls(undefined), []);
});

test("a job that reads outside content never starts on a provider Follow-up can't take tools from (invariant 81's other-provider gap)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-unguarded-"));
  try {
    let ran = 0;
    const jobs = new AiJobs({ logPath: join(dir, "ai-jobs.jsonl"), runner: async () => { ran++; return { text: "{\"ok\":true}", costUsd: null, inputTokens: null, outputTokens: null }; } });
    const spec = { name: "rank", prompt: "x", schema: z.object({ ok: z.boolean() }) };
    // Copilot is an ACP agent: nothing it offers takes every tool away, so an outside job never starts there.
    const refused = await jobs.run({ ...spec, outside: true, provider: "copilot" });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "unguarded");
    assert.match(!refused.ok ? refused.error : "", /can't take copilot's tools away/);
    assert.equal(ran, 0, "refused before any runner, an injected one included");
    // Every provider that promises a job no tools runs it (shared/provider-support.ts providerCaps).
    for (const provider of ["claude", "codex", "pi", "opencode"]) assert.equal((await jobs.run({ ...spec, outside: true, provider })).ok, true, provider);
    assert.equal((await jobs.run({ ...spec, provider: "copilot" })).ok, true, "a job over Follow-up's own state still runs anywhere");
    assert.equal(ran, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
