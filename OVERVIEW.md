# Follow-up

Follow-up watches every pull request a Paseo workspace opens until the work is actually done. It shows each PR stack at a glance, gathers conflicts, failing required checks and review threads into one repair batch for the workspace's main agent, and tells you when something needs you, such as an approved PR to merge, a question the agent asked or a batch to send. Answer a question in Follow-up and the answer goes straight to the agent's chat.

## What you see

- A workspace panel that leads with status: PRs merged, what needs you, what needs fixing, a bar with one segment per PR, and what the agent is doing now.
- A Needs you card with one button per decision: Send repairs, Merge, Resume, Retry, or Answer.
- Questions from the main agent, each with a permanent ref (Q1, Q2…), lettered options, the agent's recommendation and what it does while it waits. Pick an option, add a note and Send it to the agent, or Copy it instead. Answered questions stay listed under their ref, and the question mode setting (Stop, Work around, Keep building) tells agents what to do until you answer.
- A Spec link in the header to the page that sums up the workspace, usually the Claude artifact the main agent keeps up to date.
- An Activity card: repairs sent and finished with how long they took, merges, PR actions and questions.
- Each stack drawn top to base like Graphite, merged PRs folded away, and a sheet per PR with checks, reviewers and Merge.
- Tasks for work that outlives a merge, manual or scheduled after a merge or deploy, with an optional delay.
- A composer pill and a sidebar count that appear only when something needs you; the pill steps through open questions so you can answer without leaving the chat. One screen lists every tracked workspace by who is up next, and a larger view opens a workspace in two columns.
- Compact rows for Follow-up's own tool calls in agent chats, a card for each repair batch, and a card when the agent declares Done.

## Setup

Requires Paseo 0.14+, Node 22+ and an authenticated `gh` on the daemon host. Merge uses saved Graphite CLI authentication. Open a workspace, open Follow-up from its header or Command-K, and choose Track this workspace. Project settings can track every workspace in a project. The optional Send to Paseo browser companion adds Graphite's Merge when ready switch through its existing pairing; it is not needed for anything else.

## What it does on its own, and what it never does

Auto-send starts off for every workspace. Until you turn it on, each repair batch waits for your click; with it on, Follow-up sends batches once the main agent is idle, after fresh permission and Session Guard checks. Follow-up never merges, turns on merge when ready, requests reviewers or archives on its own, and Merge always re-checks the stack and asks again. Done needs the main agent's declaration, settled PRs and tasks, and no open questions. Answers are sent only when you click Send; an answer the agent can't take yet waits and goes out on the next check, and one Paseo didn't confirm waits for you to Resend. An optional recovery agent can rebuild missed PRs and tasks from a workspace's history; it runs only when you start it and never edits code. Deployment checks and reviewer shortcuts exist only for specifically configured repositories; elsewhere deployment stays unknown.

## Data and access

This is a trusted, unsandboxed plugin. It reads workspace metadata, saved agent history and configuration, GitHub status and existing CLI authentication, and keeps its state in `plugin-data/follow-through` on the daemon host. It registers scoped MCP tools and reversible provider hooks only for tracked sessions. To find the spec link it reads completed Claude Artifact publish results in the workspace's root sessions, never page content, chat links or the repository; a link you set wins over the agent's, which wins over detection. Repair prompts go to your configured agent and provider. It has no Slack identity and no background channel scanning; replies to stakeholders need your authorization and a sent-message receipt from the agent.
