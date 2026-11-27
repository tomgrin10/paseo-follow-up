import { z } from "zod";
import type { AgentToolDefinition, AgentToolContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { callableTools, compact, overseerTools, runTool, schemas, toolList, validate, type ToolTuple } from "./mcp.mjs";
import type { Role } from "./scopes";

/**
 * 1.4.0-beta.2: Follow-up's agent tools served natively. At agent.session_open they're attached to request.tools,
 * and the daemon serves them through the agent's own Paseo MCP (its per-agent endpoint and token), so no
 * per-agent node process runs and the caller's id comes from the daemon rather than an environment variable. Calls
 * run in this worker with the same availability rules, validation and compact receipts as the stdio bridge
 * (server/mcp.mjs), which remains the fallback where this isn't available.
 *
 * Tool names carry a follow_ prefix: plugin tools share one namespace with Paseo's own (a collision fails the
 * agent's whole Paseo tool list), and other plugins prefix theirs the same way.
 */
export const PREFIX = "follow_";

/** What session_open knew about the agent; the per-call check also reads the agent's current role. */
export type SessionFlags = { recovery: boolean; brief: boolean; root: boolean; overseer: boolean };
export type Live = { role: Role | null; inbox: boolean };

/** The same rule as the stdio bridge's per-request list: what the agent's current role may call (ROLE_TOOLS). */
export function availableTools(flags: SessionFlags, live: Live): ToolTuple[] {
  const brief = flags.brief && live.inbox && !flags.recovery;
  const acting = flags.root && !flags.recovery;
  const role = live.role === "main" && flags.recovery ? "recovery" : live.role;
  const base = role ? callableTools(role === "recovery", role === "contributor", brief, false, acting) : callableTools(false, false, brief, true, acting);
  return [...base, ...(flags.overseer && !flags.recovery ? overseerTools : [])];
}

/**
 * What this session lists: every tool its role could list for its lifetime (a role that changes mid-session needs no
 * reopen; calls re-check), which is the main agent's, a contributor's and an untracked root agent's lists together.
 * The long tail of actions stays behind find_action/run_action (agent-tools-by-role).
 */
export function attachableTools(flags: SessionFlags): ToolTuple[] {
  if (flags.recovery) return toolList(true, false, false, false, false);
  const all: ToolTuple[] = [];
  for (const list of [toolList(false, false, flags.brief, false, flags.root), toolList(false, true, flags.brief, false, flags.root), toolList(false, false, flags.brief, true, flags.root)])
    for (const t of list) if (!all.some(a => a[0] === t[0])) all.push(t);
  return [...all, ...(flags.overseer ? overseerTools : [])];
}

type PaseoConfig = { daemon?: { mcp?: { enabled?: boolean; injectIntoAgents?: boolean } }; agents?: { providers?: Record<string, { paseoTools?: { enabled?: boolean; disabledTools?: string[] } }> } };
/** Whether this host serves plugin tools to this agent: request.tools exists (Paseo 0.15+), the daemon injects its MCP, and the provider's Paseo tools aren't off. */
export function nativeToolsAvailable(request: Pick<PluginSessionOpenRequest, "provider"> & { tools?: unknown }, config: PaseoConfig | null): boolean {
  if (!Array.isArray(request.tools)) return false;
  if (config?.daemon?.mcp?.enabled === false || config?.daemon?.mcp?.injectIntoAgents === false) return false;
  const policy = config?.agents?.providers?.[request.provider]?.paseoTools;
  if (policy?.enabled === false) return false;
  return !policy?.disabledTools?.some(name => name.startsWith(PREFIX));
}

export type Invoke = (method: string, input: Record<string, unknown>, context: AgentToolContext) => Promise<unknown>;
/** The tool definitions for one session. `live` reads the agent's current role and the inbox setting on each call. */
/** `workflows`: whether known repositories ship through Graphite, GitHub or both, for merge tools' wording. */
/**
 * `lead`: text that goes before one call's result, once (server/session-prompt.ts changedInstructions: workspace
 * instructions that changed since the session's system prompt). Any provider reads a tool result.
 */
export function nativeTools(flags: SessionFlags, live: (agentId: string) => Promise<Live>, invoke: Invoke, workflows: "graphite" | "github" | "mixed" | null = null, lead?: (agentId: string) => Promise<string | null>): AgentToolDefinition[] {
  const list = attachableTools(flags);
  const shapes = schemas(list, workflows);
  return list.map((tool, i) => ({
    name: PREFIX + tool[0],
    description: shapes[i].description,
    input: (z as unknown as { fromJSONSchema: (schema: unknown) => z.ZodType }).fromJSONSchema(shapes[i].inputSchema),
    async execute(input: unknown, context: AgentToolContext) {
      try {
        const callable = availableTools(flags, await live(context.agent.id));
        const current = callable.find(t => t[0] === tool[0]);
        if (!current) throw new Error("This tool is unavailable for the current agent. Tracking must be active; recovery authority ends after acknowledgment.");
        const args = (input ?? {}) as Record<string, unknown>;
        validate(args, shapes[i].inputSchema);
        const { name, args: used, value } = await runTool(current, args, callable, (method: string, body: Record<string, unknown>) => invoke(method, { ...body, agentId: context.agent.id }, context), workflows);
        const result = JSON.stringify(used.detail === "full" ? value : compact(name, used, value));
        const before = lead ? await lead(context.agent.id).catch(() => null) : null;
        return { text: before ? `${before}\n\n${result}` : result };
      } catch (error) { return { isError: true, text: (error as Error).message }; }
    },
  }));
}
