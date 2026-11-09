/**
 * Whether Paseo has this agent's runtime in memory right now.
 *
 * Reading an agent's timeline (fetch_agent_timeline) or its provider subagents goes through the daemon's
 * ensureAgentLoaded, which resumes an unloaded agent from persistence (provider CLI plus every MCP server,
 * about 650 MB) and keeps it loaded for an hour. Follow-up must never do that on its own.
 *
 * An unloaded agent's snapshot is projected from its stored record and reports the last persisted
 * status (usually "idle", rarely "closed"), so status alone can't tell. A loaded agent's snapshot always
 * carries `activeTurn` (null between turns); the stored projection never does. Running, initializing and
 * permission-waiting agents are live by definition. Anything else is treated as unloaded: when in doubt,
 * don't wake it.
 */
export type LoadSignals = { status: string; activeTurn?: unknown; pendingPermissions?: unknown[] | null };
export const LIVE_STATUSES = ["running", "initializing"];
export function isLoaded(agent: LoadSignals | null | undefined): boolean {
  if (!agent) return false;
  if (LIVE_STATUSES.includes(agent.status) || !!agent.pendingPermissions?.length) return true;
  return agent.status !== "closed" && Object.prototype.hasOwnProperty.call(agent, "activeTurn") && agent.activeTurn !== undefined;
}
