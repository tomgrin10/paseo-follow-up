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
export type LoadSignals = { status: string; activeTurn?: unknown; pendingPermissions?: unknown[] | null; backgroundWork?: { count?: unknown } | null };
export const LIVE_STATUSES = ["running", "initializing"];
/**
 * Paseo 0.16 reports an agent's live background work (shells, tasks it started and ended its turn on) as
 * `backgroundWork: { count }` in fetch_agent and the agent list. Absent on 0.15, so 0 there. Anything but a positive
 * number reads as 0: `backgroundWork.list()` throws before an agent's first turn, and unknown is not busy here.
 */
export type WorkSignals = { status: string; backgroundWork?: { count?: unknown } | null };
export function backgroundCount(agent: WorkSignals | null | undefined): number {
  const n = agent?.backgroundWork?.count;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}
/** Running for Follow-up: mid-turn, starting, or (0.16) with live background work. Status invariant background-work-is-running. */
export const isLive = (agent: WorkSignals | null | undefined) => !!agent && (LIVE_STATUSES.includes(agent.status) || backgroundCount(agent) > 0);
/** The status Follow-up acts on: an idle agent whose background work is still live reads "running" (no finished, no repairs). */
export const liveStatus = (agent: WorkSignals) => !LIVE_STATUSES.includes(agent.status) && backgroundCount(agent) > 0 ? "running" : agent.status;
export function isLoaded(agent: LoadSignals | null | undefined): boolean {
  if (!agent) return false;
  if (isLive(agent) || !!agent.pendingPermissions?.length) return true;
  return agent.status !== "closed" && Object.prototype.hasOwnProperty.call(agent, "activeTurn") && agent.activeTurn !== undefined;
}
