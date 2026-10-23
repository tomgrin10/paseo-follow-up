import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, mkdir, copyFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export type McpDefinition = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
type Run = (command: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string }>;
function absent(error: unknown): boolean { const e = error as { stderr?: string; message?: string }; return /No MCP server (?:named|found)|not found|Absent/i.test(e.stderr ?? e.message ?? ""); }
const toml = (value: unknown): string => Array.isArray(value) ? `[${value.map(toml).join(", ")}]` : value && typeof value === "object" ? `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }` : JSON.stringify(value);
const forwarded = ["PASEO_AGENT_ID", "FOLLOW_THROUGH_RECOVERY", "PASEO_PASSWORD", "PASEO_PASSWORD_FILE"];
export function mcpDefinition(directory: string, clientEntry: string, home: string, runtime = { execPath: process.execPath, electron: process.versions.electron, appImage: process.env.APPIMAGE }): McpDefinition {
  return { type: "stdio", command: runtime.electron ? runtime.appImage ?? runtime.execPath : runtime.execPath, args: [join(directory, "mcp.mjs")], env: { FOLLOW_THROUGH_MANAGED: "1", FOLLOW_THROUGH_CLIENT_ENTRY: clientEntry, PASEO_HOME: home, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } };
}
export function claudeMcpMatches(output: string, d: McpDefinition): boolean {
  const lines = output.split(/\r?\n/).map(s => s.trim());
  return lines.includes("Scope: User config (available in all your projects)") && lines.includes(`Command: ${d.command}`) && lines.includes(`Args: ${d.args.join(" ")}`) && Object.entries(d.env).every(([key, value]) => lines.includes(`${key}=${value}`));
}
function valueEnd(text: string, start: number): number {
  let depth = 0, quote = "", escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '\"') escaped = true;
      else if (c === quote) quote = "";
    } else if (c === '\"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") { if (--depth === 0) return i + 1; }
    else if (c === "#") { const end = text.indexOf("\n", i); if (end < 0 || !depth) return i; i = end; }
    else if (c === "\n" && !depth) return i;
  }
  return text.length;
}
function section(text: string, header: string, values: Record<string, unknown>): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^\\[${escaped}\\][ \\t]*\\r?$`, "m").exec(text);
  if (!found) return text.trimEnd() + `\n\n[${header}]\n` + Object.entries(values).map(([k, v]) => `${k} = ${toml(v)}\n`).join("");
  const start = found.index + found[0].length;
  const end = text.slice(start).search(/\n[ \t]*\[[^\]\n]+\][ \t]*(?:#[^\n]*)?(?=\n|$)/);
  const stop = end < 0 ? text.length : start + end;
  let body = text.slice(start, stop);
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}[ \\t]*=[ \\t]*`, "m");
    const match = pattern.exec(body);
    const line = `${key} = ${toml(value)}`;
    body = match ? body.slice(0, match.index) + line + body.slice(valueEnd(body, match.index + match[0].length)) : body.trimEnd() + "\n" + line + "\n";
  }
  return text.slice(0, start) + body + text.slice(stop);
}
export function reconcileCodexMcp(text: string, definition: McpDefinition, envVars: string[] = []): string {
  const primary = section(text, "mcp_servers.follow-through", { command: definition.command, args: definition.args, env_vars: [...new Set([...envVars, ...forwarded])] });
  return section(primary, "mcp_servers.follow-through.env", definition.env);
}
export class AgentMcp {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private clientEntry: string, private home: string, private run: Run = (command, args, env) => exec(command, args, { env: { ...process.env, ...env }, timeout: 20_000, maxBuffer: 1024 * 1024 }), private codexPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml")) {}
  start(): Promise<{ claude: string; codex: string }> {
    const result = this.tail.then(async () => {
      const definition = mcpDefinition(this.directory, this.clientEntry, this.home);
      const results = await Promise.allSettled([this.claude(definition), this.codex(definition)]);
      return { claude: results[0].status === "fulfilled" ? results[0].value : "unavailable", codex: results[1].status === "fulfilled" ? results[1].value : "unavailable" };
    });
    this.tail = result.catch(() => undefined); return result;
  }
  private async claude(definition: McpDefinition): Promise<string> {
    let existing: string | null = null;
    try { existing = (await this.run("claude", ["mcp", "get", "follow-through"])).stdout; } catch (error) { if (!absent(error)) return "unavailable"; }
    if (existing && claudeMcpMatches(existing, definition)) return "present";
    if (existing && !existing.includes("FOLLOW_THROUGH_MANAGED=1")) return "name-conflict";
    if (existing) await this.run("claude", ["mcp", "remove", "follow-through", "--scope", "user"]);
    await this.run("claude", ["mcp", "add-json", "--scope", "user", "follow-through", JSON.stringify(definition)]);
    return existing ? "updated" : "added";
  }
  private async codex(definition: McpDefinition): Promise<string> {
    let current: any = null;
    try { current = JSON.parse((await this.run("codex", ["mcp", "get", "follow-through", "--json"])).stdout); } catch (error) { if (!absent(error)) return "unavailable"; }
    if (current?.enabled === false) return "disabled";
    if (current && current.transport?.env?.FOLLOW_THROUGH_MANAGED !== "1") return "name-conflict";
    const before = await readFile(this.codexPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (before) { await mkdir(dirname(this.codexPath), { recursive: true, mode: 0o700 }); await copyFile(this.codexPath, this.codexPath + ".follow-through.bak", 1).catch(error => { if (error.code !== "EEXIST") throw error; }); await chmod(this.codexPath + ".follow-through.bak", 0o600); }
    if (!current) {
      // Codex reserializes unrelated tables; stage its write to preserve the user’s text.
      const staging = await mkdtemp(join(tmpdir(), "follow-mcp-config-"));
      try {
        await writeFile(join(staging, "config.toml"), before, { mode: 0o600 });
        await this.run("codex", ["mcp", "add", "follow-through", ...Object.entries(definition.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", definition.command, ...definition.args], { CODEX_HOME: staging });
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    await mkdir(dirname(this.codexPath), { recursive: true, mode: 0o700 });
    for (let i = 0; i < 5; i++) {
      const original = await readFile(this.codexPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      const next = reconcileCodexMcp(original, definition, current?.transport?.env_vars ?? []);
      if (next === original) return "present";
      if (await readFile(this.codexPath, "utf8").catch(() => "") !== original) continue;
      const temporary = this.codexPath + "." + randomUUID();
      await writeFile(temporary, next, { mode: 0o600 }); await rename(temporary, this.codexPath);
      try { JSON.parse((await this.run("codex", ["mcp", "get", "follow-through", "--json"])).stdout); }
      catch (error) {
        if (await readFile(this.codexPath, "utf8") === next) { await writeFile(temporary, original, { mode: 0o600 }); await rename(temporary, this.codexPath); }
        throw error;
      }
      return current ? "updated" : "added";
    }
    throw new Error("Codex settings changed during registration");
  }
}
