# Serving a plugin's agent tools without a process per agent

Follow-up 1.4.0-beta.2 stopped running a `node mcp.mjs` stdio server inside every Claude and Codex session. On the
VM that was 34 processes and about 1.9 GB of private memory, plus one process in every non-Paseo Claude session
because of a user-scope registration. This note is the pattern, written so another plugin (Smart Session next) can
copy it.

## The mechanism (Paseo 0.15+)

`agent.session_open` hands a plugin `request.tools`. Push `AgentToolDefinition`s onto it:

```ts
server.before("agent.session_open", async ({ request }) => {
  if (!Array.isArray(request.tools)) return request; // Paseo 0.14: fall back (below)
  return { ...request, tools: [...request.tools, {
    name: "smart_status",               // [a-z][a-z0-9_]*, ≤64; prefix it (see below)
    description: "One short sentence.",
    input: z.object({ … }),            // zod; the host turns it into JSON Schema and parses input with it
    async execute(input, { agent, paseo, signal }) {
      // runs in your plugin process; agent.id comes from the daemon
      return { text: JSON.stringify(result) };   // or { isError: true, text }
    },
  }] };
});
```

The daemon then lists these tools on the agent's existing Paseo MCP server (`mcp__paseo__<name>` in Claude,
`paseo.<name>` in Codex) and routes calls to `execute` in your plugin process over IPC. No new process, no port, no
token code of your own.

## Why it's better than a per-agent stdio server

- **Memory.** Zero per agent; the calls run in the plugin process you already have.
- **Identity.** `context.agent.id` comes from the daemon's per-agent MCP endpoint and token. A stdio bridge only knows
  `PASEO_AGENT_ID` from its environment, and any local process holding the daemon password could claim any id.
- **Lifecycle.** Tools are detached when the agent closes or the plugin reloads (the daemon re-opens stale plugin
  sessions), so nothing outlives your worker.

## Things to get right

1. **Prefix every name** (`follow_`, `smart_`). Plugin tools share one namespace with Paseo's own tools; a collision
   throws and takes down the agent's whole Paseo tool list.
2. **The list is fixed per session open.** There's no `notifications/tools/list_changed`. Attach everything the
   session could need for its lifetime and re-check permissions inside `execute` on every call
   (`server/native-tools.ts`: `attachableTools` vs `availableTools`).
3. **No MCP `instructions`.** Put role text in your agent hooks (`SessionStart`, which Claude also fires after
   compaction) and keep tool descriptions short: the Paseo tool list is shared by every plugin. Claude keeps hook
   context for the session, so send it once per session instead of on every prompt (`agent-hook.mjs`:
   `shouldRepeat`). Follow-up's main-agent text was ~1.3k tokens per turn before that change.
4. **Know when the host won't serve them** and fall back to a stdio server for that launch only:
   no `request.tools` (Paseo 0.14), `daemon.mcp.enabled === false` or `injectIntoAgents === false` in
   `config.json`, or the provider's `agents.providers.<id>.paseoTools.enabled === false` / `disabledTools`
   (`nativeToolsAvailable`).
5. **Never register globally.** A user-scope MCP entry (`~/.claude.json`, `~/.codex/config.toml`) starts the
   process in every session on the machine. Check every home Paseo launches with: the defaults,
   `CLAUDE_CONFIG_DIR`/`CODEX_HOME` in `agents.providers.<id>.env`, and zerosub's
   `~/.paseo/zerosub/homes/<id>/`. Zerosub copies the main `.claude.json`'s servers into its homes, so remove the
   entry from the main file too (`server/mcp-registrations.ts`).
6. **Tell the hooks and UI which names the agent has.** Sessions opened before the upgrade keep the old names
   until they reopen. Follow-up sets `FOLLOW_THROUGH_TOOLS=native|stdio` in the agent env and matches both
   name forms wherever it reads tool calls.
7. **Reuse your handlers.** Follow-up records every `server.handle` handler in a map and calls it in-process from
   `execute` with `{ paseo: context.paseo }`, so the stdio bridge and the native tools run the same code.

## Testing it

`scripts/check-native-tools.mjs` starts an isolated daemon with its agent MCP on, attaches tools to fixture
agents, reads each agent's launch config (no per-agent stdio server), then calls a tool over the daemon's MCP
endpoint the way Claude would and checks the caller's identity resolved. `--stdio` runs the old path for comparison.
