# Testing

## Before every PR

| Command | What it runs |
| --- | --- |
| `npm run verify` | `typecheck`, `check:notes` (release-note fragments), `npm test` (every `tests/*.test.ts` through tsx), `button-visibility.test.mjs`, `test:scale`, `test:native`, `test:trust`. PR CI (`.github/workflows/ci.yml`) runs it with Paseo 0.15.2. |
| `npm run test:install` | `scripts/check-install.mjs` (packs the plugin and installs it into an isolated daemon with fixture providers: activation, recovery, ownership, hooks, tasks, Session Guard coordination, project defaults), then `scripts/check-wait.mjs` ([wait.md](wait.md)). PR CI doesn't run it. The publish workflow runs it with Paseo 0.15.2 and no model credentials. |
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
  - `tests/rpc-ack.test.ts`: every client RPC replies within 500 ms with Paseo, the daemon and gh hanging
    (`tests/support/hanging-host.ts` runs the real `contribute()` in a temp home), or has an `EXEMPT` reason.
    `tests/answer-ack.test.ts` covers the answer paths: fast ack, one send per answer, retries, resume after reload.
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
| `scripts/scale-check.mjs` | `test:scale` | No dormant agent wakes at 120 workspaces; RSS, CPU and idle request budgets. Skips without the paseo CLI, except in CI. |
| `scripts/check-native-tools.mjs` | `test:native` | Tools are served through Paseo's MCP with no per-agent process. A reload detaches them, the bridge still works, and they come back. |
| `scripts/check-trust-bypass.mjs` | `test:trust` | Trust bypass on a real daemon. |
| `scripts/check-install.mjs` | `test:install`, `preview` | The packed install. `--keep` (`npm run preview`) leaves the daemon running for screenshots, prints "Isolated browser app: http://127.0.0.1:<port>", and writes `.preview-isolated.json`. |
| `scripts/check-wait.mjs` | `test:wait`, `test:wait-live` | Wait with real Haiku agents. Skips without credentials or Paseo 0.15; `test:wait-live` fails instead. |
| `scripts/check-move.mjs` | `test:move` | 2.0's move from 1.x on a real daemon: the published 1.x beta auto-updates from a fake npm registry to a broken 2.0 (rolled back), then a good one; the move to the new plugin id fails probation once (rolled back, data intact), then succeeds on Try again. Same `follow_*` tool names; Paseo's plugin list shows the new id only. Screenshots (`--shots <dir>`): Home before and after, Settings → General after the rollback and after the move (desktop, 390 px, dark). Passes on Paseo 0.15.4 and 0.16 (`HARNESS_PASEO=0.16`). About 15 minutes. |
| `scripts/check-move.mjs --registry` | `test:move:registry` | The same move for an install from Paseo's plugin list: a fake plugin registry (`PASEO_PLUGIN_REGISTRY`) pins the live pin (1.0.1) as `tomgrin10/follow-up`, which installs under the old id. The pin moves to 2.0, `paseo plugin update` installs it under the old id, and the move reinstalls from the same registry under the new id with data and plugin settings. About 8 minutes. |
| `scripts/check-github-mode.mjs` | `test:github-mode` | Plain-GitHub mode on the running preview, with a fake `gh`. |

Every script in the table above starts its own isolated daemon, except `test:github-mode`. The scripts below don't:
they need a running `npm run preview` and read `.preview-isolated.json`. Some drive a browser with Send to Paseo
(`SEND_TO_PASEO_SOURCE`, `STP_CHROMIUM`):

- `scripts/check-browser-controls.mjs`, with `scripts/browser-control-fixture.mjs` and
  `scripts/browser-control-preload.cjs`: merge-when-ready through the extension.
- `scripts/check-compact-panel.mjs`: the panel at phone width.
- `scripts/check-chat-grouping.mjs`: a synthetic mixed turn for chat-grouping screenshots (starts its own isolated daemon).
- `scripts/check-sender-steps.mjs`: Home's Recent steps with one message from every sender kind; fails on a raw `<paseo-system` envelope or overflow (starts its own isolated daemon).
- `scripts/check-optional-recovery.mjs`: recovery only on request.
- `scripts/check-project-settings.mjs`: per-project defaults.
- `scripts/check-reviewers.mjs` and `scripts/check-reviewer-concurrency.mjs`: reviewer requests.
- `scripts/check-task-triggers.mjs`: merge and deploy triggers.
- `scripts/demo.mjs`: seeds the preview with demo data for screenshots (`node scripts/demo.mjs`, optionally
  `--freeze-pr-display`).

`scripts/ui-home.mjs` is the Playwright helper screenshot scripts use to reach Follow-up Home: `openHome` goes to
Home by URL and waits for the Status strip and search field, `homeRow` finds a row in Home's column (never the
sidebar entry with the same title), and both throw with a screenshot instead of shooting the wrong page.

`scripts/fixture-provider.ts` is the synthetic agent provider these daemons use. Its `fixture-scripts.json` mode
plays a scripted turn (timeline items, Follow-up RPCs, a permission) for a given prompt, for `scripts/screenshots.mjs`.
`scripts/harness.mjs` gives them their slot and cleanup (below). `scripts/daemon-counter.mjs` and
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
  `questions`, `pill`, `pr-sheet`, `phone`, `whats-new`, `context-menu` (Home's row menu, right-clicked) and
  `linked-items` (the Linked list open over Home's detail). `--only a,b` shoots a subset. Home is reached with
  `scripts/ui-home.mjs`, which fails the shot instead of shooting the wrong page.
- **Theme.** Dark for desktop shots, light for the phone shot; `--scheme dark|light` overrides both.
- **What's new** is shot after a reinstall as `2.0.0-rc.0` over `1.4.0-beta.32`. It shows the repo's CHANGELOG.md
  `## 2.0.0` section when there is one, else a built-in stand-in; `--whats-new-changelog <file>` uses that file instead.
- **Size** (aim under ~300 KB each). With `pngquant` (lossy palette) or `oxipng` on PATH, shots are taken at
  deviceScaleFactor 2 and optimised. Without either, desktop shots use deviceScaleFactor 1.25 and Playwright's own PNG
  (the phone shot stays at 2). `--scale <n>` sets the desktop factor.

## UI

Render every state you touched with headless Playwright against `npm run preview`: desktop and 390×844, light and
dark, no horizontal overflow. Run `/impeccable critique` and apply its findings.
