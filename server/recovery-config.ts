import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import type { Agent } from "./daemon";

type Config = Partial<PluginBeforeRequests["agent.create"]["config"]>;

export async function recoveryConfig(home: string, main: Agent): Promise<Config> {
  if (!/^[\w-]+$/.test(main.id)) throw new Error("Main agent has an unsupported storage identity");
  const { root } = win32.parse(main.cwd);
  const withoutRoot = main.cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const directory = withoutRoot ? (sanitizedRoot ? `${sanitizedRoot}-` : "") + withoutRoot.replace(/[\\/]+/g, "-") : sanitizedRoot || "root";
  let record;
  try { record = JSON.parse(await readFile(join(home, "agents", directory, `${main.id}.json`), "utf8")); }
  catch { throw new Error("Could not read the main agent's saved configuration; recovery was not launched with defaults"); }
  if (record.id !== main.id || record.workspaceId !== main.workspaceId || record.cwd !== main.cwd || record.provider !== main.provider)
    throw new Error("Main agent configuration no longer matches its workspace identity");
  const saved = record.config ?? {};
  const config: Config = {};
  for (const key of ["modeId", "model", "thinkingOptionId", "featureValues", "providerOptions", "toolPolicy", "systemPrompt", "mcpServers"] as const)
    if (saved[key] !== null && saved[key] !== undefined) Object.assign(config, { [key]: saved[key] });
  if (main.model) config.model = main.model;
  if (main.currentModeId) config.modeId = main.currentModeId;
  if (main.thinkingOptionId !== undefined) {
    if (main.thinkingOptionId === null) delete config.thinkingOptionId;
    else config.thinkingOptionId = main.thinkingOptionId;
  }
  if (main.features) config.featureValues = { ...config.featureValues, ...Object.fromEntries(main.features.map(feature => [feature.id, feature.value])) };
  return config;
}
