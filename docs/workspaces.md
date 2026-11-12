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
   (`runtimeBusy`, `backgroundBusy`, `runtimeReason`, `sendWait`, PR reads, the batch's last refusal). It sends when:
   - Auto-send is on, nothing is held, and the agent isn't dormant or gone.
   - The batch has no completion check.
   - The main agent is loaded and recently used (else `sendWait` is `unloaded`), not busy, and has no background work.
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
     `reconcile` doesn't count as delivered). Once one unchanged condition (same task key and fingerprint) has gone
     out `NO_PROGRESS_CAP` (2) times without an acknowledgment, the batch is `blocked` with that reason, and only then
     does Needs you offer Retry (invariant `retry-only-when-capped`). A refused acknowledgment still blocks.
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
7. **Done label.** Paseo's Done label is set only when the label changes.

The repair wording follows the PR workflow ([prs.md](prs.md)): the review-fix command (e.g. `/fix-pr`), and GitHub
retargeting instead of Graphite restacks.

## Repairs are tasks (Q49)

A PR condition Follow-up finds (a conflict, review feedback, a failing required check, a restack) is a task row in the
workspace's Tasks, next to the developer's and agents' own tasks (`shared/task-rows.ts`, `client/tasks.tsx`). Nothing
is stored per repair: a row comes from the message it rides (the pending or sent batch), the tasks `reconcile` held
back (`heldTasks`), or a settled message (Done). The batch is the internal delivery record and never shows.

- **One rule for every task in a message.** Repairs and Auto tasks (obligations with Auto and a due trigger) ride the
  same message and get the same states: Queued, Sent, Needs you (capped), Done. The Done check isn't a task: it stays
  "Ready to finish" in Needs you.
- **Say it once.** The strip at the top of Tasks ("Next message to Billing fix · 4 tasks · sends at 14:32 · waits a
  minute so new changes join the same message", with Preview and Send now) carries when and why, from `sendDecision`.
  A row in the message says only Queued or Sent (invariant `message-rows-say-it-once`). Send now shows only where the
  server takes it (`canSendNow`) and the send doesn't wait on the developer (then Send lives in Needs you only). While
  sent, the strip reads "Sent to <agent> at 14:32 · N tasks · waiting for it to report back" with Open agent.
- **The cap is per task.** A turn without an acknowledgment always settles its batch (completed + unacknowledged).
  A condition that went out `NO_PROGRESS_CAP` times unchanged is held as `capped`: it stays out of the next message,
  shows its own Needs-you row ("Conflicts on #142 are still there after 2 messages", Retry and Open agent), and the
  rest of the queue keeps moving (invariant `a-capped-task-never-holds-the-queue`). Retry (`follow.control`
  `retryTask`, the `retry_batch` tool with `task`) records the sends so far in `taskRetries`, re-arming that one
  condition. 2.0 betas that blocked a batch for this are settled by `recover()`.
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

Background work is work (Paseo 0.16): the main agent's `backgroundWork.count > 0` sets `backgroundBusy`
(`server/daemon.ts` `observe`), so no repair is sent into it ("sends after the agent's background work"), and Done
waits ("Wait for background agents and jobs to finish"; a declaration is kept and accepted when it clears). Make main
agent waits too (`checkMainClaim`).

`shared/status.ts` is the one place a user-facing status is computed. `batchView(w, now)` picks the batch that
describes Follow-up's work right now: its phase (`queued`, `sent`, `stuck`), who it waits on (the agent's
turn, the open batch, an idle agent Follow-up won't wake, setup, or you) and its one line. A queued batch's reason
and who it waits on come from `sendDecision`, never a copy of its rules. Home's bucket (`trackedGroup` in `shared/home.ts`), the header live line (`liveLine`) and Needs you
all read it (`agentCard` stays as a pure helper for the invariants; the panel no longer draws an agent card). Rules it encodes:

- "Main agent is on it" only while a batch is really sent; a queued one reads "Queued for the main agent".
- "Follow-up is fixing" only for work in flight or about to auto-send.
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

## Tasks (obligations)

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
- **Triggers** (`shared/task-trigger.ts`): `now`, `merge` or `deploy`, with an optional `delayDays`. Deploy state
  comes from `server/deployments.ts` and `server/deployment-anchor.ts`, only for configured repositories; elsewhere
  it stays unknown.
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
- **The activity log.** `shared/activity.ts` builds it from stored state.

## Questions

- `server/questions.ts` and `shared/questions.ts` (adapted from Progress): refs Q1, Q2…, lettered options, a
  recommendation, and what the agent does while it waits.
- The question mode (Stop, Work around, Keep building) is a host setting, `questionPreferences`.
- Answers from the UI go through `follow.answer-question`: Send, Copy or Resend. An answer the agent can't take yet
  queues, and the engine delivers it on a later tick.
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

Done labels the workspace but never archives it. Tests: `tests/done-loop.test.ts`.

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
else to "gcloud call failed", "gh call failed", "unreadable response", "registry timed out" or "lookup failed", so no
transport detail leaks. The reason goes into the PR's evidence line and `lastError`. A failed read retries on the next
15 s refresh, and isn't cached for a minute.
