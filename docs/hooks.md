# Provider hooks

## Installing the hooks

`server/agent-hooks.ts` (`AgentHooks`):

- **What it installs.** It writes `agent-hook.mjs` (from `server/hook-source.ts`, generated from
  `server/agent-hook.mjs`) into `plugin-data/follow-up/`. It adds one command per event to Claude Code's
  `~/.claude/settings.json` and Codex's `~/.codex/hooks.json` for SessionStart, UserPromptSubmit, PostToolUse and
  Stop.
- **When it's written.** `AgentHooks.start()` rewrites `agent-hook.mjs` and the settings entries on every worker
  start (each plugin load or reload). `stop()` removes them at teardown.
- **Reversible.** Entries end with `# paseo-follow-up-hook`, and `reconcileHooks` removes them.
- **Written through symlinks.** Settings files are often symlinks (dotfiles, a shared account dir). Every write to a
  user-owned config file goes through `server/write-through.ts`: it resolves the path, then backs up and replaces the
  target, so a link stays a link. A dangling link is refused with an error naming the path; Follow-up never creates
  the missing target. `tests/write-through.test.ts` fails when a module that names a user config file writes it
  another way.
- **Never from a harness into a real home.** When `plugin-data/follow-up` is under the OS temp dir (a test or
  harness daemon), Follow-up skips, with a warning, any settings file outside the temp dir, whatever
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` it inherited.
- **Lease.** The worker renews `hooks-enabled.json` every 30 s, and it expires 120 s after the last renewal. The
  hook does nothing without a fresh lease, so a stopped Follow-up costs nothing.

## What the hook does (`server/agent-hook.mjs`)

It runs on every event, so it reads only small files: `scopes.json`, `brief.json`, its `hook-state/` markers, and
`tools-instance.json`. It never reads `state.json` when `scopes.json` exists. It skips subagent events, recovery
agents and anything without `PASEO_AGENT_ID`.

| Event | Effect |
| --- | --- |
| SessionStart | Adds Follow-up's instructions for tracked agents (worded for the agent's PR workflow, contributor or main), the native tools' guidance (`nativeExtras`, since native tools carry no MCP instructions), and Wait's guidance (`waitExtras`: `waitInstruction` when `FOLLOW_UP_WAIT=1`, or on Paseo 0.16 `backgroundWorkInstruction` when `FOLLOW_UP_BACKGROUND_WORK=1`). Untracked Claude sessions with Wait get only Wait's guidance. |
| UserPromptSubmit | Starts a turn marker. Repeats the context when it changed (Codex always repeats). Tells a demoted agent once that it lost the main role. For the Overseer, injects the digest. |
| PostToolUse | Marks the turn dirty after shell or edit tools. Says once per session that native tools are detached after a reload. |
| Stop | Blocks the stop once if a dirty turn didn't `sync_workspace` (read from `hook-state/sync-<agent>.json`, written by the RPC handler, so any tool spelling counts), or if a root Claude session didn't call `needs_you` (`shouldNudge`). Never blocks twice in one turn, or while background tasks run. |

## Env flags

The worker sets these at `agent.session_open`:

- `FOLLOW_UP_TOOLS`: `native` or `stdio`.
- `FOLLOW_UP_PROVIDER`.
- `FOLLOW_UP_ROOT`.
- `FOLLOW_UP_BRIEF`: the provider, when the nudge applies.
- `FOLLOW_UP_OVERSEER`.
- `FOLLOW_UP_RECOVERY`.
- `FOLLOW_UP_CLI`: the bridge path.
- `FOLLOW_UP_WAIT`.
- `FOLLOW_UP_BACKGROUND_WORK` (Paseo 0.16, instead of `FOLLOW_UP_WAIT`).

Tests: `tests/agent-hooks.test.ts` and `tests/hook-native.test.ts` (the hook is imported with
`FOLLOW_UP_HOOK_IMPORT=1`, so `main()` doesn't run), plus `tests/session-mcp.test.ts`.
