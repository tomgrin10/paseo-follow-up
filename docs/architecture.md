# Architecture: the worker, RPCs and the daemon

## The worker (`index.server.ts`)

`contribute(server)` runs once per plugin load, in one worker process for the whole daemon. In order, it:

1. Registers host settings: `displayPreferences` (`shared/display.ts`) and `questionPreferences`
   (`shared/questions.ts`).
2. Writes `tools-instance.json` synchronously, so the agent hook can tell when native tools were detached (see
   [native-agent-tools.md](native-agent-tools.md)).
3. Builds the stores and services:
   - `Store`: `state.json` in memory, with batched writes and the worker lock.
   - `PaseoGateway`: `server/daemon.ts`, Follow-up's view of the daemon.
   - `Engine`, `Github`, `Graphite`, `PrActions`, `BrowserBridge`.
   - The reviewer, PR workflow and agent settings stores.
   - `Inbox`, `Overseer`, `Ranker`, `AboutService`, `AiJobs`.
   - `Governor`, `Wait`, `TrustBypass`, `OnboardingStore`, `VersionsStore`.
4. Wraps `server.handle` in a local `handle()` that also records each handler in a `handlers` map. Native agent tools
   call that map in-process, so the stdio bridge and native tools run identical code. Calls in `MAIN_WORK` (sync,
   register-pr, obligation, done…) by a successor main agent also make a pending handover stick.
5. Starts `ready`. It decides fresh vs existing install for onboarding, takes the worker lock, writes the bridge
   (`plugin-data/follow-up/mcp.mjs`), and removes old global MCP registrations. Then it starts the governor,
   recovers interrupted sends (`engine.recover()`), runs the one-time migrations (each backs `state.json` up to a
   `*.bak` first), seeds reviewers and the PR workflow, and installs provider hooks with a 30 s lease heartbeat.
6. Starts two loops:
   - `engine.tick()` every 15 s: discovery, PR observation, batches, auto-send, the Done label.
   - `inboxLoop` every 15 s: inbox tick, permission reconcile, Session Guard, the Overseer digest, the ranker's
     scheduled run.
   - Both skip work the governor holds back.
7. Subscribes to lifecycle events. `server.on` handles the `agent.*` and `workspace.*` events that patch the
   directory and feed the inbox. `agent.permission_requested` also feeds trust bypass. `server.before`
   handles `agent.session_open`, which attaches tools (`withTools`, wrapped by `withWait`).
8. Returns a teardown that stops timers, Wait, the governor and AI jobs, removes hooks, and flushes the store.

## RPCs

Every call is a `defineRpc` contract in `shared/contracts.ts`, named `follow.<name>`. The client calls them with
`client.rpc(contract, input)`. Agents reach them through:

- `follow.agent-act`: one entry for every action tool. It dispatches to `AgentActions` (`server/agent-actions.ts`)
  or `RPC_TOOLS` (`server/agent-parity.ts`).
- `follow.overseer-act`: the Overseer's routing tools.
- Each core tool's own RPC, e.g. `follow.register-pr`.

The full list, with the client surface and agent tool for each, is in [rpcs-and-tools.md](rpcs-and-tools.md).

To add an RPC:

1. Add the contract to `shared/contracts.ts`.
2. Add the handler with `handle(rpc.xRpc, …)` in `index.server.ts`.
3. If the client calls it, add a `PARITY` entry in `server/agent-parity.ts` (a tool, or an exemption with a reason).
4. Add a line in [rpcs-and-tools.md](rpcs-and-tools.md). `tests/docs.test.ts` checks it.

**Every client RPC replies fast.** Paseo gives a plugin RPC 30 s, then shows the developer "Plugin RPC timed out"
whatever the handler does next. A handler records the developer's action and returns; anything that waits on Paseo
(sending to an agent, which may first resume a dormant one), GitHub or the daemon runs after the reply, or is
queued durably and retried. `tests/rpc-ack.test.ts` runs every client RPC against the real worker with Paseo, the
daemon socket and gh hanging, and fails on one that doesn't reply within 500 ms; the ones that still wait are in its
`EXEMPT` list with a reason, and that list only shrinks. The answer paths (`follow.brief-action`,
`follow.answer-question`) are the model: see [needs-you.md](needs-you.md#answering-a-brief). Reads the client polls
answer from what the worker already holds and refresh after, so the next poll carries the refresh: Needs you's list
serves the last directory snapshot (only a first list, with none yet, waits up to 300 ms, then says it's still
loading), the usage meters serve their last reading, and a Summary's open waits up to 300 ms for its inputs, then says
pending and the client asks again after 500 ms, backing off to 3 s. Both caches are primed when the worker starts. `tests/rpc-cached.test.ts` hangs each slow side.

**Slow RPCs name themselves.** `server/rpc-timing.ts` wraps every handler: one slower than the 500 ms ack budget (`RPC_SLOW_MS`) logs
`[follow-up] slow rpc <method> <ms> ms (event loop since last: p99 …, max …)` to the plugin's output (daemon.log).
A long call with a small event-loop delay awaited something; a large delay means synchronous work blocked the worker.

Answers that the client polls are kept small:

- `follow.list` takes `since` (a revision) and returns only changed workspaces (`server/list-cache.ts`). It
  serialises only a workspace whose object changed (`a-list-answer-serializes-only-what-changed`): the store keeps an
  unchanged workspace's frozen object, so the same object is skipped.
- `follow.inbox-list` takes an `etag` and returns `{ unchanged: true }` when nothing changed (`server/etag.ts`).

## The daemon, seen from the worker

Timeline reads parse every entry they fetch, and live entries carry tool output (8 KB is common), so each entry is
read once (`a-rescan-reads-only-new-entries`, `a-turn-end-reads-the-turn-once`). Discovery rescans a running agent
every 15 s by reading forward from the cursor it cached (`readSince`, `direction: "after"`, plus a 25-entry overlap),
not the newest 100 entries. A turn end reads its own turn back to the item that started it, in pages of `TURN_PAGE`
and at most `TURN_READ_CAP` entries, and the engine's and the inbox's handlers share that one read (`turnItems`,
`server/inbox-directory.ts`).

- `server/daemon.ts` (`PaseoGateway`):
  - lists agents, workspaces and projects;
  - observes a workspace's main agent (busy, loaded, recent, gone);
  - sends repair prompts;
  - labels Done;
  - reads bounded timeline tails, only for loaded agents.

  It also holds `withDaemon`, `paseoHome` and `clientEntry` (the daemon client the bridge uses), and the main-agent
  choice helpers (`chooseMainAgent`, `successorMainAgent`, `handBackMainAgent`).
- `server/directory.ts` (`DaemonDirectory`) is the one in-memory copy of Paseo's agent, workspace and project lists.
  Discovery, runtime checks, the inbox, the Overseer and every client RPC share it.
  - Lifecycle events patch it.
  - A dirty directory re-reads at most once a minute; a clean one, every 10 minutes.
  - Before anything that could load an agent, re-read that one agent.
- **Per-tick I/O** (2026-11-12: a live worker read ~49 MB/min, ~38 MB of it two other plugins' files re-read per
  workspace per tick, and opened a daemon WebSocket per workspace per tick, 96/min):
  - `server/shared-file.ts` (`readSharedJson`): Session Guard's `state.json` and Smart Session's `compactions.json` are
    read and parsed again only when their inode, size or mtime changes; the parsed value is shared and read-only
    (`observe-reads-shared-files-once-per-tick`).
  - `sharedDaemon` (`server/daemon.ts`): `PaseoGateway` (and its directory) share one daemon connection, so a tick
    opens at most one whatever the workspace count (`one-daemon-connection-per-tick`). It sits in the same client set
    as `withDaemon`'s, so `closeConnections` closes it within `stopWorker`'s deadline and nothing opens after stop.
  - **A running worker holds one daemon connection** (`a-running-worker-holds-one-daemon-connection`). The shared
    connection closes only after `SHARED_CLIENT_IDLE_MS` unused: the engine's `TICK_MS` plus `SHARED_CLIENT_MARGIN_MS`
    (10 s), so consecutive ticks reuse it; a dropped one is retired at once, and `SHARED_CLIENT_MAX_MS` (30 min)
    replaces a long-lived one. One idle timer per connection, not one per call. 2026-11-13 live: with a 5 s idle close
    and a 60 s replacement every 15 s tick opened a fresh WebSocket (39 hellos in 12 min). Guarded by
    `tests/daemon-connection.test.ts` (a drift check against `TICK_MS`, and 10 ticks open exactly one connection).
  - `InboxStore` keeps what `inbox.json` holds after the first read; it's the file's only writer. Its mutations copy
    only the entries they touch (`a-mutation-copies-only-what-it-changes`, below), and the worker writes the file at
    most once per `INBOX_WRITE_MS` (2 s, `the-inbox-writes-at-most-once-per-window`, below).
  - Guarded by `tests/observe-io.test.ts`.
- `server/store.ts`: `state.json` stays in memory once loaded. `mutate()` serializes changes. Writes are batched (at
  most one a second) and skipped when nothing changed. `onChanged` writes `scopes.json` for the hooks and the
  bridge.
- **Only real changes are written** (`store-writes-only-real-changes`). PR read timestamps (`snapshot.observedAt`,
  `deployment.observedAt`) and discovery's history scan time (`inventory.scannedMessageAt`, which nothing reads back;
  4 of 7 live writes moved only it) are volatile: a mutation that changes nothing else stays in memory and reaches
  `state.json` with the next real change, after `VOLATILE_WRITE_MS` (5 min), or on close. `InboxStore` writes compact
  JSON, skips unchanged states, and holds a lastSeen-only change for up to `LAST_SEEN_WRITE_MS` (5 min); the worker's
  stop flushes it (`stopWorker`). 2026-11-12, live: 17 of 19 `state.json` writes (1.3 MB each) only moved read
  timestamps, and 14 of 14 sampled `inbox.json` writes were lastSeen-only or identical. Guarded by
  `tests/store-writes.test.ts`.
- **A tick copies the state at most once** (`a-tick-copies-the-state-at-most-once`). The engine's per-workspace writes
  use `mutateWorkspace` (one workspace copied), never a whole-state `mutate`, and a tick runs inside `Store.batch`:
  its mutations apply in order in memory, and `state.json` is saved (or scheduled) and `onChanged` runs once, at its
  end (`MAX_HOLD_MS`, 10 s, commits a stuck tick's changes anyway). An untouched workspace (same state object, same
  runtime, no new PR read, full pass under `OBSERVE_FULL_MS`) isn't copied at all, and `statusCheck` skips it until
  its inputs change or the 5-minute sweep. A save validates only the workspaces that aren't the objects it last
  validated (`Store.validate`), so unchanged workspaces keep their identity; tests also parse every write whole
  (`FOLLOW_UP_STORE_FULL_VALIDATION`). The directory's agents are indexed once per snapshot (`agentIndex`), and
  `InboxStore.snapshot` is shared and deep-frozen; a quiet `Inbox.tick` records lastSeen without copying the inbox
  (`touchLastSeen`). 2026-11-12, live 2.0.1-beta.2: a cold-start tick copied the 1.7 MB state ~150 times, and the
  worker sat at ~450 MB RSS (85 MB live heap). Guarded by `tests/tick-copies.test.ts`, the agent-index test in
  `tests/never-wake.test.ts`, the quiet-tick test in `tests/inbox.test.ts` and `test:scale`.
- **A nudge costs its workspace** (`a-nudge-costs-its-workspace`). `Engine.nudge` (a turn end, an action, a tool that
  registered a PR) runs a tick scoped to the nudged workspaces: their PRs are read, only they are observed, and their
  discovery is `PaseoGateway.discover` with `scope`, which places only those workspaces and rescans only their dirty
  agents whose turn read is still kept (`TurnTimeline.since`). It makes no daemon request, so a PR the turn just
  opened shows at once. Each row is applied with `mutateWorkspace` (`Engine.discoverScoped`), never a whole-state
  `mutate`. A dirty agent without a kept read (expired after `TURN_READ_KEEP_MS`, or no cursor yet) stays dirty for the
  timer's tick, which still discovers and observes everything. A nudged workspace that needs the whole state (not yet
  saved, parked by the active-scope migration, or the migration not yet run) gets the full discovery instead.
  2026-11-13, run Y (the CI live shape, 140 workspaces): every turn end's nudge ran discovery over all 140 workspaces,
  a whole-state copy and an observation of every workspace, and the busy window grew V8's committed pages from 87 to
  165 MB. Guarded by `tests/nudge-costs-its-workspace.test.ts` (20 nudges of 1 of 140: no full discovery, no
  whole-state copy, no timeline read beyond the turn's own).
- **A send never clones the whole state** (`a-send-never-clones-the-whole-state`). A send's claim, recipient, sent and
  acknowledgment writes, an answer's delivery writes and an agent's turn events (`server/turn-events.ts`: a superseded
  hold, the Done a turn ends, a woken dormant workspace, the history and Stop hold at turn end) each write the one
  workspace they are about with `mutateWorkspace`; no turn event walks every workspace. A whole-state `mutate` that
  remains (discovery, settings) hands back the saved object of every workspace it didn't change, so the next save
  validates only the changed ones. 2026-11-13, #139 fair-seed `test:scale`: 6 sends copied the 2 MB state for every
  write (93 MB) and made the next save re-validate all 140 workspaces (47 MB); RSS went 227 → 342 MB and stayed.
  Guarded by `tests/send-clones.test.ts` and `test:scale`.
- **A mutation copies only what it changes** (`a-mutation-copies-only-what-it-changes`; it generalises
  `a-send-never-clones-the-whole-state` to every store). Every store hands a mutation a copy-on-access draft
  (`server/cow.ts` `copyOnAccess`): a top-level field is copied when the mutation first reads it, and an item of a
  keyed collection (state workspaces, inbox entries, linked workspaces, Summary entries) when that item is first read.
  `finish()` builds the next value from the saved one, keeps every untouched or unchanged item's saved (frozen) object,
  and says what changed; the store validates and freezes only that, writes nothing when nothing changed, and
  serialises the file once per real write. `Store.mutate`, `InboxStore.mutate` and `JsonFileStore`
  (`server/json-file-store.ts`: `about.json`, `linked.json`, `rename.json`, read once and kept in memory; a stat per read
  picks up someone else's edit) use it. 2026-11-13 live (2.0.1-beta.4, 153-PR workspace, 86 inbox entries): every inbox
  mutation structuredCloned, validated and stringified the whole inbox 4–5 times, several mutations per agent turn;
  under live's turn rate that was 28% of the worker's 4.3 MB/s of allocation, and RSS stepped 315 → 405 MB with a
  harness-sized JS heap. Guarded by `tests/inbox-copies.test.ts`, `tests/store-copies.test.ts` (it walks every JSON
  writer in `server/`: a new store must use the draft or carry an exemption with its reason) and `test:scale`'s busy
  window.
- **A send lists agents at most once per tick** (`a-send-lists-agents-at-most-once-per-tick`). The engine starts each
  tick on the gateway (`tickStarted`); a decision that needs current status (`fresh: "agents"`, before a send)
  re-lists agents once in that tick and then reads that list, which lifecycle events keep patched. Within the tick a
  listed "loaded" row is trusted without a `fetch_agent`, each agent's subagents are listed at most once, and the send
  reads its recipient and the recovery-labelled agents from the list. 2026-11-13: each send listed every agent three
  times and fetched its recipient (46 daemon requests a minute for 6 sends). Guarded by `tests/daemon-load.test.ts`
  and `test:scale`.

## Lifecycle of an agent session

At `agent.session_open` (`purpose: "interactive"` only), the worker decides the agent's role:

- **Overseer**: labelled `follow-up.overseer=1`.
- **Tracked main**: the workspace's `mainAgentId`.
- **Contributor**: another root agent of a tracked workspace.
- **Recovery**: the agent Follow-up launched to run a recovery batch (labelled `follow-up.recovery`, and the
  batch's `recipientAgentId`). It isn't a root agent. It gets `FOLLOW_UP_RECOVERY=1` and the reduced core set.
- **Untracked root**: a root agent in a workspace Follow-up doesn't track.
- **Subagent**: anything else. It gets no Follow-up tools.

`withTools` then attaches the matching tool set natively, or through the per-launch stdio bridge, and sets the
`FOLLOW_UP_*` env flags that the hook reads. The full list is in [hooks.md](hooks.md#env-flags). `withWait` adds Wait's tools to every interactive Claude session on top ([wait.md](wait.md)).
