# Data files

Everything lives in `$PASEO_HOME/plugin-data/follow-up/`.

- Files are owner-only (0600, folders 0700).
- Writes are atomic: a temp file, then rename.
- Only the worker writes, except where noted.
- An unreadable file means defaults, never "off".
- New features get their own file rather than changing `state.json`'s shape.

| File | Owner | What it holds |
| --- | --- | --- |
| `state.json` | `server/store.ts` | Tracked workspaces: main agent, PRs and snapshots, obligations (tasks), batches, questions, spec, completion, hold, main-agent history, migrations. Schema `shared/model.ts`. |
| `worker.lock` | `server/store.ts` | Makes one worker the only writer. |
| `state.before-*.json.bak` | `index.server.ts` | One-time backups made before each migration. Never overwritten. |
| `archive/` | `server/batch-archive.ts` | Never-sent cancelled batches pruned from `state.json`. |
| `history-cache.json` | `server/history-cache.ts` | Discovery's distilled per-agent history (goal, PR candidates, cursor). Never raw timeline items. |
| `scopes.json` | `server/scopes.ts` | Each agent's role (main, contributor, recovery) and PR workflow, for the hook and the bridge. Written on change. |
| `background-agents.json` | `server/background-agents.ts` | Paseo 0.16 background agents (other plugins' helpers) Follow-up has seen, newest 2,000, so the hook skips them. Written when one is found. |
| `mcp.mjs` | `index.server.ts` | The stdio bridge and CLI, written from `server/mcp-source.ts` at start. |
| `agent-hook.mjs`, `hooks-enabled.json` | `server/agent-hooks.ts` | The provider hook script, and its lease (expires 120 s after the last heartbeat). |
| `hook-state/` | hook, worker | Per-session turn markers. `sync-<agent>.json` (the last sync), `needs-you-<agent>.json` (the last `needs_you` call), `native-<agent>.json` (which worker attached native tools), `overseer-seen-<agent>.json`, `bookkeeping-<agent>.json` (the reply a Stop-hook bookkeeping continuation interrupted, which the Finished reason reports instead of the bookkeeping reply). |
| `tools-instance.json` | `index.server.ts` | This worker's instance id, to detect detached native tools. |
| `brief.json` | `index.server.ts` | Whether the inbox and the nudge are on, plus agents with a permission prompt showing. Read by the hook and the bridge. |
| `inbox.json` | `server/inbox.ts` | One Needs-you flag per root agent, snoozes, finish flags, briefs, the delivery ledger (`by: "agent:<id>"` for agent actions), and the `outbox` of brief answers Paseo hasn't confirmed yet. |
| `agents.json` | `server/agent-settings.ts` | Settings → Agents: per-role provider, model, effort and mode, plus `enable_wait`. |
| `reviewers.json` | `server/reviewer-config.ts` | Reviewer lists per repository, plus a default. |
| `pr-workflow.json` | `server/pr-workflow.ts` | Graphite or GitHub, the default and per repository, merge methods, the review-fix command. |
| `priorities.json`, `ranker.json` | `server/priorities.ts`, `server/ranker.ts` | Home's Priority sort, the ranker's input hash, run count, source health and plan summary. |
| `about.json`, `ai-jobs.jsonl` | `server/about.ts`, `server/ai-jobs.ts` | Summary overviews and linked items, and each model call's duration and cost. |
| `linked.json` | `server/linked.ts` | Linked items per workspace (items, exclusions, Linear candidates), keys Linear rejected, the known Linear teams, the daily check count and migrations ([linked-items.md](linked-items.md)). Read on use, never cached in the worker. |
| `overseer.json`, `overseer-digest.json`, `overseer-home/` | `server/overseer.ts` | The Overseer's agent id, the digest its hook injects, and its workspace folder. |
| `onboarding.json` | `server/onboarding.ts` | Setup progress: fresh or existing install, the current step, offer state. |
| `versions.json` | `server/release-notes.ts` | The installed version, the previous one, and the host-wide What's new record. |
| `updates.json`, `registry.json`, `updates.jsonl`, `heartbeat.json`, `update-watchdog.mjs`, `update-watchdog.lock` | `server/updater.ts`, `server/updates.ts`, `server/update-watchdog.mjs` | Self-update settings and caches, the last npm answer, the install log, the new worker's readiness, and the detached installer and its lock ([updates.md](updates.md)). |
| `move.json`, `migrated-from.json` | `server/plugin-move.ts`, `server/data-move.ts` | 2.0's move from 1.x: when the plugin-id move became ready and the last busy time, and where the data was copied from and when ([updates.md](updates.md#moving-from-1x)). |
| `trust-bypass.jsonl` | `server/trust-bypass.ts` | Permission prompts trust bypass approved, with a redacted summary. |
| `wait/` | `server/wait-jobs.ts` | `run-job.sh`, plus `jobs/<agentId>/<jobId>/` with `job.json`, the `started` marker, and `result.json` (the exit receipt, written by the runner in the agent's shell). |

Outside this folder, Follow-up reads (never writes):

- Paseo's `config.json`.
- Session Guard's `plugin-data/session-guard/state.json`.
- Defer's `plugin-data/defer/queue.json`.
- Smart Session's `plugin-data/smart-session/` files.
- Provider transcripts (`~/.claude/projects`, `~/.codex/sessions`).

It writes its hook entries into `~/.claude/settings.json` and `~/.codex/hooks.json`, which is reversible: entries
carry the `# paseo-follow-up-hook` marker. [OVERVIEW.md](../OVERVIEW.md) is the user-facing statement of this.
