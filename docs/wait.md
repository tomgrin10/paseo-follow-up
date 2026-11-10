# Wait for background jobs

This was the standalone paseo-wait plugin, folded in at 1.4.0-beta.24. Claude agents often start a long command in
the background and end the turn "waiting for a notification". Wait lets them hold for the result instead.

## Paseo 0.16: retired

Paseo 0.16 advertises `features.agentBackgroundWork`: it tracks an agent's background shell jobs, shows them with
Stop, and wakes the agent when one finishes, at no model cost while it waits. On such a host Wait attaches no tools
and doesn't set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`. It sets `FOLLOW_THROUGH_BACKGROUND_WORK=1` instead, and the
SessionStart hook gives `backgroundWorkInstruction` (`server/mcp.mjs`): run it with `run_in_background=true`, end
the turn, confirm the exit code when woken. Settings shows why (reason `host`). The same switch, labels and
standalone check still apply. Everything below is Paseo 0.15. Delete Wait when Follow-up requires 0.16.

- `server/host-features.ts`: `hostFeature` reads the daemon's `server_info.features` once and keeps the first real
  answer. A failed read answers false, so Wait stays as on 0.15.

## How it works

1. `wait_prepare_job({description, command, timeoutSeconds?})` records a job and returns the exact `bashCommand`.
   It runs nothing. The time limit defaults to 3 h (at most 12 h) and is written to the job's `timeout` file.
2. The agent runs that command with native Bash and `run_in_background=true`. The command is the runner
   (`wait/run-job.sh`, from `server/wait-runner.sh`) wrapping the agent's command.
3. `wait_for_job({jobId, max_wait_seconds})` holds for up to 60 s (default 30). It returns `completed` or `failed`
   with the exit code, `still_pending`, or `new_message`.
4. `wait_get_job({jobId})` reads a job's status.

## Files

- `server/wait.ts`: the `Wait` class.
  - `open(request)` attaches the tools at session open.
  - `standaloneWaitInstalled` and `waitStatus` decide whether Wait is on.
  - `WAIT_TOOLS` lists the tools; `WAIT_LABEL` is `follow-up-wait/enabled`.
- `server/wait-jobs.ts`: `WaitJobs`, the job store under `wait/jobs/<agentId>/<jobId>/`.
- `server/wait-runner.sh`: the runner, generated into `server/wait-runner-source.ts`.
- `shared/wait.ts`: `waitStatusSchema` and the Settings copy.
- `index.server.ts`: `withWait` wraps the session_open handler; `currentWait` feeds Settings.

## Rules

- **Native tools only.** No loopback MCP, no process per agent or job. A wait holds two timers, plus at most one
  agent refresh a second to notice a new message, and only while it waits.
- **Proof of completion.** Only the runner's atomic exit receipt (`result.json`) proves completion. An elapsed wait
  or missing output is `still_pending`, never success. Symlinked or malformed receipts are rejected.
- **Time limit.** The runner runs the command under `timeout -k 30 <limit>`, so a job that never ends (an unbounded
  poll loop) can't keep the machine awake all night. Exit 124 writes `"timedOut": true` into the receipt, and
  `wait_for_job` says the command was stopped, not that it finished. A command that itself exits 124 reads as timed
  out too. Without `timeout(1)` (macOS) commands run unbounded, as before.
- **No escaped jobs.** GNU `timeout` moves the job into its own process group, so the runner starts it in the
  background and forwards TERM, INT and HUP to it. A TERM to the runner or to its whole group (Stop, Claude Code
  killing the background task) stops the job and still writes a receipt. The job's stdin is `/dev/null`.
- **Ownership.** Each job is scoped by the daemon's agent id and cwd. A tool input with an `agentId` is rejected.
- **Stop and new messages.** Stop cancels the wait, and a new message ends it with `new_message`. Neither kills the
  job.
- **Claude only.** Wait sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` and `FOLLOW_THROUGH_WAIT=1` for the session.
- **Guidance.** `waitInstruction` in `server/mcp.mjs` reaches the agent through the SessionStart hook
  ([hooks.md](hooks.md)).

## When it's off

- **Settings.** Settings → Agents → Background jobs switches it off (`enable_wait: false` in `agents.json`; RPC
  `follow.set-wait`, tool `set_wait_for_jobs`).
- **No double install.** While Paseo's `config.json` lists `paseo-wait` as installed and not disabled, Settings
  shows "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait".
- **Paseo 0.16.** Settings says the host runs background jobs itself (above).
- **No plugin tools.** On hosts that don't serve plugin tools (Paseo 0.14, or the agent MCP off), Settings explains
  it.
- **Labels.** It's also off for agents labelled `follow-up-wait/enabled=false`, `paseo-wait/enabled=false` or
  `plugin-tools/enabled=false`.

## Tests

- **Unit:** `tests/wait.test.ts`, `tests/wait-jobs.test.ts` and `tests/wait-host.test.ts` (0.16).
- **Live:** `scripts/check-wait.mjs` (`npm run test:wait`, part of `test:install`) drives real Claude Haiku agents
  in an isolated in-process daemon. Cases: adoption, repeat, failure, stop, message, reload, standalone.
  - It skips with exit 0 when there are no Claude credentials or Paseo is below 0.15 (CI).
  - `npm run test:wait-live` fails instead of skipping.
  - `--cases a,b` re-runs single cases.
  - Keep the adoption prompt free of Wait's tool names.
- **Client:** `client/agents.tsx` (`WaitSettings`).
