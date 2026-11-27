# Compass

Compass takes the developer's priorities from where the developer takes them: the people and places that decide what
they work on first. A **source** says whose words count, where to read them and what they tell Follow-up. Each workday
morning Follow-up reads what those people said, a fast model turns it into **notes** that quote them, each note finds
its workspace, and AI priority ranks the work by it.

Files: `shared/compass.ts` (the model, validation, dates, matching, a note's life), `server/compass.ts` (the reads, the
extraction job, `compass.json`), `client/compass-settings.tsx` and `client/morning-brief-settings.tsx` (Settings →
Compass).

## Settings → Compass: one place for priority inputs

Settings → Compass (it was Settings → Morning brief; the category id `brief` stays, so links land here) is the one
place for everything AI priority reads (invariant 108, `one-place-for-priority-inputs`):

- **What sets your priorities:** one list. First the Compass sources (the people and places the developer picked),
  then the built-in inputs, each with its role (`inputLabel`, `inputRole` in `shared/brief-sources.ts`): your Linear
  queue and review requests (Sets your priorities), your DMs and mentions, your calendar and your mail (Background),
  your docs (Compass's doc places: the docs server is read only for the pages a source names). Every row, a source's
  or a built-in input's, has one style: its name, one line with its role and what it reads, a warning when its last
  read failed, a chevron for the rest (a source's plan, reading notes, live notes and Edit source; an input's own
  setting: the queue's states, the chat window, the calendar's days) and its switch. Add a source and Read now sit
  right under the sources, before the built-in inputs, so a phone never puts them a screen below. Servers no recipe
  fits follow, for Ask. Paseo's own state is always read and isn't a row.
- **This week's plan:** Compass, A link, or Off. A source with Posts the plan shows the plan it brought on
  its row ("Shared this week's plan, Week of Nov 23 · Sun 18:05", with Open).
- **How to read your Compass** and the glossary.
- **When:** the morning read's time, changes since, the zone and the workdays (`set_brief_settings`).
- **Connections:** what mcpproxy and GitHub let Follow-up read ("6 inputs read · Review requests needs attention above":
  a row's failure is said once, on its row), the servers it can't read, and Check sources again.

`compass` returns all of it (`plan`, `inputs`, `brief` beside the sources), and `set_compass` changes all of it
(`plan`, `inputs`, `queue` beside a source's fields). The brief's tools (`brief_plan`, `set_brief_plan`,
`brief_sources`, `set_brief_sources`, `brief_chat_search`) stay as aliases for one minor release; `brief_settings`
keeps the brief's own fields.

**The one-time move.** The first read after the update turns Find it for me's person and channels into one Compass
source (`moveToCompass`, `MorningBrief.moveOnce`): that person, read in their DM and those channels, with Sets my
priorities and Posts the plan. The same person already a source gains the plan role and the places it lacks instead.
A name kept without a chat id is looked up once by the chat search (an exact name); one still not found stays in
`plan.unmoved`, by name, and the plan card says to add it. Nothing else moves: the brief's queue, windows and switches
were already stored where they are read. A file with `plan.mode: "auto"` reads as `compass`.

## This week's plan, from Compass

A source with **Posts the plan** provides the plan. As Compass reads it (the morning read, Read now, a new place's
week), the newest claude.ai artifact link one of the source's own people shared (`artifactLinks`, share key dropped)
goes to `MorningBrief.recordPlan`: a newer one becomes this week's, the one before it last week's, and its title is
read at once through the plan reader (Artifact `read` only, under the job guard). The same link again, or an older
one a week's read meets, changes nothing. There is no search of its own and no timer: Find it for me's daily search is
gone (the-brief-has-one-timer). The plan's items are matched to issues and workspaces (`matchPlan`: an item's first
key is its issue, its workspace by the one predicate Dispatch reads), and the card counts the items without an issue.
`effectivePlan` keeps its order: `FOLLOW_UP_PLAN_URL`, Off, a pasted link (a newer plan from Compass replaces it when
"replace when newer" is on), else Compass's newest plan, else last week's.

## The rule that keeps it generic

> Code knows kinds of things. Config names the developer's things. Instructions say what their words mean.

- **Code** ships reader kinds (a conversation, a doc, a tracker scope, a calendar), roles, validation, matching and
  default reading notes, all written about "a person", "a place" and "the developer". It names no tool, server,
  company, person or workflow (invariant 99, widening 82).
- **Config** (`morning-brief.json` `compass`, edited in Settings and by `set_compass`) decides what is read and where
  results go.
- **Instructions** (the developer's "How to read this" per source, at most 600 characters, and "How to read your
  Compass" for all of them, at most 1000) decide how what was read is understood. They never change what is read,
  what is written or where a result goes (invariant 100).

## A source

```ts
{ id, label, who, places[1-5], roles[], instructions, enable_needs_you, enabled, addedBy, addedAt }
```

- **who:** a person, up to 5 people, everyone in the place (`anyone`, decision R1: capped, see Reading), or the
  developer's own words (`me`). A tracker's or a calendar's items are read by rule, so nobody is picked for them.
- **places,** each picked from what its reader finds (`compass_find`), so every place carries its reader's own id:
  - a **conversation** (DM, group, channel, thread), from the chat tool's search;
  - a **doc**: a page a docs tool serves (the doc recipe: a read by id or link plus a search, matched by shape), or a
    Markdown or text file on this machine (decision R2; `compass_find {kind: "file"}` checks it first: an absolute
    path, `.md` or `.txt`, at most 64 KB). A file's id is `file-` and a hash of its path; the path stays in the
    place's own settings and never reaches a key, a log line or an error;
  - a **tracker** scope: a Linear project or milestone from the queue's own snapshot (`linear:project:<name>`), or a
    GitHub repository's label or milestone (`github:<owner/repo>:label:<name>`, `…:milestone:<number>`);
  - a **calendar**: the calendar tool's, with "meetings with guests" or all events.
  A place no reader here can serve is refused with one line of why (`READER_MISSING`), never saved to sit unread.
- **roles:** Sets my priorities, Posts the plan, Deadlines, A customer's voice, My own notes, Background. Each ships
  generic reading notes (`ROLE_INFO`). Background makes no notes.
- **Presets** (`PRESETS`) only fill a new source's fields. One whose reader isn't here (no chat tool, no tracker, no
  calendar) is listed with its why; a doc preset is always offered, since a local file needs no tool.
- **Glossary:** the developer's words → an issue key (or workspace or account), checked when saved, read by matching
  before anything else.
- **expiry** (undated days 7, grace 1, decay 3 workdays) is editable. **routing** (where suggestions go: urgent ones to
  Needs you and the rest to Dispatch, Dispatch only, or off; how strong and how soon is urgent) and **cadence** (the daytime
  read: Off, 1 h, 2 h, 4 h; default 2 h) are in Settings → Compass → When and `set_compass`.

## Reading

`Compass.idle()` drains active and queued reads before their dependencies are disposed; callers stop starting new work first.

- **When:** once a workday after the sweep time, from the worker's 15 s loop (`Compass.tick`, the-brief-has-one-timer),
  while the governor allows background work; then the **daytime read** every `cadence` (default 2 h) from the same
  loop, only while an app client is open (a home-feed subscriber, or on Paseo 0.15 a priorities poll in the last 2
  minutes), on workdays between 08:00 and 20:00 in the developer's zone; on Read now (`read_compass`); and over the
  last week when a place is added. With the app closed nothing is read on a schedule. Each read takes only what's new
  since the place's cursor, and an empty read makes no model call.
- **How:** by cursor in time order, never by a relevance search. The chat recipe's `history` role (a conversation id
  and an oldest time, matched by shape) is read newest page first, at most `COMPASS.pagesMax` pages; without one, the
  message search sorted by time, one day at a time, and the place says it's on the slower path. A read that fails
  keeps the cursor, so the next read covers the gap. Thread replies are read with their parent's thread in a later
  release.
- **Whose words:** only the source's people reach the model; the developer's own replies come along marked as context
  (for "never mind") and can never become a note; anyone else in the place is dropped before the model. With
  **everyone** (`anyone`), one read takes the place's newest 40 messages in one extraction and skips the older ones,
  and the place says so ("A busy place: this read took its newest 40 messages and skipped 12 older"); the source's
  reading notes narrow it ("only the leads").
- **A doc** is read whole each time (one call to the docs tool, or a stat of the file, which is opened only when its
  modified time or size moved) and compared by hash: an unchanged doc makes no model call. A changed one is split into
  blocks (paragraphs and list runs, each with the heading above it), and only blocks not read before (`seen`, by hash)
  go to the extraction. A Posts the plan doc's claude.ai artifact link becomes the plan, as in a conversation.
- **A tracker** place is read by rule, with no model: each open issue in scope (most urgent first, at most 15) is a
  note quoting its own fields ("ACME-177 Webhook retries · due 2026-11-26 · Urgent · Todo"), its strength from its
  priority (Urgent and High high, Medium normal, Low low; a GitHub label the developer named is high, a milestone
  normal; under Posts the plan, low), its date the issue's or the milestone's due date. An issue that leaves the scope
  ends its note. Linear's come from the sweep's snapshot (no read of their own; the queue is the developer's assigned
  issues); GitHub's from one in-process REST read, at most once an hour per place except on Read now. A tracker or doc
  under Posts the plan makes plan notes AI priority ranks like plan items; the plan card itself stays the newest
  artifact or a pasted link.
- **A calendar** place is read by rule too: the calendar tool's events over the next 14 days. An event lends its date
  to the work it matches (the glossary, an issue key in its title, then the title score); one that matches nothing
  isn't kept, so meetings never crowd the notes (at most 10). "Meetings with guests" skips an event whose reply says
  it has none.
- **A read someone asked for waits its turn:** a new place's first read, Read now and `read_compass` arriving while
  another read runs, run once after it, so a source added during another's first read still gets its own (a
  scheduled read joins the one going).
- **Caps** (`COMPASS`): 8 sources, 5 places each, 25 model calls a day for all of Compass, 40 messages and 8 k
  characters a call, 60 live notes, 64 KB a doc, 15 notes a tracker place and 10 a calendar. A cap reached says so on
  the place ("Paused until tomorrow"), never silently.

## Extraction

One call per read that has new words from the source, on the **Summaries** role's model (Claude Haiku by default)
through `AiJobs`. The prompt is, in order: the rules, the role notes, the developer's global reading notes, the
source's, today in the developer's zone, the source's open notes, then the messages fenced as data. No workspace list:
matching is Follow-up's.

**The guard.** The words are other people's, so extraction runs only where Follow-up can take every tool away: Claude
under the job guard's empty grant (`server/job-guard.ts`), Codex in its read-only sandbox. With Summaries on any other
provider, Compass reads nothing at all, not even the conversation, and the Compass card and `compass` say why in one
line ("Compass doesn't read on Gemini: Follow-up can't take its tools away. Pick Claude or Codex for Summaries in
Settings → Agents."). The general gap for other providers' jobs closes in a later release.

**Validation** (`validateExtraction`): a note stands only when its quote is a verbatim substring of the message
(whitespace folded), its keys are written in the message or come from the glossary, its date comes from the words
(`resolveUntil`, which wins unless the developer's reading notes name the phrase) or lies within 60 days, and its
message is the source's own, not a reply of the developer's. Author, time and link are the message's. A refused note
is logged by rule code only (`quote-not-found`, `key-not-in-text`, …). No retry.

## Notes

`compass.json` holds each place's cursor, the notes, today's model-call count, the morning read's day, the last read
and the last refused rule codes. Never the text read: a note keeps its quote (at most 280 characters), dropped 7 days
after the note ends.

- **Matching** (`placeNote`): the glossary first, then a key's workspace (`issueWorkspaces`, invariant 95's one
  predicate), then one token score per workspace (title, Summary, linked titles, PR branch) chosen at ≥ 0.5 and 0.15
  above the next. A key with no workspace makes the note about that issue. Otherwise it is unplaced.
- **Life** (`settleNotes`): a dated note lives through its date plus grace; an undated one for `undatedDays` after it
  was last said; a retraction ends it; a newer note from the same source on the same subject supersedes it. Notes from
  different people that disagree are all kept: Follow-up never picks between people.
- **By hand** (`applyNoteAction`): pin a note on a workspace in your own words (source `hand`, "Pinned by hand"),
  edit its date, strength or workspace, unpin it. A hand note with no date lives until it is unpinned.
- **Settings** opens a source's live notes under its row: what each says, the words it quotes, its date and where it
  went.
- **AI priority** reads the live notes (`Compass.forRanker`, at most 20, soonest first) as its COMPASS section, with
  rules for how strong each role and strength is. A note's reason line names Compass as its source
  (`PRIORITY_SOURCES` `compass`). New notes mark the ranker due once (`Ranker.markDue`).

## On screen

- **Home's reason line**: a Compass reason carries the compass glyph and ends "· Compass". A workspace the ranker gave
  no reason shows its first live note instead ("Dana: client call Tue"; `noteLines`, soonest then strongest), on the
  workspace's main row only. The lines ride on `follow.priorities` and the Home feed as `compass`.
- **The panel's Why it matters** (`client/why-it-matters.tsx`), under the goal: the AI priority line ("2nd of 14 in AI
  priority · reason", from `compass {workspace}`), then the first note: what it says, the quote at two lines (press to
  open), who, role, when, where and until. Open message opens the source message. Ask the Overseer puts a question about
  the note in the Overseer's composer, unsent (hidden when the Overseer is off). ⋯ holds Tell the agent, Edit, Move to
  another workspace and Unpin (asks once). "+N more" shows the rest.
- **Catch up**: a card's head gains one muted line, "Compass · Dana: client call Tue".
- **Tell the agent** (invariant 107, `compass-reaches-an-agent-only-by-a-click`) queues one message to the workspace's
  main agent: the developer passed this on, the quote as someone else's words, what Compass read, the date. It asks for
  nothing. Nothing else in Compass ever messages an agent.

## Suggestions: issues nobody's on

A live note about an issue (`match.issue`) that has no workspace (invariant 95's one predicate) is a **suggestion**
(`suggestions`, `shared/nobody.ts`), one per issue: its soonest, then strongest note.

- **Urgent** (routing `needs-you-and-new`, the source's Needs-you switch on, strength at `routing.urgentStrength`, a
  date within `routing.urgentWithinWorkdays` workdays): a **Nobody's on it** row in Needs you
  (nobody-s-on-it-is-needs-you). A raised Linear issue is the same row kind: one row per issue (`nobodyNeeds`) whatever
  the reasons, the first drawn as its reason line with its source ("Dana: renewal call Thu · Compass", "Linear ·
  Raised Low → Urgent"), every one in its screen-reader label and `why_suggested`. One Start… (Dispatch on the issue), one
  two-click Remove (`follow.dismiss {issue}` takes the raise and every Compass ask on it), one count on the home feed.
- **Everything else** sorts first in Dispatch's **My issues**, with its reason line. An issue not assigned to the developer
  joins My issues with the compass glyph while its note is live. A search shows no suggestion.
- **Remove** is per note (`dismiss_item {compass: noteId}`, kept in `compass.json` `removed`); a later note on the same
  issue suggests it again. Routing `off` turns suggestions off; notes still reorder AI priority.
- **`{why}`** (an-action-is-data): Dispatch's placeholder for a suggestion's quote, who said it, when and its date
  (`whyText`). The built-ins carry it; for any other source it is empty and its line drops.

## The brief: one Since block

The brief's "Since" block is one block for every source (design §8): "Since Friday · Dana, your Linear queue". Against
the brief's own stored point (a-change-is-against-what-you-last-saw), Compass's lines (`compassSince`) come first:
workspaces it heard about (at most 3, with the quote), what went to Needs you (named once, no second Start…), other
suggestions (at most 2, with Dispatch's actions), then the queue's changes, then notes dropped ("Dana dropped Okta SSO"),
"N notes aren't on any workspace" and a failed read. Home's brief row adds "1 from Dana" (`heardWords`) when Compass
heard anything since.

## The Overseer: a user, not the engine

Compass runs as Follow-up's own job with the Overseer off (compass-without-the-overseer). The Overseer's digest gains a
Compass block when a note is live: this week's plan and at most 12 notes, `who · until · what · where · note id`, built
only when its digest is. It acts through the same tools (`compass_note`, `set_compass`, dry run then confirm) and never
reads a source. Why it matters' Ask the Overseer puts a question about a note in its composer, unsent.

## Tools

| Tool | Kind | Does |
| --- | --- | --- |
| `compass` | read | Sources, glossary, presets, each place's last read, live notes (optionally one workspace's) with the titles of the workspaces they went to, `blocked`, and (without `workspace`) `plan`, `inputs` and `brief`: every priority input. |
| `compass_find` | read | A place for a source, each with the place `set_compass` takes: `people`, `channels` (the chat's search), `docs` (the docs tool's search), `file` (a local path, checked), `trackers` (the queue's Linear projects and milestones, or `owner/repo [words]`: its GitHub labels and milestones), `calendars`. |
| `set_compass` | planned | Add, edit or remove a source; reading notes; glossary; expiry; `routing`; `cadence`; `plan` (mode, link, replaceWhenNewer, find), `inputs` (on, retry, check, preview) and `queue` (states, chat and calendar windows). |
| `read_compass` | planned | Read now; waits up to 30 s, then `running`. |
| `compass_note` | planned | Pin (a workspace, what, optional until and strength), edit, unpin, or tell (one message to the workspace's main agent, only on the developer's ask). Audited as `agent:<id>`. |
| `why_suggested` | read | The notes behind a workspace, issue or note: what, quote, who, when, source, role, strength, until and how it matched, and `needsYou`: whether it is a suggestion, urgent (Nobody's on it) or first in Dispatch, and why. |

`dismiss_item {compass: noteId}` removes one suggestion; `dismiss_item {issue}` removes a Nobody's-on-it row.
"Set up Compass from my DM with my PM" is `compass` → `compass_find` → `set_compass` (dry run, then confirm).
