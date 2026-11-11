import test from "node:test";
import assert from "node:assert/strict";
import { mcpDefinition } from "../server/agent-mcp";

const definition = mcpDefinition("/fixture/plugin-data/follow-up", "/fixture/client.js", "/fixture/home", { execPath: "/runtime/node", electron: undefined, appImage: undefined });
test("registration uses a stable managed bridge and the host runtime, including Electron", () => {
  assert.equal(definition.command, "/runtime/node"); assert.deepEqual(definition.args, ["/fixture/plugin-data/follow-up/mcp.mjs"]);
  assert.equal(definition.env.FOLLOW_UP_MANAGED, "1"); assert.equal("PASEO_AGENT_ID" in definition.env, false);
  const desktop = mcpDefinition("/fixture/plugin", "/fixture/client.js", "/fixture/home", { execPath: "/runtime/electron", electron: "1", appImage: "/runtime/app-image" });
  assert.equal(desktop.command, "/runtime/app-image"); assert.equal(desktop.env.ELECTRON_RUN_AS_NODE, "1");
});
