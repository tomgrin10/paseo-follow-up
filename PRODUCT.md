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

Tracked main agents maintain sidebar metadata during normal work. Scoped Claude/Codex hooks supply instructions on session start and normal prompts, including compaction recovery; a missed end-of-turn sync permits one bookkeeping continuation. This does not wake idle agents, launch recovery or change Auto. Codex hook trust remains a separate provider requirement.

## Capabilities and Constraints
Paseo native Explorer panel and workspace tab; global overview; persistent host-side records and polling with the app closed; agent MCP tools; individual or project-default tracking with original main-agent ownership. Done is an agent declaration gated by settled PRs and completed obligations. Archiving remains manual. The POC supports GitHub, historical PR reference recovery and agent-maintained stack membership.

Canonical remote Git projects whose repository basename is `hero-poc` track by default, including organization and fork projects. Other projects start off. Native Settings → Plugins → Actions for follow-through → Follow-up and **Follow-up: project settings** provide per-project switches, persisted by stable project ID. On enrolls existing and future unarchived workspaces with a valid original main agent; Off stops further enrollment while preserving tracked records and settings. New enrollments have Auto off and do not send messages or create a recovery agent automatically. Existing tracked Auto choices remain unchanged.

Existing-workspace inventory is an optional user action under Workspace → Recovery, repeatable after completion. It runs in a separate recovery agent. Its result and conversation remain accessible there; the original main agent retains ownership of repairs and Done. Recovery and repair prompts stay specific to their respective tasks. Manually registered PR repairs, dependency checks and Done never require inventory acknowledgment. Auto does not schedule recovery. Optional recovery activity, failures and permissions do not hold main-agent work.

Developer-corrected scope is retained through `exclude_stack`: unrelated stacks, their PRs, and associated obligations move into a durable audit with the reason and exclusion time. Excluded PRs and stack names are blocked from registration, so later recovery cannot silently restore them to owned work.

Pull requests keeps active stacks visible and retains fully settled stacks under a collapsed **Settled** subsection, including their headings and counts. Expanding it reveals the historical stacks and their PRs.

Open PRs have human-operated Graphite **Merge** and **Merge when ready** controls in Follow-up. Merge always opens a fresh confirmation; an upper PR lists its owned unmerged downstack in order. MWR changes on an upper PR offer this PR or the listed downstack. A single-PR toggle applies after fresh checks. Changed revisions or membership invalidate confirmation; an uncertain result must be checked before another action. Submission reopens completion but never declares Done, changes ownership, or enables Auto.

Tracking, recovery, follow-up, Done, and CLI-backed Merge work without Send to Paseo or a Graphite browser session. Merge and checking its result use saved Graphite CLI authentication. The optional browser companion supplies the signed-in session needed to read and change the actual MWR setting; all merge UI stays in Follow-up. Disconnected MWR switches are hidden and their individual browser reads pause. A collapsed **Optional merge when ready** subsection after PR stacks contains connection guidance; connecting restores the switches. Read-only Graphite readiness and queue observations still batch owned open PRs by repository with a 30-second cache. GitHub auto-merge remains separate. These adapters use internal Graphite APIs and require compatibility verification.

## Product Principles

Stakeholder replies are substantive follow-through tasks. Agents retain the original Slack thread and recipient, distinguish progress from verified outcomes, and record sent-message receipts. Final verify-and-reply tasks can wait for actual deployment. Auto governs agent delivery; external replies require actual developer authorization and an available write-capable connection. Drafts or uncertain posts stay blocked. The plugin does not scan Slack in the background or create its own posting identity.

- Tracking follows a workspace click or an enabled project default; repository identity, not display names, determines the built-in hero-poc default. Installation and lifecycle discovery respect these defaults without enabling Auto. Polling sends only for tracked workspaces with explicit Auto consent.
- Auto is a visible per-workspace toggle, off by default. Manual clicks are immediate; Auto waits for idle boundaries.
- Show what needs human judgment and what the agent is handling.
- Preserve history independently of the checked-out branch.
- Separate merged PRs from completed goals.
- Deliver fresh, deduplicated work at safe boundaries.

## Evidence on Hand
Existing Graphite, Defer, Smart Session, and Session Guard plugin code; the developer's long-lived workspace transcript. Screenshots use clearly identified synthetic demo data.

## Compact status and deployment follow-through

The workspace view leads with compact PR headlines: icon/number/status in one column, a two-line title beside them, with full detail available on demand. Tasks are secondary concrete checks, migrations and decisions. Approval/merge/deploy checklist duplicates remain in legacy history and are omitted from Tasks. Goals, evidence and recovery details use disclosures.

For herosecurity/hero-poc production, the plugin reads serving Cloud Run revisions and immutable build source commits, then checks the actual PR merge commit's git ancestry. PR status progresses from Merged to Deployed once deployment is confirmed; pending, partial or unknown deployment keeps the Merged label, with evidence available in details. Known production deployment must be verified before Done. Other repositories currently have no deployment adapter. Tasks default to manual. Explicit Now, merge or verified-deploy triggers can schedule delivery, with a delay in days and owned PR selection. Delays begin at the last selected event; deployment timers retain the first verified serving observation across polls and restarts. Unscheduled and future tasks never join repair batches; delivery retains explicit workspace Auto consent or a click, idle/hold guards and deduplication. Tasks with multiple dependencies wait for all of them.
