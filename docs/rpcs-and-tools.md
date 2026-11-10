# RPCs and agent tools

Every RPC lives in `shared/contracts.ts`, and its handler in `index.server.ts`. Agent tools are tuples in
`server/mcp.mjs`: `[name, description, rpc, properties, required]`. `tests/docs.test.ts` fails when an RPC or a tool
is missing from AGENTS.md or docs/, so add a line here when you add one.

## How tools reach an agent

- **Native (Paseo 0.15+).** `server/native-tools.ts` turns the tuples into `AgentToolDefinition`s on
  `request.tools`. Claude sees them as `mcp__paseo__follow_<name>` and Codex as `paseo.follow_<name>`.
  - Each call runs the RPC handler in-process through the `handlers` map, as the caller (`context.agent.id`).
  - `live()` re-checks the caller's role on every call.
  - Details: [native-agent-tools.md](native-agent-tools.md).
- **Stdio bridge (Paseo 0.14, or when the host serves no plugin tools).** `server/session-mcp.ts` adds a per-launch
  MCP server that runs `plugin-data/follow-through/mcp.mjs`. It connects to the daemon as `PASEO_AGENT_ID` and calls
  the same RPCs. The same file is a CLI: `node "$FOLLOW_THROUGH_CLI" list` or `call <tool> '<json>' [--compact]`.
  - There is never a global MCP registration. `server/mcp-registrations.ts` removes the old user-scope one, with a
    `.follow-through-unregister.bak`.
  - `server/agent-mcp.ts` builds the stdio definition.
- **Which tools a session gets** is decided by `toolList()` in `server/mcp.mjs` and `availableTools()` in
  `server/native-tools.ts`:

| Session | Tools |
| --- | --- |
| Tracked main agent | Core tools (below), the action tools, and `needs_you` while the inbox is on. |
| Contributor (another root agent of a tracked workspace) | `workspace_status`, `register_pr`, `sync_workspace`, `link_item`, `unlink_item`, and `make_main_agent` (its claim rules apply). |
| Recovery agent | Core tools except `declare_done`, `sync_workspace`, the question tools, `set_spec`, `link_item` and `unlink_item`. No action tools. |
| Untracked root agent | The action tools, and `needs_you` while the inbox is on. |
| Overseer | `needs_you`, the action tools and the Overseer tools. |
| Subagents | None (Wait still applies: [wait.md](wait.md)). |
| Any interactive Claude session | `wait_prepare_job`, `wait_for_job`, `wait_get_job` while Wait is on. |

- **Recognising tool calls in chat.** `shared/chat.ts` recognises Follow-up's tool calls in every spelling (native,
  bridge, CLI). `client/chat.tsx` renders them as compact rows.
- **Read-only and destructive tools.** `readOnlyTools` and `destructiveTools` in `server/mcp.mjs` mark tools
  read-only or destructive. `merge` is the only destructive one.

## Core tools (the workspace's own bookkeeping)

| Tool | RPC | Use |
| --- | --- | --- |
| `workspace_status` | `follow.agent-status` | The workspace's goal, PRs, tasks and work queue. `detail=full` adds history. Includes the PR workflow. |
| `sync_workspace` | `follow.sync` | Confirms the sidebar matches the work. The Stop hook asks for it after code-changing turns. |
| `enroll_workspace` | `follow.enroll` | Refines the goal of a workspace the developer activated. |
| `register_pr` | `follow.register-pr` | Registers a submitted PR and its stack and parent. |
| `exclude_stack` | `follow.exclude-stack` | Removes a wrongly registered stack, with an audit (`server/exclusions.ts`). |
| `update_obligation` | `follow.obligation` | Creates or updates a task (an obligation), with an optional trigger and communication receipt. |
| `acknowledge_batch` | `follow.acknowledge` | Records a repair batch's result: completed or blocked. |
| `ask_question`, `record_answer`, `withdraw_question` | `follow.ask-question`, `follow.record-answer`, `follow.withdraw-question` | Questions for the developer (`server/questions.ts`). |
| `set_spec` | `follow.set-spec` | The agent's spec link. The developer's own link wins over it. |
| `link_item`, `unlink_item` | `follow.link-item`, `follow.unlink-item` | Links what the work is about (a Linear key is confirmed with Linear first; a PR is refused), or removes one for good ([linked-items.md](linked-items.md)). Main and contributors. |
| `needs_you` | `follow.needs-you` | The end-of-turn brief: what the developer must do next. |
| `declare_done` | `follow.done` | Declares the goal fulfilled and returns any blockers. |

## Action tools (agent parity)

All of these go through `follow.agent-act`. The handlers are in `AgentActions` (`server/agent-actions.ts`,
`AGENT_TOOLS`), or in `RPC_TOOLS` (`server/agent-parity.ts`) for tools that mirror one developer RPC. Planned tools
return a dry run and run only with `confirm: true` and the plan id. `PARITY` maps every client RPC to its tools.

| Tool | Mirrors | Kind |
| --- | --- | --- |
| `list_prs` | `follow.list`, `follow.get` | read |
| `add_reviewers` | `follow.request-reviewers` | planned |
| `merge`, `enable_merge_when_ready`, `disable_merge_when_ready` | `follow.prepare-pr-action`, `follow.confirm-pr-action` | planned |
| `send_repairs` | `follow.send` | write |
| `set_auto_send`, `clear_hold`, `retry_batch` | `follow.control` | write |
| `snooze_workspace` | `follow.control` (`snooze`) | planned; Later and Bring back now on a workspace-only Needs-you row |
| `make_main_agent` | `follow.control` (`mainAgentId`) | planned; claim rules in `checkMainClaim` |
| `track` | `follow.activate` (`engine.activate`): follow a workspace again after an opt-out | write |
| `refresh` | `follow.refresh` | write (cheap) |
| `run_recovery` | `follow.recover` | planned |
| `workspace_about` | `follow.workspace-about` | read (writes a Summary when none is cached) |
| `agent_settings`, `set_agent_setting`, `set_wait_for_jobs` | `follow.agent-settings`, `follow.set-agent-setting`, `follow.set-wait` | read / planned |
| `display_settings`, `set_display` | the host's `settings.display` document | read / planned |
| `follow_settings`, `set_follow_settings` | `follow.follow-settings`, `follow.set-follow-settings` | read / planned |
| `project_settings`, `set_project_tracking` | `follow.project-settings`, `follow.set-project-tracking` | read / planned |
| `pr_workflow`, `set_pr_workflow` | `follow.pr-workflow`, `follow.set-pr-workflow` | read / planned |
| `reviewer_settings`, `reviewer_suggestions`, `save_reviewers` | `follow.reviewer-settings`, `follow.reviewer-suggestions`, `follow.save-reviewers` | read / planned |
| `onboarding_status`, `onboarding_checks`, `set_onboarding` | `follow.onboarding`, `follow.onboarding-checks`, `follow.set-onboarding` | read / planned |
| `priorities`, `set_priorities` | `follow.priorities` | read / planned |
| `rank_status`, `rerank_priorities` | `follow.rank-status`, `follow.rank-now` | read / planned |
| `usage` | `follow.usage` | read |
| `overseer_status`, `overseer_start`, `overseer_restart`, `overseer_ask` | `follow.overseer-status`, `follow.overseer-start`, `follow.overseer-restart`, `follow.overseer-ask` | read / planned |
| `inbox_list`, `inbox_brief` | `follow.inbox-list`, `follow.inbox-brief` | read |
| `sign_off`, `snooze`, `set_finish_flags`, `inbox_act` | `follow.inbox-act` | planned; other agents only |
| `brief_action` | `follow.brief-action` | planned; never your own brief |
| `answer_question` | `follow.answer-question` | planned; never your own question |
| `set_workspace_spec` | `follow.workspace-spec` | planned |
| `set_task_trigger` | `follow.set-task-trigger` | planned |
| `link_items`, `set_linked_items` | `follow.linked-items`, `follow.set-linked-items` (add, remove, undo) | read / planned. Their `PARITY` rows land with the UI that calls them. |
| `pr_controls`, `browser_status` | `follow.pr-control-status`, `follow.browser-status` | read |
| `release_notes` | `follow.release-notes` | read |
| `updates_status`, `check_updates` | `follow.updates` | read / write (no plan) |
| `set_updates`, `install_update` | `follow.set-updates`, `follow.install-update` | planned ([updates.md](updates.md)) |
| `trust_bypass_status` | `follow.trust-bypass` | read |

Exempt in `PARITY`, with the reason recorded there:

- `follow.check-pr-action`: the PR sheet's progress poll.
- `follow.whats-new-seen`: a person closing What's new.
- `follow.dismiss-update-notice`: a person hiding Home's update line.

## Overseer tools

Only in the Overseer's session, through `follow.overseer-act` (`server/overseer.ts`, `OVERSEER_TOOLS`):

| Tool | Use |
| --- | --- |
| `workstreams` | Every workspace, grouped as Home groups them. |
| `agent_digest` | One agent's last steps. Reads the transcript on disk when the agent isn't loaded. |
| `route_candidates` | Scores workspaces for an ask. |
| `send_to_agent` | Forwards the developer's words to the agent that owns the work. |
| `start_workspace` | Starts a new workspace. Dry run, then confirm. |
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
| `follow.pr-owner`, `follow.pr-workspaces` | Send to Paseo: who owns a PR, and the read-only browser view of it. |

## Client RPCs by surface

| Surface | RPCs |
| --- | --- |
| Home, panel, larger view, pill | `follow.list`, `follow.get`, `follow.control`, `follow.send`, `follow.recover`, `follow.refresh`, `follow.answer-question`, `follow.workspace-spec`, `follow.set-task-trigger`, `follow.workspace-about`, `follow.priorities`, `follow.usage`, `follow.rank-status`, `follow.rank-now` |
| Needs-you inbox and brief card | `follow.inbox-list`, `follow.inbox-act`, `follow.inbox-brief`, `follow.brief-action` |
| PR sheet | `follow.pr-control-status`, `follow.prepare-pr-action`, `follow.confirm-pr-action`, `follow.check-pr-action`, `follow.request-reviewers`, `follow.browser-status` |
| Overseer card | `follow.overseer-status`, `follow.overseer-start`, `follow.overseer-restart`, `follow.overseer-ask` |
| Settings | `follow.follow-settings`, `follow.set-follow-settings`, `follow.project-settings`, `follow.set-project-tracking`, `follow.reviewer-settings`, `follow.save-reviewers`, `follow.reviewer-suggestions`, `follow.agent-settings`, `follow.set-agent-setting`, `follow.set-wait`, `follow.pr-workflow`, `follow.set-pr-workflow`, `follow.trust-bypass` |
| Getting started | `follow.onboarding`, `follow.set-onboarding`, `follow.onboarding-checks` |
| Release notes and updates | `follow.release-notes`, `follow.whats-new-seen`, `follow.updates`, `follow.set-updates`, `follow.install-update`, `follow.dismiss-update-notice` |
