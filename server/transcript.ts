import type { Dirent } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { TailStep } from "../shared/home";

/**
 * An unloaded agent's recent steps, read from its provider's transcript on disk. Read-only and never
 * through the daemon: reading a timeline loads the agent for an hour (see shared/agent-load.ts).
 *
 * The record is Paseo's per-agent JSON under `$PASEO_HOME/agents/<cwd dir>/<agentId>.json`. The mapping
 * from record to file follows paseo-transcript-search:
 * - Claude Code: `<config>/projects/<encoded cwd>/<sessionId>.jsonl`, falling back to that file name in any project.
 * - Codex: `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl` (or `archived_sessions/`).
 * - Anything else whose native handle is an absolute path to a file.
 * Every field is optional and unknown lines are skipped, so format drift degrades to fewer steps, never an error.
 * Only the file's last TAIL_BYTES are read.
 */

export const TAIL_BYTES = 512 * 1024;
type Persistence = { sessionId?: string | null; nativeHandle?: string | null };
export type AgentRecordLite = { id: string; provider: string; cwd: string; persistence: Persistence | null };

const list = async (path: string): Promise<Dirent[]> => { try { return await readdir(path, { withFileTypes: true }); } catch { return []; } };
const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };

/** The agent's stored record (provider, cwd, session id). Credentials in `persistence.metadata` are never kept. */
export async function agentRecord(paseoHome: string, agentId: string): Promise<AgentRecordLite | null> {
  if (!/^[\w-]+$/.test(agentId)) return null;
  const root = join(paseoHome, "agents");
  for (const d of await list(root)) {
    if (!d.isDirectory()) continue;
    try {
      const raw = JSON.parse(await readFile(join(root, d.name, `${agentId}.json`), "utf8"));
      if (raw?.id !== agentId || typeof raw.provider !== "string") continue;
      const p = raw.persistence && typeof raw.persistence === "object" ? raw.persistence : null;
      return { id: agentId, provider: raw.provider, cwd: typeof raw.cwd === "string" ? raw.cwd : "", persistence: p ? { sessionId: str(p.sessionId), nativeHandle: str(p.nativeHandle) } : null };
    } catch { /* not in this directory */ }
  }
  return null;
}
const str = (v: unknown) => typeof v === "string" && v ? v : null;

/** Claude's project directory name for a cwd (ported from the daemon's project-dir.ts). */
export function encodeProjectDir(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= 200) return replaced;
  let h = 0; for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return `${replaced.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

export type TranscriptRoots = { claude?: string; codex?: string };
const claudeRoot = (r?: TranscriptRoots) => r?.claude ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexRoot = (r?: TranscriptRoots) => r?.codex ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

export async function transcriptFile(record: AgentRecordLite, roots?: TranscriptRoots): Promise<string | null> {
  const p = record.persistence;
  if (record.provider === "claude") {
    const id = p?.sessionId ?? p?.nativeHandle;
    if (!id || !/^[\w-]+$/.test(id)) return null;
    const projects = join(claudeRoot(roots), "projects");
    const dirs = new Set<string>();
    if (record.cwd) { try { dirs.add(encodeProjectDir(await realpath(record.cwd))); } catch { /* worktree gone */ } dirs.add(encodeProjectDir(record.cwd)); }
    for (const d of dirs) { const f = join(projects, d, `${id}.jsonl`); if (await isFile(f)) return f; }
    for (const d of await list(projects)) { if (!d.isDirectory()) continue; const f = join(projects, d.name, `${id}.jsonl`); if (await isFile(f)) return f; }
    return null;
  }
  if (record.provider === "codex") {
    const id = p?.nativeHandle ?? p?.sessionId;
    if (!id || !/^[\w-]+$/.test(id)) return null;
    const suffix = `-${id}.jsonl`;
    for (const top of ["sessions", "archived_sessions"]) {
      const queue = [join(codexRoot(roots), top)];
      while (queue.length) {
        const dir = queue.shift()!;
        for (const e of await list(dir)) {
          const path = join(dir, e.name);
          if (e.isDirectory()) queue.push(path);
          else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) return path;
        }
      }
    }
    return null;
  }
  const handle = p?.nativeHandle;
  return handle && isAbsolute(handle) && await isFile(handle) ? handle : null;
}

/** The last TAIL_BYTES of a file, split into whole lines. */
async function tailLines(path: string, bytes = TAIL_BYTES): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally { await handle.close(); }
}

const tool = (name: unknown) => typeof name === "string" ? name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "") : "tool";
/** Text the developer typed, not harness wrappers (command caveats, system reminders, environment context). */
const typed = (text: string) => { const t = text.trim(); return t && !t.startsWith("<") ? t : null; };

/** Steps from transcript lines (Claude Code or Codex rollout), oldest first. Unknown shapes are skipped. */
export function transcriptSteps(lines: string[]): TailStep[] {
  const out: TailStep[] = [];
  for (const line of lines) {
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== "object") continue;
    // Claude Code
    if ((j.type === "user" || j.type === "assistant") && j.message && !j.isMeta && !j.isSidechain) {
      const content = j.message.content;
      if (typeof content === "string") { const t = j.type === "user" ? typed(content) : content.trim(); if (t) out.push({ kind: j.type === "user" ? "you" : "agent", text: t }); continue; }
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") { const t = j.type === "user" ? typed(c.text) : c.text.trim(); if (t) out.push({ kind: j.type === "user" ? "you" : "agent", text: t }); }
        else if (c?.type === "tool_use") out.push({ kind: "tool", text: tool(c.name) });
      }
      continue;
    }
    // Codex rollout
    const p = j.type === "response_item" ? j.payload : null;
    if (p?.type === "message" && (p.role === "user" || p.role === "assistant") && Array.isArray(p.content)) {
      for (const c of p.content) {
        if (typeof c?.text !== "string") continue;
        const t = p.role === "user" ? typed(c.text) : c.text.trim();
        if (t) out.push({ kind: p.role === "user" ? "you" : "agent", text: t });
      }
    } else if (p?.type === "function_call" || p?.type === "custom_tool_call" || p?.type === "local_shell_call") out.push({ kind: "tool", text: tool(p.name ?? "shell") });
  }
  return out;
}

/** The agent's last `n` steps from disk, or null when there is no readable transcript. */
export async function transcriptTail(paseoHome: string, agentId: string, n: number, roots?: TranscriptRoots): Promise<TailStep[] | null> {
  try {
    const record = await agentRecord(paseoHome, agentId);
    const file = record && await transcriptFile(record, roots);
    if (!file) return null;
    return transcriptSteps(await tailLines(file)).slice(-n);
  } catch { return null; }
}

// "What's this about?": the first developer messages and the latest items, as timeline-like items. Uses the same
// record and path rules as transcriptTail; reads only the file's first HEAD_BYTES and last TAIL_BYTES.
const HEAD_BYTES = 256 * 1024;
export type TranscriptItem = { type: "user_message" | "assistant_message" | "tool_call"; text?: string; name?: string; detail?: { output: string } };

/** The first and last bytes of a file; lines cut at the edges are dropped. */
export async function headAndTail(path: string): Promise<{ head: string[]; tail: string[] }> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const read = async (position: number, length: number) => { const buf = Buffer.alloc(length); const { bytesRead } = await handle.read(buf, 0, length, position); return buf.subarray(0, bytesRead).toString("utf8"); };
    if (size <= HEAD_BYTES + TAIL_BYTES) { const all = (await read(0, size)).split("\n"); return { head: all, tail: all }; }
    const head = (await read(0, HEAD_BYTES)).split("\n"); head.pop();
    const tail = (await read(size - TAIL_BYTES, TAIL_BYTES)).split("\n"); tail.shift();
    return { head, tail };
  } finally { await handle.close(); }
}

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(c => c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "").filter(Boolean).join("\n") : "";
const outputOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map(c => typeof c === "string" ? c : textOf([c])).join("\n") : "";

/** One transcript line as timeline-like items (Claude or Codex), tool output included (capped). Unknown shapes give none. */
export function parseLine(line: string): TranscriptItem[] {
  if (!line.trim()) return [];
  let j: Record<string, any>;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  if ((j.type === "user" || j.type === "assistant") && j.message && typeof j.message === "object") {
    if (j.isSidechain || j.isMeta) return [];
    const content = j.message.content;
    const out: TranscriptItem[] = [];
    if (typeof content === "string") out.push({ type: j.type === "user" ? "user_message" : "assistant_message", text: content });
    else if (Array.isArray(content)) for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") out.push({ type: j.type === "user" ? "user_message" : "assistant_message", text: c.text });
      else if (c.type === "tool_use" && typeof c.name === "string") out.push({ type: "tool_call", name: c.name });
      else if (c.type === "tool_result") { const o = outputOf(c.content); if (o) out.push({ type: "tool_call", name: "result", detail: { output: o.slice(0, 4000) } }); }
    }
    return out;
  }
  const p = j.type === "response_item" ? j.payload : null;
  if (p && typeof p === "object") {
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) { const t = textOf(p.content); return t ? [{ type: p.role === "user" ? "user_message" : "assistant_message", text: t }] : []; }
    if (p.type === "function_call" && typeof p.name === "string") return [{ type: "tool_call", name: p.name }];
    if (p.type === "function_call_output") { const o = typeof p.output === "string" ? p.output : outputOf(p.output?.content ?? p.output); return o ? [{ type: "tool_call", name: "result", detail: { output: o.slice(0, 4000) } }] : []; }
  }
  return [];
}

/** Codex and Claude both inject instructions as user messages; they aren't the developer's words. */
const injected = (text: string) => /^\s*(<|# AGENTS\.md instructions|<INSTRUCTIONS>|Caveat: The messages below)/.test(text);

/** The first developer messages and the last `limit` items of an agent's transcript, or null when there is none. */
export async function readTranscript(paseoHome: string, agentId: string, limit: number, roots?: TranscriptRoots): Promise<{ first: TranscriptItem[]; tail: TranscriptItem[] } | null> {
  try {
    const record = await agentRecord(paseoHome, agentId);
    const path = record && await transcriptFile(record, roots);
    if (!path) return null;
    const { head, tail } = await headAndTail(path);
    const first = head.flatMap(parseLine).filter(i => i.type === "user_message" && i.text && !injected(i.text)).slice(0, 2);
    const items = tail.flatMap(parseLine).filter(i => i.type !== "user_message" || (i.text && !injected(i.text)));
    return { first, tail: items.slice(-limit) };
  } catch { return null; }
}
