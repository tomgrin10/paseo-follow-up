import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeNeeds, needsYou, workspaceSnoozed } from "../shared/attention";
import { readFile } from "node:fs/promises";
import { buildHome } from "../shared/home";
import { resolveUntil } from "../shared/inbox";
import { flatItems, rowMenu, type RowMenuInput } from "../shared/row-menu";
import { AgentActions, controlWorkspace, type AgentActionDeps } from "../server/agent-actions";
import { Store } from "../server/store";
import type { InboxAction } from "../server/inbox";
import type { State } from "../shared/model";
import { workspace } from "./fixtures";

/**
 * Later on a workspace-only Needs-you row (a hold, repairs to send): those rows carry no inbox flag, so the inbox can't
 * snooze them. The workspace keeps its own snooze over the items it was set on; a new item, or the time, brings it back.
 */
const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();
const held = (patch = {}) => workspace({ hold: "Paused after 3 failed sends", prs: [], ...patch });
const state = (w = held()): State => ({ version: 1, workspaces: [w] } as State);

test("resolveUntil: the words the tools accept become a time the snooze can wake at (bug: an agent's '1h' never woke)", () => {
  const now = new Date(2026, 10, 10, 9, 0);
  assert.equal(resolveUntil("1h", now), new Date(now.getTime() + 3_600_000).toISOString());
  assert.equal(resolveUntil("hour", now), resolveUntil("1h", now));
  assert.equal(resolveUntil("tomorrow", now), new Date(2026, 10, 11, 9, 0).toISOString());
  assert.equal(resolveUntil("tonight", now), new Date(2026, 10, 10, 18, 0).toISOString());
  assert.equal(resolveUntil("next-event", now), "next-event");
  assert.equal(resolveUntil("pr:example/app#1", now), "pr:example/app#1");
  assert.equal(resolveUntil("2026-11-12T08:00:00.000Z", now), "2026-11-12T08:00:00.000Z");
  assert.equal(resolveUntil("someday", now), null);
});

test("a workspace snooze holds over the items it was set on, until its time or a new item", () => {
  const set = controlWorkspace(state(), { workspaceId: "workspace", snooze: { until: iso(60) } }, NOW);
  assert.ok(set.snooze);
  assert.ok(workspaceSnoozed(set, needsYou(set, NOW), NOW + 1));
  assert.ok(!workspaceSnoozed(set, needsYou(set, NOW + 61 * 60_000), NOW + 61 * 60_000), "the time passed");
  const worse = { ...set, hold: "Paused: the main agent is gone" };
  assert.ok(!workspaceSnoozed(worse, needsYou(worse, NOW), NOW + 1), "a different hold is news");
  const next = controlWorkspace(state(), { workspaceId: "workspace", snooze: { until: "next-event" } }, NOW);
  assert.ok(workspaceSnoozed(next, needsYou(next, NOW), NOW + 86_400_000), "next event: no time limit");
  const more = { ...next, questions: [{ id: "Q1", title: "Pick", question: "Which?", options: [], state: "open" } as never] };
  assert.equal(workspaceSnoozed(more, [...needsYou(next, NOW), { kind: "question", key: "question:Q1" } as never], NOW + 1), false, "any new item wakes it");
  assert.equal(controlWorkspace(state(next), { workspaceId: "workspace", snooze: null }, NOW).snooze, null, "Bring back now");
  assert.throws(() => controlWorkspace(state(workspace({ prs: [] })), { workspaceId: "workspace", snooze: { until: "next-event" } }, NOW), /Nothing needs you/);
  assert.throws(() => controlWorkspace(state(), { workspaceId: "workspace", snooze: { until: "someday" } }, NOW), /until/);
});

test("Home: a snoozed workspace-only row sits in Later, and comes back to Needs you on its own", () => {
  const w = controlWorkspace(state(), { workspaceId: "workspace", snooze: { until: iso(60) } }, NOW);
  const groupOf = (now: number, x = w) => buildHome({ rows: [], tracked: [x], paseo: [], now }).groups.find(g => g.items.some(i => i.key === "ws:workspace"))?.id;
  assert.equal(groupOf(NOW - 1, held()), "needs");
  assert.equal(groupOf(NOW + 1), "later");
  assert.equal(groupOf(NOW + 61 * 60_000), "needs");
});

const base = { s: { key: "ws:workspace", agentId: "main-agent", workspaceId: "workspace", title: "Migration rollout", agent: null }, flagged: false, w: held(), needs: needsYou(held(), NOW), canAsk: false } satisfies RowMenuInput;
test("row menu: a workspace-only Needs-you row leads with Later; snoozed, it offers Bring back now; no Sign off", () => {
  const triage = rowMenu({ ...base, workspaceLater: { snoozedUntil: null }, now: new Date(2026, 10, 10, 9) })[0];
  assert.equal(triage.key, "triage");
  assert.deepEqual(triage.items.map(i => i.action), ["later_ws"]);
  assert.deepEqual(triage.items[0].children!.map(c => c.arg), ["hour", "tonight", "tomorrow", "next-event"]);
  const snoozed = rowMenu({ ...base, workspaceLater: { snoozedUntil: "10:00" } })[0].items;
  assert.deepEqual(snoozed.map(i => i.action), ["later_ws", "bring_back_ws"]);
  assert.equal(snoozed[0].hint, "Later until 10:00");
  assert.ok(!flatItems(rowMenu(base)).some(i => i.action === "later_ws"), "no workspace Later unless the surface offers it");
  assert.ok(!flatItems(rowMenu({ ...base, flagged: true, workspaceLater: { snoozedUntil: null } })).some(i => i.action === "later_ws"), "an agent flag takes the inbox's Later instead");
});

async function agents(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ws-later-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.mutate(s => { s.workspaces = [held()]; });
  const acts: InboxAction[] = []; const notes: string[] = [];
  const deps = {
    store, prActions: {} as never, engine: { sendPending: async () => { throw Error("unused"); }, activate: async () => { throw Error("unused"); } },
    inbox: { list: async () => ({ enabled: true, rows: [{ agentId: "a2", title: "Other", workspaceTitle: null, needs: { reasons: [], since: iso(0) }, snooze: null, seq: 3 } as never] }), act: async (input: InboxAction) => { acts.push(input); return { results: (input.agentIds ?? []).map(agentId => ({ agentId, ok: true, cameBack: false })) }; }, noteAction: async (_by: string, _id: string, action: string) => { notes.push(action); } },
    reviewersFor: () => [], now: () => NOW,
  } as unknown as AgentActionDeps;
  return { store, acts, notes, agent: new AgentActions(deps) };
}

test("agent parity: snooze_workspace snoozes and brings back, planned like snooze", async t => {
  const f = await agents(t);
  const plan = await f.agent.run("orchestrator", "snooze_workspace", { workspace: "workspace", until: "1h" }) as { planId: string };
  assert.equal((await f.store.snapshot()).workspaces[0].snooze ?? null, null, "planned: nothing changes before confirm");
  await f.agent.run("orchestrator", "snooze_workspace", { confirm: true, planId: plan.planId });
  assert.equal((await f.store.snapshot()).workspaces[0].snooze?.until, new Date(NOW + 3_600_000).toISOString(), "1h is stored as a time");
  const back = await f.agent.run("orchestrator", "snooze_workspace", { workspace: "workspace", bring_back: true }) as { planId: string };
  await f.agent.run("orchestrator", "snooze_workspace", { confirm: true, planId: back.planId });
  assert.equal((await f.store.snapshot()).workspaces[0].snooze, null);
  assert.deepEqual(f.notes, ["snooze_workspace", "snooze_workspace"]);
});

test("the agent's inbox snooze stores '1h' as a time too", async t => {
  const f = await agents(t);
  const plan = await f.agent.run("orchestrator", "snooze", { agentIds: ["a2"], until: "1h" }) as { planId: string };
  await f.agent.run("orchestrator", "snooze", { confirm: true, planId: plan.planId });
  assert.equal(f.acts[0].until, new Date(NOW + 3_600_000).toISOString());
  await assert.rejects(f.agent.run("orchestrator", "snooze", { agentIds: ["a2"], until: "someday" }), /until/);
});

test("one rule for every count: the header dot, the pill and Home skip a workspace in Later (bug: the dot still said 1 need you)", async () => {
  const w = controlWorkspace(state(), { workspaceId: "workspace", snooze: { until: iso(60) } }, NOW);
  assert.deepEqual(activeNeeds(w, NOW + 1), []);
  assert.equal(activeNeeds(w, NOW + 61 * 60_000).length, 1, "back once its time comes");
  assert.equal(activeNeeds(held(), NOW).length, 1);
  // Surfaces that count a workspace's needs go through activeNeeds; only the lists that show the items read needsYou.
  for (const f of ["client/live.tsx", "client/pill.tsx"]) assert.match(await readFile(f, "utf8"), /activeNeeds\(/, `${f} counts with activeNeeds`);
  assert.doesNotMatch(await readFile("client/live.tsx", "utf8"), /needsYou\(w\)\.length/);
});

test("workspace Later is undone from the Undo bar, like agent Later", async () => {
  const source = await readFile("client/row-actions.ts", "utf8");
  const body = source.slice(source.indexOf('case "later_ws"'), source.indexOf('case "bring_back_ws"'));
  assert.match(body, /noteLater/, "records the Later for the Undo bar");
  assert.match(body, /success: null/, "no toast on top of the bar");
});
