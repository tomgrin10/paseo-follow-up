# Release notes

What changed in each version of Follow-up, newest first. Follow-up shows "What's new" after an update that brings new release notes: the curated part of each stable release since you last looked (betas install quietly; Settings → General can turn it off), and every version's notes from Home's version line.

## 2.4.0 (2026-11-25)

Start new work in one step, rank it by what the people you follow ask for, and use Follow-up with any agent provider, GitHub or not.

- **Dispatch starts new work** from a Linear issue, a link or a sentence: Follow-up makes the workspace, starts the agent and tracks it. Agents and the Overseer can start work too once you agree.
- **Compass ranks by what matters to your team.** Pick the people and sources whose words set your priorities. AI priority ranks by them, and the morning brief shows what moved in your Linear queue.
- **Any provider, GitHub optional:** agents on OpenCode, Pi, Copilot, Cursor and more get Follow-up's tools, and everything but the PR features works without the GitHub CLI.
- **PR statistics** show who opens, merges and reviews PRs, and how long PRs wait for a first review, for the repositories you turn on.
- **Setup fits your machine:** it skips what you can't use, shows each helper agent on one line, and its tour covers Dispatch.
- **Paste or drop images** into replies, Dispatch and the Overseer. Agents wait for CI without polling GitHub, and tasks come due on their own. Plus many smaller fixes.

<details><summary>Full changelog since 2.3.0</summary>

### Dispatch

- Dispatch: start work from your Linear issues, a pasted link or a sentence. Pick an action (Create PR, Plan as artifact, Investigate and more) and Follow-up creates the workspace, starts the agent and tracks it.
- Open Dispatch from Home's button, the sidebar's Dispatch row, ⌘K (typing "new" finds it too), or its key from anywhere: ⌘⇧N in the desktop app, ⌘⇧O in a browser tab (Settings → Display).
- Agents can start new work for you from a Linear issue, a GitHub issue or PR, a link or a sentence: they show what they would start and where, and start it only once you agree. A start can be undone for 10 minutes.
- The Overseer now starts new workspaces the way Dispatch does, so it picks the project your team's work usually goes to and says why.
- Home shows what Dispatch just started, with Undo for 10 minutes.
- In Dispatch's text box, Shift+Enter starts a new line, and the arrow keys move through a task of more than one line. Search all of Linear runs from its row.
- Dispatch's text box is the main element now: wide, at the top, and it grows as you write.
- Dispatch suggests only issues you could start. An issue another workspace already has, linked or with a PR that names it, folds into one row at the end of My issues, and Enter there opens that workspace.
- Settings → Dispatch: reorder, hide or reset its actions, pick which project each Linear team's work goes to, and set the base branch per project.
- Settings → Agents → Dispatch picks the agent Dispatch starts; it's the Overseer's until you choose one.
- The sidebar's Dispatch row is optional: switch it off in Settings → Dispatch. Dispatch stays on Home, in Command-K and on its key.
- Settings → Dispatch suggests hiding Paseo's own New workspace row, since Dispatch starts workspaces too.
- A new agent's first message is short: the issue, a line to read all of it itself, what to do, and your own words. Neither Dispatch nor the Overseer pastes the issue's description into it any more.
- Dispatch's first message to the agent no longer repeats your words, and branch names end on a whole word.
- Typing in Dispatch no longer makes the preview flicker, and a project or agent you picked stays while you type.
- On a phone, Dispatch's other actions wrap instead of cutting off their names.
- The Overseer starts only the issues you approved: picking Skip for one decision on its card keeps that issue from starting.

### Compass and the morning brief

- Compass: pick the people whose words set your priorities, like your product lead's DM. Each workday morning Follow-up notes what they asked for, in their words, and AI priority ranks by it.
- Settings → Compass is one list of everything that sets your priorities, the people you follow and your Linear queue, chat, calendar, mail and review requests, each with its role.
- Settings → Compass reads as one list: every source and built-in input has the same row, Add a source sits right under your sources, and Connections no longer repeats a row's failure.
- Compass reads more than chat: a doc or a notes file on this machine, a Linear project or milestone, a GitHub label or milestone, and your calendar's meetings, which date the work they match. Trackers and calendars need no model.
- A Compass source can read everyone in a team or customer channel, the newest 40 messages each read, and your reading notes can narrow it.
- Tell Compass how to read each source in your own words ("P0 means today"), and teach it your names for things with a glossary. Agents can set it up for you too.
- Compass also reads during the day while Follow-up is open: every 2 hours by default, or set it in Settings → Compass → When. The Overseer now knows what Compass heard.
- Compass on screen: the panel's new Why it matters shows where AI priority ranks the workspace and the notes behind it, with the quote, who said it and until when.
- From a Compass note you can open the message, ask the Overseer about it, tell the workspace's agent, change its date, move it or unpin it. An agent can pin a note in your words.
- Home's reason line and Catch up show a workspace's Compass note with the compass glyph.
- When someone you follow in Compass says an issue nobody has started is urgent, it shows in Needs you as "Nobody's on it", beside issues raised in your Linear queue. Less urgent ones sort first in Dispatch, with who asked.
- This week's plan comes from Compass: give a source Posts the plan and the newest plan they share is picked up as soon as Compass reads it, with how many items have no issue. Find it for me's person and channels move over on their own.
- In Settings → Compass, pick where this week's plan comes from. Find it for me looks for the newest artifact link from the person and channels you pick, or paste a link, or turn it off.
- When no plan shows up this week, the brief keeps last week's and says so, with a field to paste the new link.
- This week's plan is read and never changed: Follow-up now refuses any attempt to publish, edit or delete the plan, whatever the plan's text says.
- The morning brief shows what moved in your Linear queue since you last read it: new urgent issues, raises, due dates that moved, and issues that left. Urgent issues with no workspace come with Create PR and Plan right there.
- The morning brief says what Compass heard since you last looked, in the same "Since" block as your Linear queue, and Home's brief line says who it heard from.
- Follow-up reads your whole Linear queue every workday morning, not just the 75 newest issues, and tracks what changed: raised from Low to High, new and urgent, a due date moved, or left your queue and why.
- AI priority weighs what changed in your Linear queue, and an urgent or newly raised issue with no workspace shows as not started.
- Choose which Linear states count as your queue, when the morning sweep runs, your time zone and your workdays. Agents can change these too.
- The morning sweep and AI priority's hours follow your own time zone and its usual working week. Agents can read the queue and sweep it.
- "47 issues by priority" opens your whole queue, grouped by priority, with No workspace and Changed filters and Start… on every issue.
- Your Linear queue shows who opened each issue and how long ago, or "opened by you" for your own. Hover for the exact date and time.
- An issue raised to Urgent or High that has no workspace shows in Needs you until you start it or remove it.
- A raised issue that already has a PR in a workspace no longer shows in Needs you.
- Settings → Compass now lists every source the brief reads: your issue tracker, chat, calendar, GitHub and Paseo, each with what it adds and whether it's working. Mail is there too, off until you turn it on.
- The brief now reads today's meetings, and you can pick how far back it reads chat (24, 48 or 72 hours). Agents can turn sources on and off too.
- A source that failed says why and offers Retry. One that needs a sign-in tells you where to sign in.
- A server the morning brief doesn't know can still feed it: turn on Ask for it in Settings → Compass → Sources. Preview what it would find first, then turn it on.
- Ask uses a fast model to pick a few read-only lookups each morning and sums up what needs you. Every lookup is checked first, and it never changes anything.
- Follow-up finds each source by the tools mcpproxy offers, so a renamed server still works. It only ever calls read-only tools.

### Any provider, GitHub optional

- Follow-up now works when your agents run on OpenCode, Pi, Copilot, Cursor or any other provider Paseo supports, not only Claude Code and Codex: they get Follow-up's tools, the Needs you call and, on Paseo 0.17, its instructions.
- Helper agents never default to a provider you don't have: with no Claude installed, summaries, AI priority and the Overseer run on what Paseo has. Settings → Agents says in one line what agents on other providers don't get.
- On a provider other than Claude or Codex, jobs that read other people's words no longer run there, and Settings → Agents says which.
- On Paseo 0.17, agents get Follow-up's standing instructions once, in their system prompt, so Codex agents no longer get them repeated with every message.
- On Paseo 0.17.2 and later, a message Paseo holds until the agent's turn ends reads "Queued", and a message that had to stop the agent's turn says so.
- A new agent in a project Follow-up follows by default now gets Follow-up's tools from its very first session, and starts a little faster.
- GitHub is now optional. Without the GitHub CLI, workspaces, Needs you, questions, Catch up, the Overseer, tasks and Compass all work, and setup offers GitHub instead of failing.
- Each GitHub feature (PR status, merge, reviewers, waiting for checks, PR stats) says in one line what's missing and how to turn it on. Installing and signing in is picked up without a restart.
- While GitHub is off, a workspace's Refresh checks for it again at once.
- Setup skips steps with nothing to set on your machine, says Follow-up works with every agent Paseo runs, waits for a provider still loading, shows each helper as one line with Change, and its tour shows Dispatch.

### Home and Needs you

- The search shortcut (⌘⇧K by default), ⌘K "Follow-up: Search" and / now always put the cursor in Home's search, also from Catch up, PR stats or Settings, while Home is still loading, and when you opened Home before.
- On Paseo 0.17.1 or newer, Done shows as a green badge on the workspace's sidebar row instead of a label, with its own switch in the sidebar's Show menu.
- Archive a workspace from its row menu. It asks first and says what archiving does to that workspace, such as uncommitted changes in its worktree being lost.
- The row menu no longer offers Copy PR link.
- A closed agent's real ask with nothing new for 3 days moves to a folded Older group under Needs you, out of the count. It comes back if the agent runs again.
- Needs you no longer lists closed agents' flags that ask nothing, or flags from archived workspaces.
- The chat's "No ask stated" card now points at what Needs you is waiting on instead.
- An ask shows once in Needs you: when the agent's note at the end of its turn is about a blocked task, it folds into that task's card instead of sitting beside it.
- A blocked task that needs you to do something, not decide, now has a Done button instead of asking you to write a decision.
- Done on an action card is one click everywhere: the panel, Home and the chat card show one Done button, with Add note and Reply instead beside it, instead of an option to pick and then Send.
- On an action card, Sign off shows ✕ instead of ✓ and is never the main button, because Done is what tells the agent. The card has no Q1 chip.
- On an action card, Add note and Reply instead fit beside Done in the narrow panel. Done keeps its Ctrl ⏎ hint where there's room, and Ctrl+Enter sends Done on the chat card too.
- Sign off & next and `/ok next` skip the rows Needs you no longer shows.
- Report an issue and Rename title with AI also open on the screen you're looking at.
- Home with nothing followed offers Dispatch on desktop too.

### Agent's tasks

- Tasks no longer sit forever as "Manual". Each task now says what moves it: waiting for its pull request, due because it merged or deployed, due because you answered the question it waited on, or a re-check date.
- When a task comes due, its agent is reminded at the end of its turn to do the check and close it, or to set a new re-check date. It is reminded at most twice, and nothing is closed for it.
- A due task the agent ignores twice shows as stale. Finished tasks are cleared from storage after 30 days.
- The workspace panel's Tasks card is now "Agent's tasks": one line by default ("6 open · 2 due · 1 stale"), amber only when the agent let a task go stale. Open it to see what moves each task, due ones first with the agent's note.
- The workspace panel's header line names the task the agent owes next, and question cards in the panel show the question before its context.
- In the workspace panel, the next message to the agent and the PR repairs in it have their own card, and finished tasks are listed in Activity.
- Polish in the workspace panel: stale tasks are a clearer amber in light mode, "in Activity" under the tasks is a link, the Questions tab counts only real questions, and a question without options just asks for your answer.
- Adding a task that looks like one already open no longer makes a second copy. The agent gets the open task's id and updates it, or says it really is a separate task. Repeating its own exact title updates that task.
- The Follow-up skill no longer tells agents that tasks are manual. It says what the tool says: a task comes due when its pull requests merge or deploy, or on its re-check date.
- A task waiting on your decision no longer shows a second card for a question you already have or answered. The task shows which question it waits on, and an extra card from before closes as "Already asked as Q1."

### Repairs and PRs

- What Follow-up sends the agent (conflicts, review comments, failed checks) now reads "repairs" everywhere: Messages, Needs you, Home, Activity, Settings. "Tasks" means only the agent's own to-do list.
- When an agent says part of a repair waits on a person, such as one review thread that needs the reviewer's call, that part shows in Needs you and on the workspace's Home row, with Open #N and Hand back to agent.
- Later messages tell the agent to leave a part that waits on a person and count only the threads it acts on. An agent that says it is already on it keeps the part.
- An agent can say it is already on a repair. Follow-up then waits for that work instead of sending the same items again, and it no longer shows as a failure.
- A review that keeps getting new comments no longer sends "do this" then "never mind" seconds later: the agent gets an update saying what is new, and only a review that is really gone reads "No longer needed".
- Repairs keep going out on their own when a subagent is stuck in an error or never goes idle, and older stuck or duplicate repairs tidy themselves up after the update.
- Agents wait for CI without polling GitHub: they ask Follow-up once and get one message when the checks finish, so your GitHub limit lasts longer.
- Activity says which PR changed on GitHub ("#12 changed on GitHub") instead of "1 repair updated on GitHub".
- Long stacks are easier to scan: the stack bar groups PRs instead of drawing a thin line, and the Pull requests list folds runs of PRs that are just in review, so the ones that need fixing stay in view.
- Home's PR chip and the panel's status line now show the worst PR in a workspace, so a failing PR further up a stack is never hidden behind a green check.
- Home's PR chip now counts the PRs with failed checks, the same number the panel's status line shows.
- A PR that holds a merge now says "checks failed", in the same words as the PR rows.
- On a phone, the stack bar is no longer a row of tiny tap targets. Tap the PR rows below it instead.
- Home and the workspace panel stay fast on stacks with hundreds of PRs.
- Add reviewers asks the people the row names in one click, with no sheet in between. Click it on several rows in a row: each one goes out, and the rows stay where they are.
- Send to Paseo can now show when a PR's agent is closed, instead of the PR looking like nobody owns it.
- Send to Paseo can color its button by how a PR's workspace is doing (needs you, working, ready to merge), using the same colors as Home.

### PR statistics

- PR statistics: see who opens, merges and reviews PRs, and how long PRs wait for a first review, per repository you turn on. Open it from Home's header icon or ⌘K "Follow-up: PR stats".
- Sort the PR statistics leaderboard by PRs opened, merged, wait for a first review, reviews given or review turnaround, for this week, last week, 30 or 90 days. A person opens their PRs and the reviews they gave.
- Turn PR statistics on per repository in Settings → Following → PR statistics. It reads GitHub slowly in the background, stops whenever GitHub's limit runs low, and stays on this machine.
- Turning on PR statistics works while your machine is busy: the cost estimate still loads, and if it can't, the dialog says why and still lets you turn them on.
- Refresh on the PR stats page and on a workspace reads right away even when the machine is busy; only background work waits.

### Images

- Paste or drop images into Dispatch, the Overseer, More context, question and brief answers, and reply boxes on desktop. They go to the agent with your words.
- Every field that takes images has an Add image button that opens your file picker on desktop and in the browser.
- Each attached image shows as a small thumbnail you can remove. Past six images or 5 MB, or for an agent that can't read images, the field says so before you send.
- Agents can attach image files too when they answer or start work for you.

### Fixes

- Dispatch opens again after you visit Home a second time. It used to land on Home with nothing open.
- Asking the Overseer to start workspaces in chat works again, including "create workspaces for these" with several issues. It no longer asks you again on a card.
- Workspaces with very long stacks work again: PR status, Merge when ready and Add reviewers no longer fail with "Too big: expected array to have <=50 items" past 50 PRs.
- When Follow-up does hit one of its own limits, it says what didn't fit in a plain sentence instead of showing raw error data.
- With a row menu open, Enter no longer opens the selected workspace behind it.
- A workspace whose agent is working again no longer sits in Needs you as "Finished · No ask stated".
- Follow-up gives back memory more reliably once a busy stretch is over.

</details>

## 2.3.0 (2026-11-22)

Clear what doesn't need you, find the workspace you meant, and spend far less of GitHub's limit.

- **Dismiss anything in Needs you**, questions included, with the small × in its corner. Remove and Keep sit side by side, the agent isn't messaged, and Undo brings it back. A removed item returns by itself when something about it changes.
- **Search finds what you meant**, even typed on the wrong keyboard layout, in any language. Search from anywhere is now ⌘⇧K (Ctrl+Shift+K), since Paseo 0.17 uses ⌘/.
- **Ask for More context anywhere:** the panel, Home, the question dialog, the chat pill or your phone.
- **Repairs reach your main agent as soon as it's free**, even while its subagents keep working, and a waiting repair says what it's waiting for.
- **Far less of GitHub's limit:** Follow-up reads a PR in full only when something on it changed, and pauses its checks if the limit runs low.
- **Settings are tabs** on Follow-up's own settings page on Paseo 0.16 and later, and Home lists its keys when you press S. Plus many smaller fixes.

<details><summary>Full changelog since 2.2.0</summary>

### Home and Needs you

- Dismiss anything in Needs you with the small x in its corner: an agent's ask, a merge or reviewers ask, repairs waiting on you, and the rest. The agent isn't messaged, and Undo brings it back.
- On Home, Enter opens the selected workspace's chat however you picked it, including pressing Enter again right after a search. O does the same, as in Catch up.
- Press S on Home (or the keyboard button by settings) to see every Home key.
- Ask for more context on a question from the panel, Home, the question dialog, the chat pill or your phone, not only in Catch up. The answer shows on the question wherever you look at it.
- Search finds workspaces typed on the wrong keyboard layout, with a quiet hint and your text kept intact. Desktop uses physical keys; Hebrew and Russian also work on phones and pasted text.
- On Paseo 0.16 and later, Follow-up's settings categories (General, Following, Reviewers, Agents, Inbox & display) are Paseo's own tabs on the Follow-up settings page, and every Settings link opens the right one.
- When the agent says only a person can move something, such as a stale review the reviewer must re-review, Needs you shows it as that PR waiting on its reviewer, with Ask for re-review, instead of "The tasks didn't finish".
- Search from anywhere is now ⌘⇧K (Ctrl+Shift+K): Paseo 0.17 uses ⌘/ for its model picker. If you picked ⌘/, you’re moved to ⌘⇧K; change it in Settings → Display.

### Questions and answers

- A dismissed item comes back by itself when something about it changes, like a new push or a new failure. In Catch up, Shift+D dismisses any card.
- The card for a new agent or workspace stays after it's created and opens it.
- With Claude agents, the Done card and a question's number now show in the chat.
- When the limit runs low, Follow-up pauses its checks and leaves the rest to your agents. The Pull requests card says when it updates again.

### Repairs and PRs

- Repairs reach your main agent as soon as it's free, even while its subagents keep working.
- A waiting repair says what it's waiting for, like the main agent's turn, a permission prompt or Session Guard, and Send now still sends it the moment the main agent is free.
- Follow-up checks your PRs with a small fraction of GitHub's hourly limit, even with lots of PRs: it reads a PR in full only when something on it changed.

### Setup, Settings and updates

- The panel's Project settings button now opens Following.

### More

- Keep is where the keyboard lands, so pressing Enter twice never removes anything, and neither does a double-click on the x.
- Dismissing asks for a second click on the same spot, so a stray click doesn't dismiss anything. The first click turns the x into a small red Dismiss button; clicking elsewhere, Esc, or waiting a few seconds puts the x back.

### Fixes

- Dismiss a question that no longer matters. The agent isn't messaged, and Undo brings it back. In Catch up, Shift+D does it.
- Removing an item from Needs you now shows Remove and Keep side by side, so backing out is one obvious click.
- A removed item now says Removed everywhere you see it, on its card and in question history, matching the toast.
- Needs you no longer shows a repair that stopped mattering: once its PR merges or the problem is gone, it clears on its own.

</details>

## 2.2.0 (2026-11-18)

Catch up walks you through everything that needs you, one card at a time.

- **Start Catch up from Home or ⌘K.** On a phone, swipe left to skip a workspace or right to go back; Skip on the bar skips one card. On desktop, use the keyboard and queue beside the card.
- **Ask for More context** right on a card. Your workspace's agent explains it, and the card comes back with the answer. More context and Later open beside the card, above the bar on a phone.
- **Write your own answer in one step:** pick Something else, type, and send. Use Add note to explain a picked option.
- **See what's new after stable updates.** Turn off Show What's new after updates in Settings → General if you prefer. Home also announces every available stable version when Updates is set to Tell me.
- **Steadier answers:** your field and Send stay above the phone keyboard, and unconfirmed messages keep checking and retrying, including answers an older version gave up on. Plus many smaller fixes.
- Follow-up has a new icon.

<details><summary>Full changelog since 2.1.0</summary>

### Home and Needs you

- Catch up has a key for every move on desktop: A–H pick, W writes your own, ⌘↵ sends, J/K skip and go back, M asks for context, L later, O opens the chat, R the queue. S shows them all; X leaves.
- Catch up: once a question has an answer, Send to agent is on the move bar. More context and Later open right where you are, a sheet above the phone's bar or a popover on desktop, never below the card.
- Agents can ask the card's workspace main agent to explain it in plain words, and read what Catch up will show you next. The answer comes back on its own, with no waiting around.
- Catch up walks everything that needs you one card at a time, from Home's "Catch up · N" or ⌘K. Ask for more context and the deck moves on; that workspace comes back as your next card with the answer. Desktop shows the queue beside the card.
- On a phone the card follows your finger: drag left to skip the whole workspace (shown underneath), right to go back, or let go early and it springs back. Skip on the bar skips one card.
- Skip workspace, at the top right of the card beside the workspace name, skips every card of that workspace at once (Shift+J on desktop).
- More context asks the workspace's main agent, so its answer lands on the card.
- Catch up's Skip says what it skips ("Skip question", "Skip permission") and that the card comes back after the rest.
- On a phone, what you type and its Send button stay on screen. While you write an answer or a note, Sign off and the reply box step aside and the page scrolls the field above the keyboard.

### Questions and answers

- A note on a picked option opens with Add note and says which option it goes with.
- Answers that an older version gave up on go back to checking after the update.

### Repairs and PRs

- A message to a busy agent, or one Paseo kept refusing after a crash, now still reaches the agent: Follow-up checks the agent's chat more thoroughly and sends again when it isn't there.

### Setup, Settings and updates

- Follow-up has a new icon.
- What's new now opens after any update that brings new release notes, not only a major one. Betas still install quietly.
- Don't want it? Turn off Show What's new after updates in Settings → General. Release notes stay one tap away.

### Fixes

- Follow-up now sees a Graphite sign-in made with newer gt versions.
- Home now says when any new stable version is out, including minor and patch releases, if Updates is set to Tell me. Betas stay in Settings → General.
- Writing your own answer to a question is one step everywhere. Pick Something else, type, and send. The box no longer sits there as a note before you pick anything, in the panel, on Home or on a phone.
- An answer Follow-up couldn't confirm no longer ends as Failed and waits for you. It keeps checking the agent's chat and sends it again once the chat shows it never arrived.

</details>

## 2.1.0 (2026-11-17)

Answers reach the agent even when Paseo is busy, search is one key away, and artifact links have their real names.

- **Answers reach the agent on their own.** They wait in a queue and retry until they land, even while Paseo is busy or unreachable, without arriving twice. The card says when the next try is.
- **⌘/ opens Follow-up search from anywhere** (Ctrl+/ on Windows and Linux). Walk Home and the sidebar view with ↑/↓ or j/k, and Enter opens the chat.
- **Find things faster:** search inside a workspace's Pull requests, Tasks and Activity, and the sidebar filter puts name matches first.
- **Artifact links show their real names** instead of "Untitled artifact", or where they came from and when if the name was never seen.
- **New:** Follow-up's own icon, a resizable side pane on Home, the Overseer in the sidebar view, and Report an issue can start in a new workspace.
- **Steadier and lighter:** Follow-up starts on its own after Paseo restarts, keeps one connection to Paseo, gives memory back after a busy stretch, and tells you when it can't save instead of failing silently.

<details><summary>Full changelog since 2.0.1</summary>

### Home and Needs you

- Follow-up has its own icon now, in the sidebar, the workspace header button and the panel tab, instead of the pull request icon. While a workspace needs you, the icon's dot turns amber.
- Walk Home and Follow-up's sidebar view from the keyboard: ↑/↓ or j/k move between workspaces, Home and End jump to the ends, and Enter opens the chat.
- Drag the line between Home's list and the right-hand pane to make the pane wider or narrower. Follow-up keeps the width you pick, and on a keyboard you can move it with the arrow keys.
- Press ⌘/ (Ctrl+/ on Windows and Linux) anywhere in Paseo to open Follow-up Home with the cursor in its search, even while you're typing a message. Pick another key, or none, in Settings under Inbox & display.
- Search inside a workspace's Pull requests, Tasks and Activity: the search icon in each section's header finds a PR by number, title, branch or failing check, a task by its title or evidence, and anything in Activity, including folded items.
- Filtering the sidebar list puts workspaces whose name matches first, then matches in a branch, PR or linked item, then matches elsewhere in the row.
- On a narrow Home list, a row's badges and pull request chip now make room (shortening, then hiding the least important) instead of covering when the row last changed.
- A task scheduled for a time now starts at that time, not up to a minute later.

### Questions and answers

- Sending repairs answers at once, even when Paseo is slow. Follow-up queues the message and sends it as soon as the agent is free; the message line says why it's waiting.
- An answer and the repairs waiting for the same agent now go together as one message, so the agent wakes up once instead of twice.
- Your answers reach the agent on their own. If Paseo is busy or unreachable, Follow-up keeps the answer and retries until it lands, and the card says when it tries next. Once Paseo is back, the answer goes out within about 15 seconds.
- An answer that can't be confirmed after several tries shows Failed with Retry, instead of waiting silently for you to resend it.
- On a phone, Report an issue's Send to list scrolls again, and the new workspace and new agent options come first.

### Repairs and PRs

- Lists inside sheets and popovers scroll on a phone, and the reviewer field in a PR sheet stays above the keyboard.
- Follow-up keeps one connection to Paseo while it runs, instead of reconnecting every minute or two between checks.
- The deploy check reads Cloud Run in Follow-up itself instead of starting gcloud for every fleet read; gcloud now only hands out the access token, once every 45 minutes.

### The Overseer and AI priority

- Overseer forwards and reports handed to an agent are kept and retried until they arrive.

### Summary and Linked items

- Rename title with AI works with linked artifacts and fixes long or quoted suggestions before showing them.

### Providers and helper agents

- Report an issue can start the report in a new workspace, with an agent on the default model.

### Agents and tools

- Rename title with AI works for workspaces beyond the first page, including background workspaces.

### Setup, Settings and updates

- Release tooling waits for delayed registry updates after npm accepts a version, rather than treating the version as failed.
- Retrying an accepted release resumes verification when npm reports that the version was already published.

### Performance

- Follow-up gives memory back after a busy stretch: once agents and the app go quiet, the worker returns to its usual size instead of staying at its peak.
- Follow-up does less work while agents are busy.
- Follow-up sends the app less data when it refreshes your workspaces, so the worker uses less memory.

### More

- Agents can read Follow-up's message queue and retry or cancel a waiting message, like you can.
- Artifact and spec links reuse names from local publish and read receipts across workspaces. Existing unnamed links fill at startup, chosen names stay intact, and unnamed artifacts show their source and date.
- Follow-up reliably frees its previous session when the app restarts, so tracking can resume.
- The action is now called Rename title with AI in menus, ⌘K and the dialog.

### Fixes

- A message to an agent that can't go out (an Overseer forward or a report) now shows in Needs you with Retry and Cancel.
- Fixed: an answer card could reach the agent twice when Paseo was slow to confirm it. Follow-up now checks the agent's chat before sending anything again.
- Follow-up's sidebar view now shows the Overseer, with its state, like Home does. Tap it to open the Overseer's chat, or to start it.
- Saving reviewers, agent settings and the PR workflow no longer stalls on a slow disk, and Needs you no longer waits while the inbox saves.
- A setting that can't be saved now shows an error instead of failing silently; your change is kept and saving keeps retrying.
- A message waiting to go out now says "Next try at 12:04" instead of "retrying at 12:04", so its status line no longer repeats the Retrying label.
- Suggestions stay editable when they need a change, and a busy host no longer refuses a rename click.
- The sort menu now says only when your workspaces were last ranked, without the run's cost or a note about Home.
- If Follow-up can't save your tracked work, it now says so and keeps retrying instead of failing silently.
- Follow-up no longer stays down after Paseo restarts while the previous Follow-up is still stopping. It waits for that one to exit and starts on its own, and says it is waiting meanwhile.

</details>

## 2.0.1 (2026-11-14)

Fixes are easier to follow, merging takes one click, and Follow-up runs much lighter.

- **Tasks:** what Follow-up finds on your PRs (conflicts, review comments, failing checks) is now a task with one clear state, and Tasks shows what goes to the agent next and when.
- **One-click merge,** and a No review setting per repository that lets agents merge their own PRs.
- **Answers:** add a note to your pick on a decision card, or put your answer straight into the agent's message box.
- **New:** Rename with AI, Report a bug from Settings or any error, and a card in the chat for each agent or workspace an agent creates.
- **Lighter:** about half the CPU and much less memory, and on Paseo 0.16 changes show up live instead of by polling.
- Plus many smaller fixes.

<details><summary>Full changelog since 2.0.0</summary>

### Home and Needs you

- Rename with AI: pick it from a workspace's menu (Home, the sidebar view, the panel's new More button) or ⌘K, and Follow-up suggests a short name from the Summary, PRs and linked items. Edit it or accept it; Undo puts the old name back.
- What Follow-up finds on your PRs (conflicts, review feedback, failing checks, restacks) are now ordinary tasks in the workspace's Tasks, each with its PR and one plain state: Queued, Sent, Needs you or Done.
- Needs you, Home and the chat pill say "tasks" everywhere, and the Send in Needs you names the agent and doesn't repeat the task list.
- Home remembers which groups you folded. Needs you always opens, so nothing waiting on you hides behind a fold.
- A pull request without reviewers asks once in Needs you, naming the suggested reviewer ("Add reviewers to … : Ravi"), instead of a second reviewers card beside it.
- Home's "Follow-up is fixing" is now "Sending": messages on their way to an agent, with when and why each goes out, and Send now where it would go through. A send that waits on you stays in Needs you.
- Every Needs you row about a PR opens it in one click: an Open #N link beside its action, and each #N it names is a link.
- Agents get each inbox row's PR links from inbox_list.
- A copied answer, or one put in the chat, stays in Needs you as "Your Q1 answer isn't sent yet" until it reaches the agent. Sending it from the chat, Send on that row (one click) or Sign off clears it. Before, Copy cleared it at once.
- On Paseo 0.16, the recovery agent runs in the background: no tab, no notification and no sidebar row. Its progress shows in the workspace panel.
- The "has no reviewers" row has a "Let the agent merge in" link that switches its repository to No review, with Undo.
- Switching a repository to No review clears its "Add reviewers" asks everywhere at once (Needs you, the header, the pill and Home); Undo brings them back.
- Search results look like the rows of your list, with the words you typed highlighted where they appear. A match in a branch, PR or linked issue shows on the second line.
- The Follow-up sidebar view has a filter and Home's sort. The sort is one setting for Home and the sidebar, the same on every device, and agents can change it when you ask.
- A task names the agent working on it and whether it is working, idle or closed, instead of a stale "Agent working", with Open agent. The status line and Home spin only while that agent really runs.
- An answer you copied or put in the agent's message box now reads "not sent yet" on the chat's card, in the question and in Activity, like Needs you, instead of "Answered" with a check. It reads Answered once it reaches the agent.
- In menus on a phone, the check beside the chosen sort and the action icons now sit centred beside their item, sized to match the text.
- An open question shows once in the panel and on Home, under one name: the agent's ask and its question are one card in Needs you, with other questions as headers below. Blocked tasks say what they wait on.
- Right-click a workspace in the sidebar view to open its menu.
- A task an agent marks blocked only asks you something when it is blocked on you, with a real question. Tasks waiting on a pull request or another agent show as Blocked in Tasks instead of in Needs you.
- On Paseo 0.16, Home, the sidebar and the pills update the moment something changes, on every device, instead of checking every 15 to 60 seconds. An open Follow-up now sends almost nothing while you aren't using it.
- Follow-up's worker makes less short-lived garbage under load: the workspace list re-serializes only the workspaces that changed, and the Needs-you inbox is saved at most once every 2 seconds.
- Needs you, the usage meters and a workspace's Summary answer at once instead of waiting on Paseo; what's new arrives on the next refresh.

### Questions and answers

- Decision cards: "Add note" under the options lets you send a pick with a note ("A, but keep the BOM off"). One tap still sends; with a note typed, each option reads "Send A with note".
- A note sent with a picked option on a decision card (by an agent's brief_action today) now reaches the agent and shows on the chat's answer card. Before, only Something else kept its words.
- You're asked only when the same problem was sent twice with no change, and the card says which one.
- When an agent creates another agent or a workspace, the chat shows a card for it: its name, model, live status and what Follow-up knows (an open question, PR state). Tap it to open the agent or workspace.
- Paseo 0.16: **Put in chat** on a question adds your answer to the end of the agent's message box to edit before sending. It never replaces a draft; if the chat can't open, the answer is copied. Copy becomes an icon (0.15 keeps its label).
- Follow-up stays quick on workspaces with hundreds of PRs or questions.
- A multi-decision card is titled with the agent's ask, not Q1.

### Repairs and PRs

- After a reload mid-send, Follow-up checks the agent's chat and sends the message again only if it never arrived.
- The top of Tasks says who the next message goes to, when it goes and why it waits, with Preview and Send now. You can keep any single task for yourself by turning its Auto-send off.
- A task that went out twice with no change on GitHub, even if the agent said it was done, asks you on its own, and everything else keeps going. This replaces the old rule that stopped a PR's messages after three tries.
- When the machine is short on memory, one line at the top of Sending says auto-sends are paused and why.
- What Follow-up sends the agent is called tasks everywhere, never repairs.
- The deploy check is now a per-repository setting on your machine, set by an agent. Settings → Following → PR workflow shows it for each repository, or Not set up.
- One click on Merge merges: no second "Merge this PR?". The button names everything it merges first ("Merge 3 PRs"), and a blocker found at click time merges nothing and says why.
- You can set a repository to No review in Settings → Shipping PRs. There, Follow-up never asks you to add reviewers or merge, and agents merge their own PRs once checks pass. Team review stays the default.
- Report a bug, an idea or feedback from Settings → General, Command-K or any error message. Your agent writes it up with versions and recent errors, removes private names, and shows you the issue before it goes to GitHub.
- When GitHub's API limit for your account runs out, pull requests keep their last known status instead of turning Unknown, and Follow-up waits for the limit to reset before asking again.
- An Add reviewers row says only what is new: "Suggested: Ravi" under its title, not the ask again. No headline repeats its label or the PR number its chip already shows.
- A merged PR reads by its title, not "#240 merged" beside its chip.
- Follow-up uses far less of your GitHub API limit: an agent finishing a turn rechecks only its own workspace's pull requests, and agents finishing together share one check.
- Follow-up's worker does less work when an agent's turn ends: it checks only that workspace, and a PR the agent just opened still shows right away.

### Providers and helper agents

- After a failed recovery, the Recovery block offers one action, Retry recovery, instead of both Run recovery and Retry recovery.

### Setup, Settings and updates

- On the phone, Follow-up now keeps your settings category and folded sections after you reopen the app.

### Performance

- Follow-up uses about half the CPU it did, reads about 50 times less from disk and opens one daemon connection at a time instead of one per workspace.
- Follow-up writes its state files only when something really changed, about 8 times less often.

### More

- An agent whose session Paseo closed (after an hour idle or a plugin reload) keeps its link as "Open chat" on task rows and cards. Only archived agents show words alone.
- No repository tracks by default from Follow-up itself anymore: with Follow every workspace off, only the projects you switch on are followed.
- Ask any agent to "report a bug about Follow-up" and it files a detailed issue only after you say yes. Screenshots are uploaded only if you agree for that report.
- Follow-up keeps one connection to Paseo instead of opening a new one for each read, and asks for usage meters only when Smart Session is installed.
- Follow-up reads each agent turn once, picking up where its last read stopped, instead of re-reading the newest part of the chat at the start of the turn, at its end and again for discovery.

### Fixes

- Fixes no longer ask you to Retry when the agent's turn ends without reporting back. Follow-up checks GitHub instead: what's cleared is done, and what's still open goes in the next message.
- Sending is lighter: each send writes only its own workspace and reuses the agent list, so a few sends no longer leave the worker ~110 MB larger, and it stays quiet afterwards (it used to keep making ~16 Paseo requests a minute).
- The line under queued fixes now says exactly why they haven't gone out, such as a PR Follow-up couldn't read or a send that was refused, and only says "sending now" when one is really going out.
- Fixes that keep changing no longer push their send back: they go out a minute after the first one was queued.
- A task whose agent Paseo no longer knows reads "Agent unavailable" instead of "In progress", and archived agents keep reading "archived" after Follow-up re-reads Paseo's list.
- A "No ask stated" card no longer sits above a Needs-you item that says what to do.
- A PR the agent merges itself no longer reads "No reviewers" in the Pull requests card or the PR sheet.
- Follow-up pauses only when you stop the main agent. A turn replaced by a new message, a compaction or a session reload no longer leaves it paused, and any pause lifts once the agent runs again.
- Follow-up reads GitHub inside its own process, so starting up or finishing a deploy no longer launches dozens of `gh` processes.
- A "Nothing needed" turn end no longer shows in Needs you or counts there when the workspace is flagged for something else, like a merged PR. The pill and rows read that reason instead.
- Follow-up uses much less memory while your agents are busy, and no longer reconnects to Paseo every few seconds.
- Needs you: a merged PR reads "Merged", not "PR closed", which now means closed without merging. A PR the agent merged itself no longer flags you; a Later "until this PR merges" still wakes.
- An agent that says nothing is needed no longer stays in Needs you with an older "No ask stated" card.
- A PR that merged long ago no longer shows up in Needs you again as "Merged" in workspaces with many PRs.
- The popup no longer repeats its ask or to-do count.
- A row never says "No ask stated" above work to do.
- Merged pull requests no longer show Unknown after GitHub was briefly unreachable or out of API budget. Every pull request keeps its last known status, and its details say when it was last checked.
- Tracking a workspace right after creating its agent no longer fails with "This workspace has no available main agent".
- Follow-up uses much less memory and CPU with many workspaces, and no longer spikes when it starts.
- Signing off, Later and Undo no longer wait for Paseo to clear the unread dot.

</details>

## 2.0.0 (2026-11-11)

Follow-up keeps track of every workspace your coding agents work in, until the work is merged and done. It shows you in one place which agents are waiting on you and why, sends failed checks and review comments back to the right agent by itself, and lets you answer an agent's question without opening its chat.

![Follow-up Home: every workspace in one list, grouped by what it needs from you, with the selected workspace's question on the right](https://raw.githubusercontent.com/tomgrin10/paseo-follow-up/175c85a5bf012c6727fef9d5565fa375bef60ccd/docs/screenshots/follow-up-notes-home.png#1120x680)

### One list of what needs you

Home lists every workspace, grouped by what it needs from you. When an agent finishes, asks something, hits an error or waits for a permission, it moves to the top, under Needs you, and stays there until you mark it done or reply. You act on it right there, without switching to its chat.

### A panel on every workspace

The Follow-up tab beside a workspace's chat shows how far its PRs are, what needs you and what's left to fix, with a bar for the PR stack, what the agent is doing now and the question it's waiting on.

![The Follow-up panel on a workspace: 1 of 3 PRs merged, 3 need you, 1 to fix, a stack bar, Auto-send, and the agent's question with three lettered options, one recommended](https://raw.githubusercontent.com/tomgrin10/paseo-follow-up/175c85a5bf012c6727fef9d5565fa375bef60ccd/docs/screenshots/follow-up-notes-panel.png#320x910)

### Answer questions from anywhere

When an agent needs a decision, it asks in a card with lettered options, its recommendation and room for your own answer. Answer it on Home, in the panel, in the bar above the agent's message box, or on your phone. The answer goes straight into the agent's chat.

### Fixes go back to the agent

When a PR's checks fail, it hits a merge conflict or a reviewer leaves comments, Follow-up sends them to the agent that made the PR, in one message once it's idle. You're only asked for what's yours to decide, like merging. Works with plain GitHub; Graphite is optional.

### Context at a glance

Each workspace gets a one-line description of what it's for, and a list of the Linear issues, Slack threads and docs it's about. Ask about any workspace from Home's search box, and an agent that knows all of them passes your question to the one doing the work.

### Fits your setup

- Its small background jobs, like writing those descriptions, run on any model provider Paseo has.
- Agents can do anything you can click in Follow-up, after showing you a plan.
- It updates itself when nothing is busy, and rolls back if an update fails.

---

Follow-up borrows ideas from [Progress](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) by Steve Castaneda and [Better Paseo](https://github.com/RoundRedDot/better-paseo) by RoundRedDot. Thank you to both.

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
- Follow-up's version shows at the top of Home and the panel. Tap it for update status and the release notes.

### Questions and answers

- When an agent needs you, a card at the end of its chat says the ask in one line, with decisions as buttons and only the context you need.
- Every question with options ends with Something else, for your own answer. Questions with several decisions let you pick every answer, then send them in one message.
- Your answer is recorded at once. The card shows Sending until the agent has it, offers Send again if it couldn't be delivered, and never sends it twice.
- Press Cmd+Enter (Ctrl+Enter) to send an answer or save a dialog, even while typing a note.
- Links in questions, cards, tasks and agent replies are clickable, including PR references like owner/repo#123.
- An answered question stays on its card, folded to what was asked and what you picked, and a card answered somewhere else or replaced by a newer one says so.
- Question and option text is shown whole; long context opens in full with Show more.

### Repairs and PRs

- Follow every workspace and Send repairs automatically are on by default, also after upgrading from 1.x. On a fresh install, auto-send waits until you finish or skip setup. Turn Follow every workspace off in Settings → Following.
- Works with plain GitHub; Graphite is optional, chosen per repository. Settings → Following → Shipping PRs sets how each repository ships PRs.
- On plain GitHub, the PR sheet follows GitHub's own review and check verdict.
- Reviewers per repository, plus a default list, for Add reviewers.
- A deploy Follow-up has seen stays counted until a rollback, and Done goes through with a note when Follow-up can't check what production serves.
- Saving a spec link, a task's schedule or a reviewer pick closes at once and confirms with a short message.
- An agent can mark a PR it merges itself, so Follow-up stops asking you to review or merge it. Work the agent is waiting on reads as Waiting, with what it waits on.
- Follow-up checks GitHub with far fewer requests and no helper processes, and checks a workspace's PRs as soon as you open it.

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
- Installed from Paseo's plugin list? Follow-up moves to its new plugin id by itself there too, keeping your workspaces and settings.
- What's new shows screenshots of what it describes.
- Release notes and What's new open wider on large screens, so their screenshots are easier to read.
- The release notes always show their scrollbar when there is more to read, and their titles name Follow-up.

### Phone and performance

- Reworked for phones: Home, the cards, the composer pill and Settings fit a phone screen, with real tap targets.
- Far less load on Paseo: one shared list of agents and workspaces instead of asking for them every few seconds, and no polling while the app is hidden.
- On Paseo 0.15 and later, agents get Follow-up's tools through Paseo itself, so no extra process starts per agent. The old per-session registration is removed, with a backup of each file it touched.
- After an update, agents in the middle of a turn keep using Follow-up's tools instead of hitting "tool not found".

### Fixes

- Home, the panel and the header agree on what Follow-up is doing, and "Follow-up is fixing" shows only while repairs are really with the agent.
- A question an agent asks again no longer shows up twice.
- A workspace whose agent is still working no longer shows in Needs you.
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
- A workspace no longer shows Needs you for "Add reviewers" in a repository nobody is set up to review, and the flag goes away on its own once the PR merges or gets reviewers.
- A failed update no longer shows as failed once a newer version of Follow-up is running.

### More

- Tapping a screenshot in the notes shows it larger inside Paseo instead of opening a browser tab.

</details>
