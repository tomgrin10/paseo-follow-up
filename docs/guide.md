# Using Follow-up

The [README](../README.md) says what Follow-up is and how to install it. This page is the rest: setup, each part of
the app, settings, updates and a few things for specific setups. Screenshots use synthetic workspaces, people and PRs.

- [Setup](#setup)
- [Using it](#using-it)
- [Updates and What's new](#updates-and-whats-new)
- [Helper agents and providers](#helper-agents-and-providers)
- [Settings](#settings)
- [Report a bug or request a feature](#report-a-bug-or-request-a-feature)
- [Upgrading from 1.x](#upgrading-from-1x)
- [Data and access](#data-and-access)
- [Memory on Linux](#memory-on-linux)
- [Working on Follow-up](#working-on-follow-up)

## Setup

The first time you open Follow-up from the sidebar, a short setup takes Home's place. It takes about two minutes, and
**Skip setup** leaves it at any point.

<img alt="Follow-up's setup, first step: an example PR going from failed checks to a fix sent to its agent to a merge only you can approve" src="screenshots/follow-up-setup.png">

It shows what Follow-up does, checks GitHub and the helper agents (with the fix to copy for anything missing), and asks
what Follow-up may do without asking you, how you ship PRs, who reviews, how it updates and which helpers to turn on.
Every switch is the same one Settings shows. Run it again from Settings → General → **Set up Follow-up again**.

## Using it

Open **Follow-up** in Paseo's sidebar for Home, or the Follow-up icon in a workspace's header for that workspace's
panel. ⌘K (Ctrl+K) has a Follow-up command for most things.

Home lists every workspace, grouped by what it needs from you. When an agent finishes, asks something, hits an error
or waits for a permission, it moves to the top, under **Needs you**, and stays there until you mark it done or reply.
You act on it right there, without opening the chat.

When a PR's checks fail, it hits a merge conflict or a reviewer leaves comments, Follow-up sends them to the agent
that made the PR, in one message once it's idle. You're only asked for what's yours to decide, like merging. Works
with plain GitHub; Graphite is optional.

Type in Home's search box and an agent that knows all your workspaces passes your question to the one doing the work.
Optionally, Follow-up orders the list by what your Linear issues, Slack mentions and review requests say matters most.

On Paseo 0.16 or newer, Follow-up can also be your sidebar: pick **Follow-up: Needs you** in Settings → Sidebar →
View. Follow-up 2.0 still runs on Paseo 0.15; there it simply doesn't offer the view.

<img alt="Paseo 0.16's sidebar showing Follow-up's view: workspaces grouped by what they need from you, each with its status, beside the selected workspace's chat" src="screenshots/follow-up-sidebar.png" width="600">

<img alt="The workspace panel beside the agent's chat: 1 of 3 PRs merged, a stack bar, a question to answer, a failed check for the agent to fix and a task waiting on a deploy" src="screenshots/follow-up-panel.png">

### Answer a question

When an agent needs a decision, it asks in a card with lettered options, its recommendation and room for your own
answer. Answer on Home, in the workspace's side panel, in the bar above the agent's message box, or on your phone. The
answer goes straight into the agent's chat.

Pick an option, add a note if you like, and send. Cmd+Enter (Ctrl+Enter) sends. If the agent is busy or waking up,
the card says Sending until it has the answer, and offers Send again if it couldn't deliver.

<img alt="A question card: three lettered options, A recommended, with a note for the agent" src="screenshots/follow-up-questions.png">

### The pill

The bar above the message box (the pill) shows what needs you in the chat you're in, with the same actions.

<img alt="The composer pill opened: a question to answer, tasks ready to send and an approved PR" src="screenshots/follow-up-pill.png">

### A PR

Tap a PR, or its segment in the stack bar, for its checks, reviewers and Merge. When Merge isn't available yet, the
sheet says what it's waiting for. Follow-up never merges on its own, and Merge checks the stack again first.

<img alt="The PR sheet for a PR whose required test check failed" src="screenshots/follow-up-pr-sheet.png">

### Summary and linked items

Each workspace gets a one-line Summary of what it's for. Next to it: the Linear issues, Slack threads and docs it's
about, with who linked each one and why. Paste a link or a key to add one. Agents link what they start from, and a
Linear key counts only once Linear confirms it.

<img alt="A workspace's Linked list: a Linear issue, a Slack thread and a doc, each with who linked it" src="screenshots/follow-up-linked-items.png">

### On a phone

Home is the list and a row opens its detail. Sheets open from the bottom.

<img alt="Follow-up on a phone: Home's list, and a workspace's detail with its question" src="screenshots/follow-up-phone.png">

### What it never does on its own

- Merge, turn on merge when ready, request reviewers or archive. Those take your click, or an agent's confirmed plan.
- Answer a question for you. Answers go out only when you send them.
- Wake an agent that's resting to read it. It reads the transcript on disk instead.

Your agents can do anything you can click in Follow-up, after showing you a plan.

## Updates and What's new

Follow-up updates itself when nothing is busy, and rolls back if an update fails. With Updates set to **Tell me**,
Home says when any newer stable version is available, including minor and patch releases. On the Beta channel, betas
show only in Settings → General.

After an update that brings new release notes, Follow-up shows **What's new** once. Betas install quietly. To stop it,
turn off **Show What's new after updates** in Settings → General. Release notes are there too, and in
[CHANGELOG.md](../CHANGELOG.md).

Betas are on npm's `beta` dist-tag: `paseo plugin install npm:paseo-follow-up@beta`.

## Helper agents and providers

Follow-up runs a few small background jobs ("helpers") for you. Each one is optional, and Settings → **Agents** shows
what each uses and recommends a model from the providers you have, with **Use recommended** in one click.

| Helper | What it does | Runs on |
| --- | --- | --- |
| Summaries | One sentence under each workspace's title saying what it's for | Any provider Paseo has |
| AI priority | Sorts Home from Linear, Slack and review requests, about hourly on workdays, and only when something changed | Any provider Paseo has |
| Overseer | One agent you ask about all your workspaces. Starts only when you click Start on Home | A Paseo agent, Claude by default |
| Recovery | Rebuilds a workspace's tracking when Follow-up lost track of it. Runs only when you ask | The main agent's provider, or one you pick |

Claude and Codex run a job directly. Other providers run it as a short hidden agent. AI priority reads Linear and
Slack through read-only tools and never posts anything.

## Settings

Settings (the gear on Home, or ⌘K → **Follow-up: settings**) has five categories:

- General: updates (Install automatically, Tell me or Off; Stable or Beta), setup, and the release notes.
- Following: which projects and workspaces Follow-up follows, auto-send, how each repository ships PRs (GitHub or
  Graphite, the merge method, how agents handle review comments), and Trust bypass for permission prompts.
- Reviewers: who **Add reviewers** asks, with a default for every repository and a list per repository.
- Agents: the helper agents and their models, what agents do while a question waits, and, on Paseo 0.15, Wait for
  background jobs.
- Inbox & display: the Needs-you inbox, the sidebar badge and the pills.

## Report a bug or request a feature

Ask any agent in Paseo to "report a bug about Follow-up" (or a feature request, or feedback), or use **Report a bug**
in Settings → General, Command-K, `/report-issue` in the composer, or **Report this** on any error. The agent asks what
it needs, checks what it can, and shows you the exact issue before filing it in this repository with your own GitHub
sign-in. It adds Follow-up's version, Paseo's, your OS and recent errors, and replaces private repository names, PR
titles, hostnames, emails and paths with placeholders. Screenshots are uploaded to a public `paseo-issue-assets`
repository in your account only if you say yes for that report; otherwise you drag them into the issue. Without a
GitHub sign-in you get a prefilled link instead. You can also
[open an issue](https://github.com/tomgrin10/paseo-follow-up/issues/new/choose) by hand.

## Upgrading from 1.x

Update as usual. 2.0 copies your data to its new folder and moves itself to the plugin id `follow-up` once, while
nothing is busy; Settings → General says when it's done. 2.0 needs Paseo 0.15 or later. To go back to 1.0.1:

```sh
paseo plugin remove follow-up
paseo plugin install npm:paseo-follow-up@1.0.1
```

1.x's data folder is never deleted, so 1.0.1 starts from where it was before the move.

## Data and access

Paseo plugins run trusted, unsandboxed code on the daemon's machine. Follow-up reads workspace metadata, agent history
and GitHub PR status with your existing credentials, and keeps its state in `$PASEO_HOME/plugin-data/follow-up`. It
gives agents scoped tools and installs reversible hooks for Claude Code and Codex. [OVERVIEW.md](../OVERVIEW.md) has
the full data-access statement.

## Memory on Linux

On Linux (glibc), a Follow-up that stays up for hours can slowly grow in memory: the allocator keeps memory Follow-up
already freed. macOS isn't affected. Three allocator settings in the Paseo daemon's environment stop most of the idle
growth. Every process Paseo starts inherits them.

If a systemd unit runs Paseo, add them to it (the unit name is your own; `paseo` here):

```sh
systemctl --user edit paseo
```

```ini
[Service]
Environment=MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
```

Then `systemctl --user restart paseo`. If the unit already reads an `EnvironmentFile=` (say `~/.config/paseo/env`),
put the three `NAME=value` lines there instead. If you start the daemon from a shell, stop it and start it with them:

```sh
paseo daemon stop
MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072 paseo daemon start
```

In our test harness (140 workspaces, 45 idle minutes) Follow-up grew about 20 MB without them and 3 to 6 MB with them,
at no measurable CPU cost. On a busy real setup they kept Follow-up flat while idle, but memory still stepped up during
bursts of activity and stayed there: after about 4.7 hours it used 363 MB with them and 375 MB without. To undo it,
remove the settings and restart Paseo.

## Working on Follow-up

```sh
npm ci
npm run verify
npm run test:install
npm run shots          # re-shoots the README images in an isolated daemon
```

Checks run against a separate Paseo home with synthetic agents, never your own. A PR that changes something users see
adds a release-note fragment ([rules](../changes/README.md)), and releases are described in
[releasing.md](releasing.md). [AGENTS.md](../AGENTS.md) is the place to start, with or without an agent: the
architecture, invariants and how to test. Each part has its own page here, such as [Needs you](needs-you.md),
[PRs](prs.md), [Linked items](linked-items.md), [updates](updates.md), [Wait](wait.md) and
[agent tools](rpcs-and-tools.md).
