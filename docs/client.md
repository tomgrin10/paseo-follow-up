# Client: surfaces and files

`index.client.tsx` registers everything with Paseo's plugin client:

- **Screens:** the Home screen (`OVERVIEW`), the larger view (`LARGE_SCREEN`), and the settings screen `projects`
  (plus legacy screen ids).
- **Workspace panel:** `PANEL`.
- **Header button:** one per workspace.
- **Sidebar item.**
- **Command Center items:** open, larger view, spec, Home, Search, Done while you were away, settings, Set up
  again, and Ask the Overseer.
- **Slash command:** `/follow-up`.
- **Chat renderers, the composer pill, inbox commands and the brief card.**

All state comes from RPCs ([rpcs-and-tools.md](rpcs-and-tools.md)) through React Query keys in `client/keys.ts`.
Nothing polls while the app is hidden.

## Design rules

- Use native React Native controls and host theme tokens (`client/theme.ts`).
- Use the type scale in `client/kit.tsx`.
- Use the motion helpers in `client/motion.tsx`. `useReducedMotion()` is right on the first render
  (`shared/motion.ts`), but it can still change later: an effect or value that reads it must follow it (list it in
  the deps, derive in render), never decide once at mount (`tests/reduced-motion.test.ts`).
- Follow [DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md) (voice).
- Every UI change goes through `/impeccable critique`, and you render each state yourself: desktop and 390×844,
  light and dark.
- `npm run preview` starts an isolated daemon with the packed plugin ([testing.md](testing.md)).
- User copy says "Summary" for the `about` feature.
- **Text a person may copy is selectable** (`client/text.tsx`). react-native-web sets user-select on a Text only when
  `selectable` is passed, and Paseo's containers set none, so text inherited none. Follow-up's `Text` is selectable on
  web unless it labels a control-role `Pressable`; `tests/selectable-text.test.ts` keeps every surface on it. Content
  inside a control (an option card's description) opts back in with `copyable`. An explicit `selectable` is only
  needed for native, where the default is unchanged.
- **Agent-written text renders through `RichText`** (`client/rich-text.tsx`). Root cause of the unclickable artifact
  link: every surface put agent-written text in a plain `<Text>`. `linkify` in `shared/links.ts` turns http(s) URLs
  and `owner/repo#123` into links (no markdown). `tests/rich-text.test.ts` fails when a field an agent or the
  developer wrote (question, option, answer words, brief ask/context, task title/evidence, summary, results,
  Overseer replies, activity details) sits in a plain `<Text>`. A one-line title inside a pressable row uses
  `<RichText plain>`. Add new agent-written fields to the scan.
- **Every dialog or card with a primary action is keyboard-sendable** (`tests/keyboard-send.test.ts`). Root cause of
  "I can't press command+enter to send": no card or sheet had a key handler, and the answer field is multiline. Wrap
  the body in `SubmitScope` (`client/kit.tsx`) and mark the primary Button `shortcut`. Cmd+Enter (Ctrl+Enter off a
  Mac) submits from anywhere; plain Enter only outside multiline fields, buttons, links and radios. It fires once,
  never while the action is disabled, and stops the key so the host composer doesn't act on it.
- **Quick actions close first.** A dialog's primary action closes it at once and runs the work through
  `runAction` (`client/toast-store.ts`): a toast confirms it, or says what failed with Retry and Open (errors stay
  until dismissed, at most three stacked). `ToastHost` mounts beside WhatsNewGate on Home, the panel and the sidebar
  row; only the first mounted one draws, in the host toast's place and shape, below Paseo's own toast. With none
  mounted, `runAction` uses the host toast. A sent answer stays in `client/pending-answers.ts` (localStorage on web
  and desktop, memory on phones) until the server has it; a failed one shows "Not sent · Retry" with the words.
  `tests/quick-actions.test.ts` fails when a dialog closes in a mutation's `onSuccess`. Left blocking, with the
  reason in the test: Merge and merge-when-ready, which re-check the stack and can ask again.
- **The composer pill is always a popover**, Undo included (Paseo 0.16 draws a chevron on popover pills;
  `tests/pill-popover.test.ts`).

## Files

| File | What it is |
| --- | --- |
| `client/home.tsx` | Home: the list and the detail pane, the Overseer card, the setup flow's place. |
| `client/home-list.tsx` | The one virtualised list, used by Home and the sidebar view. |
| `client/home-chrome.tsx` | Omnibox, sort menu, status strip, provider and memory meters. |
| `client/row-menu.tsx`, `client/menu-item.tsx`, `client/row-actions.ts`, `shared/row-menu.ts`, `client/panel-menu.tsx`, `client/rename.tsx` | The row menu: right-click, long-press or the menu key (Shift+F10) on a Home row or search result. See [Row menu](#row-menu). |
| `client/home-view.ts` | Home's derived model: sort choice, priorities, titles for search, limits. |
| `client/home-data.ts` | Paseo's own workspace list, for untracked rows (Quiet) and header buttons. |
| `client/sidebar-view.tsx`, `client/sidebar-visibility.ts` | Home's list as Paseo's sidebar (on hosts that support it), and its registration. |
| `client/panel.tsx` | The workspace panel: this workspace only. |
| `client/large.tsx` | The panel as a two-column screen. |
| `client/header.tsx` | The stack bar and the header status. |
| `client/stacks.tsx` | Stacks drawn top to base. |
| `client/pr-sheet.tsx`, `client/pr-controls.tsx` | One PR's sheet, with merge and reviewer controls. |
| `client/reviewers.tsx` | Reviewer lists and the picker. |
| `client/needs-you.tsx` | The workspace's one Needs you block: the asks (question cards, the brief), then the decision rows (Send repairs, Merge, Resume, Retry, Check). |
| `client/questions.tsx` | The question dialog and answer form. |
| `client/tasks.tsx` | Tasks and their triggers. Repairs are task rows too (Q49): the next-message strip first (Preview, Send now, Open agent while sent), PR-condition rows with their PR chip, the repair task sheet (per-task Auto-send, the message with its line highlighted). Rows come from `shared/task-rows.ts`. |
| `client/spec.tsx` | The spec link chip, row and sheet. The chip sits in the references line (`client/linked.tsx`). |
| `client/linked.tsx`, `shared/linked-display.ts` | Linked items on screen: the references line (Spec and Linked chips), the Linked sheet, the disclosure row, and Home search's index. See [linked-items.md](linked-items.md#ui). |
| `client/brand-icons.ts` | Monochrome brand marks (Simple Icons, CC0) for linked items, passed to the host `Icon` as inline SVG. |
| `client/about.tsx` | Summary at the top of Home's detail pane and the panel. |
| `client/inbox.tsx`, `client/inbox-store.ts`, `client/done-windows.ts` | Needs-you rows, the undo bar and inbox commands, plus the shared inbox poll and Done's per-agent Undo windows (the pill says Done while one is open). |
| `client/brief.tsx` | The brief card in agent timelines. |
| `client/pill.tsx` | The composer pill. |
| `client/chat.tsx` | Compact rows for Follow-up's tool calls, batch cards and Done cards in chats (recognised by `shared/chat.ts`). |
| `client/live.tsx`, `client/workspace-data.ts` | The shared workspace poll (diffed `follow.list`) and the per-workspace view of it. |
| `client/visibility.ts` | Foreground detection; hidden means no polling. |
| `client/display.tsx`, `client/button-visibility.ts` | Settings → Display, and button visibility (unknown is not off). `button-visibility.test.mjs` covers the lifecycle. |
| `client/settings.tsx`, `client/settings-shell.tsx` | The settings screen and its collapsible sections. |
| `client/agents.tsx` | Settings → Agents: the shared job rows with each row's More, and Background jobs (Wait). |
| `client/job-rows.tsx` | The job rows Settings → Agents and setup's Helper agents step share (`JobRows`, `RolePickers`). |
| `client/shipping.tsx` | Settings → Following → Shipping PRs. |
| `client/onboarding.tsx` | Getting started. |
| `client/updates.tsx` | Settings → General's Updates sections, Home's update notice, setup's Updates step ([updates.md](updates.md)). |
| `client/release-notes.tsx` | What's new and the notes list. Home's version marker is `VersionMark` in `client/updates.tsx`. |
| `client/image-viewer.tsx` | The image viewer a notes screenshot opens in (Paseo's SDK has none for plugins): dimmed, fitted to the window, never past the image's CSS width; closes on a click, Esc or the X. Its sizing is `fitImage` in `shared/image-fit.ts`. |
| `shared/notes-scrollbar.ts` | The notes' scrollbar style: always visible while they overflow (macOS hides overlay scrollbars otherwise), scoped to the notes' scroll container. |
| `client/kit.tsx`, `client/motion.tsx`, `shared/motion.ts`, `client/theme.ts`, `client/keys.ts` | The type scale, motion (and the first-render reduced-motion read), theme helpers and query keys. |
| `client/rich-text.tsx`, `shared/links.ts` | The one renderer for agent-written text, and the linkifier behind it. |
| `client/text.tsx`, `client/text-rules.ts` | Follow-up's own `Text` and `Pressable`: text is selectable on web and desktop, except a control's label (a Pressable with a button, link, tab or option role). Surfaces never import react-native's. |
| `client/toasts.tsx`, `client/toast-store.ts`, `client/pending-answers.ts` | The toast host, `runAction` for quick actions, and answers kept until the server has them. |

## Row menu

Right-click a Home row or search result (or long-press it on a phone, or press the menu key or Shift+F10 on a focused
row) for quick moves without opening it. `rowMenu()` in `shared/row-menu.ts` lists only what applies to that row:

1. Triage: Later (the same four choices as the detail pane and the pill, `LATER_CHOICES`), Bring back now on a
   snoozed row (`inbox_act` `unsnooze`; the detail pane offers it too), then Sign off. Later and Sign off show the
   Undo bar. A workspace-only Needs-you row gets the workspace's own Later and Bring back now instead (no Sign off).
2. Answer Q<n> for up to two open questions.
3. Resume follow-up, Send N repairs and Retry repairs, each shown only when it applies.
4. Open chat, and Ask the Overseer about this (it pre-fills the omnibox and doesn't send).
5. Copy branch name, Copy PR link(s), Rename with AI…, Rewrite summary, Make <agent> the main agent, and Stop
   following… (which asks first).

The same menu opens from the workspace panel header's More button (`client/panel-menu.tsx`, the workspace's own
`ws:<id>` row) and from the rows of Follow-up's sidebar view (`client/sidebar-view.tsx`), so there is one menu
everywhere. Rename with AI… opens the rename dialog (`client/rename.tsx`, [ai-roles](ai-roles.md#rename-with-ai)).
The sidebar view's top row is "Filter workspaces" and Home's sort as an icon (invariant 8 on phones: a 44px field
and a 44px icon, nothing else). The filter narrows the list in place with Home search's matcher (`useListFilter`,
`FilterField` in `client/home-chrome.tsx`); it never says "Search" or takes a shortcut, because Paseo's own sidebar
Search opens the Command Center (⌘K). The sort menu there adds "Home uses this order too."
In the sidebar view there is no omnibox, so Ask the Overseer is left out (not shown disabled), and Open and Answer
open the agent's chat.

Rules:

- **Rows only.** The DOM `contextmenu` listener sits on each row's own node, so the browser's menu stays everywhere
  else. `tests/row-menu.test.ts` fails on a `contextmenu` listener anywhere else.
- **Every list has it** (`every-list-row-has-the-row-menu`). `menu` is required on `HomeList` (and the opener on
  its rows), so a new list surface can't ship without it and fall back to the platform's Copy/Paste menu. The test
  checks every `<HomeList>` in `client/` passes the shared `useRowMenu`.
- **Parity.** Each action is a `ROW_ACTIONS` entry that names its agent tool, or why it needs none (open, copy,
  pre-fill). Every pick goes through `runAction` and the RPC its usual button calls. Both are tested.
- **One item layout** (`menu-glyphs-center-on-their-item`). Every menu item, here and in Home's sort menu, renders
  `MenuItemContent` from `client/menu-item.tsx`: the leading glyph's slot is centred on the item (a check beside a
  two-line option, not at its top) and the glyph grows on touch with the text. `tests/menu-glyph.test.ts` fails on a
  menu item that builds its own glyph slot.
- **Layout.** On desktop it's a popover at the pointer, clamped inside the viewport (`placeMenu`). On a phone it's a
  sheet. It has `role=menu`, arrow keys and Home/End to move, Right and Left to open and close Later, Enter to pick,
  and Escape to close. Focus returns to the row.
- **Not here yet.** There's no archive or merge (those stay deliberate), and no manual priority, because
  `set_priorities` only takes ranker scores. The workspace panel's navigator and the sidebar view don't have the menu
  yet.

## Chat rows and Paseo's grouping

Timeline transforms must not break Paseo's grouping. Paseo groups only `tool_call` and thought items, and a transform
can only return plugin items, so a transformed call always leaves the group and renders loose.

- **Classify every agent tool.** Follow-up's tools and Wait's are classified in `TOOL_PRESENTATION`
  (`shared/chat.ts`).
- **Routine bookkeeping returns `undefined`** and stays Paseo's own call.
- **Only a moment the developer must see becomes a row:** `declare_done`'s card, or `ask_question`.
- **A new tool is routine** unless it's such a moment.
- **A repeated `declare_done`** for the same workspace and summary draws one card.
- **Tests and screenshots:** `tests/chat-grouping.test.ts`. `scripts/check-chat-grouping.mjs` renders a synthetic
  mixed turn in an isolated daemon for screenshots; run it through the harness slot.

## Created agent and workspace cards

Paseo's `create_agent` and `create_workspace` tool calls render as a card that opens what they made
(`client/created.tsx`, parsing in `shared/created.ts`). The card replaces the raw call, so Paseo's "N tool calls"
group no longer counts it, the same as the Done card (a transform can only replace an item).

- **Card:** a provider tile with a presence dot (green while working, hollow when closed), the title, the status word
  and a chevron, then "New agent · <model> · <workspace>" or "New workspace · <branch> · <repo>". A Follow-up line
  shows only when there is something to say: the workspace's first open question, up to two PR chips, or its live
  line. An agent's card shows it only when that agent is the workspace's main agent.
- **States:** starting and creating (Follow-up's spinner); working and idle (tappable); closed, a session Paseo ended
  (the idle unload or a plugin reload), reads "Closed · Open chat" with a hollow dot and stays tappable, since the
  developer's tap is the only load and nothing reads, prefetches or previews it; archived (words only, no chevron);
  unknown, not listed or not read yet (words only; the task line reads "Agent unavailable"); failed ("Couldn't start <title>", the error on two lines, in full
  in the accessibility label).
- **Opening:** timeline items get no navigation, so a tap opens Follow-up's Home screen with `open=<agentId>` or
  `openWorkspace=<id>`. `useNextRelay` hands off to the host: the agent's chat, or the workspace with its Follow-up
  panel docked.
- **Live facts:** `follow.created-items`, from the engine's directory snapshot as it stands (`DaemonDirectory.snapshotFor()`: it never waits on the daemon, and nothing is
  woken) and the store.
- **The one exception to snapshot-only: archived agents.** Paseo's `fetch_agents` leaves archived agents out, so after
  the directory's next re-read an archived agent would vanish and its card and task line would read unknown instead of
  "archived". Two things cover it, both in `server/directory.ts`:
  - A memo of archived agents, in memory and bounded (`ARCHIVED_MEMO_MAX`, 500, least recently used out), fed by the
    archive event, by listed rows that carry `archivedAt` and by lookups. It survives re-reads.
    `withArchived` / `snapshotFor` add it back only for the ids a card or task line names.
  - `lookup(ids)`: for an id a card or task line names that the directory lacks, one `fetch_agent`, at most once per
    id for the worker's life (ids Paseo reports gone included), capped at 40 a call. It runs on demand (the
    created-items RPC, the engine's task-agent read), never on a timer, and never waits the caller: the answer shows
    on the next read. `fetch_agent` is metadata only: Paseo projects an unloaded agent from its stored record and
    doesn't load it (`tests/daemon-load.test.ts`; `scripts/check-archived-lookup.mjs` checks the archived agent is
    still unloaded afterwards, on 0.15 and 0.16). Agent states go through `taskAgentStates` and `PRESENCE` (`shared/task-status.ts`), the same
  words and link rule as task lines. Cards in one chat share one request; they poll every 20 s only while a card shows
  an agent that isn't archived and the app is visible. `tests/daemon-load.test.ts` checks that a closed or archived
  agent's card and task line cost no daemon request.
- **Feature detection:** without `addTimelineTransformer` / `addTimelineRenderer` nothing is registered; a call whose
  result has no `agentId` / `workspaceId` keeps Paseo's plain row. Tests: `tests/created-card.test.ts`.

## Shared copy

- `shared/presentation.ts` is the PR status label and tone (`prPresentation`) and the Graphite link.
- `shared/errors.ts` turns RPC errors into the human part.

Tests: `tests/surfaces.test.ts`, `tests/mobile.test.ts`, `tests/presentation.test.ts`, `tests/settings-nav.test.ts`,
`tests/access.test.ts`.
