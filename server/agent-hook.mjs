#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
// One place for Follow-up's words and the one turn-end decision (shared/agent-text.mjs, shared/turn-checks.mjs).
// scripts/build.mjs inlines both into hook-source.ts, so the copy in the data directory still imports nothing else.
import { named, detachedNotice, quietInstruction, stopReason, nudgeReason, syncBookkeeping, syncCall, checksLine, pollNudge, workspaceText, demotedNotice, needsYouInstruction, actionInstruction, overseerInstruction, waitInstruction, backgroundWorkInstruction } from "../shared/agent-text.mjs";
import { isAskInput, pickNudges, turnEndDecision, dueBlock } from "../shared/turn-checks.mjs";

/** Set by the worker's prelude (shared/legacy.ts withRuntimePrelude); absent when a test imports this file. */
const runtime = globalThis.followUpRuntime ?? {};
/** FOLLOW_UP_<name>, or the 1.x name a session opened before the upgrade still carries. */
const env = name => process.env[`FOLLOW_UP_${name}`] ?? (runtime.legacyEnvPrefix ? process.env[runtime.legacyEnvPrefix + name] : undefined);

const directory = dirname(fileURLToPath(import.meta.url));
/** 1.4.0-beta.2: launched with Follow-up's tools served by Paseo's MCP (follow_<name>), or the follow-up bridge (<name>). Agents opened before the upgrade carry no flag and keep the bridge names. */
let native = env("TOOLS") === "native";
/**
 * Paseo 0.17: the parts of the static session text the worker put in this session's system prompt (appendSystemPrompt,
 * server/session-prompt.ts), by name. The hook leaves exactly those out, so the agent reads each once.
 */
const inPrompt = new Set(String(env("SYSTEM_PROMPT") ?? "").split(",").filter(Boolean));
/** Whether a tool call is Follow-up's own, under either name set (mcp__follow-up__x, follow-up.x, mcp__paseo__follow_x, paseo.follow_x). */
export function isFollowTool(tool) { return [ "follow-up", runtime.legacyMcpServer].some(server => server && new RegExp(`^(?:mcp__)?${server}(?:__|[.:/])[a-z_]+$`).test(tool)) || /^(?:mcp__paseo__|paseo[.:/])follow_[a-z_]+$/.test(tool); }
/** Whether a shell call runs the bridge, however it names it ($FOLLOW_UP_CLI, as the skill says, or the path). */
export function isBridgeCall(args, bridgePath) { return args.includes(bridgePath) || ["FOLLOW_UP_", runtime.legacyEnvPrefix].some(prefix => prefix && new RegExp(`\\$\\{?${prefix}CLI\\b`).test(args)) || /mcp\.mjs["']?\s+call\b/.test(args); }
/**
 * Native tools are attached by one worker; a plugin reload or update drops them from open sessions until each reopens
 * (Paseo 0.15.2 reopens a session before that agent's next prompt). The worker records its instance and the instance
 * that attached each session's tools; a mismatch means this session's follow_ tools are gone. Pure, so it's testable.
 */
export function toolsDetached(isNative, current, mine) { return isNative && !!current?.instance && mine?.instance !== current.instance; }

/**
 * The Overseer's per-turn digest (1.4.0-beta.0). The daemon rewrites overseer-digest.json only when it changes (one line and a hash
 * per workspace); this diffs it against what the Overseer saw last turn. Pure, so size and paging are testable.
 * Kept to about 3k tokens: at most 20 needs lines and 30 changes, then a pointer to the workstreams tool.
 */
export function overseerDigest(file, seen, now = Date.now(), { needsMax = 20, changedMax = 30, restingMax = 40, chars = 12_000 } = {}) {
  const all = Array.isArray(file?.rows) ? file.rows : [];
  const rows = all.filter(r => !r.resting);
  const resting = all.filter(r => r.resting);
  const prior = seen && typeof seen.rows === "object" && seen.rows ? seen.rows : null;
  const age = Math.max(0, Math.round((now - Date.parse(file?.at ?? "")) / 1000));
  const lines = [`Follow-up digest (last change ${Number.isFinite(age) ? `${age}s` : "?"} ago): ${file?.total ?? all.length} workspaces, ${file?.needs ?? 0} need the developer. Paging: workstreams(page, group, query).`];
  const needs = rows.filter(r => r.group === "needs");
  if (needs.length) {
    lines.push(`Needs the developer (${needs.length}):`);
    for (const r of needs.slice(0, needsMax)) lines.push(`- ${r.line}`);
    if (needs.length > needsMax) lines.push(`- …${needs.length - needsMax} more: workstreams(group="needs")`);
  } else lines.push("Nothing needs the developer right now.");
  if (!prior) {
    const active = rows.filter(r => r.group === "running" || r.group === "sending");
    lines.push(`First turn. Running now (${active.length}):`);
    for (const r of active.slice(0, changedMax)) lines.push(`- ${r.line}`);
    if (active.length > changedMax) lines.push(`- …${active.length - changedMax} more: workstreams(group="running")`);
  } else {
    const current = new Set(all.map(r => r.id));
    const changed = rows.filter(r => prior[r.id] !== r.hash && r.group !== "needs");
    const gone = Object.keys(prior).filter(id => !current.has(id));
    lines.push(changed.length || gone.length ? `Changed since your last turn (${changed.length + gone.length}):` : "No other changes since your last turn.");
    for (const r of changed.slice(0, changedMax)) lines.push(`- [${r.group}] ${r.line}`);
    if (changed.length > changedMax) lines.push(`- …${changed.length - changedMax} more changed: workstreams()`);
    if (gone.length) lines.push(`- ${gone.length} workspace${gone.length === 1 ? "" : "s"} archived or removed: ${gone.slice(0, 5).join(", ")}`);
  }
  if (resting.length) lines.push(`Resting (${resting.length}; agents likely unloaded, sending wakes them): ${resting.slice(0, restingMax).map(r => r.line).join("; ")}${resting.length > restingMax ? `; …${resting.length - restingMax} more: workstreams()` : ""}`);
  // Compass (compass-without-the-overseer): what the developer's priority sources said, as notes. compass lists them all
  // with links; compass_note pins, edits, unpins or tells (dry run, then confirm).
  const compass = Array.isArray(file?.compass) ? file.compass.filter(l => typeof l === "string") : [];
  if (compass.length) { lines.push("Compass (the developer's priority sources, as notes: who · until · what · where · note id; run_action compass for all, compass_note to act):"); for (const l of compass) lines.push(`- ${l}`); }
  let text = "";
  for (const l of lines) { if (text.length + l.length + 1 > chars) { text += "- …truncated: use workstreams()\n"; break; } text += l + "\n"; }
  return { text: text.trimEnd(), seen: { at: now, rows: Object.fromEntries(all.map(r => [r.id, r.hash])) } };
}
/**
 * a-derived-view-is-built-when-read: the worker builds overseer-digest.json when the Overseer's turn starts, usually before
 * this hook runs. The file is fresh for this turn when its builtAt is newer than the one the Overseer last saw and
 * within windowMs of now; otherwise poll every stepMs for up to waitMs, then use what is there (the last build, at most
 * the worker's 10-min backstop old). A worker that writes no builtAt is taken as is. Pure apart from read and sleep.
 */
export async function freshDigest(read, seen, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), waitMs = 1500, stepMs = 100, windowMs = 5000 } = {}) {
  const fresh = file => {
    if (!file?.builtAt) return true;
    const built = Date.parse(file.builtAt);
    const last = Date.parse(seen?.builtAt ?? "");
    return (!Number.isFinite(last) || built > last) && now() - built <= windowMs;
  };
  let file = await read();
  const until = now() + waitMs;
  let waited = 0;
  while (!fresh(file) && now() < until) { await sleep(stepMs); waited += stepMs; file = (await read()) ?? file; }
  return { file, fresh: fresh(file), waited };
}
const SHELL_TOOL = /(bash|shell|exec_command|write_stdin|monitor|terminal)/i;
const GH_QUERY = /\bgh\s+(?:pr\s+(?:checks|view|status)\b|run\s+(?:list|view)\b|api\b[^\n;|&]*(?:graphql|\/pulls\b|check-runs|check-suites|\/statuses\b|\/status\b|\/actions\/runs))/;
const GH_WATCH = /\bgh\s+(?:pr\s+checks\b[^\n;|&]*--watch\b|run\s+watch\b)/;
// A for loop over PRs (reading each one once) isn't polling; a wait between reads is.
const LOOP = /(?:^|[\s;&|({])(?:while|until)\b[\s\S]*?\bdo\b|\bsleep\s+\d|\bwatch\s+-n\b|\bsetInterval\b|\btime\.sleep\(/;
/** The text a tool call runs: every string in its input (Bash command, Codex cmd, Monitor's command, a script). */
function commandText(input) {
  const out = [];
  const walk = v => { if (typeof v === "string") out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(input);
  return out.join("\n").slice(0, 20_000);
}
/** Whether a shell tool call polls GitHub for CI: a watch command, or a loop or sleep around a gh status read. */
export function pollsGithub(tool, input) {
  if (!SHELL_TOOL.test(String(tool ?? ""))) return false;
  const text = commandText(input);
  if (GH_WATCH.test(text)) return true;
  return GH_QUERY.test(text) && LOOP.test(text);
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
/** The quiet paragraph's revision: an agent whose turn marker predates it is told it once (PostToolUse). */
const quietRevision = 1;
/** Follow-up's words with this session's tool names. */
const say = text => named(text, native);
/**
 * The tracked workspace's instructions (shared/agent-text.mjs workspaceText), with the bridge in this data directory.
 * The worker builds the same text for a provider without the hook (server/session-prompt.ts).
 */
export function workspaceInstructions({ contributor = false, workflow, native: isNative = native, clientEntry, dir = directory }) {
  return workspaceText({ contributor, workflow, native: isNative, clientEntry, bridge: join(dir, "mcp.mjs") });
}

/** With native tools there's no MCP initialize reply, so the role text it carried comes from the hook instead. */
function nativeExtras(brief) {
  if (!native) return [];
  return [
    brief?.enable_inbox && env("BRIEF") && !inPrompt.has("needsYou") ? needsYouInstruction : null,
    env("ROOT") === "1" && !inPrompt.has("action") ? actionInstruction : null,
    env("OVERSEER") === "1" && !inPrompt.has("overseer") ? overseerInstruction : null,
  ].filter(Boolean).map(say);
}
/**
 * Wait's guidance (server/wait.ts attaches its tools natively, so there is no MCP initialize text to carry it). On
 * Paseo 0.16 Wait attaches no tools and sets FOLLOW_UP_BACKGROUND_WORK instead: background it, end the turn.
 */
function waitExtras() {
  if (env("WAIT") === "1") return inPrompt.has("wait") ? [] : [waitInstruction];
  if (env("BACKGROUND_WORK") === "1") return inPrompt.has("backgroundWork") ? [] : [backgroundWorkInstruction];
  return [];
}
/**
 * The Stop hook's facts for the one turn-end decision (shared/turn-checks.mjs turnEndDecision). The hook asks a tracked
 * agent to sync every turn it didn't (its instructions say "including when no changes are needed"), so a turn counts as
 * changed here. A root agent is one launched with FOLLOW_UP_BRIEF (a tracked main, or a root agent outside any tracked
 * workspace); a turn whose start the hook never saw (no UserPromptSubmit) is not nudged.
 */
export function stopDecision({ workspace, contributor, root, brief, agentId, turn, synced, called, due, receipt, now }) {
  const startedAt = turn?.startedAt ?? 0;
  return turnEndDecision({
    trigger: "hook", role: workspace ? (contributor ? "contributor" : "main") : null, root: root && !!startedAt && !turn?.stopped,
    nudgeOn: brief?.enable_inbox === true && brief?.enable_brief_nudge === true && !(Array.isArray(brief.pending) && brief.pending.includes(agentId)),
    changed: true, synced: !!(turn && workspace && synced?.workspaceId === workspace.id && synced.at >= Math.max(startedAt, turn.dirtyAt ?? 0)),
    needsYouCalled: !!(called && called.at >= startedAt), askedElsewhere: !!(turn?.askedAt && turn.askedAt >= startedAt),
    due, receipt, now,
  });
}
/** R2: whether the Stop hook nudges this root agent to call needs_you; the provider never decides it. Pure, so every skip is testable. */
export function shouldNudge({ brief, agentId, contributor, recovery, subagent, stopHookActive, turn, called }) {
  if (recovery || subagent || stopHookActive) return false;
  return stopDecision({ workspace: contributor ? { id: "w" } : null, contributor, root: true, brief, agentId, turn, synced: null, called, due: [], receipt: {}, now: Date.now() }).nudge;
}
/**
 * Claude Code keeps hook context for the whole session and re-runs SessionStart after compaction, so the same text
 * on every prompt only costs tokens (~1.3k per turn for a tracked main agent): send it once per session and again
 * only when it changes. Other providers keep the per-prompt text.
 */
export function shouldRepeat(provider, turn, hash) { return provider !== "claude" || turn?.contextHash !== hash; }
const digest = text => createHash("sha256").update(text).digest("hex").slice(0, 16);
async function main() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId || !/^[\w-]+$/.test(agentId) || env("RECOVERY") === "1") return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 2_000_000) return; }
  const event = JSON.parse(input);
  if (event.agent_id || event.hook_event_name === "SubagentStop") return;
  const lease = await json(join(directory, "hooks-enabled.json"));
  if (lease.expiresAt < Date.now() || !lease.clientEntry) return;
  // A Paseo 0.16 background agent (another plugin's helper) gets nothing from Follow-up: no context, no Stop-hook
  // nudge. The worker lists them as it learns of them (server/background-agents.ts); Paseo doesn't say so at launch.
  const background = await json(join(directory, "background-agents.json")).catch(() => null);
  if (Array.isArray(background?.agents) && background.agents.includes(agentId)) return;
  const instance = native ? await json(join(directory, "tools-instance.json")).catch(() => null) : null;
  const detached = toolsDetached(native, instance, native ? await json(join(directory, "hook-state", `native-${agentId}.json`)).catch(() => null) : null);
  // Detached: name the bridge's tools everywhere below, and include the bridge paragraph.
  if (detached) native = false;
  // The Overseer: a fresh digest at the start of every turn; no sidebar bookkeeping and no Stop-hook nudge.
  if (env("OVERSEER") === "1") {
    if (event.hook_event_name === "SessionStart") {
      const extras = [...await nativeExtras(await json(join(directory, "brief.json")).catch(() => null)), ...await waitExtras()];
      if (extras.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extras.join("\n\n") } }) + "\n");
      return;
    }
    if (event.hook_event_name !== "UserPromptSubmit") return;
    const seenPath = join(directory, "hook-state", `overseer-seen-${agentId}.json`);
    const seen = await json(seenPath).catch(() => null);
    const { file } = await freshDigest(() => json(join(directory, "overseer-digest.json")).catch(() => null), seen);
    if (!file || file.agentId !== agentId) return;
    const digest = overseerDigest(file, seen);
    await save(seenPath, { ...digest.seen, ...(file.builtAt ? { builtAt: file.builtAt } : {}) });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: digest.text } }) + "\n");
    return;
  }
  // scopes.json is a few KB; this hook runs on every tool call. Older workers don't write it: read state.json.
  const scopes = await json(join(directory, "scopes.json")).catch(() => null);
  let workspace = null; let contributor = false; let workflow; let demoted = null; let due = [];
  if (scopes?.agents) { const entry = scopes.agents[agentId]; if (entry && entry.role !== "recovery") { workspace = { id: entry.workspaceId }; contributor = entry.role === "contributor"; workflow = entry.workflow; demoted = contributor ? demotedNotice(entry.demoted) : null; due = Array.isArray(entry.due) ? entry.due : []; } }
  else {
    const state = await json(join(directory, "state.json")).catch(() => ({ workspaces: [] }));
    workspace = state.workspaces.find(w => (w.mainAgentId === agentId || w.contributorAgentIds?.includes(agentId)) && w.enable_tracking && !w.archived) ?? null;
    contributor = !!workspace && workspace.mainAgentId !== agentId;
  }
  // The brief nudge applies to root agents launched with FOLLOW_UP_BRIEF, tracked or not.
  const provider = env("BRIEF") || null;
  const brief = provider ? await json(join(directory, "brief.json")).catch(() => null) : null;
  if (!workspace && !(brief?.enable_inbox && brief?.enable_brief_nudge) && !(native && env("ROOT") === "1")) {
    // Every other Claude session with Wait (subagents, untracked agents) still gets Wait's guidance, once per session.
    if (event.hook_event_name === "SessionStart") { const extras = await waitExtras(); if (extras.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extras.join("\n\n") } }) + "\n"); }
    return;
  }
  const context = () => workspaceInstructions({ contributor, workflow, clientEntry: lease.clientEntry });
  // Paseo 0.17: the workspace text is in the system prompt (part "workspace"), and hook-state/prompt-<agent>.json records
  // which. Left out while it is still that text; a changed one (a role or workflow change, an enrollment) is said once,
  // here or in the next Follow-up tool result, whichever comes first, and recorded (server/session-prompt.ts).
  const recordPath = join(directory, "hook-state", `prompt-${agentId}.json`);
  const workspacePart = async () => {
    if (!workspace) return null;
    const text = context();
    if (!inPrompt.has("workspace")) return text;
    const record = await json(recordPath).catch(() => null);
    return record?.hash === digest(text) ? null : text;
  };
  const recordSaid = async text => { if (inPrompt.has("workspace") && workspace && text.includes(context())) await save(recordPath, { hash: digest(context()), at: Date.now() }).catch(() => undefined); };
  const sessionText = async () => [await workspacePart(), ...await nativeExtras(brief), ...await waitExtras(), (workspace || env("ROOT") === "1") && !inPrompt.has("checks") ? say(checksLine) : null].filter(Boolean).join("\n\n");
  const name = event.hook_event_name;
  if (!["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].includes(name)) return;
  const session = createHash("sha256").update(String(event.session_id ?? agentId)).digest("hex").slice(0, 24);
  const path = join(directory, "hook-state", `${agentId}-${session}.json`);
  const turn = await json(path).catch(() => null);
  const emit = text => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }) + "\n");
  if (name === "SessionStart") {
    const text = await sessionText();
    if (text) { emit(text); await save(path, { ...turn, contextHash: digest(text) }); await recordSaid(text); }
    return;
  }
  if (name === "UserPromptSubmit") {
    if (turn?.stopped && String(event.prompt ?? "").startsWith(stopReason)) return;
    const text = await sessionText(); const hash = text ? digest(text) : null;
    // Lost the main role (make_main_agent, Make main agent, or a handover): said once, on the next turn.
    const tellDemoted = demoted && turn?.demotedNotice !== demoted.at;
    await save(path, { startedAt: Date.now(), dirtyAt: null, lastToolAt: null, stopped: false, quietRevision, contextHash: hash, ...(turn?.detachedNotice ? { detachedNotice: turn.detachedNotice } : {}), ...(tellDemoted || turn?.demotedNotice ? { demotedNotice: tellDemoted ? demoted.at : turn.demotedNotice } : {}) });
    const out = [text && shouldRepeat(env("PROVIDER"), turn, hash) ? text : null, tellDemoted ? demoted.text : null].filter(Boolean);
    if (out.length) { emit(out.join("\n\n")); await recordSaid(out.join("\n\n")); }
    return;
  }
  if (name === "PostToolUse") {
    // Said once per session per worker: the tools stay detached until the session reopens.
    const notice = detached && turn?.detachedNotice !== instance.instance;
    // Once per turn (the turn's start, or the session's when no prompt was seen), and never a block.
    const turnId = turn?.startedAt || 0;
    const polling = (workspace || env("ROOT") === "1") && turn?.pollNudged !== turnId && pollsGithub(event.tool_name, event.tool_input);
    const tool = String(event.tool_name ?? "");
    const args = JSON.stringify(event.tool_input ?? {});
    const trackedTool = isFollowTool(tool) || isBridgeCall(args, join(directory, "mcp.mjs"));
    // Another tool asked the developer this turn (PostToolUse fires only on success): the Stop nudge stays quiet.
    const asked = !trackedTool && isAskInput(event.tool_input) ? { askedAt: Date.now() } : {};
    if (!workspace) {
      if (notice || polling || asked.askedAt) await save(path, { ...turn, ...asked, ...(notice ? { detachedNotice: instance.instance } : {}), ...(polling ? { pollNudged: turnId } : {}) });
      if (notice || polling) emit([notice ? detachedNotice : null, polling ? say(pollNudge) : null].filter(Boolean).join("\n\n"));
      return;
    }
    const dirty = !trackedTool && /(bash|shell|exec_command|write_stdin|edit|write|apply_patch|notebook)/i.test(tool);
    const upgrade = turn?.quietRevision !== quietRevision;
    // A dirty call is dated from when it could have started (the previous tool's end), not when it ended: a call that
    // itself confirms sync, through any bridge spelling, then still satisfies the Stop check, which reads the
    // sync record the RPC handler wrote rather than tool names.
    const now = Date.now();
    const callStart = turn?.lastToolAt || turn?.startedAt || now;
    await save(path, { ...turn, ...asked, startedAt: turn?.startedAt ?? (dirty ? callStart : 0), stopped: turn?.stopped ?? false, ...(dirty ? { dirtyAt: callStart } : {}), quietRevision, lastToolAt: now, ...(notice ? { detachedNotice: instance.instance } : {}), ...(polling ? { pollNudged: turnId } : {}) });
    const text = [upgrade ? quietInstruction : null, notice ? detachedNotice : null, polling ? say(pollNudge) : null].filter(Boolean).join("\n\n");
    if (text) emit(text);
    return;
  }
  if (event.stop_hook_active || turn?.stopped || event.background_tasks?.length) return;
  const synced = await json(join(directory, "hook-state", `sync-${agentId}.json`)).catch(() => null);
  const called = await json(join(directory, "hook-state", `needs-you-${agentId}.json`)).catch(() => null);
  // due-by-fact: the receipt is the workspace's, so the main agent and the task's worker share the cap.
  const receiptPath = workspace && /^[\w-]+$/.test(workspace.id) ? join(directory, "hook-state", `task-nudges-${workspace.id}.json`) : null;
  const decision = stopDecision({ workspace, contributor, root: !!provider, brief, agentId, turn, synced, called, due: receiptPath ? due : [], receipt: receiptPath && due.length ? await json(receiptPath).catch(() => ({})) : {}, now: Date.now() });
  if (!decision.any) return;
  if (decision.receipt) await save(receiptPath, decision.receipt).catch(() => undefined);
  await save(path, { ...turn, startedAt: turn?.startedAt ?? Date.now(), stopped: true, ...(decision.nudge ? { nudgedAt: Date.now() } : {}) });
  // The reply this Stop interrupts is the agent's real answer; what it says after the bookkeeping continuation answers
  // Follow-up. The inbox reports this one as the Finished reason (server/inbox-classifier.ts finishedReply).
  if (typeof event.last_assistant_message === "string" && event.last_assistant_message.trim()) await save(join(directory, "hook-state", `bookkeeping-${agentId}.json`), { at: Date.now(), reply: event.last_assistant_message.slice(0, 4000) }).catch(() => undefined);
  const reasons = [detached ? detachedNotice : null, decision.due.length ? dueBlock(decision.due, native) : null, decision.sync ? (inPrompt.has("workspace") ? `${stopReason} ${syncBookkeeping} ${say(syncCall)}` : `${stopReason} ${syncBookkeeping}\n\n` + context()) : null, decision.nudge ? say(nudgeReason) : null].filter(Boolean);
  process.stdout.write(JSON.stringify({ decision: "block", reason: reasons.join("\n\n") }) + "\n");
}
// Tests import shouldNudge without running the hook; the worker imports workspaceInstructions the same way.
if (env("HOOK_IMPORT") !== "1" && !globalThis.followUpHookLibrary) main().catch(() => {});
