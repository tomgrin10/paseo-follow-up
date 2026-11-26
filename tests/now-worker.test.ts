import test from "node:test";
import assert from "node:assert/strict";
import { fakeServer, hangingHost, type Registered } from "./support/hanging-host";
import { seed } from "./support/seed";
import { FIXTURE } from "./support/sample-input";

/**
 * The line's agent input and its agent tool, on the real worker (contribute() from index.server.ts): sync_workspace's
 * optional `milestone` is stored per agent on the workspace record (omitted keeps it, null clears it), and
 * workspace_now returns the same lines every surface draws (agent parity). Provider-neutral: the field rides the
 * sync_workspace call every provider already makes (native tool or the CLI bridge).
 */
type Before = (input: { request: Record<string, unknown> }, context: { paseo: unknown }) => Promise<Record<string, unknown> | void>;
type Line = { agentId: string; role: string; work: { text: string; source: string; position: { at: number; of: number } | null } | null; state: { kind: string; text: string } };

test("sync_workspace milestone is stored per agent, and workspace_now returns the line", { timeout: 120_000 }, async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  await seed(host.directory);
  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const befores = new Map<string, Before>();
  (server as { before: unknown }).before = (name: string, handler: Before) => { befores.set(name, handler); return () => undefined; };
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());
  const agent = (id: string) => ({ id, workspaceId: FIXTURE.workspaceId, labels: {}, parentAgentId: null, provider: "pi", status: "idle" });
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: agent(id) }) }) } };
  const run = (name: string, input: unknown) => { const h = handlers.get(name) as Registered | undefined; assert.ok(h, `${name} is registered`); return h.input.parseAsync(input).then(i => h.run(i, { paseo })); };
  const stored = async () => ((await run("follow.get", { workspaceId: FIXTURE.workspaceId })) as { workspace: { milestones?: Record<string, { now: string; done: string[]; next: string[] }> } }).workspace.milestones;

  await run("follow.sync", { agentId: FIXTURE.agentId, summary: "Synced", milestone: { now: "Capping the retry gap", done: ["Reading the gateway logs"], next: ["Shipping the fix", "Verifying in staging"] } });
  assert.deepEqual((await stored())?.[FIXTURE.agentId]?.now, "Capping the retry gap");
  const view = await run("follow.workspace-now", { agentId: FIXTURE.agentId }) as { workspaceId: string; agents: Line[] };
  assert.equal(view.workspaceId, FIXTURE.workspaceId);
  const main = view.agents.find(a => a.agentId === FIXTURE.agentId)!;
  assert.equal(main.role, "main");
  assert.deepEqual([main.work?.text, main.work?.source, main.work?.position], ["Capping the retry gap", "stated", { at: 2, of: 4 }]);

  // Omitted keeps the last one; null clears it.
  await run("follow.sync", { agentId: FIXTURE.agentId, summary: "Synced again" });
  assert.equal((await stored())?.[FIXTURE.agentId]?.now, "Capping the retry gap");
  await run("follow.sync", { agentId: FIXTURE.agentId, summary: "Cleared", milestone: null });
  assert.equal((await stored())?.[FIXTURE.agentId], undefined);

  // The tool is attached to the main agent on any provider.
  const open = befores.get("agent.session_open")!;
  const session = await open({ request: { agentId: FIXTURE.agentId, provider: "pi", cwd: "/fixture", workspaceId: FIXTURE.workspaceId, reason: "create", purpose: "interactive", env: {}, title: null, labels: {}, tools: [], mcpServers: {} } }, { paseo }) as { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] };
  const names = session.tools.map(tool => tool.name);
  assert.ok(names.includes("follow_workspace_now"), "workspace_now is attached");
  const sync = session.tools.find(tool => tool.name === "follow_sync_workspace");
  assert.ok(sync, "sync_workspace is attached");
});
