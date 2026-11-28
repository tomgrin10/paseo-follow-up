# RPCs and agent tools

Every RPC lives in `shared/contracts.ts`, and its handler in `index.server.ts`. Agent tools are tuples in
`server/mcp.mjs`: `[name, description, rpc, properties, required]`. `tests/docs.test.ts` fails when an RPC or a tool
is missing from AGENTS.md or docs/, so add a line here when you add one.

## How tools reach an agent

- **Native (Paseo 0.15+).** `server/native-tools.ts` turns the tuples into `AgentToolDefinition`s on
  `request.tools`. Claude sees them as `mcp__paseo__follow_<name>` and Codex as `paseo.follow_<name>`. Every provider
  gets them, not only Claude and Codex: Paseo serves plugin tools through its agent MCP to any provider that takes MCP
  servers (OpenCode, Pi, Copilot, Cursor, any ACP agent). `FOLLOW_UP_TOOL_PROVIDERS` narrows it for the isolated
  harness only (an-agent-on-any-provider-gets-follow-up).
  - Each call runs the RPC handler in-process through the `handlers` map, as the caller (`context.agent.id`).
  - `live()` re-checks the caller's role on every call.
  - Details: [native-agent-tools.md](native-agent-tools.md).
- **Stdio bridge (Paseo 0.14, or when the host serves no plugin tools).** `server/session-mcp.ts` adds a per-launch
  MCP server that runs `plugin-data/follow-up/mcp.mjs`. It connects to the daemon as `PASEO_AGENT_ID` and calls
  the same RPCs. The same file is a CLI: `node "$FOLLOW_UP_CLI" list` or `call <tool> '<json>' [--compact]`.
  - There is never a global MCP registration. `server/mcp-registrations.ts` removes the old user-scope one, with a
    `.follow-up-unregister.bak`.
  - `server/agent-mcp.ts` builds the stdio definition.
- **Which tools a session gets** is one table, `ROLE_TOOLS` in `server/mcp.mjs` (agent-tools-by-role, invariant 139).
  `toolList()` is what a role lists, `callableTools()` what it may call (its list plus the actions its role may run
  by name), and `availableTools()` in `server/native-tools.ts` re-checks it on every native call. A native session
  lists everything a root agent's role could list for its lifetime (`attachableTools`: the main agent's, a
  contributor's and an untracked agent's lists together, about 22 tools), since the list is fixed at session open.
  The ~100 actions are not listed: [the action lookup](#the-action-lookup-find_action-run_action) reaches them.

| Session | Lists | May also run (through `run_action`) |
| --- | --- | --- |
| Tracked main agent | Core tools (below), `needs_you` while the inbox is on, `make_main_agent`, `find_action`, `run_action`. About 5.8k tokens of schema. | Every action. |
| Contributor (another root agent of a tracked workspace) | `workspace_status`, `workspace_now`, `register_pr`, `sync_workspace`, `show_card`, `link_item`, `unlink_item`, `context_reply`, `wait_for_checks`, `make_main_agent` (its claim rules apply), `find_action`, `run_action`. | `report_issue`. |
| Recovery agent | Core tools except `declare_done`, `sync_workspace`, the question tools, `show_card`, `link_item`, `unlink_item`, `context_reply` and `wait_for_checks`. | Nothing. |
| Untracked root agent | `wait_for_checks` (it names where else to wait), `make_main_agent`, `find_action`, `run_action`, and `needs_you` while the inbox is on. | Every action. |
| Overseer | The untracked root agent's list and the Overseer tools. | Every action. |
| Subagents | None (Wait still applies: [wait.md](wait.md)). |
| Any interactive Claude session | `wait_prepare_job`, `wait_for_job`, `wait_get_job` while Wait is on. |

- **Recognising tool calls in chat.** `shared/chat.ts` recognises Follow-up's tool calls in every spelling (native,
  bridge, CLI). `client/chat.tsx` renders them as compact rows.
- **Read-only and destructive tools.** `readOnlyTools` and `destructiveTools` in `server/mcp.mjs` mark tools
  read-only or destructive. `merge` is the only destructive one.

## Core tools (the workspace's own bookkeeping)

No core tool answers ok without acting (invariant 111). A write in a workspace Paseo still has archived is refused
with why and what to call (`archivedAskError`, `shared/reopen.ts`); one Paseo shows live again is reopened first. Other
paths that change nothing say so too: tracking off or opted out ("Tracking is inactive"), not the main agent (the access
error), the inbox off (`needs_you` errors), a dismissed ask restated (`needs_you`'s `note`).

| Tool | RPC | Use |
| --- | --- | --- |
| `workspace_status` | `follow.agent-status` | The workspace's goal, PRs, tasks and work queue. `detail=full` adds evidence. Finished items (merged or closed PRs, done or waived tasks, settled questions, batches and PR actions) are a count plus the newest few in both details (`history`); `history=<kind>` with `offset`/`limit` pages one kind; `detail=full live=<kind>` pages live evidence when budget pressure compacts it (see [Bounded answers](#bounded-answers)). Includes the PR workflow, `nextMessage` (recipient, tasks, exact text, reason, eta: Preview's agent form), `heldTasks` and `githubWait` (while GitHub's budget is low, when Follow-up checks this workspace's PRs again; null otherwise). |
| `workspace_now` | `follow.workspace-now` | read. Every agent in the caller's workspace, main agent first: what it is working on toward the goal (`work`: text, source, the agent's own done/next and its place, "2 of 4") and its state (working, a permission, an ask, compacting, a background job, CI, idle), the same line the panel and Home draw (`nowOf`, [shared/now.ts](../shared/now.ts)). Built from the record and the inbox rows the worker holds; no daemon read, nothing woken. |
| `sync_workspace` | `follow.sync` | Confirms the sidebar matches the work. The Stop hook asks for it after code-changing turns. Optional `milestone {now, done?, next?}`: what the agent is working on toward the goal, in a few words, with the milestones before and after it (each ≤80 chars, ≤8 per list). Stored per agent on the workspace record (`milestones`); omitted keeps the last one, null clears it; cleared at Done and when the agent leaves. The panel and Home show it as the agent's line (`workspace_now`). |
| `enroll_workspace` | `follow.enroll` | Refines the goal of a workspace the developer activated. |
| `register_pr` | `follow.register-pr` | Registers a submitted PR and its stack and parent. `agentMerges: true` marks a PR the agent merges itself: Follow-up never asks the developer to review or merge it. In a No review repository every PR counts as `agentMerges` unless the agent sets it false ([review mode](prs.md#review-mode)). |
| `exclude_stack` | `follow.exclude-stack` | Removes a wrongly registered stack, with an audit (`server/exclusions.ts`). |
| `update_obligation` | `follow.obligation` | Creates or updates a task (an obligation), with an optional trigger and communication receipt. `status: working` records the caller as the task's agent, or `workingAgentId` (another agent Paseo knows). `ask`, with `blocked`, is the question the developer must answer; only then does the task ask them. `question: "Q<n>"`, with `blocked`, points at a question already asked with `ask_question` instead: no second card (`one-decision-one-card`), and the reply's `note` says when the task is already asked or answered as a question; the card a task makes itself is never named (the turn's `needs_you` folds into it on the server). `need` (`decision` or `action`), with `blocked` and `ask`, says whether the developer decides or does something and reports back; an action's card has Done (`one-ask-one-item`). Without `id`, a title close to an open task's is refused with that task's id (`a-new-task-is-checked-once`); `new: true` adds it anyway, and the caller's own exact title updates its task. |
| `acknowledge_batch` | `follow.acknowledge` | Records a repair batch's result: completed or blocked; blocked with `humanOnly` when only a person can move it (a PR item for the developer, not an agent failure); `in_progress` when the agent or its subagent is already on it; `waitingOn` names the part only a person can move, with any outcome (a person item; later messages tell the agent to leave it). |
| `ask_question`, `record_answer`, `withdraw_question` | `follow.ask-question`, `follow.record-answer`, `follow.withdraw-question` | Questions for the developer (`server/questions.ts`). |
| `show_card` | `follow.show` | Shows the developer something in the workspace view: a card of typed blocks, replaced by id, removed with `remove: true` ([cards.md](cards.md)). Main agents and contributors. Replaced `set_spec` (2.6): a spec is the card with id `spec`. The view reads `follow.cards`, `follow.card-media` and `follow.card-act`. |
| `link_item`, `unlink_item` | `follow.link-item`, `follow.unlink-item` | Links what the work is about (a Linear key is confirmed with Linear first; a PR is refused), or removes one for good ([linked-items.md](linked-items.md)). Main and contributors. |
| `needs_you` | `follow.needs-you` | The end-of-turn brief: what the developer must do next. From a workspace Follow-up read as archived it reopens the workspace when Paseo shows it live, else the ask still reaches Needs you and the reply's `note` says the workspace is archived (invariant 111). |
| `declare_done` | `follow.done` | Declares the goal fulfilled and returns any blockers. |
| `wait_for_checks` | `follow.wait-for-checks` | Waits for a PR's checks without polling: answers at once from the caller's own workspace read, then sends one message after the turn when the checks on the current head finish (or it merges, closes or conflicts). Every root agent (main, contributors, untracked); not recovery. PRs Follow-up can't see get the way on (Paseo's `subscribe_change_request` on 0.17+) ([wait-for-checks.md](wait-for-checks.md)). |
| `context_reply` | `follow.context-reply` | Answers the developer's question (Your questions, More context) with the `requestId` the ask carried; only the agent it was asked of may answer ([needs-you.md](needs-you.md#your-questions)). Main agents and contributors get it (`/ask` can ask a contributor); recovery sessions don't. |

## The action lookup (find_action, run_action)

Until 2.6.0-beta.3 every root agent listed all of the action tools below: 117 tools, about 22k tokens of schema for a
main agent, loaded every turn on Codex and ACP agents (Claude Code defers them, so it paid for the names). Now a role
lists what it uses every turn and reaches the rest through two tools:

| Tool | RPC | Use |
| --- | --- | --- |
| `find_action` | none (answered in `server/mcp.mjs`, `findActions`) | read. `query`: a few words, the best six actions with their input schemas; `names`: those actions' schemas; no arguments: every action the caller may run, a line each. |
| `run_action` | `follow.agent-act` | `{ action, args }`: runs that action exactly as its own tool would (`runTool`): its input is checked against its schema first, then it goes through `follow.agent-act` with the same plan/confirm step, `agent:<id>` audit and per-call role check. Errors name the action and say how to find it (`resolveAction`). |

The bridge and the CLI still call an action by its own name (`node "$FOLLOW_UP_CLI" call list_prs '{}'`), and
`list` prints every tool. Action names in Follow-up's text stay bare (`TOOL_NAMES` in `server/agent-hook.mjs` holds only
names a session can list), and `tests/tool-budget.test.ts` scans each role's session text: every tool it names is one
that role lists, or an action it can run through `run_action`.

## Action tools (agent parity)

All of these go through `follow.agent-act`. The handlers are in `AgentActions` (`server/agent-actions.ts`,
`AGENT_TOOLS`), or in `RPC_TOOLS` (`server/agent-parity.ts`) for tools that mirror one developer RPC. Planned tools
return a dry run and run only with `confirm: true` and the plan id. `PARITY` maps every client RPC to its tools.

**Who acted** (`shared/actor.ts`): an agent tool runs the same handler as the developer's click, but it is never the
developer's action. `AgentActions.runRpc` hands every RPC the acting agent (id and title) through the worker's RPC
bridge (`context.actor`); a call without one came from the app. Handlers read `actorOf(context)` and record it: the
inbox ledger (`by: "agent:<id>"`, never `"developer"`), a brief's `answeredBy`/`answeredByTitle`, a question's answer
(`by: "agent"`, `agentId`), the spec link (`source: "agent"`), linked items (`by`), and `inbox_act` notes each row it
touched. A card answer an agent sends carries "Answered by <agent> (agent <id>) for the developer." so the receiving
agent, its chat card ("<agent>'s answer"), Recent steps ("Answer from <agent>") and the classifier never read it as
the developer's; it never clears a Needs-you flag and never passes the Overseer's new-workspace gate. Invariant
`only-developer-acts-as-developer` (`actorViolations`, `tests/agent-actor.test.ts`).

| Tool | Mirrors | Kind |
| --- | --- | --- |
| `list_prs` | `follow.list`, `follow.get` | read |
| `workspace_cards`, `card_action` | `follow.cards`, `follow.card-act` | read / planned: what agents show in a workspace's view, and its ⋯ menu ([cards.md](cards.md)) |
| `add_reviewers` | `follow.request-reviewers` | planned |
| `merge`, `enable_merge_when_ready`, `disable_merge_when_ready` | `follow.prepare-pr-action`, `follow.confirm-pr-action` | planned |
| `send_repairs` | `follow.send` | write |
| `set_auto_send`, `clear_hold`, `retry_batch` | `follow.control` | write. `set_auto_send` with `task` is the task sheet's Auto-send switch (`taskAuto`); `retry_batch` with `task` is a capped task's Retry (`retryTask`). |
| `snooze_workspace` | `follow.control` (`snooze`) | planned; Later and Bring back now on a workspace-only Needs-you row |
| `make_main_agent` | `follow.control` (`mainAgentId`) | planned; claim rules in `checkMainClaim` |
| `track` | `follow.activate` (`engine.activate`): follow a workspace again after an opt-out | write |
| `refresh` | `follow.refresh` | write (cheap) |
| `run_recovery` | `follow.recover` | planned |
| `workspace_about` | `follow.workspace-about` | read (writes a Summary when none is cached) |
| `agent_settings`, `set_agent_setting`, `set_wait_for_jobs` | `follow.agent-settings`, `follow.set-agent-setting`, `follow.set-wait` | read / planned |
| `display_settings`, `set_display` | the host's `settings.display` document, Home's order (`home_sort`), how its list is arranged (`home_view`: grouping, title, show, filters), Home's right pane width (`home_detail_fraction`), Catch up's queue rail width (`catch_up_rail_fraction`) and the search-from-anywhere key (`search_shortcut`) among it | read / planned |
| `follow_settings`, `set_follow_settings` | `follow.follow-settings`, `follow.set-follow-settings` | read / planned |
| `project_settings`, `set_project_tracking` | `follow.project-settings`, `follow.set-project-tracking` | read / planned |
| `pr_workflow`, `set_pr_workflow` | `follow.pr-workflow`, `follow.set-pr-workflow` | read / planned |
| `pr_stats` | `follow.pr-stats` | read: one repository's PR statistics for a period (people, team numbers, PRs waiting for a first review now with their urls), a person's drill-down with `person`, and `fresh: true` for one sync first ([pr-stats.md](pr-stats.md)) |
| `pr_stats_settings`, `set_pr_stats` | `follow.pr-stats-settings`, `follow.set-pr-stats` | read / planned: Settings → Following → PR statistics; turning a repository on shows the estimate (`estimate: true`) as the dry run's `before` |
| `reviewer_settings`, `reviewer_suggestions`, `save_reviewers` | `follow.reviewer-settings`, `follow.reviewer-suggestions`, `follow.save-reviewers` | read / planned |
| `onboarding_status`, `onboarding_checks`, `set_onboarding` | `follow.onboarding`, `follow.onboarding-checks`, `follow.set-onboarding` | read / planned |
| `priorities`, `set_priorities` | `follow.priorities` | read / planned |
| `rank_status`, `rerank_priorities` | `follow.rank-status`, `follow.rank-now` | read / planned |
| `usage` | `follow.usage` | read |
| `overseer_status`, `overseer_start`, `overseer_restart`, `overseer_ask` | `follow.overseer-status`, `follow.overseer-start`, `follow.overseer-restart`, `follow.overseer-ask` | read / planned |
| `inbox_list`, `inbox_brief` | `follow.inbox-list`, `follow.inbox-brief` | read (`inbox_list` rows carry `prs`: each PR the row is about, with its url) |
| `sign_off`, `snooze`, `set_finish_flags`, `inbox_act` | `follow.inbox-act` | planned; other agents only |
| `brief_action` | `follow.brief-action` | planned; never your own brief |
| `queue_list` | `follow.queue-list` | read: the message queue per workspace or agent (state, why it waits, next try), plus the newest sent |
| `queue_action` | `follow.queue-action` | planned: retry a queued or failed message now, or cancel it (a card's Retry, Needs you's message row) |
| `dismiss_item` | `follow.dismiss` | planned; the small x on any Needs-you item for the developer: `{ workspaceId, key }` (an item's key, `question:Qn` included) or `{ agentId }` for another agent's turn-end brief, or `{ issue }` for a Nobody's-on-it row (an issue with no workspace: raised to Urgent or High in the queue, or an urgent Compass ask; it takes both), or `{ compass }` for one Compass suggestion by note id. Sends no agent anything (`dismissing-anything-in-needs-you-sends-the-agent-nothing`); `undo: true` brings it back. Refused for your own brief or question, and for your own workspace's items. |
| `dismiss_question` | `follow.dismiss-question` | planned; the question-only alias of `dismiss_item` (`key: "question:Qn"`). Dismisses another agent's question for the developer and sends that agent nothing (`dismissing-a-question-sends-the-agent-nothing`); `undo: true` reopens it. Refused for a question you asked or own: that is `withdraw_question`. |
| `answer_question` | `follow.answer-question` | planned; never your own question. The tool sends; the UI's Copy and Put in chat (`action: "copy" \| "chat"`) only move the developer's own words into their clipboard or composer, so they have no tool (`server/agent-parity.ts`). |
| `set_workspace_spec` | `follow.workspace-spec` | planned |
| `set_task_trigger` | `follow.set-task-trigger` | planned |
| `ai_rename` | `follow.rename-status` (the dry run: name now, suggestion, undoable rename), `follow.rename-workspace` (rename or `undo`) | planned. `title` skips the model; `undo=true` restores the name before the last rename for 24 h. |
| `dispatch` | `follow.dispatch-preview` (the dry run: source, action, project and why, base, branch, agent, the exact instructions), `follow.dispatch` (confirm) | planned. Dispatch's start from a Linear key or link, a GitHub issue or PR link, another link or words; confirm is refused when the instructions changed since the dry run ([dispatch.md](dispatch.md)). |
| `dispatch_sources`, `dispatch_records` | `follow.dispatch-sources` (open Linear issues, or `query` to search, plus the latest starts), `follow.dispatch-records` (the last 50) | read |
| `pin_workspace` | Paseo's `setPinned` on the workspace (the same pin as Paseo's sidebar) | planned. Pin to top or Unpin, as the row menu does |
| `dispatch_undo` | `follow.dispatch-undo` | planned. Cancels a start still waiting for Paseo, or archives what it created within 10 minutes. |
| `dispatch_actions`, `set_dispatch_actions` | `follow.dispatch-actions`, `follow.set-dispatch-actions` (upsert, move, hide, reset, delete, reset-all) | read / planned |
| `dispatch_settings`, `set_dispatch_settings` | `follow.dispatch-settings`, `follow.set-dispatch-settings` (team rules, bases, the no-team rule) | read / planned |
| `linear_queue` | `follow.linear-queue` | read: the Morning brief's queue by priority (`filter` all, no-workspace, changed; `limit`), each issue's workspace or none and its change, the changes since the developer last read the brief (or `since`), and the sweep's time and health. The brief's own read (`open: true`, not on the tool) marks the read "since" stands on ([morning-brief.md](morning-brief.md)). |
| `sweep_queue` | `follow.sweep-queue` | planned: sweeps every page now (Sweep now) and returns the summary, or `running` past 45 s. The queue screen's button passes `wait: false` and gets `running` at once, then polls `follow.linear-queue`. |
| `brief_settings`, `set_brief_settings` | `follow.brief-settings`, `follow.set-brief-settings` | read / planned: the brief's own settings (Settings → Compass → When): sweep time, `since` (read or workday), time zone and workdays, and the zone and week in use; the read includes the queue's settings and the plan. The queue's states and the chat and calendar windows are `set_compass` `queue` (the RPC still takes them, for Settings). |
| `brief_plan`, `set_brief_plan` | `follow.brief-plan`, `follow.set-brief-plan` | read / planned, aliases of `compass`'s `plan` and `set_compass` `plan` for one minor release: this week's plan. Mode (compass, link, off; "auto" reads as compass), replace-when-newer, `find` (read the sources that post the plan now); the link in use and where it came from (env, link, found: from a Compass source, previous), the sources that post it, the last read. A change naming a person or channels is refused: who posts the plan is a Compass source. `brief_plan {link}` reads that link's title first, and is `set_brief_plan`'s dry run. |
| `brief_sources`, `set_brief_sources` | `follow.brief-sources`, `follow.set-brief-sources` | read / planned, aliases of `compass`'s `inputs` and `set_compass` `inputs` for one minor release: the built-in inputs. Every mcpproxy server matched by its tools (a recipe's source, one with no recipe yet, one with no read tools) plus GitHub and Paseo, with health (ok, sign-in, failed, off), what each adds, its cost and whether it's on. `check` asks mcpproxy again (Settings sends it on open). The change turns sources on or off (`on: {id: bool}`; an Ask source only after a preview under 24 h old), Retries one (`retry`), checks again (`check`) or previews an Ask source (`preview`: one ask, nothing turned on); a check, Retry or preview runs after the reply and the read says `checking` / `retrying` / `previewing`. |
| `brief_chat_search` | `follow.brief-chat-search` | read, an alias of `compass_find` for one minor release: people or channels from the chat tool's own search. |
| `compass`, `compass_find` | `follow.compass` (`workspace` narrows the notes and adds its AI priority rank and the Overseer's agent), `follow.compass-find` (`kind` people, channels, docs, file, trackers or calendars, `query`) | read: Compass ([compass.md](compass.md)). Its sources, glossary, presets the connected tools allow, each place's last read, the live notes and `blocked` (why Compass doesn't read: Summaries on a provider with no guard); without `workspace`, also `plan`, `inputs` and `brief` (every priority input, invariant 108). `compass_find` lists people and conversations from the chat tool's own search, pages from the docs tool's, a local Markdown or text file it checked, tracker scopes (the Linear queue's projects and milestones, a GitHub repository's labels and milestones) and calendars, each with the place `set_compass` takes: the only way an agent learns a place id. |
| `set_compass`, `read_compass` | `follow.set-compass`, `follow.read-compass` | planned: add, edit or remove a source (who, places, roles, How to read this), the global reading notes, the glossary and expiry, `plan`, `inputs` and `queue` (one change for every priority input); Read now (waits up to 30 s, then `running`). The dry run shows Compass as it is now. |
| `compass_note` | `follow.compass-note` (`action` pin, edit, unpin or tell; `id`, `workspace`, `what`, `until`, `strength`) | planned: change one Compass note or tell its workspace's main agent (one queued message, invariant 107). The dry run is `compass` for the workspace. Returns the view and `told` (the agent told). |
| `why_suggested` | `follow.why-suggested` (`workspace`, `issue` or `note`) | read: the Compass notes behind it, each with its quote, who, when, source, role, strength, until and how it matched, and `needsYou` (Compass doesn't add Needs you rows yet). |
| `link_items`, `set_linked_items` | `follow.linked-items`, `follow.set-linked-items` (add, remove, undo) | read / planned. The Linked sheet calls both; `link_item` and `unlink_item` also count for `follow.set-linked-items`. |
| `link_items` (per workspace) | `follow.linked-index` | read. Home's search over every workspace's linked keys and titles, fetched only while the search field has text. |
| `pr_controls`, `browser_status` | `follow.pr-control-status`, `follow.browser-status` | read |
| `release_notes` | `follow.release-notes` | read (notes since `previous` in full, older ones bounded: `older`, `offset`/`limit`) |
| `updates_status`, `check_updates` | `follow.updates` | read / write (no plan) |
| `set_updates`, `install_update` | `follow.set-updates`, `follow.install-update` | planned ([updates.md](updates.md)) |
| `retry_move` | `follow.retry-move` | planned ([updates.md](updates.md#moving-from-1x)) |
| `report_issue` | `follow.report-issue-targets`, `follow.report-issue-send`, `follow.report-issue-link` | its own dry run and confirm (`SELF_PLANNED_TOOLS`); files a bug, feature request or feedback in Follow-up's repository after the developer's yes. Served to contributors too. [report-issue.md](report-issue.md) |
| `report_send` | `follow.report-issue-send` | planned; hands the developer's report to an agent, a new agent in a workspace or a new workspace, like Report an issue's Send. [report-issue.md](report-issue.md#send-to) |
| `workspace_status` | `follow.created-items` | read. The chat's created-agent / created-workspace cards: live states from the engine's cached directory rows and Follow-up's line for the workspace ([client.md](client.md#created-agent-and-workspace-cards)). |
| `trust_bypass_status` | `follow.trust-bypass` | read |
| `catch_up_deck` | `follow.catch-up-deck` | read. Catch up's deck as Home would deal it (one card per ask, Home's Needs-you order and `home_sort`), each card with its More context ask. Built when read from the worker's own state; the client deals the same deck from Home's model ([needs-you.md](needs-you.md#catch-up)). |
| `context_requests`, `ask_context`, `question_action` | `follow.context-list`, `follow.context-ask`, `follow.question-action` | read / planned / planned. Your questions and More context: `ask_context` asks a workspace's main agent, a named agent (main or contributor of a tracked workspace) or, with `cardKey`, More context about a card (a queued message; it may wake, since the developer asked); never the caller. `context_requests` filters by `state` (all, open, tasks) and `query`. `question_action` is Done, Reply, Make a task or Withdraw, recorded as `agent:<id>`; it never reads an answer for the developer, and the asked agent can't act on its own question. |

Features that change only one person's view (no RPC) are listed in `VIEW_PARITY` with the tools that read the
same data: section search in the panel reads what `workspace_status` and `list_prs` return; Catch up's Skip and Back
move only the developer's view, and `catch_up_deck` reads the deck they move through.

Exempt in `PARITY`, with the reason recorded there:

- `follow.check-pr-action`: the PR sheet's progress poll.
- `follow.whats-new-seen`: a person closing What's new.
- `follow.dismiss-update-notice`: a person hiding Home's update line.

### Bounded answers

History uses `shared/finished.ts` for each kind. A withdrawn or dismissed question is finished without needing an
answer or delivery; a stale task reference cannot make it live again. A closed PR is finished history even without
a disposition, consistently in `workspace_status` and `list_prs`. The workspace completion gate still asks for that
disposition (`settled` in `shared/model.ts`), so paging a PR never declares its work complete. Completed, cancelled
and superseded batches are finished even without settlement timestamps; a blocked batch without settlement or
supersession remains live.

Delivered answers kept as context for unfinished tasks retain their answer, delivery and task link in compact
question records; pending questions and pending deliveries stay whole while they fit. When live evidence exceeds
the budget, every
section keeps its glance and `detail=full live=<kind>` with `offset`/`limit` pages the complete original records.
`live.<kind>` counts the complete records shown and carries the page pointer. If shortened glances still exceed
the budget, each live section keeps a bounded urgent/newest preview and its page pointer instead of failing.
The preview and its full-record pages use the same stable ordering. A page keeps the other sections’
glances and all recent history; `history` and `live` select alternative evidence pages. The budget measures the
final summary after
compaction, or the full reply for `detail=full`, including the handler’s extra fields. Finished-task glances omit
evidence and notes; `history=tasks` pages those records whole.

Every list-returning agent tool answers within `TOOL_BUDGET` (`shared/paged.ts`), however big a workspace's history:
what is live comes whole while it fits, otherwise as glances with live evidence pages; what is finished comes as
the newest `PAGE.recentDone` plus a count (`boundDone`), and
`offset`/`limit` page the rest, newest first, `PAGE.toolPage` a page by default. 2026-11-26: `workspace_status`
summary was ~207k characters in a busy workspace (357 PRs, almost all merged), over a tool result's limit.

| Tool | Whole | Bounded (field) |
| --- | --- | --- |
| `workspace_status` | open PRs, open tasks, live questions and batches, sending PR actions | each finished kind (`history.<kind>`; page one with `history=<kind>`) |
| `list_prs` | open PRs | merged and closed PRs with `include_closed` (`closed`) |
| `inbox_list` | flagged, snoozed, running, signed off today, your own row | quiet rows (`quiet`) |
| `context_requests` | asks still asking | answered, chat and failed asks (`settled`) |
| `release_notes` | notes since `previous` | older notes (`older`) |

`queue_list` (waiting items whole, at most `QUEUE_RECENT` sent ones with their text dropped), `dispatch_records`
(`RECORDS_MAX`), `workstreams` (paged) and `linear_queue` (`limit`) were bounded already. Guarded by
`tests/bounded-tools.test.ts`.

## Overseer tools

Only in the Overseer's session, through `follow.overseer-act` (`server/overseer.ts`, `OVERSEER_TOOLS`):

| Tool | Use |
| --- | --- |
| `workstreams` | Every workspace, grouped as Home groups them. |
| `agent_digest` | One agent's last steps. Reads the transcript on disk when the agent isn't loaded. |
| `route_candidates` | Scores workspaces for an ask. |
| `send_to_agent` | Forwards the developer's words to the agent that owns the work. |
| `start_workspace` | Starts a new workspace as Dispatch's Create PR (an alias of `dispatch`, with the Overseer's new-workspace gate). Dry run, then confirm. |
| `rerank` | Re-ranks Home's Priority sort. |

## Wait tools

`wait_prepare_job`, `wait_for_job` and `wait_get_job` are served natively by `server/wait.ts`, never by the bridge.
See [wait.md](wait.md).

## RPCs without an agent tool

These have no tool because only another component calls them:

| RPC | Caller |
| --- | --- |
| `follow.agent-act`, `follow.overseer-act` | The tool dispatchers above. |
| `follow.activate` | The `track` tool runs the same `engine.activate`; integration scripts call the RPC to track one workspace explicitly. |
| `follow.refine-tasks` | Integration scripts: replace a workspace's task list. |
| `follow.browser-exchange` | The Send to Paseo extension's job exchange ([prs.md](prs.md)). |
| `follow.pr-owner`, `follow.pr-workspaces` | Send to Paseo: who owns a PR, and the read-only browser view of it (each row's `group`, one-line `state` and its `tone`; a closed main agent reads "Needs you · Agent closed"; [prs.md](prs.md#send-to-paseo-browser-companion)). |

## Subscriptions (Paseo 0.16)

On a 0.16 host the client subscribes to these instead of polling the matching reads (invariant
`idle-client-makes-at-most-one-rpc-a-minute`). Each sends its current value first, then only changes. The worker serves
each topic once for all subscribers from state it already holds (`server/feeds.ts`): store saves, its own 15 s ticks,
the inbox's hooks, ranker runs, priority writes and the Display setting's own subscription. An unchanged value pushes
nothing. On 0.15 there is no `client.subscribe`, and the client polls the RPCs as before (`client/feeds.ts`).

| Subscription | Replaces | Fed by |
| --- | --- | --- |
| `follow.workspaces-feed` | `follow.list` every 15 s | Store saves and the engine tick (the revision diff, plus the worker's error) |
| `follow.inbox-feed` | `follow.inbox-list` every 15 s, and its nudge on agent activity | Inbox hooks and actions, and the inbox tick (wake-ups, directory titles) |
| `follow.home-feed` | `follow.priorities`, `follow.rank-status`, `follow.usage` every 60 s, `follow.overseer-status` every 15 s, Re-rank's 3 s loop, Catch up's More context asks (`context`, so an answer arriving needs no poll), whether Home shows the PR stats icon (`prStats`), and the raised Linear issues in Needs you with the queue's revision (`queue`; on 0.15 they ride `follow.priorities`) | A More context ask or answer, priority writes, ranker start and finish, a queue sweep's start and end or a raised issue's dismissal, the inbox tick (the Overseer), and Smart Session's accounts directory, watched only while someone subscribes (`USAGE_WATCH_DEBOUNCE_MS`, 5 s: a burst of writes is one read; the key is the meters as shown). The worker's live resources aren't in it: Home reads `follow.usage` once when it opens. With no directory to watch, `usageLive` is false and the client reads usage every 60 s |
| `follow.display-feed` | the Display settings read every 60 s (sidebar, pills, `home_sort`) | The settings' own subscription |
| `follow.pr-stats-feed` | the PR stats page re-reading on a timer | One per repository on screen: a sync run's end or a stats settings write (`PrStats.onChange`). While subscribed the repository syncs every 5 minutes (`PrStats.watching`); the page re-reads `follow.pr-stats` when the status moves ([pr-stats.md](pr-stats.md#reads-and-the-feed)) |

`follow.browser-status` is read once when a PR sheet, the panel or the pill's popover opens; nothing polls it.

## Client RPCs by surface

| Surface | RPCs |
| --- | --- |
| Home, the workspace view (side panel, tab), pill | `follow.list`, `follow.get`, `follow.activity` (the Activity card's pages, `shared/history.ts`), `follow.control`, `follow.send`, `follow.recover`, `follow.refresh`, `follow.answer-question`, `follow.dismiss`, `follow.workspace-spec`, `follow.set-task-trigger`, `follow.workspace-about`, `follow.rename-status`, `follow.rename-workspace`, `follow.priorities`, `follow.usage`, `follow.rank-status`, `follow.rank-now` |
| Needs-you inbox and brief card | `follow.inbox-list`, `follow.inbox-act`, `follow.inbox-brief`, `follow.brief-action` |
| PR sheet | `follow.pr-control-status`, `follow.prepare-pr-action`, `follow.confirm-pr-action`, `follow.check-pr-action`, `follow.request-reviewers`, `follow.browser-status` |
| Overseer card | `follow.overseer-status`, `follow.overseer-start`, `follow.overseer-restart`, `follow.overseer-ask` |
| Every field whose words reach an agent (pasted images) | `follow.image-support` (asked once per recipient when the first image is added: "<Provider> can't take images; remove them to send."), and `images` on `follow.dispatch`, `follow.overseer-ask`, `follow.context-ask`, `follow.answer-question` and `follow.brief-action` |
| Settings | `follow.follow-settings`, `follow.set-follow-settings`, `follow.project-settings`, `follow.set-project-tracking`, `follow.reviewer-settings`, `follow.save-reviewers`, `follow.reviewer-suggestions`, `follow.agent-settings`, `follow.set-agent-setting`, `follow.set-wait`, `follow.pr-workflow`, `follow.set-pr-workflow`, `follow.trust-bypass` |
| Getting started | `follow.onboarding`, `follow.set-onboarding`, `follow.onboarding-checks` |
| Chat: created agent and workspace cards | `follow.created-items` |
| Agent peek (panel lines, Home rows) | `follow.agent-turn` (an unloaded agent's current turn from its saved transcript, never the daemon; a loaded agent is read through Paseo's own timeline) |
| Report a bug (Settings → General → Help, ⌘K, `/report-issue`, error toasts) | `follow.report-issue-targets`, `follow.report-issue-send`, `follow.report-issue-link` |
| Release notes and updates | `follow.release-notes`, `follow.whats-new-seen`, `follow.updates`, `follow.set-updates`, `follow.install-update`, `follow.retry-move`, `follow.dismiss-update-notice` |

## Pasted images

Every field whose words reach an agent takes pasted images (invariant 97, `every-agent-field-takes-images`; the client
side is [client.md](client.md#pasted-images)). The RPCs behind them take an optional `images` list
(`imageUploadsSchema`, `shared/images.ts`: `{ name, mimeType, data }` with base64 data; PNG, JPEG, GIF or WebP, up to 6,
5 MB each, 20 MB in all, checked again by the file's first bytes on the server):

| RPC | Where the images go |
| --- | --- |
| `follow.dispatch` | With the new agent's first message (`agents.create({ ..., images })`). Kept as files with the dispatch record until the agent is created or the dispatch fails. |
| `follow.answer-question`, `follow.brief-action`, `follow.context-ask` | On the queued message (`queue.json` keeps refs only, `images/` the files); every resend reads the same files; removed once delivered or cancelled. `answer-question` takes them only with `action: "send"`. |
| `follow.overseer-ask` | Straight to the Overseer with the words (the ask isn't queued); never stored. |
| `follow.image-support` | Input `{ target }`: an agent, a workspace (its main agent), the Overseer, or a provider (Dispatch's pick). Output `{ ok, provider, reason }` from `imageSupport` (`server/image-support.ts`), the one rule. |

Agent tools take `images: [<local file path>]` on `dispatch`, `overseer_ask`, `ask_context`, `brief_action` and
`answer_question`. Each path must be a readable regular file (a symlink isn't followed), an image by its first bytes,
under the caps; the dry run refuses the whole call with the reason otherwise, and its plan names each image by name and
size (`images`, never the bytes). Home's reply boxes and Catch up's note send straight through Paseo's own
`agent.send(text, { images })`, as their words already did.
