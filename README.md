# paseo-follow-up

[![npm version](https://img.shields.io/npm/v/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![npm downloads](https://img.shields.io/npm/dm/paseo-follow-up?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-follow-up)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-follow-up?style=for-the-badge&color=2563eb)](LICENSE)

Follow-up watches every pull request a Paseo workspace opens until the work is actually done. It shows the whole stack at a glance, gathers conflicts, failing checks and review threads into one repair batch for the workspace's main agent, and tells you when something needs you: an approved PR to merge, a question the agent asked, or a batch to send. Answer a question in Follow-up and the answer goes straight to the agent's chat.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/media/follow-up-hero-light.png">
  <img alt="A Paseo workspace with the Follow-up panel open: a Spec link, 1 of 5 PRs merged, 4 need you, 2 to fix, a coloured stack bar, and a Needs you card with two questions from the agent, three repairs to send and Merge #418, beside the agent's chat" src="docs/screenshots/follow-up-hero.png">
</picture>

Screenshots use synthetic workspaces and PRs.

## Install

```sh
paseo plugin install paseo-follow-up
```

Needs Node 22+ and an authenticated GitHub CLI (`gh`) on the daemon host. Merge buttons use your saved Graphite CLI authentication. The installed plugin ID stays `follow-through`, so existing settings and tracked work carry over.

## Use

Follow-up follows every workspace as soon as it has an agent; there is nothing to turn on. Open a workspace and click the Follow-up icon in its header (or press ⌘K / Ctrl+K and choose **Follow-up: open for this workspace**) to see that workspace's panel. Its **Home** button opens Home, the list of every workspace. To leave a workspace or a project out, open the settings (**Follow-up: settings** in ⌘K): **Following** has the global switches, **Workspace exceptions** the per-workspace ones.

The panel shows this workspace only, top to bottom: a **Home** button, the main agent's open ask (its brief, with the decision options and **Sign off**), then:

- **Status.** How many PRs have merged, how many things need you, how many PRs need fixing, and a bar with one segment per PR in merge order. Below it, what the agent is doing right now.
- **Needs you.** One row per decision, each with its button: answer the agent's question, send repairs to the main agent, merge an approved PR, resume after you stopped the agent, or retry a batch that didn't finish.
- **Pull requests.** Each stack drawn top to base, the way Graphite shows it, with merged PRs folded away.
- **Tasks.** Work that outlives a merge, such as a production check or a backfill. Tasks wait for you unless you schedule them for after a merge or deploy.
- **Activity.** What happened and how long it took: repairs sent and finished, merges, merge and reviewer actions, and every question under its ref.

The **Spec** chip in the header opens the page that sums up the workspace, usually the Claude artifact the main agent keeps up to date. The agent registers it with a tool call, Follow-up also picks up artifacts the workspace's sessions publish, and you can set, change or remove it under **Spec, agent and recovery**. Your link wins over the agent's, which wins over detection.

![Four Follow-up panels side by side: a workspace that needs you, one where the agent is fixing two repairs and one that has shipped](docs/screenshots/follow-up-states.png)

### Questions

When the main agent needs a decision it asks in Follow-up instead of burying it in chat. Each question gets a permanent ref (Q1, Q2…), lettered options with what each means, the agent's recommendation, and a line saying what the agent does while it waits. Pick an option, add a note if you like, and **Send to agent**: the answer goes straight into its chat, even mid-turn, and stays recorded under its ref. **Copy** puts the same answer on the clipboard instead. If the agent can't take it yet (Session Guard paused it, or a permission prompt is open) the answer waits and goes out on the next check; if Paseo doesn't confirm the message, Follow-up asks you to check before resending. A task the agent marks blocked becomes a question too.

![The Q3 question dialog with three lettered options, A recommended and B selected with a note, beside the Activity card listing every question under its ref](docs/screenshots/follow-up-questions.png)

The question mode in Follow-up's settings tells agents what to do until you answer: **Stop** (end the turn and wait), **Work around** (the default: build nothing the answer affects, keep working on the rest) or **Keep building** (build the recommendation and change course if you pick another). Big questions, ones that reach outside this computer or that most of the work depends on, always wait.

### Everywhere else

When a workspace needs you, a pill appears above its main agent's message box with the same actions. It steps through open questions ("Question 1 of 2") so you can answer without leaving the chat. The sidebar's Follow-up row counts how many workspaces are waiting, and nothing shows when nothing needs you.

![The composer pill "4 need you" opened into a popover: Question 1 of 2 with an answer field, then three repairs ready to send and an approved PR](docs/screenshots/follow-up-pill.png)

Tap a PR, or its segment in the bar, for a sheet with its checks, reviewers and Merge controls. When Merge isn't available yet, the sheet says what it is waiting for.

![The PR sheet for a PR whose required checks failed](docs/screenshots/follow-up-pr.png)

The expand icon next to the gear (or **Follow-up: open the larger view** in ⌘K) opens the workspace as a full screen, in two columns when there is room: what needs you on the left, the stacks and activity on the right. Esc or the collapse icon takes you back.

![The larger view: Needs you, tasks and activity on the left, pull request stacks on the right](docs/screenshots/follow-up-large.png)

In the agent's chat, Follow-up's own tool calls collapse into one-line rows, your answers and repair batches show as short cards instead of raw prompts, and the agent's Done call gets a card of its own.

![Follow-up rows and cards in an agent chat](docs/screenshots/follow-up-chat.png)

On a phone the workspace panel opens as a tab, and the PR sheet and pill popover open as bottom sheets.

![Follow-up at phone width: the panel, a PR sheet and the pill popover](docs/screenshots/follow-up-mobile.png)

## Needs-you inbox (beta)

The 1.1 beta adds an inbox for your agents. An agent lands in **Needs you** when its turn ends, when it asks a permission or question, when it errors, when Session Guard pauses it and needs a decision, when one of its PRs has nobody asked to review it, or when the PR merges. Red CI and review threads on a tracked workspace are the agent's work: with auto-send on (the default for newly tracked workspaces) Follow-up sends the repair to the agent and nothing flags; they flag only when you have to act (auto-send off, a hold, or a stuck repair). A turn that ends with `needs_you` kind=done ("Nothing needed") doesn't flag and leaves one muted line in the chat, and while Paseo still shows an agent running, a finished turn adds nothing. It stays there until you **sign it off** or **write to it yourself**, from any device. Opening it, reading it and Paseo marking it read change nothing.

- **One pill per agent** above the composer, only while something needs you there. It leads with the one thing that matters (*Decision 4m*, *Permission 2m*, *Send 2 fixes*, *Merge #812*, *Add reviewers #1499*, *Finished 12m*), using the same order as the brief card and the Needs-you row. Click it for **Sign off**, **Sign off & next**, **Later…**, the workspace's questions and PR actions, *Mute this turn*, *Don't flag finishes* and *Open Follow-up*. After a sign-off it reads *Signed off · Undo* for 6 s.
- **Sign off** in one step: the ✓ on a row, `/ok` in the composer (`/ok next` opens the next one), or ⌘K → **Follow-up: sign off & next**. Every sign-off can be undone for 24 hours.
- **One sidebar item, Follow-up**, badged with how many agents need you (hidden at zero). It opens Home.
- **Messages from automation don't count as yours**: agent-to-agent messages, Follow-up's own repairs, Defer, Smart Session and Session Guard continuations, and schedules leave the flag in place. Their turn end flags as usual. A script calling `paseo send` without an agent envelope counts as you until Paseo reports who sent a message.
- **Don't flag finishes** (per agent, in the row's ⋯ or the composer's **More**): for agents that run on a schedule, such as a plugin auto-update. Permission prompts and errors still flag.
- **First run** imports what Paseo marks unread and idle agents from the last 7 days you never replied to. Older idle agents wait in a one-time *Unsorted* list with a confirmed *Sign off all* that one Undo reverses.
- On Paseo builds with sidebar views (Paseo `main` after 2026-11-07, expected in the next release), **Settings > Sidebar > Sidebar view > Follow-up: Needs you** puts Home's list in the sidebar.
- Everything is in one settings page, **Settings > Follow-up** (⌘K → **Follow-up: settings**): Projects, Questions, Sidebar & pills, and the Needs-you inbox. Turn the whole inbox off there. Off means nothing is flagged and no pill or sidebar item is shown.

### What you need to do, front and center (1.2 beta)

When an agent needs you, Follow-up adds a **brief** at the end of its chat, right above the composer, so it's the first thing you see when you open the agent:

- **The ask in one line**, written as what you do: *Pick how the export API is rate-limited*, *Review and merge #813*, *Allow or deny: run the migration on staging*, or *Nothing needed. Daily updates are scheduled.* The same line shows on the inbox row and in the pill's tooltip, and the pill's label comes from it (*Asks*, *Merge*, *Error*, *Paused*, *Finished*).
- **Decisions as option rows.** Click one and it goes to the agent as your message, which clears the flag. Typing the letter or the option's label in the composer counts too. On a phone, or a window too short for the whole card, each option shows its letter and label, with what it means one tap away, so the card fits above the composer.
- **Only the context needed**, plus PR facts Follow-up already knows, and the one move for this kind of ask: *Squash & merge* (Follow-up's merge flow), *Retry the turn*, *Copy error* or *Sign off & next*. Permission briefs are a single line: Paseo's own prompt right below is the control.
- **Where it came from**, always: stated by the agent, from the permission request, Session Guard, the failed turn or Follow-up's PR state. If the agent stated nothing, the card says so and points at its last paragraph. It never guesses an ask.

The content comes from a new `needs_you` tool that every root agent gets while the inbox is on, with an instruction to call it once at the end of a turn. Contributors, recovery agents and subagents don't get it. After you answer, sign off or the agent keeps going, the card folds to one muted line, so the history still shows what was asked and what happened.

**Ask agents to state what they need** (on by default, in **Follow-up: display settings**): when a Claude Code root agent ends a turn without calling `needs_you`, Follow-up's Stop hook asks it once to call it, then lets it stop. It never asks twice in one turn, and skips subagents, contributors, recovery agents and agents waiting on a permission prompt. Codex and other providers get the instruction only. The settings screen shows how often agents stated what they need over the last 7 days.

### Home (1.3 beta)

The Follow-up sidebar row (and ⌘K → **Follow-up: Home**) opens **Home**: every workspace on the left, the one you pick on the right, answered without leaving it. It replaces the old overview and tracked-workspaces screens.

- **The list**, grouped by what it needs from you: **Morning brief**, **Needs you** (blocking asks first: permissions, errors, questions; then decisions only you make, like merge and add reviewers; then finished turns to sign off, oldest first), **Follow-up is fixing** (repairs in flight), **Running**, **Waiting on others**, **Later** (snoozed) and **Quiet**, folded by project and paged, with merged and signed-off work marked ready to archive. Each row has the last ask or action, up to two badges, the PR with its checks, and the age.
- **The detail pane** for the selected row: the brief (the ask, decisions as buttons), Allow / Deny for a pending permission, merge and add-reviewer actions, **Sign off**, **Sign off & next**, **Later…**, the agent's last few steps (read only for that agent), and a reply box. Sending a reply is you writing to the agent, so it clears Needs you. Only one button on screen is filled.
- **The brief pane** when nothing is selected: a headline that names the first move, who you're waiting on, what cleared since the last workday, **Done while you were away** (what Follow-up did on its own, with a link to the full log) and how fresh Paseo and GitHub data is.
- **Open full** opens the agent's chat and docks that workspace's own panel in its explorer column (its PR stack, tasks, questions, repairs, activity and **Details**). Its **Home** button goes back. On a phone, Home is the list and a row opens a full-height detail.

#### Beta 2: search, sort, status at a glance

- **Status strip**, pinned above the list: counts for **Needs you · Fixing · Running · Waiting · Quiet** (plus Later and "to archive" when there are any). A count shows only that group; press it again or **Show all** to go back. Zero counts stay, muted. The sidebar badge and the brief headline use the same counts.
- **Provider limits** under it, from the [Smart Session](https://www.npmjs.com/package/paseo-smart-session) plugin: one line per provider, such as "Claude 5h 62% · 7d 41% · resets 14:10". Amber from 80%, red at the limit; tap a line to see each ZeroSub account. The age shows when the reading is older than 15 minutes. Without Smart Session the line isn't there.
- **Search** ("Search workspaces, branches, PRs"; `/` or ⌘K → **Follow-up: Search** focuses it) matches workspace names, branches, PR numbers ("#1402" or "1402") and titles, agent and subagent titles, the project, Linear keys such as HER-1312, and the current ask. Words can come in any order, prefixes count and one typo is forgiven. Results are one ranked list (name above branch and PR above the ask, then recency) with the matched words marked and each row's group as a chip; archived workspaces come last. ↑/↓ move, Enter opens the result on the right, Esc clears.
- **Sort** (the menu beside search, remembered on this device): **Priority** (default), **Recent**, **Oldest waiting**, **Name** and **By project**. It orders rows inside each group; groups stay in place and search ignores it. Priority means urgency: blocking asks, then decisions only you make, then finished turns; inside those, a big open question first, then the nearest task deadline, then the oldest ask. When an agent has ranked workspaces with `set_priorities` in the last 6 hours, Priority uses those scores inside Needs you (blocking asks still first), each row shows the ranker's one-line reason and source, and the menu says "Ranked 12m ago"; otherwise it says "By urgency". Follow-up never writes a reason itself.
![Home: the list grouped into Needs you, Follow-up is fixing, Running and Waiting on others, with a permission selected and Allow / Deny, Sign off and the agent's last steps on the right](docs/screenshots/follow-up-home.png)

- ⌘K: **Follow-up: Home**, **Follow-up: Search**, **Follow-up: Sign off & next**, **Follow-up: Later (tomorrow 09:00)**, **Follow-up: Next needs-you**, **Follow-up: Done while you were away**.

### The Overseer (1.4 beta)

One agent you talk to about all your workspaces. It sits pinned at the top of Home's list, under the morning brief. Click **Start the Overseer** once, and Follow-up creates it in its own workspace, which is never tracked, never shown under Needs you, and never sent repairs. Its row shows whether it is idle, working, or asking you something. Selecting it opens the conversation in the right pane with a reply box, and **Open full** opens its chat.

- **It routes your asks; it doesn't do the work.** "Tell the HER-1312 agent to use option A" goes to the agent that owns HER-1312, and the Overseer answers in one line: "Sent to Okta SCIM sync (key HER-1312)". It scores candidates by Linear key, PR number, branch, workspace name, open asks and recent activity. When no candidate stands out, it asks you with a decision (the top two or three plus **New workspace**) instead of guessing.
- **What it forwards keeps your voice.** A forwarded message starts "From Tom via Overseer:". It clears that agent's Needs-you flag only when it answers the agent's open ask. A new task leaves the ask standing.
- **New workspaces only on your word.** It starts one, branched off main and named from the task, only after you asked or picked **New workspace**, and only through a dry run and confirm.
- **Never merges, approves, closes, archives or posts to people.** Those stay yours.
- **It is cheap to keep.** Each turn begins with a digest of what changed since the last one, built from Paseo's workspace metadata and Follow-up's own state. That's about 800 tokens at 100 workspaces, with resting workspaces in one line. The digest file is rewritten only when its content changes, and not at all while the resource governor pauses background work. The Overseer never reads the timeline of an agent that isn't loaded, because that would load the agent for an hour. Instead it reads the agent's transcript from disk, or Follow-up's cached goal and PRs. Sending to a resting agent wakes it, so that happens only when you ask for it, and the reply says "woke …".
- **Archived it by accident?** Follow-up starts a new one with a handoff from the old one's last steps.

Turn it off under Settings → **Overseer (beta)**.

![Home with the Overseer selected: the pinned row asks which agent should take a broken export, and the pane shows the conversation, the routed task and the decision with two candidates plus New workspace](docs/media/overseer/overseer-dark.png)

Install the beta:

```sh
paseo plugin update follow-through --version 1.4.0-beta.0
# or, for a fresh install:
paseo plugin install npm:paseo-follow-up@beta
```

Go back to the stable release (the inbox file stays on disk and is ignored by 1.0.1):

```sh
paseo plugin update follow-through --version 1.0.1
```

Betas publish to npm's `beta` dist-tag, so `paseo plugin update` without `--version`, and scheduled updates that follow `latest`, never pick one up.

## How it works

- The workspace's main agent owns its PRs, tasks, questions, the spec link and the Done call. Other agents in the workspace can register PRs and check status.
- **Follow every workspace** (on by default since 1.3.0-beta.2): every workspace with an agent is followed, and **Send repairs automatically** (also on by default) means review threads and red CI go to the agent without you. The first start of 1.3.0-beta.2 backs up `state.json` to `state.before-follow-every.json.bak`, then turns following and auto-send on for every workspace Follow-up already knew. Turn auto-send off for one workspace under **Workspace exceptions** and each repair batch waits for your click; with it on, Follow-up sends batches itself once the agent is idle, after fresh permission and Session Guard checks.
- Follow-up never merges, turns on merge when ready, requests reviewers or archives on its own. **Merge** re-checks the stack, lists any PRs underneath that would merge first, and asks again.
- A merged PR is not the end: tasks such as production checks and open questions keep the workspace open until the main agent declares Done and everything has settled.
- Answers go out only when you click Send. Follow-up never answers for you.

### Agents can do what you can click

Tell an agent "the PRs look good, assign reviewers on all" and it can do it. Every root agent Paseo launches gets Follow-up's action tools, which run the same server code as the buttons, so the inbox, briefs and PR state change exactly as if you clicked:

| Tool | Does what this button does |
| --- | --- |
| `list_prs` | Reads tracked PRs across all workspaces (draft, checks, threads, reviewers, merge blockers). Filters: `needs_reviewers`, `ready_to_merge`, `workspace`. |
| `add_reviewers` | **Add reviewers**, on one PR or many. Repository defaults, or the logins you name. |
| `merge`, `enable_merge_when_ready`, `disable_merge_when_ready` | **Merge** and the PR sheet's merge-when-ready switch, with the same plan and blockers. |
| `send_repairs`, `set_auto_send`, `clear_hold`, `retry_batch`, `track` | **Send**, the **Auto-send** switch, **Resume**, **Retry**, following a workspace again after an opt-out. |
| `set_priorities` | Stores external priorities for Home's Priority sort: per workspace a score 0–100, a one-line reason and sources (Linear, Slack, planning, GitHub, Paseo). Plans first; `confirm: true` with the plan id stores them. Used for 6 hours. |
| `inbox_list`, `sign_off`, `snooze`, `set_finish_flags` | The Needs-you list, **Sign off**, **Later** and **Don't flag finishes**, for other agents only. |

Tools that act on a list, and merge, return a dry run first and act only when called again with `confirm: true` and that plan's id. Their descriptions tell the agent to use them only when you asked. An agent can't sign itself off. Recovery agents, contributors and subagents don't get these tools, and the daemon checks the caller again on every call.

## Send to Paseo and Graphite

With [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) on the same daemon, its composer picks the agent that registered the PR. With Send to Paseo 2.2+, Follow-up can also toggle Graphite's **Merge when ready** through your existing pairing, while Graphite is open and signed in. Each change is confirmed in Chrome, which can remember the permission per repository. With the next Send to Paseo release, its popover on a PR page also shows which tracked workspaces own the PR, with Follow-up's one line for each (for example "Needs you · Merge ready"), and opens the workspace's main agent in the Paseo app or web app. See the [integration and security contract](https://github.com/tomgrin10/send-to-paseo/blob/main/docs/follow-up-integration.md).

## Data and access

Paseo plugins run trusted, unsandboxed code on the daemon host. Follow-up reads workspace metadata, agent history and GitHub PR status with your existing credentials, and keeps its state in `$PASEO_HOME/plugin-data/follow-through`. It registers scoped MCP tools and reversible provider hooks only for tracked sessions, plus the action tools for root agents (above). GitHub and Graphite writes happen only after an explicit click, or a root agent's confirmed plan, and a fresh eligibility check.

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

Questions, question modes and the activity log are adapted from [Progress](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) by Steve Castaneda (MIT). Its notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Other plugins

- [Defer](https://github.com/tomgrin10/paseo-defer) — Schedule messages for later delivery.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, process, agent and Docker monitoring.
- [Workspace Switcher](https://github.com/tomgrin10/paseo-switcher) — Arc-style Ctrl+Tab between recent workspaces.
