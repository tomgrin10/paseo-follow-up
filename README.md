# paseo-follow-up

[![npm version](https://img.shields.io/npm/v/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![npm downloads](https://img.shields.io/npm/dm/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-follow-up?style=for-the-badge&color=2563eb)](LICENSE)

Follow-up watches every pull request a Paseo workspace opens until the work is actually done. It shows the whole stack at a glance, gathers conflicts, failing checks and review threads into one repair batch for the workspace's main agent, and tells you when something needs you: an approved PR to merge, a question to answer, or a batch to send.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/media/follow-up-hero-light.png">
  <img alt="A Paseo workspace with the Follow-up panel open: 1 of 5 PRs merged, 3 need you, 2 to fix, a coloured stack bar, a Needs you card with Send to main agent and Merge #418, and Follow-up's tool calls shown as one-line rows in the chat" src="docs/screenshots/follow-up-hero.png">
</picture>

Screenshots use synthetic workspaces and PRs.

## Install

```sh
paseo plugin install paseo-follow-up
```

Needs Node 22+ and an authenticated GitHub CLI (`gh`) on the daemon host. Merge buttons use your saved Graphite CLI authentication. The installed plugin ID stays `follow-through`, so existing settings and tracked work carry over.

## Use

Open a workspace, click the Follow-up icon in its header (or press ⌘K / Ctrl+K and choose **Follow-up: open for this workspace**), then **Track this workspace**. To track every workspace in a project, open the settings (the gear in the panel, or **Follow-up: project settings** in ⌘K) and turn the project on.

The panel reads top to bottom:

- **Status.** How many PRs have merged, how many things need you, how many PRs need fixing, and a bar with one segment per PR in merge order. Below it, what the agent is doing right now.
- **Needs you.** One row per decision, each with its button: send repairs to the main agent, merge an approved PR, resume after you stopped the agent, retry a batch that didn't finish, or answer the agent's question in chat.
- **Pull requests.** Each stack drawn top to base, the way Graphite shows it, with merged PRs folded away.
- **Tasks.** Work that outlives a merge, such as a production check or a backfill. Tasks wait for you unless you schedule them for after a merge or deploy.

![Four Follow-up panels side by side: a workspace that needs you, one where the agent is fixing two repairs, one that has shipped, and one that is not tracked yet](docs/screenshots/follow-up-states.png)

When a workspace needs you, a pill appears above its main agent's message box with the same actions, and the sidebar's Follow-up row counts how many workspaces are waiting. Nothing shows when nothing needs you.

![The composer pill "3 need you" opened into a popover with a question, three repairs ready to send, and an approved PR](docs/screenshots/follow-up-pill.png)

Tap a PR, or its segment in the bar, for a sheet with its checks, reviewers and Merge controls. When Merge isn't available yet, the sheet says what it is waiting for.

![The PR sheet for a PR whose required checks failed](docs/screenshots/follow-up-pr.png)

In the agent's chat, Follow-up's own tool calls collapse into one-line rows, a repair batch shows as a short card instead of a raw prompt, and the agent's Done call gets a card of its own.

![Follow-up rows and cards in an agent chat](docs/screenshots/follow-up-chat.png)

**Follow-up: all tracked workspaces** (or the sidebar row) lists every tracked workspace, grouped by who's up next, with each stack's bar.

![The tracked workspaces screen grouped into Needs you, Agent working, Waiting and Done](docs/screenshots/follow-up-overview.png)

On a phone the panel opens as a tab, and the PR sheet and pill popover open as bottom sheets.

![Follow-up at phone width: the panel, a PR sheet and the pill popover](docs/screenshots/follow-up-mobile.png)

## How it works

- The workspace's main agent owns its PRs, tasks and the Done call. Other agents in the workspace can register PRs and check status.
- **Auto-send** is off for every newly tracked workspace, so each repair batch waits for your click. Turn it on per workspace and Follow-up sends batches itself once the agent is idle, after fresh permission and Session Guard checks.
- Follow-up never merges, turns on merge when ready, requests reviewers or archives on its own. **Merge** re-checks the stack, lists any PRs underneath that would merge first, and asks again.
- A merged PR is not the end: tasks such as production checks keep the workspace open until the main agent declares Done and everything has settled.

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
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, process, agent and Docker monitoring.
- [Workspace Switcher](https://github.com/tomgrin10/paseo-switcher) — Arc-style Ctrl+Tab between recent workspaces.
