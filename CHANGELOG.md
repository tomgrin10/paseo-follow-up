# Release notes

What changed in each version of Follow-up, newest first. Follow-up shows these in "What's new" after an update, and in full from Home's last line.

## 1.4.0-beta.26 (2026-11-10)

- A finished workspace no longer stalls short of Done when Follow-up can't check what production serves. Done goes through with a "Deploy not confirmed by Follow-up" note.
- A deploy Follow-up has seen stays counted until a rollback. If the agent declares Done while a rollout is still going, Follow-up records Done when it lands.
- The chat shows "Workspace done" only when Follow-up accepted it, and declaring Done twice adds no second card.

## 1.4.0-beta.25 (2026-11-10)

- A question an agent asks again no longer shows up twice in Needs you. Agents get the open question back, and existing duplicates close on update.

## 1.4.0-beta.24 (2026-11-10)

- Claude agents now keep working while a long command runs, checking on it at least once a minute instead of ending their turn to wait. Turn it off in Settings → Agents → Wait for background jobs.
- This replaces the separate Wait plugin. While that plugin is installed, Follow-up's own Wait stays off and Settings says so.

## 1.4.0-beta.23 (2026-11-10)

- After an update, "What's new" shows the notes for every version since you last looked, once on each device.
- Home's last line shows your Follow-up version, with the full release notes one tap away.

## 1.4.0-beta.22 (2026-11-10)

- An agent can take over as a workspace's main agent when the main one is gone or idle, or when you ask it to. It can hand the role on too, within clear limits.
- When the main agent changes, the workspace panel shows who took over and why for a day, with Undo, and Home marks the workspace.

## 1.4.0-beta.21 (2026-11-10)

- Agents can do everything you can click in Follow-up: read and change its settings, setup, priorities and the Overseer. Changes show a dry run first.

## 1.4.0-beta.20 (2026-11-10)

- Follow-up is reworked for phones: Home, the decision card, the composer pill and Settings all fit a phone screen, with real tap targets.
- On the phone, only Home's search row stays pinned; the status chips and the setup offer scroll with the list.
- Home on the phone says when nothing is followed yet, and an open question now outranks "Finished".

## 1.4.0-beta.19 (2026-11-10)

- Settings → Following → Shipping PRs sets how each repository ships PRs, and setup asks "How do you ship PRs?".

## 1.4.0-beta.18 (2026-11-09)

- Graphite is optional: repositories that use plain GitHub PRs work fully, chosen per repository.
- On plain GitHub, the PR sheet follows GitHub's own review and check verdict.

## 1.4.0-beta.17 (2026-11-09)

- The workspace panel names the main agent, and swapping that role has an explicit Undo.
- A main agent that closes briefly keeps its role instead of handing it to another agent. Make main agent hands it back.

## 1.4.0-beta.16 (2026-11-09)

- Review requests are found reliably, and an account that fails to load no longer reads as "no review requests".

## 1.4.0-beta.15 (2026-11-09)

- On a fresh install, auto-send waits until you finish or skip setup.

## 1.4.0-beta.14 (2026-11-09)

- Getting started: a short first-run setup that checks GitHub, shows what Follow-up does on its own, and sets your defaults.

## 1.4.0-beta.13 (2026-11-09)

- Trusted agents no longer wait on permission prompts that were already showing when Follow-up started or updated.

## 1.4.0-beta.12 (2026-11-09)

- AI priority gives every ranked workspace a reason, and Re-rank now answers at once while ranking runs in the background.
- Rankings are steadier: a workspace whose inputs didn't change moves only a little between runs.
- Changing the ranker's model or effort in Settings re-ranks instead of keeping the old order.

## 1.4.0-beta.11 (2026-11-09)

- Settings is split into four categories: Following, Reviewers, Agents, and Inbox & display. Tabs on desktop, a list you tap into on the phone.
- Reviewers, Projects and Workspaces fold away, with a one-line summary when folded.
- Trust bypass moved to Following → Permissions, and the phone reopens the category you used last.

## 1.4.0-beta.10 (2026-11-09)

- Questions with several decisions let you pick every answer first, then send them all in one message.
- An answered question stays on the card, folded to what was asked and what you picked.

## 1.4.0-beta.9 (2026-11-09)

- Trust bypass: pick agents whose tool permission prompts Follow-up approves for you.
- Secrets are masked in what it approved, and the list says "None approved yet" until it has approved something.

## 1.4.0-beta.8 (2026-11-09)

- What's this about? sits at the top of Home's detail pane on the phone too.

## 1.4.0-beta.7 (2026-11-09)

- AI priority: Home's Priority sort can rank workspaces from your Linear issues, Slack DMs and mentions, GitHub review requests and the weekly plan, each with a one-line reason.

## 1.4.0-beta.6 (2026-11-09)

- Follow-up puts far less load on Paseo: it keeps one shared list of agents and workspaces instead of asking for them every few seconds.

## 1.4.0-beta.5 (2026-11-09)

- After Follow-up updates, agents in the middle of a turn can keep using its tools instead of hitting "tool not found".

## 1.4.0-beta.4 (2026-11-09)

- Settings → Agents: choose the provider, model and effort for What's this about?, the Overseer, recovery agents and the priority ranker.

## 1.4.0-beta.3 (2026-11-09)

- Ask the Overseer from Home's search box or from ⌘K.

## 1.4.0-beta.2 (2026-11-09)

- On Paseo 0.15 and later, agents get Follow-up's tools through Paseo itself, so no extra process starts for each agent.
- Older versions registered Follow-up for every Claude and Codex session on the machine. That registration is removed, with a backup of each file it touched.

## 1.4.0-beta.1 (2026-11-09)

- What's this about?: a short AI overview of each workspace, with its linked Linear issues, PRs, Slack threads and docs.
- Reviewers per repository, plus a default list, for Add reviewer.

## 1.4.0-beta.0 (2026-11-09)

- The Overseer: one agent you talk to about all your workspaces. It passes your asks to the agent that owns them.
