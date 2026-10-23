#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const directory = dirname(fileURLToPath(import.meta.url));
const quietRevision = 1;
const quietInstruction = "Do routine bookkeeping silently. Do not announce tracker calls, say you updated/synced the sidebar, recap panel state, or add plugin-status commentary/final paragraphs. Put receipts and evidence in the tools. User-facing messages should cover the actual work outcome, or a decision/blocker requiring the developer; answer sidebar status only when explicitly asked. If this continuation is bookkeeping only, use the tools and finish without another recap or repeating your previous answer.";
const stopReason = "Silently complete this workspace's sidebar bookkeeping before finishing.";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
function instructions(lease) {
  return [
    "Maintain this tracked workspace's Follow-through sidebar as part of your normal work; do not wait for a developer reminder.",
    quietInstruction,
    "Read workspace_status now and after compaction. Refine the goal with enroll_workspace when scope changes. Register every PR you produce after submitting it, parents before children, and update stack/parent relationships after restacking. Historical mentions and external dependencies are not owned PRs; preserve exclusions and existing records.",
    "Keep actual follow-through tasks current with update_obligation: production behavior checks, migrations and decisions, with concise titles, PR dependencies and evidence. Do not add merge/approval/deploy checklist tasks. Deployment-dependent work waits for verified serving revisions and existing production permissions.",
    "Stakeholder replies are follow-through too. When asked to update a requester, capture the original Slack threadUrl, recipient and explicit developer authorization in the task's communication field; referenced messages alone do not authorize posting. Use a concise progress task now and, when needed, a verify-and-reply task with purpose=verified after the relevant deployed PRs. Read existing thread replies and refresh evidence before posting; distinguish fixed, deployed and verified. Record the actual sent replyUrl and result before marking done. If posting is unavailable or its outcome is uncertain, keep the task blocked and check the thread before any retry; never claim a draft was sent. Auto authorizes delivery to you, not external messages. Communication-only requests do not authorize repairs, benchmarks, migrations or other production writes.",
    "Tasks are manual unless explicitly scheduled with trigger={event:\"now\"|\"merge\"|\"deploy\",delayDays:0}. Only set a trigger from the developer\u2019s requested timing; never infer timing from a title or enable_follow_up alone. Merge/deploy triggers require owned afterPrs; delayDays=14 waits fourteen days after the last dependency event. Now requires no PR dependencies or delay. Deployment timing starts at the first verified fully serving observation and remains conservative when history is unknown. Preserve existing trigger fields on updates; trigger=null makes a task manual. Auto controls delivery, not timing or production permissions.",
    "Follow-through batches contain a batch ID and task list. Read workspace_status and refresh live conditions before acting; skip resolved tasks. Process dependent PRs bottom to top, one PR fully before the next. Use the repository's /fix-pr workflow, validate feedback, verify changes, submit through Graphite with --publish, and reply/resolve addressed threads. Follow the repository's safe reparent procedure for merged parents and preserve uncommitted work. For post-deploy tasks, verify the currently serving revision contains every dependency and record behavioral results separately. Acknowledge the header's batch ID with acknowledge_batch before finishing: completed with the result, or blocked with the reason. Verify the entire goal and post-merge work before declare_done; acknowledge a completion batch first. Merging and archiving remain the developer's actions.",
    "Before ending this turn, reconcile the sidebar with what you actually did and call sync_workspace with a short summary, including when no changes are needed. Acknowledge any assigned batch. When the entire goal is fulfilled, use declare_done; otherwise preserve remaining work. Do not launch recovery, start queued repairs, merge, toggle merge-when-ready, or archive as part of this bookkeeping. Auto still governs separate follow-up sends. Subagents report to the main agent instead of claiming workspace ownership.",
    `Prefer the native follow-through MCP tools. For a full historical record, use workspace_status with detail=full. CLI compatibility fallback: FOLLOW_THROUGH_CLIENT_ENTRY=${quote(lease.clientEntry)} node ${quote(join(directory, "mcp.mjs"))} call <tool> '<json>' --compact. Omit --compact only when an existing script needs the full response. Never ask the developer to maintain the sidebar or run this bridge.`,
  ].join("\n\n");
}
async function main() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId || !/^[\w-]+$/.test(agentId) || process.env.FOLLOW_THROUGH_RECOVERY === "1") return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 2_000_000) return; }
  const event = JSON.parse(input);
  if (event.agent_id || event.hook_event_name === "SubagentStop") return;
  const lease = await json(join(directory, "hooks-enabled.json"));
  if (lease.expiresAt < Date.now() || !lease.clientEntry) return;
  const state = await json(join(directory, "state.json"));
  const workspace = state.workspaces.find(w => w.mainAgentId === agentId && w.enable_tracking && !w.archived);
  if (!workspace) return;
  const name = event.hook_event_name;
  if (!["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].includes(name)) return;
  const session = createHash("sha256").update(String(event.session_id ?? agentId)).digest("hex").slice(0, 24);
  const path = join(directory, "hook-state", `${agentId}-${session}.json`);
  const turn = await json(path).catch(() => null);
  const emit = text => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }) + "\n");
  if (name === "SessionStart") { emit(instructions(lease)); return; }
  if (name === "UserPromptSubmit") {
    if (turn?.stopped && String(event.prompt ?? "").startsWith(stopReason)) return;
    await save(path, { startedAt: Date.now(), dirtyAt: null, stopped: false, quietRevision });
    emit(instructions(lease)); return;
  }
  if (name === "PostToolUse") {
    const tool = String(event.tool_name ?? "");
    const args = JSON.stringify(event.tool_input ?? {});
    const trackedTool = /follow[\s_-]*through/i.test(tool) || args.includes(join(directory, "mcp.mjs"));
    const dirty = !trackedTool && /(bash|shell|exec_command|write_stdin|edit|write|apply_patch|notebook)/i.test(tool);
    const upgrade = turn?.quietRevision !== quietRevision;
    if (dirty || upgrade) await save(path, { ...turn, startedAt: turn?.startedAt ?? (dirty ? Date.now() : 0), stopped: turn?.stopped ?? false, ...(dirty ? { dirtyAt: Date.now() } : {}), quietRevision });
    if (upgrade) emit(quietInstruction);
    return;
  }
  if (event.stop_hook_active || turn?.stopped || event.background_tasks?.length) return;
  const sync = await json(join(directory, "hook-state", `sync-${agentId}.json`)).catch(() => null);
  if (turn && sync?.workspaceId === workspace.id && sync.at >= Math.max(turn.startedAt, turn.dirtyAt ?? 0)) return;
  await save(path, { ...turn, startedAt: turn?.startedAt ?? Date.now(), stopped: true });
  process.stdout.write(JSON.stringify({ decision: "block", reason: stopReason + " This is metadata bookkeeping only; do not start queued repairs or recovery.\n\n" + instructions(lease) }) + "\n");
}
main().catch(() => {});
