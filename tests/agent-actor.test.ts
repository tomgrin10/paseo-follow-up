import test from "node:test";
import assert from "node:assert/strict";
import { AgentActions } from "../server/agent-actions";
import { developerAnswer } from "../server/questions";
import { developerSetSpec } from "../server/spec";
import { actorViolations } from "../shared/status-invariants";
import { workspace } from "./fixtures";

/**
 * Invariant `only-developer-acts-as-developer`, the action half of `only-developer-is-developer`: an action an agent
 * takes through its tools on the developer's behalf (brief_action, inbox_act, answer_question, the spec link, linked
 * items) is recorded as that agent's, never the developer's. Driven through each path: the agent tool layer must hand
 * the acting agent to the RPC, and each recorder must keep it.
 */

const AGENT = { kind: "agent" as const, agentId: "helper-1", title: "Release captain" };
const NOW = Date.parse("2026-11-10T10:00:00.000Z");

test("agent tools hand the acting agent to every RPC they run, read or write", async () => {
  const calls: { method: string; actor: unknown }[] = [];
  const rpc = {
    async validate(_m: string, input: unknown) { return input; },
    async call(method: string, _input: unknown, actor?: unknown) { calls.push({ method, actor }); return { ok: true, brief: null }; },
  };
  const actions = new AgentActions({ store: { snapshot: async () => ({ version: 1, workspaces: [] }) }, inbox: { noteAction: async () => undefined }, rpc, agentTitle: async (id: string) => id === "helper-1" ? "Release captain" : null } as never);
  const runs: [string, Record<string, unknown>][] = [
    ["brief_action", { agentId: "main-1", briefId: "brief:t1", decisionId: "D1", choice: "C" }],
    ["inbox_act", { action: "mute_turn", agentIds: ["main-1"] }],
    ["answer_question", { workspaceId: "w1", questionId: "Q1", choice: "A" }],
    ["set_workspace_spec", { workspaceId: "w1", action: "set", url: "https://example.com/spec" }],
    ["set_linked_items", { workspaceId: "w1", action: "add", ref: "https://linear.app/acme/issue/HER-9" }],
  ];
  for (const [tool, args] of runs) {
    const plan = await actions.run("helper-1", tool as never, args) as { planId: string };
    await actions.run("helper-1", tool as never, { ...args, confirm: true, planId: plan.planId });
  }
  const writes = calls.filter(c => ["follow.brief-action", "follow.inbox-act", "follow.answer-question", "follow.workspace-spec", "follow.set-linked-items"].includes(c.method));
  assert.equal(writes.length, runs.length, "every write ran");
  for (const c of writes) assert.deepEqual(c.actor, AGENT, `${c.method} ran without the acting agent`);
});

test("a question answered by an agent records the agent, never the developer", () => {
  const w = workspace({ questions: [{ id: "Q1", title: "Encoding", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8" }, { letter: "B", label: "Latin-1" }], askedBy: "main-1", at: "2026-11-10T09:00:00.000Z", via: "ask" }] as never });
  const q = developerAnswer(w, "Q1", "A", undefined, "send", NOW, AGENT as never);
  assert.deepEqual(actorViolations([{ path: "answer_question", actor: AGENT, recorded: q.answer?.by === "agent" ? `agent:${(q.answer as { agentId?: string }).agentId}` : q.answer?.by }]), []);
  const mine = developerAnswer(workspace({ questions: w.questions.map(x => ({ ...x, answer: undefined })) as never }), "Q1", "B", undefined, "send", NOW);
  assert.equal(mine.answer?.by, "developer", "the app's click stays the developer's");
});

test("a spec link set by an agent records the agent, never the developer", () => {
  const w = workspace({});
  developerSetSpec(w, { action: "set", url: "https://example.com/spec" }, NOW, AGENT as never);
  assert.deepEqual(actorViolations([{ path: "set_workspace_spec", actor: AGENT, recorded: w.spec?.source === "developer" ? "developer" : `agent:${w.spec?.by}` }]), []);
});

test("the invariant flags a developer record for an agent's action, and nothing else", () => {
  assert.deepEqual(actorViolations([{ path: "brief_action", actor: AGENT, recorded: "developer" }]).map(v => v.id), ["only-developer-acts-as-developer"]);
  assert.deepEqual(actorViolations([{ path: "brief_action", actor: AGENT, recorded: "agent:helper-1" }, { path: "brief_action", actor: { kind: "developer" }, recorded: "developer" }]), []);
});

test("the new-workspace gate: an answer an agent sent never reads as the developer's click", async () => {
  const { ledgerSender } = await import("../server/inbox-classifier");
  const message = { text: "Follow-up answer D1 (Which agent?): C — New workspace\nAnswered by Release captain (agent helper-1) for the developer.", messageId: "ans-1" };
  const ledger = (by: string) => ({ ledger: async () => [{ agentId: "ov", messageId: "ans-1", at: new Date(NOW).toISOString(), by }] });
  assert.notEqual(await ledgerSender(message, "ov", NOW, ledger("agent:helper-1")), "tom", "an agent's brief_action");
  assert.equal(await ledgerSender({ ...message, text: message.text.split("\n")[0] }, "ov", NOW, ledger("developer")), "tom", "the developer's own click");
});

test("an agent's answer is labelled with the agent everywhere it is read", async () => {
  const { messageSender, senderLabel } = await import("../shared/message-sender");
  const { answerMessage } = await import("../shared/questions");
  const text = "Follow-up answer D1 (Which encoding?): B — UTF-8 with BOM\nContinue with this choice.\nAnswered by Release captain (agent helper-1) for the developer.";
  assert.equal(senderLabel(messageSender(text)), "Answer from Release captain", "Recent steps");
  assert.equal(senderLabel(messageSender(text.split("\n").slice(0, 2).join("\n"))), "Follow-up answer", "the developer's own stays Follow-up's answer row");
  const q = { id: "Q1", title: "Encoding", question: "Which?", options: [{ letter: "A", label: "UTF-8" }], answer: { choice: "A", at: "x", by: "agent", agentId: "helper-1", agentTitle: "Release captain", delivery: { state: "sending", to: null, messageId: "m", at: "x", reason: null } } };
  assert.match(answerMessage(q as never, "A"), /\nAnswered by Release captain \(agent helper-1\) for the developer\.$/, "answer_question's message names the agent");
});
