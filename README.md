# paseo-follow-up

[![npm version](https://img.shields.io/npm/v/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![npm downloads](https://img.shields.io/npm/dm/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-follow-up?style=for-the-badge&color=2563eb)](LICENSE)

Keep long-lived workspaces moving through review, deployment and completion. Follow-up tracks each workspace's PR stack and remaining tasks, batches repairs for its main agent, and records when that agent declares the work done.

![Follow-up workspace panel with sample pull requests and remaining tasks](docs/screenshots/follow-up-workspace.png)

Screenshots use synthetic workspaces and PRs.

## Install

```sh
paseo plugin install paseo-follow-up
```

Needs Node 22+ and an authenticated GitHub CLI (`gh`) on the daemon host, plus saved Graphite CLI authentication for Graphite readiness and Merge controls. The installed plugin ID stays `follow-through` so existing settings and tracked work carry over.

## Use

Open **Follow-up** from the sidebar or ⌘K / Ctrl+K. In a workspace, use the header button or panel and click **Track this workspace**.

- The workspace's main agent owns its PRs, tasks and the Done declaration. Other agents in the workspace can register PRs and check status.
- With **Auto** off, you review and send each repair batch. With Auto on, Follow-up sends them itself after fresh idle, permission and Session Guard checks. It never merges, enables merge when ready, requests reviewers or archives workspaces.
- Tasks run manually, or **Now**, **After merge** or **After deploy**, with an optional delay. A merged PR alone does not count as done.
- **Project settings** choose which projects are tracked. New workspaces start with Auto off.

![Follow-up overview with sample workspaces](docs/screenshots/follow-up-overview.png)

## Send to Paseo and Graphite

With [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) on the same daemon, its composer picks the agent that registered the PR. With Send to Paseo 2.2+, Follow-up can also toggle Graphite's **Merge when ready** through your existing pairing, while Graphite is open and signed in. Each change is confirmed in Chrome, which can remember the permission per repository. See the [integration and security contract](https://github.com/tomgrin10/send-to-paseo/blob/main/docs/follow-up-integration.md).

## Data and access

Paseo plugins run trusted, unsandboxed code on the daemon host. Follow-up reads workspace metadata, agent history and GitHub PR status with your existing credentials, and keeps its state in `$PASEO_HOME/plugin-data/follow-through`. It registers scoped MCP tools and reversible provider hooks only for tracked sessions. GitHub and Graphite writes happen only after an explicit click and a fresh eligibility check.

## Development

```sh
npm ci
npm run verify
npm run test:install
paseo plugin reload follow-through   # after changes
```

Integration checks use a separate Paseo home with synthetic agents. Version tags (`vX.Y.Z`) publish to npm through Trusted Publishing.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.

## Other plugins

- [Defer](https://github.com/tomgrin10/paseo-defer) — Schedule messages for later delivery.
- [Graphite](https://github.com/tomgrin10/paseo-graphite) — Graphite stacks and PR status.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, process, agent and Docker monitoring.
- [Workspace Switcher](https://github.com/tomgrin10/paseo-switcher) — Arc-style Ctrl+Tab between recent workspaces.
