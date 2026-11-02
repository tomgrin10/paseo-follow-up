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
