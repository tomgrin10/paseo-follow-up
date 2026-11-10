# Resources: never wake agents, stay within budgets

This host runs many agents inside one memory-limited Paseo cgroup. Follow-up must cost almost nothing when idle.

## Never wake a dormant agent

Reading an unloaded agent's timeline (`fetch_agent_timeline`) or its provider subagents goes through the daemon's
`ensureAgentLoaded`. That resumes the agent (the provider CLI plus every MCP server, about 650 MB) and keeps it
loaded for an hour.

- **Check first.** `isLoaded()` in `shared/agent-load.ts` is the check. A snapshot without `activeTurn` is a stored
  projection, so treat it as unloaded. When in doubt, don't wake it.
- **Read from disk instead.** `server/transcript.ts` reads an unloaded agent's recent steps from the provider
  transcript on disk, read-only: the last 512 KB, never credentials.
- **The active window.** `server/agent-load.ts` defines it (`workspaceActive`, `activeWindowMs`; default
  `DEFAULT_ACTIVE_WINDOW_DAYS` = 3 days) and `conversationGone`. Dormant workspaces get no observation, and auto-send never
  targets an unloaded or long-unused agent.
- **Ask only when needed.** Provider subagents are asked about only when a send is due or awaiting
  acknowledgment, or completion is being checked.
- **Finding what woke an agent.** Every wake goes through a timeline or subagent read: `paseo.agents.ref(id).timeline`
  or the `PaseoGateway` methods in `server/daemon.ts`. Grep those call sites for a missing `isLoaded()` or active
  window check. Reproduce with `npm run test:scale`, which reports loaded agents before and after, then pin the fix
  with a counting fake in `tests/never-wake.test.ts`.
- **Tests:**
  - `tests/never-wake.test.ts` counts the reads a daemon would turn into wake-ups.
  - `tests/daemon-load.test.ts` covers the directory and polling.
  - `npm run test:scale` (`scripts/scale-check.mjs`) runs an isolated daemon with 120 workspaces, 5 awake and 35
    churned, and fails if the loaded-agent count grows. Budgets: 240 MB RSS, 3 % CPU, 2 idle daemon requests a
    minute. `scripts/daemon-counter.mjs` counts the requests, and `scripts/heap-summary.mjs` summarises a heap
    snapshot.

## Polling

- **Daemon lists.** The directory (`server/directory.ts`) is the only reader of Paseo's lists. Events patch it; a
  dirty directory re-reads at most once a minute, and a clean one every 10 minutes.
- **The client.** The live store (`client/live.tsx`, `client/inbox-store.ts`) polls every 15 s as a backstop, with a
  push `nudge` when Paseo's agent stream reports a change. The client never polls while the app is hidden
  (`client/visibility.ts`).
- **Diffed answers.** List and inbox answers are diffed or etagged ([architecture.md](architecture.md)).
- **No polling by default.** Reviewer suggestions, provider catalogs, onboarding checks and release notes are read
  on demand and cached.

## Worker memory

- **No-op mutations are skipped.** `Store.mutate` and `Store.mutateWorkspace` (`server/store.ts`) compare the draft
  with `sameJson`. An unchanged draft writes, re-validates and derives nothing.
- **Mutate one workspace when you can.** `mutateWorkspace(id, work)` copies only that workspace, not the whole
  state. Use it in per-workspace loops like the engine's tick.
- **One GC after the first tick.** `compactHeap()` (`server/memory.ts`) runs one compacting GC after startup and
  the first engine tick, so the worker doesn't idle at its startup peak. Guarded by `tests/store-idle.test.ts` and
  `test:scale`'s RSS budget.

## The resource governor

`server/governor.ts` (`Governor`) and `shared/resources.ts`:

- **Samples.** It reads Paseo's cgroup working set (`memory.current` minus `inactive_file` and `slab_reclaimable`)
  against `memory.high`, plus PSI memory and CPU pressure.
- **Levels** (`governorLevel`):
  - `constrained`: memory ≥ 75 %, or pressure (memory ≥ 10, CPU ≥ 60). Background work waits: engine ticks,
    auto-sends, AI jobs, the Overseer digest.
  - `critical`: memory ≥ 85 %. Extras stop too: the inbox's background reads and usage meters.
- **Home's meter.** `follow.usage` returns `resources` for Home's meter.

## Usage meters

`server/usage.ts` (`UsageReader`) and `shared/usage.ts`:

- It reads provider limits from Smart Session's `smart-session.subscriptions` and `smart-session.budget` RPCs at most
  once a minute, or the newest rows of its accounts file.
- It never asks ZeroSub to refresh or switch.
- When Smart Session isn't installed, the meters are hidden.

Tests: `tests/governor.test.ts`, `tests/incremental.test.ts`, `tests/list-cache.test.ts`, `tests/closed-sessions.test.ts`.
