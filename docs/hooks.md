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
| SessionStart | Adds Follow-up's instructions for tracked agents (worded for the agent's PR workflow, contributor or main; in a workspace whose repositories are all No review, `workflow.noReview` in `scopes.json`, the agent merges its own PR once CI is green, see `mergeLine`; one team repository keeps the team wording), the native tools' guidance (`nativeExtras`, since native tools carry no MCP instructions), and Wait's guidance (`waitExtras`: `waitInstruction` when `FOLLOW_UP_WAIT=1`, or on Paseo 0.16 `backgroundWorkInstruction` when `FOLLOW_UP_BACKGROUND_WORK=1`). Root agents, tracked or not, also get one line on waiting for CI without polling (`checksLine`). Untracked Claude sessions with Wait get only Wait's guidance. On Paseo 0.17 the static parts go in the system prompt instead and the hook leaves them out (see [Static text in the system prompt](#static-text-in-the-system-prompt-paseo-017)). |
| UserPromptSubmit | Starts a turn marker. Repeats the context when it changed (Codex always repeats). Tells a demoted agent once that it lost the main role. For the Overseer, injects the digest. |
| PostToolUse | Marks the turn dirty after shell or edit tools. Says once per session that native tools are detached after a reload. When a shell command polls GitHub for CI (`pollsGithub`), adds once per turn, never blocking, that the agent should call `wait_for_checks` and end its turn ([wait-for-checks.md](wait-for-checks.md)); tracked and untracked root agents. |
| Stop | Blocks the stop once if a dirty turn didn't `sync_workspace` (read from `hook-state/sync-<agent>.json`, written by the RPC handler, so any tool spelling counts), or if a root agent (Claude Code or Codex) didn't call `needs_you` (`shouldNudge`, from the one decision below), unless the turn already asked the developer through another tool (PostToolUse records `askedAt` when a call's input is an ask, `isAskInput`; [one decision, one card](#another-plugins-ask)). Also blocks to name the agent's due tasks (`pickNudges` over `scopes.json`'s `due`: at most 3, each at most twice and once a day; nothing when none is due; [due by fact](workspaces.md)). Never blocks twice in one turn, or while background tasks run. |

## Static text in the system prompt (Paseo 0.17)

On a host whose session-open result takes `appendSystemPrompt` (Paseo 0.17.0+, detected by `features.checkoutWorktreeList`,
which 0.17.0 first advertises; 0.16's schema is strict and would refuse the field), the worker puts the static parts
of the SessionStart text in the session's system prompt (`withSystemPrompt`, `server/session-prompt.ts`) for Claude
and for Codex from 0.121 (`codex --version`; older Codex throws on a new thread with plugin instructions). It names
the parts in `FOLLOW_UP_SYSTEM_PROMPT` (`needsYou`, `action`, `overseer`, `wait`, `backgroundWork`, `checks`) and the
hook leaves exactly those out, so the agent reads each once (`inPrompt`).

- **What moves** is only what the hook surely adds from the launch env (`promptParts`): a native root agent's role texts
  and `checksLine`, the Overseer's role texts, and Wait's guidance for any session. The workspace instructions stay
  the hook's: they follow the role and the PR workflow, which change mid-session.
- **Who gets what doesn't change**: `tests/session-prompt.test.ts` runs every role (main native and stdio, contributor,
  untracked root, the Overseer, a subagent, recovery, a background helper) on both paths and checks that the system
  prompt plus the hook equal what the hook alone added, each part once. Recovery and background agents get nothing
  (invariant 9).
- **Compaction:** the system prompt survives compaction and resume as it is; SessionStart still re-runs on compact and
  re-adds only what stayed the hook's. A setting changed mid-session (the inbox turned off) reaches the system prompt
  at the session's next open.
- On an older host or provider, nothing changes: no `appendSystemPrompt`, no flag, the hook adds it all.

## Other providers

Paseo runs agents on more than Claude Code and Codex (OpenCode, Pi, Oh My Pi, Copilot, Cursor, Kimi, Kiro, any ACP
agent), and Follow-up's hook lives only in those two. Every feature still works on every provider, from one capability
model, `providerCaps` (`shared/provider-support.ts`, an-agent-on-any-provider-gets-follow-up); no feature checks a
provider id of its own.

- **Tools and `needs_you`**: the same as on Claude or Codex, native through Paseo's agent MCP (or the bridge).
- **Instructions** (`instructions`): on Paseo 0.17 `withSystemPrompt` puts all of what the hook's SessionStart would
  add in the system prompt (`hooklessParts`): the tracked workspace's instructions (`workspaceInstructions`, exported
  `shared/agent-text.mjs` `workspaceText`, the same text the hook adds), the
  role texts and the checks line. `tests/session-prompt.test.ts` checks, for every role, that the prompt equals what the
  hook alone adds on Claude. Paseo passes it to OpenCode, Pi and plugin providers. ACP agents don't take a plugin's
  system prompt yet, so the same text is a tool, `follow_session_instructions` (`instructionsTool`), whose description
  tells the agent to read it first and after compaction; no `FOLLOW_UP_SYSTEM_PROMPT` claim. Which providers are ACP
  comes from Paseo's config (`isAcp`): a built-in ACP id, or any provider whose `extends` chain reaches one.
- **Turn-end checks** (`turnEnd: "event"`): the Stop hook's checks (sync after a turn that changed something, the
  `needs_you` nudge, due tasks) run from Paseo's turn-end event instead (`server/turn-end.ts`), with the hook's own
  words and the same decision (`turnEndDecision`, [one turn-end decision](#one-place-for-the-words-one-turn-end-decision)). An event can't block a
  stop, so they go as one queued message after the turn, only when something is due, never for the turn that message
  started (told from that turn's own prompt, so a worker restart in between can't start a loop), and only to the agent
  whose turn just ended (it is loaded). The `needs_you` nudge, free in-turn on a hook but a whole turn here, follows
  only a turn the developer started (their message or a card answer), never a repair, a recovery or another agent's
  message. Due tasks share the hook's receipt. A turn that only compacted is never checked (`compactionOnly`,
  invariant 130). A turn that asked the developer through another tool gets no `needs_you` nudge, and that call
  counts as no change for the sync check (`askedElsewhere`).
- **Wait** (`wait`): every provider with a shell tool. Outside Claude Code the prepared command detaches itself
  (`nohup … &`, its output in the job's `output.log`), so any shell tool can start it; see [wait.md](wait.md).
- **Not there**: the per-turn context (the Overseer's digest, the demoted and detached notices, which the Overseer and
  the tools' own results carry instead) and the polling nudge, which only a hook can add mid-turn.
- **Read-only jobs** (`guard`): see [ai-roles.md](ai-roles.md). `providerNotes` says in Settings → Agents' one block
  only what a provider the developer has can't do: an ACP agent's instructions come through a tool, and with Summaries
  on a provider without a guard, its linked items, Compass and Ask don't read (`guardAction`: use, turn on or install
  one that can, never a pick the developer can't make).

## One place for the words, one turn-end decision

Everything Follow-up says to an agent is in `shared/agent-text.mjs`, and the turn-end checks are decided by
`turnEndDecision` in `shared/turn-checks.mjs` (invariant 147). The hook and the bridge import both from the repository;
`scripts/build.mjs` inlines them into `hook-source.ts` and `mcp-source.ts` (`scripts/inline.mjs`), so the files the worker
writes to the data directory still import nothing. A test that runs the hook from a temp directory writes the shipped
copy (`tests/support/shipped.ts`).

The decision takes facts, never a provider: a tracked agent (main or contributor) that changed something and didn't
sync is reminded to; a root agent that isn't a contributor (a tracked main, or a root agent outside any tracked
workspace), with the inbox and its nudge on and no permission prompt, that didn't call `needs_you` or ask through
another tool, is nudged; a tracked agent's due tasks are named. The Stop hook counts every turn as changed (the
instructions ask for a sync every turn) and acts in the turn; the turn-end event sees the turn's timeline, so it counts
only a turn that changed something, and nudges only a turn the developer started, since its message costs a turn.

## Env flags

The worker sets these at `agent.session_open`:

- `FOLLOW_UP_TOOLS`: `native` or `stdio`.
- `FOLLOW_UP_PROVIDER`.
- `FOLLOW_UP_ROOT`.
- `FOLLOW_UP_BRIEF`: the provider, when the nudge applies.
- `FOLLOW_UP_SYSTEM_PROMPT`: Paseo 0.17, the static parts already in the system prompt (comma-separated).
- `FOLLOW_UP_OVERSEER`.
- `FOLLOW_UP_RECOVERY`.
- `FOLLOW_UP_CLI`: the bridge path.
- `FOLLOW_UP_WAIT`.
- `FOLLOW_UP_BACKGROUND_WORK` (Paseo 0.16, instead of `FOLLOW_UP_WAIT`).

Tests: `tests/agent-hooks.test.ts` and `tests/hook-native.test.ts` (the hook is imported with
`FOLLOW_UP_HOOK_IMPORT=1`, so `main()` doesn't run), plus `tests/session-mcp.test.ts`.

## Another plugin's ask

Another plugin can have its own ask-the-developer tool (a question board's `*_question_ask`, Claude Code's
AskUserQuestion). A turn whose ask went through one already put its decision in front of the developer, so neither
the Stop hook nor the turn-end event nudges `needs_you` for it: the agent would restate it as a second card
(`one-decision-one-card`, invariant 73). An ask is told by its input's shape, never by tool name: a question with
choices, `{question, options[]}` or `{questions: [{question, options[]}, …]}`, from a tool that isn't Follow-up's, that
finished without an error. A bare `question` with no choices is a lookup (a docs or code search), not an ask.
`isAskInput` in `shared/turn-checks.mjs` is the rule (the hook carries it inlined), `askedElsewhere` in `shared/ask-shape.ts` reads a timeline with it, and
`tests/other-ask.test.ts` checks both agree. The sync check and due tasks are unchanged.
