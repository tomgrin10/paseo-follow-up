import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { workspace } from "./fixtures";

async function handshake(agent: boolean, recovery = false): Promise<any[]> {
  const env = { ...process.env }; delete env.PASEO_AGENT_ID;
  if (agent) env.PASEO_AGENT_ID = "fixture-agent";
  if (recovery) env.FOLLOW_THROUGH_RECOVERY = "1"; else delete env.FOLLOW_THROUGH_RECOVERY;
  const root = await mkdtemp(join(tmpdir(), "follow-mcp-")); env.PASEO_HOME = root;
  const directory = join(root, "plugin-data/follow-through"); await mkdir(directory, { recursive: true });
  const w = workspace({ mainAgentId: recovery ? "other-main" : "fixture-agent", batches: recovery ? [{ id: "recovery", state: "sent", recipientAgentId: "fixture-agent", settledAt: null, tasks: [{kind: "inventory"}] }] as any : [] });
  await writeFile(join(directory, "state.json"), JSON.stringify({ workspaces: [w] }));
  await writeFile(join(directory, "hooks-enabled.json"), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  const child = spawn(process.execPath, [resolve("server/mcp.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  const completed = new Promise<void>((ok, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? ok() : reject(new Error(error))); });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await completed; await rm(root, { recursive: true, force: true });
  return output.trim().split("\n").map(line => JSON.parse(line));
}
test("MCP stdout contains only protocol and outside-Paseo sessions have no mutation tools", async () => {
  const result = await handshake(false); assert.equal(result.length, 2); assert.equal(result[0].result.serverInfo.name, "paseo-follow-through"); assert.deepEqual(result[1].result.tools, []);
});
test("Paseo MCP sessions expose scoped schemas without an agentId override", async () => {
  const instruction = (await handshake(true))[0].result.instructions; assert.match(instruction, /Perform bookkeeping silently/);
  for (const rule of ["header with the batchId", "acknowledge_batch", "before declare_done", "skip resolved tasks", "--publish", "serving revisions", "Leave merging and archiving to the developer"]) assert.ok(instruction.includes(rule), `MCP retains ${rule} when hooks are unavailable`);
  const result = await handshake(true); const tools = result[1].result.tools; assert.equal(tools.length, 8); assert.ok(tools.some((t: any) => t.name === "declare_done")); assert.ok(tools.some((t: any) => t.name === "sync_workspace")); assert.equal(tools.find((t: any) => t.name === "acknowledge_batch").inputSchema.properties.result.maxLength, 2000); assert.ok(tools.every((t: any) => !("agentId" in t.inputSchema.properties) && t.inputSchema.additionalProperties === false));
  const task = tools.find((t: any) => t.name === "update_obligation"); assert.deepEqual(task.inputSchema.properties.communication.required, ["threadUrl", "recipient"]); assert.match(task.description, /Auto does not authorize external posts/); assert.match(task.description, /Tasks are manual unless explicitly scheduled/); assert.deepEqual(task.inputSchema.properties.trigger.properties.event.enum, ["now", "merge", "deploy"]); assert.equal(task.inputSchema.properties.trigger.properties.delayDays.maximum, 3650); assert.match(instruction, /draft or uncertain send stays blocked/);
});

test("recovery agents get metadata tools without completion authority", async () => {
  const result = await handshake(true, true);
  assert.equal(result[1].result.tools.length, 6);
  assert.ok(result[1].result.tools.every((t: any) => !["declare_done", "sync_workspace"].includes(t.name)));
  assert.match(result[0].result.instructions, /leave completion to the main agent/);
  assert.match(result[0].result.instructions, /Perform bookkeeping silently/);
});
