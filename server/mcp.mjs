#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

/** Set by the worker's prelude (shared/legacy.ts withRuntimePrelude); absent when a test imports this file. */
const runtime = globalThis.followUpRuntime ?? {};
/** FOLLOW_UP_<name>, or the 1.x name a session opened before the upgrade still carries. */
const env = name => process.env[`FOLLOW_UP_${name}`] ?? (runtime.legacyEnvPrefix ? process.env[runtime.legacyEnvPrefix + name] : undefined);

const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer", minimum: 1 };
const array = { type: "array", items: string };
const communication = { type: "object", properties: { threadUrl: string, recipient: string, purpose: { type: "string", enum: ["progress", "verified"] }, authorization: string, replyUrl: { type: ["string", "null"] } }, required: ["threadUrl", "recipient"], additionalProperties: false };
const trigger = { type: ["object", "null"], properties: { event: { type: "string", enum: ["now", "merge", "deploy"] }, delayDays: { type: "integer", minimum: 0, maximum: 3650 } }, required: ["event"], additionalProperties: false };
const tools = [
  ["workspace_status", "Read the tracked workspace's durable goal, PRs, tasks, work queue and optional recovery history. Read after compaction. Returns current work by default; detail=full includes complete evidence/history. Normal follow-through does not require recovery.", "follow.agent-status", { detail: { type: "string", enum: ["summary", "full"] } }, []],
  ["sync_workspace", "Silently confirm the sidebar matches your work before finishing, after registering owned PRs and substantive tasks. Call even when no changes are needed. Keep the summary in this tool; never announce sync or recap sidebar/plugin status to the developer. Does not declare Done, run recovery, or start repairs. Tracked root agents only.", "follow.sync", { summary: { ...string, minLength: 1, maxLength: 1000 } }, ["summary"]],
  ["enroll_workspace", "Refine this developer-activated workspace's goal. Ownership is initialized by Track this workspace or the project’s default-tracking setting. This tool cannot activate another workspace. Never ask the developer to enter this. Keep the goal concise; new scope reopens completion.", "follow.enroll", { goal: string }, ["goal"]],
  ["register_pr", "Register a PR produced by this workspace. Call after every submission. Register parents first; repeat to update its stack or parent after restacking. Supply a disposition for a deliberately closed PR.", "follow.register-pr", { repo: string, number: integer, stack: string, parentNumber: { type: ["integer", "null"], minimum: 1 }, disposition: string }, ["repo", "number", "stack"]],
  ["exclude_stack", "Correct an unrelated stack registration. Preserve its PRs and requirements in an exclusion audit; future registration is blocked. reason must cite the scope/ownership evidence. obligationIds may include related tasks without PR dependencies. Keep external dependencies separate from owned work.", "follow.exclude-stack", { stack: string, reason: string, obligationIds: array }, ["stack", "reason"]],
  ["update_obligation", "Record concrete follow-through: verification, migrations, decisions or stakeholder replies. Never add approve/merge/deploy checklist tasks. afterPrs uses owner/repo#number keys. Tasks are manual unless explicitly scheduled with trigger={event:\"now\"|\"merge\"|\"deploy\",delayDays:0}. Only set a trigger from the developer’s requested timing; never infer timing from a title or enable_follow_up alone. Merge/deploy triggers require owned afterPrs; delayDays=14 waits fourteen days after the last dependency event. Now requires no PR dependencies or delay. Deployment timing starts at the first verified fully serving observation and remains conservative when history is unknown. Preserve existing trigger fields on updates; trigger=null makes a task manual. Auto controls delivery, not timing or production permissions. For Slack replies, communication records the original threadUrl, recipient, purpose (progress or verified), explicit developer authorization and sent replyUrl. Empty authorization never queues a reply; Auto does not authorize external posts. Use a verify-and-reply task after deployment for the final update. Read the thread first; mark blocked when posting is unavailable or uncertain, never treat a draft as sent. Done requires replyUrl and evidence; preserve fields when updating.", "follow.obligation", { id: string, title: string, status: { type: "string", enum: ["pending", "waiting", "working", "blocked", "done", "waived"] }, afterPrs: array, dependencyStage: { type: "string", enum: ["merged", "deployed"] }, evidence: string, enable_follow_up: boolean, communication, trigger }, ["title", "status"]],
  ["acknowledge_batch", "Record a follow-up result. Complete only after verifying all tasks; blocked surfaces the reason to the developer. Always acknowledge before ending a repair turn. Keep the result within 2000 characters.", "follow.acknowledge", { batchId: string, outcome: { type: "string", enum: ["completed", "blocked"] }, result: { ...string, maxLength: 2000 } }, ["batchId", "outcome", "result"]],
  ["ask_question", "Ask the developer a decision you can't make yourself. Give a short title, the question, lettered options A, B, C… with what each means for them, and recommend the option you'd pick. Set big only when building ahead would send something off this computer, set something people or programs outside the repo rely on, or most remaining work would build on it. Link a PR (owner/repo#number) or task id when it is about one. The reply says the question mode and exactly what to do until the answer arrives. Asking something already open returns the open question (\"Already open as Q18\") instead of a second one; to change an open question's options, ask again with supersedes=\"Q18\". At the end of the turn point at it with needs_you questions=[\"Q18\"], don't restate it. URLs and owner/repo#123 in the question, background and options are clickable for the developer. Every card already ends with a built-in \"Something else\" choice where the developer writes their own answer; don't add an \"Other\" option yourself.", "follow.ask-question", { title: { ...string, maxLength: 120 }, question: { ...string, maxLength: 2000 }, options: { type: "array", maxItems: 26, items: { type: "object", properties: { letter: { type: "string", pattern: "^[A-Z]$" }, label: { ...string, maxLength: 200 }, consequence: { ...string, maxLength: 600 } }, required: ["letter", "label"], additionalProperties: false } }, recommend: string, big: string, background: string, links: { type: "array", maxItems: 10, items: { type: "object", properties: { url: string, path: string, label: string }, additionalProperties: false } }, pr: string, task: string, supersedes: { type: "string", pattern: "^Q\\d+$" } }, ["title", "question"]],
  ["record_answer", "Record the developer's answer when they answered a question in chat instead of in Follow-up. choice is an option letter, \"other\" when they chose none of your options (words is then required: their answer), or their short answer when there were no options; words is what they said.", "follow.record-answer", { id: string, choice: string, words: string }, ["id", "choice"]],
  ["withdraw_question", "Withdraw a question that no longer matters, with a short reason.", "follow.withdraw-question", { id: string, reason: string }, ["id", "reason"]],
  ["set_spec", "Register the link to this workspace's spec: the Claude artifact (or doc) you keep summarizing the goal, decisions and status. Call it once after the first publish, with the URL from the publish result, and again only if the link changes. Follow-up shows it in the workspace header.", "follow.set-spec", { url: { ...string, maxLength: 2000 }, title: { ...string, maxLength: 120 } }, ["url"]],
  ["link_item", "Link what this workspace's work is about: the Linear issue, Slack thread, doc or artifact you started from or opened for it. ref is its URL or Linear key; why is one short line. Don't link things you only mention. A PR isn't a linked item: register it with register_pr. An unknown Linear key is refused.", "follow.link-item", { ref: { ...string, maxLength: 2000 }, why: { ...string, maxLength: 140 }, title: { ...string, maxLength: 200 } }, ["ref"]],
  ["unlink_item", "Remove a linked item that isn't this workspace's (ref: its URL or key; reason: why). It stays out: nothing adds it back unless the developer does.", "follow.unlink-item", { ref: { ...string, maxLength: 2000 }, reason: { ...string, maxLength: 200 } }, ["ref", "reason"]],
  ["needs_you", "Call once at the end of a turn, just before your final reply: what the developer has to do next. ask is one line (≤120). kind: decision (give decisions with 2–5 options, a consequence each and recommend=<option index>; with several decisions the developer answers them together and you get one message with a line per decision, skipped ones marked as skipped; a decision that is already an open question goes in questions=[\"Q18\"] instead, never restated), action (something only they can do: merge, approve, log in, run or send), review (a PR to review and merge; link it with pr), or done (\"Nothing needed. <what you finished>.\": nothing for the developer, won't flag you). context ≤400 chars: only what they need to decide. Never blocks and never changes what you should do next.", "follow.needs-you", { ask: { ...string, minLength: 1, maxLength: 120 }, kind: { type: "string", enum: ["decision", "action", "review", "done"] }, decisions: { type: "array", maxItems: 3, items: { type: "object", properties: { question: { ...string, minLength: 1, maxLength: 200 }, options: { type: "array", minItems: 2, maxItems: 5, items: { type: "object", properties: { label: { ...string, minLength: 1, maxLength: 60 }, consequence: { ...string, maxLength: 160 } }, required: ["label"], additionalProperties: false } }, recommend: { type: "integer", minimum: 0, maximum: 4 } }, required: ["question"], additionalProperties: false } }, questions: { type: "array", maxItems: 3, items: { type: "string", pattern: "^Q\\d+$" } }, context: { ...string, maxLength: 400 }, links: { type: "array", maxItems: 4, items: { type: "object", properties: { label: string, url: string, path: string, pr: string }, required: ["label"], additionalProperties: false } } }, ["ask", "kind"]],
  ["declare_done", "Declare that the workspace goal is fulfilled. Live PR status and remaining obligations are checked. The reply's `next` says what is missing and whether it is yours to fix; follow it and do not repeat the call when nothing is yours to fix. A deploy Follow-up cannot confirm does not block Done; it is noted. Calling again after Done changes nothing. Done labels the workspace but never archives it.", "follow.done", { summary: string }, ["summary"]],
];

// Agent parity: every action the developer can click in Follow-up, through the same server path (follow.agent-act).
// Planned tools return a dry run; confirm=true with its planId runs it. Use them only when the developer asked.
const planned = { planId: string, confirm: boolean };
const prKey = { ...string, description: "owner/repo#number, from list_prs" };
const ask = " Only when the developer asked for it. Returns a dry-run plan first; run it with confirm=true and the planId.";
const read = " Read-only.";
const actionTools = [
  ["list_prs", "List tracked PRs across all workspaces with state, draft, checks, open threads, requested reviewers and merge blockers. Filters: needs_reviewers, ready_to_merge, workspace (id or title). This is how you act \"on all\".", "follow.agent-act", { workspace: string, needs_reviewers: boolean, ready_to_merge: boolean, include_closed: boolean }, []],
  ["add_reviewers", "Request reviewers on one or many PRs, the same as the Add reviewers button. Without reviewers, asks the developer's saved reviewers for that repository (each PR row in list_prs shows them as configuredReviewers, with source repo, default or none); otherwise the GitHub logins or org/team slugs you give." + ask, "follow.agent-act", { prs: { type: "array", items: prKey }, reviewers: array, ...planned }, []],
  ["merge", "Merge a PR (and its downstack with scope=downstack) through Graphite, using Follow-up's merge plan and blockers. Can't be undone." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["enable_merge_when_ready", "Turn on Graphite merge-when-ready for a PR, as the PR sheet does." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["disable_merge_when_ready", "Turn off Graphite merge-when-ready for a PR." + ask, "follow.agent-act", { pr: prKey, scope: { type: "string", enum: ["target", "downstack"] }, ...planned }, []],
  ["send_repairs", "Send a workspace's waiting repairs (review threads, failed checks) to its main agent, like the Send button. Only when the developer asked. batchId defaults to the waiting batch.", "follow.agent-act", { workspace: string, batchId: string }, ["workspace"]],
  ["set_auto_send", "Turn Auto-send on or off for a workspace, like its switch. Only when the developer asked.", "follow.agent-act", { workspace: string, value: boolean }, ["workspace", "value"]],
  ["clear_hold", "Resume Follow-up on a held workspace, like the Resume button. Only when the developer asked.", "follow.agent-act", { workspace: string }, ["workspace"]],
  ["retry_batch", "Queue a blocked or uncertain repair batch again, like the Retry button. Only when the developer asked.", "follow.agent-act", { workspace: string, batchId: string }, ["workspace", "batchId"]],
  ["track", "Follow a workspace again after the developer opted it out in Settings. Follow-up follows every workspace by default. Only when the developer asked.", "follow.agent-act", { workspace: string }, ["workspace"]],
  ["workspace_about", "Read a workspace's Summary: one sentence on what the workspace is for (a reminder, not a status), plus the Linear issues, PRs, Slack threads and docs found in its own text. Read-only unless refresh=true, which writes a new sentence like the panel's Rewrite; otherwise it writes one only when none is cached (up to ~90 s). workspaceId is a workspace id or exact title from list_prs.", "follow.agent-act", { workspaceId: string, refresh: boolean }, ["workspaceId"]],
  ["link_items", "Read any workspace's linked items: Linear issues, Slack threads, docs, artifacts (the spec among them) and GitHub issues, each with its origin (registered, manual, spec, published, extracted), plus what was removed. workspaceId is a workspace id from list_prs." + read, "follow.agent-act", { workspaceId: string }, ["workspaceId"]],
  ["set_linked_items", "Change a workspace's linked items for the developer, like the Linked items list: action add (ref: URL or Linear key), remove (ref) or undo (ref, a removal)." + ask, "follow.agent-act", { workspaceId: string, action: { type: "string", enum: ["add", "remove", "undo"] }, ref: string, title: string, ...planned }, []],
  ["agent_settings", "Read which agent each of Follow-up's special roles uses (Summaries, Overseer, Recovery, AI priority): provider, model, effort, mode and limits, and whether Wait for background jobs is on. Read-only; the developer changes them in Follow-up settings → Agents.", "follow.agent-act", {}, []],
  ["inbox_list", "Read the developer's Needs-you inbox: each root agent, whether it is flagged and why, snoozes and finish flags. Your own row has self=true.", "follow.agent-act", { flagged_only: boolean }, []],
  ["sign_off", "Sign off other agents' Needs-you flags on the developer's behalf, like Sign off. Never your own." + ask, "follow.agent-act", { agentIds: array, ...planned }, []],
  ["snooze", "Snooze other agents' flags (until: next-event, 1h, tomorrow or an ISO time), like Later." + ask, "follow.agent-act", { agentIds: array, until: string, ...planned }, []],
  ["snooze_workspace", "Put off a workspace's own Needs-you items (a hold, repairs to send) that carry no agent flag, like Later on its Home row (until: next-event, 1h, tonight, tomorrow or an ISO time); bring_back=true ends it early. A new item brings it back by itself." + ask, "follow.agent-act", { workspace: string, until: string, bring_back: boolean, ...planned }, ["workspace"]],
  ["set_finish_flags", "Turn finish flags on or off for other agents, like Don't flag finishes." + ask, "follow.agent-act", { agentIds: array, value: boolean, ...planned }, []],
  ["set_priorities", "Rank workspaces for Home's Priority sort: per workspace (id or exact title) a score 0-100, a one-line reason the developer sees, and its sources [{kind: linear|slack|planning|github|paseo, label, url}]. replace=true drops workspaces you leave out. Used for 6 hours. Returns a dry run; store it with confirm=true and the planId.", "follow.agent-act", { priorities: { type: "array", items: { type: "object", properties: { workspace: string, score: { type: "integer", minimum: 0, maximum: 100 }, reason: { ...string, maxLength: 140 }, sources: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["linear", "slack", "planning", "github", "paseo"] }, label: string, url: string }, required: ["kind", "label"] } } }, required: ["workspace", "score", "reason"] } }, replace: boolean, ...planned }, ["priorities"]],
  // Settings, onboarding, Home and the panel, one developer RPC each (server/agent-parity.ts). Writes plan first.
  ["make_main_agent", "Make yourself or another root agent of this workspace its main agent (the one that asks the developer, reports Needs-you and calls Done). requested=developer when the developer asked for it (refused only while the main is mid-turn); requested=self for your own claim, allowed only when the main is archived, gone or closed 30 minutes, or you registered every open PR and the main has been idle 24 hours, and never within 30 minutes of a change or 2 hours after you lost the role. Give a one-line reason the developer sees. Returns a dry run; run it with confirm=true and the planId.", "follow.agent-act", { agentId: string, reason: string, requested: { type: "string", enum: ["developer", "self"] }, ...planned }, []],
  ["display_settings", "Read Settings → Display: the header button, sidebar item, composer pill, Needs-you inbox, closed-PR flags, brief nudge, Overseer, ranker and trust bypass switches." + read, "follow.agent-act", {}, []],
  ["set_display", "Change Settings → Display switches, e.g. { values: { enable_trust_bypass: false } }. Keys from display_settings." + ask, "follow.agent-act", { values: { type: "object", additionalProperties: boolean }, ...planned }, []],
  ["follow_settings", "Read Settings → Following: follow every workspace, the Auto-send default, the active window, and per-workspace exceptions." + read, "follow.agent-act", {}, []],
  ["set_follow_settings", "Change Settings → Following: enable_follow_every, enable_auto_sends_default, activeWindowDays (1-60), or one workspace's exception { workspaceId, follow, enable_auto_sends }." + ask, "follow.agent-act", { enable_follow_every: boolean, enable_auto_sends_default: boolean, activeWindowDays: { type: "integer", minimum: 1, maximum: 60 }, workspace: { type: "object" }, ...planned }, []],
  ["project_settings", "Read each project and whether Follow-up follows its new workspaces by default." + read, "follow.agent-act", {}, []],
  ["set_project_tracking", "Follow a project's new workspaces by default, or stop: { projectId, enable_default_tracking }." + ask, "follow.agent-act", { projectId: string, enable_default_tracking: boolean, ...planned }, []],
  ["pr_workflow", "Read Settings → Following → Shipping PRs: each repository's PR workflow (graphite or github), merge method and review-fix setting, and the default. refresh=true re-detects." + read, "follow.agent-act", { refresh: boolean }, []],
  ["set_pr_workflow", "Change Shipping PRs: per repository (repo owner/name) its setting, mergeMethod or reviewFix (null clears back to the default), or the default." + ask, "follow.agent-act", { repo: string, setting: { type: ["string", "null"] }, default: string, mergeMethod: { type: ["string", "null"] }, reviewFix: { type: ["object", "null"] }, ...planned }, []],
  ["reviewer_settings", "Read Settings → Reviewers: the default reviewers and each repository's own list." + read, "follow.agent-act", {}, []],
  ["reviewer_suggestions", "Suggest reviewers for a repository (owner/name) from its recent history." + read, "follow.agent-act", { repo: string }, ["repo"]],
  ["save_reviewers", "Save the reviewers Add reviewers asks: repo owner/name, or null for the default; reviewers [{ login, name?, kind? }]." + ask, "follow.agent-act", { repo: { type: ["string", "null"] }, reviewers: { type: "array", items: { type: "object" } }, ...planned }, []],
  ["set_agent_setting", "Change which agent a special role uses (Settings → Agents): role about|overseer|recovery|ranker, entry { provider, model, ... } or null for the default. agent_settings shows the current ones." + ask, "follow.agent-act", { role: string, entry: { type: ["object", "null"] }, ...planned }, []],
  ["set_wait_for_jobs", "Turn Settings → Agents → Wait for background jobs on or off (enable_wait), like its switch. Applies to sessions opened afterwards. agent_settings shows it." + ask, "follow.agent-act", { enable_wait: boolean, ...planned }, []],
  ["onboarding_status", "Read the setup guide's state: whether it was finished or skipped, and the current step." + read, "follow.agent-act", {}, []],
  ["onboarding_checks", "Run the setup checks (GitHub login, providers, ...) and return each result with its fix. fresh=true re-runs them." + read, "follow.agent-act", { fresh: boolean }, []],
  ["set_onboarding", "Move the setup guide: action start|step|finish|skip|restart|dismiss-offer, step for action=step. restart is the developer's \"Set up Follow-up again\" (Settings → General, and ⌘K): the guide from the top, on Home, even after it was finished or skipped." + ask, "follow.agent-act", { action: string, step: string, ...planned }, []],
  ["priorities", "Read the stored priorities behind Home's Priority sort." + read, "follow.agent-act", {}, []],
  ["rank_status", "Read the priority ranker's state: last run, whether it's running, and errors." + read, "follow.agent-act", {}, []],
  ["rerank_priorities", "Re-rank Home's Priority sort now, like Re-rank. force=true re-runs even when nothing changed." + ask, "follow.agent-act", { force: boolean, ...planned }, []],
  ["usage", "Read provider usage limits and the VM's memory meter, as Home shows them." + read, "follow.agent-act", {}, []],
  ["overseer_status", "Read the Overseer's state: running, its agent and model, and what a restart would use." + read, "follow.agent-act", {}, []],
  ["overseer_start", "Start the Overseer, like Start on Home." + ask, "follow.agent-act", { ...planned }, []],
  ["overseer_restart", "Restart the Overseer (with the model Settings → Agents names now)." + ask, "follow.agent-act", { ...planned }, []],
  ["overseer_ask", "Send the developer's words to the Overseer, as its box on Home does: { text }." + ask, "follow.agent-act", { text: string, ...planned }, []],
  ["inbox_brief", "Read another agent's full Needs-you brief (decisions, options, links): { agentId }." + read, "follow.agent-act", { agentId: string }, ["agentId"]],
  ["brief_action", "Answer another agent's brief for the developer, like its card: { agentId, briefId, decisionId + choice, or choices [{ decisionId, choice }], or move: retry (a failed turn) or done (an Action brief: sends \"Done: <ask>\" as the developer) }. choice \"other\" is Something else and needs words (top-level, or on its entry in choices). Never your own brief." + ask, "follow.agent-act", { agentId: string, briefId: string, decisionId: string, choice: string, words: string, move: string, choices: { type: "array", items: { type: "object" } }, ...planned }, []],
  ["inbox_act", "The inbox's other actions on other agents' rows: action undo|mute_turn|unsorted_flag|unsorted_sign_off|batch_undo, agentIds." + ask, "follow.agent-act", { action: string, agentIds: array, muteTurn: boolean, ...planned }, []],
  ["answer_question", "Send the developer's answer to another agent's question (Q1…), like its card: { workspaceId, questionId, choice, words }. choice is an option letter, or \"other\" (Something else) with the developer's answer as words. For a question you asked, use record_answer." + ask, "follow.agent-act", { workspaceId: string, questionId: string, choice: string, words: string, ...planned }, []],
  ["run_recovery", "Run recovery on a workspace, like Run recovery: a separate agent reads its history for missed PRs and tasks. { workspaceId }." + ask, "follow.agent-act", { workspaceId: string, ...planned }, []],
  ["refresh", "Refresh PR status now, like Refresh. Cheap; use when status looks stale.", "follow.agent-act", { workspaceId: string }, []],
  ["set_workspace_spec", "Set, remove or reset any workspace's spec link: { workspaceId, action set|remove|reset, url, title }." + ask, "follow.agent-act", { workspaceId: string, action: string, url: string, title: { type: ["string", "null"] }, ...planned }, []],
  ["set_task_trigger", "Schedule a task to run now, on merge or on deploy (trigger { event, delayDays } or null), with afterPrs: { workspaceId, obligationId, expectedRevision, trigger, afterPrs }." + ask, "follow.agent-act", { workspaceId: string, obligationId: string, expectedRevision: { type: "integer", minimum: 0 }, trigger, afterPrs: array, ...planned }, []],
  ["pr_controls", "Read a PR's merge controls as the PR sheet shows them (Send to Paseo pairing, Graphite in Chrome): { workspaceId, prKey }." + read, "follow.agent-act", { workspaceId: string, prKey }, ["workspaceId", "prKey"]],
  ["browser_status", "Read whether Send to Paseo is paired and which repositories it may control." + read, "follow.agent-act", {}, []],
  ["release_notes", "Read Follow-up's release notes: the installed version, the version it updated from (previous) and when (updatedAt, ms), and every shipped version's notes, newest first. What's new shows the notes after previous." + read, "follow.agent-act", {}, []],
  ["updates_status", "Read Settings → General: installed version and install kind, mode (auto|notify|off), channel (stable|beta), newest version per channel, last and next check, phase (current, available, waiting, installing, settling, updated, rolled-back, install-failed, untrusted), notes for the pending version, install history, and move (2.0's one-time move to its new plugin id: phase none|waiting|moving|moved|rolled-back|failed|manual, with the reason)." + read, "follow.agent-act", {}, []],
  ["check_updates", "Ask the registry for a newer Follow-up now, like Check now. Works when updates are Off. Calls a few seconds apart share one request; call it only when asked. Returns updates_status.", "follow.agent-act", {}, []],
  ["set_updates", "Change how Follow-up updates, like Settings → General: { mode: auto|notify|off, channel: stable|beta }." + ask, "follow.agent-act", { mode: { type: "string", enum: ["auto", "notify", "off"] }, channel: { type: "string", enum: ["stable", "beta"] }, ...planned }, []],
  ["install_update", "Install a newer Follow-up, like Install now: { version } from updates_status. It waits for a quiet moment (no agent mid-turn) unless anyway: true. Rolled back automatically if the new version doesn't come up. Never installs a version whose provenance failed." + ask, "follow.agent-act", { version: string, anyway: boolean, ...planned }, ["version"]],
  ["retry_move", "Try Follow-up's move to its new plugin id again, like Settings → General's Try again, after updates_status shows move.phase rolled-back or failed. It waits for a quiet moment like an update and rolls back by itself if the new id doesn't come up." + ask, "follow.agent-act", { ...planned }, []],
  ["trust_bypass_status", "Read how many permission prompts trust bypass approved today, and the latest ones." + read, "follow.agent-act", {}, []],
];
// The Overseer's routing tools (1.4.0-beta.0): only in the session Follow-up started as its Overseer.
const overseerTools = [
  ["workstreams", "Every workspace the developer has, as Home groups them (needs, fixing, running, waiting, later, quiet): title, branch, PRs with checks, main agent and status, current ask, last activity, priority and reason, Linear keys. Paged (page, size ≤100); filter by group or query (name, branch, key, #PR).", "follow.overseer-act", { page: integer, size: integer, group: { type: "string", enum: ["needs", "fixing", "running", "waiting", "later", "quiet"] }, query: string }, []],
  ["agent_digest", "One agent's last steps (default 10) summarised, its status and its open asks to the developer (flag, decisions, questions). Use before routing when the digest isn't enough.", "follow.overseer-act", { agentId: string, steps: integer }, ["agentId"]],
  ["route_candidates", "Score every workspace for the developer's ask by Linear key, PR number, branch, workspace name, open asks and recent activity. Returns the top 3 and whether one is a confident match.", "follow.overseer-act", { ask: string }, ["ask"]],
  ["send_to_agent", "Forward the developer's words to the agent that owns the work, prefixed \"From the developer via Overseer:\". reply_to_ask=true only when the developer is answering that agent's open ask (it then clears its Needs-you flag). Then tell the developer where it went in one line.", "follow.overseer-act", { agentId: string, text: string, reply_to_ask: boolean }, ["agentId", "text"]],
  ["start_workspace", "Start a new workspace with an agent for a task, branched off main with the default model. Only when the developer asked for a new workspace or picked it. Returns a dry run (title from the task and Linear key, branch, project); run it with confirm=true and the planId.", "follow.overseer-act", { task: string, title: string, project: string, linear_key: string, base: string, planId: string, confirm: boolean }, []],
  ["rerank", "Re-rank Home's Priority sort now from Linear, Slack, GitHub review requests and the weekly plan, when the developer asks for it. Returns the top 10 with their reasons. Skips the model when nothing changed.", "follow.overseer-act", {}, []],
];
const overseerNames = new Set(overseerTools.map(t => t[0]));
const overseerInstruction = "You are Follow-up's Overseer. Route the developer's asks with route_candidates and send_to_agent; ask with needs_you kind=decision when unsure; start_workspace only when the developer asked or approved. Never merge, post to people or archive.";
const actionNames = new Set(actionTools.map(t => t[0]));
const readOnlyTools = new Set(["workspace_status", "list_prs", "inbox_list", "workstreams", "agent_digest", "route_candidates", "workspace_about", "link_items", "agent_settings", "display_settings", "follow_settings", "project_settings", "pr_workflow", "reviewer_settings", "reviewer_suggestions", "onboarding_status", "onboarding_checks", "priorities", "rank_status", "usage", "overseer_status", "inbox_brief", "pr_controls", "browser_status", "trust_bypass_status", "release_notes", "updates_status"]);
const destructiveTools = new Set(["merge"]);
const actionInstruction = "Follow-up's action tools let you do anything the developer can click, across every tracked workspace and every Settings tab. Read freely: list_prs, inbox_list, inbox_brief, workspace_about, agent_settings, display_settings, follow_settings, project_settings, pr_workflow, reviewer_settings, onboarding_status, priorities, rank_status, usage, overseer_status, pr_controls. Hand the main role on, or claim it, with make_main_agent. Act only when the developer asks (\"the PRs look good, assign reviewers on all\": list_prs needs_reviewers=true, add_reviewers with those keys, then confirm the plan): add_reviewers, merge, enable/disable_merge_when_ready, send_repairs, set_auto_send, clear_hold, retry_batch, track, run_recovery, set_priorities, rerank_priorities; settings with set_display (trust bypass too), set_follow_settings, set_project_tracking, set_pr_workflow, save_reviewers, set_agent_setting, set_wait_for_jobs, set_onboarding; snooze_workspace; and sign_off/snooze/set_finish_flags/inbox_act/brief_action/answer_question for other agents. Planned tools return a dry run showing what changes; run it with confirm=true and its planId. Never sign yourself off or answer your own brief.";

// Wait (folded in from paseo-wait): its three tools are served natively (server/wait.ts), never by this bridge.
// Native tools carry no MCP instructions, so the agent hook adds this at SessionStart when FOLLOW_THROUGH_WAIT=1.
// Paseo 0.16+ (features.agentBackgroundWork) tracks background shell jobs and wakes the agent when one finishes, so
// Wait's tools aren't attached there; the agent hook adds this instead when FOLLOW_THROUGH_BACKGROUND_WORK=1.
const backgroundWorkInstruction = "When a finite shell command may take a while (tests, builds, installs, deploy checks), run it with native Bash run_in_background=true. Continue useful independent work first if available. When only waiting remains, end your turn and say what you're waiting for: Paseo keeps the job running, shows it with Stop, and wakes you when it finishes. Don't sleep or poll in a loop to keep the turn open. When you're woken, confirm the actual exit code before reporting completion.";
const waitInstruction = "When a finite shell command may take a while and you need its result to finish the user's task, use Wait: wait_prepare_job({description, command}), run the returned exact bashCommand through native Bash with run_in_background=true, then call wait_for_job({jobId}). Continue useful independent work first if available. When only waiting remains, keep waiting through wait_for_job instead of ending your turn with \"waiting for a notification\". Each call wakes you after at most 60 seconds (default 30): on still_pending, inspect wait_get_job and the native Bash output, then wait again if appropriate. Confirm the actual exit code before reporting completion. New messages and Stop release observation without killing the job. Already-started ordinary background tasks cannot be adopted: do not rerun a command just to wrap it.";

// The brief's tool: every root agent while the Needs-you inbox is on; never contributors, recovery or subagents.
// Kept identical to NEEDS_YOU_INSTRUCTION in shared/brief.ts (a test checks it).
const needsYouInstruction = "When you end a turn, call `needs_you` once, just before your final reply, with what the developer has to do next: a decision (give 2–3 options, what each means for them, and the one you recommend), an action only they can take (merge, approve, log in, run or send something), or kind=done (\"Nothing needed\" plus what you finished, in one line), which means there is nothing for the developer and won't flag you in their inbox. A decision that is already an open question (you asked it with ask_question, or it is still open from an earlier turn) is never restated: point at it with questions=[\"Q18\"], or say \"Still open: Q18 …\" in ask. Keep `ask` to one line and `context` to what they need to decide. Don't repeat your report there; still write your normal reply. Don't call it while a permission prompt is waiting or while you're still working.";
function toolList(recovery = env("RECOVERY") === "1", contributor = false, brief = false, briefOnly = false, actions = false) {
  // Action tools: root agents (tracked main or untracked) while Follow-up runs; never recovery or contributors.
  // Contributors get make_main_agent only (its claim rules apply); recovery sessions get none.
  const acting = !actions || recovery ? [] : contributor ? actionTools.filter(t => t[0] === "make_main_agent") : actionTools;
  if (briefOnly) return [...(brief ? tools.filter(t => t[0] === "needs_you") : []), ...acting];
  return [...tools.filter(t => t[0] === "needs_you" ? brief && !recovery && !contributor : contributor ? ["workspace_status", "register_pr", "sync_workspace", "link_item", "unlink_item"].includes(t[0]) : !recovery || !["declare_done", "sync_workspace", "ask_question", "record_answer", "withdraw_question", "set_spec", "link_item", "unlink_item"].includes(t[0])), ...acting];
}
/** Whether this session may call needs_you: launched as a root agent (FOLLOW_THROUGH_BRIEF) and the inbox is on. */
async function briefEnabled() {
  if (!env("BRIEF") || env("RECOVERY") === "1") return false;
  try {
    const directory = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data/follow-through");
    const lease = JSON.parse(await readFile(join(directory, "hooks-enabled.json"), "utf8"));
    if (!(lease.expiresAt > Date.now())) return false;
    const brief = JSON.parse(await readFile(join(directory, "brief.json"), "utf8"));
    return brief?.enable_inbox === true;
  } catch { return false; }
}
/**
 * Merge and merge-when-ready say how they run. "github": every known repository ships plain GitHub, so Graphite is
 * never named; "mixed": either, per list_prs prWorkflow; anything else keeps the Graphite wording it always had.
 */
function describeAction(name, description, workflows) {
  if (workflows !== "github" && workflows !== "mixed") return description;
  const how = workflows === "github"
    ? { merge: "through GitHub (gh pr merge, with the repository's merge method)", on: "Turn on GitHub auto-merge", off: "Turn off GitHub auto-merge" }
    : { merge: "the way its repository ships (Graphite, or GitHub's gh pr merge; list_prs shows prWorkflow)", on: "Turn on merge-when-ready (Graphite) or auto-merge (GitHub)", off: "Turn off merge-when-ready (Graphite) or auto-merge (GitHub)" };
  if (name === "merge") return description.replace("through Graphite", how.merge);
  if (name === "enable_merge_when_ready") return description.replace("Turn on Graphite merge-when-ready", how.on);
  if (name === "disable_merge_when_ready") return description.replace("Turn off Graphite merge-when-ready", how.off);
  return description;
}
const schemas = (list, workflows = null) => list.map(([name, description, , properties, required]) => ({ name, description: describeAction(name, description, workflows), inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: destructiveTools.has(name) } }));
/** Action tools: a session Paseo launched as a root agent (FOLLOW_THROUGH_ROOT) while Follow-up runs (fresh hook lease). */
async function actionsEnabled() {
  if (!process.env.PASEO_AGENT_ID || env("ROOT") !== "1" || env("RECOVERY") === "1") return false;
  try {
    const lease = JSON.parse(await readFile(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data/follow-through/hooks-enabled.json"), "utf8"));
    return lease.expiresAt > Date.now();
  } catch { return false; }
}
/** The bridge input for a tool: action tools travel as { tool, args } through follow.agent-act. */
const callInput = (tool, input) => actionNames.has(tool[0]) || overseerNames.has(tool[0]) ? { tool: tool[0], args: input } : input;
/** The Overseer's routing tools: the session Follow-up launched as its Overseer, while Follow-up runs. */
async function overseerEnabled() {
  if (env("OVERSEER") !== "1" || !process.env.PASEO_AGENT_ID) return false;
  try {
    const lease = JSON.parse(await readFile(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data/follow-through/hooks-enabled.json"), "utf8"));
    return lease.expiresAt > Date.now();
  } catch { return false; }
}
let scopeCache = null;
async function scopeOf(directory, agentId) {
  try {
    const path = join(directory, "scopes.json");
    const { mtimeMs } = await stat(path);
    if (scopeCache?.mtimeMs !== mtimeMs) { const file = JSON.parse(await readFile(path, "utf8")); scopeCache = { mtimeMs, agents: file.agents ?? {}, workflows: file.workflows ?? null }; }
    return scopeCache.agents[agentId]?.role ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    for (const w of state.workspaces) {
      if (!w.enable_tracking || w.archived) continue;
      if (w.mainAgentId === agentId) return "main";
      if (w.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory"))) return "recovery";
      if (w.contributorAgentIds?.includes(agentId)) return "contributor";
    }
    return null;
  }
}
/** This agent's PR workflow from scopes.json (undefined: an older worker, which meant Graphite with /fix-pr). */
const workflowOf = agentId => scopeCache ? scopeCache.agents[agentId]?.workflow : undefined;
/** Whether the repositories Follow-up knows ship through Graphite, GitHub or both ("mixed"); null: unknown, as before. */
const workflowsOf = () => scopeCache?.workflows ?? null;
async function scope(resolveRecovery = false) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return null;
  try {
    const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
    const directory = join(home, "plugin-data/follow-through");
    const lease = JSON.parse(await readFile(join(directory, "hooks-enabled.json"), "utf8"));
    if (!(lease.expiresAt > Date.now())) return null;
    // scopes.json (a few KB, rewritten only when a role changes) instead of the whole state.json; re-read only
    // when its mtime changes. Older workers don't write it, so fall back to state.json.
    const known = await scopeOf(directory, agentId);
    if (known === "main") return env("RECOVERY") === "1" ? "recovery" : "main";
    if (known) return known;
    if (resolveRecovery && env("RECOVERY") === "1") {
      const w = await call("follow.agent-status", {});
      if (w.enable_tracking && !w.archived && w.mainAgentId !== agentId && w.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory"))) return "recovery";
    }
  } catch {}
  return null;
}
function validate(value, schema, path = "arguments") {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type) && !(type === "number" && types.includes("integer") && Number.isInteger(value))) throw new Error(`${path}: expected ${types.join(" or ")}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: choose ${schema.enum.join(", ")}.`);
  if (type === "object") {
    const extra = Object.keys(value).filter(k => !Object.hasOwn(schema.properties ?? {}, k));
    if (extra.length && schema.additionalProperties === false) throw new Error(`Unknown argument ${path}.${extra.join(", ")}. ${extra.includes("dependsOnPrs") ? "Use afterPrs with owner/repo#number keys." : "Check this tool's input schema with list."}`);
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required. Check this tool's input schema with list.`);
    for (const [key, nested] of Object.entries(value)) if (schema.properties?.[key]) validate(nested, schema.properties[key], `${path}.${key}`);
  }
  if (type === "array") for (let i = 0; i < value.length; i++) validate(value[i], schema.items, `${path}[${i}]`);
  if (type === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}: outside the allowed range.`);
  if (type === "string" && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) throw new Error(`${path}: outside the allowed length.`);
}
function currentWork(w) {
  return { id: w.id, title: w.title, goal: w.goal, mainAgentId: w.mainAgentId, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends, hold: w.hold, archived: w.archived, runtimeBusy: w.runtimeBusy, runtimeReason: w.runtimeReason, backgroundBusy: w.backgroundBusy, completion: w.completion,
    prs: w.prs.map(p => ({ key: p.key, stack: p.stack, parent: p.parent, disposition: p.disposition, error: p.error, ...(p.snapshot ? { title: p.snapshot.title, state: p.snapshot.state, head: p.snapshot.head, draft: p.snapshot.draft, reviewDecision: p.snapshot.reviewDecision, conflict: p.snapshot.conflict, openThreads: p.snapshot.threads.length, failedChecks: p.snapshot.failedChecks, otherFailedChecks: p.snapshot.otherFailedChecks ?? [], deployment: p.snapshot.deployment } : {}) })),
    obligations: w.obligations.filter(o => !["done", "waived"].includes(o.status)), completedObligations: w.obligations.filter(o => ["done", "waived"].includes(o.status)).length,
    openQuestions: (w.questions ?? []).filter(q => !q.answer && !q.closed).map(q => ({ id: q.id, title: q.title, question: q.question, options: q.options, recommend: q.recommend, big: q.big, mode: q.mode, askedBy: q.askedBy, taskId: q.taskId })),
    spec: w.spec?.url ? { url: w.spec.url, title: w.spec.title, source: w.spec.source } : null,
    recentAnswers: (w.questions ?? []).filter(q => q.answer).slice(-5).map(q => ({ id: q.id, title: q.title, choice: q.answer.choice, words: q.answer.words, delivery: q.answer.delivery.state })),
    batches: w.batches.filter(b => !["completed", "cancelled"].includes(b.state)).map(b => ({ id: b.id, state: b.state, tasks: b.tasks, result: b.result, recipientAgentId: b.recipientAgentId, contextPath: b.contextPath })),
    excludedStacks: w.excludedStacks.map(s => ({ name: s.name, reason: s.reason, prs: s.prs.map(p => p.key) })), ...(w.prWorkflow ? { prWorkflow: w.prWorkflow } : {}), detail: "summary" };
}
function compact(tool, input, result) {
  if (actionNames.has(tool)) return result;
  if (tool === "workspace_status") return currentWork(result);
  if (tool === "needs_you") return { ok: result.ok, briefId: result.briefId };
  if (tool === "declare_done") return { workspaceId: result.workspace.id, done: !result.blockers.length, alreadyDone: !!result.alreadyDone, completion: result.workspace.completion, blockers: result.blockers, ...(result.unconfirmed?.length ? { deployNotConfirmed: result.unconfirmed } : {}), next: result.next };
  if (tool === "ask_question") return { workspaceId: result.workspaceId, question: { id: result.question.id, title: result.question.title, recommend: result.question.recommend, big: result.question.big }, mode: result.mode, instruction: result.instruction, ...(result.outcome && result.outcome !== "asked" ? { outcome: result.outcome, of: result.of } : {}) };
  if (tool === "record_answer" || tool === "withdraw_question") return { workspaceId: result.workspaceId, question: { id: result.question.id, answer: result.question.answer, closed: result.question.closed } };
  if (tool === "set_spec") return { workspaceId: result.workspaceId, spec: result.spec && { url: result.spec.url, title: result.spec.title, source: result.spec.source }, applied: result.applied, message: result.message };
  if (!result?.prs) return result;
  const workspaceId = result.id;
  if (tool === "enroll_workspace") return { workspaceId, goal: result.goal };
  if (tool === "register_pr") { const p = result.prs.find(p => p.key === `${input.repo}#${input.number}`); return { workspaceId, pr: { key: p.key, stack: p.stack, parent: p.parent, disposition: p.disposition } }; }
  if (tool === "update_obligation") return { workspaceId, obligation: result.obligations.find(o => o.id === result.updatedObligationId) };
  if (tool === "acknowledge_batch") { const b = result.batches.find(b => b.id === input.batchId); return { workspaceId, batch: { id: b.id, state: b.state, result: b.result } }; }
  if (tool === "exclude_stack") { const s = result.excludedStacks.find(s => s.name === input.stack); return { workspaceId, excludedStack: { name: s.name, reason: s.reason, prs: s.prs.map(p => p.key) } }; }
  return result;
}
async function loadClient() {
  const candidates = [];
  if (env("CLIENT_ENTRY")) candidates.push(() => pathToFileURL(env("CLIENT_ENTRY")).href);
  const specifier = "@getpaseo/client/internal/daemon-client";
  if (process.resourcesPath) candidates.push(() => pathToFileURL(createRequire(join(process.resourcesPath, "app.asar/node_modules/@getpaseo/cli/dist/index.js")).resolve(specifier)).href);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const cli = join(directory, process.platform === "win32" ? "paseo.cmd" : "paseo");
    if (existsSync(cli)) candidates.push(() => pathToFileURL(createRequire(realpathSync(cli)).resolve(specifier)).href);
  }
  candidates.push(() => pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href);
  for (const resolve of candidates) try { return await import(resolve()); } catch {}
  throw new Error("Cannot load the installed Paseo client. Reload Follow-through to refresh its runtime connection.");
}
const batchInstructionsMain = "Follow-through batches contain a header with the batchId and ordered tasks. Read workspace_status and refresh live conditions; skip resolved tasks. Process PRs bottom to top, one fully before the next, using the repository's /fix-pr and safe reparent workflow. Validate feedback, verify changes, submit with Graphite --publish, reply/resolve addressed threads and preserve uncommitted work. Post-deploy tasks require verified serving revisions and existing production permissions. Stakeholder update requests are follow-through tasks: retain the original thread, recipient and developer authorization in communication. Use current evidence, distinguish fixed/deployed/verified, and read existing replies before posting. Record the sent replyUrl; a draft or uncertain send stays blocked and must be checked before retrying. Auto authorizes agent delivery only. Acknowledge the header's batchId with acknowledge_batch before finishing (completed with the result, or blocked with the reason), before declare_done for completion batches. Declare Done only after the whole goal and post-merge work are verified. Leave merging and archiving to the developer.";
/**
 * The batch rules for this workspace's PR workflow. Graphite with /fix-pr (and any agent from before workflows
 * existed) gets the original text unchanged; plain GitHub never mentions Graphite, gt or a review command it doesn't have.
 */
function batchInstructions(workflow) {
  const mode = workflow?.mode ?? "graphite";
  const fix = workflow === undefined || workflow === null ? "/fix-pr" : workflow.reviewFix ?? null;
  if (mode === "graphite" && fix === "/fix-pr") return batchInstructionsMain;
  const fixing = fix ? `using the repository's ${fix} workflow for review comments` : "reading each PR's unresolved review threads with gh";
  const restack = mode === "graphite" ? "the repository's safe reparent workflow" : "base branches kept in a chain (restack with git rebase --update-refs, push with --force-with-lease, and after a parent merges retarget its child with gh pr edit --base if GitHub didn't)";
  const submit = mode === "graphite" ? "submit with Graphite --publish" : "push the branch (gh pr create for a new PR, gh pr ready when it leaves draft)";
  const reply = fix ? "reply/resolve addressed threads" : "reply to each addressed thread and resolve it";
  return batchInstructionsMain
    .replace("using the repository's /fix-pr and safe reparent workflow.", `${fixing}, with ${restack}.`)
    .replace("submit with Graphite --publish, reply/resolve addressed threads", `${submit}, ${reply}`);
}

async function call(method, input) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) throw new Error("This bridge must run inside a Paseo agent (PASEO_AGENT_ID is missing).");
  const { DaemonClient } = await loadClient();
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  let password = process.env.PASEO_PASSWORD;
  if (!password && process.env.PASEO_PASSWORD_FILE) password = (await readFile(process.env.PASEO_PASSWORD_FILE, "utf8")).trim();
  if (!password && home === join(homedir(), ".paseo")) password = await readFile(join(homedir(), "paseo-hub/secrets/daemon-password"), "utf8").then(s => s.trim()).catch(() => undefined);
  const client = new DaemonClient({ url: process.env.PASEO_DAEMON_URL ?? `ws://${config.daemon?.listen ?? "127.0.0.1:6767"}/ws`, clientId: "follow-through-mcp", clientType: "cli", reconnect: { enabled: false }, connectTimeoutMs: 10000, suppressSendErrors: true, ...(password ? { password } : {}) });
  try {
    await client.connect();
    let last;
    for (const id of runtime.pluginIds ?? ["follow-up"]) {
      try { return await client.invokePluginRpc(id, method, { ...input, agentId }); }
      catch (error) { if (!/plugin (?:is )?not (?:available|installed|configured)/i.test(error?.message ?? "")) throw error; last = error; }
    }
    throw last;
  }
  finally { await client.close().catch(() => undefined); }
}


// The worker imports this file for the same tool tables, validation and receipts (1.4.0-beta.2: Follow-up's tools
// served natively through Paseo's own MCP). Only a direct run is the CLI / stdio bridge.
export { tools, actionTools, overseerTools, toolList, schemas, validate, compact, callInput, needsYouInstruction, actionInstruction, overseerInstruction, waitInstruction, backgroundWorkInstruction, batchInstructions, describeAction };
function isMain() {
  // 2.0's recovery shim (shared/legacy.ts) imports this file from the old data directory and asks for a bridge run.
  if (globalThis.followUpRunAsBridge === true) return true;
  try { return !!process.argv[1] && !!import.meta.url && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isMain()) runMain().catch(error => { console.error(error?.message ?? String(error)); process.exitCode = 1; });
async function runMain() {
const command = process.argv[2];
if (command === "list" || command === "--help" || command === "help") {
  process.stdout.write(command === "list" ? JSON.stringify({ tools: schemas([...toolList(undefined, false, true, false, true), ...overseerTools]) }, null, 2) + "\n" : "Usage: node mcp.mjs list | call <tool> '<json>' [--compact]\nNative MCP returns compact receipts; workspace_status({detail:full}) requests complete history. CLI calls retain full replies unless --compact is supplied.\n");
} else if (command === "call") {
  try {
    const tool = [...toolList(undefined, false, await briefEnabled(), false, await actionsEnabled()), ...(await overseerEnabled() ? overseerTools : [])].find(t => t[0] === process.argv[3]);
    if (!tool) throw new Error("Unknown tool. Run list for names and input schemas.");
    const input = JSON.parse(process.argv[4] ?? "{}");
    validate(input, schemas([tool])[0].inputSchema);
    if (process.argv.slice(5).some(arg => arg !== "--compact")) throw new Error("Unknown CLI option. Use --compact or omit it for a full reply.");
    const result = await call(tool[2], callInput(tool, input));
    process.stdout.write(JSON.stringify(process.argv.includes("--compact") && input.detail !== "full" ? compact(tool[0], input, result) : result, null, 2) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (command) {
  console.error("Unknown command. Use list, --help, or call <tool> '<json>'."); process.exitCode = 1;
} else {
  const lines = createInterface({ input: process.stdin });
  let tail = Promise.resolve(), initialized = false, lastScope = null;
  const timer = process.env.PASEO_AGENT_ID ? setInterval(() => {
    void (async () => { const current = `${await scope()}:${await briefEnabled()}:${await actionsEnabled()}:${await overseerEnabled()}`; if (initialized && current !== lastScope) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n"); lastScope = current; })().catch(() => {});
  }, 2000) : null;
  timer?.unref(); lines.on("close", () => { if (timer) clearInterval(timer); });
  lines.on("line", line => {
    tail = tail.then(async () => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (request.id === undefined) return;
      try {
        let result;
        const role = await scope(request.method === "initialize" || request.method === "tools/list");
        const brief = await briefEnabled();
        const acting = await actionsEnabled();
        const overseeing = await overseerEnabled();
        const workflow = workflowOf(process.env.PASEO_AGENT_ID);
        const available = [...(role ? toolList(role === "recovery", role === "contributor", brief, false, acting) : toolList(false, false, brief, true, acting)), ...(overseeing ? overseerTools : [])];
        if (request.method === "initialize") {
          initialized = true; lastScope = `${role}:${brief}:${acting}:${overseeing}`;
          result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "paseo-follow-through", version: "0.3.5" }, instructions: (role ? (role === "contributor" ? "Register PRs this session submits, including from secondary git worktrees. Read workspace_status and call sync_workspace before finishing. Goal, task, scope and completion changes remain with the designated main agent." : role === "recovery" ? "Recover tracking metadata from evidence, acknowledge your assigned batch, and leave completion to the main agent." : "Keep workspace follow-through updated after PR submission and scope changes. Read workspace_status after compaction. Track all post-merge work. When a decision needs the developer, ask it with ask_question (lettered options and a recommendation) and follow the question mode in its reply. If you keep a spec artifact for this workspace, register its link once with set_spec. " + batchInstructions(workflow)) + " Perform bookkeeping silently: no sidebar-update announcements, plugin-status commentary or final sidebar recap. Put receipts and summaries in tools. Report actual work outcomes or decisions/blockers; discuss sidebar status only when explicitly asked." : brief ? "" : "Follow-through tools are available to tracked workspace root agents and active recovery agents; contributor sessions receive PR registration and status tools.") + (brief && role !== "contributor" && role !== "recovery" ? (role ? " " : "") + needsYouInstruction : "") + (acting && role !== "contributor" && role !== "recovery" ? " " + actionInstruction : "") + (overseeing ? " " + overseerInstruction : "") };
        } else if (request.method === "ping") result = {};
        else if (request.method === "tools/list") result = { tools: schemas(available, workflowsOf()) };
        else if (request.method === "tools/call") {
          const tool = available.find(t => t[0] === request.params?.name);
          try {
            if (!tool) throw new Error("This tool is unavailable for the current agent. Tracking must be active; recovery authority ends after acknowledgment.");
            const input = request.params.arguments ?? {}; validate(input, schemas([tool])[0].inputSchema);
            const value = await call(tool[2], callInput(tool, input));
            result = { content: [{ type: "text", text: JSON.stringify(input.detail === "full" ? value : compact(tool[0], input, value)) }] };
          } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
        } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); return; }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } }) + "\n"); }
    });
  });
}
}
