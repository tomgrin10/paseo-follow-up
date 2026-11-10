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

`server/github.ts` (`Github.observe`) reads each tracked PR with one `gh api graphql` query: state, checks, review
threads, merge state, and the repository's merge settings. `server/graphite.ts` adds Graphite's status, only in
Graphite repositories. GitHub repositories make no Graphite calls.

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
unknown. Tasks with `trigger: deploy` wait for it ([workspaces.md](workspaces.md)).

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
