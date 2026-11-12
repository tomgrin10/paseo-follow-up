# PRs: workflow, actions, reviewers, deployments, Send to Paseo

## PR workflow: Graphite or plain GitHub

- **Detection** (`shared/pr-workflow.ts`, `server/pr-workflow.ts`, stored in `pr-workflow.json`). `auto` picks
  Graphite only where it's set up: a `gt` executable on PATH, a sign-in token in `~/.config/graphite/auth`, and the
  repository's `.graphite_repo_config`. Detection reads only files, never runs `gt`, and caches for 10 minutes.
- **What the setting holds.** The default, per-repository overrides, merge methods, and the review-fix command. The
  first start seeds `/fix-pr` when that command or skill exists.
- **RPCs and tools.** `follow.pr-workflow` and `follow.set-pr-workflow`; tools `pr_workflow` and `set_pr_workflow`.
- **Where the workflow is used.** `scopes.json` carries each agent's workflow, so the hook's and the tools'
  instructions match (`describeAction` in `server/mcp.mjs`). The engine words repairs per repository
  (`TaskWording` in `server/tasks.ts`).
- **UI:** Settings → Following → Shipping PRs (`client/shipping.tsx`). Tests: `tests/pr-workflow.test.ts`.
  End to end: `npm run test:github-mode`.

## Review mode

Each repository is **Team review** (the default) or **No review** (`review: "none"` in `pr-workflow.json`; Team
review stores nothing, so there is no migration).

- **Team review:** Follow-up asks you to add reviewers and to merge.
- **No review:** The agent merges its own PRs once checks pass. Follow-up never asks for reviewers or a merge there,
  and a merge flags nobody.

`agentMerges(pr)` (`shared/pr-workflow.ts`) is the one rule: the PR's register_pr `agentMerges` answer wins
(false hands one merge back), else the repository's mode decides. It reads a process-wide set of No review
repositories. `reviewersMissing(pr)` builds on it: the panel's PR rows and the PR sheet show "No reviewers" only for
a PR someone will be asked to review. The worker fills it from `pr-workflow.json` first thing in `ready`, before the first tick, and on
every save. The client fills it from `follow.reviewer-settings` (`noReview`), and from each `follow.inbox-list`
answer the PRs that hand their merge back (`handedBack`). The daemon withdraws an add-reviewers flag on its next tick;
the client doesn't wait: its inbox store hands every surface rows through `withoutWithdrawnAsks` and the brief cards
check `reviewersBriefWithdrawn` (`shared/inbox.ts`, both keyed by `agentMergesKey`), so the ask leaves the pill, the
inbox row, Home and the panel count the moment the repository flips, and comes back on Undo. The agent's instructions
follow the mode: `scopes.json` carries `workflow.noReview`, true only when every repository the workspace touches is
No review, and the hook and the tools say "merge your own PR once CI is
green" instead of "Merging and archiving remain the developer's actions."

Set it in Settings → Following → Shipping PRs → a repository → Review, from the Needs-you reviewers row ("Let the
agent merge in <repo>", with Undo), or with `set_pr_workflow` (`review: "team" | "none"`, a dry run first, then
`confirm`). `pr_workflow` reads it. UI: `client/review-mode.tsx`. Invariant
`a-no-review-repo-never-asks-for-review-or-merge`, `tests/review-mode.test.ts`.

## Observing PRs

`server/github.ts` (`Github.observe`) reads tracked PRs with one aliased GraphQL query per repository per tick
(15 PRs per query): state, checks, review threads, merge state, the repository's merge settings, and each base
branch's ruleset checks (`Ref.rules`, ACTIVE rulesets only, the same set REST `rules/branches/<branch>` returns).
A partial response fails only the PRs its errors point at. REST `rules/branches` is a fallback for a branch whose
rules didn't come back whole, cached 10 minutes. `server/graphite.ts` adds Graphite's status, only in Graphite
repositories. GitHub repositories make no Graphite calls.

**No process per read.** Polling talks HTTPS in-process (`server/github-api.ts`, `httpApi`). Each owner's token is
resolved once, like the developer's gh wrapper: an explicit `GH_TOKEN`/`GITHUB_TOKEN`, else the account
`~/.config/gh/account-map` names for the owner (`gh auth token --user`, run on the real gh with a dead
`DBUS_SESSION_BUS_ADDRESS` so no keyring daemon leaks), and it's resolved again after a 401. Writes (merge, retarget,
reviewers) still run `gh`. `FOLLOW_UP_GITHUB_API` points the client at a fake for harness runs.

Every worker read shares that one client (`githubApi()`): PR polling, the deploy probe's ancestry compare
(`server/deployments.ts`), Summary's PR read (`server/about.ts`), reviewer suggestions (`server/reviewer-config.ts`)
and the ranker's review-requested search (`server/ranker.ts`, `restAs` once per logged-in account; the account list
comes from `gh auth status` once an hour). 2026-11-12: the rc.3 live check still saw ~50 `gh api …/compare/…`
spawns after a start or a deploy; `tests/worker-reads-github-in-process.test.ts` (invariant
`worker-reads-github-in-process`) runs every read path with its default wiring and fails if one spawns gh, and scans
`server/` for new gh spawns that aren't writes or token lookups. The setup flow's readiness check still runs
`gh api user` on demand: it checks gh itself. `FOLLOW_UP_DEPLOY_REGISTRY` points the deploy probe's registry reads
at a fake (`scripts/poll-cost.mjs --deploy-merged`).

**Backoff** (`shared/poll.ts`). A read costs about one GraphQL point per PR (15 PRs = 16 points), from the
developer's 5000-point hourly budget that every agent shares, so only PRs that are due go into a tick's queries.
The engine ticks every 15 s. On a timer tick a PR is due when it's moving (every 30 s when only checks are running), its workspace is busy, the developer
refreshed or opened its workspace, or its interval passed: 60 s for settled open or closed PRs, 30 minutes for merged
ones (merged is final; deploy state is probed separately every tick). Otherwise its last observation stands in.
Moving means: not read yet, an error, an incomplete read, a check actually running (finishing checks don't bump a
PR's `updatedAt`; a required check that never reported isn't running), a merge queue, merge when ready on, unknown
mergeability, or a content change in the last 5 minutes. The developer's Refresh reads fresh. A turn end, an action or an agent tool nudges only its own workspace
(`engine.nudge`): that workspace's PRs, with the same backoff, and nudges within 2 s share one read (invariant
`a-turn-end-never-reads-other-workspaces-prs`; until 2026-11-12 each one re-read every tracked PR fresh). A settled open PR's change shows within 75 s, inside the completion gate's 120 s
freshness; the `poll-backoff-never-hides-a-moving-pr` invariant holds both. Opening a workspace's panel refreshes it.

**Long-running checks.** Checks still running 10 minutes after a PR's last change (or since Follow-up first saw it)
are read every 2 minutes instead of 30 s (invariant `long-running-checks-read-every-2-min`; 2026-11-12, 25 stacked
PRs with checks running for hours cost ~3000 GraphQL points an hour).

**Budget.** Each query asks for `rateLimit { cost remaining resetAt }`. Under 500 points left, settled PRs wait 5
minutes and only in repositories with something moving, and merged PRs aren't read (see below). Under 100, or when GitHub
answers with a rate limit (GraphQL's `RATE_LIMIT` or `RATE_LIMITED` error, or a 403/429 with `retry-after` or no
remaining budget), nothing is read until the reset (10 minutes when GitHub doesn't say) and the last observations
stand in instead of errors.
- **Per token.** The in-process client (`server/github-api.ts`) rests a token whose budget is spent: no request goes
  out on it until the reset, whichever owner asks (one account's token serves many owners). At most 4 requests are in
  flight per token. Every failed read is logged (`[follow-up] GitHub read failed: <repo> HTTP <status>: …`).
- **Never blanks a known PR.** Any failed read (a limit, a timeout, a 5xx) keeps each PR's last known status: the last
  observation, else the stored snapshot (after a restart nothing is in memory). Only a PR never read says why it has
  none (invariant `a-github-limit-never-blanks-a-known-pr`, `tests/github-rate-limit.test.ts`). 2026-11-12: the
  account's GraphQL budget ran out, GitHub answered `RATE_LIMIT`, and every PR on it showed Unknown.
- **Merged is final.** A merged PR with a known status isn't read again, not even on a cold start; only the
  developer's Refresh of its workspace reads it. A stored error doesn't change that: the skip reports no error, and
  parsing the state (load included) drops an error from a merged PR with a complete snapshot (`prSchema`), so an
  install heals without a Refresh. The developer's Refresh of a dormant workspace reads that workspace's PRs (only its PRs:
  no agent observation, repairs or sends); before 2.0.1-beta.2 it read nothing there.
- **A complete snapshot shows its own status.** Every surface reads a PR's status from its last complete snapshot
  (`statusKnown`, `shared/model.ts`); a failed read after it only turns the PR sheet's Checked line into "Last checked
  <age>" (`staleHint`, `shared/presentation.ts`). "Status unavailable" (Unknown in rows) means no complete read yet.
  2026-11-12, live 2.0.1-beta.1: 13 merged PRs kept an error from beta.0's limit failures and read Unknown for good
  (`tests/stale-pr-error.test.ts`). Gates that act on a PR (merge, reviewers, repairs) still want a fresh read.
Cost per tick is pinned by `tests/github-poll-cost.test.ts`; `scripts/poll-cost.mjs` measures it in a harness
(`--deploy-merged K` adds K merged PRs in the deployment repository, with a fake fleet and registry; `warmup` reports
the cold start's spawns and compares).

## PR actions (merge, merge when ready, reviewers)

`server/pr-actions.ts` (`PrActions`, with shared types in `shared/pr-actions.ts`):

- **Merge flow.** `follow.prepare-pr-action` builds a plan, re-checking the stack and blockers.
  `follow.confirm-pr-action` runs it (target or downstack), and `follow.check-pr-action` polls progress.
- **Merging.** Graphite repositories merge through saved Graphite CLI auth. Elsewhere, `gh pr merge`, with GitHub
  auto-merge for "When ready".
- **Agents** use `merge`, `enable_merge_when_ready` and `disable_merge_when_ready`, which plan and then confirm.
- **Interrupted sends.** A reload mid-send marks the action `uncertain`.

## Reviewers

- **Lists.** `shared/reviewers.ts` and `server/reviewer-config.ts` keep `reviewers.json`: per repository plus a
  default.
- **Suggestions.** `ReviewerSuggestions` reads collaborators and teams with `gh api` only when the picker opens,
  caches them for 10 minutes, and never polls.
- **RPCs:** `follow.request-reviewers` (a pick for this PR, optionally remembered), `follow.reviewer-settings`,
  `follow.save-reviewers`, `follow.reviewer-suggestions`.
- **Tools:** `add_reviewers`, `reviewer_settings`, `reviewer_suggestions`, `save_reviewers`.
- **UI:** `client/reviewers.tsx` and `client/pr-controls.tsx`.

## Deployments

`server/deployments.ts` reports deploy state only for specifically configured repositories; elsewhere it stays
unknown. A fleet read (at most once a minute) is one `gcloud run services list`; each serving revision is described
once, since a revision's image never changes. Tasks with `trigger: deploy` wait for it ([workspaces.md](workspaces.md)).

## Send to Paseo (browser companion)

`server/browser-bridge.ts` and `server/pr-owner.ts`:

- **The integration surface.** The optional integration uses only:
  - `follow.pr-owner`: the recorded registering agent;
  - `follow.pr-workspaces`: the read-only browser view (titles, ids, main-agent status and the Home one-line state,
    at most three, nothing for repositories outside the advertised scope);
  - the scoped exchange `follow.browser-exchange`.

  No inventory, messages, paths or credentials cross these RPCs.
- **Scope.** The exchange advertises at most 100 repository identities from active tracked PRs. It starts with no
  repository scopes until the extension echoes its selected exact scopes.
- **Graphite's Merge when ready** is toggled through the paired extension, confirmed in Chrome
  (`follow.pr-control-status`, `follow.browser-status`; tools `pr_controls`, `browser_status`).
- **Unknown toggle state never means off.**
- **Checks:** `scripts/check-browser-controls.mjs` with `scripts/browser-control-fixture.mjs` and
  `scripts/browser-control-preload.cjs`.

Tests: `tests/pr-actions.test.ts`, `tests/pr-owner.test.ts`, `tests/github.test.ts`, `tests/graphite.test.ts`,
`tests/reviewers.test.ts`, `tests/reviewer-config.test.ts`, `tests/deployments.test.ts`.
