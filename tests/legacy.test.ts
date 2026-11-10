import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as legacy from "../shared/legacy";
import { followShellCall, followToolName, parseBatchPrompt } from "../shared/chat";
import { reconcileHooks } from "../server/agent-hooks";
import { hookSource } from "../server/hook-source";
import { moveData, writeLegacyHeartbeat, MOVED_MARKER, dataDirs } from "../server/data-move";
import { WaitJobs } from "../server/wait-jobs";
import { moveView, moveLine } from "../shared/plugin-move";
import { PluginMove } from "../server/plugin-move";
import { runMove } from "../server/update-watchdog.mjs";

/**
 * What 1.x left behind keeps working in 2.0. Every 1.x spelling here comes from shared/legacy.ts, the one module that
 * still knows the old name (tests/no-legacy-name.test.ts).
 */
const OLD = legacy.LEGACY_PLUGIN_ID;

test("recovery agents 1.x started still count as recovery agents", () => {
  assert.equal(legacy.isRecovery({ [`${OLD}.recovery`]: "true" }), true);
  assert.equal(legacy.isRecovery({ [legacy.RECOVERY_LABEL]: "true" }), true);
  assert.equal(legacy.isRecovery({ other: "1" }), false);
  assert.equal(legacy.recoveryBatch({ [`${OLD}.recovery-batch`]: "b1" }), "b1");
  assert.equal(legacy.recoveryBatch({ [legacy.RECOVERY_BATCH_LABEL]: "b2" }), "b2");
});

test("1.x batch and recovery messages in old transcripts are still Follow-up's own", () => {
  for (const prefix of legacy.BATCH_PREFIXES) {
    const card = parseBatchPrompt(`${prefix} b1\n\n1. Fix CI\n2. Rebase`);
    assert.deepEqual(card?.tasks, ["Fix CI", "Rebase"], prefix);
    assert.equal(legacy.isPluginPrompt(`${prefix} b1\n\n1. x`), true, prefix);
  }
  for (const title of legacy.RECOVERY_TITLES) {
    assert.equal(parseBatchPrompt(`${title} b9\nWorkspace: w`)?.kind, "recovery", title);
    assert.equal(legacy.isRecoveryTaskFor(`${title} b9\nWorkspace: w`, "b9"), true, title);
    assert.equal(legacy.isRecoveryTaskFor(`${title} b8\nWorkspace: w`, "b9"), false);
  }
  assert.equal(legacy.isPluginPrompt("Please fix the build"), false);
  assert.equal(legacy.BATCH_PREFIXES.length, 4, "two current prefixes, two from 1.x");
});

test("1.x tool names and CLI calls in old transcripts are recognised", () => {
  for (const server of legacy.MCP_SERVERS) {
    assert.equal(followToolName(`mcp__${server}__register_pr`), "register_pr", server);
    assert.equal(followToolName(`${server}.register_pr`), "register_pr", server);
  }
  assert.equal(followToolName("mcp__paseo__follow_register_pr"), "register_pr");
  assert.equal(followToolName(`mcp__${OLD}x__register_pr`), null);
  for (const dir of [legacy.DATA_DIR, legacy.LEGACY_DATA_DIR])
    assert.deepEqual(followShellCall(`node ~/.paseo/plugin-data/${dir}/mcp.mjs call register_pr '{"number":1}'`), { tool: "register_pr", input: { number: 1 } }, dir);
});

test("sessions opened before the upgrade keep 1.x's env names, and both are read", () => {
  assert.equal(legacy.readEnv("RECOVERY", { [`${legacy.LEGACY_ENV_PREFIX}RECOVERY`]: "1" }), "1");
  assert.equal(legacy.readEnv("RECOVERY", { [`${legacy.ENV_PREFIX}RECOVERY`]: "1", [`${legacy.LEGACY_ENV_PREFIX}RECOVERY`]: "0" }), "1", "the current name wins");
  assert.equal(legacy.readEnv("RECOVERY", {}), undefined);
});

test("the hook reconcile drops 1.x's hook and adds the current one, once per event", () => {
  const old = { type: "command", command: `if [ -f '/x/agent-hook.mjs' ]; then node '/x/agent-hook.mjs'; fi ${legacy.LEGACY_HOOK_MARKER}` };
  const next = reconcileHooks({ hooks: { Stop: [{ hooks: [old] }, { hooks: [{ type: "command", command: "mine" }] }] } }, "/new/agent-hook.mjs");
  const commands = Object.values(next.hooks!).flat().flatMap(g => g.hooks ?? []).map(h => h.command ?? "");
  assert.equal(commands.filter(c => c.endsWith(legacy.LEGACY_HOOK_MARKER)).length, 0);
  assert.equal(commands.filter(c => c.endsWith(legacy.HOOK_MARKER)).length, 4, "SessionStart, UserPromptSubmit, PostToolUse, Stop");
  assert.ok(commands.includes("mine"), "a user's own hook stays");
  const removed = reconcileHooks(next, null);
  assert.equal(Object.values(removed.hooks!).flat().flatMap(g => g.hooks ?? []).filter(h => h.command?.includes("agent-hook.mjs")).length, 0);
});

test("the written hook keeps its shebang first and recognises 1.x's tool and env names", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-legacy-hook-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const written = legacy.withRuntimePrelude(hookSource);
  assert.ok(written.startsWith("#!"), "shebang stays on line 1");
  assert.match(written.split("\n")[1]!, /^globalThis\.followUpRuntime = /);
  await writeFile(join(dir, "agent-hook.mjs"), written);
  const saved = process.env[`${legacy.ENV_PREFIX}HOOK_IMPORT`];
  process.env[`${legacy.ENV_PREFIX}HOOK_IMPORT`] = "1";
  try {
    const hook = await import(pathToFileURL(join(dir, "agent-hook.mjs")).href) as { isFollowTool(t: string): boolean; isBridgeCall(a: string, p: string): boolean };
    assert.equal(hook.isFollowTool(`mcp__${legacy.LEGACY_MCP_SERVER}__needs_you`), true);
    assert.equal(hook.isFollowTool(`mcp__${legacy.MCP_SERVER}__needs_you`), true);
    assert.equal(hook.isBridgeCall(`"$${legacy.LEGACY_ENV_PREFIX}CLI" call workspace_status '{}'`, "/nowhere"), true);
    assert.equal(hook.isBridgeCall(`"$${legacy.ENV_PREFIX}CLI" call workspace_status '{}'`, "/nowhere"), true);
  } finally { if (saved === undefined) delete process.env[`${legacy.ENV_PREFIX}HOOK_IMPORT`]; else process.env[`${legacy.ENV_PREFIX}HOOK_IMPORT`] = saved; }
});

test("the worker and the bridge call the plugin under either id, new first", async () => {
  const calls: string[] = [];
  const under = (installed: string) => async (id: string) => { calls.push(id); if (id !== installed) throw new Error(`Request failed: Plugin is not available: ${id}`); return id; };
  assert.equal(await legacy.invokeSelf(under(legacy.PLUGIN_ID)), legacy.PLUGIN_ID);
  assert.equal(await legacy.invokeSelf(under(OLD)), OLD);
  assert.deepEqual(calls, [legacy.PLUGIN_ID, legacy.PLUGIN_ID, OLD]);
  await assert.rejects(legacy.invokeSelf(async () => { throw new Error("Unknown RPC"); }), /Unknown RPC/, "a real error isn't retried");
  assert.equal(legacy.ownRow([{ id: OLD, status: "disabled" }, { id: legacy.PLUGIN_ID, status: "running" }])?.id, legacy.PLUGIN_ID);
  assert.equal(legacy.ownRow([{ id: OLD, status: "running" }])?.id, OLD);
  assert.equal(legacy.ownRow([{ id: "other", status: "running" }]), undefined);
});

async function oldHome(t: { after(fn: () => unknown): void }) {
  const home = await mkdtemp(join(tmpdir(), "follow-legacy-move-")); t.after(() => rm(home, { recursive: true, force: true }));
  const { legacy: old } = dataDirs(home);
  await mkdir(join(old, "hook-state"), { recursive: true });
  await mkdir(join(old, "wait/jobs/agent-1/0f8fad5b-d9cb-469f-a165-70867728950e"), { recursive: true });
  await writeFile(join(old, "state.json"), JSON.stringify({ version: 1, workspaces: [{ id: "w1" }] }));
  await writeFile(join(old, "hook-state/sync-a.json"), "{}");
  await writeFile(join(old, "mcp.mjs"), "// 1.x bridge\n");
  await writeFile(join(old, "worker.lock"), "999999999:dead");
  await writeFile(join(old, "heartbeat.json"), "{}");
  await writeFile(join(old, "wait/jobs/agent-1/0f8fad5b-d9cb-469f-a165-70867728950e/job.json"), JSON.stringify({ version: 1, id: "0f8fad5b-d9cb-469f-a165-70867728950e", agentId: "agent-1", cwd: "/w", description: "build", createdAt: "2026-11-10T00:00:00.000Z" }));
  return home;
}

test("data move: copies 1.x's directory once, skips live files, keeps the old one, and is idempotent", async t => {
  const home = await oldHome(t);
  const { directory, legacy: old } = dataDirs(home);
  const first = moveData(home, { version: "2.0.0", waitMs: 0 });
  assert.equal(first.status, "moved");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).workspaces, [{ id: "w1" }]);
  assert.ok(existsSync(join(directory, "hook-state/sync-a.json")));
  assert.equal(existsSync(join(directory, "worker.lock")), false, "a live process's lock isn't copied");
  assert.equal(existsSync(join(directory, "heartbeat.json")), false);
  assert.equal(JSON.parse(await readFile(join(directory, MOVED_MARKER), "utf8")).version, "2.0.0");
  assert.ok(existsSync(join(old, "state.json")), "the old directory stays");
  assert.match(await readFile(join(old, "mcp.mjs"), "utf8"), /followUpRunAsBridge = true;\nawait import\(.*\/plugin-data\/follow-up\/mcp\.mjs/);
  assert.deepEqual((await readdir(join(home, "plugin-data"))).sort(), [legacy.DATA_DIR, legacy.LEGACY_DATA_DIR].sort(), "no temporary copy left");
  await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, workspaces: [] }));
  assert.equal(moveData(home, { waitMs: 0 }).status, "present", "a second start copies nothing");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).workspaces, []);
  writeLegacyHeartbeat(home, JSON.stringify({ version: "2.0.0", at: 1, error: null }));
  assert.equal(JSON.parse(await readFile(join(old, "heartbeat.json"), "utf8")).version, "2.0.0", "the 1.x installer's probation sees 2.0 report in");
});

test("data move: after a rollback to 1.x, a later 2.0 copies 1.x's newer data again and keeps the stale copy", async t => {
  const home = await oldHome(t);
  const { directory, legacy: old } = dataDirs(home);
  assert.equal(moveData(home, { waitMs: 0 }).status, "moved");
  // 1.x runs again and keeps working after the rollback.
  await writeFile(join(old, "state.json"), JSON.stringify({ version: 1, workspaces: [{ id: "w1" }, { id: "w2" }] }));
  const later = new Date(Date.now() + 5_000); const { utimes } = await import("node:fs/promises"); await utimes(join(old, "state.json"), later, later);
  const again = moveData(home, { waitMs: 0 });
  assert.equal(again.status, "moved");
  assert.ok(again.replaced && existsSync(join(again.replaced, "state.json")), "the stale copy is kept");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).workspaces.map((w: { id: string }) => w.id), ["w1", "w2"]);
  assert.equal(moveData(home, { waitMs: 0 }).status, "present", "then it settles");
});

test("data move: a fresh install has nothing to move", async t => {
  const home = await mkdtemp(join(tmpdir(), "follow-legacy-fresh-")); t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(moveData(home, { waitMs: 0 }).status, "fresh");
  writeLegacyHeartbeat(home, "{}");
  assert.equal(existsSync(dataDirs(home).legacy), false, "no old directory is created");
});

test("a Wait job prepared before the move is still found in 1.x's directory", async t => {
  const home = await oldHome(t);
  moveData(home, { waitMs: 0 });
  const { directory, legacy: old } = dataDirs(home);
  await rm(join(directory, "wait"), { recursive: true, force: true }); // the runner kept writing to the old path
  const jobs = new WaitJobs(join(directory, "wait"), join(old, "wait"));
  const status = await jobs.status({ id: "agent-1", cwd: "/w" }, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(status.status, "prepared");
  await assert.rejects(new WaitJobs(join(directory, "wait")).status({ id: "agent-1", cwd: "/w" }, "0f8fad5b-d9cb-469f-a165-70867728950e"), /Unknown job/);
});

test("move view: one quiet line per phase, and a failed move isn't retried by itself", () => {
  const view = (patch: Partial<Parameters<typeof moveView>[0]>) => moveView({ id: OLD, installKind: "npm", events: [], moving: false, now: 10_000, retryAsked: false, ...patch });
  assert.equal(view({}).phase, "waiting");
  assert.equal(view({ moving: true }).phase, "moving");
  assert.equal(view({ installKind: "git" }).phase, "manual");
  assert.match(moveLine(view({ installKind: "directory" }))!, /paseo plugin remove/);
  assert.equal(view({ events: [{ at: 1, event: "move-rolled-back", reason: "It didn't start within two minutes." }] }).phase, "rolled-back");
  assert.equal(view({ events: [{ at: 1, event: "move-rolled-back" }], retryAsked: true }).phase, "waiting");
  assert.equal(view({ id: legacy.PLUGIN_ID, events: [{ at: 9_000, event: "moved" }] }).phase, "moved");
  assert.equal(moveLine(view({ id: legacy.PLUGIN_ID, events: [{ at: 9_000, event: "moved" }] })), "Moved to Follow-up's new plugin id.");
  assert.equal(view({ id: legacy.PLUGIN_ID }).phase, "none");
  assert.equal(moveLine(view({ id: legacy.PLUGIN_ID })), null);
});

test("the move starts only under the old id, from npm, when quiet and no installer is alive", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-legacy-decide-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1_000_000; let busy: { kind: "agent"; count: number }[] = []; let alive = false; const spawned: unknown[] = [];
  let id: string = OLD; let installKind = "npm";
  const timers: (() => void)[] = [];
  const move = new PluginMove({ directory: dir, self: async () => ({ id, path: "/p", version: "2.0.0", installKind: installKind as "npm", status: "running", error: null }), busy: async () => busy, installerAlive: async () => alive,
    spawn: async job => { spawned.push(job); return true; }, now: () => now, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => undefined, quietMs: 60_000 });
  await move.evaluate();
  assert.equal(spawned.length, 0, "a quiet stretch first, like an update");
  now += 61_000; busy = [{ kind: "agent", count: 1 }];
  await move.evaluate();
  assert.equal(spawned.length, 0, "never while an agent is mid-turn");
  busy = []; now += 61_000; alive = true;
  await move.evaluate();
  assert.equal(spawned.length, 0, "never while an installer is alive (a 1.x one may be on probation)");
  alive = false;
  await move.evaluate();
  assert.deepEqual(spawned, [{ oldId: OLD, newId: legacy.PLUGIN_ID, version: "2.0.0" }]);
  await writeFile(join(dir, "updates.jsonl"), JSON.stringify({ at: now, from: "2.0.0", to: "2.0.0", event: "move-rolled-back", reason: "It failed to load." }) + "\n");
  now += 200_000;
  await move.evaluate();
  assert.equal(spawned.length, 1, "a rolled-back move waits for Try again");
  assert.equal((await move.retry()).phase, "waiting");
  now += 61_000;
  await move.evaluate();
  assert.equal(spawned.length, 2, "Try again moves at the next quiet moment");
  id = legacy.PLUGIN_ID;
  await assert.rejects(move.retry(), /already runs under its new plugin id/);
  id = OLD; installKind = "git";
  assert.equal((await move.view()).phase, "manual");
});

function fakeDaemon(opts: { failInstall?: boolean; newStatus?: string } = {}) {
  const calls: string[] = [];
  const rows = new Map<string, { id: string; status: string; installation: { currentRevision: string } }>([[OLD, { id: OLD, status: "running", installation: { currentRevision: "2.0.0" } }]]);
  const client = {
    disablePlugin: async (id: string) => { calls.push(`disable ${id}`); rows.get(id)!.status = "disabled"; },
    enablePlugin: async (id: string) => { calls.push(`enable ${id}`); rows.get(id)!.status = "running"; },
    removePlugin: async (id: string) => { calls.push(`remove ${id}`); rows.delete(id); },
    installPluginSource: async ({ source }: { source: string }) => { calls.push(`install ${source}`); if (opts.failInstall) throw new Error("npm said no"); rows.set(legacy.PLUGIN_ID, { id: legacy.PLUGIN_ID, status: opts.newStatus ?? "running", installation: { currentRevision: "2.0.0" } }); },
    listPlugins: async () => [...rows.values()],
    close: async () => undefined,
  };
  return { client, calls, rows };
}

for (const [name, opts, outcome, order] of [
  ["moves: settings, disable old, install new, probation, remove old", {}, "moved", ["disable OLD", "install npm:paseo-follow-up@2.0.0", "remove OLD"]],
  ["install fails: the old id runs again", { failInstall: true }, "move-rolled-back", ["disable OLD", "install npm:paseo-follow-up@2.0.0", "remove NEW", "enable OLD"]],
  ["the new id fails probation: removed, and the old id runs again", { newStatus: "failed" }, "move-rolled-back", ["disable OLD", "install npm:paseo-follow-up@2.0.0", "remove NEW", "enable OLD"]],
] as const) test(`runMove ${name}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-legacy-run-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = join(dir, "plugin-settings"); await mkdir(join(settings, OLD), { recursive: true });
  await writeFile(join(settings, OLD, "display.json"), "{\"x\":1}");
  const { client, calls } = fakeDaemon(opts);
  let now = 0;
  const result = await runMove({ kind: "move", directory: dir, oldId: OLD, newId: legacy.PLUGIN_ID, packageName: "paseo-follow-up", version: "2.0.0", settingsRoot: settings, clientEntry: "", daemon: {}, timing: { probationMs: 30, loadTimeoutMs: 1_000, watchEveryMs: 10 } },
    { connect: async () => client, now: () => now, sleep: async ms => { now += ms; if (now >= 10) await writeFile(join(dir, "heartbeat.json"), JSON.stringify({ version: "2.0.0", at: now, error: null })); } });
  assert.equal(result, outcome);
  assert.deepEqual(calls, order.map(c => c.replace("OLD", OLD).replace("NEW", legacy.PLUGIN_ID)));
  assert.equal(JSON.parse(await readFile(join(settings, legacy.PLUGIN_ID, "display.json"), "utf8")).x, 1, "settings copied before the old id is removed");
  const events = (await readFile(join(dir, "updates.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l).event);
  assert.equal(events[0], "moving"); assert.equal(events.at(-1), outcome);
  assert.equal((await stat(join(settings, OLD))).isDirectory(), true, "the old settings stay (Paseo removes them with the old id)");
});
