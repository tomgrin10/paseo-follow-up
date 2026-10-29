import assert from "node:assert/strict";
import test from "node:test";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { withSessionMcp } from "../server/session-mcp";

test("session MCP preserves other contributions and binds current caller and recovery scope", () => {
  const request = { agentId: "caller", provider: "claude", purpose: "interactive", labels: {}, tools: [], env: { KEEP: "yes" }, mcpServers: { other: { type: "http", url: "https://example.invalid" } } } as unknown as PluginSessionOpenRequest;
  for (const provider of ["claude", "codex"]) for (const reason of ["create", "resume", "refresh", "import"]) {
    const result = withSessionMcp({ ...request, provider, reason } as PluginSessionOpenRequest, "/fixture/plugin", "/fixture/client.js", "/fixture/home", false, {});
    const mcp = result.mcpServers["follow-through"]!;
    assert.ok(mcp.type === "stdio");
    assert.equal(result.env, request.env); assert.equal(result.tools, request.tools); assert.equal(result.mcpServers.other, request.mcpServers.other);
    assert.equal(mcp.env?.PASEO_AGENT_ID, "caller"); assert.equal(mcp.env?.FOLLOW_THROUGH_RECOVERY, undefined); assert.equal(mcp.env?.PASEO_HOME, "/fixture/home");
  }
  const recovery = withSessionMcp(request, "/fixture/plugin", "/fixture/client.js", "/fixture/home", true, {});
  const recoveryMcp = recovery.mcpServers["follow-through"];
  assert.ok(recoveryMcp.type === "stdio");
  assert.equal(recoveryMcp.env?.FOLLOW_THROUGH_RECOVERY, "1");
  for (const patch of [{ purpose: "history" }, { provider: "unsupported" }, { labels: { "plugin-tools/enabled": "false" } }]) {
    const input = { ...request, ...patch } as PluginSessionOpenRequest;
    assert.equal(withSessionMcp(input, "/fixture/plugin", "/fixture/client.js", "/fixture/home", false, {}), input);
  }
  assert.deepEqual(Object.keys(request.mcpServers), ["other"]);
});
