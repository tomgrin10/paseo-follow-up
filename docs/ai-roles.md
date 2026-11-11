# AI roles: Summary, the Overseer, AI priority (the ranker), recovery

## Settings → Agents (`agents.json`)

- **Roles.** `shared/agent-settings.ts` defines the roles (`AGENT_ROLES`: `about`, `overseer`, `recovery`,
  `ranker`), their defaults (`ROLE_DEFAULTS`) and lenient parsing. A missing or invalid entry means the default.
  The file also holds `enable_wait` ([wait.md](wait.md)).
- **Store.** `server/agent-settings.ts` has the store (`AgentSettingsStore`, with serialized atomic writes) and
  `ProviderCatalog`.
  - The catalog is Paseo's provider snapshot. It's read only when the settings screen opens and cached for 10
    minutes.
  - `providersFor` offers every provider in the catalog to every role. `CLI_JOB_PROVIDERS` (Claude, Codex) only
    names the providers with a headless CLI fast path; any other provider runs jobs through `server/job-agent.ts`.
  - `catalogFrom` keeps each model's description (cut to 200 characters), which the recommendations read.
- **RPCs and tools.** `follow.agent-settings`, `follow.set-agent-setting` and `follow.set-wait`; tools
  `agent_settings`, `set_agent_setting` and `set_wait_for_jobs`.
- **UI:** `client/agents.tsx` (Settings → Agents) and setup's Helper agents step both render the shared job rows
  in `client/job-rows.tsx`; see [settings.md](settings.md).
- **Names.** `ROLE_INFO` holds each role's title and what it does, the one copy both surfaces use. The ranker is
  **AI priority** in all user-facing copy; code and files keep `ranker`.
- **Recommendations** (`shared/recommend.ts`). `ROLE_TIER` says what size of model each job needs (Summary small,
  AI priority mid, the Overseer strong, recovery the same as the main agent) and `ROLE_NEED` says it in one line.
  `recommend(role, catalog)` picks:
  - with Claude available, the declared `ROLE_DEFAULTS`;
  - otherwise the first ready provider (Claude, then Codex, then the rest), and in it the model whose description
    (`modelTier`, then whole-word name patterns like `mini` or `opus`) fits the tier; a small job gets the lowest
    effort the model offers;
  - when nothing fits, the provider's default model with a hint (`source: "fallback"`).
  `isRecommended` compares a saved pick with it. `shared/job-rows.ts` turns this into what a row says.
- **Defaults.** Jobs default to fast models: Summary on Haiku, the ranker on Sonnet. Validate required fields rather
  than raising effort.

## AI jobs (`server/ai-jobs.ts`)

`AiJobs` runs bounded one-shot model jobs: a prompt in, validated JSON out.

- **Claude:** `claude -p` with no tools, MCP servers, settings or saved session.
- **Codex:** `codex exec --ephemeral` with no user config, no shell and a read-only sandbox in an empty temp folder.
- **Limits:** one turn, a 90 s timeout (the whole process group is killed), and one job at a time.
- **Log:** each call's duration and cost goes to `ai-jobs.jsonl`.
- **Any other provider** (`server/job-agent.ts`, `jobAgentRunner`): when neither a CLI runner applies, `AiJobs`
  falls back to `opts.generic`, a short-lived Paseo agent. Paseo refuses hidden internal agents from plugins, so jobs
  run in one background workspace ("Follow-up jobs", home `jobs-home/`, id cached in `jobs-workspace.json` and
  recreated once if it's gone). Background workspaces and their agents stay out of Paseo's lists. Each job creates
  an agent (label `follow-up-job`, `autoArchive`) with the job's system prompt, waits for it to finish, takes
  its last message as the answer and archives it. A permission prompt, timeout or empty reply fails the job
  visibly; with no Paseo connection yet it fails with "Follow-up isn't connected to Paseo yet". Tests:
  `tests/any-provider.test.ts`.

## Summary (internal id `about`)

User-facing copy calls it **Summary** (the Settings → Agents role is "Summaries"; before 1.4.0-beta.28 it was "What's this about?"). Code, RPCs and files keep
`about`.

- **Files.** `shared/about.ts` has the schema, prompt and parsing. `server/about.ts` has `AboutService`,
  `AboutStore` (`about.json`) and the source readers.
- **Reading an agent's steps.** It reads the root agent's latest steps from the live timeline only when Paseo
  already has the agent loaded. Otherwise it reads the provider transcript on disk (`server/transcript.ts`).
- **Linked items.** Only the Linear issues and Slack threads the workspace itself links, through
  `mcpproxy call tool-read`. It never searches.
- **When overviews are written:**
  - Ahead of time only for non-dormant workspaces in Needs you, up to the daily cap (60).
  - Never while a Claude account is above 85 % of a limit, or while the governor holds background work.
  - Opening the section (`follow.workspace-about` with `open`) starts one when the cached overview is older than
    `ABOUT_TTL_MS` (1 h) and its inputs changed; `refresh` always does. A failed attempt retries after
    `ABOUT_RETRY_MS` (10 min).
- **Agent tool:** `workspace_about`.
- **UI:** `client/about.tsx`. Placement tests: `tests/about-placement.test.ts`.

## The Overseer (beta)

One long-lived agent the developer talks to about all workspaces. It routes asks and never does the work.

- **Files:**
  - `shared/overseer.ts`: the label `OVERSEER_LABEL`, the digest, routing scores.
  - `server/overseer.ts`: the `Overseer` class and `OVERSEER_TOOLS`.
  - `server/overseer-prompt.md`: its system prompt, generated into `server/overseer-prompt-source.ts`.
- **Lifecycle:**
  - Created only on Start (`follow.overseer-start`) in a workspace under `overseer-home/`. Its id is in
    `overseer.json`.
  - Recreated if archived, from `inboxLoop`.
  - A model change in Settings → Agents applies only on restart (`follow.overseer-restart`). The new agent gets the
    old one's last steps.
- **Per-turn digest.** The worker writes `overseer-digest.json` at most once a minute, only on change, and not
  while background work is paused. The hook injects it at each UserPromptSubmit.
- **Its tools** come through `follow.overseer-act`: `workstreams`, `agent_digest` (the transcript on disk for an
  unloaded agent, never its timeline), `route_candidates`, `send_to_agent`, `start_workspace` (dry run, then
  confirm) and `rerank`.
- **What it can't do:** merge, archive or post anywhere.
- **Overrides.** `FOLLOW_UP_OVERSEER_PROVIDER` overrides the model, for isolated test daemons only.
- **UI.** Home's Overseer card (`client/home.tsx`) and the Command Center item "Ask the Overseer"
  (`follow.overseer-ask`).

## Priority ranker (beta)

- **Files.** `shared/ranker.ts` has the prompt, input fingerprint and validation. `server/ranker.ts` has `Ranker`
  and `liveRankSources`.
- **Inputs:**
  - Follow-up's own state.
  - Linear issues assigned to the developer.
  - Slack DMs and mentions from the last 48 h, through `mcpproxy call tool-read`.
  - `gh search prs --review-requested=@me`.
  - The weekly planning artifact, read through one Claude turn with only the Artifact tool.
- **When it runs.** It hashes its inputs and calls the model only when they changed. It runs hourly on workdays,
  within the daily cap, while the governor allows background work.
- **Output:** `priorities.json` (`server/priorities.ts`, `shared/priorities.ts`) and `ranker.json`.
- **One row shows the reason.** A priority is stored per workspace, and its score orders every row of that
  workspace. A workspace can have several Home rows, one per flagged root agent, and the reason was written about
  the row the ranker read. That row is `row` on the stored priority, and only that row shows the reason. A priority
  for the whole workspace (`set_priorities`, or one stored without `row`) shows on the workspace's only row, its own
  `ws:` row, or its main agent's row (`priorityRow`). The invariant is `row-lines-own-row` (`homeViolations` in
  `shared/status-invariants.ts`).
- **RPCs:** `follow.rank-status`, and `follow.rank-now`, which returns at once; poll the status.
- **Agent tools:** `set_priorities` (an agent can supply priorities itself), `priorities`, `rank_status`,
  `rerank_priorities`.

## Recovery agents

`follow.recover` (`run_recovery`) starts a separate agent that rebuilds missed PRs and tasks from a workspace's
history.

- It runs only when started, and never edits code.
- `server/recovery-config.ts` applies the recovery role. A different provider keeps the main agent's system prompt,
  MCP servers and tool policy, and drops provider-specific options.
- `server/recovery-handoff.ts` proves a handoff from the caller's own record, without loading the previous agent.

Tests: `tests/about.test.ts`, `tests/overseer.test.ts`, `tests/ranker.test.ts`, `tests/agent-settings.test.ts`,
`tests/recovery-config.test.ts`, `tests/recovery-handoff.test.ts`.
