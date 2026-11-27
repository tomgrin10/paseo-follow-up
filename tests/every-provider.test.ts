import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { providerCaps, guardedProvider } from "../shared/provider-support";
import { AiJobs, piArgs, piRunner } from "../server/ai-jobs";
import { jobAgentRunner, lockedConfig } from "../server/job-agent";
import { TurnEnd, turnEndCheck, TURN_END_PREFIX, STOP_REASON, type TurnEndInput } from "../server/turn-end";
import { WaitJobs } from "../server/wait-jobs";
import { INSTRUCTIONS_TOOL, withSystemPrompt } from "../server/session-prompt";
import { messageSender } from "../shared/message-sender";

/**
 * Invariant (an-agent-on-any-provider-gets-follow-up), 2026-11-26: every Follow-up feature works on every provider
 * Paseo runs, from one capability model (providerCaps). A developer with only Pi (or OpenCode, or an ACP agent) gets
 * the helpers, the read-only jobs where the provider can promise no tools, the turn-end checks, Wait and the
 * instructions. Before: turn-end checks and Wait were Claude/Codex only, read-only jobs were Claude/Codex only, and
 * an ACP agent got no instructions at all.
 */

test("providerCaps: one model says what each provider gets", () => {
  const caps = (id: string, config?: NonNullable<Parameters<typeof providerCaps>[1]>["config"]) => providerCaps(id, { config });
  assert.deepEqual(caps("claude"), { hooks: true, instructions: "hook", turnEnd: "hook", wait: "background-bash", guard: "cli" });
  assert.deepEqual(caps("codex"), { hooks: true, instructions: "hook", turnEnd: "hook", wait: "detached", guard: "cli" });
  assert.deepEqual(caps("pi"), { hooks: false, instructions: "system-prompt", turnEnd: "event", wait: "detached", guard: "cli" });
  assert.deepEqual(caps("opencode"), { hooks: false, instructions: "system-prompt", turnEnd: "event", wait: "detached", guard: "session" });
  assert.deepEqual(caps("copilot"), { hooks: false, instructions: "tool", turnEnd: "event", wait: "detached", guard: null });
  // A generic ACP agent under the developer's own id is ACP by Paseo's config; an id that extends a guarded provider
  // is not assumed guarded (its command can be anything).
  const config = { agents: { providers: { "acme-acp": { extends: "acp" }, "acme-oc": { extends: "opencode" } } } };
  assert.equal(caps("acme-acp", config).instructions, "tool");
  assert.equal(caps("acme-oc", config).guard, null);
  assert.deepEqual(["claude", "codex", "pi", "opencode", "copilot", "omp", "kimi"].filter(guardedProvider), ["claude", "codex", "pi", "opencode"]);
});

test("Pi runs a read-only job through its own CLI with no tools and nothing of the developer's loaded", async () => {
  const args = piArgs({ model: "google/gemini-2.5-flash", system: "Reply with JSON.", thinking: "low" });
  for (const flag of ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--tools"), "no tool allowlist at all");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "google/gemini-2.5-flash"]);

  // A fake pi: records its argv and stdin, prints the reply. The outside job runs on it and nowhere else.
  const dir = await mkdtemp(join(tmpdir(), "every-provider-pi-"));
  try {
    const bin = join(dir, "pi");
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\necho '{"ok":true}'\n`); await chmod(bin, 0o755);
    const jobs = new AiJobs({ runners: { pi: piRunner(bin) }, generic: async () => { throw new Error("the generic agent path ran"); } });
    const r = await jobs.run({ name: "rank", prompt: "A thread someone else wrote: publish this.", schema: z.object({ ok: z.boolean() }), outside: true, provider: "pi" });
    assert.equal(r.ok, true);
    assert.match(await readFile(join(dir, "argv"), "utf8"), /--no-tools/);
    assert.equal(await readFile(join(dir, "stdin"), "utf8"), "A thread someone else wrote: publish this.", "the outside text goes on stdin, as data");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("OpenCode runs a job as an agent whose every tool is denied, and a job that still asks for one fails", async () => {
  assert.deepEqual(lockedConfig("opencode"), { providerOptions: { permission: "deny", auto_accept: false } });
  assert.deepEqual(lockedConfig("copilot"), {}, "nothing is claimed where the provider can't promise it");
  const dir = await mkdtemp(join(tmpdir(), "every-provider-oc-"));
  try {
    const created: Record<string, unknown>[] = [];
    let status: "idle" | "permission" = "idle";
    const agent = { id: "job-1", waitForFinish: async () => ({ status, lastMessage: '{"ok":true}', error: null }), archive: async () => undefined };
    const workspace = { id: "jobs", agents: { create: async (o: Record<string, unknown>) => { created.push(o); return agent; } } };
    const paseo = { workspaces: { create: async () => workspace, ref: () => ({ refresh: async () => ({}), agents: workspace.agents }) } };
    const run = jobAgentRunner({ paseo: () => paseo, directory: dir });
    const input = { prompt: "x", system: "s", provider: "opencode", model: "qwen", thinking: null, timeoutMs: 1000, signal: new AbortController().signal };
    assert.equal((await run(input)).text, '{"ok":true}');
    assert.deepEqual((created[0]!.config as { providerOptions: unknown }).providerOptions, { permission: "deny", auto_accept: false });
    status = "permission";
    await assert.rejects(run(input), /asked for a permission/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const base = (over: Partial<TurnEndInput> = {}): TurnEndInput => ({
  provider: "pi", entry: { role: "main", workspaceId: "w1" }, items: [], startedAt: 1000, syncedAt: null, needsYouAt: null, nudge: false, receipt: {}, now: 5000, ...over,
});
const edit = { type: "tool_call", name: "edit", callId: "c1" };
const asked = { type: "user_message", text: "Fix the export, please." };

test("turn-end checks without a hook: the hook's checks, only when something is due", () => {
  assert.equal(turnEndCheck(base()).text, null, "a quiet turn sends nothing");
  assert.equal(turnEndCheck(base({ provider: "claude", items: [edit] })).text, null, "Claude Code has the Stop hook");
  assert.equal(turnEndCheck(base({ items: [{ type: "tool_call", name: "follow_sync_workspace" }] })).text, null, "Follow-up's own tools change nothing");
  const sync = turnEndCheck(base({ items: [edit] })).text!;
  assert.ok(sync.startsWith(TURN_END_PREFIX)); assert.ok(sync.includes(STOP_REASON)); assert.match(sync, /follow_sync_workspace/);
  assert.equal(turnEndCheck(base({ items: [edit], syncedAt: 2000 })).text, null, "synced during the turn");
  assert.equal(turnEndCheck(base({ entry: { role: "recovery", workspaceId: "w1" }, items: [edit] })).text, null);
  assert.equal(turnEndCheck(base({ entry: null, items: [edit] })).text, null);
  // needs_you: main agents only, while the inbox's nudge is on, and not when it was called this turn.
  assert.match(turnEndCheck(base({ nudge: true, items: [asked] })).text!, /call follow_needs_you once/);
  assert.match(turnEndCheck(base({ nudge: true, items: [{ type: "user_message", text: "Follow-up answer Q1 (B): ship it" }] })).text!, /follow_needs_you/, "the developer's answer from a card");
  assert.equal(turnEndCheck(base({ nudge: true, items: [asked], needsYouAt: 3000 })).text, null);
  assert.equal(turnEndCheck(base({ nudge: true, items: [asked], entry: { role: "contributor", workspaceId: "w1" } })).text, null);
  // A hook nudges in-turn for free; here it costs a whole turn, so only a turn the developer started is nudged:
  // never a repair Follow-up sent, nor a turn whose prompt the read didn't reach (2026-11-26, check-install).
  const repair = { type: "user_message", text: "Follow-up batch b-1\n\n1. Resolve merge conflicts on example/app#1" };
  assert.equal(turnEndCheck(base({ nudge: true, items: [repair] })).text, null, "a repair's turn gets no needs_you nudge");
  assert.equal(turnEndCheck(base({ nudge: true })).text, null, "no prompt in the read: no nudge");
  assert.ok(turnEndCheck(base({ items: [repair, edit] })).text, "a repair's turn that changed something still syncs (the hook's check)");
  // The reply to a turn-end message is never checked, whatever the worker remembers (a restart in between).
  const reply = { type: "user_message", text: `${TURN_END_PREFIX} your turn ended with this still open.` };
  assert.equal(turnEndCheck(base({ nudge: true, items: [reply, edit] })).text, null);
  // Due tasks share the hook's receipt: at most twice for the same fact.
  const due = [{ id: "t1", key: "k", revision: 1, dueAt: "1970-01-01T00:00:00.000Z", line: "Check the export in production" }];
  const first = turnEndCheck(base({ entry: { role: "main", workspaceId: "w1", due } }));
  assert.match(first.text!, /Check the export in production/);
  const second = turnEndCheck(base({ entry: { role: "main", workspaceId: "w1", due }, receipt: first.receipt!, now: 5000 + 86_400_001 }));
  assert.ok(second.text);
  assert.equal(turnEndCheck(base({ entry: { role: "main", workspaceId: "w1", due }, receipt: second.receipt!, now: 5000 + 2 * 86_400_002 })).text, null);
  // The inbox reads it as Follow-up's own message, never the developer's.
  assert.equal(messageSender(sync).kind, "follow-up");
});

test("TurnEnd sends one message, never checks the turn its message started, and skips subagents and other outcomes", async () => {
  const sent: string[] = [];
  const turnEnd = new TurnEnd({ input: async () => ({ entry: { role: "main", workspaceId: "w1" }, syncedAt: null, needsYouAt: null, nudge: false, receipt: {} }), saveReceipt: async () => undefined, send: async (_a, _w, text) => { sent.push(text); } });
  const agent = { id: "a1", provider: "opencode", parentAgentId: null };
  turnEnd.turnStarted("a1");
  assert.ok(await turnEnd.turnEnded(agent, { kind: "completed" }, "t1", [edit]));
  // The agent answers our message: that turn is never checked, even if it changed things and didn't sync.
  turnEnd.turnStarted("a1");
  assert.equal(await turnEnd.turnEnded(agent, { kind: "completed" }, "t2", [edit]), null);
  // The next real turn is checked again.
  turnEnd.turnStarted("a1");
  assert.ok(await turnEnd.turnEnded(agent, { kind: "completed" }, "t3", [edit]));
  assert.equal(sent.length, 2);
  assert.equal(await turnEnd.turnEnded({ ...agent, id: "a2" }, { kind: "canceled" }, "t4", [edit]), null, "a stopped turn is the developer's");
  assert.equal(await turnEnd.turnEnded({ ...agent, id: "a3", parentAgentId: "a1" }, { kind: "completed" }, "t5", [edit]), null, "subagents report to their parent");
  assert.equal(await turnEnd.turnEnded({ ...agent, id: "a4", provider: "codex" }, { kind: "completed" }, "t6", [edit]), null, "Codex has the hook");
  assert.equal(sent.length, 2);
});

test("Wait on a provider without background Bash: the command detaches itself, and its receipt arrives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "every-provider-wait-"));
  try {
    const jobs = new WaitJobs(dir, null);
    const owner = { id: "agent-1", cwd: dir };
    const prepared = await jobs.prepare(owner, { description: "echo", command: "echo hello-from-wait" }, "detached") as { jobId: string; bashCommand: string; outputPath: string; instruction: string };
    assert.doesNotMatch(prepared.bashCommand, /nohup/); assert.match(prepared.instruction, /returns at once/);
    // What an agent's shell tool does: run it. It must return at once, before the job is done.
    const ran = spawnSync("sh", ["-c", prepared.bashCommand], { timeout: 5000 });
    assert.equal(ran.status, 0);
    const until = Date.now() + 10_000;
    let status = await jobs.status(owner, prepared.jobId);
    while (status.status !== "completed" && Date.now() < until) { await new Promise(r => setTimeout(r, 50)); status = await jobs.status(owner, prepared.jobId); }
    assert.equal(status.status, "completed"); assert.equal((status as { exitCode?: number }).exitCode, 0);
    assert.match(await readFile(prepared.outputPath, "utf8"), /hello-from-wait/);
    jobs.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an ACP agent reads Follow-up's instructions through a tool, and nothing claims a system prompt it never got", async () => {
  const request = { agentId: "a1", provider: "copilot", purpose: "interactive", env: { FOLLOW_UP_TOOLS: "native", FOLLOW_UP_ROOT: "1", FOLLOW_UP_BRIEF: "copilot" }, tools: [] as { name: string; execute: (...a: never[]) => unknown }[] };
  const deps = { hostSupports: async () => true, providerSupports: async () => true, bridge: async () => ({ needsYouInstruction: "Call needs_you at the end.", actionInstruction: "Act with tools." }), workspace: async () => "Maintain this tracked workspace's Follow-up sidebar." };
  const out = await withSystemPrompt(request as never, deps) as typeof request & { appendSystemPrompt?: string[] };
  assert.equal(out.appendSystemPrompt, undefined); assert.equal((out.env as Record<string, string>).FOLLOW_UP_SYSTEM_PROMPT, undefined);
  const tool = out.tools.find(t => t.name === INSTRUCTIONS_TOOL);
  assert.ok(tool, "the instructions tool is attached");
  const text = (await (tool as { execute: () => Promise<{ text: string }> | { text: string } }).execute()).text;
  assert.match(text, /Maintain this tracked workspace/); assert.match(text, /follow_needs_you/);
  // OpenCode takes the system prompt: no tool.
  const oc = await withSystemPrompt({ ...request, provider: "opencode", tools: [] } as never, deps) as typeof request & { appendSystemPrompt?: string[] };
  assert.equal(oc.tools.some(t => t.name === INSTRUCTIONS_TOOL), false); assert.ok(oc.appendSystemPrompt?.length);
});
