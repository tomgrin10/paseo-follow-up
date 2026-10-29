import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { mcpDefinition } from "./agent-mcp";

/** The bridge and caller identity belong to this launch, never global CLI config. */
export function withSessionMcp(request: PluginSessionOpenRequest, directory: string, clientEntry: string, home: string, recovery: boolean, env: NodeJS.ProcessEnv = process.env): PluginSessionOpenRequest {
  if (request.purpose !== "interactive" || !["claude", "codex"].includes(request.provider) || request.labels["plugin-tools/enabled"] === "false") return request;
  const definition = mcpDefinition(directory, clientEntry, home);
  return { ...request, mcpServers: { ...request.mcpServers, "follow-through": { ...definition, env: {
    ...definition.env, PASEO_AGENT_ID: request.agentId,
    ...(recovery ? { FOLLOW_THROUGH_RECOVERY: "1" } : {}),
    ...(env.PASEO_DAEMON_URL ? { PASEO_DAEMON_URL: env.PASEO_DAEMON_URL } : {}),
    ...(env.PASEO_PASSWORD ? { PASEO_PASSWORD: env.PASEO_PASSWORD } : {}),
    ...(env.PASEO_PASSWORD_FILE ? { PASEO_PASSWORD_FILE: env.PASEO_PASSWORD_FILE } : {}),
  } } } };
}
