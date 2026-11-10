# Needs you: the inbox, the brief and Home

## The inbox (beta; on by default, Settings → Display `enable_inbox`)

- **One flag per root agent.** It clears only when the developer signs it off or writes to the agent, or when another
  agent signs it off on the developer's behalf (`sign_off`, which counts as a sign-off, not as writing). Opening a
  workspace, reading it, or Paseo's unread dot never clears it, and an agent can't clear its own flag.
- **Run state is the last turn's, not an outside fact.** `error` and `paused` (`RUN_STATE_REASONS`) describe the
  agent's last turn, so a newer turn start from anyone (the developer, another agent, the host resuming it) drops
  them, along with an open card that only reported them (`briefStep` `turn_start`, unless it has open questions). A
  new failure flags again. Outside facts (permission by request, ci, review, reviewers, pr_closed) and a finish with
  its ask stay until handled. Rows apply `liveFlag` with the turn start the worker saw (`turnStartedAt`), so a running
  agent never headlines an Error or Paused from before its current turn (`rowViolations`, invariant
  `running-is-not-stale`). Status alone isn't enough: Paseo can still read "running" right after a turn fails, and that
  failure is real news. And `Inbox.start` drops such flags for agents already running
  after a restart (a 0.16 host resumes them; on 0.15 the agent stopped, and the flag stays).
- **Background work is running (Paseo 0.16).** An agent that started a shell or task and ended its turn reports
  `backgroundWork.count > 0`. The inbox's directory reads it as running (`liveStatus` in `shared/agent-load.ts`), so a
  plain finish doesn't flag (F7's settle sees "running"), its row sits in Running with `backgroundWork`, and
  `liveFlag` hides an older "finished" until the work ends (shown again after, not erased). Invariant
  `background-work-is-running` in `rowViolations`. On 0.15 the field is absent and nothing changes.
- **Pure logic** is in `shared/inbox.ts`: the reducer, `REASONS` in urgency order (permission, error, paused, ci,
  review, reviewers, finished, pr_closed), snoozes (`next-event`, an ISO time, or `pr:<repo#n>`), finish flags, and
  undo. Undo covers the last sign-off or Later: a Later's undo puts back the snooze it replaced, unless a flag broke
  that snooze since. The Undo bar and the pill say which one it was ("Signed off", "Later · until 09:00").
- **Storage and loop.** `server/inbox.ts` stores `inbox.json` (`InboxStore`). `Inbox` turns lifecycle events into
  reducer events (`turnStarted`, `turnEnded`, `permissionRequested`…). `tick()` runs every 15 s from `inboxLoop`
  in `index.server.ts`.
- **Who wrote a message** (`shared/message-sender.ts`): the one classifier for user-role text. Paseo delivers more
  than the developer's words as user messages, so nothing may treat "user role" as "the developer" without it.
  `messageSender(text)` returns:
  - `agent`: a `<paseo-system kind="agent-message">` or `kind="agent-notification"` envelope (one or several), with
    the source agent's id and title, the event (`message`, `finished`, `errored`, `permission-required`, `closed`)
    and the body unescaped and stripped (a notification's `<agent-response>` reply when it has one).
  - `follow-up`: Follow-up's batch (`Follow-through batch`, legacy `Workspace follow-through batch`), recovery
    (`Follow-through recovery`), answer (`Follow-up answer`), or its provider hook's feedback (`what: "hook"`,
    `HOOK_TEXT_PREFIXES`): Claude Code records the Stop-hook bookkeeping nudge as an isMeta
    `Stop hook feedback:` line (Paseo's timeline drops it, the transcript keeps it), Codex as a
    `<hook_prompt hook_run_id="stop:…">` user message. `workItems` drops that feedback and everything the agent did in
    answer to it, up to the next prompt from anyone else; Recent steps, Summary and the Finished reason read only
    `workItems`. Because Paseo hides Claude's hook line, the Stop hook saves the reply it interrupted
    (`hook-state/bookkeeping-<agent>.json`) and the Finished reason uses it (`finishedReply`). An answer is usually the developer's click, which only
    the delivery ledger can tell (`ledgerSender`).
  - `overseer-forward`: `From the developer via Overseer:` or the legacy `From Tom via Overseer:` (`FORWARD_PREFIXES`),
    prefix stripped. It counts as the developer only through the ledger (the forwarded-message rule).
  - `system`: Paseo's bare `<paseo-system>` (schedule fires) and unknown kinds, and the harness's wrappers (a text that
    opens and closes with a tag, AGENTS.md instructions, command caveats).
  - `developer`: everything else, including Paseo's `kind="user-message"` quoting envelope.

  Call sites: Recent steps and the Overseer's digest (`tailSteps`, `transcriptSteps`), Summary inputs (`tailLines`,
  `readTranscript`), discovery's goal (`extractHistory`), linked items (`timelineRefs`), Needs-you clearing (`classify`)
  and the Overseer's new-workspace gate (`lastDeveloperMessage`). Only `developer` shows as "You"; others show as
  "From <agent>", "<agent> finished", "Follow-up batch" or "You, via Overseer", never with the raw envelope
  (`senderViolations` in `shared/status-invariants.ts`, `tests/message-sender.test.ts`). Follow-up's own words never
  read as work: `followUpTextViolations` (`no-follow-up-text-as-work`, `tests/follow-up-text.test.ts`).
- **Who started a turn** (`server/inbox-classifier.ts`):
  - The text's sender comes first: an agent envelope is `agent` and a Paseo system prompt is `system`, whatever the
    ledger says.
  - Then checks known senders in order: Follow-up's own sends (the delivery ledger, through `onBeforeSend`), Defer's
    queue, Smart Session compactions, Session Guard and Paseo schedules.
  - `turnPrompt` reads the prompt from the timeline tail. Paseo 0.15 projects another agent's message as an
    `agent_message` tool call and a schedule or heartbeat as a `heartbeat` tool call; only the developer's own words
    stay a user message.
  - A seen user message from no known sender counts as the developer (`tom`). A prompt that wasn't seen is `unknown`,
    never the developer.
  - Every reader is read-only and fails open.
- **Daemon view.** `server/inbox-directory.ts` gives the inbox the shared `DaemonDirectory`. The inbox never lists
  agents itself and never wakes one.
- **First run and restart checks** read only Paseo's agent list. Activity is unread time or the developer's last
  message, never `updatedAt`, and they never fetch timelines. Closed and archived agents are never imported.
- **Signing off** also clears Paseo's own unread dot.
- **Agent actions** apply to other agents only and are logged in the ledger as `agent:<id>`, so they never count
  as the developer writing. All are planned: the first call returns a plan, and the second with
  `confirm: true, planId` acts. Get agent ids from `inbox_list`.

| Tool | Input |
| --- | --- |
| `inbox_list` | `{ flagged_only? }` |
| `sign_off` | `{ agentIds }` |
| `snooze` | `{ agentIds, until }`: `next-event`, `1h`, `tonight`, `tomorrow`, `pr:<repo#n>` or an ISO time, stored as a time by `resolveUntil` |
| `set_finish_flags` | `{ agentIds, value }`: whether finished turns flag them |
| `snooze_workspace` | `{ workspace, until }` or `{ workspace, bring_back: true }`: Later on a workspace-only Needs-you row (below) |
| `inbox_act` | `{ action, agentIds, muteTurn? }`, where `action` is `undo` (the last sign-off or Later), `unsnooze` (Bring back now: ends a Later early), `mute_turn`, `unsorted_flag`, `unsorted_sign_off` or `batch_undo` |

- **Workspace Later.** A workspace-only Needs-you row (a hold, repairs to send, a question with no agent flag) has no
  inbox flag to snooze. Its Later (row menu, `snooze_workspace`, `follow.control` `snooze`) sets `Workspace.snooze`
  over the needs it covers (`needKey`). `workspaceSnoozed()` in `shared/attention.ts` keeps the row in Later until the time passes or a new need
  appears; Bring back now clears it. Every count (the header dot, the pill, Home) goes through `activeNeeds()`, so none
  counts a workspace in Later; the panel's card stays, reading "Later until …". The Undo bar undoes it like an agent's Later. Invariant `snooze-can-wake`.
- **A workspace Later under an agent flag.** If the main agent raises a flag while the workspace's own items are in
  Later, the agent's row shows and the workspace Later stays: it covers the workspace's items, which the flag doesn't
  change, and the developer chose its time. The agent's pane lists it under the agent's own Later, one row each
  ("This agent · Back at 22:19", "Workspace items · Back at 23:18"), each with its own Bring back now. After the flag is signed off, the workspace row is back in Later until its time or a new item.
- **Times.** The row menu resolves "Tonight 18:00" and "Tomorrow 09:00" on the device that picks them. An agent tool's
  `tonight`/`tomorrow` resolves on the daemon, in the timezone the developer's Follow-up client last reported
  (`follow.client-time-zone`, kept in `client-time-zone.json`); before any client has reported, the host's clock.
- **What Later looks like.** A Later row's time column says when it comes back ("in 25m", "in 2h", "18:00",
  "tomorrow 09:00", "next event"; `wakeShort`), and its accessible label adds how long it has waited. In the detail
  pane the header reads "Later until …", the body says when it's back ("Back at 22:19") next to Bring back now, and the
  attention card goes quiet like the row: no attention colour, labelled "Later", no age. Bring back now moves focus to the pane's Sign off; Undo moves it to the restored row. The Undo bar waits
  while its Undo has focus or the pointer and resumes with at least 2 s, and Escape closes it.

## The brief and `needs_you`

- **What the brief is.** The brief (`shared/brief.ts`) is one card appended to an agent's timeline when it needs
  the developer. `pickBrief` chooses its content by precedence: permission, paused, error, the agent's `needs_you`,
  Follow-up's PR state, extraction. It never invents an ask. States: open, answered, signed, superseded.
- **`needs_you`** (`follow.needs-you`) is the agent's end-of-turn statement.
  - **Point, don't restate.** To refer to questions already open, pass `questions: ["Qn"]` instead of restating
    them as decisions.
  - **Same turn.** A later call in the same turn replaces only the questions the earlier call created.
  - **Superseded briefs.** A superseded brief never closes a question asked with `ask_question`. Dedupe rules are in
    [workspaces.md](workspaces.md#questions). The bridge records it in
  `hook-state/needs-you-<agent>.json`.
  - The Stop hook nudges a root Claude session that ended a turn without calling it, once per turn (Settings →
    Display `enable_brief_nudge`).
  - `NEEDS_YOU_INSTRUCTION` in `shared/brief.ts` must match `needsYouInstruction` in `server/mcp.mjs`; a test
    checks this.
- **Only the developer answers a card.** A turn the developer didn't start leaves the card open, and only a newer
  brief supersedes it. While a linked question is open on the server, nothing but a developer reply, pick or sign-off
  closes its card. The invariant is `brief-follows-questions` (`shouldReopen` in `shared/brief.ts`,
  `shared/status-invariants.ts`).
- **Every row shows its own lines.** Home and Paseo 0.16's sidebar view render the same model, so a
  line on one agent's row never comes from another row of its workspace. The invariant is `row-lines-own-row`
  (`homeViolations`); [ai-roles.md](ai-roles.md#priority-ranker-beta) covers priority reasons.
- **Answering the brief.** The card's moves go through `follow.brief-action`: pick an option, several picks, or
  Retry. Each sends one message as the developer and is logged as such. Picks that answer stored questions become
  those questions' answers.
- **Shared state file.** `brief.json` tells the bridge and the hook whether the inbox and the nudge are on.
- **The headline.** `shared/headline.ts` is the one precedence for "what does this agent need", shared by the pill,
  the brief card header and the Needs-you rows, so they never disagree.

## Home

- **Grouping** (`shared/home.ts`): every workstream in one list, grouped by what it needs (`HOME_GROUPS`: needs,
  fixing, running, waiting, later, quiet). A tracked workspace's group comes from `trackedGroup`, which reads the
  status model ([workspaces.md](workspaces.md#status-model)).
- **Search, sort and colour:**
  - `shared/search.ts`: the client-side omnibox index.
  - `shared/sort.ts`: Priority, Recent, Oldest waiting, Name, By project. Sorting applies within each group.
  - `shared/attention.ts`: one colour language for the stack bar, rail nodes and overview bars.
- **Client:** `client/home.tsx`, `client/home-list.tsx`, `client/home-chrome.tsx`, `client/home-view.ts`,
  `client/home-data.ts` ([client.md](client.md)).
- **The Overseer** is pinned on Home. Its own inbox row (`overseer`) stays out of every count
  ([ai-roles.md](ai-roles.md)).
- **Priority sort** reads `follow.priorities` ([ai-roles.md](ai-roles.md)).

Tests: `tests/inbox.test.ts`, `tests/brief.test.ts`, `tests/decision-card.test.ts`, `tests/home.test.ts`,
`tests/home-beta2.test.ts`, `tests/attention.test.ts`.
