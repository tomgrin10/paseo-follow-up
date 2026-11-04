# Release verification

The 0.1.0 release was checked on Paseo 0.12.0 in a separate daemon home with fixture providers and synthetic workspaces.

- npm run verify: typecheck, 130 behavior tests and button visibility lifecycle regression pass.
- npm run test:install: the packed plugin installs without development dependencies. Native MCP, provider hooks, scoped recovery, explicit tracking, original ownership, delayed tasks, Session Guard coordination, communication receipts, opt-in Auto and completion/reopening pass.
- npm pack --dry-run: both runtime entries, manifest, license, overview, generated bridges and three interface screenshots are included. No daemon state, credentials, logs or development dependencies are in the archive.
- Real app web UI: overview/project/display navigation, independent button hiding, persisted preference after reload, desktop and 390×844 compact layouts. No horizontal overflow was observed in compact settings.
- No user's main daemon was restarted or real-agent messages sent for these checks.

Release screenshots use synthetic PRs and workspace data. No local prek configuration exists in this repository.

The packed integration suite requires the Paseo, Claude Code and Codex CLIs. The release workflow installs pinned versions before running it. The first clean-runner attempt exposed the missing provider binaries; the workflow prerequisite was corrected before CI publication.


## Prepared 0.3.0 integration (2026-11-01)

- `npm run verify`: TypeScript, 135 behavior tests and the button visibility lifecycle regression pass.
- `npm run test:install`: packed standalone lifecycle checks pass without Send to Paseo installed, including narrow PR ownership lookup and explicit re-registration.
- `npm pack --dry-run`: new server modules are included; no credentials, transcripts or daemon state are packed.
- The browser-control fixture with Send to Paseo 2.1 passes: installed RPC and HTTP transport, actual MV3 extension, native desktop controls, single-PR and downstack toggles, browser confirmation and separately allowed direct changes, cancellation, revocation, and one ordered synthetic merge. Extension settings pass wide/compact and light/dark checks.
- Send's installed routing fixture selects the registering agent over a newer Main across multiple clones of the same repository, delivers once to a synthetic provider and honors a new-agent override.

The old browser verification script had stale Follow-through labels and assumed the desktop
workspace header shortcut persisted in compact Paseo. It now checks native controls on desktop
and the changed extension settings in both viewport sizes. These checks do not claim compact
Paseo merge-control coverage.


## Release review (2026-11-02)

The Add reviewers action is now independent per PR. Duplicate in-flight clicks on one PR share
the same operation; uncertain requests still block that PR without resending notifications.
Workspace merge/toggle guards remain in place. Verification includes 138 behavior tests plus
the button lifecycle regression, packed standalone installation, and two real Add reviewers
clicks against a delayed synthetic GitHub endpoint. Both requests overlap and finish once each.
Restoring the old workspace-wide lock makes the new concurrency regressions fail.


## Cross-worktree discovery release (0.3.1, 2026-11-02)

TypeScript, 144 behavioral tests and the native button lifecycle regression pass. The new regression
creates an actual secondary git worktree, leaves the workspace branch on a merged PR, removes its
recorded owner from the live directory, and verifies submission receipts from another root session
populate the same workspace and preserve the submitting agent. A read-only replay of the reported
session recognizes all twelve missing PR receipts; no transcript or private machine paths are committed.

Additional coverage checks actual MCP tool listing for contributor roots, hook/CLI fallback context,
permission boundaries, registration/exclusion precedence, repository scoping, quoted/read-only/failed
commands, truncated Graphite output and inferred GitHub stack relationships. The packed lifecycle
suite exercises contributor MCP registration and retains the recovery handoff regression.


## Agent-created workspace release (0.3.2, 2026-11-03)

TypeScript, 149 behavior checks and the native button lifecycle regression pass. Added regressions
cover workspace-first creation with an agent whose creator is in another workspace; automatic
project enrollment and explicit Track select the new local agent instead of rejecting its parent
label. Tests preserve same-workspace child exclusions, archived-agent checks, unavailable-parent
bounds and recovery handoff. The packed lifecycle test creates three independent workspaces and
agents, checks their first-session bridge and goal access, and rejects local children and creator
claims across workspace boundaries. All writes and messages in these checks are synthetic.


## Track latency release (0.3.3, 2026-11-03)

The live verification of 0.3.2 exposed an additional timeout: Track waited for the global refresh.
Activation now returns after its ownership and tracking state are persisted. Targeted discovery for
Track/session startup reads no transcripts; normal background polling retains history discovery.
Regressions hold global observation behind an unresolved promise and assert activation still returns,
and verify that targeted discovery skips transcript calls while background discovery still scans.
Packed installation checks wait for background history instead of requiring it in the Track response.

TypeScript, all 151 behavior tests and the native button lifecycle regression pass for 0.3.3.


The tagged 0.3.3 release check exposed an installation-test deadline below the normal fifteen-second
poll interval when activation coalesced with an existing refresh. The harness now allows two poll
intervals for asynchronous history discovery; its expected references and ownership assertions are
unchanged. This harness-only correction is excluded from the npm package and does not change the
immutable 0.3.3 tag or published package integrity.


## Interface redesign (unreleased, 2026-11-04)

The workspace panel, overview, settings, composer pill, header button, sidebar row and chat rows were
redesigned. Server behaviour, RPC names, state format and safety rules are unchanged; display
preferences gained `enable_composer_pill` with a default, so older saved documents still parse.

- `npm run verify`: TypeScript, 170 behaviour tests (new: needs-you ordering and send guards, merge
  readiness gated on Graphite, stack-bar order, headline/live-line/pill agreement, Graphite blocker
  copy, chat transforms for MCP and CLI-fallback calls and batch prompts) and the button lifecycle
  regression pass.
- `npm run test:install` passes; `npm pack --dry-run` ships the new media and no harness files.
- Every state was rendered in an isolated daemon with synthetic workspaces, a fake `gh` and a demo
  provider, at 1440×900 and 390×844, light and dark: needs you, agent working, paused, shipped,
  waiting, not tracked, PR sheet, merge confirmation, task sheet, pill popover, chat rows and cards,
  overview, project and display settings. An overflow scan found no clipped text or horizontal scroll.
- The harness has no Graphite authentication, so the Merge row was shown by injecting
  `READY_TO_MERGE` into the saved state between polls. The loading skeleton and the first-load error
  card were reviewed in code only.
- The manual browser scripts under `scripts/check-*.mjs` (other than `check-install.mjs`) still target
  the previous panel's labels and need updating before their next use.
