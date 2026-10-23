import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoveryConfig } from "../server/recovery-config";
import type { Agent } from "../server/daemon";

const main = { id: "main-agent", provider: "fixture", workspaceId: "workspace", cwd: "/workspace/app", model: "current-model", currentModeId: "current-mode", thinkingOptionId: "high", features: [{ id: "enable_search", value: false }] } as Agent;
test("recovery inherits complete saved config and current live model/mode/thinking/features", async t => {
  const home = await mkdtemp(join(tmpdir(), "follow-config-")); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "agents/workspace-app"); await mkdir(directory, { recursive: true });
  const saved = { model: "old-model", modeId: "old-mode", thinkingOptionId: "medium", providerOptions: { account: "fixture", context: "large" }, featureValues: { enable_search: true, extra: "keep" }, systemPrompt: "Existing workspace instructions", mcpServers: { example: { type: "stdio", command: "example" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: "example", tool: "read" }] } };
  await writeFile(join(directory, "main-agent.json"), JSON.stringify({ ...main, config: saved }));
  const config = await recoveryConfig(home, main);
  assert.equal(config.model, main.model); assert.equal(config.modeId, main.currentModeId); assert.equal(config.thinkingOptionId, "high");
  assert.deepEqual(config.featureValues, { enable_search: false, extra: "keep" });
  for (const key of ["providerOptions", "systemPrompt", "mcpServers", "toolPolicy"] as const) assert.deepEqual(config[key], saved[key]);
  assert.ok(!("persistence" in config) && !("env" in config) && !("labels" in config));
  await writeFile(join(directory, "main-agent.json"), JSON.stringify({ ...main, workspaceId: "different", config: saved }));
  await assert.rejects(recoveryConfig(home, main), /no longer matches/);
});
test("unavailable config fails recovery rather than silently changing the main agent's settings", async () => {
  await assert.rejects(recoveryConfig("/nonexistent-follow-config", main), /not launched with defaults/);
});
