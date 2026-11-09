import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHomes, removeGlobalRegistrations, unregisterClaude, withoutCodexEntry } from "../server/mcp-registrations";

const ours = { type: "stdio", command: "/usr/bin/node", args: ["/fixture/mcp.mjs"], env: { FOLLOW_THROUGH_MANAGED: "1", PASEO_HOME: "/fixture" } };
const codex = `model = "x"

[mcp_servers.figma]
url = "https://example.invalid/mcp"

[mcp_servers.follow-through]
command = "/usr/bin/node"
args = ["/fixture/mcp.mjs"]
env_vars = ["PASEO_AGENT_ID", "FOLLOW_THROUGH_RECOVERY"]

[mcp_servers.follow-through.env]
FOLLOW_THROUGH_MANAGED = "1"
PASEO_HOME = "/fixture"

# ── Trusted projects ──
[projects."/fixture"]
trust_level = "trusted"
`;

test("removes only Follow-up's own Codex tables and keeps the rest verbatim", () => {
  const next = withoutCodexEntry(codex)!;
  assert.doesNotMatch(next, /follow-through/);
  assert.match(next, /\[mcp_servers\.figma\]\nurl = "https:\/\/example\.invalid\/mcp"\n\n# ── Trusted projects ──\n\[projects\."\/fixture"\]/);
  assert.equal(withoutCodexEntry('[mcp_servers.other]\ncommand = "x"\n'), null, "absent");
  const foreign = '[mcp_servers.follow-through]\ncommand = "mine"\n';
  assert.equal(withoutCodexEntry(foreign), foreign, "a user's own follow-through entry stays");
});

test("finds default, provider and zerosub homes, and unregisters each with a backup", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-unreg-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), paseo = join(home, ".paseo"), zero = join(paseo, "zerosub/homes/claude-abc"), custom = join(root, "custom-claude");
  for (const dir of [join(home, ".codex"), zero, custom]) await mkdir(dir, { recursive: true });
  await writeFile(join(paseo, "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: custom } } } } }));
  const claudeJson = (servers: Record<string, unknown>) => JSON.stringify({ numStartups: 3, mcpServers: servers }, null, 2) + "\n";
  await writeFile(join(home, ".claude.json"), claudeJson({ "follow-through": ours, other: { type: "stdio", command: "x" } }));
  await writeFile(join(zero, ".claude.json"), claudeJson({ "follow-through": ours }));
  await writeFile(join(custom, ".claude.json"), claudeJson({ "follow-through": { type: "stdio", command: "user's own" } }));
  await writeFile(join(home, ".codex/config.toml"), codex);

  const homes = await agentHomes({}, paseo, home);
  assert.equal(homes.claude.length, 3); assert.equal(homes.codex.length, 1);
  const results = await removeGlobalRegistrations(homes);
  const by = Object.fromEntries(results.map(r => [r.path, r.status]));
  assert.equal(by[join(home, ".claude.json")], "removed");
  assert.equal(by[join(zero, ".claude.json")], "removed");
  assert.equal(by[join(custom, ".claude.json")], "foreign");
  assert.equal(by[join(home, ".codex/config.toml")], "removed");

  const main = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(main.mcpServers), ["other"]); assert.equal(main.numStartups, 3);
  assert.ok(JSON.parse(await readFile(join(home, ".claude.json.follow-through-unregister.bak"), "utf8")).mcpServers["follow-through"], "backup first");
  assert.match(await readFile(join(home, ".codex/config.toml.follow-through-unregister.bak"), "utf8"), /follow-through/);
  // Idempotent: a second pass finds nothing and keeps the first backup.
  assert.deepEqual((await removeGlobalRegistrations(homes)).map(r => r.status).sort(), ["absent", "absent", "absent", "foreign"]);
});

test("a held .claude.json lock is respected", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-unreg-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".claude.json");
  await writeFile(path, JSON.stringify({ mcpServers: { "follow-through": ours } }));
  await mkdir(path + ".lock");
  assert.equal((await unregisterClaude(path)).status, "busy");
  assert.ok(JSON.parse(await readFile(path, "utf8")).mcpServers["follow-through"]);
});
