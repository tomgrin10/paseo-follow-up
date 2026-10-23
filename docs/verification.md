# Release verification

The 0.1.0 release was checked on Paseo 0.12.0 in a separate daemon home with fixture providers and synthetic workspaces.

- npm run verify: typecheck, 130 behavior tests and button visibility lifecycle regression pass.
- npm run test:install: the packed plugin installs without development dependencies. Native MCP, provider hooks, scoped recovery, explicit tracking, original ownership, delayed tasks, Session Guard coordination, communication receipts, opt-in Auto and completion/reopening pass.
- npm pack --dry-run: both runtime entries, manifest, license, overview, generated bridges and three interface screenshots are included. No daemon state, credentials, logs or development dependencies are in the archive.
- Real app web UI: overview/project/display navigation, independent button hiding, persisted preference after reload, desktop and 390×844 compact layouts. No horizontal overflow was observed in compact settings.
- No user's main daemon was restarted or real-agent messages sent for these checks.

Release screenshots use synthetic PRs and workspace data. No local prek configuration exists in this repository.

The packed integration suite requires the Paseo, Claude Code and Codex CLIs. The release workflow installs pinned versions before running it. The first clean-runner attempt exposed the missing provider binaries; the workflow prerequisite was corrected before CI publication.
