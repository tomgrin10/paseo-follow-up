import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { State } from "../shared/model";

export type Role = "main" | "contributor" | "recovery";
/**
 * Which agents Follow-up tracks and in what role, for the MCP bridge and the agent hook (1.3.0-beta.4). Every
 * agent runs both; they used to parse the whole state.json (5.3 MB on the VM) every 2 seconds and on every tool
 * call. This file is a few KB and rewritten only when a role changes.
 */
export function scopes(state: State): Record<string, { role: Role; workspaceId: string }> {
  const agents: Record<string, { role: Role; workspaceId: string }> = {};
  for (const w of state.workspaces) {
    if (!w.enable_tracking || w.archived) continue;
    for (const id of w.contributorAgentIds ?? []) agents[id] ??= { role: "contributor", workspaceId: w.id };
    for (const b of w.batches) if (b.recipientAgentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory")) agents[b.recipientAgentId] = { role: "recovery", workspaceId: w.id };
    agents[w.mainAgentId] = { role: "main", workspaceId: w.id };
  }
  return agents;
}
/** Writes scopes.json when it differs from the last write. */
export function scopeWriter(directory: string) {
  let last: string | null = null;
  return async (state: State): Promise<void> => {
    const text = JSON.stringify({ version: 1, agents: scopes(state) });
    if (text === last) return;
    if (last === null && await readFile(join(directory, "scopes.json"), "utf8").catch(() => null) === text) { last = text; return; }
    const temporary = join(directory, `scopes.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, join(directory, "scopes.json"));
    last = text;
  };
}
