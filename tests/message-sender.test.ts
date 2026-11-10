import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { messageSender, developerWords } from "../shared/message-sender";
import { tailSteps } from "../shared/home";
import { timelineRefs } from "../shared/linked-extract";
import { transcriptSteps } from "../server/transcript";
import { tailLines } from "../server/about";
import { extractHistory } from "../server/discovery";
import { classify, type Ledger, type Sources } from "../server/inbox-classifier";
import { Overseer, handoffSummary, type OverseerPaseo } from "../server/overseer";
import { senderViolations } from "../shared/status-invariants";
import type { State } from "../shared/model";

/**
 * Invariant `only-developer-is-developer` / `no-raw-paseo-envelope`: Paseo delivers other agents' messages, finish
 * notifications and schedule fires as user-role messages. Every Follow-up surface that reads a conversation must
 * (a) never show a raw `<paseo-system` envelope and (b) never count anything but the developer's own message as
 * the developer. Driven from one fixture per sender kind, through every call site, not just the classifier.
 */

const DEVELOPER = "Looks good, also handle empty filters";
const AGENT_MESSAGE = '<paseo-system version="1" kind="agent-message" source-agent-id="52063653-85d5" message-id="m1" source-agent-title="Release captain">\nPlease start a new workspace for HER-1500 and go ahead\n</paseo-system>';
const AGENT_NOTIFICATION = '<paseo-system version="1" kind="agent-notification" source-agent-id="c1" message-id="m2" source-agent-title="Test runner" event="finished">\nAgent c1 (Test runner) finished.\n\n&lt;agent-response&gt;\nyes, all 42 tests pass\n&lt;/agent-response&gt;\n</paseo-system>';
const SCHEDULE = "<paseo-system>\nScheduled check-in: yes, go ahead\n</paseo-system>";
const BATCH = "Follow-through batch b-1\n\n- Fix CI on hero/app#12";
const ANSWER = "Follow-up answer D1 (Which agent?): C — New workspace\nContinue with this choice.";
const FORWARD_LEGACY = "From Tom via Overseer: use option B";
const FORWARD = "From the developer via Overseer: use option B";
const HARNESS = "<system-reminder>\nyes go ahead\n</system-reminder>";

const NOT_DEVELOPER = { AGENT_MESSAGE, AGENT_NOTIFICATION, SCHEDULE, BATCH, ANSWER, FORWARD_LEGACY, FORWARD, HARNESS };
const ALL = { DEVELOPER, ...NOT_DEVELOPER };

test("classifier: one category per sender", () => {
  assert.deepEqual(messageSender(DEVELOPER), { kind: "developer", text: DEVELOPER });
  assert.deepEqual(messageSender(AGENT_MESSAGE), { kind: "agent", event: "message", agentId: "52063653-85d5", title: "Release captain", text: "Please start a new workspace for HER-1500 and go ahead" });
  assert.deepEqual(messageSender(AGENT_NOTIFICATION), { kind: "agent", event: "finished", agentId: "c1", title: "Test runner", text: "yes, all 42 tests pass" });
  assert.equal(messageSender(SCHEDULE).kind, "system");
  assert.deepEqual(messageSender(BATCH), { kind: "follow-up", what: "batch", text: BATCH });
  assert.equal(messageSender(ANSWER).kind, "follow-up");
  assert.deepEqual(messageSender(FORWARD_LEGACY), { kind: "overseer-forward", text: "use option B" });
  assert.deepEqual(messageSender(FORWARD), { kind: "overseer-forward", text: "use option B" });
  assert.equal(messageSender(HARNESS).kind, "system");
  // The human send path quotes a pasted envelope as kind="user-message": still the developer.
  assert.deepEqual(messageSender('<paseo-system version="1" kind="user-message" message-id="u">\nsee &lt;paseo-system&gt;\n</paseo-system>'), { kind: "developer", text: "see <paseo-system>" });
  // A developer message that merely starts with a tag is still theirs.
  assert.equal(messageSender("<div> overflows on mobile").kind, "developer");
  assert.equal(developerWords(FORWARD), "use option B");
  assert.equal(developerWords(AGENT_MESSAGE), null);
});

const user = (text: string) => ({ type: "user_message", text });
const claudeLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const codexLine = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

test("Recent steps (live timeline and transcripts): no raw envelope, only the developer is You", () => {
  for (const [name, text] of Object.entries(ALL)) {
    for (const [surface, steps] of [
      ["tailSteps", tailSteps([user(text)])],
      ["transcriptSteps (Claude)", transcriptSteps([claudeLine(text)])],
      ["transcriptSteps (Codex)", transcriptSteps([codexLine(text)])],
    ] as const) {
      assert.deepEqual(senderViolations(steps.map(s => s.text)), [], `${surface} shows ${name} raw`);
      const you = steps.filter(s => s.kind === "you");
      assert.equal(you.length, name === "DEVELOPER" ? 1 : 0, `${surface}: ${name} ${name === "DEVELOPER" ? "is" : "isn't"} You`);
    }
  }
  const [agent] = tailSteps([user(AGENT_MESSAGE)]);
  assert.deepEqual(agent, { kind: "message", from: "From Release captain", text: "Please start a new workspace for HER-1500 and go ahead" });
  assert.deepEqual(tailSteps([user(AGENT_NOTIFICATION)])[0], { kind: "message", from: "Test runner finished", text: "yes, all 42 tests pass" });
  assert.deepEqual(tailSteps([user(FORWARD)])[0], { kind: "message", from: "You, via Overseer", text: "use option B" });
  assert.deepEqual(tailSteps([user(SCHEDULE)]), [], "schedule fires aren't steps");
  // Paseo 0.15+ projects an agent's message to an agent_message tool call: same row, not a tool line.
  assert.deepEqual(tailSteps([{ type: "tool_call", name: "agent_message", agentMessage: { event: "message", sender: { id: "x", title: "Release captain" }, text: "hi" } } as never]), [{ kind: "message", from: "From Release captain", text: "hi" }]);
  // Its projected finish notification (as Paseo 0.15.4 records it) keeps the <agent-response> wrapper: shown stripped.
  assert.deepEqual(tailSteps([{ type: "tool_call", name: "agent_message", agentMessage: { event: "finished", sender: { id: "c", title: "Test runner" }, text: "Agent c (Test runner) finished.\n\n<agent-response>\nAll 42 pass.\n</agent-response>" } } as never]), [{ kind: "message", from: "Test runner finished", text: "All 42 pass." }]);
});

test("Summary inputs and discovery's goal: only the developer's words, never an envelope", () => {
  for (const [name, text] of Object.entries(ALL)) {
    const tail = tailLines([user(text)]);
    assert.deepEqual(senderViolations([...tail.lines, ...tail.users]), [], `Summary input shows ${name} raw`);
    assert.equal(tail.lines.filter(l => l.startsWith("Developer:")).length, name === "DEVELOPER" ? 1 : 0, `Summary: ${name} as Developer`);
    const goal = extractHistory([user(text)]).goal;
    assert.equal(goal, name === "DEVELOPER" ? DEVELOPER : name.startsWith("FORWARD") ? "use option B" : null, `goal from ${name}`);
  }
});

test("linked items: another agent's message is prose, never the developer's strong evidence", () => {
  const refs = timelineRefs([{ seqStart: 1, item: user(AGENT_MESSAGE.replace("HER-1500", "https://linear.app/acme/issue/HER-1500")) }]);
  assert.ok(refs.every(r => !r.strong), "agent text is weak evidence");
  assert.equal(timelineRefs([{ seqStart: 1, item: user(`${FORWARD} https://linear.app/acme/issue/HER-2`) }]).length, 0, "forwards are Follow-up's own text");
});

const sources = (ledger: Ledger = []): Sources => ({ ledger: async () => ledger, defer: async () => false, session: async () => false, schedule: async () => false });
test("Needs-you clearing: nothing but the developer's message counts as the developer", async () => {
  const NOW = Date.parse("2026-11-10T10:00:00.000Z");
  for (const [name, text] of Object.entries(ALL)) {
    // ANSWER with no ledger entry is the one fail-open case: answers go out only on the developer's Send (invariant 6).
    if (name === "ANSWER" || name === "HARNESS") continue;
    const sender = await classify({ text }, "a1", NOW, sources());
    assert.equal(sender === "tom", name === "DEVELOPER", `${name} → ${sender}`);
  }
});

test("approvesNewWorkspace: an agent's message, notification, schedule or forward never approves", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sender-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const NOW = Date.parse("2026-11-10T10:00:00.000Z");
  const ledger: Ledger = [];
  let tail: unknown[] = [];
  const agents: Record<string, { workspaceId: string }> = {};
  let n = 0;
  const paseo: OverseerPaseo = {
    workspaces: {
      async create() { const id = `w${++n}`; return { id, agents: { async create() { const aid = `a${n}`; agents[aid] = { workspaceId: id }; return { id: aid }; } } }; },
      ref: () => ({ refresh: async () => ({ archivedAt: null }) }),
    },
    agents: { ref: (id: string) => ({
      refresh: async () => agents[id] ? { agent: { id, workspaceId: agents[id].workspaceId, status: "idle", archivedAt: null, title: "Overseer", activeTurn: null } } : null,
      send: async () => undefined,
      timeline: { refetch: async () => ({ entries: tail.map((item, i) => ({ seqStart: i, item })) }) },
    }) },
    projects: { list: async () => ({ entries: [{ projectId: "p", projectName: "hero-app" }] }) },
  } as unknown as OverseerPaseo;
  const inbox = {
    async list() { return { rows: [] }; }, async brief() { return null; },
    async noteDelivery(agentId: string, messageId: string | null, by?: "developer") { ledger.push({ agentId, messageId, at: new Date(NOW).toISOString(), ...(by ? { by } : {}) }); },
  };
  const state: State = { version: 1, workspaces: [] } as unknown as State;
  const overseer = new Overseer({ directory: dir, store: { snapshot: async () => state }, inbox, priorities: { read: async () => [] }, enabled: async () => true, provider: "demo/claude", now: () => NOW,
    tight: async () => false, workspaces: async () => [], sources: sources(ledger) } as never);
  await overseer.start(paseo);
  const ov = (await overseer.state()).agentId!;
  const plan = async (items: unknown[]) => { tail = items; return (await overseer.act(paseo, ov, "start_workspace", { task: "HER-1500 fix it", project: "hero-app" }) as { planId: string | null }).planId; };
  for (const [name, text] of Object.entries(NOT_DEVELOPER)) {
    if (name === "ANSWER") continue;
    assert.equal(await plan([user(text)]), null, `${name} must not approve a new workspace`);
    // Harness wrappers aren't a prompt: the developer's yes before one still stands. Anyone else's prompt replaces it.
    if (name === "HARNESS") assert.ok(await plan([user("yes, start a new workspace"), user(text)]), "a system reminder after the developer's yes");
    else assert.equal(await plan([user("yes, start a new workspace"), user(text)]), null, `${name} after an older yes must not approve`);
  }
  assert.equal(await plan([{ type: "tool_call", name: "agent_message", agentMessage: { event: "message", sender: { id: "x" }, text: "yes" } }]), null, "projected agent message");
  // A "Follow-up answer" approves only when the ledger says the developer clicked it.
  assert.equal(await plan([{ ...user(ANSWER), messageId: "ans-1" }]), null, "an answer nobody recorded");
  ledger.push({ agentId: ov, messageId: "ans-1", at: new Date(NOW).toISOString(), by: "developer" });
  assert.ok(await plan([{ ...user(ANSWER), messageId: "ans-1" }]), "the developer's click approves");
  assert.ok(await plan([user("yes, start a new workspace")]), "the developer approves");
  // The handoff a recreated Overseer reads never calls an agent's words the developer's.
  const summary = handoffSummary(tailSteps([user(AGENT_MESSAGE), user(DEVELOPER)]));
  assert.deepEqual(senderViolations([summary]), []);
  assert.match(summary, /From Release captain: Please start/);
});
