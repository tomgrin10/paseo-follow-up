# Release notes

What changed in each version of Follow-up, newest first. Follow-up shows the curated part of a major release in "What's new" after the update, and every version's notes from Home's version line.

## 2.0.0 (2026-11-11)

Follow-up is a Paseo plugin that keeps track of every workspace your coding agents work in, until the work is merged and done. It shows you in one place which agents are waiting on you and why, sends failed checks and review comments back to the right agent by itself, and lets you answer an agent's question without opening its chat.

![Follow-up Home: every workspace in one list, with the selected workspace's question on the right](https://raw.githubusercontent.com/tomgrin10/paseo-follow-up/main/docs/screenshots/follow-up-home.png)

### One list of what needs you

Home lists every workspace, grouped by what it needs from you. When an agent finishes, asks something, hits an error or waits for a permission, it moves to the top, under Needs you, and stays there until you mark it done or reply. You can act on it right there, without switching to its chat.

### Answer questions from anywhere

When an agent needs a decision, it asks in a card with lettered options, its recommendation and room for your own answer. Answer on Home, in the workspace's side panel, in the bar above the agent's message box, or on your phone. The answer goes straight into the agent's chat.

![A question card with three options, one recommended](https://raw.githubusercontent.com/tomgrin10/paseo-follow-up/main/docs/screenshots/follow-up-questions.png)

### Fixes go back to the agent

When a PR's checks fail, it hits a merge conflict or a reviewer leaves comments, Follow-up sends them to the agent that made the PR, in one message once it's idle. You're only asked for what's yours to decide, like merging. Works with plain GitHub; Graphite is optional.

### Context at a glance

Each workspace gets a one-line description of what it's for, and a list of the Linear issues, Slack threads and docs it's about. Ask about any workspace from Home's search box, and an agent that knows all of them passes your ask to the one doing the work.

### Fits your setup

Its small background jobs, like writing those descriptions, run on any model provider Paseo has. Agents can do anything you can click in Follow-up, after showing you a plan. It updates itself when nothing is busy and rolls back if an update fails.

### Credits

Thanks to [Progress](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) by Steve Castaneda and [Better Paseo](https://github.com/RoundRedDot/better-paseo) by RoundRedDot, which Follow-up borrows ideas from.

<details><summary>Full changelog since 1.0.1</summary>

### Home and Needs you

- Home: every workspace in one list, grouped by what it needs from you, with a detail pane to answer, merge or sign off without leaving it.
- Needs you: an agent lands there when its turn ends, it asks something, it errors or it waits on a permission, and stays until you sign it off or write to it, from any device.
- A pill above the composer leads with the one thing that needs you in that chat, and the sidebar's Follow-up item counts the agents that need you.
- Home's search matches workspace names, branches, PR numbers and titles, and linked issue keys. Sort orders each group by priority, recency, age or name.
- Right-click a workspace on Home, or long-press it on a phone, for quick actions: Later, Sign off, answer its question, send repairs, copy the branch or PR link, and more.
- Later puts a workspace off until a time you pick, shows when it comes back, and has Undo and Bring back now. An agent's "tonight" or "tomorrow" means your timezone.
- Repairs queued for an idle agent show in Needs you with a Send button, and a workspace with everything in but no Done shows Ready to finish.
- An action card has a Done button that tells the agent you did it. Done shows as in progress while you can still undo it.
- Ctrl+Z (Cmd+Z on a Mac) undoes the last action while its Undo message shows, on any keyboard layout.
- You can select and copy text in cards, the panel, Home, sheets and messages.
- Follow-up's version shows at the top of Home and the panel. Tap it for Settings and the release notes.

### Questions and answers

- When an agent needs you, a card at the end of its chat says the ask in one line, with decisions as buttons and only the context you need.
- Every question with options ends with Something else, for your own answer. Questions with several decisions let you pick every answer, then send them in one message.
- Your answer is recorded at once. The card shows Sending until the agent has it, offers Send again if it couldn't be delivered, and never sends it twice.
- Press Cmd+Enter (Ctrl+Enter) to send an answer or save a dialog, even while typing a note.
- Links in questions, cards, tasks and agent replies are clickable, including PR references like owner/repo#123.
- An answered question stays on its card, folded to what was asked and what you picked, and a card answered somewhere else or replaced by a newer one says so.
- Question and option text is shown whole; long context opens in full with Show more.

### Repairs and PRs

- Follow every workspace and Send repairs automatically are on by default. On a fresh install, auto-send waits until you finish or skip setup.
- Works with plain GitHub; Graphite is optional, chosen per repository. Settings → Following → Shipping PRs sets how each repository ships PRs.
- On plain GitHub, the PR sheet follows GitHub's own review and check verdict.
- Reviewers per repository, plus a default list, for Add reviewers.
- A deploy Follow-up has seen stays counted until a rollback, and Done goes through with a note when Follow-up can't check what production serves.
- Saving a spec link, a task's schedule or a reviewer pick closes at once and confirms with a short message.

### Agents and the main agent

- Agents can do everything you can click in Follow-up, including its settings, setup and priorities. Changes show a plan first.
- An agent can take over as a workspace's main agent when the main one is gone or idle, or when you ask. The panel names the main agent and shows a change for a day, with Undo.
- When an agent answers or acts for you, Follow-up records that agent, not you, and the card says whose answer it was.
- Trust bypass: pick agents whose permission prompts Follow-up approves for you, with secrets masked in what it approved.
- Claude agents keep working while a long command runs, instead of ending their turn to wait. This replaces the separate Wait plugin. Jobs stop after 3 hours unless the agent asks for longer.
- On Paseo 0.16, agents leave long commands to Paseo, an agent with a command still running counts as running, and other plugins' background helpers are left alone.
- Follow-up's routine tool calls stay inside Paseo's grouped rows; only a question asked and Workspace done stand out in the chat.

### The Overseer and AI priority

- The Overseer: one agent you talk to about all your workspaces. Ask it from Home's search box or ⌘K, and it passes your ask to the agent that owns the work. What it forwards starts "From the developer via Overseer:".
- AI priority orders Home from your Linear issues, Slack DMs and mentions and GitHub review requests, with a one-line reason for each workspace. Re-rank now answers at once, and rankings stay steady when nothing changed.

### Summary and Linked items

- Summary: one short sentence under each workspace's name saying what it's for. Rewrite it from the panel.
- Linked items: the Linear issues, Slack threads, docs and artifacts each workspace is about, next to its Spec with a count for each. Open the list to see who linked each one and why, add one by pasting a link or key, or remove one with Undo.
- Agents link what they start from, and Follow-up picks links up from your messages and the agent's lookups. A Linear key counts only once Linear confirms it.

### Helper agents and providers

- Settings → Agents sets the provider, model and effort for Summaries, the Overseer, recovery and AI priority, and recommends a model from what you have, with Use recommended.
- Summaries and AI priority run on any provider Paseo has. Other providers run each job as a short hidden agent.

### Setup, Settings and updates

- Follow-up moves itself to its new plugin id, follow-up, once while nothing is busy, keeping your workspaces and settings. It needs Paseo 0.15 or later.
- Getting started: a short first-run setup that checks GitHub and the helper agents, shows what Follow-up does on its own, and sets your defaults.
- Settings has five categories: General, Following, Reviewers, Agents and Inbox & display. Tabs on desktop, a list you tap into on a phone.
- Follow-up updates itself: Install automatically, Tell me or Off, on the Stable or Beta channel. It installs only when no agent is busy and goes back to the old version if the new one fails.
- What's new pops up only after a major update, once per device.
- With reduced motion on, setup's steps show at once.

### Phone and performance

- Reworked for phones: Home, the cards, the composer pill and Settings fit a phone screen, with real tap targets.
- Far less load on Paseo: one shared list of agents and workspaces instead of asking for them every few seconds, and no polling while the app is hidden.
- On Paseo 0.15 and later, agents get Follow-up's tools through Paseo itself, so no extra process starts per agent. The old per-session registration is removed, with a backup of each file it touched.
- After an update, agents in the middle of a turn keep using Follow-up's tools instead of hitting "tool not found".

### Fixes

- Home, the panel and the header agree on what Follow-up is doing, and "Follow-up is fixing" shows only while repairs are really with the agent.
- A question an agent asks again no longer shows up twice.
- A card in the chat closes only when you answer it, not on another agent's message, a Follow-up prompt or a schedule.
- A card shows a PR's checks and reviews only when it's about that PR.
- Recent steps label other agents' messages and Follow-up's own, and never report Follow-up's bookkeeping as the agent's work.
- In a workspace with several agents, each row shows only its own reason and error.
- An agent that failed a turn and kept running no longer shows Error, and Follow-up resumes on its own unless you stopped it.
- Review requests are found reliably, and an account that fails to load no longer reads as "no review requests".
- Trusted agents no longer wait on permission prompts that were already showing when Follow-up started.
- An answer card shows your whole answer and note.
- If your Claude or Codex settings file is a link, Follow-up updates the file it points to and keeps the link.
- Error messages are as short as Paseo's own, with the full reason where Open takes you.

</details>
