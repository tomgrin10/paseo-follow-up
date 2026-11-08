#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const directory = dirname(fileURLToPath(import.meta.url));
const quietRevision = 1;
const quietInstruction = "Do routine bookkeeping silently. Do not announce tracker calls, say you updated/synced the sidebar, recap panel state, or add plugin-status commentary/final paragraphs. Put receipts and evidence in the tools. User-facing messages should cover the actual work outcome, or a decision/blocker requiring the developer; answer sidebar status only when explicitly asked. If this continuation is bookkeeping only, use the tools and finish without another recap or repeating your previous answer.";
const stopReason = "Silently complete this workspace's sidebar bookkeeping before finishing.";
// Kept identical to NEEDS_YOU_NUDGE in shared/brief.ts (a test checks it).
const nudgeReason = "Before you stop, call needs_you once with what the developer has to do next: a decision with options, an action only they can take, or kind=done (\"Nothing needed\" plus what you finished), which means nothing for the developer and won't flag you. Then stop; don't repeat your reply.";

/**
 * R2: whether to nudge a Claude Code root agent that ended its turn without needs_you. Pure, so every skip is testable.
 * At most once per turn: Claude's stop_hook_active and our own per-turn `stopped` marker both end it.
 */
export function shouldNudge({ provider, brief, agentId, contributor, recovery, subagent, stopHookActive, turn, called }) {
  if (provider !== "claude" || recovery || subagent || contributor || stopHookActive) return false;
  if (!brief || brief.enable_inbox !== true || brief.enable_brief_nudge !== true) return false;
  if (Array.isArray(brief.pending) && brief.pending.includes(agentId)) return false;
  if (!turn || turn.stopped || !turn.startedAt) return false;
  return !(called && called.at >= turn.startedAt);
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
function instructions(lease, contributor = false) {
  if (contributor) return [
    "Maintain PR tracking for this session in its tracked workspace. Read workspace_status now and after compaction. Register every PR you submit, including from secondary git worktrees, with register_pr; register parents before children. References and external dependencies are not owned PRs. Call sync_workspace before finishing. The designated main agent retains goal, task, scope and completion authority.",
    quietInstruction,
    `Prefer native Follow-through tools. CLI fallback: FOLLOW_THROUGH_CLIENT_ENTRY=${quote(lease.clientEntry)} node ${quote(join(directory, "mcp.mjs"))} call <tool> '<json>' --compact. Do not ask the developer to maintain the sidebar.`,
  ].join("\n\n");
  return [
    "Maintain this tracked workspace's Follow-through sidebar as part of your normal work; do not wait for a developer reminder.",
    quietInstruction,
    "Read workspace_status now and after compaction. Refine the goal with enroll_workspace when scope changes. Register every PR you produce after submitting it, parents before children, and update stack/parent relationships after restacking. Historical mentions and external dependencies are not owned PRs; preserve exclusions and existing records.",
    "When a decision needs the developer, call ask_question with a short title, the question, lettered options with what each means, and your recommendation; mark it big only when building ahead would leave this computer, set something others rely on, or most remaining work depends on it. Follow the question mode in its reply. Answers arrive as messages starting \"Follow-up answer Q<n>\" and are already recorded; if the developer answers in chat, call record_answer. Withdraw questions that stop mattering.",
    "If you keep a Claude artifact (or doc) summarizing this workspace's goal, decisions and status, register its link once with set_spec after the first publish. Republish to the same URL; call set_spec again only if the link changes.",
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
  const state = await json(join(directory, "state.json")).catch(() => ({ workspaces: [] }));
  const workspace = state.workspaces.find(w => (w.mainAgentId === agentId || w.contributorAgentIds?.includes(agentId)) && w.enable_tracking && !w.archived);
  const contributor = !!workspace && workspace.mainAgentId !== agentId;
  // The brief nudge applies to root agents launched with FOLLOW_THROUGH_BRIEF, tracked or not.
  const provider = process.env.FOLLOW_THROUGH_BRIEF || null;
  const brief = provider ? await json(join(directory, "brief.json")).catch(() => null) : null;
  if (!workspace && !(brief?.enable_inbox && brief?.enable_brief_nudge)) return;
  const context = () => instructions(lease, contributor);
  const name = event.hook_event_name;
  if (!["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].includes(name)) return;
  const session = createHash("sha256").update(String(event.session_id ?? agentId)).digest("hex").slice(0, 24);
  const path = join(directory, "hook-state", `${agentId}-${session}.json`);
  const turn = await json(path).catch(() => null);
  const emit = text => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }) + "\n");
  if (name === "SessionStart") { if (workspace) emit(context()); return; }
  if (name === "UserPromptSubmit") {
    if (turn?.stopped && String(event.prompt ?? "").startsWith(stopReason)) return;
    await save(path, { startedAt: Date.now(), dirtyAt: null, stopped: false, quietRevision });
    if (workspace) emit(context());
    return;
  }
  if (name === "PostToolUse") {
    if (!workspace) return;
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
  let sync = false;
  if (workspace) {
    const confirmed = await json(join(directory, "hook-state", `sync-${agentId}.json`)).catch(() => null);
    sync = !(turn && confirmed?.workspaceId === workspace.id && confirmed.at >= Math.max(turn.startedAt, turn.dirtyAt ?? 0));
  }
  const called = await json(join(directory, "hook-state", `needs-you-${agentId}.json`)).catch(() => null);
  const nudge = shouldNudge({ provider, brief, agentId, contributor, recovery: false, subagent: false, stopHookActive: !!event.stop_hook_active, turn, called });
  if (!sync && !nudge) return;
  await save(path, { ...turn, startedAt: turn?.startedAt ?? Date.now(), stopped: true, ...(nudge ? { nudgedAt: Date.now() } : {}) });
  const reasons = [sync ? stopReason + " This is metadata bookkeeping only; do not start queued repairs or recovery.\n\n" + context() : null, nudge ? nudgeReason : null].filter(Boolean);
  process.stdout.write(JSON.stringify({ decision: "block", reason: reasons.join("\n\n") }) + "\n");
}
// Tests import shouldNudge without running the hook.
if (process.env.FOLLOW_THROUGH_HOOK_IMPORT !== "1") main().catch(() => {});
