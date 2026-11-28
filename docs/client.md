# Client: surfaces and files

`index.client.tsx` registers everything with Paseo's plugin client:

- **Screens:** the Home screen (`OVERVIEW`) and the settings screen `projects` (plus legacy screen ids, among them
  the retired larger view's `LARGE_SCREEN`, which now opens the workspace and its view tab).
- **Workspace panels:** `PANEL` (`follow-up`, the right side panel) and `VIEW` (`follow-up-view`, the workspace view
  as a main-area tab). Both draw the workspace view (invariant 135).
- **Header button:** one per workspace.
- **Sidebar item.**
- **Command Center items:** open (the view tab), open in the side panel, spec, Home, Search, Done while you were away, settings, Set up
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
  and desktop, memory on phones) until the client's copy has it, and every surface reads it as answered at once
  through one overlay (`shared/optimistic-answers.ts`, invariant 138 `answering-is-optimistic`); a failed one is open
  again with "Not sent · Retry", the pick, the words and the images.
  `tests/quick-actions.test.ts` fails when a dialog closes in a mutation's `onSuccess`. Left blocking, with the
  reason in the test: Merge and merge-when-ready, which re-check the stack and can ask again.
- **The composer pill is always a popover**, Undo included (Paseo 0.16 draws a chevron on popover pills;
  `tests/pill-popover.test.ts`).

## Files

| File | What it is |
| --- | --- |
| `client/home.tsx` | Home: the list and the detail pane, the Overseer card, setup's Finish setup line. `DisplaySplit` is a ResizableSplit whose width is a Display field (Home's right pane, Catch up's rail). |
| `client/catch-up.tsx` | Catch up ([needs-you.md](needs-you.md#catch-up)): Needs you one card at a time over the pure session in `shared/catch-up.ts`. Each card renders the shared components (QuestionBody, NeedsYouList, BriefCard, the permission block); More context asks through `follow.context-ask` and parks the workstream; answers arrive on Home's feed (`extras.context`). Phones: one card with the moves in thumb reach, swipe to skip or go back. Desktop: the queue rail in a `DisplaySplit` (`catch_up_rail_fraction`) and the keys. `CatchUpButton` is Home's way in. |
| `client/image-attach.tsx` | Pasted images ([Pasted images](#pasted-images)): `useImageAttachments`, `ImageField`, `ImageAttachmentsRow`, `useImagePaste`. The one component every agent-bound field uses. |
| `client/more-context.tsx` | More context for every question surface ([needs-you.md](needs-you.md#more-context)): `MorePanel`, `MoveResult` and `ContextAnswer` (Catch up's), and `QuestionMoreContext`, the quiet link `QuestionBody` draws on an open question outside Catch up. Reads the asks from one store, Home's extras (`setContextSource`, set in `index.client.tsx`). |
| `client/feeds.ts` | `openFeed`, `hasFeeds`: the stores subscribe to the worker's feeds on Paseo 0.16 (resubscribing after a worker restart) and poll on 0.15. See [Feeds](#feeds). |
| `client/shared-read.ts` | `sharedRead`: a read the client's modules make together at mount (the Display document on Paseo 0.15, the usage meters) goes out once; a caller joins the read in flight or, for `freshMs`, reuses its answer (one-read-per-key-at-mount, invariant 142). On Paseo 0.16 the feeds' first events are the documents, so Home's order and the search shortcut read none, and each feed is subscribed once: Home's order follows the Display store's feed (`followDisplayDoc`, `client/display.tsx`). |
| `client/home-list.tsx`, `shared/list-entries.ts` | The one virtualised list, used by Home and the sidebar view; `listEntries` builds what it draws, in order. A desktop row's badges and PR chip sit in `ChipRail`, which yields (shrinks, drops the last chip in `railChips`' red-amber-green-grey order, truncates) before the time column moves (invariant `row-chips-never-cover-the-time`, `tests/row-chips.test.ts`). A row draws again only when what it shows moved: `Row` compares its search hit by value (`sameHit`), the result pick is one stable callback, and `ChipRail` and the time are memoised on the row's `sig`, so a key in the search redraws only rows whose highlight moved (invariant `typing-never-redraws-unchanged-rows`, `tests/search-rows.test.ts`). |
| `client/home-chrome.tsx` | Omnibox (the field takes each key at once; results follow the typed query through `useDeferredValue`, and Enter reads the typed query's own results with `enterItem`), Display menu (`DisplayMenu`) and its filter line, status strip, provider and memory meters. |
| `client/list-keys.ts`, `shared/list-keys.ts` | The keyboard walk through a list's rows, for Home and the sidebar view. See [Keyboard walk](#keyboard-walk). |
| `client/row-menu.tsx`, `client/menu-item.tsx`, `client/row-actions.ts`, `shared/row-menu.ts`, `client/panel-menu.tsx`, `client/rename.tsx` | The row menu: right-click, long-press or the menu key (Shift+F10) on a Home row or search result. See [Row menu](#row-menu). |
| `client/home-view.ts` | Home's derived model: sort choice, priorities, titles for search, limits. |
| `client/home-data.ts` | Paseo's own workspace list, for untracked rows (Quiet) and header buttons; `useHomeModel`, Home's model for every surface that draws it (Home, Catch up, the sidebar view, the sidebar item's badge), built once per store change and shared (`sharedHome`, invariant 141). |
| `client/sidebar-view.tsx`, `client/sidebar-visibility.ts` | Home's list as Paseo's sidebar (on hosts that support it), and its registration. |
| `client/row-badges.tsx`, `shared/row-badges.ts` | Paseo 0.17.1+: Follow-up's badges on Paseo's own sidebar workspace rows (`addWorkspaceRowBadgeItem`). One item, "Follow-up: Done" in the sidebar's Show menu: a green Done where Home shows the workspace as Done, read from the live store (no poll of its own). It replaces the worker's Done label there; older hosts register nothing and keep the label (invariant 113). |
| `client/panel.tsx` | The workspace view (`WorkspaceView`) and its two panels: this workspace only. In more than one column the cards' measured heights and placement live in `Columns`, so a card that changes height (a question picked or closed) redraws the columns and no other card (invariant `a-card-resize-redraws-no-other-card`, `tests/card-resize.test.ts`). |
| `client/fold.tsx` | The one fold (panel-sections-fold): `useFold` (open or closed per device, per section) and `FoldButton` (the header button with its expanded state), used by every panel section (`Card`'s `fold`, Your questions) and settings' `Disclosure`. Section ids are `PANEL_FOLDS` (`shared/settings-nav.ts`). |
| `client/recovery-actions.ts` | The Recovery block's one primary action per state (`recovery-offers-one-primary-action`): Retry recovery after a failure, Run recovery (or Run queued recovery) otherwise, plus Open recovery agent when an agent exists. |
| `client/large.tsx` | The retired larger view's screen id, redirecting to the workspace and its view tab. |
| `client/agent-card.tsx` | The workspace view's agent card: each agent's row, then Recent steps (`RecentSteps`, the peek's `TurnView` rows) and the reply box. |
| `shared/workspace-layout.ts` | The workspace view's tiers from width (`layoutFor`) and its card placement into the shorter column (`placeCards`). |
| `client/hint.tsx` | A section's help behind a ? after its title (`useHint`, `HintIcon`, `HintBubble`). |
| `client/header.tsx` | The stack bar and the header status. |
| `client/stacks.tsx` | Stacks drawn top to base. |
| `client/section-search.tsx`, `shared/section-search.ts` | Section search in the panel's Pull requests and Activity. See [Section search](#section-search). |
| `client/paged-list.tsx`, `shared/paged.ts`, `shared/history.ts` | Every long list in pages, and a workspace's history bounded on the wire. See [Paged lists](#paged-lists). |
| `client/pr-sheet.tsx`, `client/pr-controls.tsx` | One PR's sheet, with merge and reviewer controls. |
| `client/reviewers.tsx` | Reviewer lists and the picker. |
| `client/needs-you.tsx` | The workspace's one Needs you block: the asks (question cards, the brief), then the decision rows (Send repairs, Merge, Resume, Retry, Check). |
| `client/question-context.tsx` | A question's own context, `QuestionContextBlock`: its note, links, PR line, task line and More context. `QuestionBody` draws it, and so does the chat's brief card under each decision that is a tracked question (`decisionQuestion`), so a question reads the same in the chat as on the panel (`one-answer-flow-for-every-question`). |
| `client/questions.tsx` | The question dialog and answer form (`QuestionBody`), the one answer flow every question surface draws; its field's role comes from `answerDraft` (`one-answer-flow-for-every-question`). Send, then Put in chat with Copy as an icon on Paseo 0.16 (Copy keeps its label on 0.15). |
| `client/put-in-chat.ts` | Paseo 0.16's composer controls, feature-detected (`hasComposers`, `useChatComposer`); the insert rule is `shared/put-in-chat.ts`. |
| `client/tasks.tsx` | Agent's tasks (tasks-are-the-agent-s): one folded line ("6 open · 2 due · 1 stale"), opened a row per open task saying what moves it (`shared/task-view.ts`), stale and due first with the agent's note, a row opening in place, and the "Send on a schedule…" sheet (the trigger editor). |
| `client/messages.tsx` | The Messages to the agent card: the send queue's strip (who, how many, when and why; Preview, Send now, Open agent while sent) and the open repairs with their PR chip and sheet (per-task Auto-send, the message with its line highlighted). Rows come from `shared/task-rows.ts`. |
| `client/spec.tsx` | The spec link chip, row and sheet. The chip sits in the references line (`client/linked.tsx`). |
| `client/linked.tsx`, `shared/linked-display.ts` | Linked items on screen: the references line (Spec and Linked chips), the Linked sheet, the disclosure row, and Home search's index. See [linked-items.md](linked-items.md#ui). |
| `client/brand-icons.ts` | Monochrome brand marks (Simple Icons, CC0) for linked items, passed to the host `Icon` as inline SVG. |
| `client/follow-up-icon.ts` | `FOLLOW_UP_ICON`, Follow-up's own mark (a cursive l) as a `currentColor` glyph: the sidebar row, header button, panel tab, Settings, the open command and the larger view's empty state (`follow-up-has-one-mark`). |
| `client/about.tsx` | Summary at the top of Home's detail pane and the panel. |
| `client/inbox.tsx`, `client/inbox-store.ts`, `client/done-windows.ts` | Needs-you rows, the undo bar and inbox commands, plus the shared inbox poll and Done's per-agent Undo windows (the pill says Done while one is open). |
| `client/brief.tsx` | The brief card in agent timelines. |
| `client/card-store.ts` | Per-card picks, Something else words and pick notes, shared by every copy of a card and kept across re-renders. |
| `client/pill.tsx` | The composer pill. |
| `client/chat.tsx` | Compact rows for Follow-up's tool calls, batch cards and Done cards in chats (recognised by `shared/chat.ts`). |
| `client/live.tsx`, `client/workspace-data.ts`, `shared/list.ts` | The shared workspace poll (diffed `follow.list`, list forms only) and the per-workspace full read (`follow.get`). Opening a workspace reads it once: the check it asks for (`follow.refresh`) reaches the view as a list change (one re-read) or as read stamps over the copy it holds (`newerReadStamps`), and new reviewer lists redraw that copy, never a read (invariant `opening-reads-the-workspace-once`, `tests/panel-open-reads.test.ts`). |
| `client/visibility.ts` | Foreground detection; hidden means no polling. |
| `client/display.tsx`, `client/button-visibility.ts` | Settings → Display, and button visibility (unknown is not off). `button-visibility.test.mjs` covers the lifecycle. |
| `client/settings.tsx`, `client/settings-shell.tsx`, `client/settings-screens.ts` | The settings screens (one per category on Paseo 0.16, one with Follow-up's own tabs on 0.15) and their collapsible sections. |
| `client/view-store.ts` | The device settings document `follow-up-view` (Paseo 0.16): view state per device, seeded once from localStorage; `<ViewSync />` mounts it on each surface ([settings.md](settings.md#where-settings-live)). |
| `client/agents.tsx` | Settings → Agents: the shared job rows with each row's More, and Background jobs (Wait). |
| `client/job-rows.tsx` | The job rows Settings → Agents and setup's Helper agents step share (`JobRows`, `RolePickers`). |
| `client/shipping.tsx` | Settings → Following → Shipping PRs. |
| `client/review-mode.tsx` | Per-repository review mode: the Settings Review row (its menu uses `MenuItemContent`), the Needs-you reviewers row's "Let the agent merge in <repo>" link, and the Undo toast both share. See [docs/prs.md](prs.md#review-mode). |
| `client/onboarding.tsx` | Getting started: the steps and their moves. |
| `client/setup-gate.tsx`, `client/setup-dialog.tsx`, `client/setup-ui.ts` | Setup's popup (`setup-is-one-popup`): `SetupGate` on the first surface to mount, Home's `FinishSetupLine`, the dialog/sheet frame with the welcome and done pages, and the session store. |
| `client/updates.tsx` | Settings → General's Updates sections, Home's update notice, setup's Updates step ([updates.md](updates.md)). |
| `client/release-notes.tsx` | What's new and the notes list. Home's version marker is `VersionMark` in `client/updates.tsx`. |
| `client/image-viewer.tsx` | The image viewer a notes screenshot opens in (Paseo's SDK has none for plugins): dimmed, fitted to the window, never past the image's CSS width; closes on a click, Esc or the X. Its sizing is `fitImage` in `shared/image-fit.ts`. |
| `shared/notes-scrollbar.ts` | The notes' scrollbar style: always visible while they overflow (macOS hides overlay scrollbars otherwise), scoped to the notes' scroll container. |
| `client/docked-pane.tsx`, `client/dock.ts` | `DockedPane`: a scrolling pane with a bar docked under it (Home's detail pane, the Overseer's pane, setup, Catch up's card). On a phone, while a field in the pane has focus or the keyboard is up, the dock drops its extras (`dockYields`), the pane stops above a keyboard that overlays the page (`keyboardOverlap`), and the focused field's primary form, the field with its Send marked `PRIMARY_FORM`, scrolls into view (`revealFocused`), again when the keyboard or the dock changes size. Native scrolls the focused input clear of the keyboard with room for its Send. Invariant `a-focused-field-and-its-send-stay-in-view`, `tests/dock-in-view.test.ts`. |
| `client/field.tsx`, `client/keyboard.tsx` | The phone keyboard never covers the field you type in (invariant `the-keyboard-never-covers-a-field`). Paseo moves its own composer and positions fields in its sheets, but its app draws edge to edge, so a plugin's screens and panels get no room from the keyboard on iOS or Android. `Field` is the one text field (the SDK's `TextInput`, so sheets still position it) and reports focus to the nearest `KeyboardRoom`. Every surface (Home and the Overseer, the workspace view in the panel and its tab, every settings screen) and `DockedPane` is a `KeyboardRoom`: it reads the keyboard once for the whole client (`useKeyboard`: native `endCoordinates.screenY`, web the visual viewport), pads its bottom by what the keyboard covers of it (`roomOverlap`, so a host that already moved it leaves nothing), then brings the focused field into view: on the web `revealFocused`, on native `revealPlan` (`client/dock.ts`) scrolls the field's `ScrollView` (this file's, which knows its offset; a docked pane keeps room for Send) and lifts the room by what scrolling can't cover. Guarded by `tests/keyboard-field.test.ts`. |
| `client/split.tsx`, `shared/split.ts`, `client/pane-allowlist.ts` | `ResizableSplit`: a pane beside a flexible side with a draggable divider (11 px hit area, col-resize cursor, hover and drag highlight, a grip), keyboard moves (arrows 2 %, Shift 10 %, Home and End to the ends, Enter or double-click resets) and a separator role; the width updates locally per frame and commits once on release. `shared/split.ts` holds its clamping. Home's list and right pane use it, saving `home_detail_fraction`. Phones keep their stacked layout. Layouts allowed to stay fixed are in `client/pane-allowlist.ts` with a reason (invariant `side-panes-are-resizable`, `tests/side-panes.test.ts`). |
| `client/search-key.ts`, `shared/search-key.ts` | Search from anywhere: one capture-phase `keydown` listener (web and desktop) that opens Home with the cursor in its search, or only moves the cursor when Home is on screen; the key (⌘⇧K / Ctrl+Shift+K by default) is the Display field `search_shortcut`, read at start and from the Display feed. `shared/search-key.ts` holds the presets, the exact-modifier matcher, the labels each platform prints and `PASEO_BOUND`, Paseo's own combos, which no preset may take. The ⌘K "Follow-up: Search" row and Home's search chip name the key (`createSearchKey`). Where the caret lands is `client/search-focus.ts` and `shared/search-focus.ts`: one owner holds a search request until the developer acts (the request's own key, repeating or with a modifier pressed alone, is not an act; characters typed before the caret lands become the query) and gives it to the Home search on screen (AGENTS.md invariant 116, `every-search-request-lands-in-the-visible-search`). Dispatch from anywhere (`new_shortcut`, `createNewKey`) is matched by the same listener ([dispatch.md](dispatch.md#the-dialog)). |
| `client/scroll-allowlist.ts` | The React Native ScrollView/FlatList imports allowed to stay native, each with why it never renders inside a host sheet or popover; every other scroll view is the kit's (invariant `sheet-content-scrolls-with-the-sheet`, `tests/sheet-scroll.test.ts`). |
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
5. Copy branch name, Rename title with AI…, Rewrite summary, Make <agent> the main agent, Stop
   following… (which asks first), and Archive workspace….

Archive workspace… is on any row whose workspace Paseo lists (tracked or not) when the host's Paseo API has
`workspaces.archive`; a row Follow-up calls ready to archive (Home's "N to archive") leads with it, first in triage,
instead. It sends Paseo's own archive request (`archive_workspace_request`, what Paseo's Archive sends), so it does
what Paseo's archive does: every agent in the workspace is archived (a running one stops), its terminals close, it
leaves the list (and shows under Archived in search), and for a worktree Paseo created Paseo runs the teardown and
deletes the folder with `git worktree remove --force`, so uncommitted changes there are lost; the branch and its
commits stay and Paseo can restore it. The confirm step says so for this workspace (`archiveConfirm`), from what
Paseo's workspace list already streams (`ArchiveFacts`: kind, `isPaseoOwnedWorktree`, `isDirty`, `diffStat`,
`aheadOfOrigin`, a running status), never a new git read. Paseo's list streams `isDirty` only once something read the
worktree's status, so while it's unknown (and no diff) the line says uncommitted changes, if any, are lost; it says
the folder is clean only when Paseo says so. An Undo from Paseo's own app cancels the archive: the row stays and the
toast says so. A refusal shows the error toast with Paseo's reason and the
row stays. Agents archive with Paseo's own `archive_workspace` tool (the `ROW_ACTIONS` exemption). Follow-up never
archives by itself (invariants 6 and 87, `tests/archive-on-click.test.ts`).

The same menu opens from the workspace panel header's More button (`client/panel-menu.tsx`, the workspace's own
`ws:<id>` row) and from the rows of Follow-up's sidebar view (`client/sidebar-view.tsx`), so there is one menu
everywhere. Rename title with AI… opens the rename dialog (`client/rename.tsx`, [ai-roles](ai-roles.md#rename-title-with-ai)).
The sidebar view's top row is "Filter workspaces" and Home's Display menu as an icon (invariant 8 on phones: a 44px field
and a 44px icon, nothing else). The filter narrows the list in place with Home search's matcher and rank (`useListFilter`,
`FilterField` in `client/home-chrome.tsx`): inside each group a title match comes first, then linked items, branch
and PR, then the second line and the rest, and a tie keeps the list's order; it never says "Search" or takes a shortcut, because Paseo's own sidebar
Search opens the Command Center (⌘K). The Display menu (`DisplayMenu`, the same one as Home's, Paseo's Settings2 icon
and menu shape) holds Grouping (Status, Project, None), Sort, Title (title or branch name), Show (branch, project, pull
request, labels, last activity), the Project and Labels filters and Show background. It is one Display field,
`home_view` (`shared/home-arrange.ts`), shared with Home; a filter on puts a neutral dot on the icon and one
"Project: acme/app · Clear" line above the list. Paseo's pins (`pinnedAt`) are the Pinned section on top, the Overseer
first; a host without pins draws none (invariant `sidebar-view-is-paseo-s-sidebar-plus-follow-up-s-line`). Its Sort
page ends with one footer line,
`rankFooter` in `shared/ranker.ts`: when the ranking last ran ("Ranked 1h ago"), "Not ranked yet", "Ranking now" before
the first run, or a failed run's short reason. It never shows a run's cost (agents read it from `rank_status`).
In the sidebar view there is no omnibox, so Ask the Overseer is left out (not shown disabled), and Open and Answer
open the agent's chat.
The sidebar view pins Home's Overseer row under the filter, from the same state (`listOverseerRow`,
`shared/overseer.ts`; invariant `every-home-list-pins-the-overseer`). It stacks like the sidebar's other rows: "Overseer"
on the first line, its state line under it on up to two lines, the amber or red edge kept, no chevron on touch
(`HomeList` `stackOverseer`). Selecting it opens the Overseer's chat while it's idle, working or asking; Start and a
failed restart open Follow-up Home with the Overseer selected (`openScreen` with `item: "overseer"` and an `at` token,
which an already-open Home also follows), where those controls live. "Filter workspaces" keeps the row only when the
query is in "Overseer" or its line, and marks the match the way rows mark theirs.

### Keyboard walk

On desktop and web, Home and the sidebar view walk their rows with the same keys, through one hook (`useListKeys`,
`client/list-keys.ts`, called once in `HomeList`; invariant `one-keyboard-walk-for-every-list`). ↑/↓ and j/k step one
row, Home/End jump to the first or last, Enter (or O, Catch up's letter) opens. The order is the list as drawn: the Morning brief, the Overseer,
then every row of an open group (a collapsed group and a closed Quiet fold are skipped; a filter walks only the
matches). The focus moves with the keys, so the row shows the keyboard focus ring (`focusRing`, `client/kit.tsx`;
never after a click) and the browser keeps it in view. On Home the selection follows the keys and the detail pane
with it. Double-clicking a workspace row (including a search result) opens its chat through the same callback as Enter
(`client/row-open.ts`); nested buttons and menus keep their own actions, and touch taps still select. Enter opens the selected workspace's chat (Open full, whose button shows a quiet ↵), however it was
selected: a focused row opens itself, and with nothing focused the selection opens (`enterTarget`, invariant
`the-selected-workspace-opens-with-enter`). In Home's search the first Enter shows the active result in the pane and
Enter again on that result opens it; Esc clears the search, a second Esc leaves it, and Enter then opens the selection
(`searchEnter`). S (or the keyboard button beside settings) shows Home's keys, read from `HOME_KEYS`
(`shared/home-keys.ts`) in Catch up's sheet (`KeysSheet`). In the sidebar view only the focus moves and Enter opens the chat,
since each open loads a chat and moves the main pane. If opening leaves focus nowhere, it goes back to the row so ↓ ↓
Enter keeps walking; if Paseo puts it in the composer, it stays there. The open chat's row wears Paseo's own
selected-item fill (`sidebarSelected`, `client/theme.ts`: Paseo's `surfaceSidebarSelected`, which the plugin theme
doesn't carry), so it reads like a selected native item in both themes. The keys count only while
focus is inside the surface (Home also takes them with nothing focused, but only while it's on screen: a Home kept
mounted behind another tab or chat leaves them to what's in front, `surfaceVisible`) and never while typing, except the arrows in
the sidebar's filter and Home's empty search, which step into the list. Modified keys stay Paseo's: ⌘[ ⌘] and ⌘1…9
(Ctrl, or Alt on the web) walk Paseo's own sidebar, which a plugin view can't feed. Escape and Space are left to Paseo
too. Phones have no hardware-key walk.

Rules:

- **Rows only.** The DOM `contextmenu` listener sits on each row's own node, so the browser's menu stays everywhere
  else. `tests/row-menu.test.ts` fails on a `contextmenu` listener anywhere else.
- **Every list has it** (`every-list-row-has-the-row-menu`). `menu` is required on `HomeList` (and the opener on
  its rows), so a new list surface can't ship without it and fall back to the platform's Copy/Paste menu. The test
  checks every `<HomeList>` in `client/` passes the shared `useRowMenu`.
- **Parity.** Each action is a `ROW_ACTIONS` entry that names its agent tool, or why it needs none (open, copy,
  pre-fill). Every pick goes through `runAction` and the RPC its usual button calls. Both are tested.
- **One item layout** (`menu-glyphs-center-on-their-item`). Every menu item, here and in the Display menu, renders
  `MenuItemContent` from `client/menu-item.tsx`: the leading glyph's slot is centred on the item (a check beside a
  two-line option, not at its top) and the glyph grows on touch with the text. `tests/menu-glyph.test.ts` fails on a
  menu item that builds its own glyph slot.
- **Layout.** On desktop it's a popover at the pointer, clamped inside the viewport (`placeMenu`). On a phone it's a
  sheet. It has `role=menu`, arrow keys and Home/End to move, Right and Left to open and close Later, Enter to pick,
  and Escape to close. Focus returns to the row.
- **Not here yet.** There's no archive or merge (those stay deliberate), and no manual priority, because
  `set_priorities` only takes ranker scores. The workspace panel's navigator and the sidebar view don't have the menu
  yet.

## The workspace view

One `WorkspaceView` (`client/panel.tsx`, invariant 135 `one-workspace-view`) draws a workspace in three places: Home's
detail pane (`place` "home"), the right side panel (`follow-up`, "panel") and a main-area tab (`follow-up-view`,
"tab"). Its layout comes from its own width only (`layoutFor`, `shared/workspace-layout.ts`):

| Width | Layout | Recent steps |
| --- | --- | --- |
| under 560 | one column, dense: the head's moves are icon buttons | 5 |
| 560 to 759 | one column, labelled buttons | 6 |
| 760 to 1399 | two columns, the left at 55%: Needs you's while it has items, else the agent's | 8 |
| 1400 and up | three columns, the left one Needs you's or the agent's as in two | 10 |

The head spans every column; nothing is centred in a max-width box. In one column the order is Shipped, Needs you, the
agent card, Messages to the agent, Your questions, the shipped history, Pull requests, Agent's tasks, Activity, then
Spec, agent and recovery. In more columns the left column (the wide one in two) holds Shipped, the agent card, Messages
and the history; Needs you, Your questions, Pull requests and Agent's tasks take the next. While anything waits on the
developer, Needs you takes the left column under Shipped instead and the agent card, Messages and the history move to
the next, so the decision reads first as it does in one column. Activity and Spec go to the shorter column
(`placeCards`, with 32 px of hysteresis so a card never flips back and forth).

- **The agent card** (`client/agent-card.tsx`): each agent's row (a row selects it, Cmd/Ctrl opens its chat), then
  Recent steps, the peek's `TurnView` rows for the selected agent, and the reply box under them. Recent steps reads
  live while shown and an unloaded agent's saved transcript otherwise (`follow.agent-turn`), never waking it
  (invariant 1). "live" shows only while the agent works.
- **Per place** only two things differ: the head's own controls and the reply box. Home's head carries Back, Open
  (per `open_workspace_on`), Sign off, Sign off & next and Later; the side panel's "Open in a tab"; the tab's "Open
  chat". The side panel never draws the reply box (the chat is beside it) and never marks the agent's timeline as on
  screen; Home's pane and the tab mark it while Recent steps shows, so its status-line peek stays shut. On a phone
  Home's moves and reply box sit in the bottom dock.
- **Permissions** an agent waits on sit at the top of Needs you with Allow and Deny.
- **Amber is Needs you's alone**: stale tasks and Your questions' unread chip are neutral.

## Section hints

A section's help sits behind a small ? after its title (`client/hint.tsx`; `Card`'s `hint`), never as text in its
body. Desktop shows it on hover or focus; touch opens it on a tap and closes it on a tap elsewhere. The bubble draws
under the header, over the section's content, so nothing moves.

## Panel sections fold

Every section of the workspace panel (Needs you, Your questions, Messages to the agent, Pull requests, Agent's tasks,
Activity, Spec, agent and recovery) folds the same way, through one fold (`client/fold.tsx`, invariant
panel-sections-fold):

- **The header is the button**: the icon, title, count and a chevron at the end, with its expanded state for screen
  readers; a click or Enter toggles it (Space never reaches a plugin's button in Paseo's web app, whose window
  listener takes it first). Controls in the header (search, Activity's tabs) sit beside the button
  and show only while the section is open. Only `FoldButton` draws the chevron: one size and color, in a box that
  never shrinks, last in the button, so it always sits at the right just before the section's own controls.
- **Home's pane** draws the same view and folds. It is a screen without Paseo's panel-only client state, so Spec,
  agent and recovery reads agent titles there through `AgentTitleSource` (short ids) instead of `useAgent`, which throws.
- **Folded**, the body unmounts and the header keeps its count, plus a short plain line where it helps: Needs you's
  first ask, the next message ("2 repairs queued"), the PRs ("6 PRs in 2 stacks") when the open count doesn't say it,
  Activity's latest event, the tasks' line (shown open too). No new labels.
- **Remembered per device, per section**, never per workspace: the device document's `follow-up.settings.fold.panel.<id>`
  (`PANEL_FOLDS`), the same store as settings' folds (invariant 22), so it survives reloads. Open by default, except
  Agent's tasks and Spec, agent and recovery, which start folded as before.
- Every place and phones draw the same sections, so they fold the same way. Recent steps (`PANEL_FOLDS.steps`) is open
  by default in Home's pane and the tab and folded in the side panel, which sits beside the chat; the developer's own
  fold wins.
- **Adding a section**: give its card `fold={{ id }}` with a new `PANEL_FOLDS` id, or an exemption with a reason in
  `tests/panel-folds.test.ts`, which fails on any element the panel lays out without one, and on any `Card` without
  a fold that isn't an error or empty state. Exempt today: the Shipped notice and the shipped
  history fold.

## Section search

The panel's Pull requests and Activity cards each have a search icon at the right of their header, shown while the
section is open (`useSectionSearch`, `client/section-search.tsx`). Pressing it turns the header into the shared `QueryField`
("Search pull requests", "Search activity") with focus in it, "n of N" inside the field and ✕ beside
it. Esc or ✕ closes it, and focus returns to the icon. There's no key binding, so Ctrl/Cmd+F stays the browser's find.

- **What each section searches** (`shared/section-search.ts`): Pull requests, the number and title (shown) and the
  branch and failed check names (hidden); Activity, both tabs at once: a timeline entry's line and detail, a question's "Qn · title" and its
  status line. A match only in a hidden field replaces line 2 with "<Key> · excerpt", as on Home's rows.
- **A filter, not a ranking.** `filterItems` (`shared/search.ts`) uses the matcher every workspace search uses
  (invariant 28) and keeps the list's own order. Matched words take the sidebar filter's hit style (`marks`).
- **Agent's tasks has no search**: it is the agent's list, folded to one line, a handful of rows when open.
- **Folds are ignored while a query is typed**: merged PRs, settled stacks and Activity's "Show all" show
  their matches in place, done ones muted as usual, a page at a time ([Paged lists](#paged-lists)). Activity searches on
  the worker (`follow.activity`), across its whole history. The next-message strip, held merges and in-flight lines step
  aside. Activity's tab chips move under the field and count their matches, so a hit in the other tab is never hidden.
- Nothing matches: "No tasks match ‘x’" (or pull requests, activity).
- **View state only.** The query lives in the card, per section, and belongs to the workspace it was typed in:
  another workspace opens with it closed (`queryFor`). Agents read the same lists whole through `workspace_status`
  and `list_prs` (`VIEW_PARITY`, `server/agent-parity.ts`).

## Paged lists

Every list that grows with use draws one page at a time (invariant `pr-scale-lists-batch-not-throw`, "every list
pages"). One component, `client/paged-list.tsx`: `usePagedList` returns the rows to draw and the footer, and
`PagedRows` is the same as an element, for a list inside a condition or a fold. Page math and copy are
`shared/paged.ts` (`PAGE.size` 25 rows a page, `PAGE.preview` 5 folded).

- **Folded**: a list with its own fold shows `preview` rows and "Show all N". **Opened**: one page and the pager:
  Show less on the left, then Previous, "26–50 of 312" (read as "Rows 26 to 50 of 312 …, page 2 of 13", a polite
  live region) and Next. A list without a fold of its own (a card that folds whole, a settings section) pages from
  the first row with no Show all or Show less. The buttons are plain buttons: Tab reaches them, Enter or Space
  presses them; 44 pt tall on phones.
- **Search pages its hits** from the first page, with no fold. A new query, tab or filter (`resetKey`) goes back to
  page 1; `follow` keeps a row's page in view (Catch up's rail follows the card on screen).
- **Data is bounded too.** `follow.get` and `follow.list` carry what is live in full and the newest `HISTORY_KEPT`
  settled questions, batches and PR actions (`boundHistory`, `shared/history.ts`); the Activity card reads its rows a
  page at a time from `follow.activity` (`activityPage`), which searches the whole history on the worker. The panel's
  own copy draws the first page until the worker answers. History lifecycle predicates live in `shared/finished.ts`:
  withdrawn and dismissed questions are finished even without answers or with old task references. Unsent answers
  and delivered answers still used by live tasks remain context; signing off ends an unreferenced answer's lifecycle.
  Completed, cancelled-before-send and superseded batches are history even without a settlement timestamp.
  Task rows, Activity's finished-task events, the panel's history count and task pruning share `finishedTask`.
  An old question opened from Activity draws from the page's copy (`QuestionSheet`'s `fallback`).
- **Every adopter**: Activity (timeline and questions), Agent's tasks, Messages to the agent, Needs you (items and
  question cards), Pull requests (stacks, 10 a page, and each stack's rows), held merges, other agents, Catch up's
  rail, Done while you were away, Settings → Following (projects, workspaces, repositories, PR statistics),
  Reviewers (repositories, the default's chips), New work (rules, learned teams, bases), Compass's sources and
  servers, the queue screen and Nobody's on it, What's new (5 versions a page; a preview's bullets), PR stats
  (people, a person's PRs and reviews) and onboarding's workspaces. Linked items stay whole: the store keeps at most
  50. `tests/paged-lists.test.ts` fails on a "Show all" or "Show N more" that draws every row anywhere else.

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

## Feeds

An idle open client makes at most one RPC a minute (invariant `idle-client-makes-at-most-one-rpc-a-minute`,
`tests/idle-rpc.test.ts`). The shared stores (the live list in `client/live.tsx`, Needs you in `client/inbox-store.ts`,
Home's extras in `client/home-view.ts`, the Display preferences in `client/display.tsx`) subscribe to the worker's feeds
through `openFeed` ([rpcs-and-tools](rpcs-and-tools.md#subscriptions-paseo-016)). When the host has no
`client.subscribe` (Paseo 0.15) the store polls its RPC as before. `openFeed` keeps each feed open: when the worker
restarts (a plugin reload or a crash closes every subscription) or refuses a topic (an older worker during a rolling
reload), the store reads at once, polls until the feed is back, and subscribes again every second for 15 tries, then
backing off to 30 s. A resubscribe's events apply as soon as it is acknowledged, and once it has stayed open for 30 s
(`FEED_STEADY_MS`) the poll stops and the retry count starts over. So a host that accepts each subscription and drops
it at once costs what a refusing one does (the store's own poll, retries every 30 s), not a read a second. A websocket reconnect is the host's: it replays open subscriptions. `tests/feed-recovery.test.ts` and
`npm run test:feeds` (the harness, end to end) prove a push lands, and that a restart or a refused feed recovers. A store's `refresh()`
after an action is a no-op with a feed, since the worker pushes the change. The live store keeps each workspace's read stamps (`reads`, invariant 140) apart from its entries and fills them into each entry it holds, so an entry the feed sends bare still says when its PRs were read, and a stamps-only push makes a new object only for the workspaces whose stamps moved. Opening reads only what a feed leaves
out: the Home order once (it migrates this device's old choice) and `follow.usage` once (the worker's resources).
Browser status (`follow.browser-status`) is read on open only, never polled: when the pill's popover opens, when the
panel opens and again when its PR sheet opens, and when Home's or a brief's PR sheet opens. Each read is fresh
(`staleTime: 0`, `refetchOnMount: "always"`), so it is never older than the surface's last open. Screen-scoped polls stay as they are, since they run only while their screen or card is open: the settings screens,
an open brief card, the PR controls and Summary's pending back-off. A created-agent card follows Paseo's own agent
stream on 0.16 (`watchAgent` in `client/home-view.ts`) and polls `follow.created-items` every 20 s on 0.15. Clock
ticks (ages, the pill's 60 s re-render) make no RPC.

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
- **Reading the result:** through `toolResult` (`shared/tool-result.ts`), like every tool result Follow-up reads.
  Paseo never hands the bare JSON: Claude's result is `{ output: <parsed JSON> }`, Codex's is the MCP envelope whose
  text has Paseo's `<key>_count=` summary in front of the JSON (the object is in `structuredContent`). Tests run every
  reader over the real shapes in `tests/fixtures/paseo-tool-results.ts` (`tests/tool-result.test.ts`).


## Pasted images

Every field whose words reach an agent takes pasted images through one component, `client/image-attach.tsx`
(invariant 97, `every-agent-field-takes-images`): Dispatch's task field and its note, the Overseer's reply box (Home's pane),
Home's search when it asks the Overseer, an agent's reply box in Home's detail pane, More context's ask (`MorePanel`),
a question's answer or note (`QuestionBody`), the brief card's answer and note, and Catch up's note to the card's
agent. Catch up's question and More context fields are `QuestionBody` and `MorePanel` themselves.

- **Desktop web**: a paste into the field (image items of the clipboard; a paste that is only images types no file name)
  or a drop on it adds images. The field takes a dashed accent outline while a file is dragged over it. Each image shows
  as a small thumbnail under the field with a remove ×; hovering a thumbnail names it and its size, and a click shows it
  larger in the release notes' viewer (`client/image-viewer.tsx`) so the right screenshot is checked before Send. A
  reply box (an agent's, the Overseer's) draws its thumbnails inside the composer, above the words.
- **Add image** (`AttachImageButton`): every field that takes images has one, from the same component. It opens the
  system file picker for the caps' types, several at once, the way Paseo's composer does on web (a hidden file input;
  Paseo's desktop app opens its system dialog for it). A one-line field or a reply box draws it among its own controls
  (`ImageField` `attach="inline"`: before Dispatch's ⌘V, beside a reply box's Send, at the end of Home's search while it
  asks the Overseer, named "Add image for the Overseer"); every other field gets a quiet "Add image" line under it and
  its thumbnails. At the cap a press opens nothing and says why on the field's line, as a refused paste does. No
  picker, no button: the phone app draws none (`PICKER_ON`).
- **Caps** (`shared/images.ts`): PNG, JPEG, GIF and WebP; 6 per message, 5 MB each (Claude's API limit), 20 MB in all.
  A paste past a cap is refused at once with the reason under the field ("6 images is the most one message takes.",
  "That image is 7.2 MB; the most is 5 MB." then "Nothing was added."), and nothing is added.
- **Before Send**: when the first image is added, the field asks `follow.image-support` once for its recipient (cached
  per recipient for the session). A recipient that can't take images says so on the field ("Acme Agent can't take
  images; remove them to send.") and Send waits until they are removed. Never after Send.
- **Home's search** stays one line: a paste or drop on it while the Overseer is on adds images, drawn on their own line
  under the search row with "Sent with your ask to the Overseer."
- **Dispatch** keeps one set for the task field and the note; the thumbnails sit under the task field on desktop, and under
  the note on a phone-width web window, where the note's screen is the one showing.
  The source card ("Your words · 2 images") and the phone bar's line count them, so what goes is on screen before the click.
- **A failed send keeps them** (`client/unsent-images.ts`): a field that sends puts its images (and a reply box its
  words) under its key before the call, and only a confirmed send takes them out. The model (`useImageAttachments`
  `keep`) starts with what is kept, so a reply box or Home's search opened again after a failure shows them, and a
  question's Retry (pending-answers, `answerImagesKey`) sends them again. Memory only, since images don't fit in
  localStorage: after a reload the unsent answer says how many images weren't kept. The brief card has one image set
  for its answer and note fields and draws its thumbnails under the last open one.
- **Phones (the native app)**: the plugin client has no image picker for plugin fields (`@getpaseo/plugin/client`'s
  attachment sources serve Paseo's own composer), so nothing is drawn and no space is kept.
- `tests/every-agent-field-takes-images.test.ts` classifies every TextInput in `client/`: agent-bound fields must be
  inside `ImageField`, every other field is listed with why its words never reach an agent.

## Shared copy

- `shared/presentation.ts` is the PR status label and tone (`prPresentation`) and the Graphite link.
- `shared/errors.ts` turns RPC errors into the human part.

Tests: `tests/surfaces.test.ts`, `tests/mobile.test.ts`, `tests/presentation.test.ts`, `tests/settings-nav.test.ts`,
`tests/access.test.ts`.

Paseo shortcut compatibility: `shared/paseo-keys.ts` extracts bundle combos and expands Mod for both platforms.
`scripts/check-paseo-keys.ts` (`npm run check:paseo-keys`) manually packs the latest and beta server releases,
checks every search preset and modified Catch up/Home key, and lists collisions and additions to `PASEO_BOUND`.
Run it when Paseo ships, then review and refresh the snapshot union in `shared/search-key.ts`. A missing or
unreadable bundle fails the check rather than claiming compatibility. There is no schedule or CI network check.
Home’s search chip sets its hover title on its DOM node because React Native Web drops the Text title prop.

## Agent peek

Invariant 137 (`a-peek-is-bounded-and-never-wakes`). Resting the pointer on an agent's line for 350 ms, or focusing it,
shows that agent's current turn beside it: the panel's agent lines (under the line), Home's desktop rows and the
larger view (beside the row). On a phone, a tap on a panel line opens the same turn in a sheet with one Open chat
button. A click still opens the chat.

- **One fold, one component.** `shared/turn.ts` `foldTurn` turns timeline or transcript items into the chat's rows
  (your message, a run of steps folded like Chat Polish's merged row, the reply, tasks, notices, errors), bounded to
  `TURN_ROWS` rows; `fitTurn` cuts it further for narrow surfaces. `client/turn-view.tsx` `TurnView` draws only the
  rows, so the peek and the workspace view's Recent steps share them; `useTurn` reads it (live when loaded, the saved
  transcript through `follow.agent-turn` when not) and `turnSource` writes "Saved transcript · last active 3h ago".
- **Timeline already on screen.** `shared/peek.ts` `timelineOnScreen` is the one predicate: an agent marked by a
  surface (`useMarkTimelineOnScreen` in `client/on-screen.tsx`: Home's detail pane for its selected row, the
  workspace view for its selected agent) or the chat beside the caller. Such a line has no peek.
- **Timing.** `peekStep` is a pure state machine: 350 ms intent to open (a line crossed on the way to the open peek only
  arms a takeover, which needs the same rest), 150 ms grace to close, and a peek showing a permission stays once the
  pointer entered it. Esc, a click outside or a scroll that moves the line closes it. From a focused line, → (or
  Alt+↓) moves focus into its open peek; Esc there closes it and returns focus to the line. Timers use
  `performance.now()`: wall time can jump, and the screenshot harness freezes `Date`.
- **Where it draws.** `PeekHost` draws it with `FloatingSurface`'s nonmodal mode inside the host's own box, not the
  modal portal: React Native Web's Modal traps focus (it focuses itself on open and pulls outside focus back), which a
  hover-opened peek must never do. So the panel's peek opens under the line (wholly above it when it doesn't fit
  below), within the panel; beside-the-row falls back to that when the row leaves no 440 px beside it.
- **Live data.** A loaded agent's timeline is read client-direct (tail 60, re-read at most every 400 ms on its
  updates; on Paseo 0.15, with no timeline subscription, re-read every 2 s while open). One subscription per open
  peek, closed with it.


Invariant 134 (`menus-stay-visible`): `client/floating-surface.tsx` is the shared overlay for row menus (including
panel More), sort, repository review choices, Catch up's keys, Later and More context. `shared/floating.ts` places
it in viewport coordinates, flips at edges, shifts it inside the visual viewport (including keyboard/zoom offsets),
and limits its width and scrollable height. An offscreen anchor still produces an onscreen menu.

The old row overlay measured a fixed containing block, not the visible sidebar slot. The installed host renders
its footer after `SidebarViewSlot` as a sibling; Vitals contributes a normal footer row with no elevated z-index.
A transformed ancestor changes
that containing block, and the host sidebar can clip its descendants and paint its footer above them. A local z-index
cannot escape either boundary. The shared React Native Modal portals to the document body on web, retaining plugin
context and drawing above host chrome on sidebar, panel, Home and main tabs. The probe remains with the opener and
is remeasured on window/visual viewport resize, opener resize and captured scroll; listeners and observers exist only while open.
Each popup links to its opener probe (`floatingScopes`), so Catch up keeps its scoped More context shortcuts across
the portal without claiming another surface's popup. A hidden opener closes its popup. Native uses the same Modal
and its own scroller, outside a host sheet's gesture context. Host-owned modals/popovers
and inline sheet bodies keep the host's positioning. Use this shared component for future custom popovers.

The workspace view's tab (`follow-up-view`) receives the same `HomeSources` as the side panel, so its existing shared
More menu is available and uses the same bounded portal on the main tab.

Web Escape is handled on keydown. React Native Web's modal keyup callback is disabled so the same Escape cannot
back out of a row confirmation and then close its restored menu. Native hardware Back still closes the modal.

Keys help uses `modal={false}`: it stays a nonmodal ARIA dialog so Home's keyboard walk keeps working. Without a
public context-preserving nonmodal portal, it is clamped to the intersection of its pane and the visual viewport
and scrolls there, instead of drawing into host chrome. Action menus and popovers retain the modal portal.
