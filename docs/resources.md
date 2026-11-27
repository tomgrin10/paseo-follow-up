# Resources: never wake agents, stay within budgets

This host runs many agents inside one memory-limited Paseo cgroup. Follow-up must cost almost nothing when idle.

## Never wake a dormant agent

Reading an unloaded agent's timeline (`fetch_agent_timeline`) or its provider subagents goes through the daemon's
`ensureAgentLoaded`. That resumes the agent (the provider CLI plus every MCP server, about 650 MB) and keeps it
loaded for an hour.

- **Check first.** `isLoaded()` in `shared/agent-load.ts` is the check. A snapshot without `activeTurn` is a stored
  projection, so treat it as unloaded. When in doubt, don't wake it. `isLive()` is "running for Follow-up": mid-turn,
  starting, or with Paseo 0.16 background work (`backgroundCount`; absent, zero or malformed counts read as none).
- **Read from disk instead.** `server/transcript.ts` reads an unloaded agent's recent steps from the provider
  transcript on disk, read-only: the last 512 KB, never credentials.
- **The active window.** `server/agent-load.ts` defines it (`workspaceActive`, `activeWindowMs`; default
  `DEFAULT_ACTIVE_WINDOW_DAYS` = 3 days) and `conversationGone`. Dormant workspaces get no observation, and auto-send never
  targets an unloaded or long-unused agent.
- **Requested messages arrive.** A time trigger or `wait_for_checks` verdict is the exception: sending resumes
  the agent even when its runtime was unloaded (`closed`), including after an hour idle. A running turn waits;
  an archived workspace, archived agent or gone agent cancels. Nudges, repairs, briefs and auto-sends keep the
  normal rule. See invariants 1, 71 and 121.
- **Ask only when needed.** Provider subagents are asked about only when a send is due or awaiting
  acknowledgment, or completion is being checked.
- **Finding what woke an agent.** Every wake goes through a timeline or subagent read: `paseo.agents.ref(id).timeline`
  or the `PaseoGateway` methods in `server/daemon.ts`. Grep those call sites for a missing `isLoaded()` or active
  window check. Reproduce with `npm run test:scale`, which reports loaded agents before and after, then pin the fix
  with a counting fake in `tests/never-wake.test.ts`.
- **Tests:**
  - `tests/never-wake.test.ts` counts the reads a daemon would turn into wake-ups.
  - `tests/daemon-load.test.ts` covers the directory and polling.
  - `npm run test:scale` (`scripts/scale-check.mjs`) runs an isolated daemon on the realistic seed (140 workspaces,
    ~280 agents, 5 awake, a live-shaped state and a fake GitHub) and fails if the loaded-agent count grows. Budgets
    (reasoning in AGENTS.md, invariant 2): peak RSS from the worker's start and idle RSS each derived from CI's own readings (`scripts/scale-budget.mjs`), 3 % CPU, 2 idle
    daemon requests a minute. `scripts/daemon-counter.mjs` counts the requests, `scripts/heap-summary.mjs` and
    `scripts/heap-retainers.mjs` read a heap snapshot, and `--cpu-prof` / `--alloc-prof` attribute CPU and garbage
    ([docs/testing.md](testing.md)).

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
- **One GC after the first tick.** `compactHeap()` (`server/memory.ts`) runs one memory-reducing GC after startup
  and the first engine tick, so the worker doesn't idle at its startup peak. Guarded by `tests/store-idle.test.ts` and
  `test:scale`'s RSS budget.
- **Memory returns after a burst** (`memory-returns-after-a-burst`). A busy period (agent turns, an open app, PR and
  check updates) grows V8's young generation to its 128 MB cap, and V8 keeps those pages after it shrinks. Only a
  memory-reducing collection (`gc({ type: "major", flavor: "last-resort" })`) returns them; a plain `gc()` doesn't.
  `watchMemory()` starts after the first tick: its `HeapSettler` runs one when RSS is 48 MB over where the last one
  left it, the worker has had a quiet minute (the median of the minute's event-loop utilization samples and the latest
  sample under 1 %; burst samples run 2-14 %, gap samples 0.1-0.3 % with the worker's own ticks spiking to 6-12 % once
  or twice a minute, so a quiet minute's mean reads 1.2-1.6 % and the gate never reads the mean) and 2 minutes have
  passed. Busy for 10 minutes past the threshold, it runs anyway; one that gives back under
  8 MB doubles the wait (a runtime that ignores the flavor, as Node 20 does, or growth outside V8).
  - Cost: 57–96 ms with the event loop blocked and about 0.2–0.3 s of CPU per collection on a live-sized heap, about
    one per busy period.
  - Harness, live-sized, 3-minute bursts: 320–369 MB after each burst without it, 195–208 MB with it.
  - The young generation's cap is V8's default; `--max-semi-space-size` would lower it, but only as a flag on the
    process that starts the worker (Paseo does), not from inside the plugin.
- **The worker's memory in heartbeat.json.** Every minute `heartbeat.json` gets `memory`: `rssMb`, `heapUsedMb`,
  `heapTotalMb`, `externalMb`, `arrayBuffersMb`, `youngMb`, the last minute's median event-loop `utilization` and its
  `samples`,
  `quietSettles` and `forcedSettles` (settles a quiet minute allowed, and ones the 10-minute fallback forced), and the
  last five settles (`beforeMb`, `afterMb`, `ms`, `cpuMs`, `forced`). `version`, `at` and `error` stay as the
  installer's probation reads them. The 1 % quiet gate comes from the harness: on a host whose worker never idles under
  it, settles show up as forced, and `utilization` says by how much.

## The resource governor

`server/governor.ts` (`Governor`) and `shared/resources.ts`:

- **Samples.** It reads Paseo's cgroup working set (`memory.current` minus `inactive_file` and `slab_reclaimable`)
  against `memory.high`, plus PSI memory and CPU pressure.
- **Levels** (`governorLevel`):
  - `constrained`: memory ≥ 75 %, or pressure (memory ≥ 10, CPU ≥ 60). Background work waits: engine ticks,
    auto-sends, AI jobs, the Overseer digest. A read the developer starts still goes (invariant 106): a workspace's
    Refresh reads its PRs (no discovery, agent reads or sends), and PR stats' estimate and Refresh skip the governor
    step of the stats gate. `tests/developer-reads.test.ts` lists every `governor.allowsBackground()` in the worker
    with why no click goes through it.
  - `critical`: memory ≥ 85 %. Extras stop too: the inbox's background reads and usage meters.
- **Home's meter.** `follow.usage` returns `resources` for Home's meter.

## Usage meters

`server/usage.ts` (`UsageReader`) and `shared/usage.ts`:

- It reads provider limits from Smart Session's `smart-session.subscriptions` and `smart-session.budget` RPCs at most
  once a minute, or the newest rows of its accounts file.
- A read answers from the last reading at once and refreshes after (one refresh in flight, 20 s deadline); the
  client's next poll carries it. Only a read with nothing cached waits, at most 300 ms, then shows no meters.
- It never asks ZeroSub to refresh or switch.
- When Smart Session isn't installed, the meters are hidden.

Tests: `tests/governor.test.ts`, `tests/incremental.test.ts`, `tests/list-cache.test.ts`, `tests/closed-sessions.test.ts`.
