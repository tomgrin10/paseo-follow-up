import { HOOK_MARKER, HOOK_MARKERS, withRuntimePrelude } from "../shared/legacy";
import { mkdir, readFile, writeFile, rename, rm, realpath } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { hookSource } from "./hook-source";
import { backupOnce, writeTarget, writeThrough } from "./write-through";


const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
type Handler = { command?: string; [key: string]: unknown };
type Group = { hooks?: Handler[]; [key: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [key: string]: unknown };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function reconcileHooks(settings: Settings, script: string | null): Settings {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    next.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks?.filter(hook => !HOOK_MARKERS.some(marker => hook.command?.endsWith(marker))) })).filter(group => !group.hooks || group.hooks.length > 0);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (script) for (const event of events) (next.hooks[event] ??= []).push({ hooks: [{ type: "command", command: `if [ -f ${quote(script)} ]; then node ${quote(script)}; fi ${HOOK_MARKER}`, timeout: 10 }] });
  return next;
}
/** Follow-up's own files (plugin data dir), never the user's: a plain temp file + rename is right here. */
async function atomic(own: string, value: unknown) {
  await mkdir(dirname(own), { recursive: true, mode: 0o700 });
  const temporary = `${own}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, own);
}
const inside = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
/**
 * Writes Follow-up's hook entries into a user's settings file. The file is often a symlink (dotfiles, a shared
 * account dir): it is read, backed up and replaced at its target, so the link survives (server/write-through.ts).
 * Defense in depth: a Follow-up whose data dir is under the OS temp dir is a harness or test run, and it never
 * writes a settings file outside the temp dir, whatever CLAUDE_CONFIG_DIR/CODEX_HOME it inherited.
 */
async function install(path: string, script: string | null, directory: string): Promise<void> {
  const target = await writeTarget(path);
  const temp = await realpath(tmpdir()).catch(() => tmpdir());
  if (inside(temp, await realpath(directory).catch(() => directory)) && !inside(temp, target)) {
    console.warn(`[follow-up] not writing ${path}: this Follow-up runs from a temp data dir (${directory}), so it's a harness or test, and the settings file is outside the temp dir.`);
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const original = await readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!original && !script) return;
    const settings = original ? JSON.parse(original) : {};
    const next = reconcileHooks(settings, script);
    if (JSON.stringify(settings) === JSON.stringify(next)) return;
    if (original !== null) await backupOnce(target, ".follow-up.bak");
    if (await readFile(target, "utf8").catch(() => null) !== original) continue;
    await writeThrough(target, JSON.stringify(next, null, 2) + "\n"); return;
  }
  throw new Error("Agent hook settings kept changing; Follow-up will retry after reload.");
}
export class AgentHooks {
  constructor(private directory: string, private clientEntry: string, private paths = [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json")]) {}
  async start(): Promise<void> {
    await writeFile(join(this.directory, "agent-hook.mjs"), withRuntimePrelude(hookSource), { mode: 0o600 });
    await this.heartbeat();
    const results = await Promise.allSettled(this.paths.map(path => install(path, join(this.directory, "agent-hook.mjs"), this.directory)));
    const failed = results.flatMap(result => result.status === "rejected" ? [String((result.reason as Error)?.message ?? result.reason)] : []);
    if (failed.length) throw new Error(`Could not register all agent hooks. Check Claude/Codex hook settings; tracking is still available. ${failed.join(" ")}`);
  }
  heartbeat(): Promise<void> { return atomic(join(this.directory, "hooks-enabled.json"), { expiresAt: Date.now() + 120_000, clientEntry: this.clientEntry }); }
  async confirm(workspaceId: string, agentId: string, summary: string): Promise<void> {
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity");
    await atomic(join(this.directory, "hook-state", `sync-${agentId}.json`), { workspaceId, at: Date.now(), summary });
  }
  async stop(): Promise<void> {
    await rm(join(this.directory, "hooks-enabled.json"), { force: true });
    await Promise.all(this.paths.map(path => install(path, null, this.directory)));
  }
}
