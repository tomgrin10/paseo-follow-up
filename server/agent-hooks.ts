import { mkdir, readFile, writeFile, rename, copyFile, rm, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { hookSource } from "./hook-source";

const marker = "# paseo-follow-through-hook";
const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
type Handler = { command?: string; [key: string]: unknown };
type Group = { hooks?: Handler[]; [key: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [key: string]: unknown };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function reconcileHooks(settings: Settings, script: string | null): Settings {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    next.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks?.filter(hook => !hook.command?.endsWith(marker)) })).filter(group => !group.hooks || group.hooks.length > 0);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (script) for (const event of events) (next.hooks[event] ??= []).push({ hooks: [{ type: "command", command: `if [ -f ${quote(script)} ]; then node ${quote(script)}; fi ${marker}`, timeout: 10 }] });
  return next;
}
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
async function install(path: string, script: string | null): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const original = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!original && !script) return;
    const settings = original ? JSON.parse(original) : {};
    const next = reconcileHooks(settings, script);
    if (JSON.stringify(settings) === JSON.stringify(next)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (original !== null) {
      await copyFile(path, path + ".follow-through.bak", 1).catch(error => { if (error.code !== "EEXIST") throw error; });
      await chmod(path + ".follow-through.bak", 0o600);
    }
    if (await readFile(path, "utf8").catch(() => null) !== original) continue;
    await atomic(path, next); return;
  }
  throw new Error("Agent hook settings kept changing; Follow-through will retry after reload.");
}
export class AgentHooks {
  constructor(private directory: string, private clientEntry: string, private paths = [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json")]) {}
  async start(): Promise<void> {
    await writeFile(join(this.directory, "agent-hook.mjs"), hookSource, { mode: 0o600 });
    await this.heartbeat();
    const results = await Promise.allSettled(this.paths.map(path => install(path, join(this.directory, "agent-hook.mjs"))));
    if (results.some(result => result.status === "rejected")) throw new Error("Could not register all agent hooks. Check Claude/Codex hook settings; tracking is still available.");
  }
  heartbeat(): Promise<void> { return atomic(join(this.directory, "hooks-enabled.json"), { expiresAt: Date.now() + 120_000, clientEntry: this.clientEntry }); }
  async confirm(workspaceId: string, agentId: string, summary: string): Promise<void> {
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity");
    await atomic(join(this.directory, "hook-state", `sync-${agentId}.json`), { workspaceId, at: Date.now(), summary });
  }
  async stop(): Promise<void> {
    await rm(join(this.directory, "hooks-enabled.json"), { force: true });
    await Promise.all(this.paths.map(path => install(path, null)));
  }
}
