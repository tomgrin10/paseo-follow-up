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

1. **Header.** Workspace title and the settings gear (compact layouts drop the title, which the host header already shows, and lead with the goal). The goal in two muted lines. A status sentence with coloured counts ("1 of 5 PRs merged · 3 need you · 2 to fix"). The stack bar: one segment per PR in merge order; merged segments are solid purple, every other PR is a neutral track with a short centred dash in its status colour, so the filled length is real progress. Segments open their PR. A live line with a spinner, clock, pause or check saying what is happening now and since when. A strip with "Checked 1m ago", a refresh icon and the **Auto-send** switch, always visible and off by default.
2. **Shipped card** when the main agent has declared Done and every requirement has settled: a green check, the agent's summary, PR count and time, and a reminder that archiving is the developer's action. The stack and tasks fold into one History row beneath it.
3. **Needs you card** (amber border, count chip). One row per decision with exactly one action: Resume follow-up, Retry (plus Open agent), Check state, Answer in chat, Send to main agent (with the batch's tasks listed and the reason when Send is unavailable), Merge (only when the PR is approved, checks pass and Graphite reports it ready), Add reviewers (only where reviewer defaults are configured). Send is the only primary button.
4. **Agent card** while a batch is with the agent, or queued under Auto-send: what was sent and when, and Open.
5. **Pull requests card.** Active stacks first, problems first within them. Each stack is a rail: a 2px line through 16px nodes, top of stack first and its base last, like Graphite. Merged PRs fold into a "N merged below" node; fully settled stacks fold into one row at the end. A row shows the title (two lines) and `#n · status` with extras such as No reviewers or Merge when ready. Approved stays green and merged/deployed purple, and Merged is shown until deployment is confirmed.
6. **Tasks card.** Outstanding tasks with a status glyph, title and either "Manual · waits for #412" or a schedule chip ("2d after deploy · #418"); finished tasks fold into "N done". Approve/merge/deploy checklist items never appear here.
7. **Agent, recovery and Graphite** disclosure, collapsed by default: open the main agent, run or retry optional recovery (separate agent, never edits code, not tied to Auto), the optional Merge-when-ready connection guidance, and a link to all tracked workspaces.

Fold choices persist per tab through `useTabState`. Data stays on screen during refreshes; a failed refresh adds a warning line under the header instead of replacing the panel.

### Sheets

A PR row (or a stack-bar segment) opens a Paseo `Modal`: a dialog on desktop, a bottom sheet on phones. It shows the full title, status chip, repository, stack position, parent, required and optional failed checks separately, unresolved threads, reviewers, deployment evidence and when it was last checked, then the controls, then Open in Graphite and GitHub.

Merge always prepares a fresh plan and shows it as a section of the sheet: the affected PRs bottom to top, each blocker, then Merge / Merge all N, and Cancel. An upper PR's Merge-when-ready change offers the listed downstack or Just this PR; a single-PR toggle applies after fresh checks. Loading, Queued to merge, Submitted and actionable errors describe the observed stage without claiming a merge happened. Uncertain actions block further actions on that PR until Check state resolves them. Without the browser companion the When ready switch is hidden and Merge still works through the Graphite CLI. When Merge isn't available the sheet says what it is waiting for, and Graphite blockers name the cause and the fix.

A task row opens a task sheet with its evidence, due date and the schedule editor: Manual, Now, After merge, After deploy; merge and deploy add a delay in days and the PRs to wait for, and Save is disabled until the selection is valid. Scheduling never changes Auto-send.

## Pill, header button and sidebar

The composer pill appears on a tracked workspace's main agent only while something needs the developer, labelled with the single action ("Merge #418", "Send 3 repairs") or a count ("3 need you"), with a red octagon when something is blocked. Its popover holds the same Needs you rows and an Open Follow-up button. The header button is an icon with a small amber dot when that workspace needs you. The sidebar row opens the tracked-workspaces screen and shows a count badge. Display settings can hide each of the three.

## Tracked workspaces screen

A title with refresh and settings, a filter row of status chips with counts, then raised groups: Needs you, Agent working, Waiting, In progress, Done · ready to archive. Each row: status glyph, name, relative time, the first thing that needs you (or what is happening), the stack bar at 4px and a meta line that omits zero counts. Rows open the workspace.

## Chat

Follow-up's MCP tool calls, and its CLI fallback in a shell call, render as one-line rows sized like Paseo's tool rows that expand to the full result. Repair batches render as a card listing the tasks with the full message behind a toggle. A successful Done call renders a green Workspace done card.

## Settings

Project tracking uses Paseo's settings kit: one switch per project, with its remote or path as the hint and the explanation in the section's info tip. Display settings hold the sidebar row, header button and composer pill switches.

## Empty, loading and error

An untracked workspace teaches with the panel's own rail: three nodes for what Follow-up does, the safety promise, one primary Track button and a pointer to project settings. Loading shows a skeleton of the header and two cards. A failed first load shows a card with the error and Try again.

## CI labels

Required CI failures display Checks failed. Failures outside the effective branch requirements display Optional check failed (or Optional checks failed), including in rows, and the PR sheet names required and optional failures separately. Stacked PRs inherit trunk check requirements when GitHub confirms their base branch is an open PR's head; other failed checks affect the warning and ordering, while automatic repair and merge gating use requirements only.
