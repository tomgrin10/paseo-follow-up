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
4. Auto-sends a pending batch only when all of these hold:
   - Auto-send is on, nothing is held, and the agent isn't dormant or gone.
   - The batch isn't a completion check.
   - The main agent is loaded and recently used, not busy, and has no background work.
   - No other batch is in flight, and 60 s have passed since the batch was created.
   - PR observations are complete.
   - Setup isn't holding auto-sends.

   Otherwise the batch waits for the developer's Send (`follow.send`). The worker persists why it held an
   auto-send for an idle-but-unloaded agent or for setup in `sendWait` (written only when it changes), so the status
   model can say the real reason.
5. Batch states: `pending` → `sending` → `sent` → acknowledged (`acknowledge_batch`), or `blocked` or `uncertain`.
   - A sent batch with no acknowledgment after 2 idle minutes becomes `blocked`.
   - A reload mid-send makes it `uncertain` (`engine.recover()`).
   - Never-sent cancelled batches are pruned to `archive/` (`server/batch-archive.ts`).
6. **Holds.** A canceled or failed main-agent turn sets `hold`, unless Session Guard owns the interruption
   (`server/session-guard.ts`, `sessionGuardOwnsInterruption`). A lost provider conversation sets `goneAgent`
   (`server/delivery.ts`, `conversationGone`), and Follow-up stops sending to that agent.
7. **Done label.** Paseo's Done label is set only when the label changes.

The repair wording follows the PR workflow ([prs.md](prs.md)): the review-fix command (e.g. `/fix-pr`), and GitHub
retargeting instead of Graphite restacks.

## Status model

`shared/status.ts` is the one place a user-facing status is computed. `batchView(w, now)` picks the batch that
describes Follow-up's work right now: its phase (`queued`, `sent`, `stuck`), who it waits on (the agent's
turn, the open batch, an idle agent Follow-up won't wake, setup, or you) and its one line. It mirrors the auto-send
rules above. Home's bucket (`trackedGroup` in `shared/home.ts`), the header live line (`liveLine`), the panel's agent
card (`agentCard`) and Needs you all read it. Rules it encodes:

- "Main agent is on it" only while a batch is really sent; a queued one reads "Queued for the main agent".
- "Follow-up is fixing" only for work in flight or about to auto-send.
- The Done check never auto-sends, so it waits on you: Needs you shows "Ready to finish · ask the main agent to
  declare Done" with **Ask to finish**, whether Auto is on or off. Done settles any open Done check
  (`settleDoneChecks`).
- A queued batch never claims it "sends when the agent is idle".

The invariants in `shared/status-invariants.ts` check these over a grid of states
(`tests/status-invariants.test.ts`). After each refresh the worker runs `violations()` and appends changes to
`plugin-data/follow-through/status-diagnostics.jsonl` (`server/status-check.ts`, rotated at 256 KB).

## Tasks (obligations)

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
- **Questions from blocked tasks.** A blocked task becomes a question (`syncTaskQuestions`).
- **The activity log.** `shared/activity.ts` builds it from stored state.

## Questions

- `server/questions.ts` and `shared/questions.ts` (adapted from Progress): refs Q1, Q2…, lettered options, a
  recommendation, and what the agent does while it waits.
- The question mode (Stop, Work around, Keep building) is a host setting, `questionPreferences`.
- Answers from the UI go through `follow.answer-question`: Send, Copy or Resend. An answer the agent can't take yet
  queues, and the engine delivers it on a later tick.
- Answers given in chat are recorded with `record_answer`.
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
