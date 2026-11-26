import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeServer, hangingHost, type Registered } from "./support/hanging-host";
import { seed } from "./support/seed";
import { FIXTURE } from "./support/sample-input";
import { OVERSEER_LABEL } from "../shared/overseer";

/**
 * Invariant (an-agent-on-any-provider-gets-follow-up): a developer whose agents all run on a provider other than
 * Claude Code and Codex (OpenCode here; Paseo 0.17 also runs Pi, Copilot, Cursor, Kimi, Kiro and any ACP agent) gets
 * Follow-up's core: its main agents get the tools and needs_you, the Overseer gets its routing tools, and every
 * helper left on its default runs on a provider the developer has. The real worker (contribute() from
 * index.server.ts) runs in a temp PASEO_HOME where Paseo lists only OpenCode and the claude and codex commands are
 * missing: nothing may try either.
 *
 * Before: tools, needs_you and the Overseer's tools attached only to Claude and Codex sessions, and every helper
 * defaulted to Claude whether or not it was installed.
 */

type Before = (input: { request: Record<string, unknown> }, context: { paseo: unknown }) => Promise<Record<string, unknown> | void>;

test("an-agent-on-any-provider-gets-follow-up: the worker with only OpenCode: tools, needs_you, the Overseer and the helpers all work", { timeout: 120_000 }, async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  // No Claude and no Codex: each command exists only to record that something tried it, and fails like a missing one.
  const tried = join(host.root, "tried");
  for (const tool of ["claude", "codex"]) {
    const bin = join(host.root, "bin", tool);
    await writeFile(bin, `#!/bin/sh\necho ${tool} >> '${tried}'\nexit 127\n`); await chmod(bin, 0o755);
  }
  await seed(host.directory);

  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const befores = new Map<string, Before>();
  (server as { before: unknown }).before = (name: string, handler: Before) => { befores.set(name, handler); return () => undefined; };
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());

  const agent = (id: string, labels: Record<string, string> = {}) => ({ id, workspaceId: FIXTURE.workspaceId, labels, parentAgentId: null, provider: "opencode" });
  const paseo = {
    agents: { ref: (id: string) => ({ refresh: async () => ({ agent: agent(id) }) }) },
    providers: {
      snapshot: async () => ({ entries: [{ provider: "opencode", status: "ready", label: "OpenCode", models: [
        { id: "small-fast", label: "Small Fast", description: "Fast and cheap for quick tasks", isDefault: false },
        { id: "coder", label: "Coder", isDefault: true },
        { id: "frontier", label: "Frontier", description: "Most capable model for complex reasoning", isDefault: false },
      ] }] }),
      waitForReady: async () => ({ entries: [] }),
    },
  };
  const run = (name: string, input: unknown) => { const h = handlers.get(name) as Registered; return h.input.parseAsync(input).then(i => h.run(i, { paseo })); };

  // Helpers: none was picked, Claude isn't here, so each runs on OpenCode, sized to the job, AI priority included.
  const view = await run("follow.agent-settings", { catalog: true }) as { roles: { role: string; provider: string; model: string | null; same: boolean }[] };
  const roles = Object.fromEntries(view.roles.map(r => [r.role, r]));
  assert.deepEqual([roles.about!.provider, roles.overseer!.provider], ["opencode", "opencode"], "no helper defaults to a provider the developer lacks");
  // OpenCode takes a session with every tool denied (job-agent.ts lockedConfig), so AI priority runs there too.
  assert.equal(roles.ranker!.provider, "opencode", "AI priority runs on OpenCode, with no tools");
  assert.equal(roles.about!.model, "small-fast"); assert.equal(roles.overseer!.model, "frontier");
  assert.equal(roles.recovery!.same, true, "recovery still copies the main agent, whatever it runs on");

  // The tracked main agent on OpenCode: the tools, and needs_you while the inbox is on.
  const open = befores.get("agent.session_open")!;
  assert.ok(open, "the worker hooks session open");
  const request = (agentId: string, labels: Record<string, string> = {}) => ({ agentId, provider: "opencode", cwd: "/fixture", workspaceId: FIXTURE.workspaceId, reason: "create", purpose: "interactive", env: {}, title: null, labels, tools: [], mcpServers: {} });
  const main = await open({ request: request(FIXTURE.agentId) }, { paseo }) as { tools: { name: string }[]; env: Record<string, string> };
  const names = main.tools.map(tool => tool.name);
  for (const tool of ["follow_workspace_status", "follow_sync_workspace", "follow_ask_question", "follow_needs_you", "follow_update_obligation"])
    assert.ok(names.includes(tool), `the main agent on OpenCode gets ${tool}`);
  assert.equal(main.env.FOLLOW_UP_BRIEF, "opencode");
  assert.equal(main.env.FOLLOW_UP_TOOLS, "native");

  // The Overseer on OpenCode gets its routing tools.
  const overseer = await open({ request: request("overseer-agent", { [OVERSEER_LABEL]: "1" }) }, { paseo }) as { tools: { name: string }[] };
  assert.ok(overseer.tools.some(tool => tool.name === "follow_send_to_agent"), "the Overseer on OpenCode routes");

  assert.equal(await readFile(tried, "utf8").catch(() => ""), "", "nothing tried Claude or Codex");
  await rm(tried, { force: true });
});

test("providerNotes: only what a provider the developer has can't do, at most two short lines, with the one thing to do", async () => {
  const { providerNotes, guardAction } = await import("../shared/provider-support");
  const p = (id: string, label: string, available = true, reason: string | null = null) => ({ id, label, available, reason });
  assert.deepEqual(providerNotes([p("claude", "Claude"), p("codex", "Codex")], "claude"), [], "nothing to say with Claude and Codex");
  // OpenCode and Pi get every feature: nothing to say (an-agent-on-any-provider-gets-follow-up).
  assert.deepEqual(providerNotes([p("opencode", "OpenCode"), p("pi", "Pi")], "pi"), [], "nothing to say with OpenCode and Pi");
  // A new non-Claude user: only a generic ACP agent, Claude and Codex turned off, Summaries on the ACP agent.
  const acp = providerNotes([p("claude", "Claude", false, "Turned off in Paseo"), p("codex", "Codex", false, "Turned off in Paseo"), p("pi", "Pi", false, "Not installed"), { ...p("acme-acp", "Acme ACP"), acp: true }], "acme-acp");
  assert.deepEqual(acp, [
    "Paseo doesn't pass Follow-up's instructions to Acme ACP yet, so it reads them through a tool at the start of each session.",
    "Summaries' linked issues, Compass and Ask read other people's words, so they run only where Follow-up can take every tool away. Turn on Claude or Codex in Paseo for Summaries to use them.",
  ]);
  assert.doesNotMatch(acp.join(" "), /Pick Claude|hooks/, "no dead end, no mechanism words");
  assert.equal(guardAction([p("copilot", "Copilot")]), "Install Claude Code, Codex, OpenCode or Pi");
  assert.equal(guardAction([p("pi", "Pi"), p("copilot", "Copilot")]), "Use Pi");
});

test("a helper that reads other people's words is never Recommended where it can't run, and shows off with no guarded provider", async () => {
  const { jobRow } = await import("../shared/job-rows");
  const { recommend } = await import("../shared/recommend");
  const { resolveRole, roleSummary, EMPTY_AGENT_SETTINGS } = await import("../shared/agent-settings");
  const prov = (id: string, available = true, reason: string | null = null) => ({ id, label: id === "acme-acp" ? "Acme ACP" : id === "codex" ? "Codex" : id === "claude" ? "Claude" : id, available, reason, models: [{ id: `${id}-1`, label: `${id} 1`, isDefault: true, thinking: [] }], modes: [], defaultMode: null });
  const cat = (...providers: ReturnType<typeof prov>[]) => ({ providers, error: null, fetchedAt: null });
  const ranker = (over: Record<string, unknown> = {}) => { const d = { ...resolveRole(EMPTY_AGENT_SETTINGS, "ranker"), ...over }; return { ...d, summary: roleSummary(d) }; };
  const none = cat(prov("claude", false, "Turned off in Paseo"), prov("codex", false, "Not installed"), prov("acme-acp"));
  assert.equal(recommend("ranker", none.providers).source, "none", "AI priority is never recommended on an unguarded provider");
  assert.equal(recommend("about", none.providers).provider, "acme-acp", "Summaries still runs there");
  const blocked = jobRow(ranker({ provider: "acme-acp", model: null }), none);
  assert.equal(blocked.blocked, true); assert.equal(blocked.recommended, false);
  assert.equal(blocked.pick, "No provider here can run it", "never a pick on a provider the developer lacks");
  assert.equal(blocked.notice?.tone, "warning");
  assert.match(blocked.notice!.text, /^AI priority reads other people's messages, so it runs only where Follow-up can keep it read-only \(Claude Code, Codex, OpenCode or Pi\)\. Turn on Claude in Paseo to use it\.$/);
  const withCodex = cat(prov("codex"), prov("acme-acp"));
  const moved = jobRow(ranker({ provider: "acme-acp", model: null }), withCodex);
  assert.equal(moved.blocked, false); assert.equal(moved.recommended, false); assert.equal(moved.rec?.provider, "codex");
  assert.match(moved.notice!.text, /^AI priority reads other people's messages, so it runs only where Follow-up can keep it read-only \(Claude Code, Codex, OpenCode or Pi\)\. Recommended: /);
});

test("isAcp follows Paseo's config: a provider that extends acp, directly or through another, is ACP", async () => {
  const { isAcp } = await import("../shared/provider-support");
  const config = { agents: { providers: { "acme-acp": { extends: "acp" }, "acme-2": { extends: "acme-acp" }, "acme-oc": { extends: "opencode" }, loop: { extends: "loop" } } } };
  assert.equal(isAcp("kiro"), true);
  assert.equal(isAcp("acme-acp"), false, "without the config an unknown id isn't assumed ACP");
  assert.equal(isAcp("acme-acp", config), true);
  assert.equal(isAcp("acme-2", config), true);
  assert.equal(isAcp("acme-oc", config), false);
  assert.equal(isAcp("loop", config), false, "a cycle ends");
});

test("runnableRole: only a role left on an unavailable default moves, and only to what Paseo has", async () => {
  const { runnableRole } = await import("../shared/job-rows");
  const { resolveRole } = await import("../shared/agent-settings");
  const cat = (providers: { id: string; available: boolean; reason?: string | null; models?: { id: string; label: string; isDefault: boolean; thinking: [] }[] }[], error: string | null = null) =>
    ({ providers: providers.map(p => ({ label: p.id, reason: p.available ? null : "Not installed", models: [], modes: [], defaultMode: null, ...p })), error, fetchedAt: null });
  const about = resolveRole(null, "about");
  const opencode = { id: "opencode", available: true, models: [{ id: "mini-fast", label: "Mini", isDefault: false, thinking: [] as [] }] };
  assert.equal(runnableRole(about, undefined, cat([{ id: "claude", available: true }, opencode])), about, "Claude here: the default stands");
  assert.deepEqual([runnableRole(about, undefined, cat([opencode])).provider, runnableRole(about, undefined, cat([opencode])).model], ["opencode", "mini-fast"]);
  assert.equal(runnableRole(about, undefined, null), about, "no catalog: unknown is not off");
  assert.equal(runnableRole(about, undefined, cat([], "offline")), about, "a failed read keeps the default");
  assert.equal(runnableRole(about, undefined, cat([opencode, { id: "claude", available: false, reason: "Still loading" }])), about, "still loading keeps the default");
  const picked = resolveRole({ version: 1, roles: { about: { provider: "claude" } } }, "about");
  assert.equal(runnableRole(picked, { provider: "claude" }, cat([opencode])), picked, "a picked provider is never moved");
  const recovery = resolveRole(null, "recovery");
  assert.equal(runnableRole(recovery, undefined, cat([opencode])), recovery, "recovery copies the main agent");
});
