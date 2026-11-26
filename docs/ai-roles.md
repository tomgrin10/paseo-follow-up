# AI roles: Summary, the Overseer, AI priority (the ranker), recovery

## Settings → Agents (`agents.json`)

- **Roles.** `shared/agent-settings.ts` defines the roles (`AGENT_ROLES`: `about`, `overseer`, `recovery`,
  `ranker`, `dispatch`), their defaults (`ROLE_DEFAULTS`) and lenient parsing. A missing or invalid entry means the
  default. `dispatch` is Settings → Agents → Dispatch, the agent Dispatch starts for an action without its own
  ([dispatch.md](dispatch.md#settings)); like recovery it has `same` (`hasSame`), here "Same as the Overseer", its
  default. It's in Settings only, not setup's Helper agents step.
  The file also holds `enable_wait` ([wait.md](wait.md)).
- **Store.** `server/agent-settings.ts` has the store (`AgentSettingsStore`, with serialized atomic writes) and
  `ProviderCatalog`.
  - The catalog is Paseo's provider snapshot. It's read only when the settings screen opens and cached for 10
    minutes.
  - `providersFor` offers every provider in the catalog to every role. `CLI_JOB_PROVIDERS` (Claude, Codex, Pi) only
    names the providers with a headless CLI fast path; any other provider runs jobs through `server/job-agent.ts`.
  - **Outside content stays on a guarded provider** (`a-job-that-reads-outside-content-can-only-read`, invariant 81).
    A job whose prompt carries words someone else wrote is marked `outside` (AI priority's `rank`, `rank-reasons` and
    `rank-plan`, Ask's `ask-plan` and `ask-items`, `compass-extract`, and a Summary with linked issues or threads).
    `AiJobs.run` refuses it before any runner on a provider without a guard (`providerCaps(...).guard`,
    `shared/provider-support.ts`: Claude, Codex and Pi through their CLIs, OpenCode through a locked session; anything
    else, ACP agents included, can't promise a job no tools), with reason `unguarded`. The Summary leaves the linked
    text out there and still runs on the workspace's own work. AI priority (`needsGuard`) is never recommended on such a
    provider, and with none available its row shows it off and says what to install or turn on; the Summary's
    linked items, Compass and Ask are named in the block under the rows (`providerNotes`), and the source's own row
    (Compass, an Ask server) says why.
  - `catalogFrom` keeps each model's description (cut to 200 characters), which the recommendations read.
- **RPCs and tools.** `follow.agent-settings`, `follow.set-agent-setting` and `follow.set-wait`; tools
  `agent_settings`, `set_agent_setting` and `set_wait_for_jobs`.
- **UI:** `client/agents.tsx` (Settings → Agents) and setup's Helper agents step both render the shared job rows
  in `client/job-rows.tsx`; see [settings.md](settings.md).
- **Names.** `ROLE_INFO` holds each role's title and what it does, the one copy both surfaces use. The ranker is
  **AI priority** in all user-facing copy; code and files keep `ranker`.
- **Recommendations** (`shared/recommend.ts`). `ROLE_TIER` says what size of model each job needs (Summary small,
  AI priority mid, the Overseer strong, recovery the same as the main agent, Dispatch the same as the Overseer) and `ROLE_NEED` says it in one line.
  `recommend(role, catalog)` picks:
  - with Claude available, the declared `ROLE_DEFAULTS`;
  - otherwise the first ready provider (Claude, then Codex, then the rest), and in it the model whose description
    (`modelTier`, then whole-word name patterns like `mini` or `opus`) fits the tier; a small job gets the lowest
    effort the model offers;
  - when nothing fits, the provider's default model with a hint (`source: "fallback"`).
  `isRecommended` compares a saved pick with it. `shared/job-rows.ts` turns this into what a row says.
- **A role runs on a provider you have** (`runnableRole`, `shared/job-rows.ts`). A role whose provider was never
  picked runs on its declared default while Paseo has it; when Paseo's catalog says the default can't run and another
  provider can, `AgentSettingsStore.role()`/`all()` return the recommendation instead, so with no Claude installed
  the Summary, AI priority and the Overseer run on what the developer has, and Settings → Agents shows that pick. A
  picked provider is never moved, and an unknown catalog (not read, failed, still loading) keeps the default. The
  catalog is the last one read (the worker reads it once in the background when it first gets a Paseo handle, and
  Settings reads it when it opens); reading a role never waits on Paseo, so no RPC does (tests/rpc-ack.test.ts).
- **Defaults.** Jobs default to fast models: Summary on Haiku, the ranker on Sonnet. Validate required fields rather
  than raising effort.

## AI jobs (`server/ai-jobs.ts`)

`AiJobs` runs bounded one-shot model jobs: a prompt in, validated JSON out.

- **Claude:** `claude -p` with no tools, MCP servers, settings or saved session.
- **The job guard** (`server/job-guard.ts`, sources-are-read-only): every Claude job runs with a PreToolUse hook,
  passed with `--settings`, that refuses any tool call outside the job's grant before Claude Code runs it, whatever
  the prompt or `--allowedTools` say. The default grant is nothing; the plan reader's is the Artifact tool's `read`
  (`ARTIFACT_READ`, never with `out_dir`). A refused call doesn't fail the job: the model is told no and answers from
  what it read. The hook is Node with `-e` (the grant in `FOLLOW_UP_JOB_TOOLS`) and refuses what it can't parse.
- **Codex:** `codex exec --ephemeral` with no user config, no shell and a read-only sandbox in an empty temp folder.
- **Pi:** `pi -p --no-tools` with no extensions, skills, prompt templates or context files and no saved session
  (`piArgs`); the prompt on stdin, from the temp folder.
- **OpenCode:** a job agent (`server/job-agent.ts`) whose session carries `permission: "deny"` (every tool, Paseo's
  MCP tools included, refused by OpenCode before it runs) and Auto Accept off (`lockedConfig`); a job that still asks
  for a permission fails and is archived.
- **Limits:** one turn, a 90 s timeout (the whole process group is killed), and one job at a time.
- **Log:** each call’s duration and cost goes to `ai-jobs.jsonl`. A caller may attach a privacy-safe
  `validationReason` rule code through `diagnose`; never a reply, prompt, name or issue key. Calls the guard refused
  are logged as `refused`, tool and action names only ("Artifact.publish").
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
    `ABOUT_RETRY_MS` (10 min). Its inputs (history, subagents) are read once per workspace; the reply waits for
    them up to 300 ms (`collectWaitMs`), so a fast read answers in full. Past that the view says pending and the
    client asks again after 500 ms, backing off to 3 s (`pendingPollMs`); each ask waits on the read under way the
    same way. The agent tool's `wait` waits for all of it.
- **Agent tool:** `workspace_about`.
- **UI:** `client/about.tsx`. Placement tests: `tests/about-placement.test.ts`.

## Ask for unknown sources

The Morning brief's Ask (docs/morning-brief.md#ask) runs on the Summaries role too: one call plans at most 3 read-only
reads of a server no recipe fits (weekly, or when its tools change), one turns the replies into at most 5 items. Every
call and item is validated; the model runs nothing itself. Off until the developer previews and turns a source on.

## Rename title with AI

A short workspace name from what Follow-up already stored, on Summaries' agent (Settings → Agents → Summaries, Claude
Haiku by default). About $0.001 and 3 s a suggestion. This one-line Haiku subprocess explicitly disables
thinking with job-only environment settings; it does not change Summaries or saved CLI preferences.

- **Files.** `shared/rename.ts` has the name rules (`checkName`), the prompt and the Undo rules; `server/rename.ts`
  has `RenameService`, `RenameStore` (`rename.json`) and `renameDaemon`; `client/rename.tsx` the dialog.
- **Inputs, stored data only:** the name now, the branch, the goal, the Summary sentence, the spec name, PR titles,
  linked items and the titles of the workspace's agents from the cached directory. Never a timeline, a transcript or a
  `fetch_agent` (invariant `rename-never-wakes-an-agent`).
- **Workspace lookup.** `findWorkspace(id)` on newer clients, otherwise 200-row cursor pages. Include background workspaces only when the client reports
  `supportsBackgroundWorkspaces() === true`; omit that option on older clients or unsupported hosts. Never use `idPrefix`: the server accepts but ignores it. No agent or timeline reads.
- **The name.** One rule, `NAME_RULE` ("Start with a verb. Up to 8 words."), stated word for word under the
  dialog's field and in the prompt, and enforced by `checkName`: sentence case, at most 60 characters, no quotes or
  branch shapes. A linked Linear key may go inline after the verb (`Verify ABC-123 vendor mismatch`, not counted as a
  word), never first and never alone; an unlinked key is refused. The prompt carries two short examples. Before `checkName`, `normalizeSuggestion` removes quotes and trailing punctuation,
  drops unlinked keys, moves a leading linked key after the verb, and cuts to eight words or 60 characters on a word
  boundary. Only empty, unchanged or branch-like content needs one retry. If it is still unusable, the best candidate
  stays in the editable field with the rule hint. The developer's edits still pass the strict `checkName`; no invalid
  name is applied. `checkName` returns privacy-safe rule IDs for the job log, never the rejected name text.
- **Limits.** 30 suggestions a day (each model run counts), separate from Summaries' cap. A developer's rename
  click may wait 250 ms for room but is never refused as busy.
  The daily cap leaves an editable field with a limit notice, rather than a suggestion-failure error.
- **Renaming** sets Paseo's own workspace title (`set_workspace_title`) and records the old title in `rename.json`.
  The toast after it has Undo for 10 s; for 24 h the dialog's Undo last rename and `ai_rename undo=true` restore it,
  but only while the workspace still has the name the rename gave it (invariant `rename-is-always-undoable`).
- **RPC boundary.** `renameIssueKeys` selects only Linear-style issue keys before the 20-key wire limit. Artifact
  and document URLs can be much longer than the 40-character issue-key field and must never enter it. Otherwise a
  successful model answer can still fail output validation. A fictional long-artifact fixture guards this path.
- **Errors.** Provider failures and timeouts show “Couldn't suggest”; repairable or still-editable replies do not.
- **Entry points:** the row menu (Home, Follow-up's sidebar view, the panel's More button), ⌘K "Follow-up: Rename
  title with AI", and the agent tool `ai_rename` (planned). Tests: `tests/rename.test.ts`.

### Daemon list audit

Production list requests in `server/` were audited for ignored filters and options:
`server/rename.ts` was the only caller sending `idPrefix`, which the server ignores. It now uses an exact id lookup
across pages. `server/directory.ts` lists agents and workspaces with supported `page.limit` and `page.cursor` only,
then matches locally; its agent refresh uses the same paging. `server/daemon.ts` declares those list methods but
sends no additional list options. The `filter` in `server/data-move.ts` belongs to filesystem copying.
No other ignored daemon filter or option was found. `tests/support/workspace-list.ts` deliberately ignores
wire-only `idPrefix` and `includeInternal`, applies background visibility and pagination, and rejects unmodelled
filters rather than inventing server behaviour. Rename tests share it.


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
  confirm; it runs as Dispatch's Create PR, [dispatch.md](dispatch.md)) and `rerank`.
- **What it can't do:** merge, archive or post anywhere.
- **Overrides.** `FOLLOW_UP_OVERSEER_PROVIDER` overrides the model, for isolated test daemons only.
- **UI.** Home's Overseer card (`client/home.tsx`) and the Command Center item "Ask the Overseer"
  (`follow.overseer-ask`).

## Priority ranker (beta)

- **Files.** `shared/ranker.ts` has the prompt, input fingerprint and validation. `server/ranker.ts` has `Ranker`
  and `liveRankSources`.
- **Inputs:**
  - Follow-up's own state.
  - The developer's Linear queue, from the Morning brief's snapshot ([morning-brief.md](morning-brief.md)): its top
    40 issues by priority plus every issue that changed since the last workday's sweep, each with its change ("raised
    Low → High"). The ranker makes no Linear call of its own; with no snapshot yet it asks for one sweep first.
  - Slack DMs and mentions from the last 48 h, through `mcpproxy call tool-read`.
  - `gh search prs --review-requested=@me`.
  - The weekly planning artifact, read through one Claude turn with only the Artifact tool's read (the job guard
    refuses every other action), at most once a day. Its link
    is Settings → Compass's ([morning-brief.md](morning-brief.md#settings)): `FOLLOW_UP_PLAN_URL`, else a pasted
    link, else the newest a Compass source with Posts the plan shared (or last week's).
- **When it runs.** It hashes its inputs and calls the model only when they changed. It runs hourly on the
  developer's workdays, 08:00–20:00 in their zone (the brief's clock: Settings → Morning brief's zone, else the device's, else the host's; the workdays
  are the zone's usual week), within the daily cap, while the governor allows background work.
- **Not started** (`notStartedFrom`): issues that are Urgent, or were raised to High or Urgent since the last workday,
  with no workstream naming their key. Read from the queue, never asked of the model.
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
