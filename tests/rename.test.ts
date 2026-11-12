import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkName, lastRename, NAME_EXAMPLES, RENAME_DAILY_CAP, renamePrompt, undoRefusal, UNDO_WINDOW_MS, type RenameInputs } from "../shared/rename";
import { RenameService, RenameStore, renameDaemon, type WorkspaceTitles } from "../server/rename";
import { AiJobs, type Runner } from "../server/ai-jobs";
import { resolveRole } from "../shared/agent-settings";
import { AgentActions } from "../server/agent-actions";
import { rowMenu, ROW_ACTIONS } from "../shared/row-menu";

const inputs = (over: Partial<RenameInputs> = {}): RenameInputs => ({ current: "feature-branch-12", branch: "dev/retry-backoff", goal: "Make the billing worker back off on retries", summary: "Fixes the retry storm in the billing worker.", spec: null, prs: ["Back off billing retries"], linked: [{ key: "ABC-1234", title: "Retry storm in billing" }], agents: ["Billing retries"], ...over });

test("checkName: a short, verb-first name passes and is normalised", () => {
  assert.deepEqual(checkName("  Fix retry backoff   in the billing worker. "), { ok: true, name: "Fix retry backoff in the billing worker" });
  for (const e of NAME_EXAMPLES) assert.equal(checkName(e, { keys: ["ABC-1234"] }).ok, true, e);
});

test("checkName: length, words, quotes and branch junk are refused with a reason", () => {
  const no = (s: string, opts = {}) => { const r = checkName(s, opts); assert.equal(r.ok, false, s); return r.ok ? "" : r.reason; };
  assert.match(no(""), /Give it a name/);
  assert.match(no("x".repeat(61)), /60 characters/);
  assert.match(no("One two three four five six seven eight nine"), /8 words/);
  assert.match(no('"Fix retries"'), /quotes/);
  assert.match(no("`Fix retries`"), /quotes/);
  assert.match(no("feat/retry-backoff"), /branch/);
  assert.match(no("fix: retry backoff"), /branch/);
  assert.match(no("retry-backoff-billing"), /branch/);
  assert.match(no("retry_backoff"), /branch/);
  assert.match(no("Fix retries", { current: "fix retries" }), /name it has now/);
  // An apostrophe inside a word is English, not a quote.
  assert.equal(checkName("Don't retry on 4xx in billing").ok, true);
});

test("checkName: a linked issue key may lead and isn't counted; a key alone or an unlinked key is refused", () => {
  assert.equal(checkName("ABC-1234: Add CSV export to the audit log page", { keys: ["ABC-1234"] }).ok, true, "8 words after the key");
  assert.match((checkName("ABC-1234", { keys: ["ABC-1234"] }) as { reason: string }).reason, /after the issue key/);
  assert.match((checkName("ABC-1234:", { keys: ["ABC-1234"] }) as { reason: string }).reason, /after the issue key/);
  assert.match((checkName("XYZ-9: Fix retries", { keys: ["ABC-1234"] }) as { reason: string }).reason, /isn't linked/);
});

test("renamePrompt: the rules, the examples, the material and the retry reason, bounded", () => {
  const p = renamePrompt(inputs({ prs: Array.from({ length: 40 }, (_, i) => `PR ${i} ${"x".repeat(300)}`) }), { name: "feat/x", reason: "Use words, not a branch name." });
  for (const e of NAME_EXAMPLES) assert.ok(p.includes(e));
  assert.ok(p.includes("ABC-1234"));
  assert.ok(p.includes("Fixes the retry storm"));
  assert.ok(p.includes('was rejected: Use words, not a branch name.'));
  assert.ok(p.length < 4000, `prompt is ${p.length} chars`);
  assert.ok(renamePrompt(inputs({ linked: [] })).includes("Don't add an issue key"));
});

/** A Paseo with workspace titles in memory. */
function fakeTitles(start: Record<string, { title: string | null; name: string }>) {
  const rows = structuredClone(start); const sets: [string, string | null][] = [];
  const titles: WorkspaceTitles = { get: async id => rows[id] ? { ...rows[id] } : null, set: async (id, title) => { sets.push([id, title]); rows[id].title = title; } };
  return { titles, rows, sets };
}

async function setup(replies: string[], o: { room?: string | null; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rename-"));
  const seen: { model: string; prompt: string }[] = [];
  const runner: Runner = async input => { seen.push({ model: input.model, prompt: input.prompt }); return { text: replies.shift() ?? '{"name":"Fix retry backoff in billing"}', costUsd: 0.0005, inputTokens: 400, outputTokens: 12 }; };
  const t = fakeTitles({ w1: { title: null, name: "dev-retry-backoff" } });
  const store = new RenameStore(dir);
  const service = new RenameService({ store, jobs: new AiJobs({ runner }), role: async () => resolveRole(null, "about"), titles: t.titles, inputs: async (_id, current) => inputs({ current }), room: async () => o.room ?? null, now: o.now });
  return { dir, service, seen, t, store, done: () => rm(dir, { recursive: true, force: true }) };
}

test("suggest: Summaries' model (haiku), validated, one retry with the reason, then an error", async () => {
  const a = await setup(['{"name":"feat/retry-backoff"}', '{"name":"Fix retry backoff in billing"}']);
  const s = await a.service.status("w1", true);
  assert.equal(s.suggestion, "Fix retry backoff in billing");
  assert.equal(s.current, "dev-retry-backoff");
  assert.deepEqual(a.seen.map(x => x.model), ["haiku", "haiku"]);
  assert.match(a.seen[1].prompt, /was rejected: Use words, not a branch name/);
  await a.done();
  const b = await setup(['{"name":"ABC-1234"}', '{"name":""}']);
  await assert.rejects(b.service.status("w1", true), /Couldn't suggest a usable name/);
  await b.done();
});

test("suggest: the governor refuses up front and the daily cap holds at 30", async () => {
  const a = await setup([], { room: "The VM is short on memory right now." });
  await assert.rejects(a.service.status("w1", true), /short on memory/);
  assert.equal(a.seen.length, 0);
  await a.done();
  const b = await setup([]);
  for (let i = 0; i < RENAME_DAILY_CAP; i++) await b.service.status("w1", true);
  await assert.rejects(b.service.status("w1", true), /30 suggestions for today/);
  assert.equal(b.seen.length, RENAME_DAILY_CAP);
  await b.done();
});

// Invariant rename-is-always-undoable: every applied rename leaves a ledger entry whose Undo restores the exact name
// it replaced (a default name too), for 24 h, and never overwrites a rename made after it.
test("invariant rename-is-always-undoable: Undo restores the exact previous title, then nothing more", async () => {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const a = await setup([], { now: () => now });
  const r1 = await a.service.rename("w1", { title: "Fix retry backoff in billing" }, "developer");
  assert.deepEqual(r1, { workspaceId: "w1", title: "Fix retry backoff in billing", previous: "dev-retry-backoff", undone: false });
  const r2 = await a.service.rename("w1", { title: "Ship billing retry backoff" }, "agent:a1");
  assert.equal(r2.previous, "Fix retry backoff in billing");
  const ledger = JSON.parse(await readFile(join(a.dir, "rename.json"), "utf8"));
  assert.deepEqual(ledger.entries.map((e: { from: string | null; to: string; by: string }) => [e.from, e.to, e.by]), [[null, "Fix retry backoff in billing", "developer"], ["Fix retry backoff in billing", "Ship billing retry backoff", "agent:a1"]]);
  // Undo walks back one rename at a time, to the exact title (null: Paseo's default name).
  assert.equal((await a.service.rename("w1", { undo: true }, "developer")).title, "Fix retry backoff in billing");
  assert.equal((await a.service.rename("w1", { undo: true }, "developer")).title, "dev-retry-backoff");
  assert.deepEqual(a.t.sets.at(-1), ["w1", null]);
  await assert.rejects(a.service.rename("w1", { undo: true }, "developer"), /Nothing to undo/);
  await a.done();
});

test("invariant rename-is-always-undoable: never overwrites a later rename, expires after 24 h, pruned on write", async () => {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const a = await setup([], { now: () => now });
  await a.service.rename("w1", { title: "Fix retry backoff in billing" }, "developer");
  a.t.rows.w1.title = "Renamed by hand in Paseo";
  await assert.rejects(a.service.rename("w1", { undo: true }, "developer"), /renamed again since/);
  assert.equal(a.t.rows.w1.title, "Renamed by hand in Paseo");
  now += UNDO_WINDOW_MS + 1;
  assert.equal(lastRename(await a.store.read(), "w1", now), null);
  await a.service.rename("w1", { title: "Plan admin page for migrations" }, "developer");
  assert.equal((await a.store.read()).entries.length, 1, "the 24 h old entry was pruned on write");
  assert.equal(undoRefusal(null, "x"), "Nothing to undo: no rename in the last 24 hours.");
  // Edits run the same rules as suggestions.
  await assert.rejects(a.service.rename("w1", { title: "feat/x" }, "developer"), /branch/);
  await a.done();
});

// Invariant rename-never-wakes-an-agent: the only daemon calls a rename makes are fetch_workspaces narrowed to one id
// and set_workspace_title. A fetch_agent or a timeline read throws here.
test("invariant rename-never-wakes-an-agent: renameDaemon reaches only the workspace title", async () => {
  const calls: string[] = [];
  const rows = [{ id: "w1", name: "dev-retry-backoff", title: null as string | null }, { id: "w10", name: "other", title: "Other" }];
  const client = new Proxy({}, { get: (_t, prop: string) => {
    if (prop === "then") return undefined;
    if (prop === "fetchWorkspaces") return async (o: { filter?: { idPrefix?: string } }) => { calls.push(`fetchWorkspaces:${o.filter?.idPrefix}`); return { entries: rows.filter(r => r.id.startsWith(o.filter?.idPrefix ?? "")) }; };
    if (prop === "setWorkspaceTitle") return async (id: string, title: string | null) => { calls.push(`setWorkspaceTitle:${id}`); rows.find(r => r.id === id)!.title = title; return { title }; };
    throw new Error(`rename called daemon.${prop}, which can wake an agent`);
  } });
  let dirty = 0;
  const titles = renameDaemon(async work => work(client as never), () => dirty++);
  assert.deepEqual(await titles.get("w1"), { title: null, name: "dev-retry-backoff" });
  const dir = await mkdtemp(join(tmpdir(), "rename-"));
  const runner: Runner = async () => ({ text: '{"name":"Fix retry backoff in billing"}', costUsd: null, inputTokens: null, outputTokens: null });
  const service = new RenameService({ store: new RenameStore(dir), jobs: new AiJobs({ runner }), role: async () => resolveRole(null, "about"), titles, inputs: async (_id, current) => inputs({ current }), room: async () => null });
  const s = await service.status("w1", true);
  await service.rename("w1", { title: s.suggestion! }, "developer");
  await service.rename("w1", { undo: true }, "developer");
  assert.ok(calls.every(c => /^(fetchWorkspaces|setWorkspaceTitle):w1$/.test(c)), calls.join(", "));
  assert.equal(dirty, 2, "the directory re-reads after each title change");
  await rm(dir, { recursive: true, force: true });
});

test("ai_rename: dry run shows from and to, confirm renames as the agent; undo plans the restore", async () => {
  const calls: [string, unknown, unknown][] = [];
  let last: { from: string; to: string; at: string } | null = null;
  const rpc = {
    validate: async (_m: string, i: unknown) => i,
    call: async (method: string, input: unknown, actor?: unknown) => {
      calls.push([method, input, actor]);
      if (method === "follow.rename-status") return { workspaceId: "w1", current: "dev-retry-backoff", suggestion: (input as { suggest?: boolean }).suggest ? "Fix retry backoff in billing" : null, keys: [], last };
      return { workspaceId: "w1", title: "Fix retry backoff in billing", previous: "dev-retry-backoff", undone: false };
    },
  };
  const agent = new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [] }), mutate: async () => undefined }, inbox: { noteAction: async () => undefined }, rpc } as never);
  const plan = await agent.run("a1", "ai_rename", { workspaceId: "w1" }) as { dryRun: boolean; planId: string; from: string; to: string };
  assert.deepEqual([plan.dryRun, plan.from, plan.to], [true, "dev-retry-backoff", "Fix retry backoff in billing"]);
  assert.equal(calls.filter(c => c[0] === "follow.rename-workspace").length, 0, "the dry run renames nothing");
  await agent.run("a1", "ai_rename", { confirm: true, planId: plan.planId });
  const done = calls.find(c => c[0] === "follow.rename-workspace")!;
  assert.deepEqual(done[1], { workspaceId: "w1", title: "Fix retry backoff in billing" });
  assert.equal((done[2] as { kind: string; agentId: string }).agentId, "a1");
  await assert.rejects(agent.run("a1", "ai_rename", { workspaceId: "w1", undo: true }), /Nothing to undo/);
  last = { from: "dev-retry-backoff", to: "Fix retry backoff in billing", at: new Date().toISOString() };
  const undo = await agent.run("a1", "ai_rename", { workspaceId: "w1", undo: true }) as { to: string };
  assert.equal(undo.to, "dev-retry-backoff");
});

test("row menu: Rename with AI on every row with a workspace, through ai_rename", () => {
  const items = (s: Parameters<typeof rowMenu>[0]["s"]) => rowMenu({ s, flagged: false }).flatMap(x => x.items).map(i => i.key);
  assert.ok(items({ key: "ws:w1", agentId: null, workspaceId: "w1", title: "W", agent: null }).includes("rename_ai"));
  assert.ok(!items({ key: "agent:a1", agentId: "a1", workspaceId: null, title: "A", agent: null }).includes("rename_ai"));
  assert.deepEqual(ROW_ACTIONS.rename_ai, { tool: "ai_rename" });
});
