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
mergeability, or a content change in the last 5 minutes. Every other caller (the developer's Refresh, actions,
`declare_done`) reads fresh. A settled open PR's change shows within 75 s, inside the completion gate's 120 s
freshness; the `poll-backoff-never-hides-a-moving-pr` invariant holds both. Opening a workspace's panel refreshes it.

**Budget.** Each query asks for `rateLimit { cost remaining resetAt }`. Under 500 points left, settled PRs wait 5
minutes and only in repositories with something moving, and merged PRs wait for the reset. Under 100, or when GitHub
answers `RATE_LIMITED`, nothing is read until the reset (10 minutes when GitHub doesn't say) and the last
observations stand in instead of errors.
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
