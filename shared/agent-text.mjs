/**
 * Everything Follow-up says to an agent, in one place (one-place-for-agent-text): the workspace instructions, the role
 * texts, Wait's guidance, the turn-end and nudge wording. Plain JS with no imports, so the agent hook and the stdio
 * bridge can carry it: scripts/build.mjs inlines it into server/hook-source.ts and server/mcp-source.ts, which the
 * worker writes to the data directory, and the worker's TypeScript imports it directly (types: agent-text.d.mts).
 * Internal helpers carry an `at` prefix so the inlined copy can't collide with the file it lands in.
 */

// Tool names that read unambiguously in prose: the underscore names a session can list (server/mcp.mjs ROLE_TOOLS and
// the Overseer's; a test checks it). Action names stay bare: they run through run_action, never as follow_<name>.
export const TOOL_NAMES = ["workspace_status", "workspace_now", "sync_workspace", "enroll_workspace", "register_pr", "exclude_stack", "update_obligation", "acknowledge_batch", "ask_question", "record_answer", "withdraw_question", "set_spec", "link_item", "unlink_item", "needs_you", "declare_done", "agent_digest", "route_candidates", "send_to_agent", "start_workspace", "make_main_agent", "context_reply", "wait_for_checks", "find_action", "run_action"];
const atToolPattern = new RegExp(`(?<![\\w])(${TOOL_NAMES.join("|")})(?![\\w])`, "g");
/** Names Follow-up's tools the way the agent has them: follow_<name> for native tools, the bare name on the bridge. */
export function named(text, isNative) { return isNative ? text.replace(atToolPattern, "follow_$1") : text; }

export const detachedNotice = "Follow-up was updated while this session was open, so its follow_* tools are detached and fail with \"Tool not found\" until this session reopens (Paseo reopens it before your next prompt). Until then use the bridge, which runs the same tools with their unprefixed names: node \"$FOLLOW_UP_CLI\" call <tool> '<json>' --compact (for example sync_workspace or needs_you). Do not mention this to the developer.";
export const quietInstruction = "Do routine bookkeeping silently. Do not announce tracker calls, say you updated/synced the sidebar, recap panel state, or add plugin-status commentary/final paragraphs. Put receipts and evidence in the tools. User-facing messages should cover the actual work outcome, or a decision/blocker requiring the developer; answer sidebar status only when explicitly asked. If this continuation is bookkeeping only, use the tools and finish without another recap or repeating your previous answer.";
export const stopReason = "Silently complete this workspace's sidebar bookkeeping before finishing.";
// What the Stop hook and the turn-end message say to a root agent that ended its turn without needs_you.
export const nudgeReason = "Before you stop, call needs_you once with what the developer has to do next: a decision with options (or questions=[\"Q18\"] for one that is already an open question), an action only they can take, or kind=done (\"Nothing needed\" plus what you finished), which means nothing for the developer and won't flag you. Then stop; don't repeat your reply.";
/** The first line of the turn-end message a provider without the hook gets instead (server/turn-end.ts). */
export const turnEndPrefix = "Follow-up turn-end check:";
export const dueHeader = "Follow-up: these tasks are due. For each, do it and close it with update_obligation (status=done with evidence), or keep it with recheck=\"YYYY-MM-DD\" and why in evidence.";
/** The rest of the turn-end message's sync line, after stopReason. */
export const syncBookkeeping = "This is metadata bookkeeping only; do not start queued repairs or recovery.";
/**
 * One Follow-up message can carry several parts (shared/queue.ts ENVELOPE_SEPARATOR, PART_HEADERS): an answer and the
 * batch that rode along with it. tests/message-envelope.test.ts holds this text to the envelope format.
 */
export const ENVELOPE_GUIDANCE = "One Follow-up message can carry several parts, separated by a line holding only ---; each part starts with its own header (\"Follow-up answer …\" or \"Follow-up batch …\") and follows its own rules: an answer is already recorded, a batch is acknowledged with acknowledge_batch by its batch ID.";
export function batchParagraph(workflow) {
  const mode = workflow?.mode ?? "graphite";
  const fix = workflow === undefined || workflow === null ? "/fix-pr" : workflow.reviewFix ?? null;
  const steps = "Follow-up batches contain a batch ID and task list. Read workspace_status and refresh live conditions before acting; skip resolved tasks. Process dependent PRs bottom to top, one PR fully before the next.";
  const review = fix ? `Use the repository's ${fix} workflow, validate feedback, verify changes,` : "For review comments, read the PR's unresolved threads with gh, validate the feedback, fix it and verify the change,";
  const submit = mode === "graphite" ? "submit through Graphite with --publish" : "push the branch (gh pr create for a new PR, gh pr ready when it leaves draft)";
  const reply = fix ? "reply/resolve addressed threads" : "reply to each addressed thread and resolve it";
  const restack = mode === "graphite" ? "Follow the repository's safe reparent procedure for merged parents" : "Keep stacked PRs as a chain of base branches: restack with git rebase --update-refs and push with --force-with-lease, and when a parent merges retarget its child with gh pr edit --base if GitHub didn't already";
  return `${steps} ${review} ${submit}, and ${reply}. ${restack} and preserve uncommitted work.`;
}
/** A No review repository (pr-workflow.json review: "none", in scopes.json as workflow.noReview): the agent merges its own PRs. */
export const NO_REVIEW_MERGE = "This repository has no review: merge your own PR once CI is green, without asking the developer. Archiving remains the developer's action.";
/** Who merges, closing the batch paragraph: the developer (team review, unchanged text), or the agent in a No review repository. */
export const mergeLine = workflow => workflow?.noReview ? NO_REVIEW_MERGE : "Merging and archiving remain the developer's actions.";
/**
 * Wait for checks (docs/wait-for-checks.md). One SessionStart line for root agents, and a PostToolUse nudge when a
 * shell command polls GitHub for CI: said at most once per turn, never blocking (the-polling-nudge-never-blocks).
 * The hook already runs on every PostToolUse (no matcher), so this costs no new process.
 */
export const checksLine = "To wait for CI, don't poll GitHub (gh pr checks --watch, gh run watch, sleep loops over gh): call wait_for_checks with the PR after pushing and end your turn; Follow-up messages you when the checks finish.";
export const pollNudge = "That command polls GitHub for CI, which spends the developer's shared GitHub budget. Stop it, call wait_for_checks with the PR (no prs = every open PR of this workspace) and end your turn: Follow-up messages you once when the checks finish, from reads it already makes. A single gh pr checks to look once is fine.";
export const linkInstruction = "When you start from a Linear issue, Slack thread or doc, or open a new one for this work, call link_item with its URL. Don't link things you only mention. A PR isn't a link: register it.";
const atQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
/**
 * The tracked workspace's instructions, for the agent's role (main or contributor), its PR workflow and its tool names.
 * `bridge` is the stdio bridge's path (the data directory's mcp.mjs), named in the CLI fallback line.
 */
export function workspaceText({ contributor = false, workflow, native = false, clientEntry, bridge }) {
  return named(workspaceParagraphs({ contributor, workflow, clientEntry, bridge }).filter(p => !(native && /^Prefer (?:the )?native/i.test(p))).join("\n\n"), native);
}
function workspaceParagraphs({ contributor, workflow, clientEntry, bridge }) {
  if (contributor) return [
    "Maintain PR tracking for this session in its tracked workspace. Read workspace_status now and after compaction. Register every PR you submit, including from secondary git worktrees, with register_pr; register parents before children. References and external dependencies are not owned PRs. Call sync_workspace before finishing. The designated main agent retains goal, task, scope and completion authority.",
    linkInstruction,
    quietInstruction,
    `Prefer native Follow-up tools. CLI fallback: FOLLOW_UP_CLIENT_ENTRY=${atQuote(clientEntry)} node ${atQuote(bridge)} call <tool> '<json>' --compact. Do not ask the developer to maintain the sidebar.`,
  ];
  return [
    "Maintain this tracked workspace's Follow-up sidebar as part of your normal work; do not wait for a developer reminder.",
    quietInstruction,
    "Read workspace_status now and after compaction. Refine the goal with enroll_workspace when scope changes. Register every PR you produce after submitting it, parents before children, and update stack/parent relationships after restacking. Historical mentions and external dependencies are not owned PRs; preserve exclusions and existing records.",
    "When a decision needs the developer, call ask_question with a short title, the question, lettered options with what each means, and your recommendation; mark it big only when building ahead would leave this computer, set something others rely on, or most remaining work depends on it. Follow the question mode in its reply. Ask each decision once: asking it again returns the open question, and at a turn's end you point at it (needs_you questions=[\"Q<n>\"]) instead of restating it. Answers arrive as messages starting \"Follow-up answer Q<n>\" and are already recorded; several decisions from one card arrive together in one message, one line per decision, with skipped ones marked \"skipped\" and still open. An answer of Something else — \"…\" means none of your options: the quoted words are the developer's answer. Every card already offers Something else, so don't add an Other option. If the developer answers in chat, call record_answer (choice \"other\" with words when it matches none of your options). Withdraw questions that stop mattering. " + ENVELOPE_GUIDANCE,
    linkInstruction,
    "If you keep a Claude artifact (or doc) summarizing this workspace's goal, decisions and status, register its link once with set_spec after the first publish. Republish to the same URL; call set_spec again only if the link changes.",
    "Keep actual follow-up tasks current with update_obligation: production behavior checks, migrations and decisions, with concise titles, PR dependencies and evidence. Do not add merge/approval/deploy checklist tasks. Deployment-dependent work waits for verified serving revisions and existing production permissions. A task waiting on a PR or another agent is status=waiting; blocked is only for the developer. One decision, one card: ask it once with ask_question (task set to the task), then mark the task blocked with question=\"Q<n>\"; ask= is only for a decision you haven't asked, and need=action when the developer must do something and tell you (the card gets Done). Follow-up shows a blocked task and your turn-end needs_you about it as one item. Once it is answered, act on the answer and move the task.",
    "Stakeholder replies are follow-up too. When asked to update a requester, capture the original Slack threadUrl, recipient and explicit developer authorization in the task's communication field; referenced messages alone do not authorize posting. Use a concise progress task now and, when needed, a verify-and-reply task with purpose=verified after the relevant deployed PRs. Read existing thread replies and refresh evidence before posting; distinguish fixed, deployed and verified. Record the actual sent replyUrl and result before marking done. If posting is unavailable or its outcome is uncertain, keep the task blocked and check the thread before any retry; never claim a draft was sent. Auto authorizes delivery to you, not external messages. Communication-only requests do not authorize repairs, benchmarks, migrations or other production writes.",
    "A task comes due by itself when its afterPrs reach dependencyStage, or on its recheck date (update_obligation recheck=\"YYYY-MM-DD\"; a task with no PRs defaults to 3 days after your last update). At your turn\u2019s end Follow-up names due tasks: do each and close it with evidence, or keep it with a new recheck and why. A trigger={event:\"now\"|\"merge\"|\"deploy\",delayDays:0} also sends a task to you as a message; set one only from the developer\u2019s requested timing; never infer timing from a title or enable_follow_up alone. trigger={event:\"at\",at:\"<ISO time with offset>\"} or {event:\"at\",inMinutes:30} sends it to you once at that time, Auto-send on or off: set it from a time the developer named, or yourself on a waiting task to check back on something Follow-up can\u2019t see (a registry, a release window, a reply); never a sleep loop or a timer of your own (CI: wait_for_checks). Merge/deploy triggers require owned afterPrs; delayDays=14 waits fourteen days after the last dependency event. Now requires no PR dependencies or delay. Deployment timing starts at the first verified fully serving observation and remains conservative when history is unknown. Preserve existing trigger fields on updates; trigger=null removes it. Auto controls delivery, not timing or production permissions.",
    batchParagraph(workflow) + " For post-deploy tasks, verify the currently serving revision contains every dependency and record behavioral results separately. Acknowledge the header's batch ID with acknowledge_batch before finishing: completed with the result, or blocked with the reason (humanOnly=true when only a person can move it, such as a stale review the reviewer must re-review or dismiss). Verify the entire goal and post-merge work before declare_done; acknowledge a completion batch first. " + mergeLine(workflow),
    "Before ending this turn, reconcile the sidebar with what you actually did and call sync_workspace with a short summary, including when no changes are needed. Pass milestone when the milestone you're on changed. Acknowledge any assigned batch. When the entire goal is fulfilled, use declare_done; otherwise preserve remaining work. Do not launch recovery, start queued repairs, merge, toggle merge-when-ready, or archive as part of this bookkeeping. Auto still governs separate follow-up sends. Subagents report to the main agent instead of claiming workspace ownership.",
    `Prefer the native follow-up MCP tools. For a full historical record, use workspace_status with detail=full. CLI compatibility fallback: FOLLOW_UP_CLIENT_ENTRY=${atQuote(clientEntry)} node ${atQuote(bridge)} call <tool> '<json>' --compact. Omit --compact only when an existing script needs the full response. Never ask the developer to maintain the sidebar or run this bridge.`,
  ];
}
/** The old main's notice, within a day of losing the role: who took over, why, and what to do. Null otherwise. */
export function demotedNotice(demoted, now = Date.now()) {
  if (!demoted?.at || now - Date.parse(demoted.at) > 24 * 60 * 60_000) return null;
  const time = new Date(demoted.at).toISOString().slice(11, 16);
  const who = demoted.by === "developer" ? "the developer moved it" : demoted.by === "auto" ? "Follow-up moved it" : "it was claimed";
  return { at: demoted.at, text: `You're no longer this workspace's main agent: ${demoted.to} took over at ${time} UTC (${who}${demoted.reason ? `: ${demoted.reason}` : ""}). Report to it instead of asking the developer or calling Done. If that's wrong, ask the developer to make you main again; you can't take it back on your own for 2 hours.` };
}

// Wait (folded in from paseo-wait): its three tools are served natively (server/wait.ts), never by the bridge, and
// native tools carry no MCP instructions, so this goes in the session's text when FOLLOW_UP_WAIT=1. Paseo 0.16+
// (features.agentBackgroundWork) tracks background shell jobs and wakes the agent when one finishes, so Wait's tools
// aren't attached there; backgroundWorkInstruction goes instead when FOLLOW_UP_BACKGROUND_WORK=1.
export const backgroundWorkInstruction = "When a finite shell command may take a while (tests, builds, installs, deploy checks), run it with native Bash run_in_background=true. Continue useful independent work first if available. When only waiting remains, end your turn and say what you're waiting for: Paseo keeps the job running, shows it with Stop, and wakes you when it finishes. Don't sleep or poll in a loop to keep the turn open. When you're woken, confirm the actual exit code before reporting completion.";
export const waitInstruction = "When a finite shell command may take a while and you need its result to finish the user's task, use Wait: wait_prepare_job({description, command}), run the returned exact bashCommand the way the reply's instruction says (on Claude Code through native Bash with run_in_background=true; elsewhere it starts itself in the background), then call wait_for_job({jobId}). Continue useful independent work first if available. When only waiting remains, keep waiting through wait_for_job instead of ending your turn with \"waiting for a notification\". Each call wakes you after at most 60 seconds (default 30): on still_pending, inspect wait_get_job and the job's output (the native Bash output, or outputPath), then wait again if appropriate. Confirm the actual exit code before reporting completion. New messages and Stop release observation without killing the job. Already-started ordinary background tasks cannot be adopted: do not rerun a command just to wrap it.";
// The brief's tool: every root agent while the Needs-you inbox is on; never contributors, recovery or subagents.
export const needsYouInstruction = "When you end a turn, call `needs_you` once, just before your final reply, with what the developer has to do next: a decision (give 2–3 options, what each means for them, and the one you recommend), an action only they can take (merge, approve, log in, run or send something), or kind=done (\"Nothing needed\" plus what you finished, in one line), which means there is nothing for the developer and won't flag you in their inbox. A decision or action that is already an open question (you asked it with ask_question, it is a blocked task's card, or it is still open from an earlier turn) is never restated: point at it with questions=[\"Q18\"], or say \"Still open: Q18 …\" in ask. Keep `ask` to one line and `context` to what they need to decide. Don't repeat your report there; still write your normal reply. Don't call it while a permission prompt is waiting or while you're still working.";
/** The Overseer's role text. */
export const overseerInstruction = "You are Follow-up's Overseer. Route the developer's asks with route_candidates and send_to_agent; ask with needs_you kind=decision when unsure; start_workspace only when the developer asked or approved, passing the keys, never your summary of an issue (the new agent reads it itself). Never merge, post to people or archive.";
/** The action tools' role text (agent parity): every root agent. */
export const actionInstruction = "Follow-up's actions let you do anything the developer can click, across every tracked workspace and every Settings tab: PRs, reviewers and merging, sending and holds, Needs you, Dispatch, Compass and the morning brief, PR statistics, updates and every setting. They aren't listed as tools: find one with find_action (query: a few words; names: exact names for their input schemas; no arguments lists them all), then run it with run_action {action, args}. Read freely (list_prs, inbox_list, workspace_about, the *_settings and *_status reads). Hand the main role on, or claim it, with make_main_agent. Act only when the developer asks (\"the PRs look good, assign reviewers on all\": run_action list_prs {needs_reviewers: true}, then add_reviewers with those keys, then confirm the plan); that includes sign_off, snooze, inbox_act, brief_action and answer_question for other agents. Planned actions return a dry run showing what changes; run it again with confirm=true and its planId. Never sign yourself off or answer your own brief.";

// The stdio bridge's batch rules (its MCP initialize reply).
const atBatchMain = "Follow-up batches contain a header with the batchId and ordered tasks. A batch can arrive as one part of a message, after an answer, separated by a line holding only ---; the part starts with its own header. Read workspace_status and refresh live conditions; skip resolved tasks. Process PRs bottom to top, one fully before the next, using the repository's /fix-pr and safe reparent workflow. Validate feedback, verify changes, submit with Graphite --publish, reply/resolve addressed threads and preserve uncommitted work. Post-deploy tasks require verified serving revisions and existing production permissions. Stakeholder update requests are follow-up tasks: retain the original thread, recipient and developer authorization in communication. Use current evidence, distinguish fixed/deployed/verified, and read existing replies before posting. Record the sent replyUrl; a draft or uncertain send stays blocked and must be checked before retrying. Auto authorizes agent delivery only. Acknowledge the header's batchId with acknowledge_batch before finishing (completed with the result, in_progress when you or your subagent are already on it, or blocked with the reason; add humanOnly=true when only a person can move it, such as a stale review the reviewer must re-review or dismiss), before declare_done for completion batches. Declare Done only after the whole goal and post-merge work are verified. Leave merging and archiving to the developer.";
/** A No review repository (Settings → PR workflow → Review): nobody else reviews, so the agent merges its own PRs. */
const atNoReviewMerge = "This repository has no review: merge your own PR once CI is green, without asking the developer. Leave archiving to the developer.";
/**
 * The batch rules for this workspace's PR workflow. Graphite with /fix-pr (and any agent from before workflows
 * existed) gets the original text unchanged; plain GitHub never mentions Graphite, gt or a review command it doesn't have.
 */
export function batchInstructions(workflow) {
  const mode = workflow?.mode ?? "graphite";
  const fix = workflow === undefined || workflow === null ? "/fix-pr" : workflow.reviewFix ?? null;
  const merging = workflow?.noReview ? atNoReviewMerge : null;
  if (mode === "graphite" && fix === "/fix-pr") return merging ? atBatchMain.replace("Leave merging and archiving to the developer.", merging) : atBatchMain;
  const fixing = fix ? `using the repository's ${fix} workflow for review comments` : "reading each PR's unresolved review threads with gh";
  const restack = mode === "graphite" ? "the repository's safe reparent workflow" : "base branches kept in a chain (restack with git rebase --update-refs, push with --force-with-lease, and after a parent merges retarget its child with gh pr edit --base if GitHub didn't)";
  const submit = mode === "graphite" ? "submit with Graphite --publish" : "push the branch (gh pr create for a new PR, gh pr ready when it leaves draft)";
  const reply = fix ? "reply/resolve addressed threads" : "reply to each addressed thread and resolve it";
  return atBatchMain
    .replace("using the repository's /fix-pr and safe reparent workflow.", `${fixing}, with ${restack}.`)
    .replace("submit with Graphite --publish, reply/resolve addressed threads", `${submit}, ${reply}`)
    .replace("Leave merging and archiving to the developer.", merging ?? "Leave merging and archiving to the developer.");
}

/** The stdio bridge's MCP instructions (its initialize reply), for the session's role, the inbox, actions and the Overseer. */
export function bridgeInstructions({ role, brief, acting, overseeing, workflow }) {
  return (role ? (role === "contributor" ? "Register PRs this session submits, including from secondary git worktrees. Read workspace_status and call sync_workspace before finishing. Goal, task, scope and completion changes remain with the designated main agent." : role === "recovery" ? "Recover tracking metadata from evidence, acknowledge your assigned batch, and leave completion to the main agent." : "Keep workspace follow-up updated after PR submission and scope changes. Read workspace_status after compaction. Track all post-merge work. When a decision needs the developer, ask it with ask_question (lettered options and a recommendation) and follow the question mode in its reply. If you keep a spec artifact for this workspace, register its link once with set_spec. " + batchInstructions(workflow)) + " Perform bookkeeping silently: no sidebar-update announcements, plugin-status commentary or final sidebar recap. Put receipts and summaries in tools. Report actual work outcomes or decisions/blockers; discuss sidebar status only when explicitly asked." : brief ? "" : "Follow-up tools are available to tracked workspace root agents and active recovery agents; contributor sessions receive PR registration and status tools.") + (brief && role !== "contributor" && role !== "recovery" ? (role ? " " : "") + needsYouInstruction : "") + (acting && role !== "contributor" && role !== "recovery" ? " " + actionInstruction : "") + (overseeing ? " " + overseerInstruction : "");
}
