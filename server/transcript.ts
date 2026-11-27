import type { Dirent } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { userStep, type TailStep } from "../shared/home";
import { developerWords, messageSender, workItems } from "../shared/message-sender";
import { foldTurn, type Turn, type TurnItem } from "../shared/turn";

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

/**
 * Claude Code records Stop-hook feedback as an isMeta user line. Meta lines are otherwise skipped, but this one is
 * kept as a user message so the classifier can see Follow-up's own nudge and drop the bookkeeping that answered it.
 */
const hookFeedback = (j: any) => j.isMeta && j.type === "user" && /^\w+ hook feedback:/.test(typeof j.message?.content === "string" ? j.message.content : textOf(j.message?.content));

type Raw = { type: "user_message" | "assistant_message" | "tool"; text: string };
/** Steps from transcript lines (Claude Code or Codex rollout), oldest first. Unknown shapes are skipped. */
export function transcriptSteps(lines: string[]): TailStep[] {
  const raw: Raw[] = [];
  const text = (user: boolean, t: string) => raw.push({ type: user ? "user_message" : "assistant_message", text: t });
  for (const line of lines) {
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== "object") continue;
    // Claude Code
    if ((j.type === "user" || j.type === "assistant") && j.message && (!j.isMeta || hookFeedback(j)) && !j.isSidechain) {
      const content = j.message.content;
      if (typeof content === "string") { text(j.type === "user", content); continue; }
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") text(j.type === "user", c.text);
        else if (c?.type === "tool_use") raw.push({ type: "tool", text: tool(c.name) });
      }
      continue;
    }
    // Codex rollout
    const p = j.type === "response_item" ? j.payload : null;
    if (p?.type === "message" && (p.role === "user" || p.role === "assistant") && Array.isArray(p.content)) {
      for (const c of p.content) if (typeof c?.text === "string") text(p.role === "user", c.text);
    } else if (p?.type === "function_call" || p?.type === "custom_tool_call" || p?.type === "local_shell_call") raw.push({ type: "tool", text: tool(p.name ?? "shell") });
  }
  // The sender classifier: You only for the developer; Follow-up's hook feedback and the bookkeeping after it dropped.
  const out: TailStep[] = [];
  for (const r of workItems(raw)) {
    if (r.type === "user_message") { const step = userStep(r.text); if (step) out.push(step); }
    else if (r.type === "tool") out.push({ kind: "tool", text: r.text });
    else { const t = r.text.trim(); if (t) out.push({ kind: "agent", text: t }); }
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

// Summary: the first developer messages and the latest items, as timeline-like items. Uses the same
// record and path rules as transcriptTail; reads only the file's first HEAD_BYTES and last TAIL_BYTES.
const HEAD_BYTES = 256 * 1024;
export type TranscriptItem = { type: "user_message" | "assistant_message" | "tool_call"; text?: string; name?: string; detail?: { output: string } };

/** The first and last bytes of a file; lines cut at the edges are dropped. */
/**
 * Whether a transcript's read part holds `marker` since `sinceMs`: true when a line has it; false only when the read
 * part provably reaches back to `sinceMs` (the whole file was read, or its first dated line is no later) and no line has
 * it; null otherwise. Lines are JSONL (Claude and Codex both date each line with `timestamp`).
 */
export function markerSince(lines: readonly string[], whole: boolean, sinceMs: number, marker: string): boolean | null {
  if (!marker) return null;
  const needle = JSON.stringify(marker).slice(1, -1);
  if (lines.some(line => line.includes(needle))) return true;
  return whole || reachesBack(lines, sinceMs) ? false : null;
}
/** Whether the first dated line (`"timestamp"`) is no later than `sinceMs`: the lines cover everything since then. */
function reachesBack(lines: readonly string[], sinceMs: number): boolean {
  for (const line of lines) {
    const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    if (Number.isFinite(at)) return at <= sinceMs;
  }
  return false;
}


/** How far back from its end a transcript is read for a send's marker, in chunks. Only an unconfirmed send reads it. */
export const MARKER_READ_MAX_BYTES = 32 * 1024 * 1024;
const MARKER_CHUNK_BYTES = 1024 * 1024;

/**
 * Whether the transcript at `path` holds `marker` since `sinceMs`, read backwards from its end in 1 MB chunks until a
 * chunk reaches back past `sinceMs`, the file's start, or MARKER_READ_MAX_BYTES: a busy agent writes megabytes between a
 * send and its check, so a fixed tail can't say "not there". Each chunk is searched raw for the marker first; only the
 * chunk's first dated line is parsed. Same answers as markerSince.
 */
export async function markerInFile(path: string, sinceMs: number, marker: string, maxBytes = MARKER_READ_MAX_BYTES): Promise<boolean | null> {
  if (!marker) return null;
  const needle = Buffer.from(JSON.stringify(marker).slice(1, -1));
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    let end = size; let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - MARKER_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      // The chunk plus the next one's head, so a marker cut at the edge is still found.
      const joined = Buffer.concat([buf.subarray(0, bytesRead), carry.subarray(0, needle.length)]);
      if (joined.includes(needle)) return true;
      if (start === 0) return false;
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n"); lines.shift();
      if (reachesBack(lines, sinceMs)) return false;
      carry = buf.subarray(0, bytesRead); end = start;
    }
    return null;
  } finally { await handle.close(); }
}

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
    if (j.isSidechain || j.isMeta && !hookFeedback(j)) return [];
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


/** The first developer messages and the last `limit` items of an agent's transcript, or null when there is none. */
export async function readTranscript(paseoHome: string, agentId: string, limit: number, roots?: TranscriptRoots): Promise<{ first: TranscriptItem[]; tail: TranscriptItem[] } | null> {
  try {
    const record = await agentRecord(paseoHome, agentId);
    const path = record && await transcriptFile(record, roots);
    if (!path) return null;
    const { head, tail } = await headAndTail(path);
    // Only the developer's words are "first messages"; Summary's tailLines classifies the tail's user lines itself.
    const first = head.flatMap(parseLine).flatMap(i => { const words = i.type === "user_message" && i.text ? developerWords(i.text) : null; return words ? [{ ...i, text: words }] : []; }).slice(0, 2);
    // Follow-up's hook feedback and the agent's bookkeeping after it are not the work (workItems).
    const items = workItems(tail.flatMap(parseLine)).filter(i => i.type !== "user_message" || (i.text && messageSender(i.text).kind !== "system"));
    return { first, tail: items.slice(-limit) };
  } catch { return null; }
}

// The peek (shared/turn.ts): an unloaded agent's last turn from disk, as timeline-like items with each tool's input, so
// foldTurn draws it like the live timeline. Read-only, never through the daemon (invariant 1).

/** A provider tool call as a timeline tool call: the typed detail Paseo would give it. */
export function toolItem(name: string, input: unknown): TurnItem {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (v: unknown) => typeof v === "string" ? v : undefined;
  const lower = name.toLowerCase();
  const cmd = s(o.command) ?? s(o.cmd) ?? (Array.isArray(o.command) ? (o.command as unknown[]).map(String).join(" ") : undefined);
  const detail: Record<string, unknown> | null =
    lower === "bash" || lower === "shell" || lower === "exec_command" || lower === "local_shell" ? { type: "shell", command: cmd ?? "" }
    : lower === "read" ? { type: "read", filePath: s(o.file_path) ?? s(o.path) }
    : lower === "edit" || lower === "multiedit" || lower === "apply_patch" || lower === "notebookedit" ? { type: "edit", filePath: s(o.file_path) ?? s(o.path) ?? s(o.notebook_path) }
    : lower === "write" ? { type: "write", filePath: s(o.file_path) ?? s(o.path) }
    : lower === "grep" || lower === "glob" ? { type: "search", pattern: s(o.pattern) }
    : lower === "websearch" ? { type: "search", query: s(o.query) }
    : lower === "webfetch" ? { type: "fetch", url: s(o.url) }
    : lower === "task" || lower === "agent" ? { type: "sub_agent", description: s(o.description) ?? s(o.prompt) }
    : null;
  return { type: "tool_call", name: lower === "websearch" ? "web_search" : name, status: "completed", detail };
}

/** Transcript lines (Claude Code or Codex rollout) as the peek's items, oldest first, and when the last line was written. */
export function transcriptTurnItems(lines: string[]): { items: TurnItem[]; at: string | null } {
  const items: TurnItem[] = []; let at: string | null = null;
  for (const line of lines) {
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== "object") continue;
    if (typeof j.timestamp === "string") at = j.timestamp;
    if ((j.type === "user" || j.type === "assistant") && j.message && (!j.isMeta || hookFeedback(j)) && !j.isSidechain) {
      const user = j.type === "user"; const content = j.message.content;
      if (typeof content === "string") { items.push({ type: user ? "user_message" : "assistant_message", text: content }); continue; }
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") items.push({ type: user ? "user_message" : "assistant_message", text: c.text });
        else if (c?.type === "thinking") items.push({ type: "reasoning", text: "" });
        else if (c?.type === "tool_use" && typeof c.name === "string") {
          if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) items.push({ type: "todo", items: c.input.todos.map((t: any) => ({ text: String(t?.content ?? ""), status: String(t?.status ?? "") })) });
          else items.push(toolItem(c.name, c.input));
        } else if (c?.type === "tool_result" && c.is_error) { const last = items.findLast(i => i.type === "tool_call"); if (last) last.status = "failed"; }
      }
      continue;
    }
    const p = j.type === "response_item" ? j.payload : null;
    if (p?.type === "message" && (p.role === "user" || p.role === "assistant") && Array.isArray(p.content)) {
      for (const c of p.content) if (typeof c?.text === "string") items.push({ type: p.role === "user" ? "user_message" : "assistant_message", text: c.text });
    } else if (p?.type === "reasoning") items.push({ type: "reasoning", text: "" });
    else if (p?.type === "function_call" || p?.type === "custom_tool_call" || p?.type === "local_shell_call") {
      let args: unknown = p.arguments ?? p.input ?? p.action;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* a patch or plain text */ } }
      items.push(toolItem(p.name ?? "shell", args));
    }
  }
  return { items, at };
}

/** An unloaded agent's last turn from its transcript on disk, or null when there is no readable transcript. */
export async function transcriptTurn(paseoHome: string, agentId: string, roots?: TranscriptRoots): Promise<{ turn: Turn; at: string | null } | null> {
  try {
    const record = await agentRecord(paseoHome, agentId);
    const file = record && await transcriptFile(record, roots);
    if (!file) return null;
    const { items, at } = transcriptTurnItems(await tailLines(file));
    return { turn: foldTurn(items, false), at };
  } catch { return null; }
}
