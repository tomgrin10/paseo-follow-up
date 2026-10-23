import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentMcp, mcpDefinition, claudeMcpMatches, reconcileCodexMcp } from "../server/agent-mcp";

const definition = mcpDefinition("/fixture/plugin-data/follow-through", "/fixture/client.js", "/fixture/home", { execPath: "/runtime/node", electron: undefined, appImage: undefined });
test("registration uses a stable managed bridge and the host runtime, including Electron", () => {
  assert.equal(definition.command, "/runtime/node"); assert.deepEqual(definition.args, ["/fixture/plugin-data/follow-through/mcp.mjs"]);
  assert.equal(definition.env.FOLLOW_THROUGH_MANAGED, "1"); assert.equal("PASEO_AGENT_ID" in definition.env, false);
  const desktop = mcpDefinition("/fixture/plugin", "/fixture/client.js", "/fixture/home", { execPath: "/runtime/electron", electron: "1", appImage: "/runtime/app-image" });
  assert.equal(desktop.command, "/runtime/app-image"); assert.equal(desktop.env.ELECTRON_RUN_AS_NODE, "1");
  const text = ["Scope: User config (available in all your projects)", "Command: " + definition.command, "Args: " + definition.args.join(" "), ...Object.entries(definition.env).map(([k,v])=>`${k}=${v}`)].join("\n");
  assert.equal(claudeMcpMatches(text, definition), true); assert.equal(claudeMcpMatches(text.replace("User config", "Local config"), definition), false);
});
test("Codex reconciliation forwards current identity without pinning it and preserves unrelated policy, comments and credentials", () => {
  const original = '# Keep comments\nmodel = "keep"\n[mcp_servers.other]\nurl = "https://example.invalid/mcp"\n[mcp_servers.follow-through]\ncommand = "old"\nargs = [\n  "old[path]",\n]\nenabled_tools = ["workspace_status"]\n[mcp_servers.follow-through.env]\nKEEP_CUSTOM = "untouched"\n[projects."/fixture/path"]\ntrust_level = "trusted"\n';
  const changed = reconcileCodexMcp(original, definition, ["CUSTOM_NAME"]);
  assert.ok(changed.includes('enabled_tools = ["workspace_status"]')); assert.ok(changed.includes('KEEP_CUSTOM = "untouched"')); assert.ok(changed.startsWith('# Keep comments\nmodel = "keep"\n[mcp_servers.other]\nurl = "https://example.invalid/mcp"'));
  assert.ok(changed.endsWith('[projects."/fixture/path"]\ntrust_level = "trusted"\n'));
  assert.ok(changed.includes('"PASEO_AGENT_ID"')); assert.ok(changed.includes('"CUSTOM_NAME"')); assert.ok(!changed.includes('PASEO_AGENT_ID ='));
  assert.equal(reconcileCodexMcp(changed, definition, ["CUSTOM_NAME"]), changed);
});
test("provider CLIs register only this server, remain idempotent and preserve manually disabled/conflicting entries", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-register-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.toml"); await writeFile(path, 'model = "keep"\n');
  let claude = "", codex: any = null; const calls: string[] = [];
  const run = async (command: string, args: string[], env?: Record<string, string>) => {
    calls.push(command + " " + args.slice(0, 3).join(" "));
    if (args[1] === "get") { if (command === "claude" && claude) return { stdout: claude }; if (command === "codex" && codex) return { stdout: JSON.stringify(codex) }; throw new Error("Absent"); }
    if (command === "claude" && args[1] === "add-json") {
      const d = JSON.parse(args.at(-1)!); claude = ["Scope: User config (available in all your projects)", "Command: " + d.command, "Args: " + d.args.join(" "), ...Object.entries(d.env).map(([k,v])=>`${k}=${v}`)].join("\n"); return { stdout: "added" };
    }
    if (command === "codex" && args[1] === "add") { codex = { enabled: true, transport: { env: { FOLLOW_THROUGH_MANAGED: "1" } } }; const target = env?.CODEX_HOME ? join(env.CODEX_HOME, "config.toml") : path; await writeFile(target, (await readFile(target, "utf8"))+'[mcp_servers.follow-through]\ncommand = "old"\nargs = []\n'); return { stdout: "added" }; }
    throw new Error("Unexpected command");
  };
  const registry = new AgentMcp(join(root, "plugin-data"), "/fixture/client.js", root, run, path);
  assert.deepEqual(await registry.start(), { claude: "added", codex: "added" });
  const installed = await readFile(path, "utf8"); assert.ok(installed.includes('model = "keep"')); assert.equal(await readFile(path + ".follow-through.bak", "utf8"), 'model = "keep"\n');
  assert.deepEqual(await registry.start(), { claude: "present", codex: "present" }); assert.equal(await readFile(path, "utf8"), installed);
  claude = "Command: other-program"; codex.enabled = false;
  assert.deepEqual(await registry.start(), { claude: "name-conflict", codex: "disabled" }); assert.equal(await readFile(path, "utf8"), installed);
  assert.equal(calls.filter(c=>c.startsWith("claude mcp add-json")).length, 1); assert.equal(calls.filter(c=>c.startsWith("codex mcp add")).length, 1);
});
