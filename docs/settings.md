# Settings, onboarding, release notes and trust bypass

## Where settings live

| Setting | Stored in | Code |
| --- | --- | --- |
| Display (header button, sidebar item, composer pill, inbox, closed-PR flags, brief nudge, Overseer, ranker, trust bypass, Home's order) | Paseo host settings document `display` (`displayPreferences`). It's host-scoped and keeps older saved sidebar values. | `shared/display.ts`, `client/display.tsx` |
| Question mode | host settings `questionPreferences` | `shared/questions.ts` |
| Following, projects, per-workspace exceptions, active window | `state.json` | `shared/settings.ts`; RPCs `follow.follow-settings`, `follow.set-follow-settings`, `follow.project-settings`, `follow.set-project-tracking` |
| Agents and Wait | `agents.json` | [ai-roles.md](ai-roles.md), [wait.md](wait.md) |
| Shipping PRs | `pr-workflow.json` | [prs.md](prs.md) |
| Reviewers | `reviewers.json` | [prs.md](prs.md) |
| View state: settings category, settings folds, Home group folds, What's new "seen" | Paseo 0.16 device settings document `follow-up-view`, with localStorage as the first-paint cache; on 0.15, localStorage (memory on the phone) | `client/view-store.ts`, `shared/settings-nav.ts` |

- **Booleans** use positive `enable_` names. Fields only ever gain defaults, so documents saved by older versions
  keep parsing.
- **Home's order** is the Display field `home_sort` (absent until first chosen, read as Priority). The sort menu on
  Home and in the sidebar view writes it, so the order is the same on every device, and `set_display` sets it with
  `{ values: { home_sort: "recent" } }`.
- **Display fields** are read and written by agents through `display_settings` and `set_display`
  (`DISPLAY_TOOLS` in `server/agent-parity.ts`, PARITY key `settings.display`).
- **View state is per device; settings are per host** (invariant 22, `view-state-is-per-device-settings-are-per-host`).
  View state is how this screen looks on this device: the settings category, which sections are folded, Home's group
  folds and the What's new version last seen. On Paseo 0.16 it lives in the device settings document `follow-up-view`
  (`{ migrated, entries }`, keyed by the old localStorage names). The worker and agents never see it, so it has no
  tool and no PARITY entry. Anything an agent can set stays host-scoped: `home_sort` is a Display field on purpose
  (`tests/view-settings.test.ts` fails if it ever moves to a device document).
  - **Where 0.16 keeps a device document.** The app stores it with AsyncStorage under
    `@paseo:plugin-device-settings:follow-up/follow-up-view`. On web and desktop AsyncStorage is `window.localStorage`,
    which is where Follow-up already kept this state, so nothing changes there. On the phone it is native storage:
    the category and folds now survive reopening the app (before, they were memory only). A plugin reinstall keeps
    it; an app reinstall or cleared app data does not.
  - **No flash.** Reads take the document's value once it loads, else the localStorage cache, and every reader
    re-renders when the document arrives (`useViewVersion`). The first paint is the cached value, never the default.
    What's new waits for the document before deciding, so it never shows from a stale "seen".
  - **Migration.** The first time a device loads an empty document, it copies its view keys from localStorage and
    marks it `migrated: true`; a migrated document is never overwritten. Writes still go to localStorage too, as a
    cache and a downgrade path, for one release.
  - **Home group folds** persist per device, except Needs you: it opens on every mount, and closing it holds only for
    that mount. Quiet starts closed until the developer opens it.
  - **0.15.** `useSettings` is missing there, so nothing syncs and view state stays in localStorage, else memory.
  - **Manual check (the harness can't drive the phone):** on the phone app, pick a settings category and fold a
    section, close the app fully, reopen it: the same category and folds come back.
- **The settings screen.** `client/settings.tsx` (categories), `client/settings-shell.tsx` (collapsible blocks) and
  `shared/settings-nav.ts` (categories, summaries, saved view state). Settings open through Paseo's settings screen
  `projects`; legacy screen ids still map there.

## Adding a setting

First, pick where it lives:

- **A host-wide switch for what Follow-up shows or does** (most switches) goes in `displayPreferences`. Add a field
  with a default to the schema in `shared/display.ts` and a row in `client/display.tsx`.
  - No new RPC is needed: the client uses the host's `settings.display` document.
  - Agents get it for free through `display_settings` and `set_display`, so there's no new tool.
  - The server reads it with `displaySettings.read()`, and an unreadable document means defaults.
- **Something that configures one of Follow-up's agents** goes in `agents.json`, as `enable_wait` does.
  1. Add the field to `AgentSettingsFile` and `parseAgentSettings` in `shared/agent-settings.ts`, and to the view
     schema.
  2. Add a getter and setter to `AgentSettingsStore` in `server/agent-settings.ts`. Write the field only when it
     differs from the default.
  3. Add a dedicated RPC in `shared/contracts.ts` (like `follow.set-wait`) and its handler in `index.server.ts`.
     Return the full agent settings view.
  4. Add a planned `RPC_TOOLS` entry and a `PARITY` entry in `server/agent-parity.ts`, the tool tuple in
     `server/mcp.mjs`, the name in `AGENT_TOOLS` (`server/agent-actions.ts`), and the tool count in
     `tests/mcp-usage.test.ts`. Then run `npm run prepare`.
  5. Add the UI in `client/agents.tsx` (a per-job control goes in the row's More, `RoleMore`) and the copy in `shared/`.
  6. Add tests in `tests/agent-settings.test.ts`, lines in [rpcs-and-tools.md](rpcs-and-tools.md) and here, and
     `changes/<branch>.md`.
- **Following, projects or per-workspace settings** go in `state.json`, through `follow.set-follow-settings` and
  `shared/settings.ts`.

## Getting started (onboarding)

- **Files.** `shared/onboarding.ts` defines the steps (`ONBOARDING_STEPS`: intro, checks, defaults, shipping,
  reviewers, updates, helpers, tour), install detection and the checks schema. `server/onboarding.ts` holds `OnboardingStore`
  (`onboarding.json`) and `ReadinessChecks`.
- **Fresh or existing install** is decided once, before anything writes state. A host with any Follow-up data is
  existing and only gets an offer.
- **An unreadable file counts as finished**, so setup is never forced. While setup is open on a fresh install,
  auto-sends are held (`holdsAutoSends`).
- **Readiness checks** run on demand, cached a minute (`fresh` re-runs them):
  - `gh api user`;
  - the provider snapshot;
  - Paseo's `config.json`;
  - the count of `hook-state/native-*.json`.
- **Choices** write through the same RPCs the Settings screen uses.
- **Helper agents step and Settings → Agents share one component.** `client/job-rows.tsx` (`JobRows`) renders both;
  `shared/job-rows.ts` decides what each row says (`jobRow`: what the job does, the current pick, the Recommended
  chip, the need line, an amber line when the saved provider can't run here), the header (`jobsHeader`, with Use
  recommended) and what Use recommended saves (`recommendedEntry`: provider, model and effort only; limits and
  schedule stay). The surfaces differ only in order (`SETUP_ORDER`, `SETTINGS_ORDER`), Settings' per-row More
  (Permissions, limits, AI priority's schedule, Reset to defaults) and setup's `preselect`, which fills in a
  recommendation only for a job with nothing saved whose default can't run here. `tests/job-rows.test.ts` fails if
  either surface grows row content of its own.
- **The tour** ("Where to find things") is its own last step.
- **RPCs:** `follow.onboarding`, `follow.set-onboarding`, `follow.onboarding-checks`. **Tools:**
  `onboarding_status`, `onboarding_checks`, `set_onboarding`. **UI:** `client/onboarding.tsx`.

## Release notes, What's new and updates

- **Release notes.** `shared/changelog.ts` parses `CHANGELOG.md` and picks the What's new notes.
  `shared/version.ts` orders versions (semver with prerelease identifiers) and selects channels.
- **Only a major version gets a popup.** `announcesUpdate(from, to)` in `shared/changelog.ts` is the one rule for
  every prompt about Follow-up's own updates: true only when a new major is released (1.x to 2.0.0; a 2.0.0 beta still
  counts as 1.x). What's new and any update notice or prompt must go through it; everything else is recorded quietly
  or shown as a Settings row, never a sheet or toast. Home's "Updated to X · What's new" needs notes of X's own. The
  invariant is `update-announcements-major-only`, and `tests/update-announcements.test.ts` has a grid test: add any
  new update surface to it.
- **The installed version.** `server/release-notes.ts` reads Follow-up's own install row from the daemon's plugin
  list (`describeSelf`) and the package's `CHANGELOG.md`. It records `versions.json`: the current version, the
  previous one, and the host-wide "seen" record.
- **RPCs:** `follow.release-notes` (tool `release_notes`) and `follow.whats-new-seen` (exempt from parity: it records
  a person closing the sheet).
- **UI:** `client/release-notes.tsx` shows What's new after an update and the full list. A curated note's images load by URL (the app may be a phone away from the host), never wider than their CSS size, at the shape the URL gives; one that fails to load is left out. A tap opens it in Follow-up's image viewer (`client/image-viewer.tsx`) over the notes, never in a browser tab; Esc or a click closes the viewer before the notes. From 1280px windows the notes use a wider dialog of their own (840px, text lines capped at 600px, screenshots the full width), drawn like the host's, whose Modal is 520px wide with no way to widen it; below that, the host's dialog, and the host's sheet on phones. The version marker at the top of Home and the panel (`VersionMark` in `client/updates.tsx`, text from `versionMark` in `shared/updates.ts`) shows only the running version, with no word or dot for the update state. Tapping it opens Settings → General, which shows the update state, Release notes and What's new.
- **Self-update** (check npm, install, watch, roll back) is in [updates.md](updates.md).
- How notes get written is in [releasing.md](releasing.md).

## Trust bypass

`server/trust-bypass.ts` (`TrustBypass`), on `agent.permission_requested`:

- **What it approves.** When the agent's current mode is `bypassPermissions` (Claude) or `full-access` (Codex), it
  approves plain tool permissions that Claude Code still prompts for (compound `cd … && git`, writes under `.git/`,
  and so on). Each approval is logged, redacted, to `trust-bypass.jsonl`.
- **What it never answers:** questions, plan approval, MCP elicitation or auth, or any other mode.
- **The switch.** Display `enable_trust_bypass`, on by default.
- **RPC:** `follow.trust-bypass`, today's count and the recent approvals (tool `trust_bypass_status`).
- **Tests:** `tests/trust-bypass.test.ts` and `npm run test:trust` (a real daemon, in CI).
