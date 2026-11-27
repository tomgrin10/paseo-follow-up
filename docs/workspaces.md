# Workspaces: discovery, ownership, repairs and Done

## Discovery and following

- **Follow every workspace (default since 1.3.0-beta.2).** Every Paseo workspace with an agent is followed, except
  opt-outs. Settings → Following holds the switches and the per-project and per-workspace exceptions
  (`shared/settings.ts`: `followsByDefault`, `optedOut`, `migrateFollowEvery`).
- **Discovery** (`server/discovery.ts`, called by `engine.tick()` through `PaseoGateway.discover`):
  - Builds `DiscoveredWorkspace` rows from the directory's root agents. `applyDiscovery` adds or updates
    workspaces, and `applyHistory` fills goal and PR candidates from the distilled history
    (`server/history-cache.ts`).
  - Track and interactive session startup must not scan transcripts or wait for a daemon-wide refresh. Persist
    activation before returning, and leave history and external status to background work.
  - A regression test blocks the global refresh to keep successful activation from timing out again.
- **Dormant.** A workspace with no user message within the active window (Settings → Following, `activeWindowDays`)
  is dormant. It stays listed but gets no PR or agent observation until it's active again.
- **PR submission discovery** (`server/submissions.ts`):
  - Uses only completed shell-tool receipts from workspace root sessions. Never a repository-wide worktree scan,
    and never plain PR mentions or links in chat.
  - Receipts are constrained by the GitHub repository identity of the workspace's project.
  - Explicit registrations, exclusions (`server/exclusions.ts`) and existing owners are preserved.
  - Tests cover secondary worktrees and an unavailable recorded owner.

## Root agents, subagents and roles

- **Root vs subagent** (`server/workspace-agent.ts`, `isWorkspaceRoot`). A parent-agent label alone doesn't
  identify a workspace subagent. Resolve the parent's workspace: a launch into a different workspace is an eligible
  root, while a same-workspace child stays excluded. Unknown parent membership grants no new scope. Use this module
  everywhere: discovery, tool access and recovery handoff. Packed tests cover workspace-first agent creation.
- **Background agents** (`server/background-agents.ts`). On Paseo 0.16 another plugin can run a helper with
  `background: true` (no tab, no notifications, left out of Paseo's agent lists). Such an agent is never a root:
  - no action tools, no `needs_you` and no Stop-hook nudge at session open;
  - no Wait;
  - no inbox rows for its turns;
  - no directory row.
  Paseo sends the flag only in the agent snapshot (`fetch_agent` / `agents.ref(id).refresh()`), not in lifecycle
  events or `session_open`. On 0.16 a brand-new agent's snapshot doesn't exist yet at `session_open` (checked in the
  0.16 harness), so its first session still gets the tools. The worker learns the flag at `agent.created` and
  writes `background-agents.json`. The hook then skips the agent (no context, no Stop-hook nudge), tool calls are
  refused (`isWorkspaceRoot`), and later session opens skip tools and Wait. `BackgroundAgents` remembers only
  "yes": the flag is fixed at creation, and an early "no" must not stick. A failed read counts as not background.
  On 0.15 the field is absent and nothing changes. Guarded by `tests/background-agents.test.ts`.
- **Roles:**
  - **Main agent:** owns goal, tasks, questions, the spec and Done.
  - **Contributors** (other root agents): get PR status, registration and sync only.
  - **Recovery agents:** a separate agent that reads history for missed PRs and tasks, and never edits code.
    `server/recovery-config.ts` applies Settings → Agents' recovery role; `server/recovery-handoff.ts` proves a
    handoff without reading timelines.
    On a host that advertises `features.backgroundAgents` (Paseo 0.16) it is created `background: true`
    (`withBackground` in `server/daemon.ts`): no tab, no notification, no sidebar row; its batch shows in the panel.
    Follow-up skips background agents at `agent.session_open`, except the one its own record names as a recovery
    recipient (`recordedRecoveryAgent` in `server/tasks.ts`, never labels), so it keeps its tools on every session.
    No plugin API releases an agent by id, so "unloads" means host-collectable: a settled batch leaves nothing that
    vetoes Paseo's idle-runtime cleanup (`recoveryCollectable`). Paseo 0.15 creates it exactly as before.
- **The PR owner.** `server/pr-owner.ts` records the latest explicit registering agent on each PR. Legacy
  registrations keep their workspace main. Duplicate claims are ambiguous: never route by recency or by title.

## Changing the main agent

All changes go through `setMainAgent` (`server/discovery.ts`) and are recorded in `mainHistory`. There are four
kinds:

| Kind | When |
| --- | --- |
| `handover` | The recorded main is archived or gone, or has read "closed" for 30 minutes without a break (`MAIN_CLOSED_HANDOVER_MS`). A live root agent takes over: the one the developer wrote to last, then the newest (`successorMainAgent` in `server/daemon.ts`). |
| `handBack` | The original main reads live again before the successor did any main-agent work (`handBackMainAgent`). Main-agent work is any `MAIN_WORK` call (`markMainWork`). |
| `developer` | "Make main agent" in the panel (`follow.control` with `mainAgentId`). |
| `claim` | The `make_main_agent` tool (planned: the agent confirms its own dry run). It passes `requested: developer` when the developer asked, which is refused only while the main is mid-turn, and `requested: self` otherwise. `checkMainClaim` (`server/discovery.ts`) applies the rules: refused while the main is mid-turn; a self-claim also needs the main archived, gone or closed 30 min, or every open PR registered by the claimant and the main idle 24 h; a 30 min cooldown after any change; no reclaim within 2 h. |

A demoted agent is told once, on its next turn, through the hook (`demotedNotice` in `server/agent-hook.mjs`).
Tests: `tests/main-claim.test.ts`, `tests/main-handover.test.ts`.

## Repairs: batches

`server/engine.ts` (`Engine.tick`, every 15 s, skipped while the governor holds background work) does the following:

1. Runs discovery.
2. Observes PRs (`server/github.ts`, plus `server/graphite.ts` in Graphite repositories) and each active
   workspace's main agent (`PaseoGateway.observe`).
3. `reconcile` builds tasks from PR state: conflicts, failing required checks, review threads, restacks
   (`tasksFor` in `server/tasks.ts`). It then builds a pending **batch** for the main agent, with one prompt from
   `batchPrompt`, also in `server/tasks.ts`.
4. Auto-sends a pending batch exactly when `sendDecision(w, now)` (`shared/send-decision.ts`) says `send`. It is
   the one rule: every surface's batch line shows its `reason` (status invariant
   `the-send-line-matches-the-send-decision`), and it reads only what the refresh persisted before deciding
   (`mainBusy`, `runtimeReason`, `sendWait`, PR reads, the batch's last refusal). It sends when:
   - Auto-send is on, nothing is held, and the agent isn't dormant or gone.
   - The batch has no completion check.
   - The main agent is loaded and recently used (else `sendWait` is `unloaded`) and free: `mainBusy` (`server/daemon.ts`
     `observe`, the same read that sets `runtimeBusy`) is its own turn (`turn`), its own background job while Wait for
     background jobs is on (`jobs`), a permission prompt or question (`permission`), a Session Guard pause (`guard`) or
     a compaction (`compacting`), each said in `MAIN_WAIT`'s words. Another agent in the workspace, a subagent the main
     agent started, or the main agent's provider subagents never hold a repair (Q96 = A, invariant
     `a-repair-goes-to-a-free-main-agent`). While the main agent is busy, Send now is offered and taken: the repair
     waits in the queue and goes on the tick that sees the main agent free.
   - Setup isn't holding auto-sends (`sendWait` is `setup`).
   - No other batch is open (`sending`, `sent`, `blocked`, `uncertain`).
   - Every PR reads cleanly when the batch has PR tasks (`needsPrObservations`): "waits for a clean read of #2 (…)".
   - No refusal in the last settle window, and 60 s (`SETTLE_MS`) have passed since the batch was created.

   One pending batch per workspace is updated in place as tasks come and go, and its settle clock stays at the
   first queued task: a task that joins a batch older than 60 s goes out on the next refresh, and a flapping check
   can't keep it "in a moment". A batch is cancelled only when nothing is left to send.
   A refused automatic send (the dispatch's own re-check: the agent just started a turn, task dependencies changed)
   is stored on the batch as `refusal` and is the line's reason ("didn't send: … · tries again shortly"). It is
   retried once per settle window, and cleared by a send or a changed task list. Otherwise the batch waits for the
   developer's Send (`follow.send`).
5. Batch states: `pending` → `sending` → `sent` → acknowledged (`acknowledge_batch`), or `blocked` or `uncertain`.
   - No routine Retry (Q50). A sent batch whose agent sits idle 2 minutes (`UNACKNOWLEDGED_MS`) without an
     acknowledgment is settled from GitHub (`settleUnacknowledged`, `shared/send-decision.ts`): tasks GitHub no
     longer shows are done, and still-open ones go back in the queue (`completed` with `unacknowledged`, which
     `reconcile` doesn't count as delivered). The per-task cap below decides when an unchanged condition stops going
     out. A refused acknowledgment, and the agent's own `blocked` acknowledgment (its reason is the Needs-you text),
     still block.
   - **A stuck batch leaves once nothing it asked for applies** (`a-batch-item-leaves-once-nothing-applies`). Every
     `reconcile` re-checks a `blocked` or `uncertain` repair batch against the tasks the PRs show now, as it does a
     queued one (`stillApplies`, `shared/send-decision.ts`): once no task's condition (key and fingerprint) is still
     open, because every PR merged or closed or the review was dismissed or replaced, the checks pass or the conflict
     is gone, it leaves Needs you and the queue with the reason and its blocker's own time. An answer the agent gave
     keeps its state and words and gets `movedOn` (`why: "gone"`, "No longer needed: #142 merged."); an unconfirmed
     send settles `cancelled`. A PR GitHub didn't answer for still applies (unknown is not off). `recover()` runs the
     same pass at start-up over every tracked workspace, dormant ones included, so a batch an older release left stuck
     clears.
   - **A changed review is an update, never a cancel** (`a-changed-review-updates-never-cancels`). A stuck batch whose
     exact condition is gone but whose task key is still open (the same review with new threads or replies) changed:
     it gets `movedOn` with `why: "changed"` (`changedNotGone`), never "No longer needed", and the next message says
     what moved in counts ("since the last message: 2 new threads, 1 with new replies", `taskUpdate` over the task's
     `parts`, the review's `threadId@updatedAt`). A batch with `movedOn` never holds the queue (`holdsQueue`) or shows
     as stuck (`stuckBatch`); Activity words it as updated, sent again or no longer needed, muted. Retry on an answered
     batch marks it `movedOn` `retried` instead of rewriting it `cancelled`. `acknowledge_batch` takes
     `outcome: "in_progress"` when the agent or its own subagent is already on it: the batch settles `completed` with
     `inProgress`, and its unchanged conditions count as delivered while the workspace is busy (`inProgressHolds`, at
     most `IN_PROGRESS_MAX_MS`, 2 h), so the same items are never sent again meanwhile. Other agents' work keeps a sent
     message open at most `IN_PROGRESS_MAX_MS` after it went out, and an agent in `error` or `closed` reports no
     background work (`backgroundCount`), so a busy signal that can't clear never holds auto-sends. `healBatches`
     (in `recover()`, logged in counts only) relabels a churned "No longer needed" whose task a later batch carried,
     restores an answer a Retry rewrote, and sets aside an older answer whose exact conditions went out again.
   - **A human-only outcome is a human item** (`a-human-only-outcome-is-a-human-item`). `acknowledge_batch` blocked
     with `humanOnly: true` says nothing is left for an agent: only a person can move it (a reviewer must re-review or
     dismiss a stale review, access must be granted). The batch settles `completed` with `humanOnly`, and `reconcile`
     holds each still-open condition as `person` (`personHeld`): never re-sent on its own, never "The tasks didn't
     finish", and it doesn't hold the queue. Needs you shows a PR item ("#142 waits on its reviewer", the agent's words
     as detail) with Ask for re-review (the PR sheet's reviewers; `add_reviewers`), Hand back to agent (`follow.control`
     `retryTask`, the `retry_batch` tool with `task`) and the PR link. A changed condition (a new review, a new head)
     has a new fingerprint and goes out as usual; a merged PR ends it.
   - **A person part is a person item** (`a-person-part-is-a-person-item`). When only part of a batch waits on a person
     (one review thread needs the reviewer's call), the agent names it in `acknowledge_batch` `waitingOn` with any
     outcome and goes on with the rest (`Batch.waitingOn`). The agent's latest answer for that task decides
     (`personPart`, keyed by the task, not its fingerprint, so a review that keeps changing keeps it): while its PR is
     open, Needs you has a person item ("Part of #270 waits on its reviewer", the agent's words as detail, with Open #270
     first and Hand back to agent), and it headlines the workspace's row like any other Needs-you item. Every later
     message for that task ends its item with "Leave this part for a person: "…"", and its review count leaves that part
     out ("3 open threads" where the PR row says 4). An `in_progress` answer without `waitingOn` carries the part over; a
     completed or blocked answer without it, Hand back to agent (`retryTask`) or a merged PR ends it.
   - A recovery batch follows the same rule: one that ends without an acknowledgment but caught the PR list up
     (`inventory.syncedRevision`) is done.
   - A reload mid-send makes it `uncertain` (`engine.recover()`). The next refresh reads the recipient's chat for the
     batch's `messageId` (`PaseoGateway.arrived`, at most once a minute, loaded agents only so nothing wakes): found,
     it's `sent`; missing, it goes back to `pending` under the same `messageId` and sends once; unknown, it stays
     `uncertain` and asks the developer to check.
   - Never-sent cancelled batches are pruned to `archive/` (`server/batch-archive.ts`).
6. **Holds.** A failed main-agent turn, or the developer's Stop, sets `hold` (`holdOnTurnEnd` in `shared/status.ts`),
   unless Session Guard owns the interruption (`server/session-guard.ts`, `sessionGuardOwnsInterruption`).
   - Only a Stop holds. Paseo reports a Stop, a turn replaced by a newer message (the developer's or another
     agent's) and a refreshed session all as "Interrupted", so `cancelCause` reads the context: a newer turn already
     started (`replaced`), the turn was a `/compact` (`compaction`: its prompt, or Smart Session's queue showing a
     `/compact` it just delivered, `compactionDelivered`), the reason names a reload or close (`reload`,
     `closed`), else `stop`. When unsure it doesn't hold: a missed pause is cheap, a stuck one silently stops repairs
     (invariant `only-a-stop-holds`, `tests/cancel-hold.test.ts`).
   - Follow-up's automatic hold is run state: a newer main-agent turn (a different turn id, from anyone) means the
     agent was resumed and lifts it, on the turn start and, as a repair, on the next refresh (`holdSuperseded`,
     invariant `automatic-hold-is-not-stale`). A hold from before the interruption was recorded lifts on any
     main-agent turn. A hold the developer set stays until they resume; Resume and the `clear_hold` tool clear any hold.
   - A lost provider conversation sets `goneAgent` (`server/delivery.ts`, `conversationGone`), and Follow-up stops
     sending to that agent.
7. **Done label.** Paseo's Done label is set only when the label changes. On Paseo 0.17.1 and later the worker sets
   none: Done is a sidebar row badge drawn by the client, and a Done label set before the upgrade comes off once
   (invariant 113, `row-badges-replace-sidebar-labels`).

The repair wording follows the PR workflow ([prs.md](prs.md)): the review-fix command (e.g. `/fix-pr`), and GitHub
retargeting instead of Graphite restacks.

## Repairs (Q49, Q141)

A PR condition Follow-up finds (a conflict, review feedback, a failing required check, a restack) is a repair: a row in the
panel's Messages to the agent card, with the message it rides (`shared/task-rows.ts`, `client/messages.tsx`); the agent's own
tasks are a separate card (tasks-are-the-agent-s). On screen the two never share a word (Q141): every count or line
about a queued or sent message says "repairs" (`sendItems`, `shared/send-words.ts`: "2 repairs", "2 repairs and 1 task"
when an Auto task rides along), and "tasks" means the agent's list. The message the agent receives keeps its own
wording. Nothing
is stored per repair: a row comes from the message it rides (the pending or sent batch), the tasks `reconcile` held
back (`heldTasks`), or a settled message (Done). The batch is the internal delivery record and never shows.

- **One rule for every task in a message.** Repairs and Auto tasks (obligations with Auto and a due trigger) ride the
  same message and get the same states: Queued, Sent, Needs you (capped), Done. The Done check isn't a task: it stays
  "Ready to finish" in Needs you.
- **Say it once.** The strip at the top of the Messages to the agent card ("Next message to Billing fix · 4 tasks · sends at 14:32 · waits a
  minute so new changes join the same message", with Preview and Send now) carries when and why, from `sendDecision`.
  A row in the message says only Queued or Sent (invariant `message-rows-say-it-once`). Send now shows only where the
  server takes it (`canSendNow`) and the send doesn't wait on the developer (then Send lives in Needs you only). While
  sent, the strip reads "Sent to <agent> at 14:32 · N tasks · waiting for it to report back" with Open agent.
- **The cap is per task, and it is the only one.** A turn without an acknowledgment always settles its batch
  (completed + unacknowledged). An acknowledged `completed` whose PR condition GitHub still shows, read after the
  acknowledgment (`readSince`), goes out again too. A condition that went out `NO_PROGRESS_CAP` times unchanged,
  acknowledged or not, is held as `capped`: it stays out of the next message,
  shows its own Needs-you row ("Conflicts on #142 are still there after 2 messages", Retry and Open agent), and the
  rest of the queue keeps moving (invariant `a-capped-task-never-holds-the-queue`). Retry (`follow.control`
  `retryTask`, the `retry_batch` tool with `task`) records the sends so far in `taskRetries`, re-arming that one
  condition. 2.0 betas that blocked a batch for this are settled by `recover()`, and a message the retired "three
  batches" rule blocked before it went out is re-formed under the cap.
- **Auto per task.** The task sheet's Auto-send switch (`follow.control` `taskAuto`, the `set_auto_send` tool with
  `task`) adds the task key to `manualTasks`; `reconcile` holds it as `manual` ("Auto off · stays with you").
- **Done.** A task that went out and is gone from GitHub is Done: "Billing fix finished it" when acknowledged,
  "resolved on GitHub" when the turn ended without one. A task GitHub cleared before it was ever sent vanishes, so
  flapping checks never flood Done.
- **Preview.** `nextMessage` is the exact text the agent gets (the pending batch's task lines, no id line). The task
  sheet highlights the task's own line. `workspace_status` returns it as `nextMessage` with the recipient, the
  reason and when it goes, so an agent sees what the developer sees.
- The recipient is the main agent's Paseo title (`mainAgentTitle`, read with the runtime), else "the main agent".

## Status model

Background work is work (Paseo 0.16): any member's `backgroundWork.count > 0` sets `backgroundBusy`
(`server/daemon.ts` `observe`), so Done waits ("Wait for background agents and jobs to finish"; a declaration is kept
and accepted when it clears). Make main agent waits too (`checkMainClaim`). A repair waits only for the main agent's
own job, and only while Wait for background jobs is on (`mainBusy` `jobs`: "sends when the main agent's background job
ends").

Two scopes, one read (Q96 = A, 2026-11-18). `runtimeBusy` and `backgroundBusy` are the whole workspace: every
non-recovery member's turn and background work, and, only when Done, a sent message's turn or a Done check going out
needs it, the provider subagents of idle loaded members. They decide Done and its check (`QUIET_WAIT`), the status
lines ("Agent handling", Home's running group), a sent message's acknowledgment clock and how hot a workspace's PR
reads are, because each of those means "all work finished". `mainBusy` is the main agent's own work and decides only
repairs: the auto-send, the developer's Send, the queue's resolve and re-check, and an answer's ride-along.

`shared/status.ts` is the one place a user-facing status is computed. `batchView(w, now)` picks the batch that
describes Follow-up's work right now: its phase (`queued`, `sent`, `stuck`), who it waits on (the agent's
turn, the open batch, an idle agent Follow-up won't wake, setup, or you) and its one line. A queued batch's reason
and who it waits on come from `sendDecision`, never a copy of its rules. Home's bucket (`trackedGroup` in `shared/home.ts`), the header live line (`liveLine`) and Needs you
all read it (`agentCard` stays as a pure helper for the invariants; the panel no longer draws an agent card). Rules it encodes:

- "Main agent is on it" only while a batch is really sent; a queued one reads "Queued for the main agent".
- Home's "Sending" (it replaced "Follow-up is fixing") only for a message in flight or queued to go out without the
  developer; one that waits on the developer is in Needs you only (`sending-never-waits-on-you`).
- The Done check never auto-sends, so it waits on you: Needs you shows "Ready to finish · ask the main agent to
  declare Done" with **Ask to finish**, whether Auto is on or off. Done settles any open Done check
  (`settleDoneChecks`).
- A queued batch never claims it "sends when the agent is idle". Repairs Auto won't send because the agent is idle
  and unloaded wait on you: Needs you offers Send (`waits-on-you-means-needs-you`).
- The Done check uses one wording everywhere (`FINISH_WORD`, `FINISH_ASK`, `FINISH_LINE`) and its own icon, never
  a wrench or a green check. A stuck Done check reads "The Done check didn't go through", never "repairs"
  (`stuckLine`).
- A Done with an unconfirmed deploy says so in the header and live line, and both cards use `unconfirmedNote`.

The invariants in `shared/status-invariants.ts` check these over a grid of states
(`tests/status-invariants.test.ts`). After each refresh the worker runs `violations()` and appends changes to
`plugin-data/follow-up/status-diagnostics.jsonl` (`server/status-check.ts`, rotated at 256 KB).

## What each agent is working on

The panel and Home show each agent's line: what it is working on toward the workspace's goal, then its state.
"Capping the retry gap · 2 of 4", under it "Main agent · working 6m". One pure function builds it, `nowOf` in
[shared/now.ts](../shared/now.ts), for every surface and for agents (`workspace_now`), so they never disagree. The
line never shows a tool, file, command or to-do step, and it has no name on screen: no label, no placeholder. When
nothing is known, the state is the whole line.

**The work**, the first source that has one (`NOW_SOURCES`, invariant `the-line-takes-its-first-source`):

| # | Source | Example |
| --- | --- | --- |
| 1 | Work Follow-up handed the agent and it hasn't settled (a sent repair or task batch, while it runs) | "Fixing CI on #412", "Checking the work is finished" |
| 2 | What the agent stated: `sync_workspace` `milestone {now, done?, next?}` | "Capping the retry gap", 2 of 4 |
| 3 | The task it is working on (status working, `workingAgentId`, its agent working per `taskAgents`) | "E2E for the 60 s window" |
| 4 | Its one open PR, only when it owns exactly one | "#77 · In review" |
| 5 | A contributor's Paseo title (never the main agent's: that is the workspace) | "Retry tests" |

`shared/pr-status.ts` holds `prRowStatus`, the exact shared PR wording used by the list row and agent line,
and `prReference`, their shared reference formatter. The PR fallback uses the
PR row's words (Conflicts, Checks failed, Checking, Changes requested, In review, Approved, Draft, thread counts,
and Queued to merge). It keeps Shipping only without a complete status. A PR in the workspace project's own
repository shows #N; another repository, or an unknown workspace repository, shows owner/repo#N. Discovery
stores the project repository in `repo`, independently of owned PRs, so Home, the panel and `workspace_now`
use the same facts. The list row uses this same reference on compact and wide layouts; Home’s compact chip
keeps #N beside its qualified agent line, and its pending-check word is also Checking. Changes requested also
appears on the PR row, matching its detail sheet.

"2 of 4" comes only from the agent's own list: `done.length + 1` of `done + 1 + next`, no index to get wrong. Work
Follow-up sent is the line with nothing added. Not sources: the to-do list's in-progress item (the micro step, and
not every provider keeps one), a model call, and `sync_workspace`'s `summary` (a receipt).

**The state**: a pending permission ("Wants your OK · …"), an open stop question ("Asking you: …"), compacting,
working (since the turn started), a background job, waiting on CI for its PR,
idle (since its last activity), or closed. Unknown stays unknown: no made-up "Idle".

**Where it comes from.** The stated work is stored per agent on the workspace record (`milestones`), so the lists
and the panel read it with the rest of the workspace; it is cleared at Done and when the agent leaves the workspace.
The state reads the inbox row both the worker and the clients already hold (status, turn start, a permission,
background jobs) and the record (`mainBusy` compacting, `taskAgents`). Nothing here subscribes to a stream, reads
a timeline or wakes an agent. It works the same on every provider: the field rides the `sync_workspace` call (native
tool or the CLI bridge), and everything else is Follow-up's own state.

**Prompt cost.** About 40 words in `sync_workspace`'s schema (prompt-cached with the tool list) and one sentence in
the turn-end sync instruction ("Pass milestone when the milestone you're on changed."), on the hook and on
providers without one ([hooks.md](hooks.md)).

## Tasks (obligations)

**The developer's view: Agent's tasks** (`shared/task-view.ts`, `client/tasks.tsx`, invariant `tasks-are-the-agent-s`).
Tasks are the agent's to-do list, so the panel folds them to one line by default, in every state: "Agent's tasks ·
6 open · 2 due · 1 stale". Due is the agent's normal work and stays neutral; only stale (due, nudged twice, no answer)
is amber. Opened, a row per open task: a glyph per kind of move (a dot for due, amber for stale, a PR for "After #232
merges", a calendar for a re-check, a pause for blocked, a hand or question bubble for one in Needs you), the title, and
one line saying what moves it (`taskViewRows`). Stale and due come first, oldest first, each with the agent's note under
it; a task waiting on the developer reads "In Needs you" (no question id) and opens it there, and comes last. A row
opens in place: the whole note, its agent, and "Send on a schedule…", the developer's override (`update_obligation`
`trigger` is the agent's way). Finished tasks leave the card for Activity ("Task done · …", with the evidence); the
footer says "3 finished this week · in Activity". The send queue and the repairs are the Messages to the agent card
(`client/messages.tsx`). The header's live line names the task the agent owes ("Due: …", "Stale: …") before any
waiting one, and a waiting one says what moves it ("Check alert emails in staging · after #232 deploys").

- **Who is working on a task** (invariant `a-task-only-says-working-when-its-agent-is`). `update_obligation` with
  `status: working` records the calling agent as `workingAgentId`, or the agent it names with `workingAgentId` (an
  orchestrator's subagent; refused unless Paseo knows that agent). The record keeps it after the task moves on, and
  `workspace_status` shows it. The task row and the Task sheet never read "working" off the stored status: their line
  comes from `taskStatus` (`shared/task-status.ts`), which names that agent and its live state from
  `taskAgents` on the workspace (Paseo's agent directory, metadata only, so nothing is woken): "<title> working" (spinner),
  "<title> idle", "<title> closed" ("Agent closed" when the name is unknown) or "<title> archived". With no agent recorded it reads "In
  progress"; with a recorded agent whose live state isn't known (not read yet, or Paseo doesn't list it) it reads
  "Agent unavailable": words only, no live state, no link. While the agent is open (working or idle) the row has **Open agent** and the sheet an **Open agent**
  button, which open its chat. Paseo reads an agent "closed" whenever its session ends (the idle unload, about an hour,
  and every plugin reload), so a closed agent keeps the link, as "Open chat": opening it is the developer's own tap,
  and Follow-up never reads, prefetches or previews it. Only an archived agent (or one Paseo no longer lists) is words
  only. Paseo's agent list leaves archived agents out, so the directory remembers the archived ones it has seen
  (`DaemonDirectory.withArchived`) and looks up a named agent it lacks once (`lookup`; see
  [client.md](client.md#created-agent-and-workspace-cards)). One table, `PRESENCE` in `shared/task-status.ts`, sets the word and the link for task lines and chat cards. The engine refreshes `taskAgents` with
  `runtimeBusy` on every tick (`Gateway.observe`, `taskAgentStates` in `server/tasks.ts`), so every surface that
  derives "working" from a task reads the same states (invariant `a-task-only-says-working-when-its-agent-is`): the
  panel's live line spins on a task only while its agent runs, and otherwise reads "<task> · <the row's words>"; the
  summary says "Agent handling" (Home's Agent working) only for a running agent, never for the stored status alone.

- **Writing tasks.** `update_obligation` writes tasks (`server/obligations.ts`). `afterPrs` uses `owner/repo#number`
  keys.
- **Duplicates at write time** (invariant `a-new-task-is-checked-once`, `shared/task-dup.ts`). A write without an id is
  checked once against the workspace's open tasks, by token Jaccard on the first 60 characters of the titles. The same
  agent's exact whole title updates its task (a repeated write); a similar one (0.5 or more) is refused with up to 3 lines,
  `Similar open task: <id> "<title>" (<status>). Update it by id, or pass new=true for a separate task.`, and `new: true`
  adds it anyway. Clean writes add nothing. Renames keep the id and are never checked.
- **Triggers** (`shared/task-trigger.ts`): `now`, `merge` or `deploy`, with an optional `delayDays`, or `at`, a time.
  Deploy state comes from `server/deployments.ts` and `server/deployment-anchor.ts`, only for configured repositories;
  elsewhere it stays unknown. now, merge and deploy join the next message as obligation tasks and follow Auto-send.
- **Scheduled tasks** (`at`; `server/scheduled-tasks.ts`, invariant `a-scheduled-task-arrives-once-at-its-time`). The
  agent passes `trigger: {event: "at", at: "<ISO time with offset>"}` or `{event: "at", inMinutes: N}` to
  `update_obligation` or `set_task_trigger`; the developer picks At a time in the task's Send on a schedule sheet
  (quick picks, or a date and time on their own clock). `storedTrigger` keeps it in UTC, at least a minute out and at
  most 30 days (later is a `recheck` day); an offset is required, so the zone is never a guess. It needs no PRs. It is
  never a batch task (`taskSchedule` is never ready for it): after each engine pass `ScheduledTasks.evaluate` finds
  every due time, saves one `scheduled` queue message to the main agent (`Follow-up scheduled task <id>, set for
  <ISO>: <title>`, then where it stood and what to do), and marks the trigger `queuedAt`; the queue's channel marks
  `sentAt` when it leaves and `notSent` when it is cancelled. It goes whether Auto-send is on or not: someone named the
  time (the developer, or the agent for its own check-back on a waiting task). A running turn is waited out; an idle
  agent is messaged even unloaded (`closed`): Paseo reopens it, as with `wait_for_checks`. An archived workspace,
  archived agent or gone agent cancels, and the row says why ("Didn't go out · the agent was archived") in amber.
  Old stored cancellation reasons stay as recorded. The engine's untouched-pass skip ends at the earliest due time
  (`nextDue`), so it fires within a tick and never before; a worker down at the time fires it once on its first pass,
  and the message says it is late. Paused with the rest of background work while the governor holds it. Developer
  lines (row "Sends 12:15", then "Sent 12:15"; the live line and Home's Waiting row "<title> · checks back 12:15")
  use the device's clock; what an agent reads is ISO. Once it went out, due by fact holds the task again.
- **Due by fact** (`shared/task-due.ts`, invariant `due-by-fact`). Every open task knows what moves it, and none is
  "Manual". With `afterPrs` it comes due when every PR reaches `dependencyStage` (merged, or deployed; a repository
  with no deploy target counts its merge), or when one closes unmerged. With no PRs it comes due on `recheckAt`: the
  agent's `recheck` ("YYYY-MM-DD"), else 3 days (`RECHECK_DAYS`) after its last `update_obligation`; a later `recheck`
  also holds a PR-made fact. A task blocked on a question the developer already answered or closed (`coveredBy`,
  `waitsOnDeveloper`) comes due at that answer ("Due · Q7 answered"): the agent acts on it and moves the task. A task
  still waiting on the developer (Needs you has it; it gets no default re-check) or on a trigger that hasn't sent it
  yet (it is sent as a message) is left out. Due is a nudge, never an auto-send and never a done: the worker lists each agent's
  due tasks in `scopes.json` (`dueByAgent`: the task's working contributor and the main agent, oldest first, at most
  5), and the Stop hook names at most 3 whose time passed (`pickNudges`), each at most twice for the same fact and
  revision and at most once a day, sharing `hook-state/task-nudges-<workspace>.json`: "Task <id> "<title, 60 chars>":
  #231 deployed. Do it and close it with evidence, or keep it with recheck="YYYY-MM-DD" and why." Nothing due adds
  nothing. Every 10 minutes the worker reads that receipt into each task's `nudged` (`maintainTasks`); two nudges with
  no change to the task make it **stale** (`isStale`: "Stale · #231 deployed · nudged twice, no answer"), and it is
  never closed for the agent (only a supersede by id waives one). The task row says the moving fact: "Due · #231
  merged", "After #232 merges", "Re-check Nov 25", "Due since Nov 22" (`dueLabel` through `taskSchedule`). The same pass stamps tasks from
  before due-by-fact (a re-check 3 days out, `finishedAt` now) and prunes finished tasks 30 days after `finishedAt`
  unless something still reads them (`pruneBlocked`): every task finished in a workspace not yet declared done (the
  completion batch's fingerprint lists every task), an unsettled batch carrying it, an open question naming it.
  Batches and Activity keep their own copy of a task's title.
- **Lifecycle-only tasks.** `shared/follow-up.ts` drops approve, merge and deploy checklist tasks (`lifecycleOnly`),
  and decides `deployed` and recovery batches. `server/deployment-anchor.ts` pins the merge commit a deploy was
  seen for.
- **Communication receipts** (`shared/communication.ts`): stakeholder replies need the developer's authorization and
  a sent-message receipt.
- **Questions from blocked tasks.** Only a task blocked on the developer asks them something: `status: "blocked"` with
  `ask`, the question they must answer (`blockedOnDeveloper`, `shared/model.ts`). It becomes a question that asks exactly
  that, never the task's evidence (`syncTaskQuestions`). A task blocked without an ask waits on a PR or another agent:
  it shows as Blocked in Tasks and never reaches Needs you or the workspace's Needs you status; agents should use
  `waiting` for that, and the hook says so. Leaving blocked, dropping the ask or changing it closes the open question.
  An ask set while blocked is kept by blocked updates that leave it out. Invariant
  `a-question-always-asks-the-developer-something` (`tests/task-question-asks.test.ts`): 2026-11-12, Q48 put a task's
  evidence in the developer's Needs you as a question with no options while the task waited on a PR.
- **One decision, one card** (`one-decision-one-card`). A blocked task makes a card only when no question already asks
  its decision. `findTaskCover` (`shared/questions.ts`) looks for one the ask names ("Q1: may I …?", or
  `update_obligation` `question: "Q1"`, which also writes the ask), one asked with `task` set to it, or an open one that
  reads the same (`findOpenMatch`); a superseded question is followed to its replacement and a withdrawn one covers
  nothing. `syncTaskQuestions` records it on the task (`coveredBy`), closes a card the task made before as "Already asked
  as Q1." (or "Already answered as Q1."), and Needs you shows no decision item for it. An answered question keeps
  covering the task while its ask is unchanged: the agent has the answer and moves the task, so the task reads "Due · Q1
  answered" in Tasks (due-by-fact) and doesn't count as the developer's (`waitsOnDeveloper`, `shared/model.ts`).
  A changed ask drops the cover and looks again. `update_obligation` says "Already asked as Q1" (or answered) in its
  reply's `note`, and `ask_question` and `needs_you` run the sync at once, so a card the task made closes when the
  richer question arrives. 2026-11-22, Tom: "a lot of the time, 2 questions are created for the same thing"; live data
  had 33 of 96 task-made questions repeating an `ask_question` question, 19 while it was open and 13 after it was
  answered. Guarded by `tests/one-decision-one-card.test.ts` and `INVARIANTS`.
- **One ask, one item** (`one-ask-one-item`). A blocked task's card is shaped by what its ask wants (`taskNeed`,
  `shared/questions.ts`): a decision keeps the free answer, and an action the developer takes and reports back ("Share
  the decision page with alice and tell me when they've picked") gets one Done option (`TASK_DONE`), with Something else
  for anything more, never "Write the decision for the agent". `update_obligation` `need` says which; without it the ask
  decides (it asks to be told when something is done, or opens with something to do and asks no question). A card from
  before that framed an action as a decision is reshaped in place and keeps its id. The agent's turn-end brief folds into
  the task's card instead of standing beside it: `needsYouQuestions` points an action or decision `needs_you` at every
  open task card it names ("Q3") and every card it restates (`taskCardsFor`: half of the card's words; for a card made
  during that turn, `turn.at`, where the agent blocked the task and is reporting it, two shared words and 0.3 of the
  card's words), as `questions: ["Q3"]` would, so `needsYouBlock` draws the card once with the brief's context. A card
  the brief doesn't name or restate never hides it, even one made in the same turn: both show. The fold is the server's, so `update_obligation` says nothing about the task's own
  card: the agent reads zero extra words. An action card is answered by one Done button (`isDoneOnly`) in the panel, on
  Home and in the chat brief, never an option to pick and then Send; a brief's Done on it answers the card (A).
  2026-11-22, the developer: an Action brief and its blocked task's card showed the same ask,
  and the card read "Write the decision" for an action; live, 7 of 9 open task cards sat beside an open action or
  decision brief from the same agent, and none was pointed at. Guarded by `tests/one-ask-one-item.test.ts` and
  `INVARIANTS`.
- **The activity log.** `shared/activity.ts` builds it from stored state.

## Questions

- `server/questions.ts` and `shared/questions.ts` (adapted from Progress): refs Q1, Q2…, lettered options, a
  recommendation, and what the agent does while it waits.
- The question mode (Stop, Work around, Keep building) is a host setting, `questionPreferences`.
- Answers from the UI go through `follow.answer-question`: Send, Copy, Put in chat (`chat`, Paseo 0.16) or Resend.
  Copy and Put in chat record the answer as `copied` or `in-chat` and send nothing; it waits in Needs you until it is
  delivered ([needs-you.md](needs-you.md#answers-waiting-to-be-sent)). Send and Resend go through the message queue
  (below): an answer the agent can't take yet waits there and goes out on its own.
- Answers given in chat are recorded with `record_answer`.
- **Something else on every question with options.** A built-in last choice, recorded as `choice: "other"` with
  required words; agents never add it. The agent gets `Follow-up answer Qn (title): Something else — "words"`, and a
  multi-decision brief keeps one line per decision. `answer_question`, `record_answer` and `brief_action` accept
  "other" and refuse it without words. `answerLabel` in `shared/questions.ts` is the one way a surface names an
  answer. Tests: `tests/something-else.test.ts`.
- **One identity per open question.** Every path that creates a question first asks `findOpenMatch` in
  `shared/questions.ts`. That covers `ask_question`, `needs_you` decisions, and a retry after a reload.
  - The matcher is deterministic: normalized title and question tokens plus option-label overlap. It makes no model
    call.
  - Candidates are the same workspace's open questions from the same asker, plus `needs_you` ones. Another agent's
    question matches only when it's near-identical. Blocked-task questions keep their own identity.
  - Outcomes (`outcome` in the `follow.ask-question` reply, with `of`):
    - `duplicate`: the same question returns the open one ("Already open as Qn").
    - `superseded`: changed options replace it. An agent can also pass `supersedes: "Qn"` to replace one
      explicitly.
    - `asked`: a new question.
  - Two versions are never open at once. The invariant is `no-duplicate-open-question`
    (`duplicateOpenQuestions`). Tests: `tests/question-dedupe.test.ts`.

### Dismissing a question

A question that no longer matters can be dismissed instead of answered (invariant
`dismissing-a-question-sends-the-agent-nothing`): the small x every Needs-you item has (docs/needs-you.md#dismiss), on every
open question card (the panel's Needs you, Home's detail pane, the question dialog, the pill, phones and Catch up, where
⇧D does it), and the `dismiss_item` / `dismiss_question` agent tools for another agent's question. `follow.dismiss`
(key `question:Qn`; `follow.dismiss-question` for the alias tool) closes it as dismissed
(`closed.dismissed`, `closed.by` "developer" or "agent:<id>"; `dismissQuestion` in `server/questions.ts`) and queues and
sends nothing, so the agent spends no turn and no tokens on it. It leaves Needs you and every count at once; the toast's
Undo (`undo: true`) reopens it exactly as it was. The card reads "Dismissed by you" (`closedLine`), never an agent's
"Withdrawn"; a brief whose questions were all dismissed closes as "You dismissed this question".

The agent learns only when it looks: `workspace_status` lists `dismissedQuestions`; pointing at one with `needs_you`
questions=["Qn"] is refused with why; restating it as a needs_you decision leaves it off the card (the call's `note`
says so); and asking it again with `ask_question` returns the dismissed question with outcome `dismissed` and no new
card, so an agent can't bring it back by asking again. `supersedes="Qn"` is the way to ask again on purpose when
something really changed. A blocked task's question that is dismissed isn't asked again for the same block; the task
stays blocked, since a task's state is the agent's (it can update or waive it), and a new block asks anew. An agent
can't dismiss a question it asked or owns: that is `withdraw_question`.

## Spec link

`server/spec.ts` and `shared/spec.ts`. Precedence: the developer's link (`follow.workspace-spec`), then the main
agent's `set_spec`, then detection. Detection reads completed Claude Artifact publish receipts in root sessions,
never page content or chat links.

## Done

`completionGate` in `shared/model.ts` lists what stands between a workspace and Done; `completionBlockers` is the
text view of it. Each blocker has an owner:

| Owner | Meaning |
| --- | --- |
| `agent` | The main agent can fix it with its tools: record a task, acknowledge a batch, withdraw a question. |
| `developer` | It needs the developer: merge, answer, resume, check a PR action. |
| `wait` | It's time, or Follow-up's own observation: the agent is busy, a deploy rollout, a status refresh. It never revokes a Done. |

`engine.declareDone` (`follow.done`) works like this:

- **Accepted.** With no blockers, it records `completion`. The reply's `next` (`doneGuidance`) tells the agent
  whether anything is its to fix and when not to call again. Repeating the call is a no-op (`alreadyDone`).
- **Stored for later.** When only `wait` blockers remain, it keeps `declaration`, and the engine records Done on its
  own once they clear (`acceptDeclaration`). Nobody retries.
- **Unconfirmed deploys don't block.** A deploy Follow-up can't confirm is recorded with the note "Deploy not
  confirmed by Follow-up" (`completion.unconfirmed`, `unconfirmed` in the reply), with the agent's summary as
  evidence.
- **Revoking Done.** `revokesDone` takes a Done back only for new work or contrary evidence (a rollback), never for
  waiting or observation gaps.
- **Hysteresis.** A queued Done check survives the agent's own turns, and completion checks never auto-send.

Done labels (or, on Paseo 0.17.1+, badges) the workspace but never archives it. Tests: `tests/done-loop.test.ts`.

## Deploy state and the latch

`deployState` in `shared/follow-up.ts` returns one of:

- `none`: not merged, or no deploy target;
- `deployed`;
- `not-deployed`: a fresh probe saw a pending or partial rollout;
- `unconfirmed`: a deploy target exists but nothing was confirmed.

The latch: once Follow-up has seen a merge commit serving, `server/deployment-anchor.ts` records `deploymentAnchor`.
After that, a probe error or a stale observation (older than `DEPLOY_FRESH_MS`, 2 min) never turns it back. Only
fresh contrary evidence does.

`server/deployments.ts` summarizes probe failures with `probeReason`. It keeps its own messages and reduces anything
else to "gcloud call failed", "gh call failed", "unreadable response", "read timed out" or "lookup failed", so no
transport detail leaks. The reason goes into the PR's evidence line and `lastError`. A failed read retries on the next
15 s refresh, and isn't cached for a minute.

## The message queue

`a-message-is-saved-before-sent-and-arrives-once` (`server/message-queue.ts`, `shared/queue.ts`). Every message
Follow-up sends an agent for the developer goes through one durable outbox, `queue.json`, and one sender per workspace.
Kinds: Q answers (`Engine.answer`, `answer`), brief answers (`Inbox.briefAction`, `brief`), repair batches and Done
checks (`Engine.sendPending` and auto-send, `repair`), recovery (`recovery`, its agent made when it goes out), and
Overseer forwards and reports handed to an agent (`message`).

**Delivery receipts (Paseo 0.17.2+).** `sendMessage` there answers with a receipt (`deliveryStatus: "queued"` when
Paseo holds the message until the agent's running turn ends, `activeTurnBehavior` for what it did with the turn: Follow-up
asks to steer, a provider that can't falls back, `guidance`). `PaseoGateway.deliverTo` returns it with the recipient,
and the queue keeps it on the item (`receipt`, shown by `queue_list`), the batch and the answer's delivery
(`deliveryReceipt`, kept only when it says something). Every card words it one way: "Queued" with "Paseo holds it until
the agent's current turn ends." for a held message, "Sent" plus "The agent's turn was stopped so it could read it." for
a steer that fell back to interrupt (`deliveryStatus`, `receiptNote` in `shared/queue.ts`). Paseo 0.17.1 and older
answer nothing, and nothing changes. A harness on an older host can render the wording with
`FOLLOW_UP_HARNESS_RECEIPT` (`check-message-queue.mjs --receipt`), honoured only under the temp dir.

- **One message per agent.** Everything due for one agent goes as one envelope, answers first, each part with its own
  header and contract, separated by a line holding only `---` (`ENVELOPE_SEPARATOR`, `envelopeParts` in
  `shared/queue.ts`). A lone part keeps its own messageId; several share one derived from their ids. The chat splits an
  envelope back into a card per part (`client/chat.tsx`), and the hook's SessionStart text tells agents the format
  (`ENVELOPE_GUIDANCE`, `server/agent-hook.mjs`; `tests/message-envelope.test.ts` holds the two together).
- **Priorities.** Answers and forwards (`now`) never wait behind repairs and steer into a running turn. Repairs
  (`idle`) go only to an idle main agent: `resolveRepair` reads the agent when it goes out and defers while it is busy;
  the engine's tick retries a deferred repair as soon as it sees the agent idle. **Ride-along:** an answer going to an
  idle main agent takes the pending repair with it when `sendDecision` would send it but for its settle window (and the
  idle-agent wait, since the answer resumes the agent anyway); never the Done check, a hold, Auto off, an open message
  or unread PRs. One turn instead of two.
- **No Paseo call on the reply.** Send on a message, Retry, a Q or card answer, an Overseer forward and a report handed
  to an agent reply once the item is saved. What needs fresh state (the agent idle, tasks still due, the recovery
  agent made) runs in the sender; a refusal lands on the batch (`refusal`, "didn't send: …").

- **Saved before sent.** An action records its answer, adds a queue item and replies; it never waits on Paseo. The
  sender marks the item `sending` with the envelope's messageId and waits for that one write before Paseo hears of it.
  The outcome rides the next coalesced write.
- **Quiet window.** A workspace's items go out once it has been quiet `QUEUE_QUIET_MS` (2 s), at most `QUEUE_CAP_MS`
  (8 s) after the first, so a stream of clicks can't starve one. A timer exists only while a workspace has an item due.
- **Recipient at send time.** `Channel.resolve` picks the agent when the envelope goes out (`answerRecipients` for a
  Q answer): an answer whose asker was archived or replaced reaches the workspace's main agent. A workspace archived or
  no longer followed cancels it, with the reason on the card ("Not sent").
- **Never left: never fails.** Paseo unreachable, no agent available, a permission prompt or Session Guard: nothing
  was sent, so it waits as Queued ("Queued: Paseo unreachable. Next try at 12:04.") and goes at once on worker start.
  Paseo unreachable: it goes out within about 15 s of Paseo coming back. While anything waits so, one connect-only
  probe (`PaseoGateway.probe`: the worker's one connection, no agent read, so nothing wakes) runs every `PROBE_MS`
  (15 s), every `PROBE_SLOW_MS` (60 s) once the outage passes 10 min, and stops the moment nothing waits; a probe that
  connects, or any connection the worker opens for anything (`onDaemonReconnect`), sends them at once. The other
  reasons wait on `NEVER_LEFT_MS` (15 s, 1 min, then every 5 min).
- **Left unconfirmed: read the chat first.** An error after the message went out, or the attempt's 2-minute deadline,
  makes it `uncertain` (Retrying). Paseo doesn't refuse a resend by messageId, so before any resend `arrivedMessage`
  (`server/daemon.ts`) looks for it: a loaded agent's timeline by clientMessageId, an unloaded agent's provider
  transcript on disk by its first line, read back from its end to the send (`markerInFile`, at most
  `MARKER_READ_MAX_BYTES`; never waking it, and "not there" only when the read reaches back past the send). Found:
  Sent. Not there: resent. Unknown: the next `AMBIGUOUS_MS` step (15 s, 1 min, 5 min, then every 15 min), never Failed
  (`a-queued-message-never-stops-short`). Every unconfirmed resend climbs the same ladder, so an agent Paseo can't
  load yet isn't sent to every 15 s. A loaded agent whose timeline read can't tell (a busy one) falls back to the same
  transcript search. A messageId Paseo refuses for good (a stuck receipt or a key conflict, `idRefused`) is replaced
  by a fresh derived id on the resend that follows a "not there", and the check looks for every id the item used
  (`sentIds`).
- **Failed means gone.** Only a send whose agent's conversation is gone (`ConversationGone`) ends Failed, with
  `GONE_REASON` and Retry, which resends without asking. A Failed item from an older version whose target isn't gone
  goes back to checking when the worker loads the queue.
- **A reload mid-send** reads `sending` back as `uncertain`, so the chat is checked before it goes again.
- **Small file.** Sent and cancelled items leave `queue.json` once their record shows it; the newest `QUEUE_RECENT`
  stay, without text.
- **One vocabulary.** `deliveryStatus` words every card: Sending…, Queued (with when), Retrying ("Next try at 12:04"), Failed with
  Retry, Not sent, Sent. Records keep a mirror of their item (`deliveryOf`): `answer.delivery` on a question,
  `brief.delivery` on a card.
- **Upgrade.** `Engine.adoptAnswers` (every start, idempotent) and `Inbox.adoptOutbox` (once) move 2.0's in-flight
  answers onto the queue: `unconfirmed` and `sending` ones as `uncertain`, so nothing is sent twice across the upgrade.
