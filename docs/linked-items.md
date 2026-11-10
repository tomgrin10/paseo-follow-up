# Linked items

The verified things a workspace's work is about: Linear issues, Slack threads, Claude artifacts, docs, GitHub issues
and, when someone links one on purpose, any other URL. PRs are not linked items, because they have their own card.

## Files

- `shared/linked.ts` is pure, with no I/O. It holds the schema, identity (`classifyLink`), dedupe across origins
  (`upsertItem`), exclusions, the cap, the Linear candidate queue (`noteCandidate`, `setTeams`, `dueChecks`,
  `applyCheck`, `takeBudget`) and the one-time migration from Summary links (`migrateAboutLinks`).
- `server/linked.ts` has `LinkedStore` (`linked.json`, written atomically, read on use and never cached in the worker),
  `LinkedService` (drain and migrate) and `liveLinkedSources`, which runs Linear's `get_issue` and `list_teams`
  through mcpproxy, like the Summary.
- `shared/linked-extract.ts` is pure too. It extracts references from text Follow-up already reads (`timelineRefs`,
  `workspaceRefs`).
- `index.server.ts` runs a loop every 10 minutes, the first 90 s after start: migrate once, note the workspace
  record's references, then drain.

## How items get in

- **`link_item` / `unlink_item`** (an agent, origin `registered`) and **`set_linked_items`** / `follow.set-linked-items`
  (the developer or an agent for them, origin `manual`).
  - A Linear key is confirmed with Linear on the spot. An unknown key or a non-team prefix is refused, not stored.
  - When Linear can't be read, the key waits as a candidate.
  - A PR is refused and pointed to `register_pr`.
- **Extraction** (origin `extracted`) rides discovery's own timeline batch (`PaseoGateway.linkRefs`). Only loaded
  agents are read, so a dormant agent is never woken for this.
  - Strong: Linear tool receipts, Slack threads the agent read, URLs in completed tool calls, the developer's own
    messages, and the goal, title, PR titles and branches.
  - Weak: agent prose and other agents' messages. A weak key waits for a second sighting before Linear is asked.
  - Only entries past the cached cursor count, so a re-read overlap is never a second sighting.
  - Follow-up's own messages, bare keys in shell commands, PRs and generic URLs never count.
- **Spec and published artifacts** (origins `spec`, `published`) are derived in the view (`linkedView`) from
  `w.spec` and `w.artifacts`, never copied. The spec is tagged and left out of the counts.

## Rules

- **Precision over recall.** An extracted Linear key is a *candidate* and never renders until Linear confirms it.
  It also needs a team prefix that is a known Linear team (`list_teams`, read at most once a day), so lookalikes like
  STATUS-1025 or REVISION-2026 never show.
- **Not found** is remembered in `rejected` and never checked again. A read error is retried after 1 h, 6 h and 24 h,
  then dropped. There is never a "couldn't be read" row.
- **Budget:** at most 6 checks per drain and 120 a day. There are no checks while the resource governor says the VM is
  short of room. An empty queue (the steady state) costs one small file read and no MCP call.
- **Trust order** when one key arrives from several origins: manual > registered > spec/published > extracted. A
  more trusted origin takes the record over; a less trusted one only fills in missing fields.
- **Exclusions stick.** A removed key stays out against every origin. Only the developer adding it back clears it,
  and Undo restores the removed item as it was.
- **Cap:** 50 items per workspace. The oldest extracted item makes room. Registered and manual items are never
  evicted silently: adding past the cap with nothing extracted to evict is refused.
- **Migration (`about-links-1`):** runs once. Summary links Linear had confirmed (with a title), Slack threads with a
  channel, artifacts and docs carry over. Bare keys become candidates. PRs and generic links are dropped.
