import { userStep } from "./home";
import { workItems } from "./message-sender";
import { ago } from "./attention";

/**
 * The agent's current turn as its chat draws it, condensed (the peek, and later the workspace view's Recent steps).
 * One pure fold, `foldTurn`, over timeline items (a loaded agent's live timeline) or transcript items (an unloaded
 * agent's file on disk, server/transcript.ts `transcriptTurn`), so both read the same rows.
 *
 * It copies how Paseo's timeline looks with the Chat Polish plugin, which restyles it: a run of thoughts and tool
 * calls between two replies is one row ("Ran 4 commands and edited 2 files", or the live step's verb while it runs)
 * that opens to its steps; each step is an icon, a verb and a target ("Ran `npm test`", "Read `src/a.ts`", "Called
 * Follow update obligation"). The verbs, icons and summary words follow Chat Polish's `client/model.ts` (`toolData`)
 * and `client/steps.ts` (`stepSummary`). A plugin can't draw the host's timeline (Paseo 0.17 has no such component),
 * so this is a copy: if Chat Polish changes its words, change them here too.
 *
 * Bounded (invariant `a-peek-is-bounded`): at most TURN_ROWS rows and TURN_STEPS steps in an open run; older steps
 * fold into one run that keeps only their counts; text is capped. A long turn costs the same as a short one.
 */

export const TURN_ROWS = 10;
export const TURN_STEPS = 12;
export const REPLY_CHARS = 1200;
export const MESSAGE_CHARS = 400;

/** One timeline-like item (Paseo's `AgentTimelineItem`, loosely: every field optional, unknown shapes skipped). */
export type TurnItem = {
  type: string; text?: string; message?: string; name?: string; status?: string; error?: unknown;
  detail?: Record<string, unknown> | null; items?: { text?: string; status?: string; completed?: boolean }[];
};

export type StepStatus = "running" | "done" | "failed" | "canceled";
export type TurnStep = { icon: string; verb: string; target?: string; mono?: boolean; status: StepStatus };
export type RunCounts = { thoughts: number; commands: number; read: number; edited: number; searches: number; other: number; paseo: number };
export type TurnRow =
  | { kind: "you"; text: string }
  | { kind: "message"; from: string; text: string }
  | { kind: "reply"; text: string }
  | { kind: "run"; key: string; steps: TurnStep[]; hidden: number; counts: RunCounts; live: boolean; failed: number }
  | { kind: "tasks"; done: number; total: number; active: string | null }
  | { kind: "notice"; text: string; live: boolean }
  | { kind: "error"; text: string };
export type Turn = { rows: TurnRow[]; empty: boolean };

const firstLine = (s: string) => s.split("\n").find(l => l.trim())?.trim() ?? "";
const str = (v: unknown) => typeof v === "string" && v.trim() ? v : undefined;
/** "AskUserQuestion", "create_agent" → "Ask user question", "Create agent" (Chat Polish's `readable`). */
export const readable = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._\s-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const PASEO = /^(mcp__paseo__|paseo\.)/i;
/** An MCP tool's readable name ("mcp__paseo__follow_update_obligation" → "Follow update obligation"). */
function mcpName(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([\w-]+)\.([\w.-]+)$/.exec(name);
  if (!m) return null;
  return /^paseo/i.test(m[1]!) ? readable(m[2]!) : `${m[1]} › ${readable(m[2]!)}`;
}
const tense = (running: boolean, now: string, done: string) => running ? now : done;

/** One tool call as a step: Chat Polish's icon, verb (running or done) and target. */
export function stepOf(item: TurnItem): TurnStep {
  const status: StepStatus = item.status === "running" || item.status === "executing" ? "running" : item.status === "failed" || item.error ? "failed" : item.status === "canceled" ? "canceled" : "done";
  const running = status === "running";
  const d = item.detail ?? {};
  const name = item.name ?? "";
  const path = str(d.filePath) ?? str(d.path);
  switch (d.type) {
    case "shell": return { icon: "SquareTerminal", verb: tense(running, "Running", "Ran"), target: firstLine(str(d.command) ?? ""), mono: true, status };
    case "read": return { icon: "Eye", verb: tense(running, "Reading", "Read"), target: path, mono: true, status };
    case "edit": return { icon: "Pencil", verb: tense(running, "Editing", "Edited"), target: path, mono: true, status };
    case "write": return { icon: "FilePlus", verb: tense(running, "Writing", "Wrote"), target: path, mono: true, status };
    case "search": {
      const web = /web/i.test(name);
      return { icon: web ? "Globe" : "Search", verb: tense(running, web ? "Searching web" : "Searching", web ? "Searched web" : "Searched"), target: str(d.query) ?? str(d.pattern), mono: !web, status };
    }
    case "fetch": return { icon: "Globe", verb: tense(running, "Fetching", "Fetched"), target: str(d.url), mono: true, status };
    case "sub_agent": return { icon: "Bot", verb: "Sub agent", target: str(d.description) ? firstLine(d.description as string) : undefined, status };
    case "worktree_setup": return { icon: "GitBranch", verb: tense(running, "Setting up worktree", "Set up worktree"), status };
  }
  if (/^thinking$/i.test(name)) return { icon: "Brain", verb: tense(running, "Thinking", "Thought"), status };
  const mcp = mcpName(name);
  if (mcp) return { icon: "Blocks", verb: tense(running, "Calling", "Called"), target: mcp, status };
  if (/^(bash|shell|exec_command|local_shell)$/i.test(name)) return { icon: "SquareTerminal", verb: tense(running, "Running", "Ran"), target: firstLine(str(d.command) ?? ""), mono: true, status };
  return { icon: "Wrench", verb: tense(running, "Calling", "Called"), target: name ? readable(name) : undefined, status };
}

const isAgentMessage = (it: TurnItem) => it.type === "tool_call" && (it.name === "agent_message" || !!(it as { agentMessage?: unknown }).agentMessage);
const isStep = (it: TurnItem) => (it.type === "tool_call" && !isAgentMessage(it)) || it.type === "reasoning";
const emptyCounts = (): RunCounts => ({ thoughts: 0, commands: 0, read: 0, edited: 0, searches: 0, other: 0, paseo: 0 });
function count(c: RunCounts, it: TurnItem, files: { read: Set<string>; edited: Set<string> }) {
  if (it.type === "reasoning") { c.thoughts++; return; }
  const d = it.detail ?? {}; const path = str(d.filePath) ?? str(d.path) ?? `#${c.edited + c.read}`;
  if (PASEO.test(it.name ?? "")) c.paseo++;
  else if (d.type === "edit" || d.type === "write") { files.edited.add(path); c.edited = files.edited.size; }
  else if (d.type === "shell" || /^(bash|shell|exec_command)$/i.test(it.name ?? "")) c.commands++;
  else if (d.type === "read") { files.read.add(path); c.read = files.read.size; }
  else if (d.type === "search") c.searches++;
  else c.other++;
}
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
/** "Ran 4 commands and edited 2 files": Chat Polish's `stepSummary` order and words. */
export function runSummary(c: RunCounts): string {
  const parts = [
    c.thoughts && `thought ${n(c.thoughts, "time", "times")}`,
    c.edited && `edited ${n(c.edited, "file", "files")}`,
    c.commands && `ran ${n(c.commands, "command", "commands")}`,
    c.read && `read ${n(c.read, "file", "files")}`,
    c.searches && `searched ${n(c.searches, "time", "times")}`,
    c.other && `used ${n(c.other, "other tool", "other tools")}`,
    c.paseo && `called Paseo ${n(c.paseo, "time", "times")}`,
  ].filter((p): p is string => !!p);
  const text = parts.length > 2 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts.join(" and ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Working";
}
export const runSteps = (r: Extract<TurnRow, { kind: "run" }>) => r.steps.length + r.hidden;

/** The run row's label: the live step's verb while it runs (Tom's chat: "Running · 6 steps"), else what it did. */
export function runLabel(r: Extract<TurnRow, { kind: "run" }>): string {
  if (r.live) return r.steps.findLast(s => s.status === "running")?.verb ?? "Working";
  return runSummary(r.counts);
}

const cap = (s: string, max: number) => s.length > max ? `…${s.slice(s.length - max).replace(/^\S*\s/, "")}` : s;
const capStart = (s: string, max: number) => s.length > max ? `${s.slice(0, max).replace(/\s\S*$/, "")}…` : s;

/**
 * The current turn: from the last message that started one (the developer's, or anyone's) to now, as the chat's rows.
 * `live`: the agent is mid-turn, so the last run is live while its last step runs (or the agent is still adding to it).
 */
export function foldTurn(all: readonly TurnItem[], live: boolean): Turn {
  const items = workItems(all as TurnItem[]);
  let start = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "user_message" && items[i]!.text && userStep(items[i]!.text!)) { start = i; break; }
  const turn = start >= 0 ? items.slice(start) : items;
  const rows: TurnRow[] = [];
  type Run = { steps: TurnStep[]; counts: RunCounts; files: { read: Set<string>; edited: Set<string> }; key: string };
  let tasks = null as Extract<TurnRow, { kind: "tasks" }> | null;
  let run = null as Run | null;
  let reply = null as Extract<TurnRow, { kind: "reply" }> | null;
  const closeRun = () => {
    if (!run) return;
    const steps = run.steps;
    rows.push({ kind: "run", key: run.key, steps: steps.slice(-TURN_STEPS), hidden: Math.max(0, steps.length - TURN_STEPS), counts: run.counts, live: false, failed: steps.filter(s => s.status === "failed").length });
    run = null;
  };
  turn.forEach((it, i) => {
    if (isStep(it)) {
      reply = null;
      run ??= { steps: [], counts: emptyCounts(), files: { read: new Set(), edited: new Set() }, key: `run-${i}` };
      count(run.counts, it, run.files);
      run.steps.push(it.type === "reasoning" ? { icon: "Brain", verb: "Thought", status: "done" } : stepOf(it));
      return;
    }
    if (it.type === "todo" && Array.isArray(it.items)) {
      const all = it.items; const done = all.filter(t => t.completed || t.status === "completed").length;
      const active = all.find(t => t.status === "in_progress")?.text ?? null;
      if (tasks) { tasks.done = done; tasks.total = all.length; tasks.active = active; } else { tasks = { kind: "tasks", done, total: all.length, active }; }
      return;
    }
    closeRun();
    if (it.type === "user_message" && it.text) {
      reply = null;
      const s = userStep(it.text);
      if (s?.kind === "you") rows.push({ kind: "you", text: capStart(s.text.trim(), MESSAGE_CHARS) });
      else if (s?.kind === "message") rows.push({ kind: "message", from: s.from, text: capStart(s.text.trim(), MESSAGE_CHARS) });
    } else if (it.type === "assistant_message" && it.text) {
      // Streaming arrives as chunks of one message: join consecutive agent text.
      if (reply) reply.text = cap(reply.text + it.text, REPLY_CHARS);
      else { reply = { kind: "reply", text: cap(it.text, REPLY_CHARS) }; rows.push(reply); }
    } else if (it.type === "error" && (it.message || it.text)) {
      reply = null; rows.push({ kind: "error", text: capStart(String(it.message ?? it.text), MESSAGE_CHARS) });
    } else if (it.type === "compaction") {
      reply = null; rows.push({ kind: "notice", text: it.status === "loading" ? "Compacting context" : "Context compacted", live: it.status === "loading" });
    }
  });
  closeRun();
  // The last run is live while the turn is: its running step, or the agent still adding to it after its last reply.
  if (live) {
    const last = rows.at(-1);
    if (last?.kind === "run") last.live = true;
    for (const r of rows) if (r.kind === "notice" && r !== rows.at(-1)) r.live = false;
  } else for (const r of rows) if (r.kind === "notice") r.live = false;
  return { rows: bound(tasks ? [...rows, tasks] : rows), empty: !rows.length && !tasks };
}

/** A folded turn cut to at most `max` rows (narrow surfaces show fewer): older rows fold the same way. */
export const fitTurn = (turn: Turn, max: number): Turn => ({ ...turn, rows: bound(turn.rows, Math.max(1, Math.min(TURN_ROWS, Math.floor(max)))) });

/** At most `max` rows: older ones fold into one closed run that keeps only their step counts. */
function bound(rows: TurnRow[], max = TURN_ROWS): TurnRow[] {
  if (rows.length <= max) return rows;
  const cut = rows.length - (max - 1);
  const older = rows.slice(0, cut);
  const runs = older.filter((r): r is Extract<TurnRow, { kind: "run" }> => r.kind === "run");
  const kept = rows.slice(cut);
  if (!runs.length) return rows.slice(-max);
  const counts = emptyCounts();
  for (const r of runs) for (const k of Object.keys(counts) as (keyof RunCounts)[]) counts[k] += r.counts[k];
  const hidden = runs.reduce((s, r) => s + runSteps(r), 0);
  return [{ kind: "run", key: "earlier", steps: [], hidden, counts, live: false, failed: runs.reduce((s, r) => s + r.failed, 0) }, ...kept];
}

/** Where a turn came from: a live timeline, or an unloaded agent's saved transcript (never woken). */
export type TurnSource = "live" | "saved";
/** "Saved transcript · last active 3h ago" for a saved turn; null for a live one (live needs no caption). */
export function turnSource(state: { source: TurnSource | null; at: string | null }, now = Date.now()): string | null {
  if (state.source !== "saved") return null;
  const when = ago(state.at, now);
  return when ? `Saved transcript · last active ${when}` : "Saved transcript";
}
