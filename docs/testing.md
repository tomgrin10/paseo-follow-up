# Testing

## Before every PR

| Command | What it runs |
| --- | --- |
| `npm run verify` | `typecheck`, `check:notes` (release-note fragments), `npm test` (every `tests/*.test.ts` through tsx), `button-visibility.test.mjs`, `test:scale`, `test:native`, `test:trust`. PR CI (`.github/workflows/ci.yml`) runs it with Paseo 0.15.2. |
| `npm run test:install` | `scripts/check-install.mjs` (packs the plugin and installs it into an isolated daemon with fixture providers: activation, recovery, ownership, hooks, tasks, Session Guard coordination, project defaults), then `scripts/check-wait.mjs` ([wait.md](wait.md)). PR CI doesn't run it. The publish workflow runs it with Paseo 0.14 and no model credentials. |
| `npm pack --dry-run` | Checks the package contents: runtime entries, generated sources, `server/wait-runner.sh`, screenshots, and no state, logs or credentials. |

Write the failing test first. Bugs get a root cause, a failing test, a fix for the whole class, and an invariant,
not a patch for one instance.

## Unit tests (`tests/`)

- **Shared code.** Most logic is pure and lives in `shared/`, so tests target it directly.
- **Fixtures.** `tests/fixtures.ts` builds workspaces, PRs, snapshots and a clock.
- **A clean environment.** `npm test` preloads `tests/hermetic-env.mjs`, which clears the Follow-up and Paseo session
  variables (`FOLLOW_THROUGH_*`, `PASEO_AGENT_ID`, `PASEO_HOME`…). A run from inside a live agent session then
  matches CI.
- **Tests that guard a whole class of bug:**
  - `tests/never-wake.test.ts` and `tests/daemon-load.test.ts`: no wake-ups, bounded reads.
  - `tests/status-invariants.test.ts`: every invariant in `shared/status-invariants.ts` holds over a grid and the
    bug fixtures.
  - `tests/agent-parity.test.ts`: every client RPC has a tool or an exemption.
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

`scripts/fixture-provider.ts` is the synthetic agent provider these daemons use, and `scripts/harness.mjs` gives them
their slot and cleanup (below). `scripts/daemon-counter.mjs` and
`scripts/heap-summary.mjs` are measurement helpers ([resources.md](resources.md)).

## Rules for harness daemons

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

## UI

Render every state you touched with headless Playwright against `npm run preview`: desktop and 390×844, light and
dark, no horizontal overflow. Run `/impeccable critique` and apply its findings.
