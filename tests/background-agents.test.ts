import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceRoot } from "../server/workspace-agent";
import { BackgroundAgents, backgroundAgentsFile, isBackgroundAgent } from "../server/background-agents";
import { DaemonDirectory } from "../server/directory";
import { Inbox, type AgentInfo, type Directory } from "../server/inbox";
import type { Sources } from "../server/inbox-classifier";
import { Wait } from "../server/wait";
import type { Agent, Daemon, withDaemon } from "../server/daemon";

/*
 * Invariant: a background agent (Paseo 0.16 `background: true`, a helper another plugin runs for itself) never gets
 * root-agent treatment from Follow-up: no action tools, no Wait, no needs_you / Stop-hook nudge, no inbox rows and no
 * directory row. On Paseo 0.15 the field is absent and every agent keeps today's behaviour.
 */

const snapshot = (id: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId: "w1", provider: "claude", cwd: "/fixture", createdAt: "2026-11-10T00:00:00Z", status: "idle", labels: {}, lastUserMessageAt: null, pendingPermissions: [], ...patch });

test("only an explicit background: true counts; an absent field (Paseo 0.15) or anything else doesn't", () => {
  assert.equal(isBackgroundAgent({ background: true }), true);
  for (const value of [undefined, false, "true", 1, null]) assert.equal(isBackgroundAgent({ background: value }), false, String(value));
  assert.equal(isBackgroundAgent(null), false); assert.equal(isBackgroundAgent(undefined), false);
});

test("a background agent is never a workspace root", async () => {
  const helper = { id: "helper", workspaceId: "w1", labels: {}, background: true };
  assert.equal(await isWorkspaceRoot(helper, async () => null), false);
  assert.equal(await isWorkspaceRoot({ ...helper, background: undefined }, async () => null), true, "0.15: no field, still a root");
});

test("only 'yes' is remembered: an early read before the snapshot exists doesn't stick", async () => {
  const found: string[] = [];
  const agents = new BackgroundAgents(id => { found.push(id); });
  let reads = 0; let created = false;
  // 0.16 order (probe): session_open first, where the new agent's snapshot has no flag yet; agent.created after.
  const refresh = async (id: string) => { reads++; return id === "helper" && created ? { background: true } : id === "helper" ? undefined : {}; };
  assert.equal(await agents.check("helper", refresh), false, "session_open: not known yet");
  created = true;
  assert.equal(await agents.check("helper", refresh), true, "agent.created: the flag shows up");
  assert.equal(await agents.check("helper", refresh), true);
  assert.equal(reads, 2, "background is fixed at creation, so it's read once it's known");
  assert.deepEqual(found, ["helper"], "and announced once");
  assert.equal(await agents.check("main", refresh), false);
  assert.equal(await agents.check("flaky", async () => { throw new Error("offline"); }), false, "unknown keeps today's behaviour");
  assert.equal(await agents.check("flaky", async () => ({ background: true })), true, "a failed read isn't cached");
});

test("Wait doesn't attach to a background agent's session", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-bg-wait-")); t.after(() => rm(root, { recursive: true, force: true }));
  const wait = new Wait(join(root, "wait"), { enabled: async () => true, config: async () => null }); t.after(() => wait.close());
  const request = { purpose: "interactive", provider: "claude", agentId: "helper", labels: {}, env: {}, tools: [], mcpServers: {} } as never;
  const opened = await wait.open(request);
  assert.ok((opened as { tools: unknown[] }).tools.length > 0, "a normal session gets Wait");
  assert.equal(await wait.open(request, { background: true }), request, "a background helper's session is left alone");
});

test("the directory never takes in a background agent from agent.created", async () => {
  const agents = [snapshot("main"), snapshot("helper", { background: true }), snapshot("later")];
  const listed = agents.filter(a => !a.background);
  const client = {
    fetchAgents: async () => ({ entries: listed.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    fetchWorkspaces: async () => ({ entries: [{ id: "w1", name: "w1", projectId: "p" }], pageInfo: { hasMore: false, nextCursor: null } }),
    listProjects: async () => ({ projects: [] }),
    fetchAgent: async (id: string) => { const agent = agents.find(a => a.id === id); return agent ? { agent } : null; },
  } as unknown as Daemon;
  const directory = new DaemonDirectory((async work => work(client)) as typeof withDaemon);
  await directory.read();
  listed.push(agents[2]);
  await directory.agentCreated({ id: "helper" } as never);
  await directory.agentCreated({ id: "later" } as never);
  const ids = (await directory.read()).agents.map(row => row.agent.id).sort();
  assert.deepEqual(ids, ["later", "main"], "no row to flicker in and out");
});

test("a background agent's turns raise no inbox rows; a root agent's still do", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-bg-inbox-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { workspaceId: "w1", parentAgentId: null, title: "Agent", status: "idle", archivedAt: null, updatedAt: "2026-11-10T00:00:00.000Z", lastUserMessageAt: null, requiresAttention: false, attentionReason: null };
  const agents: AgentInfo[] = [{ ...base, id: "main" }, { ...base, id: "helper", background: true }];
  const tails: Record<string, unknown[]> = {};
  const directory: Directory = {
    async agents() { return agents; }, async workspaces() { return [{ id: "w1", name: "w1" }]; },
    async agent(id) { return agents.find(a => a.id === id) ?? null; },
    async tail(id) { tails[id] = []; return []; }, async clearAttention() {},
  };
  const none: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };
  const inbox = new Inbox(dir, { enabled: async () => ({ enable_inbox: true, enable_inbox_pr_closed: true }), directory, sources: none, guard: async () => null, graceMs: 5, now: () => Date.parse("2026-11-10T00:01:00.000Z") });
  await inbox.store.mutate(s => { s.importedAt = "2026-11-10T00:00:00.000Z"; s.lastSeen = "2026-11-10T00:00:30.000Z"; s.primedAt = "2026-11-10T00:00:00.000Z"; s.notifiedAt = "2026-11-10T00:00:00.000Z"; });
  for (const id of ["helper", "main"]) {
    await inbox.turnStarted({ id, workspaceId: "w1" }, "t1");
    await inbox.turnEnded({ id, workspaceId: "w1" }, { kind: "completed" }, "t1");
  }
  const entries = (await inbox.store.snapshot()).entries;
  assert.equal(entries.helper, undefined, "no Needs-you row for a helper");
  assert.ok(entries.main, "the root agent's finish still flags");
  assert.equal("helper" in tails, false, "and its timeline isn't read");
});

test("session open asks about background before giving any root treatment", async () => {
  const source = await readFile(new URL("../index.server.ts", import.meta.url), "utf8");
  const open = source.slice(source.indexOf('server.before("agent.session_open"'));
  const guard = open.indexOf("isBackground(");
  assert.ok(guard > 0, "the session_open handler checks for a background agent");
  for (const later of ["FOLLOW_UP_OVERSEER", "isWorkspaceRoot(", "withTools("]) assert.ok(guard < open.indexOf(later), `before ${later}`);
  assert.match(source, /wait\.open\(.*\{ background: await isBackground\(/, "and Wait is told too");
});

test("the hook stays silent for a listed background agent: no context, no Stop-hook nudge", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-bg-hook-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugin-data/follow-up"); await mkdir(join(directory, "hook-state"), { recursive: true });
  await writeFile(join(directory, "agent-hook.mjs"), await readFile(resolve("server/agent-hook.mjs"), "utf8"));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000, clientEntry: "/fixture/client.js" }));
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces: [] }));
  await writeFile(join(directory, "brief.json"), JSON.stringify({ enable_inbox: true, enable_brief_nudge: true, pending: [] }));
  const fire = (agent: string, event: object) => new Promise<string>((ok, bad) => {
    const child = spawn(process.execPath, [join(directory, "agent-hook.mjs")], { env: { ...process.env, FOLLOW_UP_HOOK_IMPORT: "", PASEO_AGENT_ID: agent, FOLLOW_UP_BRIEF: "claude", FOLLOW_UP_RECOVERY: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", c => out += c); child.once("error", bad); child.once("exit", () => ok(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
  });
  const agents = new BackgroundAgents();
  const save = backgroundAgentsFile(directory, () => agents.ids);
  await agents.check("helper", async () => ({ background: true })); await save();
  await fire("helper", { hook_event_name: "UserPromptSubmit", prompt: "classify this" });
  assert.equal(await fire("helper", { hook_event_name: "Stop" }), "", "no needs_you nudge, so no extra model turn");
  await fire("root", { hook_event_name: "UserPromptSubmit", prompt: "do it" });
  assert.equal(JSON.parse(await fire("root", { hook_event_name: "Stop" })).decision, "block", "a root agent still gets it");
});
