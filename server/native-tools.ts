import { z } from "zod";
import type { AgentToolDefinition, AgentToolContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { actionTools, callInput, compact, overseerTools, schemas, toolList, validate, type ToolTuple } from "./mcp.mjs";
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

/** The same rule as the stdio bridge's per-request `available` list. */
export function availableTools(flags: SessionFlags, live: Live): ToolTuple[] {
  const brief = flags.brief && live.inbox && !flags.recovery;
  const acting = flags.root && !flags.recovery;
  const role = live.role === "main" && flags.recovery ? "recovery" : live.role;
  const base = role ? toolList(role === "recovery", role === "contributor", brief, false, acting) : toolList(false, false, brief, true, acting);
  return [...base, ...(flags.overseer && !flags.recovery ? overseerTools : [])];
}

/** Everything this session could be offered, so a role that changes mid-session needs no reopen; calls re-check. */
export function attachableTools(flags: SessionFlags): ToolTuple[] {
  if (flags.recovery) return toolList(true, false, false, false, false);
  const all = toolList(false, false, flags.brief, false, flags.root);
  return [...all, ...(flags.root ? actionTools.filter(t => !all.some(a => a[0] === t[0])) : []), ...(flags.overseer ? overseerTools : [])];
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
export function nativeTools(flags: SessionFlags, live: (agentId: string) => Promise<Live>, invoke: Invoke, workflows: "graphite" | "github" | "mixed" | null = null): AgentToolDefinition[] {
  const list = attachableTools(flags);
  const shapes = schemas(list, workflows);
  return list.map((tool, i) => ({
    name: PREFIX + tool[0],
    description: shapes[i].description,
    input: (z as unknown as { fromJSONSchema: (schema: unknown) => z.ZodType }).fromJSONSchema(shapes[i].inputSchema),
    async execute(input: unknown, context: AgentToolContext) {
      try {
        const current = availableTools(flags, await live(context.agent.id)).find(t => t[0] === tool[0]);
        if (!current) throw new Error("This tool is unavailable for the current agent. Tracking must be active; recovery authority ends after acknowledgment.");
        const args = (input ?? {}) as Record<string, unknown>;
        validate(args, shapes[i].inputSchema);
        const value = await invoke(current[2], { ...callInput(current, args), agentId: context.agent.id }, context);
        return { text: JSON.stringify(args.detail === "full" ? value : compact(current[0], args, value)) };
      } catch (error) { return { isError: true, text: (error as Error).message }; }
    },
  }));
}
