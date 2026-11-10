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
- Use the motion helpers in `client/motion.tsx`.
- Follow [DESIGN.md](../DESIGN.md) and [PRODUCT.md](../PRODUCT.md) (voice).
- Every UI change goes through `/impeccable critique`, and you render each state yourself: desktop and 390×844,
  light and dark.
- `npm run preview` starts an isolated daemon with the packed plugin ([testing.md](testing.md)).
- User copy says "Summary" for the `about` feature.

## Files

| File | What it is |
| --- | --- |
| `client/home.tsx` | Home: the list and the detail pane, the Overseer card, the setup flow's place. |
| `client/home-list.tsx` | The one virtualised list, used by Home and the sidebar view. |
| `client/home-chrome.tsx` | Omnibox, sort menu, status strip, provider and memory meters. |
| `client/row-menu.tsx`, `client/row-actions.ts`, `shared/row-menu.ts` | The row menu: right-click, long-press or the menu key (Shift+F10) on a Home row or search result. See [Row menu](#row-menu). |
| `client/actions.ts` | `runAction`: a quick action closes its control at once and reports as a toast. A stand-in until the shared one lands. |
| `client/home-view.ts` | Home's derived model: sort choice, priorities, titles for search, limits. |
| `client/home-data.ts` | Paseo's own workspace list, for untracked rows (Quiet) and header buttons. |
| `client/sidebar-view.tsx`, `client/sidebar-visibility.ts` | Home's list as Paseo's sidebar (on hosts that support it), and its registration. |
| `client/panel.tsx` | The workspace panel: this workspace only. |
| `client/large.tsx` | The panel as a two-column screen. |
| `client/header.tsx` | The stack bar and the header status. |
| `client/stacks.tsx` | Stacks drawn top to base. |
| `client/pr-sheet.tsx`, `client/pr-controls.tsx` | One PR's sheet, with merge and reviewer controls. |
| `client/reviewers.tsx` | Reviewer lists and the picker. |
| `client/needs-you.tsx` | The workspace's decision queue (Send repairs, Merge, Resume, Retry, Answer). |
| `client/questions.tsx` | The question dialog and answer form. |
| `client/tasks.tsx` | Tasks and their triggers. |
| `client/spec.tsx` | The spec link chip and row. |
| `client/about.tsx` | Summary at the top of Home's detail pane and the panel. |
| `client/inbox.tsx`, `client/inbox-store.ts` | Needs-you rows, the undo bar and inbox commands, plus the shared inbox poll. |
| `client/brief.tsx` | The brief card in agent timelines. |
| `client/pill.tsx` | The composer pill. |
| `client/chat.tsx` | Compact rows for Follow-up's tool calls, batch cards and Done cards in chats (recognised by `shared/chat.ts`). |
| `client/live.tsx`, `client/workspace-data.ts` | The shared workspace poll (diffed `follow.list`) and the per-workspace view of it. |
| `client/visibility.ts` | Foreground detection; hidden means no polling. |
| `client/display.tsx`, `client/button-visibility.ts` | Settings → Display, and button visibility (unknown is not off). `button-visibility.test.mjs` covers the lifecycle. |
| `client/settings.tsx`, `client/settings-shell.tsx` | The settings screen and its collapsible sections. |
| `client/agents.tsx` | Settings → Agents, including Background jobs (Wait). |
| `client/shipping.tsx` | Settings → Following → Shipping PRs. |
| `client/onboarding.tsx` | Getting started. |
| `client/updates.tsx` | Settings → General's Updates sections, Home's update notice, setup's Updates step ([updates.md](updates.md)). |
| `client/release-notes.tsx` | What's new, the notes list, Home's version line. |
| `client/kit.tsx`, `client/motion.tsx`, `client/theme.ts`, `client/keys.ts` | The type scale, motion, theme helpers and query keys. |

## Row menu

Right-click a Home row or search result (or long-press it on a phone, or press the menu key or Shift+F10 on a focused
row) for quick moves without opening it. `rowMenu()` in `shared/row-menu.ts` lists only what applies to that row:

1. Triage: Later (the same four choices as the detail pane and the pill, `LATER_CHOICES`), then Sign off.
2. Answer Q<n> for up to two open questions.
3. Resume follow-up, Send N repairs and Retry repairs, each shown only when it applies.
4. Open chat, and Ask the Overseer about this (it pre-fills the omnibox and doesn't send).
5. Copy branch name, Copy PR link(s), Rewrite Summary, Make <agent> the main agent, and Stop following… (which asks
   first).

Rules:

- **Rows only.** The DOM `contextmenu` listener sits on each row's own node, so the browser's menu stays everywhere
  else. `tests/row-menu.test.ts` fails on a `contextmenu` listener anywhere else.
- **Parity.** Each action is a `ROW_ACTIONS` entry that names its agent tool, or why it needs none (open, copy,
  pre-fill). Every pick goes through `runAction` and the RPC its usual button calls. Both are tested.
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

## Shared copy

- `shared/presentation.ts` is the PR status label and tone (`prPresentation`) and the Graphite link.
- `shared/errors.ts` turns RPC errors into the human part.

Tests: `tests/surfaces.test.ts`, `tests/mobile.test.ts`, `tests/presentation.test.ts`, `tests/settings-nav.test.ts`,
`tests/access.test.ts`.
