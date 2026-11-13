# Follow-up

<!-- impeccable:product-schema 1 -->

## Platform
adaptive

## Users
Developers managing many long-lived Paseo workspaces, primarily with one main agent that survives compaction. A workspace may produce multiple PR stacks over time and may start from an idea without a Linear issue.

## Product Purpose
Reduce manual workspace checking. Retain PR history, show what remains, collect repair batches for the developer to send to the existing main agent, and explain when a workspace is ready to archive.

## Operating Context
Smart Session handles compaction, Session Guard handles usage pauses, and the developer merges and archives. Agents declare completion after checking recorded obligations such as deployment verification and migrations. A developer click sends each batch, or the developer enables Auto for that workspace; the agent may then fix and push.

Tracked root sessions maintain PR metadata during normal work. Contributor roots receive only PR registration, status and sync; the designated main agent retains goal, task, scope and completion authority. Scoped Claude/Codex hooks supply instructions on session start and normal prompts, including compaction recovery; a missed end-of-turn sync permits one bookkeeping continuation. This does not wake idle agents, launch recovery or change Auto. Codex hook trust remains a separate provider requirement.

## Capabilities and Constraints
Paseo native Explorer panel and workspace tab; global overview; persistent host-side records and polling with the app closed; agent MCP tools; individual or project-default tracking with original main-agent ownership. Done is an agent declaration gated by settled PRs and completed obligations. Archiving remains manual. The plugin supports GitHub, historical PR reference recovery, automatic discovery from successful session submission receipts across git worktrees, and explicit stack membership.

Canonical remote Git projects whose repository basename is `acme-poc` track by default, including organization and fork projects. Other projects start off. Native Settings → Plugins → Actions for follow-up → Follow-up and **Follow-up: project settings** provide per-project switches, persisted by stable project ID. On enrolls existing and future unarchived workspaces with a valid original main agent; Off stops further enrollment while preserving tracked records and settings. New enrollments have Auto off and do not send messages or create a recovery agent automatically. Existing tracked Auto choices remain unchanged.

Existing-workspace inventory is an optional user action under the panel's Agent, recovery and Graphite disclosure, repeatable after completion. It runs in a separate recovery agent. Its result and conversation remain accessible there; the original main agent retains ownership of repairs and Done. Recovery and repair prompts stay specific to their respective tasks. Manually registered PR repairs, dependency checks and Done never require inventory acknowledgment. Auto does not schedule recovery. Optional recovery activity, failures and permissions do not hold main-agent work.

Developer-corrected scope is retained through `exclude_stack`: unrelated stacks, their PRs, and associated obligations move into a durable audit with the reason and exclusion time. Excluded PRs and stack names are blocked from registration, so later recovery cannot silently restore them to owned work.

Pull requests keeps active stacks visible, folds merged PRs under each stack, and retains fully settled stacks behind one collapsed row with their counts. Expanding it reveals the historical stacks and their PRs. Once a workspace has shipped, stacks and tasks fold into a single History row under the Shipped card.

Each repository ships PRs through plain GitHub or Graphite (setting `prWorkflow`: auto, graphite or github; auto picks Graphite only where `gt` is installed, signed in and the repository is gt-initialised). Plain GitHub is a full mode: readiness from GitHub's merge state, checks, reviews, threads, protections and merge queue; Merge through `gh pr merge` with an allowed method; When ready as GitHub auto-merge; stacks from base-branch chains, retargeted after a parent merges. Nothing in GitHub mode mentions Graphite. In Graphite repositories, open PRs have human-operated Graphite **Merge** and **Merge when ready** controls in Follow-up. Merge is one click: its label names the whole scope first (an upper PR names its owned unmerged downstack in order), and the click merges exactly that at the heads shown, or merges nothing and says why. MWR changes on an upper PR offer this PR or the listed downstack. A single-PR toggle applies after fresh checks. Changed revisions or membership invalidate confirmation; an uncertain result must be checked before another conflicting action. Reviewer requests on different PRs are independent; duplicate clicks on the same PR share the pending request. Submission reopens completion but never declares Done, changes ownership, or enables Auto.

Tracking, recovery, follow-up, Done, and CLI-backed Merge work without Send to Paseo or a Graphite browser session. Merge and checking its result use saved Graphite CLI authentication. The optional browser companion supplies the signed-in session needed to read and change the actual MWR setting; all merge UI stays in Follow-up. Disconnected MWR switches are hidden and their individual browser reads pause. Connection guidance lives in the collapsed Agent, recovery and Graphite disclosure; connecting restores the switches. Read-only Graphite readiness and queue observations still batch owned open PRs by repository with a 30-second cache. GitHub auto-merge remains separate. These adapters use internal Graphite APIs and require compatibility verification.

## Product Principles

Stakeholder replies are substantive follow-up tasks. Agents retain the original Slack thread and recipient, distinguish progress from verified outcomes, and record sent-message receipts. Final verify-and-reply tasks can wait for actual deployment. Auto governs agent delivery; external replies require actual developer authorization and an available write-capable connection. Drafts or uncertain posts stay blocked. The plugin does not scan Slack in the background or create its own posting identity.

- Tracking follows a workspace click or an enabled project default; repository identity, not display names, determines the built-in acme-poc default. Installation and lifecycle discovery respect these defaults without enabling Auto. Polling sends only for tracked workspaces with explicit Auto consent.
- Auto is a visible per-workspace toggle, off by default. Manual clicks are immediate; Auto waits for idle boundaries.
- Show what needs human judgment and what the agent is handling.
- Preserve history independently of the checked-out branch.
- Separate merged PRs from completed goals.
- Deliver fresh, deduplicated work at safe boundaries.

## Evidence on Hand
Existing Graphite, Defer, Smart Session, and Session Guard plugin code; the developer's long-lived workspace transcript. Screenshots use clearly identified synthetic demo data.

## Compact status and deployment follow-up

The workspace view leads with status: PRs merged, what needs the developer, what needs fixing, a stack bar and what the agent is doing now. Developer decisions sit in one Needs you card with an action each. PR rows are drawn as stack rails with a two-line title and `#n · status`; full detail opens in a PR sheet. Tasks are secondary concrete checks, migrations and decisions. Approval/merge/deploy checklist duplicates remain in legacy history and are omitted from Tasks. Goals, evidence and recovery details use disclosures.

For acme/acme-poc production, the plugin reads serving Cloud Run revisions and immutable build source commits, then checks the actual PR merge commit's git ancestry. PR status progresses from Merged to Deployed once deployment is confirmed; pending, partial or unknown deployment keeps the Merged label, with evidence available in details. Known production deployment must be verified before Done. Other repositories currently have no deployment adapter. Tasks default to manual. Explicit Now, merge or verified-deploy triggers can schedule delivery, with a delay in days and owned PR selection. Delays begin at the last selected event; deployment timers retain the first verified serving observation across polls and restarts. Unscheduled and future tasks never join repair batches; delivery retains explicit workspace Auto consent or a click, idle/hold guards and deduplication. Tasks with multiple dependencies wait for all of them.


## Sidebar settings and CI status

The panel leads with its status header; the settings gear sits beside the workspace title. Project
and display preferences remain available in Paseo’s plugin settings and Command-K. A composer pill
and the header button's dot appear only while a workspace needs the developer.

Stacked PRs inherit trunk check requirements when GitHub confirms their parent branch is an open
PR head in the same repository. Other observed failing checks remain visible as Optional check
failed (or Optional checks failed), with their names in details, without becoming automatic
repair tasks or new required merge checks. Required failures retain the Checks failed label.
