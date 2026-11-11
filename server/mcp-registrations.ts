import { mkdir, readFile, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backupOnce, writeThrough } from "./write-through";

/**
 * 1.4.0-beta.2: Follow-up's tools are served per agent (natively through Paseo's MCP, or a per-agent stdio bridge
 * as the fallback), so the old user-scope "follow-through" registration only made every Claude/Codex session on
 * the machine, Paseo's or not, spawn its own node mcp.mjs. This removes the entries Follow-up wrote
 * (FOLLOW_THROUGH_MANAGED=1) from every Claude and Codex home Paseo launches agents with, backing each file up first.
 * Entries the user added themselves are left alone.
 */
export type Unregistered = { path: string; status: "removed" | "absent" | "foreign" | "busy" | "error"; error?: string };
const NAME = "follow-through";
const BACKUP = ".follow-through-unregister.bak";

/** Every Claude global config (.claude.json) and Codex config.toml Paseo may launch an agent with. */
export async function agentHomes(env: NodeJS.ProcessEnv = process.env, paseoHome = env.PASEO_HOME ?? join(homedir(), ".paseo"), home = homedir()): Promise<{ claude: string[]; codex: string[] }> {
  const claudeDirs = new Set<string | null>([env.CLAUDE_CONFIG_DIR?.trim() || null, null]);
  const codexDirs = new Set<string>([env.CODEX_HOME?.trim() || join(home, ".codex"), join(home, ".codex")]);
  // Homes set in Paseo's provider settings (agents.providers.<id>.env).
  try {
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8"));
    for (const provider of Object.values(config?.agents?.providers ?? {}) as { env?: Record<string, string> }[]) {
      if (provider?.env?.CLAUDE_CONFIG_DIR) claudeDirs.add(provider.env.CLAUDE_CONFIG_DIR);
      if (provider?.env?.CODEX_HOME) codexDirs.add(provider.env.CODEX_HOME);
    }
  } catch {}
  // Homes other plugins create per account (zerosub: ~/.paseo/zerosub/homes/<id>/, Claude and Codex alike).
  for (const root of [join(paseoHome, "zerosub", "homes")]) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      claudeDirs.add(join(root, entry.name)); codexDirs.add(join(root, entry.name));
    }
  }
  const claude = [...claudeDirs].map(dir => dir ? join(resolve(dir), ".claude.json") : join(home, ".claude.json"));
  const codex = [...codexDirs].map(dir => join(resolve(dir), "config.toml"));
  const existing = async (paths: string[]) => [...new Set((await Promise.all(paths.map(async p => (await stat(p).catch(() => null))?.isFile() ? await realpath(p) : null))).filter((p): p is string => !!p))];
  return { claude: await existing(claude), codex: await existing(codex) };
}

/** Claude Code guards .claude.json writes with a `<file>.lock` directory; take it too. False when it's held. */
async function withLock(file: string, action: () => Promise<void>): Promise<boolean> {
  const lock = `${file}.lock`;
  try { await mkdir(lock); } catch {
    const held = await stat(lock).catch(() => null);
    if (held && Date.now() - held.mtimeMs < 10_000) return false;
    await rmdir(lock).catch(() => undefined);
    try { await mkdir(lock); } catch { return false; }
  }
  try { await action(); return true; } finally { await rmdir(lock).catch(() => undefined); }
}
async function replace(path: string, text: string): Promise<void> {
  await backupOnce(path, BACKUP);
  await writeThrough(path, text, (await stat(path)).mode & 0o777);
}
const managed = (server: unknown) => (server as { env?: Record<string, string> } | null)?.env?.FOLLOW_THROUGH_MANAGED === "1";

export async function unregisterClaude(path: string): Promise<Unregistered> {
  try {
    const peek = JSON.parse(await readFile(path, "utf8"));
    if (!peek?.mcpServers?.[NAME]) return { path, status: "absent" };
    if (!managed(peek.mcpServers[NAME])) return { path, status: "foreign" };
    let removed = false;
    const done = await withLock(path, async () => {
      const text = await readFile(path, "utf8"); const config = JSON.parse(text);
      if (!managed(config?.mcpServers?.[NAME])) return;
      delete config.mcpServers[NAME];
      await replace(path, JSON.stringify(config, null, 2) + (text.endsWith("\n") ? "\n" : "")); removed = true;
    });
    return { path, status: done ? removed ? "removed" : "absent" : "busy" };
  } catch (error) { return { path, status: "error", error: (error as Error).message }; }
}

/** Removes [mcp_servers.follow-through] and its .env table when they're Follow-up's, keeping everything else verbatim. */
export function withoutCodexEntry(text: string): string | null {
  const lines = text.split("\n");
  const header = (line: string) => /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)?.[1].replace(/["']/g, "") ?? null;
  const ours = (name: string | null) => name === `mcp_servers.${NAME}` || name?.startsWith(`mcp_servers.${NAME}.`);
  const tables: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ours(header(lines[i]))) continue;
    let end = i + 1;
    while (end < lines.length && header(lines[end]) === null) end++;
    // Comments and blank lines just above the next table belong to it.
    while (end > i + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
    tables.push({ start: i, end }); i = end - 1;
  }
  if (!tables.length) return null;
  const body = tables.map(t => lines.slice(t.start, t.end).join("\n")).join("\n");
  if (!/FOLLOW_THROUGH_MANAGED\s*=\s*["']1["']/.test(body)) return text;
  const keep = lines.filter((_, i) => !tables.some(t => i >= t.start && i < t.end));
  return keep.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function unregisterCodex(path: string): Promise<Unregistered> {
  try {
    const text = await readFile(path, "utf8");
    const next = withoutCodexEntry(text);
    if (next === null) return { path, status: "absent" };
    if (next === text) return { path, status: "foreign" };
    await replace(path, next);
    return { path, status: "removed" };
  } catch (error) { return { path, status: "error", error: (error as Error).message }; }
}

/** Removes Follow-up's own global registrations from every known home. Never throws. */
export async function removeGlobalRegistrations(homes?: { claude: string[]; codex: string[] }): Promise<Unregistered[]> {
  const found = homes ?? await agentHomes().catch(() => ({ claude: [], codex: [] }));
  return Promise.all([...found.claude.map(unregisterClaude), ...found.codex.map(unregisterCodex)]);
}
