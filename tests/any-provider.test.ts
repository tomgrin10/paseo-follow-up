import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AiJobs, type Runner } from "../server/ai-jobs";
import { jobAgentRunner, JOBS_TITLE, JOB_LABEL, type JobPaseo } from "../server/job-agent";
import { providersFor } from "../server/agent-settings";
import { ROLE_DEFAULTS, type CatalogProvider } from "../shared/agent-settings";
import { modelTier, recommend, recommendAll, isRecommended, ROLE_NEED } from "../shared/recommend";
import { providerChecks, toolsCheck } from "../shared/onboarding";

// One-shot jobs on any Paseo provider (1.4.0): Claude and Codex keep their CLI; every other provider runs the job as
// a short-lived agent in a hidden background workspace. Setup and Settings recommend a model per job from the catalog.

const schema = z.object({ sentence: z.string() });

test("a role saved with a provider other than Claude or Codex runs through the generic path; Claude stays on its CLI", async () => {
  const seen: string[] = [];
  const tag = (name: string, text: string): Runner => async input => { seen.push(`${name}:${input.provider}/${input.model}`); return { text, costUsd: null, inputTokens: null, outputTokens: null }; };
  const jobs = new AiJobs({ runners: { claude: tag("cli", '{"sentence":"a"}') }, generic: tag("generic", '{"sentence":"b"}') });
  const a = await jobs.run({ name: "about", prompt: "p", schema, provider: "opencode", model: "qwen3-coder" });
  assert.deepEqual(a.ok && a.value, { sentence: "b" });
  const b = await jobs.run({ name: "about", prompt: "p", schema });
  assert.deepEqual(b.ok && b.value, { sentence: "a" });
  assert.deepEqual(seen, ["generic:opencode/qwen3-coder", "cli:claude/haiku"]);
  // Junk from any provider fails visibly; no retry at higher effort.
  const junk = await new AiJobs({ generic: tag("generic", "sure! here you go") }).run({ name: "about", prompt: "p", schema, provider: "copilot" });
  assert.equal(junk.ok, false); assert.equal(!junk.ok && junk.reason, "invalid-json"); assert.equal(seen.filter(s => s.startsWith("generic:copilot")).length, 1);
});

type Created = { options: Record<string, unknown>; archived: number };
function fakePaseo(result: { status: "idle" | "error" | "permission" | "timeout"; lastMessage: string | null; error?: string | null }, opts: { failCached?: boolean } = {}) {
  const workspaces: Record<string, unknown>[] = [];
  const agents: Created[] = [];
  let fail = !!opts.failCached;
  const agentsApi = (wsId: string) => ({
    async create(options: Record<string, unknown>) {
      if (fail && wsId === "ws-old") { fail = false; throw new Error("workspace archived"); }
      const entry: Created = { options: { ...options, workspaceId: wsId }, archived: 0 }; agents.push(entry);
      return { id: `agent-${agents.length}`, async waitForFinish() { return { error: null, ...result }; }, async archive() { entry.archived++; return { archivedAt: "now" }; } };
    },
  });
  const paseo: JobPaseo = {
    workspaces: {
      async create(options) { workspaces.push(options); const id = `ws-${workspaces.length}`; return { id, agents: agentsApi(id) }; },
      ref(id) { return { async refresh() { return {}; }, agents: agentsApi(id) }; },
    },
  };
  return { paseo, workspaces, agents };
}
const input = (provider = "opencode", model = "qwen3-coder") => ({ prompt: "P", system: "S", provider, model, thinking: null, timeoutMs: 5000, signal: new AbortController().signal });

test("the generic path: one hidden background workspace, one agent per job with the prompt in and the final message out, archived after", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fu-jobs-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fakePaseo({ status: "idle", lastMessage: '{"sentence":"x"}' });
  const run = jobAgentRunner({ paseo: () => f.paseo, directory: dir });
  assert.deepEqual(await run(input()), { text: '{"sentence":"x"}', costUsd: null, inputTokens: null, outputTokens: null });
  await run(input("copilot", ""));
  assert.equal(f.workspaces.length, 1, "the workspace is reused");
  assert.equal(f.workspaces[0].background, true); assert.equal(f.workspaces[0].title, JOBS_TITLE);
  assert.deepEqual(f.agents.map(a => (a.options.config as { provider: string }).provider), ["opencode/qwen3-coder", "copilot"]);
  const first = f.agents[0].options;
  assert.equal(first.prompt, "P"); assert.equal((first.config as { systemPrompt: string }).systemPrompt, "S"); assert.equal(first.autoArchive, true);
  assert.deepEqual(first.labels, { [JOB_LABEL]: "1" });
  assert.ok(f.agents.every(a => a.archived >= 1), "archived once it answered");
  assert.match(await readFile(join(dir, "jobs-workspace.json"), "utf8"), /ws-1/);
});

test("the generic path fails visibly: no Paseo yet, a permission prompt, an error, an empty answer; a gone workspace is made again once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fu-jobs-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(jobAgentRunner({ paseo: () => null, directory: dir })(input()), /isn't connected to Paseo/);
  for (const [r, message] of [[{ status: "permission", lastMessage: null }, /asked for a permission/], [{ status: "error", lastMessage: null, error: "model not found" }, /model not found/], [{ status: "idle", lastMessage: "  " }, /answered with nothing/], [{ status: "timeout", lastMessage: null }, /No answer within 5 s/]] as const) {
    const f = fakePaseo(r);
    await assert.rejects(jobAgentRunner({ paseo: () => f.paseo, directory: dir })(input()), message);
    assert.equal(f.agents[0].archived >= 1, true, "never left running");
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "jobs-workspace.json"), JSON.stringify({ workspaceId: "ws-old" }));
  const f = fakePaseo({ status: "idle", lastMessage: "{}" }, { failCached: true });
  await jobAgentRunner({ paseo: () => f.paseo, directory: dir })(input());
  assert.equal(f.workspaces.length, 1, "made a new one"); assert.equal(f.agents[0].options.workspaceId, "ws-1");
});

test("every role, jobs included, can pick any provider Paseo has", () => {
  const catalog = [provider("pi", [])];
  assert.equal(providersFor("about", catalog)[0].available, true);
  assert.equal(providersFor("ranker", catalog)[0].reason, null);
});

// ---------- recommendations ----------

const model = (id: string, extra: Partial<{ label: string; description: string; isDefault: boolean; thinking: string[] }> = {}) =>
  ({ id, label: extra.label ?? id, isDefault: !!extra.isDefault, ...(extra.description ? { description: extra.description } : {}), thinking: (extra.thinking ?? []).map(t => ({ id: t, label: t, isDefault: false })) });
function provider(id: string, models: ReturnType<typeof model>[], available = true): CatalogProvider {
  return { id, label: id, available, reason: available ? null : "Not installed", models, modes: [], defaultMode: null };
}
const CLAUDE = provider("claude", [model("haiku", { label: "Haiku" }), model("sonnet", { label: "Sonnet", isDefault: true }), model("claude-opus-5-5", { label: "Opus 5.5" })]);
const CODEX = provider("codex", [model("gpt-6-luna", { isDefault: true, thinking: ["low", "medium", "high"] }), model("gpt-6-luna-mini", { thinking: ["minimal", "low", "medium"] }), model("gpt-6-luna-max", { thinking: ["medium", "high", "xhigh"] })]);
const OPENCODE = provider("opencode", [
  model("qwen3-coder", { description: "A fast, low-cost coding model." }),
  model("kimi-k2", { description: "Our most capable model for complex tasks.", isDefault: true }),
  model("glm-4.6", { description: "Balanced everyday model." }),
]);
const COPILOT = provider("copilot", [model("gpt-4.1", { isDefault: true }), model("gemini-2.5-pro"), model("gemini-2.5-flash")]);

test("recommendations: the declared defaults stand whenever Claude is available, whatever else is there", () => {
  for (const catalog of [[CLAUDE], [CODEX, CLAUDE], [OPENCODE, COPILOT, CLAUDE, CODEX]]) {
    const recs = recommendAll(catalog);
    for (const role of ["about", "ranker", "overseer"] as const) {
      assert.deepEqual([recs[role].provider, recs[role].model, recs[role].source], [ROLE_DEFAULTS[role].provider, ROLE_DEFAULTS[role].model, "default"], role);
    }
    assert.equal(recs.recovery.same, true);
  }
});

test("recommendations: Codex only goes by name (mini, the default, max), with low effort for the small job", () => {
  const recs = recommendAll([CODEX, provider("claude", [], false)]);
  assert.deepEqual([recs.about.provider, recs.about.model, recs.about.thinking, recs.about.source], ["codex", "gpt-6-luna-mini", "minimal", "name"]);
  assert.deepEqual([recs.ranker.model, recs.ranker.source], ["gpt-6-luna", "name"]);
  assert.deepEqual([recs.overseer.model, recs.overseer.source], ["gpt-6-luna-max", "name"]);
  assert.equal(recs.recovery.same, true);
});

test("recommendations: OpenCode and Copilot go by the catalog's own wording first, names only after", () => {
  const recs = recommendAll([COPILOT, OPENCODE]);
  assert.deepEqual([recs.about.provider, recs.about.model, recs.about.source], ["opencode", "qwen3-coder", "metadata"]);
  assert.deepEqual([recs.overseer.provider, recs.overseer.model, recs.overseer.source], ["opencode", "kimi-k2", "metadata"]);
  assert.deepEqual([recs.ranker.provider, recs.ranker.model, recs.ranker.source], ["opencode", "glm-4.6", "metadata"]);
  // Copilot alone: names only; "gemini" is not "mini".
  const copilot = recommendAll([COPILOT]);
  assert.deepEqual([copilot.about.model, copilot.overseer.model, copilot.ranker.model], ["gemini-2.5-flash", "gemini-2.5-pro", "gpt-4.1"]);
  assert.equal(modelTier({ id: "gemini-2.5", label: "Gemini 2.5" }), null);
});

test("recommendations: nothing fits gives the provider's default and a hint; nothing available gives nothing", () => {
  const rec = recommend("about", [provider("pi", [model("pi-1", { isDefault: true })])]);
  assert.deepEqual([rec.provider, rec.model, rec.source], ["pi", null, "fallback"]); assert.match(rec.hint!, /says which is small/);
  assert.equal(recommend("overseer", [provider("pi", [])]).hint, "None of its models says which is strongest, so this is its default.");
  assert.equal(recommend("about", [provider("claude", [], false)]).source, "none");
  assert.ok(isRecommended({ provider: "codex", model: "gpt-6-luna-mini", same: false }, recommend("about", [CODEX])));
  assert.ok(!isRecommended({ provider: "codex", model: null, same: false }, recommend("about", [CODEX])));
  for (const line of Object.values(ROLE_NEED)) assert.doesNotMatch(line, /—|[\u{1F300}-\u{1FAFF}]/u, "plain copy");
});

// ---------- checks ----------

test("checks for a host with only OpenCode: the default helpers' Claude row fails and offers OpenCode; nothing names Claude or Codex as required", () => {
  const catalog = { error: null, providers: [{ id: "opencode", label: "OpenCode", available: true, reason: null }] };
  let rows = providerChecks(catalog, { claude: ["the Overseer", "Summaries", "AI priority"] });
  const claude = rows.find(r => r.id === "provider-claude")!;
  assert.equal(claude.state, "fail"); assert.match(claude.detail, /Paseo doesn't have it/); assert.match(claude.fix!.text, /switch those helpers to OpenCode/); assert.equal(claude.fix!.settings, "agents");
  assert.equal(rows.find(r => r.id === "provider-opencode")!.state, "ok");
  assert.equal(rows.find(r => r.id === "provider-codex"), undefined, "an unused provider Paseo doesn't have stays out");
  assert.equal(rows.find(r => r.id === "providers"), undefined, "a provider is ready");

  rows = providerChecks(catalog, { opencode: ["the Overseer", "Summaries", "AI priority"] });
  assert.deepEqual(rows.map(r => [r.id, r.state]), [["provider-opencode", "ok"]]);
  assert.match(rows[0].detail, /Used by the Overseer, Summaries and AI priority/);

  rows = providerChecks({ error: null, providers: [{ id: "opencode", label: "OpenCode", available: false, reason: "Not installed" }] }, { opencode: ["Summaries"] });
  assert.equal(rows[0].id, "providers"); assert.doesNotMatch(rows[0].detail, /Claude|Codex/);
  assert.match(rows.find(r => r.id === "provider-opencode")!.fix!.text, /Set up OpenCode/);

  const tools = toolsCheck({ config: { agents: { providers: { opencode: { paseoTools: { enabled: false } } } } }, nativeAgents: 1, hookError: null });
  assert.match(tools[0].detail, /off for OpenCode/);
});
