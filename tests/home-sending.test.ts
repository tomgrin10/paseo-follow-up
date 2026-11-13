import test from "node:test";
import assert from "node:assert/strict";
import { AgentActions } from "../server/agent-actions";
import { compact } from "../server/mcp.mjs";
import type { Batch, Task, Workspace } from "../shared/model";
import { buildHome, homeCounts, type HomeModel } from "../shared/home";
import { autoSendHold, HELD_REASON, sendingOf, UNACKNOWLEDGED_NOTE } from "../shared/sending";
import { IDLE_REASON, SETTLE_REASON } from "../shared/send-decision";
import { homeViolations, violations } from "../shared/status-invariants";
import { workstreams } from "../shared/overseer";
import type { Resources } from "../shared/resources";
import { clock, workspace } from "./fixtures";

// Q51 (2026-11-13): Home's "Sending" replaces "Follow-up is fixing". It holds a message out with the agent or queued to
// go out on its own; a send that waits on the developer is in Needs you only. One hold line per machine, at the top.

const at = (ms: number) => new Date(clock - ms).toISOString();
const t = (kind: Task["kind"], n: number): Task => ({ key: `${kind}:example/app#${n}`, kind, target: `example/app#${n}`, title: `Fix ${kind} on example/app#${n}`, fingerprint: "f" });
const TASKS = [t("conflict", 1), t("checks", 2)];
const batch = (state: Batch["state"], patch: Partial<Batch> = {}): Batch => ({ id: `b-${state}`, messageId: "m", attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
  tasks: TASKS, state, createdAt: at(120_000), sentAt: ["sending", "sent", "completed"].includes(state) ? at(60_000) : null, settledAt: state === "completed" ? at(30_000) : null, ...patch });
const ws = (id: string, patch: Partial<Workspace> = {}) => workspace({ id, title: `Workspace ${id}`, enable_auto_sends: true, mainAgentTitle: `Workspace ${id}`, batches: [batch("pending")], ...patch });
const home = (tracked: Workspace[], o: { hold?: string | null } = {}) => buildHome({ rows: [], tracked, paseo: [], now: clock, ...o });
const row = (model: HomeModel, id: string) => model.byKey.get(`ws:${id}`)!;
const sending = (model: HomeModel) => model.groups.find(g => g.id === "sending")?.items ?? [];

test("queued: in Sending with when and why, the clock glyph, and Send now where the server takes it", () => {
  const w = ws("q", { batches: [batch("pending", { createdAt: at(10_000) })] });
  const s = row(home([w]), "q");
  assert.equal(s.group, "sending");
  assert.equal(s.icon, "ClockArrowUp", "queued reads as the clock family, never Running's spinner");
  assert.equal(s.line, `2 tasks queued · ${SETTLE_REASON}`);
  assert.equal(sendingOf(w, clock)!.when, new Date(Date.parse(at(10_000)) + 60_000).toISOString(), "when it goes out on its own");
  assert.deepEqual(s.sendNow, { batchId: "b-pending", count: 2 });
  assert.deepEqual(violations(w, clock), []);
});

test("agent busy: in Sending after its turn, with no Send now the server would refuse", () => {
  const s = row(home([ws("busy", { runtimeBusy: true })]), "busy");
  assert.equal(s.group, "sending");
  assert.equal(s.line, "2 tasks queued · sends when its current turn ends, so it isn't interrupted");
  assert.equal(s.sendNow, null);
});

test("in flight: the send glyph, what it waits for, and no Send now", () => {
  const w = ws("out", { batches: [batch("sent")], runtimeBusy: true });
  const s = row(home([w]), "out");
  assert.deepEqual([s.group, s.icon, s.line, s.sendNow], ["sending", "Send", "Main agent is working on 2 tasks", null]);
  assert.deepEqual({ state: sendingOf(w, clock)!.state, why: sendingOf(w, clock)!.why, when: sendingOf(w, clock)!.when }, { state: "sent", why: "waiting for it to report back", when: at(60_000) });
});

test("a send that waits on the developer is in Needs you only, said once without the row's title", () => {
  for (const patch of [{ sendWait: "unloaded" as const }, { enable_auto_sends: false }]) {
    const model = home([ws("idle", patch)]);
    const s = row(model, "idle");
    assert.equal(s.group, "needs", JSON.stringify(patch));
    assert.equal(sending(model).length, 0, "never in Sending too");
    assert.equal(s.word, "Send");
    assert.ok(!s.line.toLowerCase().includes(s.title.toLowerCase()), `say it once: "${s.line}" repeats the row title`);
  }
  assert.equal(row(home([ws("idle", { sendWait: "unloaded" })]), "idle").line, "The agent is idle; Follow-up doesn't wake it");
  assert.equal(IDLE_REASON, "the agent is idle; Follow-up doesn't wake it");
});

test("cap reached: the capped task moves to Needs you and the workspace leaves Sending", () => {
  const w = ws("cap", { heldTasks: [{ task: t("review", 3), held: "capped" }] });
  const model = home([w]);
  assert.equal(row(model, "cap").group, "needs");
  assert.equal(sending(model).length, 0);
});

test("after a failed or unacknowledged send, the row says what happens next", () => {
  const unacked = ws("again", { batches: [batch("completed", { id: "b-old", unacknowledged: true }), batch("pending", { createdAt: at(10_000) })] });
  assert.equal(row(home([unacked]), "again").line, `2 tasks queued · ${UNACKNOWLEDGED_NOTE} · ${SETTLE_REASON}`);
  const refused = ws("refused", { batches: [batch("pending", { refusal: { at: at(5_000), reason: "the agent was busy" } } as Partial<Batch>)] });
  assert.match(row(home([refused]), "refused").line, /didn't send: the agent was busy · tries again shortly$/);
});

test("the machine-wide hold: one line above Sending, only while it has rows; queued rows wait for it to ease", () => {
  const line = "Auto-sends are paused on this machine · Paseo is at 78% of its memory limit. Queued tasks go out when it eases; Send now still sends.";
  const held = home([ws("held"), ws("out", { batches: [batch("sent")] })], { hold: line });
  assert.equal(held.hold, line);
  assert.equal(row(held, "held").line, `2 tasks queued · ${HELD_REASON}`);
  assert.deepEqual(row(held, "held").sendNow, { batchId: "b-pending", count: 2 }, "Send now still sends while auto-sends are held");
  assert.equal(row(held, "out").line, "Main agent is working on 2 tasks", "a message already out isn't held");
  const empty = home([ws("calm", { batches: [] })], { hold: line });
  assert.equal(empty.hold, null, "no hold line without Sending rows");
  assert.ok(!empty.groups.some(g => g.id === "sending"), "an empty group is hidden");
  assert.deepEqual(homeViolations(held, [], clock), []);
  assert.deepEqual(homeViolations(empty, [], clock), []);
});

test("the hold line: the same words everywhere, the percentage only when it is real and current", () => {
  const r = (patch: Partial<Resources>): Resources => ({ memoryPct: 78, memoryBytes: null, memoryHighBytes: null, cpuPct: 20, memoryPressure: 0, cpuPressure: 0, level: "constrained", at: at(10_000), ...patch });
  assert.equal(autoSendHold(r({ level: "ok" }), clock), null);
  assert.equal(autoSendHold(r({}), clock), "Auto-sends are paused on this machine · Paseo is at 78% of its memory limit. Queued tasks go out when it eases; Send now still sends.");
  assert.match(autoSendHold(r({ at: at(10 * 60_000) }), clock)!, /Paseo is near its memory limit\./, "an old reading drops the %");
  assert.match(autoSendHold(r({ memoryPct: 40, memoryPressure: 30 }), clock)!, /memory is under pressure/);
  assert.match(autoSendHold(r({ memoryPct: 40, cpuPressure: 80 }), clock)!, /CPU is under sustained load/);
});

test("home-group-count-equals-rows: the strip's counts are the rows, and the invariant catches a drift", () => {
  const model = home([ws("a"), ws("b", { runtimeBusy: true }), ws("c", { sendWait: "unloaded" }), ws("d", { batches: [batch("sent")] }), ws("e", { batches: [] })]);
  const counts = homeCounts(model);
  assert.equal(counts.sending, 3); assert.equal(counts.needs, 1);
  assert.deepEqual(homeViolations(model, [], clock), []);
  const drifted = { ...model, groups: model.groups.map(g => g.id === "sending" ? { ...g, items: g.items.slice(1) } : g) };
  assert.deepEqual([...new Set(homeViolations(drifted, [], clock).map(v => v.id))], ["home-group-count-equals-rows"]);
  assert.deepEqual(homeViolations({ ...model, groups: [...model.groups, { id: "later", title: "Later", items: [] }] }, [], clock).map(v => v.detail), ["later shows with no rows"]);
});

test("agents read the same Sending rows: workspace_status, inbox_list and workstreams", async () => {
  const w = ws("agent", { mainAgentId: "main-1", batches: [batch("pending", { createdAt: at(10_000) })] });
  const expected = sendingOf(w, clock)!;
  assert.deepEqual({ state: expected.state, canSendNow: expected.canSendNow, why: expected.why }, { state: "queued", canSendNow: true, why: SETTLE_REASON });
  // workspace_status (the agent's compact view) carries it as is.
  assert.deepEqual((compact("workspace_status", {}, { ...w, sending: expected }) as { sending: unknown }).sending, expected);
  // inbox_list: on the main agent's row, and held like Home when the governor holds auto-sends.
  const inboxRow = { agentId: "main-1", title: "Workspace agent", workspaceTitle: "Workspace agent", workspaceId: "agent", status: "idle", needs: null, snooze: null, enable_finish_flags: true };
  const actions = (held: boolean) => new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [w] }) }, inbox: { list: async () => ({ enabled: true, rows: [inboxRow] }), noteAction: async () => undefined }, now: () => clock, autoSendsHeld: () => held } as never);
  const listed = await actions(false).run("helper-1", "inbox_list", {}) as { rows: { sending: unknown }[] };
  assert.deepEqual(listed.rows[0].sending, expected);
  const heldList = await actions(true).run("helper-1", "inbox_list", {}) as { rows: { sending: { why: string } }[] };
  assert.equal(heldList.rows[0].sending.why, HELD_REASON);
  // workstreams (the Overseer): the row's group and its Sending answer.
  const rows = workstreams({ rows: [], tracked: [w], paseo: [], now: clock });
  assert.deepEqual([rows[0].group, rows[0].sending], ["sending", expected]);
});

test("say it once: while the hold line shows, the memory meter keeps its reading and drops '· paused'", async () => {
  const { resourceMeter } = await import("../shared/resources");
  const r: Resources = { memoryPct: 78, memoryBytes: null, memoryHighBytes: null, cpuPct: 20, memoryPressure: 0, cpuPressure: 0, level: "constrained", at: at(10_000) };
  assert.equal(resourceMeter(r, clock)!.suffix, "· paused", "on its own the meter says it");
  const held = resourceMeter(r, clock, undefined, { holdShown: true })!;
  assert.equal(held.suffix, null);
  assert.match(held.text, /Paseo memory 78%/, "the reading stays");
  // Home passes the model's hold to both meters (desktop's under the strip, the phone's at the end of the list).
  const { readFileSync } = await import("node:fs");
  const home = readFileSync(new URL("../client/home.tsx", import.meta.url), "utf8");
  assert.equal((home.match(/<UsageMeters [^>]*hold=\{!!model\.hold\}/g) ?? []).length, 2);
});

test("the Needs-you Send with Auto off says how much waits and why, never the title", () => {
  const w = ws("off", { enable_auto_sends: false });
  const s = row(home([w]), "off");
  assert.deepEqual([s.group, s.word, s.line], ["needs", "Send", "2 tasks ready · auto-send is off here"]);
});

test("phones: the status strip has its row to itself, so no chip hides behind the version", async () => {
  // 2026-11-13 (Q51 review): "Sending" made the strip longer and "v2.0.1-beta.4" beside it hid Waiting, Quiet and
  // Later at 390pt. The phone header holds the strip alone (it scrolls sideways, nothing over it); the version is a
  // muted caption at the end of the list.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../client/home.tsx", import.meta.url), "utf8");
  const phoneHeader = src.slice(src.indexOf("header={omnibox.results ? undefined : compact"), src.indexOf(": updateNotice} />"));
  assert.match(phoneHeader, /<StatusStrip [^>]*touch dense \/>/);
  assert.doesNotMatch(phoneHeader, /VersionMark/, "nothing shares the strip's row");
  const phoneFooter = src.slice(src.indexOf("footer={omnibox.results ? undefined : compact"), src.indexOf("afterNeeds="));
  assert.match(phoneFooter, /<VersionMark theme=\{theme\} touch/, "the version is still one tap from Settings");
});
