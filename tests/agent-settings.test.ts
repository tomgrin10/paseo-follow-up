import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { parseAgentSettings, resolveRole, roleSummary, modelName, labelsFor, ROLE_DEFAULTS } from "../shared/agent-settings";
import { AgentSettingsStore, ProviderCatalog, catalogFrom, providersFor } from "../server/agent-settings";
import { AiJobs, claudeArgs, codexArgs, codexPrompt, parseCodexEvents, type Runner } from "../server/ai-jobs";
import { applyRecoveryRole } from "../server/recovery-config";
import { Overseer, type OverseerPaseo } from "../server/overseer";
import { AgentActions, READ_ONLY_TOOLS } from "../server/agent-actions";
import type { State } from "../shared/model";

const schema = z.object({ ok: z.boolean() });

test("config: missing, garbage and partly invalid files fall back to today's defaults, field by field", () => {
  assert.deepEqual(resolveRole(null, "about"), { role: "about", ...ROLE_DEFAULTS.about, isDefault: true });
  assert.equal(resolveRole(undefined, "overseer").mode, "bypassPermissions");
  assert.equal(resolveRole(null, "recovery").same, true, "recovery copies the main agent by default");
  assert.equal(roleSummary(resolveRole(null, "recovery")), "Same as main agent");
  assert.equal(roleSummary(resolveRole(null, "about")), "Claude · Haiku");
  assert.equal(roleSummary(resolveRole(null, "overseer")), "Claude · Newest Opus");

  assert.deepEqual(parseAgentSettings("nonsense").file.roles, {});
  assert.deepEqual(parseAgentSettings({ roles: [] }).file.roles, {});
  const mixed = parseAgentSettings({ roles: { about: { provider: "codex", model: "gpt-6-luna", dailyCap: -4 }, overseer: "opus please", ranker: { cadenceMinutes: 30 }, bogus: { provider: "x" } } });
  assert.deepEqual(mixed.invalid.sort(), ["about", "overseer"]);
  const about = resolveRole(mixed.file, "about");
  assert.equal(about.provider, "codex"); assert.equal(about.model, "gpt-6-luna"); assert.equal(about.dailyCap, 60, "the invalid cap falls back alone");
  assert.equal(resolveRole(mixed.file, "overseer").provider, "claude");
  assert.equal(resolveRole(mixed.file, "ranker").cadenceMinutes, 30); assert.equal(resolveRole(mixed.file, "ranker").model, "sonnet");

  // A new provider without a model doesn't inherit the old provider's model, effort or mode.
  const moved = resolveRole({ version: 1, roles: { overseer: { provider: "codex" } } }, "overseer");
  assert.equal(moved.model, null); assert.equal(moved.mode, null); assert.equal(moved.isDefault, false);
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5"); assert.equal(modelName("gpt-6-luna"), "GPT-6-Luna"); assert.equal(modelName("haiku"), "Haiku");
});

test("store: agents.json is its own file, written only on change, reset removes the role", async t => {
  const dir = await mkdtemp(join(tmpdir(), "agents-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AgentSettingsStore(dir);
  assert.equal((await store.role("about")).model, "haiku");
  assert.deepEqual(await readdir(dir), [], "reading never writes");
  await store.save("about", { provider: "codex", model: "gpt-6-luna", thinking: "low", mode: "full-access", dailyCap: 20 });
  const saved = JSON.parse(await readFile(join(dir, "agents.json"), "utf8"));
  assert.deepEqual(saved.roles.about, { provider: "codex", model: "gpt-6-luna", thinking: "low", dailyCap: 20 }, "a job role stores no mode");
  assert.deepEqual(await readdir(dir), ["agents.json"]);
  await assert.rejects(store.save("about", { provider: "has spaces" }), /isn't valid/);
  await store.save("about", null);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "agents.json"), "utf8")).roles, {});
  assert.equal((await new AgentSettingsStore(dir).role("about")).isDefault, true);
  await writeFile(join(dir, "agents.json"), "{not json");
  assert.equal((await new AgentSettingsStore(dir).role("overseer")).provider, "claude", "an unreadable file means defaults");
});

test("ai-jobs: the role's provider picks the CLI; claude and codex arguments; unknown providers fail cleanly", async () => {
  const seen: Parameters<Runner>[0][] = [];
  const fake = (text: string): Runner => async input => { seen.push(input); return { text, costUsd: null, inputTokens: 1, outputTokens: 1 }; };
  const jobs = new AiJobs({ runners: { claude: fake('{"ok":true}'), codex: fake('{"ok":false}') } });
  const a = await jobs.run({ name: "about", prompt: "p", schema });
  assert.deepEqual(a.ok && a.value, { ok: true }); assert.equal(seen[0].provider, "claude"); assert.equal(seen[0].model, "haiku");
  const b = await jobs.run({ name: "about", prompt: "p", schema, provider: "codex", model: "gpt-6-luna", thinking: "low" });
  assert.deepEqual(b.ok && b.value, { ok: false }); assert.equal(seen[1].provider, "codex"); assert.equal(seen[1].model, "gpt-6-luna"); assert.equal(seen[1].thinking, "low");
  const c = await new AiJobs().run({ name: "about", prompt: "p", schema, provider: "opencode" });
  assert.equal(c.ok, false); assert.match(!c.ok ? c.error : "", /can't run one-shot jobs/);

  assert.deepEqual(claudeArgs({ model: "sonnet", system: "S", thinking: "high" }).slice(-4), ["--effort", "high", "--system-prompt", "S"]);
  assert.ok(!claudeArgs({ model: "haiku", system: "S" }).includes("--effort"));
  const args = codexArgs({ model: "gpt-6-luna", thinking: "low", cwd: "/tmp/x" });
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--json"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(args.indexOf("--disable"), args.indexOf("--disable") + 2), ["--disable", "shell_tool"]);
  assert.ok(args.includes("model_reasoning_effort=low")); assert.equal(args.at(-1), "-", "the prompt goes on stdin");
  assert.equal(codexPrompt({ system: "SYS", prompt: "P" }), "SYS\n\nP");

  const out = parseCodexEvents(['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}', '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":9}}'].join("\n"));
  assert.deepEqual(out, { text: '{"ok":true}', costUsd: null, inputTokens: 120, outputTokens: 9 });
  assert.throws(() => parseCodexEvents('{"type":"turn.failed","error":{"message":"{\\"error\\":{\\"message\\":\\"model not supported\\"}}"}}'), /model not supported/);
});

test("ai-jobs: the codex runner kills its process group on timeout like claude's", async t => {
  const dir = await mkdtemp(join(tmpdir(), "codex-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const hang = join(dir, "codex"); await writeFile(hang, "#!/bin/sh\nsleep 30 &\nsleep 30\n", { mode: 0o755 });
  const { codexRunner } = await import("../server/ai-jobs");
  const started = Date.now();
  const r = await new AiJobs({ runners: { codex: codexRunner(hang) } }).run({ name: "t", prompt: "p", schema, provider: "codex", timeoutMs: 400 });
  assert.equal(r.ok, false); assert.equal(!r.ok && r.reason, "timeout"); assert.ok(Date.now() - started < 5000);
});

test("catalog: Paseo's snapshot becomes pickers; failures come back as an error, never a throw", async () => {
  const providers = catalogFrom([
    { provider: "claude", status: "ready", label: "Claude", models: [{ id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] }, { id: "claude-opus-5-5[1m]", label: "Opus 1M" }], modes: [{ id: "bypassPermissions", label: "Bypass" }] },
    { provider: "codex", status: "ready", label: "Codex", models: [{ id: "gpt-6-luna", label: "GPT-6-Luna" }] },
    { provider: "opencode", status: "unavailable", enabled: true },
    { provider: "copilot", status: "unavailable", enabled: false },
    { provider: "muse", status: "error", error: "muse not found on PATH" },
  ]);
  assert.deepEqual(providers.map(p => [p.id, p.available, p.reason]), [["claude", true, null], ["codex", true, null], ["opencode", false, "Not installed"], ["copilot", false, "Turned off in Paseo"], ["muse", false, "muse not found on PATH"]]);
  assert.deepEqual(providers[0].models.map(m => m.id), ["claude-opus-5-5"], "1M-context variants are hidden");
  const forJobs = providersFor("about", [...providers, { id: "pi", label: "Pi", available: true, reason: null, models: [], modes: [], defaultMode: null }]);
  assert.equal(forJobs.find(p => p.id === "pi")!.available, true, "jobs run on any provider Paseo has");
  assert.equal(providersFor("overseer", providers).find(p => p.id === "codex")!.available, true);
  assert.deepEqual(labelsFor({ ...resolveRole(null, "overseer"), model: "claude-opus-5-5", thinking: "high" }, { providers, error: null, fetchedAt: null }), { provider: "Claude", model: "Opus 5.5", thinking: "High" });

  let calls = 0; let now = 0;
  const failing = new ProviderCatalog(async () => { calls++; throw new Error("socket closed"); }, () => now);
  const r = await failing.read();
  assert.deepEqual(r.providers, []); assert.match(r.error!, /socket closed/);
  await failing.read(); assert.equal(calls, 1, "cached");
  now += 61_000; await failing.read(); assert.equal(calls, 2, "a failure is retried after a minute, not ten");
  let ok = 0;
  const cached = new ProviderCatalog(async () => { ok++; return { entries: [{ provider: "claude", status: "ready" }] }; }, () => now);
  await cached.read(); now += 120_000; await cached.read(); assert.equal(ok, 1); await cached.read(true); assert.equal(ok, 2, "fresh re-reads");
  let loading = 0;
  const lazy = new ProviderCatalog(async () => { loading++; return { entries: [{ provider: "claude", status: loading < 2 ? "loading" : "ready" }] }; }, () => now);
  assert.equal((await lazy.read()).providers[0].reason, "Still loading");
  now += 11_000; assert.equal((await lazy.read()).providers[0].available, true, "still-loading answers are kept only seconds");
});

test("recovery: 'Same as main agent' copies it; another provider drops what's provider-specific", () => {
  const main = { provider: "claude", model: "claude-opus-5-5" };
  const config = { model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high", featureValues: { x: 1 }, systemPrompt: "SP", mcpServers: {} };
  assert.deepEqual(applyRecoveryRole(main, config, null), { provider: "claude", model: "claude-opus-5-5", config });
  assert.deepEqual(applyRecoveryRole(main, config, { same: true, provider: "codex", model: "gpt-6-luna", thinking: null, mode: null }).provider, "claude");
  const codex = applyRecoveryRole(main, config, { same: false, provider: "codex", model: "gpt-6.1-sol", thinking: "low", mode: "full-access" });
  assert.equal(codex.provider, "codex"); assert.equal(codex.model, "gpt-6.1-sol");
  assert.deepEqual(codex.config, { model: "gpt-6.1-sol", modeId: "full-access", thinkingOptionId: "low", systemPrompt: "SP", mcpServers: {} });
  const sonnet = applyRecoveryRole(main, config, { same: false, provider: "claude", model: "claude-sonnet-5-5", thinking: null, mode: null });
  assert.equal(sonnet.config.modeId, "bypassPermissions", "same provider keeps the main agent's mode"); assert.equal(sonnet.model, "claude-sonnet-5-5");
});

function overseerHarness(dir: string, setting: () => { provider: string; model: string | null; thinking: string | null; mode: string | null }, loaded = false) {
  const created: Record<string, unknown>[] = []; const timelineReads: string[] = [];
  const agents: Record<string, { workspaceId: string }> = {};
  let n = 0;
  const paseo: OverseerPaseo = {
    workspaces: {
      async create(options) { const id = `w${++n}`; return { id, agents: { async create(o) { const aid = `ov${n}`; created.push(o); agents[aid] = { workspaceId: id }; return { id: aid }; } } }; },
      ref: () => ({ refresh: async () => ({ archivedAt: null }) }),
    },
    agents: { ref: (id: string) => ({
      refresh: async () => agents[id] ? { agent: { id, workspaceId: agents[id].workspaceId, status: "idle", archivedAt: null, ...(loaded ? { activeTurn: null } : {}) } } : null,
      send: async () => undefined,
      timeline: { refetch: async () => { timelineReads.push(id); return { entries: [] }; } },
    }) },
    providers: { listModels: async (p: string) => ({ models: p === "claude" ? [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5", isDefault: false }] : [{ id: "gpt-6.1-sol", isDefault: true }] }) },
  };
  const state: State = { version: 1, workspaces: [] };
  const overseer = new Overseer({ directory: dir, store: { snapshot: async () => state }, inbox: { list: async () => ({ rows: [] }), brief: async () => null, noteDelivery: async () => undefined },
    priorities: { read: async () => [] }, workspaces: async () => [], enabled: async () => true, agent: async () => setting(), paseoHome: dir });
  return { overseer, paseo, created, timelineReads };
}

test("Overseer: created with the configured model; a change offers a restart that hands off without waking it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ov-settings-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let setting = { provider: "claude", model: null as string | null, thinking: null as string | null, mode: "bypassPermissions" as string | null };
  const h = overseerHarness(dir, () => setting);
  await h.overseer.start(h.paseo);
  assert.equal((h.created[0].config as { provider: string }).provider, "claude/claude-opus-5-5", "default: the newest Opus");
  assert.equal((h.created[0].config as { modeId: string }).modeId, "bypassPermissions");
  assert.equal((await h.overseer.agentInfo()).restart, false);

  setting = { provider: "codex", model: "gpt-6-luna", thinking: "low", mode: "full-access" };
  const info = await h.overseer.agentInfo();
  assert.equal(info.restart, true); assert.deepEqual(info.running, { provider: "claude", model: "claude-opus-5-5" });
  assert.equal(h.created.length, 1, "a setting change never restarts it by itself");

  await h.overseer.restart(h.paseo);
  const second = h.created[1] as { config: Record<string, unknown>; prompt: string };
  assert.deepEqual([second.config.provider, second.config.modeId, second.config.thinkingOptionId], ["codex/gpt-6-luna", "full-access", "low"]);
  assert.match(second.prompt, /Handoff from the previous Overseer, which Tom replaced to run on GPT-6-Luna/);
  assert.deepEqual(h.timelineReads, [], "the unloaded old Overseer's timeline is never read");
  assert.equal((await h.overseer.agentInfo()).restart, false);
  assert.equal((await h.overseer.state()).generation, 2);
});

test("Overseer: an older state without a recorded agent counts as the default, so nobody gets a restart offer", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ov-legacy-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "overseer.json"), JSON.stringify({ version: 1, agentId: "old", workspaceId: "w0", startedAt: "2026-11-09T10:00:00Z", generation: 1, error: null }));
  const h = overseerHarness(dir, () => ({ provider: "claude", model: null, thinking: null, mode: "bypassPermissions" }));
  assert.equal((await h.overseer.agentInfo()).restart, false);
  const h2 = overseerHarness(dir, () => ({ provider: "claude", model: "claude-sonnet-5-5", thinking: null, mode: "bypassPermissions" }));
  assert.equal((await h2.overseer.agentInfo()).restart, true);
});

test("agent_settings is a read-only agent tool", async () => {
  assert.ok(READ_ONLY_TOOLS.includes("agent_settings"));
  const actions = new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [] }) }, agentSettings: { all: async () => ({ about: resolveRole(null, "about"), overseer: resolveRole(null, "overseer"), recovery: resolveRole(null, "recovery"), ranker: resolveRole(null, "ranker") }) } } as unknown as ConstructorParameters<typeof AgentActions>[0]);
  const out = await actions.run("agent-1", "agent_settings", {}) as { roles: { role: string; summary: string }[] };
  assert.deepEqual(out.roles.map(r => [r.role, r.summary]), [["about", "Claude · Haiku"], ["overseer", "Claude · Newest Opus"], ["recovery", "Same as main agent"], ["ranker", "Claude · Sonnet"]]);
});
