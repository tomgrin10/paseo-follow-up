# Wait for checks

Agents often find out when CI finished by polling GitHub: `gh pr checks --watch`, `gh run watch`, or a `while`/`sleep`
loop around `gh pr checks`, `gh pr view` or `gh api`, every few seconds, often inside a background shell or a Monitor.
Each loop spends the developer's GitHub budget, the same 5000 points an hour Follow-up, gt and every other agent share.
Follow-up already reads every tracked PR, so it tells the agent instead.

## The tool

`wait_for_checks({ prs?, minutes?, cancel? })` (RPC `follow.wait-for-checks`, `server/wait-for-checks.ts`). Every root
agent gets it: the main agent, contributors and untracked root agents; recovery sessions don't. It acts only on the
caller's own workspace (the caller is `context.agent.id`; there is no `agentId` input).

1. `prs` are URLs, `owner/repo#N` or numbers; none means every open PR of the caller's workspace. A GitHub PR of the
   caller's that Follow-up doesn't follow yet is registered through `register_pr`'s own path first (its stack can be
   fixed with `register_pr` later).
2. It records one watch per PR (`server/check-watches.ts`, `check-watches.json`) and nudges the caller's workspace
   (`engine.nudge`): one read of its due PRs, where each watched PR is due once after its wait began, usually a probe.
   It waits at most `ANSWER_READ_MS` (8 s) for that read.
3. It answers at once: a PR that already merged, closed, conflicts, failed, or whose checks already finished
   (seen running and finished, or a head quiet for `WATCH_SETTLE_MS`) is answered in the reply, and its watch ends.
   The rest are "waiting": the agent ends its turn.
4. After that, every engine pass judges the watches of the workspaces it read (`CheckWatches.evaluate`, from
   `Engine.afterPass`). A verdict is one `checks` message on the queue (invariant 36), sent after the agent's turn:
   - all checks passed on the current head (and whether a required check hasn't reported yet);
   - which failed, with their names and the PR's checks link; a required check failing goes out at once, other
     failures once nothing runs;
   - merged, closed, or a merge conflict, whichever comes first;
   - the time limit ran out (3 h by default, at most 12 h, like Wait's jobs).
5. One-shot: a verdict, the PR leaving the workspace, or `cancel: true` ends the watch. Asking again for the same PR
   restarts its clock.

Only a read made after the watch began decides anything (`watchVerdict`, `shared/check-watch.ts`): an older read may
predate the agent's push. "All passed" needs the checks to have been seen running on that head, or the head to have
been quiet for `WATCH_SETTLE_MS` (60 s), because right after a push GitHub can list a head with no check suites yet.

### Reviews

The watch is about checks. Review comments keep flowing through repairs (Auto-send on) or Needs you (Auto-send off);
the watch doesn't fire on them. An agent waiting on checks with Auto-send off isn't working on review comments anyway,
and the developer decides when those go out.

## Rules

- **Waiting for checks adds no GitHub read** (`waiting-for-checks-adds-no-github-read`). The watch reads nothing
  itself: it judges the observations the engine's passes already made. A watched PR counts as due at the running-checks
  cadence (`watchedSince` in `dueForRead`, `shared/poll.ts`): once after its wait began, then at most every 30 s (2 min
  once checks run past 10 min), as a probe unless the probe sees a change, and never past the reserve or for a merged
  or closed PR. Guarded by `tests/wait-for-checks.test.ts`.
- **A requested verdict reopens an unloaded agent** (`a-requested-verdict-reopens-an-unloaded-agent`, renamed from
  `a-watch-never-wakes-a-closed-agent`). Paseo's `closed` means the runtime was unloaded (idle cleanup, shutdown or
  provider retirement). The requested verdict still arrives once: sending reopens it. A running agent waits for its
  turn to end. An archived workspace, archived agent or gone agent cancels, checked again when the message goes.
  This and a scheduled task's message are invariant 1's requested-message exception; automatic nudges, repairs,
  briefs and auto-sends still never wake an unloaded agent.
- **A waited-for failure is sent once** (`a-waited-for-failure-is-sent-once`). When the agent waiting is the main agent,
  Auto-send is on and a repair batch carrying this PR's checks task is queued or out, the repair is the one message and
  the watch ends quietly (`coveredByRepair`). With Auto-send off, or a contributor waiting, the watch sends it.
- **The tool call owns its own verdict.** While the call answers, its watches are `answering` and passes skip them, so a
  verdict in the reply isn't also messaged. A worker that stops mid-call clears the flag on load.

## PRs Follow-up can't see

An untracked workspace, a PR in another forge, or a reference that doesn't resolve: the tool says so and names the way
on. On Paseo 0.17+ (`server_info.version`; there is no feature flag) that is Paseo's own `subscribe_change_request`;
otherwise "end your turn and check it once later". Follow-up never adds a second poller for them.

### Why not Paseo's watch for everything

Paseo 0.17's `subscribe_change_request` messages an agent after its turn when a check fails, all pass, a comment or
review arrives, or the PR merges or closes. It reads every watched PR on the host every 15 s in one aliased GraphQL
query (`PaseoWatchedChangeRequests`, up to 25 PRs, with checks, the last 100 comments, reviews and review threads).
Measured with `rateLimit(dryRun: true)` on that query shape against public PRs (2026-11-22): **1 point for 1 PR, 1 for
5, 6 for 25**, so about 240 points an hour while any PR is watched and about 1440 an hour at 25. Follow-up already
reads every tracked PR, so answering from those reads costs nothing extra, while a Paseo watch would add a second
15 s read of the same PR and a second failed-check message beside the repair.

## The polling nudge

The provider hook already runs on every PostToolUse (no matcher), so the nudge costs no new process. When a shell
tool's input (`Bash`, `Monitor`, Codex's `exec_command`, any tool named like a shell or terminal) polls GitHub for CI,
`pollsGithub` (`server/agent-hook.mjs`) adds context telling the agent to stop, call `wait_for_checks` and end the
turn. It matches a watch command (`gh pr checks --watch`, `gh run watch`), or a `gh pr checks|view|status`,
`gh run list|view` or `gh api` (graphql, pulls, check runs, check suites, statuses, actions runs) together with a
`while`/`until` loop, a `sleep N`, `watch -n`, `setInterval` or `time.sleep(`. A single `gh pr checks`, and a `for`
loop that reads each PR once, aren't polling.

**The polling nudge never blocks** (`the-polling-nudge-never-blocks`): it is context, never a `block`, and comes at
most once per turn (`pollNudged` in the turn's hook state). Tracked agents and untracked root agents get it.
False-positive check: 11 polling shapes and 13 non-polling ones written for the test (fictional repositories),
0 misses and 0 false positives (`tests/wait-for-checks.test.ts`).

SessionStart adds one line for root agents (`checksLine`): don't poll, call `wait_for_checks` and end the turn.

## Files

- `shared/check-watch.ts`: the watch record, `watchVerdict`, `coveredByRepair`, `parsePrRef`, the message text.
- `server/check-watches.ts`: `CheckWatches` (the store, `evaluate`, the `checks` queue channel).
- `server/wait-for-checks.ts`: the tool's answer (`waitForChecksAnswer`), `hostWatches`, `unseenAdvice`.
- `server/agent-hook.mjs`: `pollsGithub`, `pollNudge`, `checksLine`.
- Tests: `tests/wait-for-checks.test.ts`; the live check `scripts/check-wait-for-checks.mjs`.
