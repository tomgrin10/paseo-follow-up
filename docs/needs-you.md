# Needs you: the inbox, the brief and Home

## The inbox (beta; on by default, Settings → Display `enable_inbox`)

- **One flag per root agent.** It clears only when the developer signs it off or writes to the agent, or when another
  agent signs it off on the developer's behalf (`sign_off`, which counts as a sign-off, not as writing). Opening a
  workspace, reading it, or Paseo's unread dot never clears it, and an agent can't clear its own flag.
- **Pure logic** is in `shared/inbox.ts`: the reducer, `REASONS` in urgency order (permission, error, paused, ci,
  review, reviewers, finished, pr_closed), snoozes (`next-event`, an ISO time, or `pr:<repo#n>`), finish flags, and
  undo.
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
    (`Follow-through recovery`) or answer (`Follow-up answer`). An answer is usually the developer's click, which only
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
  (`senderViolations` in `shared/status-invariants.ts`, `tests/message-sender.test.ts`).
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
| `snooze` | `{ agentIds, until }`: `next-event`, `1h`, `tomorrow` or an ISO time |
| `set_finish_flags` | `{ agentIds, value }`: whether finished turns flag them |
| `inbox_act` | `{ action, agentIds, muteTurn? }`, where `action` is `undo`, `mute_turn`, `unsorted_flag`, `unsorted_sign_off` or `batch_undo` |

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
- **Answering the brief.** The card's moves go through `follow.brief-action`: pick an option, several picks, or
  Retry. Each sends one message as the developer and is logged as such. Picks that answer stored questions become
  those questions' answers.
- **Shared state file.** `brief.json` tells the bridge and the hook whether the inbox and the nudge are on.
- **The headline.** `shared/headline.ts` is the one precedence for "what does this agent need", shared by the pill,
  the brief card header and the Needs-you rows, so they never disagree.

## Home

- **Grouping** (`shared/home.ts`): every workstream in one list, grouped by what it needs (`HOME_GROUPS`: needs,
  fixing, running, waiting, later, quiet).
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
