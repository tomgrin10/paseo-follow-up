# Updates (self-update)

Follow-up checks npm for a newer version of itself, and can install it, watch it, and roll it back. The UI is the
Updates part of Settings → General (`UpdatesSections` in `client/updates.tsx`), Home's one-line notice
(`UpdateNotice`: a rollback, or in Tell me a new major only, per `announcesUpdate` in `shared/changelog.ts`), and setup's Updates step (`UpdatesStep`). Users read about it in README's "Updates" section.

## Files

| File | What it does |
| --- | --- |
| `server/updater.ts` | `Updater`: the schedule, checks, the quiet window, Install now, the provenance and notes cache, and the view (phase, notice, history). It reads `updates.jsonl` back to tell what the installer did. |
| `server/update-registry.ts` | `RegistryChecker`: one abbreviated-metadata request with an ETag. Six hours between scheduled checks, a minute when Settings opens, 5 s for Check now (a double press). |
| `server/update-provenance.ts` | `checkProvenance` reads a version's SLSA statement: its subject sha512 must equal `dist.integrity`, and the workflow repository must be this repo. `tarballChangelog` reads `package/CHANGELOG.md` from the tarball, checked against that integrity. Neither verifies Sigstore signatures, and the README says so. |
| `server/update-watchdog.mjs` | The detached installer. It previews and applies the update through Paseo's plugin-update calls, pinned to the checked integrity, then watches the plugin list and `heartbeat.json`, and rolls back the same way. `server/update-watchdog-source.ts` is generated from it by `scripts/build.mjs`; `server/update-watchdog.d.mts` holds its types. |
| `server/updates.ts` | `UpdatesStore` (`updates.json`) and `settingsOf` (the defaults). |
| `shared/updates.ts` | The view schema, modes, every state's copy (`statusCopy`), the channel hint and General's phone line (`generalSummary`). |
| `shared/update-policy.ts` | The quiet window (`quietWindow`), busy text and the probation length. `probation` itself lives in the watchdog. |
| `client/updates.tsx` | `UpdatesSections`, `StatusCard`, `UpdateNotice`, `UpdatesStep`, `useUpdates`. |

## RPCs and agent tools

- `follow.updates` returns the view. `{ check: "settings" }` asks npm unless the mode is Off or a check ran in the
  last minute; `{ check: "manual" }` always asks.
  - Tools: `updates_status` (read) and `check_updates` (write, no plan).
- `follow.set-updates` sets `{ mode, channel }`. Tool: `set_updates` (planned).
- `follow.install-update` takes `{ version, anyway? }`. Tool: `install_update` (planned).
  - It refuses a version whose provenance failed, even with `anyway`.
  - Without `anyway` it installs at once if nothing is busy, otherwise it waits.
- `follow.dismiss-update-notice` is exempt from parity: it hides Home's line for the person looking at it.

## Defaults and modes

- A fresh install defaults to Install automatically. Setup's Updates step pre-selects it, and `updatesConsent` in
  `shared/onboarding.ts` saves it when the step is passed or setup is skipped.
- An existing install defaults to Tell me, and its setup never writes a mode it didn't pick.
- Off means no scheduled checks and no check when Settings opens. Check now still works.
- Channel: Stable (`latest`) or Beta (the newer of `beta` and `latest`). It starts from the installed version, and
  Stable never offers an older stable than what runs (`offerFor` in `shared/version.ts`).
- Installs that aren't from npm (a Git checkout, a local folder, the Paseo registry) never check or install. They
  show "managed by your checkout".

## Installing

1. The version must be newer, listed on npm, and trusted. Provenance is checked once per version and cached in
   `updates.json`.
2. Automatic installs wait for a quiet moment: no agent running, and no ranker, Summary job, PR action or repair
   being sent, for 5 minutes in a row. After 24 hours of waiting, any idle moment will do. This is event-driven:
   turn starts and ends call `Updater.activity()`, one timer covers the rest, and timers exist only while an update
   waits. Agent status comes from the directory's agent list (one fresh agent list right before installing),
   never from timelines.
3. `spawn` writes `update-watchdog.mjs` to plugin-data and starts it with `detached: true`. The job, including the
   daemon password, goes in `FOLLOW_UP_UPDATE_JOB` in its environment, never on the command line.
   `update-watchdog.lock` holds its pid.
4. The watchdog applies the update. The new worker writes `heartbeat.json` once it is ready. For 10 minutes, every
   15 s, the watchdog reads the plugin list and the heartbeat, and rolls back when:
   - Paseo reports the plugin failed or missing;
   - the heartbeat carries an error;
   - nothing reports in within 2 minutes.
5. A rolled-back version is never retried automatically. A failed install is retried after the next successful
   check. Paseo itself refuses a build that can't load while applying it, which shows as "Couldn't install".
6. `VersionsStore.started` treats a downgrade as no update, so a rollback never shows "Updated to" or What's new.

## Moving from 1.x

Paseo never changes an installed plugin's id: an update or the 1.x auto-updater keeps the id the plugin was installed
under (checked on Paseo 0.15.4 and 0.16 in an isolated harness), and a plain install of the new id sits next to the
old one. 1.x ran under an older id and data directory (`shared/legacy.ts` names both), so 2.0 moves itself once.

- **Data** (`server/data-move.ts`): the first 2.0 start that finds `plugin-data/follow-up` missing copies 1.x's
  directory to a temporary sibling and renames it into place. It runs synchronously at the top of `contribute()`,
  skips files that belong to a live process (`worker.lock`, `heartbeat.json`, `update-watchdog.lock`,
  `hooks-enabled.json`), waits up to 10 s for a 1.x worker that still holds the old lock, and writes
  `migrated-from.json`. A second start finds the directory and does nothing. The old directory is never deleted.
  Two compatibility files are written there: `mcp.mjs` becomes a shim that runs the current bridge (1.x recovery
  agents run that path), and `heartbeat.json` is written next to the new one while the old directory exists, because
  a 1.x installer on probation reads it (drop that in the release after 2.0.0). Wait jobs prepared before the move
  keep their receipts in the old `wait/jobs`; `server/wait-jobs.ts` looks there for a job it can't find.
- **Plugin id** (`server/plugin-move.ts`, run by `runMove` in `server/update-watchdog.mjs`): an npm install still
  under the old id waits for the same quiet rule as an update (no agent mid-turn, nothing busy, a quiet stretch) and
  for no installer to be alive, Follow-up's or a 1.x one still on probation (its lock is in the old directory). Then
  the watchdog copies `plugin-settings/<old>/` to `plugin-settings/follow-up/` (Paseo deletes a plugin's settings
  when it's removed), disables the old id (never two workers), installs the same version from npm (which takes the
  manifest's id), runs probation, and removes the old id only after it passed. Any failure removes the new id and
  enables the old one again, which is still on disk. Each step goes to `updates.jsonl` (`moving`, `move-installed`,
  `moved`, `move-rolling-back`, `move-rolled-back`, `move-failed`). A move that failed isn't retried by itself.
- **What you see**: one quiet line in Settings → General ("Moved to Follow-up's new plugin id", or why it went back,
  with Try again). `updates_status` reports the same as `move`, and `retry_move` (planned) is Try again. Git and
  local installs can't reinstall themselves; the line says how to move by hand.
- **Labels, prefixes, env, registrations**: recovery agents 1.x started keep their labels and `isRecovery` accepts
  both; old batch and recovery prefixes in transcripts are recognised (`splitBatchText`, `isPluginPrompt`); sessions
  opened before the upgrade keep 1.x's env names, which the hook and bridge still read (the worker writes them with a
  prelude from `withRuntimePrelude`); the hook reconcile drops both markers; the bridge and the worker call the
  plugin under either id (`invokeSelf`).

## Data files (plugin-data/follow-up)

`updates.json` (mode, channel, dismissed notices, the waiting update, provenance and notes caches),
`registry.json` (the last npm answer), `updates.jsonl` (every install step), `heartbeat.json`,
`update-watchdog.mjs` and `update-watchdog.lock`.

## Testing

- Unit tests: `tests/updater.test.ts`, `tests/update-registry.test.ts` and `tests/update-policy.test.ts`.
- End to end: an isolated daemon installs from a fake npm registry (`npm_config_registry`). It runs good, untrusted
  and failing versions, with `FOLLOW_UP_UPDATES_FAST=1` for short timings (quiet 90 s, probation 60 s). Never point
  it at the live daemon.
