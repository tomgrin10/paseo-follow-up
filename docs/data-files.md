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
| `hook-state/` | hook, worker | Per-session turn markers. `sync-<agent>.json` (the last sync), `needs-you-<agent>.json` (the last `needs_you` call), `task-nudges-<workspace>.json` (the due tasks the Stop hook named: per task the due fact, revision, count and time; the worker copies it into each task's `nudged`), `native-<agent>.json` (which worker attached native tools), `overseer-seen-<agent>.json`, `bookkeeping-<agent>.json` (the reply a Stop-hook bookkeeping continuation interrupted, which the Finished reason reports instead of the bookkeeping reply). |
| `tools-instance.json` | `index.server.ts` | This worker's instance id, to detect detached native tools. |
| `brief.json` | `index.server.ts` | Whether the inbox and the nudge are on, plus agents with a permission prompt showing. Read by the hook and the bridge. |
| `inbox.json` | `server/inbox.ts` | One Needs-you flag per root agent, snoozes, finish flags, briefs, the delivery ledger (`by: "agent:<id>"` for agent actions), the `outbox` 2.0 kept brief answers in (moved to `queue.json` once, then empty), and per tracked PR the state each PR flag last notified (`notified`). |
| `queue.json` | `server/message-queue.ts` | The message queue: every message to an agent waiting, in flight or retrying (answers today), with its state, the refs of its pasted images (`images`, never the bytes), retry time, last envelope messageId and every messageId it went out under (`sentIds`), and Paseo 0.17.2+'s delivery receipt once sent (`receipt`); the newest settled ones without text; the one-time moves done (`migrations`). Saved before each send. |
| `images/` | `server/image-store.ts` | Pasted images waiting to go to an agent (`<id>.png`, `.jpg`, `.gif`, `.webp`; files 0600, the folder 0700): a queued message (`queue.json`) or a waiting dispatch (`dispatch.json`) keeps only their refs. Removed once the message is delivered or cancelled, or the dispatch is created or failed; a worker start removes any file nothing references. Nothing leaves the host except to the agent. |
| `cards.json`, `cards-media/` | `server/cards.ts` | What agents show in each workspace's view (`show_card`): cards with their blocks, who wrote them and when, rows changed in the last update, Keep, removals restorable for 10 minutes, and the migrations run. Images and videos the cards show, copied by content hash (`<sha256>.<ext>`, files 0600, folder 0700); a start and every removal sweep files no card references. A workspace gone from `state.json` takes its cards with it ([cards.md](cards.md)). |
| `agents.json` | `server/agent-settings.ts` | Settings → Agents: per-role provider, model, effort and mode, plus `enable_wait`. |
| `reviewers.json` | `server/reviewer-config.ts` | Reviewer lists per repository, plus a default. |
| `check-watches.json` | `server/check-watches.ts` | Wait for checks: each agent's open watches (PR, when it began and ends, the head it saw checks running on). One-shot, so it stays small (at most `SCALE.perWorkspace` per agent). Saved behind the reply; losing it costs the agent a call ([wait-for-checks.md](wait-for-checks.md)). |
| `context.json` | `server/context-requests.ts` | Your questions and Catch up's More context asks (schema v2, `version: 2`; v1 migrated on load): each question, who answered, the answer and what came of it (done, a task). At most 200 per workspace, none older than 30 days. Saved behind the reply; losing it costs a re-ask. |
| `pr-workflow.json` | `server/pr-workflow.ts` | Graphite or GitHub, the default and per repository, merge methods, the review-fix command. |
| `priorities.json`, `ranker.json` | `server/priorities.ts`, `server/ranker.ts` | Home's Priority sort, the ranker's input hash, run count, source health (and each failed source's one-line error) and plan summary. |
| `about.json`, `ai-jobs.jsonl` | `server/about.ts`, `server/ai-jobs.ts` | Summary overviews and linked items, and each model call’s duration and cost, plus privacy-safe validation rule codes for rejected rename replies (never their text) and the names of tool calls the job guard refused ("Artifact.publish", never their inputs). |
| `rename.json` | `server/rename.ts` | Rename title with AI: the day's suggestion count and each rename of the last 24 hours (workspace, old title or null for Paseo's default name, new title, when, by whom), so it can be undone. Pruned on every write. |
| `linear-queue.json` | `server/linear-queue.ts` | The Morning brief's Linear queue: the last two complete sweeps (each issue's key, title, priority, state, due date, team, project, milestone, url, update time, and when it was opened and by whom: `createdAt`, `creator`, `creatorId`), a 14-day log of what changed between sweeps (before and after, and why an issue left), the last sweep's outcome, when the developer last read the brief (`seen`), the workday whose morning sweep ran, the developer's Linear user id (`viewer`), and the raised issues the developer removed from Needs you (`dismissed`: key and raise time, pruned with the log) ([morning-brief.md](morning-brief.md)). |
| `morning-brief.json` | `server/morning-brief.ts` | Settings → Compass: the Linear queue's settings (states, sweep time, since, time zone, workdays), this week's plan settings (mode, pasted link, replace-when-newer; before the one-time move, Find it for me's person and channels, then when it moved and any names it couldn't), the newest plan Compass found (with its source) and last week's, Compass's settings (`compass`), when the one-time import from the morning-brief skill's registry ran, and the sources' switches, when mcpproxy was last asked, each source's last Retry, and Ask's plans (per server, a week) and last asks (items, reads, error) ([morning-brief.md](morning-brief.md#sources)). Not `brief.json`, which is the hooks' brief state. |
| `compass.json` | `server/compass.ts` | Compass ([compass.md](compass.md)): each place's cursor (the newest message read, when, ok / failed / slow-path / paused and its one line; a doc's text hash and its read blocks' hashes; a local file's modified time and size, never its path), the notes (what, keys, strength, until, the quote of at most 280 characters, who and when, the workspace it found), today's model-call count, the morning read's day, the last read and the last refused notes' rule codes. Never the text read; an ended note's quote goes after 7 days. Its settings are `morning-brief.json`'s `compass`. |
| `dispatch.json` | `server/dispatch.ts` | Dispatch: the developer's actions (`null` until changed), team → project rules, bases per project, the no-team rule, the last used project and the last 50 starts with their state ([dispatch.md](dispatch.md)). A record keeps its instructions only until the agent starts. |
| `linked.json` | `server/linked.ts` | Linked items per workspace (items, exclusions, Linear candidates), keys Linear rejected, the known Linear teams, the daily check count and migrations ([linked-items.md](linked-items.md)). Read on use, never cached in the worker. |
| `title-index.json` | `server/transcript-titles.ts` | One local artifact receipt index: per-transcript inode, size, mtime and byte cursor, bounded partial line/pending Artifact inputs, and URL/title evidence with its source path. Appends read once; completed files remain cached misses until changed. |
| `overseer.json`, `overseer-digest.json`, `overseer-home/` | `server/overseer.ts` | The Overseer's agent id, the digest its hook injects, and its workspace folder. |
| `onboarding.json` | `server/onboarding.ts` | Setup progress: fresh or existing install, the current step, offer state. |
| `versions.json` | `server/release-notes.ts` | The installed version, the previous one, and the host-wide What's new record. |
| `updates.json`, `registry.json`, `updates.jsonl`, `heartbeat.json`, `update-watchdog.mjs`, `update-watchdog.lock` | `server/updater.ts`, `server/updates.ts`, `server/update-watchdog.mjs` | Self-update settings (mode, channel, the What's new switch) and caches, the last npm answer, the install log, the new worker's readiness, and the detached installer and its lock ([updates.md](updates.md)). |
| `move.json`, `migrated-from.json` | `server/plugin-move.ts`, `server/data-move.ts` | 2.0's move from 1.x: when the plugin-id move became ready and the last busy time, and where the data was copied from and when ([updates.md](updates.md#moving-from-1x)). |
| `trust-bypass.jsonl` | `server/trust-bypass.ts` | Permission prompts trust bypass approved, with a redacted summary. |
| `stats.json` | `server/pr-stats.ts` | PR statistics settings: per repository whether it's on (or paused with data kept), its window, team filter, hidden people, the estimate seen when it was turned on and the last sync's summary; the clock, working hours, time zone, week start and GitHub share. Saved behind the reply. |
| `stats/<owner>/<repo>.json` | `server/pr-stats-store.ts` | PR statistics for a repository the developer turned on: one compact record per PR updated in the window (numbers, times, logins, branch names, a title; no text, invariant 69, `stats-records-hold-no-text`) and the sync's cursors, coverage, last cost and why it last waited ([pr-stats.md](pr-stats.md)). Loaded only for a read. |
| `wait/` | `server/wait-jobs.ts` | `run-job.sh`, plus `jobs/<agentId>/<jobId>/` with `job.json`, the `started` marker, and `result.json` (the exit receipt, written by the runner in the agent's shell). |

Outside this folder, Follow-up reads (never writes):

- Paseo's `config.json`.
- Session Guard's `plugin-data/session-guard/state.json`.
- Defer's `plugin-data/defer/queue.json`.
- Smart Session's `plugin-data/smart-session/` files.
- Provider transcripts (`~/.claude/projects`, `~/.codex/sessions`).

It writes its hook entries into `~/.claude/settings.json` and `~/.codex/hooks.json`, which is reversible: entries
carry the `# paseo-follow-up-hook` marker. [data-access.md](data-access.md) is the user-facing statement of this.
