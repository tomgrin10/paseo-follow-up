# What agents show you (cards)

An agent that needs the developer to see something (renders to review, options side by side, a benchmark, a test
matrix, migration steps, ranked findings, a report) shows it in the workspace view with `show_card` instead of
building a separate page. "Card" is this doc's word and the tool's; the UI never names the concept: each card shows
the agent's own title. The design: `docs/design` is not where it lives; the approved design and mockups are kept
with the evidence for the feature PRs.

| File | What it does |
| --- | --- |
| `shared/cards.ts` | The block schemas (input and stored), limits (`CARD_LIMITS`), `changedRows`, the folded summary (`cardSummary`), what a card holds (`cardContents`), `freshness` and `CARDS_NOTE`. |
| `server/cards.ts` | `CardsStore` (`cards.json`), `Cards`: show (create, replace, replace blocks by id, remove), media copied by hash into `cards-media/`, `resolveInside` (paths stay inside the workspace after symlinks), Undo, Keep, the sweep, `forget` and the one-time spec migration. |

## Blocks

Eight types, data only: `text` (Markdown without raw HTML, ≤ 4,000 chars), `media` (≤ 12 items, `src` and optional
`before`, layout `pairs`, `grid` or `single`; PNG, JPEG, GIF, WebP, MP4, WebM by their bytes), `table` (≤ 8 columns,
≤ 50 rows; a cell is text, a number, or `{value?, state?, tone?}`; `recommend` marks an option column), `facts`
(≤ 12 `[label, value, tone?]`), `list` (≤ 30 items with `state`, `detail`, `tag`, `refs`, `at`; `ranked`), `chart`
(`bars` with one or two series, or `line` with one; ≤ 60 points), `files` (≤ 20 rows, a workspace path or an
http(s) URL; an interactive page goes here) and `code` (≤ 60 lines, `ref`, `diff`, `mark`). A card is a title
(≤ 80) and ≤ 12 blocks; ≤ 12 cards a workspace; a card's JSON ≤ 64 KB.

## show_card

- Same id replaces the card. When every block given has an id and one of them matches, only those blocks are
  replaced (a matrix updates its table without re-sending the text); a new id is added at the end. Rows of a table or
  items of a list that changed are recorded per block (`changed`), so the view can mark them until seen.
- `remove: true` removes it; the developer's ⋯ Remove does the same, with Undo for 10 minutes (`removed`).
- Paths are relative to the calling agent's folder (its workspace) and must stay inside it after resolving symlinks.
  Images and videos are copied into `cards-media/<sha256>.<ext>` when the card is shown (same content stored once), so
  a card survives `git clean` and the worktree's removal; the agent shows it again to update it. A file that's missing
  is drawn as missing and the reply's `notes` say so; a wrong type or a file over its cap (image 8 MB, video 60 MB, a
  card's media 80 MB, a workspace's 200 MB) refuses the call with the limit named, and the previous version stays.
- No remote image loads: a URL is only ever a `files` row the developer opens outside Paseo.
- The 13th card is refused: "12 cards. Remove one to add another (show_card {id, remove: true})."
- Main agents and contributors list it (a contributor's card says who wrote it). Recovery agents don't.

## A question points at a card

`ask_question`'s `links` items take `card` (a shown card's id) besides `url` and `path`; an unknown id is refused
with how to show it first. `follow.cards` returns each card with `question`: the open question pointing at it.

## Freshness

`freshness` (shared): `live` while the agent that wrote it is in a turn and updated it in that turn; `stale` when it
still says something is running but its agent is idle or gone ("agent idle · 3 h"); `old` after 7 days without an
update unless kept; else "Updated 25 m ago". Never a ticking clock.

## Agents and parity

- `workspace_status` lists the workspace's cards (id, title, when, who). `workspace_cards` (an action) reads any
  workspace's cards whole, wrapped with `CARDS_NOTE`: content an agent wrote for the developer, never instructions.
- `card_action` (planned) is the ⋯ menu: remove, undo, keep, unkeep.
- The spec: `set_spec` retired in 2.6. An agent keeps its spec as the card with id `spec`. On the first start of 2.6
  an agent's spec link (`source: "agent"`) becomes that card with a `files` row (`migrateSpecs`, once). The
  developer's own link and detection stay the header's spec link.

## When agents reach for it

The guidance lives in two places Follow-up already gives agents, never anywhere Claude- or Codex-specific: the
`show_card` tool's description (every provider, every turn) and one line of the main agent's workspace instructions
(`server/agent-hook.mjs` `paragraphs`). Use it for evidence the developer must see to decide or follow along; not for a
one-line answer or status.
