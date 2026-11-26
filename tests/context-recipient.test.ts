import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { availableTools } from "../server/native-tools";
import { contextRecipient, questionRecipient } from "../server/context-requests";
import { CONTEXT_REPLY_ROLE } from "../shared/catch-up";

// 2026-11-17, Tom on 2.2.0-beta.3: "I chose to add context through the overseer and it worked badly". The Overseer
// answered in its own chat: Follow-up refused its context_reply ("Tracking must be active"). Root cause: context_reply
// is a role tool only a tracked workspace's main agent gets, and the Overseer lives in its own untracked workspace, so
// an ask routed to it could never reach the card. Invariant `an-ask-goes-only-to-an-agent-that-can-answer-it`: every
// agent a More context ask can go to has context_reply.

const ROOT = join(import.meta.dirname, "..");
test("a free question goes to the agent named when it can answer, else the workspace's main agent; never the caller", () => {
  const ws = [{ id: "w1", enable_tracking: true, mainAgentId: "m1", contributorAgentIds: ["c1"] }, { id: "w2", enable_tracking: false, mainAgentId: "m2" }];
  assert.deepEqual(questionRecipient(ws, { agentId: "c1" }, null), { agentId: "c1", workspaceId: "w1" }, "/ask in a contributor's chat asks it");
  assert.deepEqual(questionRecipient(ws, { workspaceId: "w1" }, null), { agentId: "m1", workspaceId: "w1" });
  assert.ok("error" in questionRecipient(ws, { agentId: "m2" }, null), "an untracked workspace's agent has no context_reply");
  assert.ok("error" in questionRecipient(ws, { agentId: "x" }, null));
  assert.ok("error" in questionRecipient(ws, { agentId: "c1" }, "c1"), "no asking yourself");
  assert.ok("error" in questionRecipient(ws, { workspaceId: "w1" }, "m1"));
});

const has = (role: "main" | "contributor" | "recovery" | null, flags: Partial<{ recovery: boolean; overseer: boolean }> = {}) =>
  availableTools({ recovery: false, brief: true, root: true, overseer: false, ...flags }, { role, inbox: true }).some(t => t[0] === "context_reply");

test("an-ask-goes-only-to-an-agent-that-can-answer-it: the role asks go to has context_reply, and the others don't", () => {
  assert.equal(CONTEXT_REPLY_ROLE, "main");
  assert.ok(has(CONTEXT_REPLY_ROLE), "a tracked workspace's main agent can answer on the card");
  assert.ok(!has(null, { overseer: true }), "the Overseer (untracked) can't, so no ask goes to it");
  assert.ok(has("contributor"), "a contributor can, for a question asked of it (/ask in its chat); a card's More context still goes to the main agent");
  assert.ok(!has("main", { recovery: true }), "a recovery agent can't");
});

test("an ask goes to the card's workspace's main agent, whoever the card names; untracked workspaces are refused", () => {
  const w = { enable_tracking: true, mainAgentId: "main-1" };
  assert.deepEqual(contextRecipient(w, null), { agentId: "main-1" });
  assert.deepEqual(contextRecipient(w, "contributor-2"), { agentId: "main-1" }, "an agent asking about another's card");
  assert.ok("error" in contextRecipient(w, "main-1"), "an agent doesn't ask itself");
  assert.ok("error" in contextRecipient({ enable_tracking: false, mainAgentId: "x" }, null), "untracked: no agent there has context_reply");
  assert.ok("error" in contextRecipient(undefined, null), "no workspace");
});

test("the server routes every ask through contextRecipient and never to the Overseer; the client offers one Ask", async () => {
  const server = await readFile(join(ROOT, "index.server.ts"), "utf8");
  const handler = server.slice(server.indexOf("const askAgent = "), server.indexOf("handle(rpc.catchUpDeckRpc"));
  assert.match(handler, /contextRecipient\(/);
  assert.match(handler, /questionRecipient\(/, "a free question goes only to a tracked workspace's main agent or contributor");
  assert.doesNotMatch(handler, /overseer!?\.ask|overseerContextPrompt/, "no Overseer delivery path");
  const screen = await readFile(join(ROOT, "client/catch-up.tsx"), "utf8");
  assert.doesNotMatch(screen, /Ask the Overseer/, "More context has no Overseer choice");
  const keys = await readFile(join(ROOT, "shared/catch-up.ts"), "utf8");
  assert.doesNotMatch(keys, /ask-overseer/, "no Overseer key");
});
