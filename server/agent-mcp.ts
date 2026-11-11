import { join } from "node:path";

export type McpDefinition = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export function mcpDefinition(directory: string, clientEntry: string, home: string, runtime = { execPath: process.execPath, electron: process.versions.electron, appImage: process.env.APPIMAGE }): McpDefinition {
  return { type: "stdio", command: runtime.electron ? runtime.appImage ?? runtime.execPath : runtime.execPath, args: [join(directory, "mcp.mjs")], env: { FOLLOW_UP_MANAGED: "1", FOLLOW_UP_CLIENT_ENTRY: clientEntry, PASEO_HOME: home, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } };
}
