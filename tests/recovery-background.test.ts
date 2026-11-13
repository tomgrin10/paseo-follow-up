import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * recovery-is-quiet-keeps-its-tools-and-unloads (Paseo 0.16 plan #8, 2026-11-13). The recovery agent opened a tab,
 * showed Running and pinged the developer's phone. On a host with features.backgroundAgents it is created
 * `background: true`; Paseo 0.15 is untouched. Three promises:
 *  - quiet: background only when the host says so, never on 0.15 (the SDK would throw);
 *  - keeps its tools: Follow-up skips background agents at session_open, except the agent its own record names as a
 *    recovery recipient (never by labels, which any plugin can write);
 *  - unloads, meaning host-collectable: no plugin API closes an agent by id, so a settled batch must leave nothing that
 *    vetoes Paseo's idle-runtime cleanup (no running turn, pending permission or live background work).
 */
const home = await mkdtemp(join(tmpdir(), "follow-recovery-bg-"));
process.env.PASEO_HOME = home; // prepareRecovery writes its context file under PASEO_HOME: never ~/.paseo.
const { PaseoGateway, recoveryCollectable, withBackground } = await import("../server/daemon");
const { mayEnroll, recordedRecoveryAgent } = await import("../server/tasks");
const { SessionGuard } = await import("../server/session-guard");
const { HistoryCache } = await import("../server/history-cache");
const { clock, workspace } = await import("./fixtures");
test.after(() => rm(home, { recursive: true, force: true }));
// The main agent's saved configuration, which recovery copies (server/recovery-config.ts): synthetic.
await mkdir(join(home, "agents", "fixture"), { recursive: true });
await writeFile(join(home, "agents", "fixture", "main-agent.json"), JSON.stringify({ id: "main-agent", workspaceId: "w1", cwd: "/fixture", provider: "claude", config: { modeId: "default" } }));

type Created = Record<string, unknown>;
function gatewayWith(background: boolean | "throws") {
  const created: Created[] = []; const timelineReads: string[] = [];
  const main = { id: "main-agent", workspaceId: "w1", provider: "claude", cwd: "/fixture", createdAt: "2026-01-01T00:00:00Z", status: "idle", labels: {}, lastUserMessageAt: null, pendingPermissions: [] };
  const client = {
    fetchAgent: async (id: string) => id === main.id ? { agent: main } : null,
    fetchAgentTimeline: async (id: string) => { timelineReads.push(id); throw new Error("an unloaded main agent's timeline is never read"); },
    createAgent: async (options: Created) => { created.push(options); return { id: `recovery-${created.length}` }; },
  };
  const gateway = new PaseoGateway((async (work: (c: unknown) => unknown) => work(client)) as never, new SessionGuard(join(home, "guard")), async () => false, new HistoryCache(null), () => clock);
  gateway.backgroundAgents = async () => { if (background === "throws") throw new Error("no server_info"); return background; };
  const w = workspace({ id: "w1", mainAgentId: "main-agent" });
  const batch = { id: "batch-1", state: "pending", tasks: [{ kind: "inventory", target: "workspace", key: "inventory:w1" }] } as never;
  return { gateway, created, timelineReads, prepare: () => gateway.prepareRecovery(w, batch) };
}

test("recovery-is-quiet-keeps-its-tools-and-unloads: the recovery agent is background only on a host with features.backgroundAgents", async () => {
  const on = gatewayWith(true); await on.prepare();
  const off = gatewayWith(false); await off.prepare();
  const unknown = gatewayWith("throws"); await unknown.prepare();
  assert.equal(on.created[0].background, true, "0.16: created background");
  assert.equal("background" in off.created[0], false, "0.15: the option never appears");
  assert.equal("background" in unknown.created[0], false, "an unreadable server_info falls back to 0.15");
  const { background: _, ...rest } = on.created[0];
  assert.deepEqual(rest, off.created[0], "everything else (labels, tools, prompt, idempotency) is the same on both hosts");
  assert.deepEqual([...on.timelineReads, ...off.timelineReads], [], "an unloaded main agent is never read, so never woken");
  const same = { a: 1 };
  assert.equal(withBackground(same, false), same, "0.15 gets the very same options object");
});

test("recovery-is-quiet-keeps-its-tools-and-unloads: the session_open exemption is Follow-up's record, never labels", async () => {
  const recovery = { id: "batch-1", recipientAgentId: "recovery-1", tasks: [{ kind: "inventory" }] };
  const ordinary = { id: "batch-2", recipientAgentId: "helper-1", tasks: [{ kind: "checks" }] };
  const state = { workspaces: [{ batches: [recovery, ordinary] }] } as never;
  assert.equal(recordedRecoveryAgent(state, "recovery-1"), true, "the recorded recipient keeps its tools on a second session");
  assert.equal(recordedRecoveryAgent(state, "helper-1"), false, "a recipient of a non-recovery batch is not exempt");
  assert.equal(recordedRecoveryAgent(state, "labelled-impostor"), false, "a background agent with recovery labels but no recorded recipient gets the request back untouched");
  const source = await readFile(join(import.meta.dirname, "../index.server.ts"), "utf8");
  const line = source.split("\n").find(l => /isBackground\(request\.agentId, paseo\)/.test(l) && /return request/.test(l));
  assert.ok(line, "session_open still skips background agents");
  assert.match(line!, /!recordedRecoveryAgent\(await store\.snapshot\(\), request\.agentId\)/, "exempting only the recorded recovery recipient");
  assert.doesNotMatch(line!, /isRecovery\(request\.labels\)/, "never by labels");
});

test("recovery-is-quiet-keeps-its-tools-and-unloads: the background recovery agent can still refine the goal (enroll_workspace)", async () => {
  const state = { workspaces: [{ batches: [{ id: "batch-1", recipientAgentId: "recovery-1", tasks: [{ kind: "inventory" }] }] }] } as never;
  const agent = (id: string, background?: boolean) => ({ id, workspaceId: "w1", labels: {}, ...(background === undefined ? {} : { background }) });
  const noParent = async () => null;
  assert.equal(await mayEnroll(state, agent("recovery-1", true), noParent), true, "0.16: the recorded recovery recipient, though background, may enroll (the batch blocked without this)");
  assert.equal(await mayEnroll(state, agent("other-plugin-helper", true), noParent), false, "another plugin's background helper still may not");
  assert.equal(await mayEnroll(state, agent("main-agent"), noParent), true, "0.15 and roots: unchanged");
  assert.equal(await mayEnroll(state, { ...agent("recovery-1", true), workspaceId: null }, noParent), false, "no workspace, no enroll");
  const source = await readFile(join(import.meta.dirname, "../index.server.ts"), "utf8");
  assert.match(source, /if \(!agent\?\.workspaceId \|\| !await mayEnroll\(await store\.snapshot\(\), agent,/, "the enroll RPC asks mayEnroll");
});

test("recovery-is-quiet-keeps-its-tools-and-unloads: a settled batch leaves its agent host-collectable; a lingering turn, permission or job is caught", () => {
  const idle = { status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], backgroundWork: { count: 0 } };
  const cases: [string, typeof idle | Record<string, unknown>, boolean][] = [
    ["after acknowledge", idle, true],
    ["after a failed turn", { ...idle, lastError: "turn failed" }, true],
    ["0.15 (no backgroundWork field)", { status: "idle", activeTurn: null, pendingPermissions: [] }, true],
    ["a pending permission", { ...idle, pendingPermissions: [{ id: "p1" }] }, false],
    ["a running turn", { ...idle, status: "running", activeTurn: { id: "t1" } }, false],
    ["a live background job", { ...idle, backgroundWork: { count: 1 } }, false],
  ];
  const wrong = cases.filter(([, agent, want]) => recoveryCollectable(agent as never) !== want).map(([label]) => label);
  assert.deepEqual(wrong, []);
});
