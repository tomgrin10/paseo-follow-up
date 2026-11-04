import test from "node:test";
import assert from "node:assert/strict";
import { followShellCall, followToolName, parseBatchPrompt, readText, toolRow, toolRowSchema, batchCardSchema } from "../shared/chat";

test("Follow-up tools are recognised under Claude and Codex names only", () => {
  assert.equal(followToolName("mcp__follow-through__register_pr"), "register_pr");
  assert.equal(followToolName("follow-through.declare_done"), "declare_done");
  assert.equal(followToolName("mcp__other__register_pr"), null);
  assert.equal(followToolName("mcp__follow-through__unknown_tool"), null);
  assert.equal(followToolName("register_pr"), null, "a bare name could belong to any server");
});

test("the CLI fallback is recognised with its JSON input, including escaped quotes", () => {
  const call = followShellCall(`FOLLOW_THROUGH_CLIENT_ENTRY='/x/y.js' node '/home/u/.paseo/plugin-data/follow-through/mcp.mjs' call update_obligation '{"title":"Verify the user'"'"'s rollout","status":"done"}'`);
  assert.deepEqual(call, { tool: "update_obligation", input: { title: "Verify the user's rollout", status: "done" } });
  assert.equal(followShellCall("npm test"), null);
  assert.deepEqual(followShellCall("node ~/.paseo/plugin-data/follow-through/mcp.mjs call workspace_status"), { tool: "workspace_status", input: {} });
});

test("repair batches become cards and ordinary messages stay untouched", () => {
  const card = parseBatchPrompt("Follow-through batch 9b2\n\n1. Resolve merge conflicts on acme/app#2\n2. Use /fix-pr for acme/app#3 (2 open threads)");
  assert.deepEqual(card?.tasks, ["Resolve merge conflicts on acme/app#2", "Use /fix-pr for acme/app#3 (2 open threads)"]);
  assert.ok(batchCardSchema.safeParse(card).success);
  assert.equal(parseBatchPrompt("Follow-through recovery abc\n\nWorkspace: X")?.kind, "recovery");
  assert.equal(parseBatchPrompt("Please follow-through on the batch"), null);
  assert.equal(parseBatchPrompt("Follow-through batch 1\n\nno numbered tasks"), null);
});

test("tool rows say what changed in one line", () => {
  const registered = toolRow("register_pr", "completed", { repo: "acme/billing", number: 421, stack: "Retry backoff", parentNumber: 418 }, "{}");
  assert.equal(registered.line, "Registered billing #421 in Retry backoff on #418");
  assert.equal(toolRow("update_obligation", "completed", { title: "Pick a strategy", status: "blocked" }, "{}").tone, "warning");
  assert.equal(toolRow("acknowledge_batch", "completed", { outcome: "blocked", result: "Needs prod access\nmore" }, "{}").line, "Repairs blocked · Needs prod access");
  assert.equal(toolRow("workspace_status", "running", {}, undefined).line, "Reading Follow-up status…");
  const failed = toolRow("register_pr", "failed", {}, undefined, "Register the parent PR first.\nstack");
  assert.equal(failed.line, "Register the parent PR first."); assert.equal(failed.tone, "danger");
  for (const row of [registered, failed]) assert.ok(toolRowSchema.safeParse(row).success);
});

test("declare_done renders the shipped card only when nothing blocks it", () => {
  const done = toolRow("declare_done", "completed", { summary: "Shipped" }, JSON.stringify({ workspaceId: "w", completion: { summary: "Migrations shipped and verified" }, blockers: [] }));
  assert.deepEqual(done.done, { summary: "Migrations shipped and verified" });
  const blocked = toolRow("declare_done", "completed", { summary: "Shipped" }, JSON.stringify({ workspace: { completion: null }, blockers: ["Settle acme/app#2", "Verify rollout"] }));
  assert.equal(blocked.done, null); assert.equal(blocked.line, "Not done yet · 2 blockers"); assert.equal(blocked.more, "• Settle acme/app#2\n• Verify rollout");
});

test("tool output text is read from Claude and Codex result shapes", () => {
  assert.equal(readText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(readText({ output: "plain" }), "plain");
  assert.equal(readText({ unknown: 1 }), undefined);
});
