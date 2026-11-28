# Needs you: the inbox, the brief and Home

## The inbox (beta; on by default, Settings → Display `enable_inbox`)

- **One flag per root agent.** It clears only when the developer signs it off or writes to the agent, or when another
  agent signs it off on the developer's behalf (`sign_off`, which counts as a sign-off, not as writing). Opening a
  workspace, reading it, or Paseo's unread dot never clears it, and an agent can't clear its own flag.
- **Run state is the last turn's, not an outside fact.** `error` and `paused` (`RUN_STATE_REASONS`) describe the
  agent's last turn, so a newer turn start from anyone (the developer, another agent, the host resuming it) drops
  them, along with an open card that only reported them (`briefStep` `turn_start`, unless it has open questions). A
  new failure flags again. Permission by request, pr_closed, pr_merged and a finish with its ask stay until handled. Rows apply `liveFlag` with the turn start the worker saw (`turnStartedAt`), so a running
  agent never headlines an Error or Paused from before its current turn (`rowViolations`, invariant
  `running-is-not-stale`). Status alone isn't enough: Paseo can still read "running" right after a turn fails, and that
  failure is real news. And `Inbox.start` drops such flags for agents already running
  after a restart (a 0.16 host resumes them; on 0.15 the agent stopped, and the flag stays).
- **PR facts last as long as the fact.** `ci`, `review` and `reviewers` (`FACT_REASONS`) mirror a PR fact Follow-up
  observes. After each PR pass, `liveFacts` (`server/inbox.ts`) lists the facts still live per agent, and a
  `facts_live` event withdraws the rest, with Follow-up's own PR card of that kind (`briefStep` `fact_ended`). An agent
  with a PR Follow-up couldn't read keeps everything (unknown is not off). One predicate, `asksForReviewers`
  (`shared/attention.ts`), decides "Add reviewers" for both the flag and the Needs-you item: an open, non-draft PR with
  no reviewers, in a repository someone is set up to review, that the agent doesn't merge itself. Invariants
  `outside-fact-is-live` (`factFlagViolations`) and `agent-merges-asks-nothing`.
- **In-flight work reads as waiting.** A PR registered with `agentMerges`, or any PR in a No review repository
  (`agentMerges(pr)`, [review mode](prs.md#review-mode)), is the agent's own merge, so it asks the developer for
  neither reviewers nor a merge. A working or waiting task puts the workspace in Waiting (never Quiet),
  and a waiting task is the agent's declared wait: its live line is the task's title, with the waiting icon. Invariant
  `in-flight-reads-waiting`; `tests/in-flight-status.test.ts` enumerates every in-flight signal.
- **Background work is running (Paseo 0.16).** An agent that started a shell or task and ended its turn reports
  `backgroundWork.count > 0`. The inbox's directory reads it as running (`liveStatus` in `shared/agent-load.ts`), so a
  plain finish doesn't flag (F7's settle sees "running"), its row sits in Working with `backgroundWork`, and
  `liveFlag` hides an older "finished" until the work ends (shown again after, not erased). Invariant
  `background-work-is-running` in `rowViolations`. On 0.15 the field is absent and nothing changes.
- **An archived row reopens on live activity** (invariant 111, `shared/reopen.ts`). Archiving an agent or its
  workspace sets the row's `goneAt`, which hides it and every later flag. Paseo unarchives an agent when it is prompted
  and sends no event, so the agent's own activity reopens the row (the `reopen` event, whatever the archive's age; a
  flag from before a 7-day keep that ran out goes): a turn start, a turn end once Paseo shows the agent unarchived (a
  turn the archive itself ended leaves it archived), a `needs_you` call, and the engine reopening the workspace.
  `needs_you` from a workspace Paseo still has archived records the ask, reopens the row so the brief reaches Needs
  you, and says so in its `note` (`ARCHIVED_NEEDS_YOU_NOTE`).
- **Briefs from closed agents** (`flagFate`, invariant `briefs-from-closed-agents`). Home decides at render, from facts
  it already holds, what a flag nobody may be waiting on does; nothing is stored or deleted, so `inbox_list` still lists
  it. A flag **drops** when its workspace is archived (tracked `archived`) or gone from Paseo's workspace list (the row's
  `workspaceTitle` is null) and the agent isn't running, or when a closed agent's flag asks nothing: no brief that
  asks (no open brief, or kind `unknown`/`done`, or source `none`) and no question, and only `finished`, `pr_merged` or
  `pr_closed` reasons. A closed agent's real ask (action, decision, review, an error) with nothing new for 3 days
  (`OLDER_AFTER_MS`) moves to Home's **Older** group, right under Needs you and folded until opened, out of the Needs-you
  count, the sidebar badge and the brief's headline. It comes back the moment the agent runs or idles again, or a new
  flag comes. A running or idle agent's ask always shows, and an Older row whose workspace has a live item (an open
  question, a blocked task) stays in Needs you; a dropped row never hides a workspace item, which the workspace's own
  row then carries. Live on 2026-11-22: 49 flagged rows; 19 drop (16 closed agents that asked nothing, 3 in archived
  or gone workspaces), 13 fold into Older, 17 stay. "Next" follows the same rule: Sign off & next, `/ok next` and the
  Command Center's Next needs-you (`nextAfter`) open only a row Home shows, never a dropped or Older one.
- **Pure logic** is in `shared/inbox.ts`: the reducer, `REASONS` in urgency order (permission, error, paused, ci,
  review, reviewers, finished, pr_closed, pr_merged), snoozes (`next-event`, an ISO time, or `pr:<repo#n>`), finish flags, and
  undo. A registered PR that leaves OPEN (`prEndEvent`, shared by the worker and the invariants) flags `pr_merged`
  ("Merged") when it merged and `pr_closed` ("PR closed") only when it closed unmerged; a flag stored before
  `pr_merged` existed ("#37 merged" under pr_closed) still reads Merged. A merge the agent made itself (register_pr
  `agentMerges`) flags nobody but still wakes a "until this PR merges" snooze. Invariants
  `a-merge-the-agent-made-never-flags-the-developer` and `pr-label-matches-state`. Undo covers the last sign-off or Later: a Later's undo puts back the snooze it replaced, unless a flag broke
  that snooze since. The Undo bar and the pill say which one it was ("Signed off", "Later · until 09:00").
- **A PR flag fires once per transition** (`a-pr-flag-fires-once-per-transition`). Each entry keeps, per tracked
  PR, the state every PR flag kind last notified (`notified`: `end` MERGED/CLOSED, `checks` and `conflict` the head,
  `threads` the thread ids, `reviewers`), read and written through `prNotice`, `notifiedBefore` and `markNotified` in
  `shared/inbox.ts`. A record lives while some workspace tracks the PR and goes with it (`pruneNotified`, only when
  something goes, so a quiet tick copies nothing). The old 200-key ring (`seenKeys`) now holds only Session Guard
  pause keys: in a 153-PR workspace it evicted old merges and re-flagged "#92 merged" two days later (2026-11-13).
  On the first tick after the upgrade (`notifiedAt` unset) the worker records every ended or flagged PR without
  flagging, the same way first-run priming does. `factFlagViolations` flags a merge flag raised more than a day
  after the merge. Guarded by `tests/pr-flags-once.test.ts`.
- **Storage and loop.** `server/inbox.ts` stores `inbox.json` (`InboxStore`). `Inbox` turns lifecycle events into
  reducer events (`turnStarted`, `turnEnded`, `permissionRequested`…). `tick()` runs every 15 s from `inboxLoop`
  in `index.server.ts`.
- **Who wrote a message** (`shared/message-sender.ts`): the one classifier for user-role text. Paseo delivers more
  than the developer's words as user messages, so nothing may treat "user role" as "the developer" without it.
  `messageSender(text)` returns:
  - `agent`: a `<paseo-system kind="agent-message">` or `kind="agent-notification"` envelope (one or several), with
    the source agent's id and title, the event (`message`, `finished`, `errored`, `permission-required`, `closed`)
    and the body unescaped and stripped (a notification's `<agent-response>` reply when it has one).
  - `follow-up`: Follow-up's batch (`Follow-up batch`, legacy `Workspace Follow-up batch`), recovery
    (`Follow-up recovery`), answer (`Follow-up answer`), or its provider hook's feedback (`what: "hook"`,
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
- **PR facts only for a PR the brief references** (`brief-pr-facts-referenced`, `briefFactsViolations` in
  `shared/status-invariants.ts`). A brief that links PRs shows the first linked PR's own state (`BriefSources.prs`,
  from `prStates`); a review that links none shows the agent's newest open PR; nothing else shows any. `factsPr` names
  the PR, and a PR's new state (`facts` step) lands only on a card whose `factsPr` matches. Error briefs show none: a
  failed turn is about the turn, and CI state beside an API error reads as its cause.
- **Done on Action briefs.** An Action brief's one move is Done (`follow.brief-action` `move: "done"`, agent tool
  `brief_action` with `move: done`). The server sends `Done: <ask>` as the developer (ledger `developer`, so the flag
  clears) and collapses the card to `Done · <ask>`. The card collapses at once; `runUndoable` (`client/toast-store.ts`)
  holds the send for the toast's Undo window, since a sent message can't be taken back. With no ToastHost mounted it
  sends at once. Only Action briefs take it; reviews, decisions and failed turns are refused.
  A brief that folded into a task's action card (`isDoneOnly`) answers that card instead: Done sends the card's A
  through `follow.answer-question` (with the note, when one is open), the brief settles when the card does, and no
  `Done: <ask>` goes out beside it. Such a card draws no option rows: Done, Add note and Reply instead (one-ask-one-item).
  During the window the composer pill reads Done and its Undo cancels the same toast (`client/done-windows.ts`, one
  window per agent); Ctrl+Z (Cmd+Z on a Mac) presses the showing toast's Undo, never inside a text field.
- **`needs_you`** (`follow.needs-you`) is the agent's end-of-turn statement.
  - **Point, don't restate.** To refer to questions already open, pass `questions: ["Qn"]` instead of restating
    them as decisions.
  - **Same turn.** A later call in the same turn replaces only the questions the earlier call created.
  - **Superseded briefs.** A superseded brief never closes a question asked with `ask_question`. Dedupe rules are in
    [workspaces.md](workspaces.md#questions). The bridge records it in
  `hook-state/needs-you-<agent>.json`.
  - The Stop hook (Claude Code, Codex) or the turn-end check (every other provider) nudges a root agent that ended a turn without calling it, once per turn (Settings →
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
  those questions' answers. See [Answering a brief](#answering-a-brief).
- **A note on a pick.** A letter can carry the developer's note (`words`), like Something else carries its answer. The
  decision keeps it (`words`), and the message carries it: `briefAnswer` adds "The developer added: …", and
  `briefAnswers` adds a `D1 note: …` line under that decision, which `parseAnswersMessage` reads back for the chat card.
  Both builders live in `shared/brief.ts`. Invariant `a-pick-note-reaches-the-agent` (questions in `INVARIANTS`, brief
  cards in `pickNoteViolations`).

### Answering a brief

`Inbox.briefAction` records the answer and replies; the message goes out through the message queue
([workspaces.md](workspaces.md#the-message-queue)). Recording is the ledger entry and the collapsed brief (`answerId`,
`delivery: { state: "sending" }`), then a queue item (`brief:<agent>:<answerId>`). The reply calls no Paseo: the
item's partition comes from the inbox's cached directory. The card shows the queue's state as it changes (Sending,
Queued with when it retries, Retrying, Failed with **Retry**, Not sent) and clears `delivery` once sent.

- **Why after.** Sending to a dormant agent makes Paseo resume it and wait for its run to start (up to 60 s; 86 s on
  2026-11-11), longer than the 30 s a plugin RPC gets. Awaiting it made the card say "Your answer wasn't sent" for
  answers that arrived, and Retry sent them twice.
- **Never twice.** The client makes one `answerId` per Send and the toast's Retry reuses it, so does the card's
  Retry. The same `answerId` returns the recorded brief (and retries its queue item) instead of a second answer. The
  messageId is derived from it (`stableMessageId`). Paseo does **not** refuse a repeat with the same messageId (it skips
  only the second timeline row; the provider runs the prompt again), so a send that may have left is never repeated
  blind: the queue reads the agent's chat for that messageId first. 2.0's per-answer retry resent a timed-out answer
  that had arrived, so the agent got it twice.
- **Questions too.** `follow.answer-question` records the answer as `sending` and queues it (`Engine.answer`); the
  question shows the same states.
- **A card trusts the live brief, not its row.** A chat card is a timeline row, a snapshot the server re-appends when the
  brief changes (best-effort). `shownBrief` (`shared/brief.ts`) decides what a card shows from `follow.inbox-brief`
  (one query per agent, `liveBriefKey`, only while a row still looks open). A card is actionable only when the live
  brief is that exact brief and open. A row whose brief moved on shows its recorded answer (from the questions it
  points at), "Replaced by a newer card" or "No longer needed · the agent moved on". A resolved card drops a status
  prefix the agent wrote into its ask (`pastAsk`: "Still open: Q35, …"). A card shows a stored question's live, full text; `decisionOf` never
  cuts it.
- **A moot refusal reconciles.** "Already answered", "replaced" and "withdrawn" refusals (`isMoot` in
  `shared/errors.ts`) aren't failures: `runAction`'s `reconcile` refreshes the card instead of offering Retry
  (`tests/stale-brief.test.ts`).
- **Shared state file.** `brief.json` tells the bridge and the hook whether the inbox and the nudge are on.
- **The headline.** `shared/headline.ts` is the one precedence for "what does this agent need", shared by the pill,
  the brief card header and the Needs-you rows, so they never disagree.

## Home

- **Grouping** (`shared/home.ts`): every workstream in one list, grouped by what it needs (`HOME_GROUPS`: needs,
  sending, running, waiting, later, quiet). A tracked workspace's group comes from `trackedGroup`, which reads the
  status model ([workspaces.md](workspaces.md#status-model)).
- **Sending** (Q51, `shared/sending.ts`; it replaced "Follow-up is fixing"): a message out with the agent (send glyph)
  or queued to go out on its own (clock glyph), never Running's spinner. `sendingOf` gives each row its line (count,
  then when and why, never the workspace's or agent's title), and Send now only where the server would take the
  developer's Send and the send doesn't wait on them; a send that waits on the developer is a Needs-you item only
  (invariant `sending-never-waits-on-you`), said once: "Send · You haven't messaged this agent lately, so it waits for you", or with
  Auto off "Send · 2 tasks ready · auto-send is off here", never the row's title. Send now is outlined: filled is only for what waits on the developer.
  A queued message after a send the agent never acknowledged says "no reply to the last message, so they go again";
  a refused send says it tries again shortly. `autoSendHold` is the one machine-wide hold line (the resource
  governor), shown once at the top of Sending and only while it has rows (`HomeModel.hold`), the same words on every
  width, with the memory % only when the reading is current; while it shows, the memory meter keeps its reading and
  drops "· paused". On phones the status strip has its row to itself (the version is a caption at the end of the list). Agents read the same rows: `sending` on
  `workspace_status`, `inbox_list` (on the main agent's row) and `workstreams`; their Send now is `send_repairs`.
- **Search, sort and colour:**
  - `shared/search.ts`: the client-side omnibox index. `rowHit` turns a hit into what the list Row shows (in-place
    highlights, or line 2 as "<Field> · excerpt" for a field the row hides); search results are that Row
    (`search-row-is-the-list-row`). `filterHome` is the sidebar view's "Filter workspaces": the same matcher, applied
    in place to the grouped list (groups kept, empty groups dropped, archived left out). Both order by one rank
    (`byRank`, invariant `one-ranking-for-every-workspace-search`): a title match first (a whole word or word start
    above a match inside a word), then linked items, branch and PR, then the rest of the row. Search breaks a tie by
    score; the filter keeps the list's own order for a tie, inside each group.
  - `shared/sort.ts`: Priority, Recent, Oldest waiting, Name. Sorting applies within each group or project. The
    chosen order is the Display setting `home_sort` (`shared/display.ts`), one for Home and the sidebar view on every
    device; `homeSortSync` reads it, and the first client to load moves its old per-device choice there once.
  - `shared/home-arrange.ts`: the Display field `home_view` and `arrangeHome`, which lays Home's model out for Home
    and the sidebar view: the Project, Labels and background filters, Paseo's pins lifted into Pinned (newest pin
    first; a pinned Needs-you row keeps its mark and still counts in Needs you), then Grouping by status (the groups
    above), by project (in order of each project's first row) or none.
  - `shared/attention.ts`: one colour language for the stack bar, rail nodes and overview bars.
- **Client:** `client/home.tsx`, `client/home-list.tsx`, `client/home-chrome.tsx`, `client/home-view.ts`,
  `client/home-data.ts` ([client.md](client.md)).
- **The Overseer** is pinned on Home. Its own inbox row (`overseer`) stays out of every count
  ([ai-roles.md](ai-roles.md)).
- **Priority sort** reads `follow.priorities` ([ai-roles.md](ai-roles.md)).

## Catch up

Catch up deals Needs you one card at a time: act, next, act, next. Design and Tom's picks:
[design/catch-up.md](design/catch-up.md).

- **The deck** (`deckCards`, `shared/catch-up.ts`): one card per ask, in Home's Needs-you order (the tiers, then
  `home_sort`). Inside a workstream: a pending permission, each open question, every other Needs-you item, then the
  agent's own brief ask when nothing above speaks for it; a finished turn with nothing to decide is one card. Cards of
  one workstream sit together, so its context is read once. The client deals it from Home's model (no read of its
  own); `catch_up_deck` deals the same deck for an agent.
- **The session** (`Session`, `startSession`, `settle`, `park`, `sync`, `nextPos`): pure, so the screen and the tests
  agree. A card that leaves Needs you elsewhere is `gone`, never pulled from under the developer; a new one joins at
  the end; Skip moves a card behind the rest (a second pass picks it up); done cards stay so Back can show them.
- **Two skips** (view-only, no server state; `VIEW_PARITY`): the card's Skip names what it skips ("Skip question",
  "Skip permission", "Skip merge", else "Skip card"), and its tooltip and accessible name say it comes back after the
  rest. Skip workspace (`skipWorkspace`) skips every card of the workspace still to act on at once, each counted as one
  skipped card, and moves to the next workspace; they come back on the second pass. It shows only while the workspace
  has more than one card left (with one it equals Skip), as a quiet text button at the top right of the card, on the
  line with the workspace title it skips, on phone and desktop alike (⇧J on desktop). Back right after it returns to
  the card it was pressed on (`Session.back`).
- **The phone drag**: the card follows the finger (translateX only), and the peek underneath says what the release does
  ("Skip workspace · N cards", or "Skip question" with one card left, or "Back") and names the card it lands on. A drag
  held halfway stays there. The direction locks in the first 8 px (`swipeLock`), so a vertical scroll stays
  a scroll; on release, past 35 % of the width or a fling (`swipeOutcome`), left skips the workspace (`applySwipe`, the
  same `skipWorkspace` as the button and ⇧J; the bar's Skip stays the way to skip one card) and right goes Back, otherwise it springs back. Reduced motion: no follow, just the move. Paseo's plugin UI
  has no gesture primitive, so it is React Native's PanResponder and Animated (native driver off the web).
- **Keys** (desktop web): every move has one, from the one list `CATCH_UP_KEYS` (`shared/catch-up.ts`) that the
  handler (`catchUpKey`), the hint line and the S sheet read. A–H pick, W writes your own answer, ⌘↵ sends, J/→ skip the card,
  ⇧J skip the workspace, K/← back, M opens More context (1–4 pick an ask, ⌘↵ asks the agent), N adds a note, L Later,
  O Open chat, R goes to the queue (↑/↓ move, Enter opens, R again returns), V dictates (when Paseo has dictation),
  S shows the keys, X leaves. None is a combo
  Paseo binds (`PASEO_BOUND`): Paseo keeps ? (its shortcuts) and Esc (interrupt agent), so the sheet is S and leaving
  is X. Home's own keys are off while Catch up shows (`tests/catch-up-keys.test.ts`). The keys have one owner
  (`every-catch-up-key-works-wherever-focus-is`): a window capture-phase listener that acts when focus is inside the
  screen or on nothing while it is on screen, finds its controls inside its own root, and stops a key it acts on. Buttons name their key in their
  tooltip.
- **Dictation** (invariant `dictated-text-lands-in-the-field`): on a Paseo whose plugin client exports
  `usePaseoDictation` (proposed upstream; Paseo 0.16 has none), the answer field (Something else, a free answer, Add
  note) has a mic in its bottom-right corner (`DictationField`, `client/dictation.tsx`; states in `micView`, `shared/dictation.ts`).
  Tap to start, tap to stop; the words go into the field's own words at the caret (`insertDictated`), editable, and
  only Send sends. Unavailable (host offline, no speech-to-text) shows a muted mic that says why in one line when
  pressed; a failed start says why under the field. V presses the mic (Something else opens first when no field is
  open) and leaves focus on it, so V again stops. Without the hook there is no mic, no key in the S sheet and no space.
  `DictationField` wraps any field, so Home and the panel can take it later. Guarded by `tests/catch-up-dictation.test.ts`.
- **The move bar** (invariant `a-move-bar-action-opens-in-view`, `MOVE_OPENS`): every move opens its result in view.
  More context and Later open as a sheet above the phone's bar and as a popover on their desktop button, with focus
  on their first choice; Add a note focuses its field; Open chat leaves for the chat; R focuses the card's row in the
  queue. Once a question card has an answer to send, Send to agent joins the bar (on a phone it reads Send, and Skip
  shrinks to an icon), running the question's own Send. Other cards keep their one action in the card:
  a permission is two choices (Allow or Deny), a merge belongs next to what it merges, a brief can hold several
  questions, and a finished turn's Sign off is already beside its one line.
- **More context** (invariant `context-never-blocks-the-deck`): the developer asks the card's workspace main agent (a
  queued message, invariant 36; asking may wake it, because the developer asked). There is one Ask and no choice of
  who: the main agent is the only role with `context_reply`, so only it can answer on the card
  (`an-ask-goes-only-to-an-agent-that-can-answer-it`, `contextRecipient`); a contributor's or recovery agent's card
  asks the main agent too, and a workspace Follow-up doesn't track is refused with a way to its chat. `ask_context`
  still accepts `target` and ignores it. 2.2.0-beta.3 could ask the Overseer, which can't reply on a card: such an ask
  still open settles as `chat` on load, with Open Overseer on the card. "I don't get it" is the first suggestion. The ask is recorded (`server/context-requests.ts`,
  `context.json`) and answered at once; the deck moves on to the next workstream, and every card of the asked one
  waits. When the answer arrives (`context_reply`), or the agent ends a turn without it (`chat`: read its chat), or
  the ask fails, the workstream comes back as the very next card, right after the one on screen and never in its
  place, with the answer on the card. The answer reaches the client on `follow.home-feed` (`context`), so nothing
  polls. A finished deck still counts the cards waiting for context, and Back reaches a waiting card at any time,
  which the card and the More context panel say.
- **An ask always ends.** The ask records when it was delivered (`deliveredAt`: the queue's settle for the main
  agent), and the first turn end after that without a `context_reply` settles it as `chat`,
  so a prompt steered into a turn already running counts. After a worker restart, an ask still open is re-derived
  from the queue's record and the cached agent list (delivered to an idle agent: `chat`; a send that failed for good:
  `failed`), never by waking anyone. The prompt carries who asked (`by`): the developer, or the agent that called
  `ask_context`.

## More context

More context is the same on every surface that answers a question (invariant `more-context-is-the-same-on-every-surface`):
Catch up's card, and everywhere `QuestionBody` draws an open question outside Catch up (the panel's Needs you card,
Home's detail pane, the question dialog, the pill, phones). Outside Catch up it is a quiet "More context" link under the
question's own context, never a new button or key; it opens Catch up's panel (`MorePanel`: "I don't get it" first, then
your own words) in Catch up's sheet (`MoveResult`), all from `client/more-context.tsx`. The ask is the same request
(`follow.context-ask`, what `ask_context` calls), to the same agent (`contextRecipient`). While it is pending the
question says so ("Asked the agent · the answer shows here when it comes"); the answer, "answered in its chat" or a
failure sits on the question (`ContextAnswer`), with "Ask more" to ask again.

One question is one card wherever it is asked from. Catch up keys its cards by workstream (`agent:<id>|Q3`), the other
surfaces by workspace (`questionCardKey`: `ws:<id>|Q3`), and every reader matches through `sameCard` / `contextFor`
(`shared/catch-up.ts`): the worker's one-open-ask-per-card rule, `catch_up_deck`'s `context`, Catch up's card and every
question card. So an ask made from the panel shows in Catch up and on Home, and the other way round. The client reads
the asks from one store, Home's extras (`setContextSource`), which `follow.home-feed` keeps current, so nothing polls.

## Your questions

The developer asks an agent something, and the answer is kept where they can find it again: one **Your questions** card
(the panel and Home's detail pane, the same component), Needs you, Catch up and phones. It is the same request as More
context (`server/context-requests.ts`, `shared/your-questions.ts`, `context.json`): a More context ask is a question
about a card (`cardKey`), a free question has `cardKey: null`. Design: `DESIGN.md` of the Your questions evidence.

- **Asking** (`follow.context-ask`, what `ask_context` calls): the card's "Ask the main agent…" field (`via: "field"`, to
  the workspace's main agent), `/ask <question>` in any agent's chat (`via: "slash"`, to *that* agent), More context
  (`via: "more"`, to the card's workspace main agent) and agents (`via: "tool"`). A free question goes only to an agent
  that can answer it (`questionRecipient`): a tracked workspace's main agent or one of its contributors, the roles with
  `context_reply`; never the caller. It is a queued message (invariant 36), human-first since the developer reads it in
  that chat too (`agentQuestionPrompt`): one line, `Your question (ctx-3f9a2b1c) · answer with context_reply:`, then the
  question as typed. How to answer (plain words, short, a question is not a task) is `context_reply`'s description, in
  every session already. Ids are `ctx-` and 8 hex, unique in the file (`newQuestionId`); older long ids keep working,
  and capture matches an id only as a whole word. The chat keeps it as a plain user message, so it starts its own turn (Paseo groups a chat into turns only at real user messages: a plugin card in its place folds into the turn before and, under "Collapse turns", out of sight). A plain
  question typed in the chat is not tracked (Q172 B=a).
- **The answer, reliably** (`your-question-always-gets-its-answer`): `context_reply {requestId, text}` first (≤4000
  chars, a corrected reply wins). Else **turn-end capture**: the first turn end after delivery takes the agent's last
  assistant message after the question's own message in that turn (`capturedAnswer`), from the items the worker already
  read for the turn end (`a-turn-s-timeline-is-read-once`; `agent.turn_ended` on every provider, no hook), and marks it
  "from its chat". With no items (the turn couldn't be read) it is "answered in its chat" with Open chat. A send that
  fails for good fails the question (Ask again); Withdraw while asking settles it as withdrawn and drops a message
  still queued.
- **After the answer** (`follow.question-action`, `question_action`): Done (read; stays in history), Reply (a follow-up
  in the same thread, `parentId`, to the same agent), Make a task (an obligation through `update_obligation`'s path,
  owned by the agent that answered, the Q&A as its `note`), Withdraw. Each records `by`; an agent's act never marks
  the answer read for the developer (`readAt` is the developer's only), and the agent a question was asked of can't
  act on it (it answers with `context_reply`).
- **Needs you** (Q172 C=a): an unread answer (`unreadAnswer`: answered, from its chat, or failed, not yet read) puts
  its workspace's row in Needs you at the lowest tier (`ANSWER_TIER`, below finished turns) as "Answer · <question>",
  unless the row already needs the developer for something louder; Catch up deals it as an `answer` card, last in its
  workstream; one that turns up mid-session joins its workstream too (`sync`), so the rail keeps one group each. A question still asking is the row's line ("Asking · …") and never Needs you. Home builds both from the
  home feed's `context` (`buildHome` `questions`), so nothing polls.
- **Kept** (Q172 E=a): 30 days, at most 200 per workspace (`pruneContext`). History (in the card on desktop, a sheet on
  a phone) searches questions and answers (`questionHistory`), All / Open / Tasks, newest first.
- **The client** (`client/your-questions.tsx`): `YourQuestionsCard` under Needs you in the panel (`WorkspaceView`) and
  Home's detail pane; it reads the one store of questions (`useContextStore`, Home's extras kept by the home feed;
  no polling) and acts through `extras.questionAction` (`follow.question-action`). Its fields (the ask, Reply) are
  `DictationField` inside `ImageField`, marked `PRIMARY_FORM`. Only what the server takes is offered: no Done while
  asking (Withdraw), no Make a task without an answer, Ask again for a failed ask. An asking row reads "queued Nm ago"
  or "sent Nm ago" (`deliveredAt`), plus "· the agent is mid-turn" while Paseo's directory has the workspace running
  (`useWorkspaceRunning` over the store Home and the panel already keep; no read of its own). Where the pane docks a
  reply field (Home on a phone), the ask field is one "Ask the main agent…" row until tapped (`foldAsk`), so the pane
  shows one text field. Done · Reply · Make a task · ⋯ stay on one row: "Task" on a narrow row, and Reply and Task
  (and Done) drop their icons below ~340 pt (a phone's panel). Catch up's `answer` card draws
  `AnswerView` and `AnswerActions` (D Done, W Reply, T Make a task, O Open chat, J Skip: `CATCH_UP_KEYS` `when:
  "answer"`); on a phone they are the thumb bar. `/ask` is an agent slash command (`index.client.tsx`).
- **v1 → v2**: `context.json` gained `version: 2`; a v1 file is migrated on load (`migrateContext`): settled asks
  become history rows already read, an open one stays open.

## Answers waiting to be sent

`an-answer-leaves-needs-you-only-when-delivered`. Copy and Put in chat move the developer's own words without
sending them, so the answer stays in Needs you as "Your Qn answer isn't sent yet" (`awaitingSend`,
`shared/questions.ts`; the headline reads "Send answer").

- **Sent from the composer.** When a turn of that agent ends, `turnEnded` (`server/turn-events.ts`) looks for
  `Follow-up answer Qn (` in the user messages of the tail it already reads; a match records the answer as sent. An
  edited message counts as long as the marker survives. No new reads, and an unloaded agent is never read.
- **Sent from here.** The row's Send delivers the recorded pick and note in one click (`follow.answer-question`,
  action `send`); the dialog's Send to agent does the same.
- **Escape hatch.** If the marker was edited away, Sign off (or mute) on that agent's row settles it as signed off
  (`signedOffAnswers`); the dialog reads "You signed it off; Follow-up didn't see it in the chat."
- **Every surface tells the same story** (`answerStatus`, `shared/questions.ts`). The chat's card, the dialog's answer
  block, Needs you, the Home row and the panel's Activity all read one helper: "In your message box · not sent yet" or
  "Copied · not sent yet" (muted, no check) until the answer is delivered; "Answered" only then.
- **Put in chat** (`put-in-chat-never-rewrites-a-draft`, `shared/put-in-chat.ts`): focus the composer at the end of
  the draft, then insert the answer, after a blank line when there's a draft. It never calls `setPrompt`, inserts
  nothing when the exact answer is already there, and falls back to Copy when the composer can't come on screen.

## One Needs you block per surface

`an-open-question-renders-once-per-surface`: the panel and Home's detail pane each draw one "Needs you · N" block
(`NeedsYouBlock` in `client/needs-you.tsx`, laid out by `needsYouBlock` in `shared/needs-block.ts`), never a brief
card beside a question list.

- **A done brief is never an ask** (`a-done-brief-is-never-an-ask`). The panel and Home pick the brief they draw with
  `briefAsks` (`shared/brief.ts`): a flagged row and a stated ask, never kind `done` ("Nothing needed"). A done brief
  on a row flagged for something else (a merged PR) leaves the block to that reason, and the flag's headline
  (`flagHeadline`: pill, sidebar row, Home row) reads it too (`doneBriefViolations` in `shared/status-invariants.ts`).
- **A brief without an ask never sits beside Needs you** (`a-brief-without-an-ask-never-sits-beside-needs-you`).
  "No ask stated" or "Nothing needed" is drawn only while nothing in Needs you speaks for the row (`briefCardShown`,
  `shared/brief.ts`); beside a question or an answer waiting to be sent it would say there's nothing to do.
  The flag's headline (`flagHeadline`: Home row, sidebar row, pill) follows the same rule: such a brief supplies the
  line only where its card would draw and only for the finish it came with. Beside drawn items the top item is the
  line; for another flag the flag's own fact is (a merged PR's title), never "Merged · No ask stated".
- **The newest brief decides** (`newest-brief-decides`). An agent's needs_you kind=done is its newest word: it
  resolves an older finish flag whose brief asked nothing ("No ask stated", source none) and replaces that brief
  (`resolveStaleFinish` in `shared/inbox.ts`, the quiet guard in `server/inbox.ts` `creator`). Only an ask the
  developer hasn't answered (`briefAsks`: a decision, action or review) outlives a later done (F7). Before this, an
  agent nobody messages kept its stale "No ask stated" flag for hours (2026-11-13). `rowViolations` checks it.
- **A compaction is not a finish** (`a-compaction-is-not-a-finish`, AGENTS.md invariant 130). A turn that only
  compacted (`compactionOnly`, `server/inbox-classifier.ts`: a compaction item and no reply, reasoning, tool call, to-do
  list or error) ends without a turn_end event or a brief step (`Inbox.turnEnded`), and on a provider without hooks
  without a turn-end check (`TurnEnd.turnEnded`, `server/turn-end.ts`); a developer's `/compact` starts the turn as
  automation, so it answers nothing (`isCompactCommand`, `shared/status.ts`). The open brief and its flag stay as they
  were. An empty turn read, or a turn whose only content is a plugin's or Follow-up's message, is still handled as
  before: nothing there proves the agent did no work.
- **One reviewers ask per PR** (`one-reviewers-ask-per-pr`). The "has no reviewers" row names whom Follow-up
  suggests (`suggestedReviewers`: the repository's or default reviewers minus the author) in the brief's own words,
  "Add reviewers to #240: Ravi" (`reviewersAsk` in `shared/reviewers.ts`). Follow-up's reviewers brief folds into that
  row (`needsYouBlock`), so the PR asks once and counts 1; a reviewers brief for a PR without a row keeps its card
  (`reviewersBriefViolations` in `shared/status-invariants.ts`, `tests/fold-reviewers.test.ts`).
- **Asks first.** The agent's open brief that points at open questions (`questionIds`) becomes the first of those
  questions' cards: the question's title, its Q chip and asked age, the brief's context, the options with Send, and
  what the agent does meanwhile as the footer. A brief that points at no open question keeps its own card, drawn bare
  as the block's first section (unless every question it points at is settled: it is resolving).
  A `needs_you` that reports a blocked task points at that task's card even when the agent didn't name it: cards it
  names or restates, with a lower bar for a card made during the turn (`taskCardsFor`, `one-ask-one-item`), so the
  brief and the task never both ask. A card it doesn't name or restate never hides the brief's ask: both show.
- **Every other open question** gets the same card. The first is open, the rest are headers that open in place.
- **Rows** follow: every other decision (send, merge, retry, a check), never a question.
- **One answer path.** A question card, the pill, the question dialog and the chat's brief card all answer a stored
  question through `follow.answer-question`; the brief resolves when its questions settle (`briefQuestionsEvent`).
  Only a decision with no tracked question goes through `follow.brief-action`.
- **One ask, one title** (`one-ask-one-title`): `needs_you` pointing at one open question stores its title as the
  brief's ask (`foldedAsk`), so the Home row, the sidebar row, the pill, the chat card and the panel name it the same
  way; the agent's context stays the card's body. Over several open questions the agent's own ask stays the title
  ("Two calls on the invoice export"); the first question's title would repeat as the card's item 1.
- **Say it once** (`say-it-once`): a flag's headline line (the Home and sidebar row's text, the pill sheet's ask)
  never repeats its word, its pill label or the PR chip. A merged or closed PR's flag carries the PR's title
  (`ReasonEntry.title`, from `prEndEvent`) and reads it, not "#240 merged"; a flag stored before that keeps its line.
  Check, review-thread and conflict flags already say what to fix.
  In the pill sheet, a to-do that only says the headline again (`echoedItems`: the same text, or a reviewers row for
  the headline's PR) drops its title and keeps its controls. The popover says its "N to do" once (`todoLine`): the
  section header over the items when they show, else the meta line; the pill's title (a phone sheet's title) never. `tests/say-it-once.test.ts` covers every reason and the
  sheet.
- **A headline says only what is new** (`a-headline-says-only-what-is-new`, inside `say-it-once`). Not even part of
  the line may repeat its row: `repeatsRow` (`shared/headline.ts`) fails a line that contains the row's word or label
  (case and punctuation ignored, the label's age dropped, a hyphenated word kept whole) or a PR ref the label or chip
  shows. So Add reviewers reads "Suggested: Ravi" (else the PR's title) under "Add reviewers #246", a merge row's line
  is the PR's title, a review flag reads "2 threads to fix", and Home drops the chip's ref from the line (`sayNew`:
  "Merge conflict to fix", not "… on #240" beside a #240 chip). A ref the row doesn't show stays. It covers the lines
  Follow-up writes; a question's or decision's line is the agent's own words and isn't reworded.
- **No "No ask stated" beside an open question:** the chat's fallback card says "Waiting on your answer to Q1".
- **A blocked task names what it waits on** (`blockedLine`, `shared/task-status.ts`): "Blocked · waits for Q1", or the
  evidence's first sentence.
- Home's chips and the composer pill stay pointers. Tests: `tests/question-once.test.ts`.

Tests: `tests/inbox.test.ts`, `tests/brief.test.ts`, `tests/decision-card.test.ts`, `tests/home.test.ts`,
`tests/home-beta2.test.ts`, `tests/attention.test.ts`.

## Dismiss

Every Needs-you item has one Dismiss: a small muted x in its card's top-right corner, beside its age
(`client/dismiss.tsx`, invariant `dismissing-anything-in-needs-you-sends-the-agent-nothing`). It means "this no longer
needs me": the item leaves Needs you and every count at once, and no agent is sent anything (no message, no turn, no
tokens). The toast says "Removed <what>. The agent wasn't messaged." with Undo for 6 s. On a phone the x is always
there, muted, with a 44 px hit area (a real box: react-native-web ignores hitSlop); on desktop it shows while the pointer is over the card or focus is
inside it (`RevealScope`), and always on the selected card (Catch up's card, Home's detail pane: `DismissReveal`).
It takes two clicks in place (`dismiss-takes-two-clicks-in-place`, `armed-dismiss-shows-remove-and-keep`): the first
click, tap, Enter or Space arms the x into two small buttons on the same spot, a quiet "Keep" (the card's ground, a
hairline, body ink; first in reading order) and "Remove" (a danger tint at rest, solid red under the pointer); a
140 ms fade, none under reduced motion. Screen readers hear "Remove, or Keep to cancel" (a polite live region on web,
where react-native-web's `announceForAccessibility` does nothing). Focus moves to Keep, so a second Enter keeps; Tab
reaches Remove. Remove removes; the second click of a double-click on the x lands on Remove and is ignored (DOM
`detail` 2). The pair grows leftward over what sits beside it and takes back its extra width with a negative margin,
so the card never reflows; on phones the x and both buttons are 44 px tall targets with 8 px between them. Keep, a click or tap anywhere
else, Esc (taken, so it doesn't also interrupt the agent; focus goes back to the x), focus leaving the pair, the
pointer leaving its card for 600 ms, or 4 s untouched (paused while the pointer is on the pair or keyboard focus is on it)
disarms it quietly. Only one x is armed at a time, app-wide. Catch up's ⇧D presses the card's x, whatever the card is,
so ⇧D twice removes (the second press clicks Remove). The agent tool `dismiss_item` is unchanged: a planned tool, so its own dry run and confirm are the
second step. One request, `follow.dismiss` (`{ workspaceId, key }` for an
item, `{ agentId }` for an agent's brief, `undo: true` for Undo); agents use `dismiss_item` (planned, audited, never
their own brief, question or workspace; `dismiss_question` stays as the question-only alias).

A dismissed item is pinned to what it is about (`dismissPrint`, `shared/attention.ts`): it stays hidden while that
holds and comes back by itself when it changes, so a real new problem is never hidden. The record is
`Workspace.dismissed` (key, print, title, when, by whom); a question closes as dismissed instead
(`server/questions.ts`), and an agent's brief is signed off as dismissed (`Inbox.dismiss`). Dismiss never drops work
Follow-up holds:

| Kind | What Dismiss does | What brings it back | What the agent sees |
| --- | --- | --- | --- |
| Agent's turn-end brief (decision, action, review, error) | Signs the row off as dismissed: the card reads "Removed" (stored as "Dismissed"), the ask is remembered (`dismissedAsk`) | Undo; a new, different ask; the developer's next message to the agent clears the memory | Nothing is sent. `workspace_status` shows `dismissedAsk`; a `needs_you` restating it (`sameAsk`) ends the turn quiet and its `note` says it was dismissed |
| `question` | Closes it as dismissed (invariant 59's rule) | Undo; `supersedes="Qn"` asks again on purpose | `dismissedQuestions`; re-asking returns it as dismissed, pointing at it is refused with why |
| `merge` (approved, ready) | Hides the Merge ask; the PR sheet still offers Merge | A new head commit on the PR | `dismissedItems` |
| `reviewers` | Hides the ask and withdraws the agent row's "Add reviewers" flag (`reviewersAskStands`) | A new head commit | `dismissedItems` |
| `send` (repairs waiting on you, the Done check) | Hides the ask; the batch stays queued on its Tasks rows and still goes with Send now or Auto | A new batch, or a task added or changed in it | `dismissedItems`; the batch is untouched |
| `retry` (a blocked or unconfirmed batch) | Hides the ask; the batch keeps its state | The batch's state, attempts or result changing (a new failure) | `dismissedItems` |
| `capped`, `person` (a held task) | Hides the ask; the task stays held, out of the queue | The task's fingerprint (what GitHub shows) or its reason changing | `dismissedItems` |
| `decision` (a blocked task not yet a question) | Hides the ask; the task stays blocked (its state is the agent's) | A new revision or ask on the task | `dismissedItems` |
| `hold` (Follow-up is paused) | Hides the ask; Follow-up stays paused and the panel still says so | A different pause reason | `dismissedItems` |
| `check` (a PR action Follow-up couldn't confirm) | Hides the ask; the action record stays | Its result changing | `dismissedItems` |
| `answer` (failed, or copied or in chat and not sent) | Hides the ask; the answer and its delivery stay as they are | Its delivery state changing (sent, failed again) | `dismissedItems` |
| `message` (an undelivered forward or report) | Hides the ask; the queue item keeps retrying, Retry and Cancel stay in the queue | Its state changing (queued to failed) | `dismissedItems` |
| Nobody's on it: a raised Linear issue (decision Q8) or an urgent Compass ask, no workspace | Hides the row (`follow.dismiss` with `issue`; `linear-queue.json` `dismissed` and `compass.json` `removed`) | A later raise, or a later Compass note on the issue | Nothing: no agent owns it ([morning-brief.md](morning-brief.md#in-the-brief)) |

## Opening the PR a row names

`a-row-that-names-a-pr-opens-it-in-one-click`: a row about one PR opens that PR in one click, without the PR sheet.

- Every Needs-you item about one PR (merge, reviewers, a capped repair on a PR, an uncertain action on one PR) carries
  `pr`, from `prLink` (`shared/presentation.ts`): Graphite when the PR ships through Graphite, else GitHub, the same
  rule as the PR sheet's links. `NeedsYouList` draws it as `PrLinkButton` (`client/kit.tsx`) after the row's action:
  an icon link labelled "Open pull request #N", an anchor on web. It is navigation, so it never counts as the row's
  one action (DESIGN.md).
- Every "#N" in a Needs-you row's or a brief's text that names a PR the workspace tracks links it: `NeedsYouList` and
  `BriefCard` wrap their rows in `PrLinksProvider` (`client/rich-text.tsx`), and `linkify` (`shared/links.ts`) links a
  bare number only when it maps to exactly one tracked PR. A done brief's "#240 is merged" opens #240.
- A brief about a PR (review, action or decision with a linked PR, reviewers, a PR event) has an Open PR move.
- `inbox_list` gives each row `prs`: its PR flags' and its Needs-you items' PRs with their urls (`rowPrs`,
  `server/agent-actions.ts`), so an agent can hand the developer the link.

### Brief cards while an agent is unloaded

`server/brief-timeline.ts` owns the inbox's timeline sink and the flush when a plugin session first appears.
It holds a pending card per agent until discovery's shared directory says loaded, then confirms with a fresh
metadata fetch before appending. Metadata never resumes an agent. Directory list refreshes, live metadata updates
and lifecycle patches retry pending cards; there is no extra timer or agent subscription. A failed append (including
an unload between metadata and append, or a missing plugin session) remains pending for the next signal. Before
appending, it reads the inbox's current brief: a deferred replaced card is dropped and same-id edits use the latest state.
An immediate collapsed update still replaces an older row while the agent is loaded, preserving chat history.
Successful appends leave the pending map; concurrent signals share one append per agent. Pending delivery lives in
the worker's memory, as the previous pre-session buffer did; this is not a durable timeline outbox.

The unchecked append and lossy pre-session flush existed before 2.6.0-beta.1. That beta's provider turn-end checks
can enqueue a follow-up message, but the available evidence does not establish that they caused the observed
unknown-agent failures. The fix covers the proven append lifecycle gap without changing turn-end checks.
