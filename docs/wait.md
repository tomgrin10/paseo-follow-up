# Wait for background jobs

This was the standalone paseo-wait plugin, folded in at 1.4.0-beta.24. Claude agents often start a long command in
the background and end the turn "waiting for a notification". Wait lets them hold for the result instead.

## How it works

1. `wait_prepare_job({description, command})` records a job and returns the exact `bashCommand`. It runs nothing.
2. The agent runs that command with native Bash and `run_in_background=true`. The command is the runner
   (`wait/run-job.sh`, from `server/wait-runner.sh`) wrapping the agent's command.
3. `wait_for_job({jobId, max_wait_seconds})` holds for up to 180 s (default 60). It returns `completed` or `failed`
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
- **Ownership.** Each job is scoped by the daemon's agent id and cwd. A tool input with an `agentId` is rejected.
- **Stop and new messages.** Stop cancels the wait, and a new message ends it with `new_message`. Neither kills the
  job.
- **Ceiling.** `HARD_MAX_WAIT_SECONDS` is 180. Before raising it, prove a full-length call end to end with
  `npm run test:wait-long`. Paseo gives a plugin tool call 10 minutes, but Claude Code's HTTP MCP transport has its
  own request timeout (`MCP_TOOL_TIMEOUT`, 60 s by default).
- **Claude only.** Codex's `tool_timeout_sec` defaults to 60 s, so Wait isn't offered there. Wait sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` and `FOLLOW_THROUGH_WAIT=1` for the session.
- **Guidance.** `waitInstruction` in `server/mcp.mjs` reaches the agent through the SessionStart hook
  ([hooks.md](hooks.md)).

## When it's off

- **Settings.** Settings → Agents → Background jobs switches it off (`enable_wait: false` in `agents.json`; RPC
  `follow.set-wait`, tool `set_wait_for_jobs`).
- **No double install.** While Paseo's `config.json` lists `paseo-wait` as installed and not disabled, Settings
  shows "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait".
- **No plugin tools.** On hosts that don't serve plugin tools (Paseo 0.14, or the agent MCP off), Settings explains
  it.
- **Labels.** It's also off for agents labelled `follow-up-wait/enabled=false`, `paseo-wait/enabled=false` or
  `plugin-tools/enabled=false`.

## Tests

- **Unit:** `tests/wait.test.ts` and `tests/wait-jobs.test.ts`.
- **Live:** `scripts/check-wait.mjs` (`npm run test:wait`, part of `test:install`) drives real Claude Haiku agents
  in an isolated in-process daemon. Cases: adoption, repeat, failure, stop, message, reload, standalone.
  - `--long` (`npm run test:wait-long`, about 4 minutes, not in `test:install`) adds `long`: one wait holds the full
    180 s ceiling to `still_pending` through Claude Code and Paseo's MCP, then the job completes.
  - It skips with exit 0 when there are no Claude credentials or Paseo is below 0.15 (CI).
  - `npm run test:wait-live` fails instead of skipping.
  - `--cases a,b` re-runs single cases.
  - Keep the adoption prompt free of Wait's tool names.
- **Client:** `client/agents.tsx` (`WaitSettings`).
