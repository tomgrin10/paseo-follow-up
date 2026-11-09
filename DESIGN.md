# Paseo native surface

Follow-up extends Paseo's existing interface. It inherits the host theme, system type, controls, icon names and platform layout, and adds one signature: a status-first header whose stack bar and stack rails share a single state colour language. Visitor mode: Operate.

## Tokens

Use only `theme.colors.surface0`, `surface1`, `surface2`, `border`, `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning` and `statusDanger`, through `client/theme.ts`:

- `raised(colors)`: cards get a hairline ring plus a soft lift in light themes and a single 8% white ring in dark themes. Dividers and attention borders stay real borders.
- `tint(color)`: tag and node fills are their own hue at 12% (light) or 16% (dark).
- `mergedColor(colors)`: Paseo's purple merged token, which the plugin SDK omits; the fallback matches the host (`#7347af` light, `#a890d5` dark).

Colour carries meaning and nothing else. Purple is merged. Green is approved, done or shipped. Red is a repair the agent must make (conflicts, failed required checks). Amber is review feedback, optional-check failures and anything that needs the developer. Muted is pending, draft or unknown. Accent is reserved for primary actions and switches, never for a state.

Type is the system sans: 15/21 semibold panel titles, 13/18 body, 12/17 supporting text, 11/15 small labels, tabular numerals for every count and time. Controls are 32px on desktop with a hit slop and 44px in compact layouts. Panel padding is 12px, 16px in compact layouts. Motion is 140–300ms ease-out, opacity and transform only, and every animation checks reduced motion: press scale, icon cross-fades when a state changes, and one rise-in for the Shipped card.

## Workspace panel

Top to bottom, every block optional except the header:

1. **Header.** Workspace title, a quiet **Spec** link chip when the workspace has a spec link, the expand icon (desktop only, while the panel is narrow) and the settings gear (compact layouts drop the title, which the host header already shows, and lead with the goal). The goal in two muted lines. A status sentence with coloured counts ("1 of 5 PRs merged · 3 need you · 2 to fix"). The stack bar: one segment per PR in merge order; merged segments are solid purple, every other PR is a neutral track with a short centred dash in its status colour, so the filled length is real progress. Segments open their PR. A live line with a spinner, clock, pause or check saying what is happening now and since when. A strip with "Checked 1m ago", a refresh icon and the **Auto-send** switch, always visible and off by default. When open PRs haven't been checked for ten minutes the strip turns amber and adds "may be out of date".
2. **Shipped card** when the main agent has declared Done and every requirement has settled: a green check, the agent's summary, PR count and time, and a reminder that archiving is the developer's action. The stack and tasks fold into one History row beneath it.
3. **Needs you card** (amber border, count chip). One row per decision with exactly one action, and a question that stopped the agent above everything else: Resume follow-up, Retry (plus Open agent), Check state, Check (an answer Paseo didn't confirm), Answer (an open question: "Q3 · title", two lines of the question and what the agent does meanwhile; questions that stopped the agent come first), Answer in chat (a blocked task the server hasn't turned into a question yet), Send to main agent (with the batch's tasks listed and the reason when Send is unavailable), Merge (only when the PR is approved, checks pass and Graphite reports it ready), Add reviewers (only where reviewer defaults are configured). Send is the only primary button.
4. **Agent card** while a batch is with the agent, or queued under Auto-send: what was sent and when, and Open.
5. **Pull requests card.** Active stacks first, problems first within them. Each stack is a rail: a 2px line through 16px nodes, top of stack first and its base last, like Graphite. Merged PRs fold into a "N merged below" node; fully settled stacks fold into one row at the end. A row shows the title (two lines) and `#n · status` with extras such as No reviewers or Merge when ready (Auto-merge for repositories that ship with plain GitHub). Approved stays green and merged/deployed purple, and Merged is shown until deployment is confirmed.
6. **Tasks card.** Outstanding tasks with a status glyph, title and either "Manual · waits for #412" or a schedule chip ("2d after deploy · #418"); finished tasks fold into "N done". Approve/merge/deploy checklist items never appear here. A blocked task that became a question reads "Q1 · waiting on your answer" in muted text and opens that question, so a decision asks for attention once, in Needs you.
7. **Activity card.** Two tabs: Timeline, drawn on the stack rail (2px line, 16px tinted nodes), with repairs sent and finished and how long they took, merges, PR actions, questions asked, answered and withdrawn, and Done, newest first, five shown with a "Show all N" fold; and Questions, every question under its ref (open in amber, answered with the choice, withdrawn with the reason; a row opens the question). Questions always read "Q3 · title" with what happened as supporting text.
8. **Spec, agent and recovery** disclosure, collapsed by default: the spec link row (name, where it came from, Open and Edit or Add link), open the main agent, run or retry optional recovery (separate agent, never edits code, not tied to Auto), the optional Merge-when-ready connection guidance, and a link to all tracked workspaces.

From 820px of content width (a wide panel, or the larger view) the panel splits into two columns: Shipped, Needs you, the agent and tasks on the left; pull requests, activity and the disclosure on the right, with PR rows gaining a right-aligned status column. The larger view is a Paseo screen opened from the expand icon or Command-K, centred at 1240px; its header leads with the goal because the screen bar already names the workspace. Esc or the collapse icon returns to the workspace.

Fold choices persist per tab through `useTabState`. Data stays on screen during refreshes; a failed refresh adds a warning line under the header instead of replacing the panel.

### Sheets

A PR row (or a stack-bar segment) opens a Paseo `Modal`: a dialog on desktop, a bottom sheet on phones. It shows the full title, status chip, repository, stack position, parent, required and optional failed checks separately, unresolved threads, reviewers, deployment evidence and when it was last checked, then the controls, then Open in Graphite and GitHub. In a repository that ships with plain GitHub the footer has one bordered Open on GitHub button and nothing that names Graphite.

Merge always prepares a fresh plan and shows it as a section of the sheet: the affected PRs bottom to top, each blocker, then Merge / Merge all N, and Cancel. An upper PR's Merge-when-ready change offers the listed downstack or Just this PR; a single-PR toggle applies after fresh checks. Loading, Queued to merge, Submitted and actionable errors describe the observed stage without claiming a merge happened. Uncertain actions block further actions on that PR until Check state resolves them. Without the browser companion the When ready switch is hidden and Merge still works through the Graphite CLI. When Merge isn't available the sheet says what it is waiting for, and Graphite blockers name the cause and the fix.

GitHub mode (a repository set or auto-detected to ship with plain GitHub): Merge appears only when GitHub's own verdict has no blockers (draft, review, conflicts, required checks, merge state, threads), the same rule Needs you uses. Blockers are noun phrases that read after "Merge opens when it clears:" ("behind its base branch (update the branch)", "2 unresolved review threads", "a branch protection rule or ruleset"). The When ready switch becomes Auto-merge, read from GitHub with the PR so it needs no browser companion; it shows only while Merge is waiting, or while auto-merge is on so it can be turned off. A repository that disallows auto-merge shows "Auto-merge is off for this repository. Turn on Allow auto-merge in its GitHub settings." instead of the switch. The confirmation names the merge method ("GitHub will squash and merge it once this repository's required protections pass.") or the merge queue, whose button reads "Add #n to merge queue"; with a queue only the bottom PR of a stack goes in. The panel's Merge when ready connection row appears only when an open PR is in a Graphite repository.

A question opens the question dialog: the question, a line with what the agent does meanwhile (stopped and waiting in amber; holding what it affects; building its recommendation; a big question's reason), then the context so it is read before choosing (background, links: web links open in the browser, file paths are selectable text; the PR or task it is about), then the lettered options as radio cards with a neutral Recommended chip (the selected card takes the accent border), a note field (or an answer field when the question has no options), then **Send to agent** (primary) and **Copy**. Once answered it shows the choice and the delivery state on a green tint: sent with the time, queued with the reason and Try now, unconfirmed in amber with Resend and Open agent, copied with Send to agent. Withdrawn questions show the reason.

The spec sheet edits the link and an optional name; Save, Remove link, and Let the agent set it when the developer owns the link. Other artifacts published in the workspace are listed below with Open and Use.

A task row opens a task sheet with its evidence, due date and the schedule editor: Manual, Now, After merge, After deploy; merge and deploy add a delay in days and the PRs to wait for, and Save is disabled until the selection is valid. Scheduling never changes Auto-send.

## Pill, header button and sidebar

The composer pill appears on a tracked workspace's main agent only while something needs the developer, labelled with the single action ("Merge #418", "Send 3 repairs", "Question Q3") or a count ("3 need you", "2 questions"). The icon is a red octagon when something is blocked, an amber pause when a question stopped the agent, and an amber question bubble when only questions are waiting. While questions are open the popover is about them: "Q1 · title" with "1 of N" and arrows, the question, its background clipped to three lines and the options in a scrolling body, then Send to agent, Copy and Details (the full dialog) pinned below it so Send is never cut off, one muted line naming anything else that needs you, and Open Follow-up with the Spec chip. Otherwise the popover holds the Needs you rows. On phones the host sheet's title replaces the popover's own header. The header button is an icon with a small amber dot when that workspace needs you. The sidebar row opens the tracked-workspaces screen and shows a count badge. Display settings can hide each of the three.

## Tracked workspaces screen

A title with refresh and settings, a filter row of status chips with counts, then raised groups: Needs you, Agent working, Waiting, In progress, Done · ready to archive. Within Needs you, workspaces whose agent stopped for a question come first and their line starts "Agent stopped". Each row: status glyph, name, the Spec chip when there is a link, relative time, the first thing that needs you (or what is happening), the stack bar at 4px and a meta line that omits zero counts. Rows open the workspace.

## Chat

Follow-up's MCP tool calls, and its CLI fallback in a shell call, render as one-line rows sized like Paseo's tool rows that expand to the full result. Repair batches render as a card listing the tasks with the full message behind a toggle. A successful Done call renders a green Workspace done card. Question and spec tool calls read "Q3 · title · asked" (amber), "Q3 · answer recorded: B", "Q3 · withdrawn: reason" and "Spec link: name". An answer sent from Follow-up renders as a "Your answer to Q2 · title" card with the choice and the note.

## Settings

Project tracking uses Paseo's settings kit: one switch per project, with its remote or path as the hint and the explanation in the section's info tip. Display settings hold the sidebar row, header button and composer pill switches. A Questions section above the projects holds the question mode select (Stop, Work around, Keep building) with the chosen mode's rule as its hint.

## Empty, loading and error

An untracked workspace teaches with the panel's own rail: three nodes for what Follow-up does, the safety promise, one primary Track button and a pointer to project settings. Loading shows a skeleton of the header and two cards. A failed first load shows a card with the error and Try again.

## CI labels

Required CI failures display Checks failed. Failures outside the effective branch requirements display Optional check failed (or Optional checks failed), including in rows, and the PR sheet names required and optional failures separately. Stacked PRs inherit trunk check requirements when GitHub confirms their base branch is an open PR's head; other failed checks affect the warning and ordering, while automatic repair and merge gating use requirements only.
