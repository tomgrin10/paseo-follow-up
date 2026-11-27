import { hookSource } from "../../server/hook-source";
import { mcpSource } from "../../server/mcp-source";

/**
 * The agent hook and the stdio bridge as the worker writes them to the data directory: one file each, with
 * shared/agent-text.mjs and shared/turn-checks.mjs inlined (scripts/build.mjs). A test that runs either from a temp
 * directory writes this, never the repository source, which imports ../shared/.
 */
const SHIPPED: Record<string, string> = { "agent-hook.mjs": hookSource, "mcp.mjs": mcpSource };
export function shipped(file: string): string {
  const text = SHIPPED[file.replace(/^.*\//, "")];
  if (text === undefined) throw new Error(`no shipped copy of ${file}`);
  return text;
}

/** Imports the shipped copy as a library (FOLLOW_UP_HOOK_IMPORT=1, so the hook's main() doesn't run). */
export async function importShipped<T = Record<string, unknown>>(file: string): Promise<T> {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  process.env.FOLLOW_UP_HOOK_IMPORT = "1";
  const path = join(mkdtempSync(join(tmpdir(), "follow-shipped-")), file.replace(/^.*\//, ""));
  writeFileSync(path, shipped(file));
  return await import(pathToFileURL(path).href) as T;
}
