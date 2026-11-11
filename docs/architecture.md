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
`follow.answer-question`) are the model: see [needs-you.md](needs-you.md#answering-a-brief).

**Slow RPCs name themselves.** `server/rpc-timing.ts` wraps every handler: one that takes over a second logs
`[follow-up] slow rpc <method> <ms> ms (event loop since last: p99 …, max …)` to the plugin's output (daemon.log).
A long call with a small event-loop delay awaited something; a large delay means synchronous work blocked the worker.

Answers that the client polls are kept small:

- `follow.list` takes `since` (a revision) and returns only changed workspaces (`server/list-cache.ts`).
- `follow.inbox-list` takes an `etag` and returns `{ unchanged: true }` when nothing changed (`server/etag.ts`).

## The daemon, seen from the worker

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
- `server/store.ts`: `state.json` stays in memory once loaded. `mutate()` serializes changes. Writes are batched (at
  most one a second) and skipped when nothing changed. `onChanged` writes `scopes.json` for the hooks and the
  bridge.

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
