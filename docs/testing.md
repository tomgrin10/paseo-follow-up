# Testing

## Before every PR

| Command | What it runs |
| --- | --- |
| `npm run verify` | `typecheck`, `check:notes` (release-note fragments), `npm test` (every `tests/*.test.ts` through tsx), `button-visibility.test.mjs`, `test:scale`, `test:native`, `test:trust`. PR CI (`.github/workflows/ci.yml`) runs it with Paseo 0.15.2. |
| `npm run test:install` | `scripts/check-install.mjs` (packs the plugin and installs it into an isolated daemon with fixture providers: activation, recovery, ownership, hooks, tasks, Session Guard coordination, project defaults), then `scripts/check-wait.mjs` ([wait.md](wait.md)), then `scripts/check-archived-lookup.mjs`. PR CI doesn't run it. The publish workflow runs it with Paseo 0.15.2 and no model credentials. |
| `npm pack --dry-run` | Checks the package contents: runtime entries, generated sources, `server/wait-runner.sh`, screenshots, and no state, logs or credentials. |

Write the failing test first. Bugs get a root cause, a failing test, a fix for the whole class, and an invariant,
not a patch for one instance.

## Unit tests (`tests/`)

- **Shared code.** Most logic is pure and lives in `shared/`, so tests target it directly.
- **Fixtures.** `tests/fixtures.ts` builds workspaces, PRs, snapshots and a clock.
- **A clean environment.** `npm test` preloads `tests/hermetic-env.mjs`, which clears the Follow-up and Paseo session
  variables (`FOLLOW_UP_*`, `PASEO_AGENT_ID`, `PASEO_HOME`…). A run from inside a live agent session then
  matches CI.
- **Tests that guard a whole class of bug:**
  - `tests/never-wake.test.ts` and `tests/daemon-load.test.ts`: no wake-ups, bounded reads.
  - `tests/status-invariants.test.ts`: every invariant in `shared/status-invariants.ts` holds over a grid and the
    bug fixtures.
  - `tests/agent-parity.test.ts`: every client RPC has a tool or an exemption.
  - `tests/answer-delivery.test.ts`: a copied or in-chat answer stays in Needs you until the agent's turn shows its
    marker, Send delivers it, or Sign off settles it; `tests/put-in-chat.test.ts` drives a fake composer (empty draft,
    typing during focus, repeat press, focus refused falls back to Copy); `tests/brief-card.test.ts`: no "No ask
    stated" card beside a Needs-you item; `tests/answer-status.test.ts`: every delivery state times every surface (chat
    card, dialog, Needs you, Home row, Activity) reads the same, and "Answered" only once delivered.
  - `tests/idle-rpc.test.ts`: the real client stores, bundled with React Native stubbed, run ten simulated minutes against
    a fake host: at most one RPC a minute with `client.subscribe` (0.16), and still polling without it (0.15).
  - `tests/feeds.test.ts`: the worker's feeds read once per change, push only changes, and watch Smart Session only
    while subscribed.
  - `tests/feed-recovery.test.ts`: the same stores (`tests/client-stores.ts` bundles them and fakes the host) stay
    correct on their feeds: a push lands with no RPC, a worker restart makes them poll and resubscribe within 5 s of
    its return, a feed the worker refuses polls only that store, and a host that accepts each subscription and drops
    it at once costs no more reads than one that refuses.
  - `tests/rpc-ack.test.ts`: every client RPC replies within 500 ms with Paseo, the daemon and gh hanging
    (`tests/support/hanging-host.ts` runs the real `contribute()` in a temp home), or has an `EXEMPT` reason. An
    exemption is stale only when the method replies in time with no slow wait giving up meanwhile
    (`tests/support/ack-ratchet.ts`; `tests/ack-ratchet.test.ts` reproduces the shared-wait flake the clock alone misread).
    The black hole drains incoming bytes without answering so socket closure records a give-up; `tests/hanging-host.test.ts`
    reproduces a peer disconnect hidden by an unread handshake. Otherwise a connect timeout inside the 500 ms window
    can look like a fast reply locally while the same timeout just outside the window passes on CI.
  - `tests/rpc-cached.test.ts`: the polled reads (Needs you's list, usage, the Summary) answer from what the worker
    holds while their slow side hangs, and the slow-RPC log fires at the ack budget.
    `tests/answer-ack.test.ts` covers the answer paths: the reply resolves before a gated send completes, one send per answer, retries, resume after reload.
    Retry delays and attempt deadlines run on injected `Timers` (`server/delivery.ts`); these tests pass
    `tests/support/fake-timers.ts`, fire timers in order with `await timers.fire()` and settle with `idle()`, and never
    sleep: a test that waits on the wall clock for a retry fails under CI load (2026-11-11, beta.67's publish run).
    An invariant in `answer-ack.test.ts` rejects `setTimeout`/sleeps in both files. A stopped `Inbox` writes nothing.
  - `tests/docs.test.ts`: every RPC, tool and source file is documented, and the docs reference no missing paths
    or npm scripts.
  - `tests/mcp-usage.test.ts` and `tests/mcp.test.ts`: tool schemas, the tool count, and both transports.
  - `tests/native-tools.test.ts` and `tests/hook-native.test.ts`: native attach and the hook's tool names.

## Integration scripts (isolated daemons)

| Script | npm | What it checks |
| --- | --- | --- |
| `scripts/scale-check.mjs` | `test:scale`, `test:scale:live` | No dormant agent wakes at 140 workspaces; RSS (peak from worker start, not only idle), CPU and idle request budgets. `--realistic` seeds a live-shaped state (`scripts/scale-seed.ts`: three PRs with full snapshots, tasks, batches and questions per workspace, ~1.7 MB at 140), two agents per workspace and a fake GitHub with live-sized PR bodies (`scripts/scale-github.mjs`). `--json` reports the worker's RSS steps over 10 MB from its start, heap peaks and idle CPU. `test:scale:live` adds `--live-sized` (one 153-PR workspace and a live-shaped inbox), a 180 s `--busy` window and `--budgets-report-only` (budget verdicts print as `[report]` lines until its derived budgets land); `--json`'s `trace.memory` splits each 5 s sample into heap, external, native, anonymous and file-backed MB. Verdicts live in `scripts/scale-budget.mjs` (typed by `scripts/scale-budget.d.mts`, tested by `tests/scale-budget.test.ts`): the idle budget judges the idle window's median RSS (the peak is reported), and the send phase must settle within its schedule from the worker's constants (2 rounds × (PR read + settle) + a last read) plus a 60 s margin, timed from when the worker loads the seed; `--json` carries the settle polls and each send's timing. `--cpu-prof <dir>` and `--heap-snapshot <dir>` profile every node process the daemon starts. Skips without the paseo CLI, except in CI. The seed is live-SIZED (2026-11-13 live: one workspace tracks 153 PRs, 150 merged; 86 inbox entries, ~40 flagged, ~48 briefs, a full 200-key seenKeys ring): workspace 0 carries `BIG_PRS` PRs in ~129 stacks with 39 tasks, `BIG_QUESTIONS` (300) questions and `BIG_BATCHES` (400) sent batches, and `inbox.json` is seeded too. On that seed the check reads the big workspace's panel (`follow.get`, `follow.activity` pages and a search) and fails when a reply outgrows `PAGED_REPLY_BUDGET_BYTES` (`pagedReplyVerdict`, every-list-pages), even with `--budgets-report-only`; `--json` reports `worker.pagedReplies`. `--busy <s>` (test:scale: 180) runs live's busy load before the idle window: the awake agents end `BUSY_TURNS_PER_MIN` turns a minute, each with `BUSY_TURN_ITEMS` timeline items of `BUSY_ITEM_BYTES`, and the window is judged on growth (`busyVerdict`: last fifth's median over the first fifth's, against `BUSY_GROWTH_BUDGET_MB`); the idle window after it judges the median it settles at. Between them the check drains the busy window (`drainState`: no awake agent running, no worker timeline read for `DRAIN_QUIET_MS` (a tick plus 5 s) and the directory re-read the busy window made due already done, bounded by `DRAIN_BOUND_MS`; `--json` reports `worker.drain`), so the idle request rate doesn't count the busy window's tail (2026-11-14: CI's idle rate scattered 5.3–8.7 a minute run to run). Without `--busy` it drains the send phase instead (`drainPlan`: no agent running and no timeline read or directory re-read for `SEND_DRAIN_QUIET_MS`, a dirty re-read's whole wait), so a late send's turn doesn't land in the idle window either. An idle-only check passed the 2026-11-13 bug (RSS stepped 315 → 405 MB under agent turns). `--cycles <n>,<burst s>,<gap s>` (test:scale:live: `2,120,180`) runs bursts and gaps after the drain: awake agents end turns at twice the busy rate, an open app reads 4 RPCs a second (`follow.list` with its revision), the fake gh moves PR heads, checks and review threads each burst (`SCALE_GH_EPOCH`), and one agent asks (a permission prompt answered in the gap); `--json`'s `worker.cycles` reports each burst's peak, each gap's median and the worker's CPU seconds per burst and gap. The last gap's median must be at most `BURST_RETURN_BUDGET_MB` (`burstReturnVerdict`, memory-returns-after-a-burst), enforced even with `--budgets-report-only`. |
| `scripts/scale-data-from.mjs` | `scale-check --data-from <dir>` (local only) | Starts the harness worker on a COPY of a real `plugin-data/follow-up` directory, remapped onto the harness's workspaces and agents (workspace i → harness workspace i, its agents → that workspace's main and helper agents; every copied JSON file goes through the same id map), with the fake GitHub answering each PR in the state the copy saw (`SCALE_GH_STATES`). It reproduces a live install's memory at its exact size. The copy holds real names: keep it in a scratch directory, never in the repo, CI, a PR or a screenshot. Pair it with `--live-mix <turns/min>,<rpcs/min>` (live-like load in the idle window), `--app-burst <rpcs/s>,<seconds>` (an open app's reads; reports each method's reply size and the RSS step), `--gh-gzip` (gzip'd GitHub answers, as api.github.com sends) and `--alloc-prof` (`FOLLOW_UP_ALLOC_PROF_WINDOWS="60,300,600"` sets the profile windows). |
| `scripts/cpu-top.mjs` | manual | Where a `.cpuprofile`'s time went (self and app-frame inclusive), optionally in a time window: `node scripts/cpu-top.mjs <file> --from 0 --to 8`. |
| `scripts/alloc-prof.cjs`, `scripts/alloc-top.mjs` | `scale-check --alloc-prof <dir>` | What each process allocates, garbage included (V8's sampling heap profiler with collected objects; `--heap-prof` shows only what stays live), for 0–60 s, 60–180 s and 180–300 s of its life (`FOLLOW_UP_ALLOC_PROF_WINDOWS` sets other window ends); `alloc-top` lists bytes per function, self and inclusive. |
| `scripts/scale-retain.cjs` | `scale-check --retain-mb <n>` | A synthetic regression: each plugin process holds n MB from its start (half V8 heap, half native), to prove the scale gate still catches growth. 2026-11-23: 20 MB read 321/325 peak and 236/241 idle on CI, over both budgets. |
| `scripts/request-top.mjs` | `scale-check --request-trace <file>` | Every daemon call the worker makes (`server/request-trace.ts`, on only when `FOLLOW_UP_REQUEST_TRACE` is set), with the first frames of the worker code that made it, one JSON line each; `request-top` prints calls a minute by method and caller for one pid and window (`worker.idleWindow` bounds the idle window), so an idle request budget's miss names the code that sent it. |
| `scripts/heap-retainers.mjs` | manual | Retained sizes in a heap snapshot (dominator tree) with a retaining path for each big owner. |
| `scripts/check-native-tools.mjs` | `test:native` | Tools are served through Paseo's MCP with no per-agent process. A reload detaches them, the bridge still works, and they come back. |
| `scripts/check-any-provider.mjs` | manual (through `harness-slot`, `HARNESS_PASEO=system` on 0.17) | An agent on a provider that is neither Claude nor Codex (`an-agent-on-any-provider-gets-follow-up`): `scripts/fake-acp-agent.mjs`, a fake ACP agent registered through Paseo's generic ACP config (`harnessConfig({ providers })`, no model, no network), records what Paseo hands it at session/new and calls `follow_workspace_status` through the MCP server it got; then Settings → Agents, desktop and 390×844, light and dark (`noHooksLine`, the helpers' fallback pick, no horizontal overflow). Writes PNGs and `report.json` to `docs/evidence/any-provider/`. |
| `scripts/check-trust-bypass.mjs` | `test:trust` | Trust bypass on a real daemon. |
| `scripts/check-install.mjs` | `test:install`, `preview` | The packed install. `--keep` (`npm run preview`) leaves the daemon running for screenshots, prints "Isolated browser app: http://127.0.0.1:<port>", and writes `.preview-isolated.json`. |
| `scripts/check-archived-lookup.mjs` | `test:install` | An archived agent a chat card names reads "archived" through the directory's one-off `fetch_agent` lookup, and stays unloaded. Run it on 0.16 too (`HARNESS_PASEO=0.16`). |
| `scripts/screenshots.mjs --only feeds` | `test:feeds` | Feeds end to end in the harness (run it through `harness-slot`, with `HARNESS_PASEO=0.16` or `0.15.4`): Home, a panel and a collapsed pill open; a new flag, a sort set by an agent and a priorities write must show within 5 s, and a usage file write within `USAGE_WATCH_DEBOUNCE_MS` plus 2 s (7 s), with no poll RPC between, then again after a plugin reload, a killed worker and a daemon restart, with no page reload. On 0.15 it records the poll delays (75 s budget) and skips the usage cases (0.15 reads usage through a cache timed on the worker's clock, which the harness crawls). Writes `feeds.json`. |
| `scripts/screenshots.mjs --only split` | — | Home's divider (`side-panes-are-resizable`) in the harness, through `harness-slot`: renders idle, hover, mid-drag, focus, min and max, and checks a real mouse drag (down, moves, up) widens the pane by what it moved, saves its share once, survives a reload, moves with the arrow keys, resets with Enter, follows an agent's `set_display`, keeps the list's minimum on a narrow window and draws no handle on a phone. Writes `split.json`; a failed check fails the run. |
| `scripts/screenshots.mjs --only paste-images` | — | Pasted images (`every-agent-field-takes-images`) in the harness, through `harness-slot`: Dispatch with two pasted images, the Overseer's reply box with one, a question's own answer with one, and seven at once refused with the reason, desktop and 390×844, light and dark. Each paste is a real ClipboardEvent carrying fake app screenshots drawn on a canvas in the page. The fixture provider counts as taking images there (`FOLLOW_UP_HARNESS_IMAGE_PROVIDERS`, honoured only under the temp dir, like `FOLLOW_UP_QUEUE_TIME_SCALE`). Writes `paste-images.json` (thumbnail counts, no horizontal overflow); a failed check fails the run. |
| `scripts/screenshots.mjs --only attach-images` | — | The Add image button (`every-agent-field-takes-images`) through `harness-slot`, desktop light and 390×844 dark: Dispatch's task field, a question's own answer with a real pick through the browser's file chooser (Playwright answers it with a canvas-drawn screenshot), and the Overseer's reply box with Home's search asking the Overseer, then six pasted and Add image pressed at the cap. Checks the chooser takes image types only and several at once, a pick adds its thumbnail to its own field, at the cap no picker opens and the line says why, no horizontal overflow; writes `attach-images.json`. Same harness setup as `paste-images`. |
| `scripts/screenshots.mjs --only shortcut` | — | Search from anywhere in the harness, through `harness-slot`: the key from an agent chat's composer opens Home with the cursor in its search, on Home it only moves the cursor, it works with Paseo's sidebar collapsed, None does nothing, another preset works and the old one doesn't, also after a reload. Renders the Keyboard settings row, Home's search chip and the ⌘K row, light and dark. Writes `shortcut.json`; a failed check fails the run. |
| `scripts/screenshots.mjs --only search-focus` | — | Every search request lands in the visible search (invariant 116), through `harness-slot` with `HARNESS_PASEO=0.16`: the search key from a chat with Home never opened, with Home in the history (once and twice), a second press, on Home with a row, a button or a text box focused, while Home loads, from Catch up, PR stats, the queue, the log and Settings, ⌘K "Follow-up: Search" and `/`, desktop and 390×844, with Home as the sidebar view, and the keys around a request as a Mac (⌘) and elsewhere (Ctrl): the key held with auto-repeat, a query typed at once (it must land in the search), focus in a workspace's Follow-up panel, and Dispatch open. Each check needs the caret in a Home search that is on screen (hit-tested), not one kept mounted behind. Writes `search-focus.json`; a failed check fails the run. |
| `scripts/screenshots.mjs --only dictation` | — | Catch up's mic (`dictated-text-lands-in-the-field`), through `harness-slot`: the harness's Paseo has no `usePaseoDictation`, so `FAKE_DICTATION` (harness only) wraps the page's eval to hand Follow-up's bundle a fake hook driven by `window.__dictation`. Renders idle, listening, transcribing, the words landed in the field, unavailable and a failed start on a phone and desktop, light and dark, the keys sheet with V, V from the card, and the card on a Paseo without the hook. Committed to `docs/evidence/catch-up-dictation/`. |
| `scripts/screenshots.mjs --only home-keys` | — | Home's Enter (`the-selected-workspace-opens-with-enter`), through `harness-slot`: a search pick then Enter again, Esc out of the search then Enter, a clicked row then Enter or O, Enter with nothing focused, all land in the chat; Enter on the sort button opens its menu and stays; S toggles the keys sheet and types in the search. Renders Home after a search pick and the keys sheet, light and dark. Writes `home-keys.json` (a run filtered to the renders runs no checks and leaves it alone); a failed check fails the run. |
| `scripts/screenshots.mjs --only your-questions` | — | Your questions (docs/needs-you.md#your-questions), through `harness-slot`: three questions answered with `follow.context-reply` and closed (two Done, one a task), one to read, and one still asking (the harness clock holds the queue, so the chat gets the question's message from `paseo send`). Renders the card in the panel and Home's detail pane, Reply's field, the history (in the card, a sheet on a phone), Catch up's answer card and the question's own message in the chat (its own turn, not folded into the one before), desktop and 390×844, light and dark (`yq-*`); a page that scrolls sideways fails the shot. Review only. |
| `scripts/screenshots.mjs --only own-answer` | — | The question answer form (`one-answer-flow-for-every-question`), through `harness-slot`: writing your own answer and a note on a picked option in the panel, Home's Needs you on a phone and the question dialog, plus two questions with a decision card, light and dark. `--own-answer-before` drives the old form (a note field before any pick, typed into with nothing picked) and names each shot `before-`. Committed to `docs/evidence/own-answer/`. |
| `scripts/screenshots.mjs --only rowchips` | — | Home rows at a 1024 px window (`row-chips-never-cover-the-time`), through `harness-slot`: narrows the list to 400, 360 and 320 px and checks, from CDP box models, that no row's visible chips overlap its time and every row with chips still shows one. Renders the 1024 window, the list at 320 and at its 480 px minimum (dark). Writes `rowchips.json`; a failed check fails the run. |
| `scripts/screenshots.mjs --only paged-lists` | — | Every list pages (`every-list-pages`), through `harness-slot`: a workspace whose agent asks 140 questions and answers each in chat, finishes 60 tasks and keeps 40 open. The panel's Activity folded, its first page and page 4 after Show all, the Questions tab's page 2, a search's paged hits, Agent's tasks opened on page 2, and the larger view on a phone at pages 1 and 3, light and dark. A shot fails on a missing or wrong pager line, a schema error's text or a phone page that scrolls sideways. Review only: PNGs are not committed. |
| `scripts/screenshots.mjs --only pr-scale` | — | A very big workspace (`pr-scale-lists-batch-not-throw`), through `harness-slot`: Ledger rewrite registers one 120-PR stack in example/app (#1001–#1120, `parentNumber` chained) and three short example/web stacks. Renders the panel's Pull requests card at its top, middle and end, the first "+N in review" fold closed and expanded, the stack bar cropped close, the panel's larger view on a phone, Home with the workspace selected (desktop and 390×844), the top failing PR's sheet (#1116; desktop and phone), the chat's brief card beside the panel and on a phone, and Billing retries (3 PRs) on the same surfaces, light and dark. A shot fails on a schema error's text, a phone page that scrolls sideways, "No ask stated" in the chat, or a fold on the 3-PR stack. Review only: PNGs are not committed. |
| `scripts/check-wait-for-checks.mjs` | `test:wait-checks` (`--live` fails instead of skipping) | Wait for checks with one real Haiku agent in a tracked workspace and a fake GitHub: told to wait for a PR's running check without the tool's name, it calls `wait_for_checks`, ends its turn without `gh`, and gets exactly one message when the check finishes ([wait-for-checks.md](wait-for-checks.md)). Skips without credentials or Paseo 0.15. Not in `test:install` (live model). |
| `scripts/check-wait.mjs` | `test:wait`, `test:wait-live` | Wait with real Haiku agents. Skips without credentials or Paseo 0.15; `test:wait-live` fails instead. Asserts each host's default: on by default on 0.15; on a host that advertises `agentBackgroundWork` (0.16) Wait steps aside (`reason: "host"`, `active: false`), so only that default and the standalone case run there. |
| `scripts/check-move.mjs` | `test:move` | 2.0's move from 1.x on a real daemon: the published 1.x beta auto-updates from a fake npm registry to a broken 2.0 (rolled back), then a good one; the move to the new plugin id fails probation once (rolled back, data intact), then succeeds on Try again. Same `follow_*` tool names; Paseo's plugin list shows the new id only. Screenshots (`--shots <dir>`): Home before and after, Settings → General after the rollback and after the move (desktop, 390 px, dark). Passes on Paseo 0.15.4 and 0.16 (`HARNESS_PASEO=0.16`). About 15 minutes. |
| `scripts/check-move.mjs --registry` | `test:move:registry` | The same move for an install from Paseo's plugin list: a fake plugin registry (`PASEO_PLUGIN_REGISTRY`) pins the live pin (1.0.1) as `tomgrin10/follow-up`, which installs under the old id. The pin moves to 2.0, `paseo plugin update` installs it under the old id, and the move reinstalls from the same registry under the new id with data and plugin settings. About 8 minutes. |
| `scripts/check-message-queue.mjs` | manual (through `harness-slot`) | The message queue on a real daemon (`a-message-is-saved-before-sent-and-arrives-once`). The daemon gets `PASEO_DAEMON_URL` pointing at a TCP proxy in the script, so only the worker's own daemon connection goes through it (pass, refuse, delay every frame, or hold from the first `send_agent_message_request`). Cases: `unreachable-then-back` (Queued "Paseo unreachable" with a retry time, then once within 15 s of the worker reconnecting), `reload-mid-send` (a send that landed but wasn't confirmed, and one that never left, each across `paseo plugin reload`: once), `permission-prompt` (Queued behind the prompt, once after it's answered), `card-answer` (a brief card's answer once; a double click and a late Retry with the same answerId send nothing), `reply-timing` (every answer RPC under 300 ms while every worker frame waits 60 s), `back-within-20s` (the outage probe: one connect at a time about every 15 s while Paseo is down, the answer once within 20 s of it coming back with nothing else running), `busy-agent` (an answer steers into a running turn alone; a sent repair waits with the batch line's reason and goes once when the turn ends), `answer-plus-repair` (Auto on, setup skipped: an answer takes the repair in its settle window along, one message, answer first, `---`, then the batch), `reply-timing-b` (Send, `follow.queue-action` retry and cancel, an Overseer forward through a stand-in `overseer.json`, a report handed to an agent: each under 300 ms while slow, then each once and the cancelled one never). `--cases forward-stuck` runs alone on `FOLLOW_UP_QUEUE_TIME_SCALE` 0.05 (`message-queue-stuck.json`): a forward that never left past the scaled `MESSAGE_STUCK_MS`, and one whose arrival can't be known (send held past the deadline, timeline reads dropped) that shows on the workspace and is still retrying, never Failed, past the whole ladder; Cancel clears each. A fake GitHub answers every `example/app` PR as conflicting, so a registered PR makes a repair. Copies are counted in the fixture provider's receipts and the timeline. `--baseline --pack <tgz>` times another build (`reply-timing` and `reply-timing-b`) without asserting (`message-queue-main.json`, embedded in the next run's timing table). Writes `docs/evidence/message-queue/message-queue.json`; a failed check fails the run. `--renders` (with `PLAYWRIGHT_CORE` and `CHROMIUM`) starts its own daemon with the web UI and `FOLLOW_UP_QUEUE_TIME_SCALE=0.25` and shoots the question dialog's answer block, the chat brief card in each delivery state it can stage (Sending, Queued, Retrying, Not sent, Sent; an unknown arrival stays Retrying past the whole ladder), light and dark, 1280×900 and 390×844, checking no horizontal overflow at 390; writes `mq-<surface>-<state>-<device>-<theme>.png` and `message-queue-renders.json` (failed shots go to `failed/`, never committed). `--renders --only message` shoots only Needs you's row for an Overseer forward that never left ("A message to <agent> didn't go out", Retry and Cancel) once it is past `MESSAGE_STUCK_MS` × 0.25, writing `mq-message-stuck-*.png` and `message-queue-renders-message.json`. |
| `scripts/check-no-gh.mjs` | `test:no-gh` | Invariant 110 (`works-without-github`) on an isolated daemon whose PATH has no `gh`, then with a `gh` that answers signed out (`--signed-out`): setup's GitHub row is optional, tasks work, every GitHub surface answers in one line, and no `gh` runs or GitHub failure is logged in a 90 s window (`NO_GH_WINDOW_MS`). `--keep` leaves the daemon up for renders (`.preview-isolated.json`), `--report` prints what it saw. |
| `scripts/check-github-mode.mjs` | `test:github-mode` | Plain-GitHub mode on the running preview, with a fake `gh` (reads reach it through check-install's `fakeGithub`). |

Every script in the table above starts its own isolated daemon, except `test:github-mode`. The scripts below don't:
they need a running `npm run preview` and read `.preview-isolated.json`. Some drive a browser with Send to Paseo
(`SEND_TO_PASEO_SOURCE`, `STP_CHROMIUM`):

- `scripts/check-browser-controls.mjs`, with `scripts/browser-control-fixture.mjs` and
  `scripts/browser-control-preload.cjs`: merge-when-ready through the extension.
- `scripts/check-compact-panel.mjs`: the panel at phone width.
- `scripts/check-chat-grouping.mjs`: a synthetic mixed turn for chat-grouping screenshots (starts its own isolated daemon).
- `scripts/check-sender-steps.mjs`: Home's Recent steps with one message from every sender kind; fails on a raw `<paseo-system` envelope or overflow (starts its own isolated daemon).
- `scripts/check-optional-recovery.mjs`: recovery only on request.
- `scripts/check-recovery-background.mjs`: the recovery agent on Paseo 0.16 (`HARNESS_PASEO=0.16`) and 0.15: background
  only with `features.backgroundAgents`, tools after a reload, host-collectable after acknowledge or failure, and the
  panel's Recovery row (`--shots <dir>`).
- `scripts/check-project-settings.mjs`: per-project defaults.
- `scripts/check-view-settings.mjs`: view state per device on Paseo 0.16 (`HARNESS_PASEO=0.16`) and 0.15: the settings
  category and a fold survive a reload, the reload never paints the default category first, and on 0.16 the device
  document `follow-up-view` holds them (migrated, no `home_sort`) (`--shots <dir>`). The phone app is a manual check
  ([settings.md](settings.md#where-settings-live)).
- `scripts/check-reviewers.mjs` and `scripts/check-reviewer-concurrency.mjs`: reviewer requests.
- `scripts/check-task-triggers.mjs`: merge and deploy triggers.
- `scripts/demo.mjs`: seeds the preview with demo data for screenshots (`node scripts/demo.mjs`, optionally
  `--freeze-pr-display`).

`scripts/ui-home.mjs` is the Playwright helper screenshot scripts use to reach Follow-up Home: `openHome` goes to
Home by URL and waits for the Status strip and search field, `homeRow` finds a row in Home's column (never the
sidebar entry with the same title), and both throw with a screenshot instead of shooting the wrong page.

`scripts/fixture-provider.ts` is the synthetic agent provider these daemons use. Its `fixture-scripts.json` mode
plays a scripted turn (timeline items, Follow-up RPCs, a permission) for a given prompt, for `scripts/screenshots.mjs`.
`scripts/harness.mjs` gives them their slot and cleanup (below), and points the browser at
`scripts/harness-fonts.conf` (`FONTCONFIG_FILE`): the machine's fonts with `system-ui` and `sans-serif` on a font that
has a bold face. Paseo's phone layout puts `system-ui` first, and on a machine whose default sans has none every phone
render drew semibold as regular. `scripts/font-weights.mjs` (`fontWeightProblem`) checks it in the page: screenshots
refuse to render when 600 draws no heavier than 400. `scripts/daemon-counter.mjs` and
`scripts/heap-summary.mjs` are measurement helpers ([resources.md](resources.md)).

## Rules for harness daemons

- **Wait by deadline, scaled by load.** A harness wait polls with `waitUntil(what, check, { baseMs })` from
  `scripts/harness.mjs`, never a fixed attempt count. Its budget is `baseMs` (sized for an idle VM) times
  `loadFactor()`: the 1-minute load per core, between 1 and 6, re-read on every poll. A shared VM at load 30 on
  8 cores runs every wait about 4× slower, and a fixed count failed `test:install` three times in four runs there.
- **Isolate the env with `harnessEnv`.** Every script that spawns a daemon, the Paseo CLI or a plugin builds the
  child env with `harnessEnv(root, { home, set })` from `scripts/harness-env.mjs` (`applyEnv` for an in-process
  daemon). It puts `HOME`, `XDG_CONFIG_HOME`, `PASEO_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` inside the temp
  root, refuses any of them outside it, and strips the session's `PASEO_*`, `CODEX_*`, Follow-up and Claude session
  variables. A hand-built `{ ...process.env, … }` once missed `CLAUDE_CONFIG_DIR`, and its daemon installed hooks into
  a real account. `tests/harness-env.test.ts` fails on a check script that builds its env by hand.
- **No real external tools.** `harnessEnv` also puts failing stubs (exit 127) for `mcpproxy`, `gh`, `gt`, `gcloud`,
  `claude` and `codex` on `PATH`, after any entries inside the root (a script's own fake `gh` or `mcpproxy` still
  wins) and before the host's. A realistic scale run's ranker once ran the host's real `mcpproxy` (Linear and Slack
  reads as the developer). The Paseo CLI stays real. Only `check-wait`, the opt-in live-model check, keeps the real
  `claude` (`real: REAL`, one constant for its env and its config); `tests/harness-env.test.ts` fails on any other
  opt-out or a tool that resolves outside the root.
- **One config.json, `harnessConfig`.** Every harness daemon's `config.json` comes from
  `harnessConfig({ port, mcp, webUi, real, extra })` in `scripts/harness-env.mjs`. It turns off the agent provider of
  each stubbed tool (`PROVIDER_TOOLS`), from the same `stubbedTools(real)` list as the stubs. With `codex` stubbed but
  its provider on, a browser's provider refresh wrote to the dead stub and Paseo 0.15.4's worker crashed on the EPIPE,
  so every shot after the first landed on the welcome screen. `tests/harness-env.test.ts` fails when a script writes
  its own config or a stubbed provider stays on.
- **In-process daemons use explicit provider options.** `createPaseoDaemon` does not load the provider settings
  written to `config.json`. `check-wait.mjs` and `check-wait-for-checks.mjs` pass
  `harnessDaemonProviders({ builtinProviderIds: BUILTIN_PROVIDER_IDS, real: REAL, settings })` as daemon options:
  `providerOverrides` disables every built-in except the providers the check uses, and `agentProviderSettings`
  carries only those providers' runtime settings. Read `BUILTIN_PROVIDER_IDS` from the installed CLI's protocol
  package, so a new built-in stays off too. Both checks refresh the catalog and call `assertProviderStubsUnused`
  before creating agents and before reporting success. The Codex stub (`scripts/harness-codex-stub.cjs`, copied
  into the isolated PATH) records invocations and rejects app-server JSON-RPC requests while keeping stdin open;
  a stray probe fails the check without racing a write to a closed pipe. Other Codex commands still exit 127.
  `tests/harness-env.test.ts` covers the provider allowlist, both in-process call sites, and repeated stub requests.
- **A crashed worker fails the run.** `screenshots.mjs` checks the daemon's log after every shot (`daemonCrashes`:
  "Uncaught exception", a worker restart) and fails at that shot with the log line, not with timeouts after it.
- **A fictional host name, `dev-box`.** Paseo labels its host with `os.hostname()` (the phone header, `server_info`)
  and has no setting for it, and renders go into this public repo. `harnessEnv` puts
  `scripts/harness-hostname.cjs` first on `NODE_OPTIONS` (after a caller's `set` and `strip`), so every harness
  process's `os.hostname()` and `HOSTNAME` read `HARNESS_HOST`. `tests/harness-env.test.ts` fails when a harness
  process can read the real name.
- **Fictional names everywhere** (`no-real-names-in-renders-or-fixtures`). Fixtures use `acme-*` names (the project
  `acme-project`, the repository `acme/acme-poc`, `linear.app/acme`, `acme.slack.com`), never the company's. Every
  render path (`screenshots.mjs`, `check-recovery-background.mjs`, `check-project-settings.mjs`,
  `check-view-settings.mjs`) passes its page text
  through `assertNoRealNames` (`scripts/real-names.mjs`), which fails a shot naming the real hostname, its user, the
  company, its people, customers or ticket keys; `tests/no-real-names.test.ts` fails any committed file (PNG text
  chunks included) that does. Fixtures use fictional people and ticket keys (`ACME-123`, `APP-142`). The hostname and user name are read at run time (`os.hostname()`,
  `os.userInfo()`, skipped in CI), and the denied words are stored only as sha256 hashes of word tokens (names match only capitalised; ticket keys as a hashed prefix followed by digits)
  (text is split on `[a-z0-9]+`), so the denylist puts no plain text in the repo. Tests of the checker use an injected
  fictional denylist. The product files that still carry the company's configuration, and the tests that exercise
  them, are excluded by path (`EXCLUDED`) until the Q55 host-config PR moves that configuration into host settings;
  scripts that need the default-tracked repository read it from `shared/settings.ts` at run time.
- **Fake GitHub over HTTP, not only `gh`.** Follow-up reads GitHub over in-process HTTPS (`server/github-api.ts`); a
  fake `gh` on PATH only answers writes. A script whose daemon needs PR reads starts `fakeGithub({ dir, gh })` from
  `scripts/fake-github.mjs` and passes its `env` and `strip` to `harnessEnv`. The server answers each request with the
  script's fixture `gh` (GH_REPO set), and only for the owner's own token, resolved through an account map and a fake
  `gh auth token --user` like the real host. `harnessEnv` points `FOLLOW_UP_GITHUB_API` at a closed port by default,
  so a daemon never reads the real api.github.com. 2026-11-11: check-install's fake `gh` was bypassed after reads
  moved to HTTPS and the v2.0.0-rc.3 publish failed; `tests/harness-env.test.ts` fails on a script that fakes `gh` for
  a daemon without this.
- **Take a slot.** Every script that starts a Paseo daemon or a browser calls `await harness()` from
  `scripts/harness.mjs` before its heavy work, and starts daemons with `spawnDaemon`. `tests/harness.test.ts` fails
  when a script skips either. `harness()`:
  - Holds a machine-wide flock on `/tmp/paseo-harness-slots/slotN`. These are the same files as the VM's
    `harness-slot` shell wrapper, so the wrapper and the scripts share slots. `HARNESS_SLOTS` sets N (default 2).
  - Waits, with a single `waiting for a harness slot` line, while every slot is taken or while Paseo's working set
    is over 75% of its cap. The working set is `memory.current` minus `inactive_file` and `slab_reclaimable` for the
    `paseo.service` cgroup.
  - Exports `HARNESS_SLOT_HELD`. A run that already has it (under the wrapper, started by a script holding a slot,
    or shooting against another agent's held daemon with `HARNESS_SLOT_HELD=1`) starts at once.
  - Checks the `paseo` CLI first on PATH: prints `paseo X at /path` once, and exits 97 with
    `wrong paseo (X at /path); need >= <floor>` when X is below `requirements.paseo` in `paseo-plugin.json`. A stale
    CLI earlier on PATH otherwise fails deep in the run, as an unknown option. Runs already inside a slot skip this.
  - Turns local speech off, so harness daemons don't download a speech model.
  
  Daemons from `spawnDaemon` run in their own process group, which is killed when the script exits, including on
  SIGINT, SIGTERM and SIGHUP. Wrap other heavy commands (`npm run verify`, Playwright) in the shell wrapper.
- **Stop what you start.** Stop a harness daemon as soon as you're done with it. `npm run preview` keeps
  running, and holds its slot, until SIGINT or SIGTERM: run it in the background, and to stop it, send SIGTERM to that npm/node process.
  It then stops its daemon (`daemonPid` in `.preview-isolated.json`) and removes nothing else. Delete
  `.preview-isolated.json` and the temp root afterwards.
- **Isolated homes only.** The scripts create a temp root with their own `HOME`, `PASEO_HOME`, `CLAUDE_CONFIG_DIR`
  and `CODEX_HOME`. The exception is `check-wait`, whose agents read real Claude credentials from your
  `CLAUDE_CONFIG_DIR`, or `~/.claude`; that's read-only. Never use the
  developer's `~/.paseo`, the live daemon, or a live plugin install. Synthetic workspaces, agents and PRs only.
- **Cap heavy scans.** Run scans or the scale check in a memory-capped scope, e.g.
  `systemd-run --user --scope -p MemoryMax=4G npm run test:scale`.
- **Live model calls** (`check-wait`) cost a few cents. Re-run single cases with
  `npm run test:wait-live -- --cases message,failure`.

## Screenshots

`npm run shots` (`scripts/screenshots.mjs`) re-shoots every README image from the current UI. Run it through the
harness slot:

```sh
PLAYWRIGHT_CORE=<playwright-core dir> CHROMIUM=<chromium binary> ~/paseo-harness/tools/harness-slot npm run shots -- --out <dir>
```

- **What it does.** Starts one isolated daemon (the packed plugin, the fixture provider, the web UI, a fake `gh`, and a
  fake `mcpproxy` that confirms a few Linear keys so Linked items render),
  seeds synthetic workspaces through Follow-up's own RPCs and scripted fixture turns, shoots with headless Playwright,
  and stops the daemon on success and on failure. It needs the Paseo CLI 0.15.x.
- **Deterministic.** Fixed seed data and fixed clocks: the daemon and worker run with a shifted `Date` (a preload),
  and the browser's clock is frozen with `page.clock`. The server id is fixed and project ids come from a counter, so
  the sidebar's project avatar keeps its colour. Two runs give the same images. It waits on UI states, not
  sleeps.
- **Synthetic only.** `example/app`, made-up people (Dana, Ravi), Linear-style keys (`APP-142`, `WEB-17`). Never real
  repos, names, channels or anything from a real Paseo home. This is a public repo.
- **Shots** (`follow-up-<shot>.png`, into `--out`, default `docs/screenshots/`): `setup`, `home`, `panel`,
  `questions`, `pill`, `pr-sheet`, `phone`, `whats-new`, `linked-items` (the Linked list open over Home's detail) and
  `sidebar` (Follow-up's sidebar view on Paseo 0.16, cropped to the sidebar; shoot it alone with
  `HARNESS_PASEO=0.16`). Review shots (not in the default set): `put-in-chat` (Paseo 0.16: the question's actions row
  on the dialog, phone and pill, answers waiting to be sent, Sign off as the escape hatch, and the waiting row's
  one-click Send). `--only a,b` shoots a subset. Home is reached with
  `scripts/ui-home.mjs`, which fails the shot instead of shooting the wrong page.
- **Theme.** Dark for desktop shots, light for the phone shot; `--scheme dark|light` overrides both.
- **README images and plugin media.** `npm run shots:readme` (`scripts/readme-shots.sh`) re-renders every README image,
  the plugin page's `media` slides and the [guide](guide.md)'s phone and sidebar shots, into `docs/screenshots/`:
  `home` and `phone` on Paseo 0.15, `sidebar` on the global Paseo CLI (`HARNESS_PASEO=0.16`: 0.16 or later), then the
  `frames` set on the same CLI. `frames` shoots 1600×900 light/dark pairs of the real app in context
  (`follow-up-frame-<name>-{light,dark}.png`, the README's `<picture>` pairs), Catch up on a phone
  (`follow-up-catch-up-phone-{light,dark}.png`), and `slide-*` crops of one element each at 8×. `scripts/cover.mjs`
  then composes the 16:10 slides (1920×1200 at 2×, `follow-up-slide-<n>-<name>.png`): the cover carries the headline
  and the purpose line (`--headline "a|b"`, `--subline`, or `COVER_HEADLINE`/`COVER_SUBLINE`), each other slide a
  short feature headline, one plain line and its crop filling a white sheet of one width (a tall one runs off the
  slide's bottom), to read on Paseo's 288×180 tiles. `paseo-plugin.json`
  `media` lists the slides, cover first, so they ship in the npm package; the demo video sits right after the cover as an absolute jsDelivr URL pinned to a commit, because the npm package leaves the video out (a relative path would point into it), and the README links the video's poster; nothing at runtime reads `docs/screenshots/`, and the README, the guide and the release notes load their images from GitHub, so `package.json` `files` ships the slides (`follow-up-slide-*.png`) and nothing else from that folder. Everything goes through `harness-slot` and is
  shown as the latest stable tag. Re-run it whenever Home's rows, the panel's copy or the fixture change, then read
  every image, and each slide at 288×180, before committing.
- **Gallery.** `npm run shots:gallery` (`scripts/gallery-shots.sh`) re-shoots `docs/screenshots/gallery/`: the
  `gallery` set (Home, the decision card, the panel, the pill, the PR sheet, Catch up, Settings, Dispatch, the Overseer asked
  from Home's search, setup, and the sidebar view on 0.16+), desktop light and 390×844 dark, plus What's new, in one run
  on the global Paseo CLI. Files are named `<surface>-<desktop|phone>-<light|dark>.png`, and
  `scripts/gallery-index.mjs` rewrites `INDEX.md` (what each shows, its size and the commit it was shot at). The
  gallery stays out of the npm package (`package.json` `files` ships only the slides). AGENTS.md has the rule for keeping it current.
- **Compression.** Both scripts source `scripts/shots-optimiser.sh`: with no `pngquant` or `oxipng` on PATH and uv's
  `uvx` available, a shim runs PyPI's `pngquant-cli`, so shots are taken at 2× and compressed.
- **Demo video.** `npm run video -- --out <dir>` (`scripts/demo-video.mjs`, through `harness-slot`) records the 20-30 s
  demo for the plugin page and README: Home, Catch up (Allow, Skip, a recommended answer), what went back to agents by
  itself, an Overseer question from Home's search, and Home again, with a drawn cursor and a caption band. It boots
  `screenshots.mjs --only home --overseer-review --keep` and records a CDP screencast at the frames' own timestamps.
  Needs `FFMPEG` (libx264 and libwebp; a pinned `ffmpeg-static` outside the repo works). Writes
  `follow-up-demo.mp4`, `follow-up-demo-poster.png`, `follow-up-demo.webp` and review frames (one every 2 s) to
  `--out` (default `.demo-video/`, git-ignored). The committed copies live in `docs/screenshots/` beside the slides,
  kept out of the npm package (`files` ships only the slides from that folder): copy the three files there after
  reading the frames. Paseo's app shows only image media; the paseo.sh plugin page plays the video, from a
  jsDelivr `gh` URL pinned to a commit (it serves `video/mp4`; a relative path would resolve to the npm package,
  which leaves the video out, and GitHub raw serves `application/octet-stream`).
- **Demo video v2.** A take recorded and edited from one shot list, in Remotion (`video/`, its own package: never in
  the plugin's dependencies or the npm package). The shot list lives in `scripts/demo-video-v2.mjs`: each beat starts
  a shot with the UI it frames (`shot`, `frame`: real element boxes), holds still while the camera settles, then acts
  inside that frame with time to read. The edit (`video/src/Demo.tsx`) plays the shots: one framing per shot, only
  ever the whole window or the Follow-up pane edge to edge (the pane when every box of the shot fits above the
  caption), eased over 1.6 s, with an eased pointer, click rings and captions that animate word by word. Two steps,
  both through `harness-slot`: `npm run video:v2:take -- --as-version <stable>` (the bare app at 2560×1600 and
  `take.json`: pointer path, presses, beats, the Follow-up pane's box and the shots, into `video/public/take/`), then
  `npm --prefix video ci && (cd video && node render.mjs)` (writes `follow-up-demo-v2.mp4`, `-poster.png`, `.webp`,
  a review frame every second and `contact-sheet.png` to `video/out/`; `node stills.mjs <seconds…>` renders single
  frames, `npx remotion studio src/index.ts` previews). Needs `PLAYWRIGHT_CORE` and `CHROMIUM` (the render uses
  `CHROMIUM` too) and, for the take, `FFMPEG` (video/'s `ffmpeg-static` works). The committed copies sit beside v1's
  in `docs/screenshots/` (`follow-up-demo-v2*`, kept out of the npm package by the same `files` rule), review frames
  and the contact sheet in `docs/evidence/demo-video-v2/`.
- **`--whats-new-review`** (review evidence, not README images): the sheet after a minor update (`2.0.1` to `2.1.0`,
  this repo's own section) on desktop and phone, and Settings → General's "Show What's new after updates" switch on
  and off (set through `set_updates`), desktop and phone, into `--out`.
- **What's new** is shot after a reinstall as the CHANGELOG's newest stable over the stable before it
  (`whatsNewStables`), opening at the newest version with its Installed pill. A `## 2.0.0` stand-in is added when the
  CHANGELOG has none; `--whats-new-changelog <file>` uses that file instead. `--whats-new-all` adds light and phone,
  an older version a scroll down (`whats-new-older*`), the end, and the Installed pill under a made-up next minor the
  updater offers (`whats-new-pending*`, from Settings' Release notes, through the `updates-demo.json` override that
  `FOLLOW_UP_UPDATES_DEMO=1` turns on for `--only whats-new` runs).
- **Size** (aim under ~300 KB each). With `pngquant` (lossy palette) or `oxipng` on PATH, shots are taken at
  deviceScaleFactor 2 and optimised. Without either, desktop shots use deviceScaleFactor 1.25 and Playwright's own PNG
  (the phone shot stays at 2). `--scale <n>` sets the desktop factor.

## UI

Render every state you touched with headless Playwright against `npm run preview`: desktop and 390×844, light and
dark, no horizontal overflow. Run `/impeccable critique` and apply its findings.
