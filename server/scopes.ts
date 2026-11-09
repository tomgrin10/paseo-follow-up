import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { State, Workspace } from "../shared/model";
import type { AgentWorkflow, PrWorkflow } from "../shared/pr-workflow";

export type Role = "main" | "contributor" | "recovery";
/**
 * Which agents Follow-up tracks and in what role, for the MCP bridge and the agent hook (1.3.0-beta.4). Every
 * agent runs both; they used to parse the whole state.json (5.3 MB on the VM) every 2 seconds and on every tool
 * call. This file is a few KB and rewritten only when a role changes.
 */
type Entry = { role: Role; workspaceId: string; workflow?: AgentWorkflow };
/**
 * `workflow` (1.4.0-beta.14) is the workspace's PR workflow and review-fix command, so the hook and bridge give
 * GitHub-only workspaces GitHub instructions. Absent: Graphite with /fix-pr, as every earlier version said.
 */
export function scopes(state: State, workflow?: (w: Workspace) => AgentWorkflow): Record<string, Entry> {
  const agents: Record<string, Entry> = {};
  for (const w of state.workspaces) {
    if (!w.enable_tracking || w.archived) continue;
    const flow = workflow ? { workflow: workflow(w) } : {};
    for (const id of w.contributorAgentIds ?? []) agents[id] ??= { role: "contributor", workspaceId: w.id, ...flow };
    for (const b of w.batches) if (b.recipientAgentId && !b.settledAt && ["sending", "sent", "blocked", "uncertain"].includes(b.state) && b.tasks.every(t => t.kind === "inventory")) agents[b.recipientAgentId] = { role: "recovery", workspaceId: w.id, ...flow };
    agents[w.mainAgentId] = { role: "main", workspaceId: w.id, ...flow };
  }
  return agents;
}
/** One word for the action tools' descriptions: every known repository's workflow, or "mixed". */
export function workflowSummary(modes: Iterable<PrWorkflow>): PrWorkflow | "mixed" | null {
  const set = new Set(modes);
  return set.size === 0 ? null : set.size === 1 ? [...set][0] : "mixed";
}
/** Writes scopes.json when it differs from the last write. */
export function scopeWriter(directory: string, workflow?: { agent(w: Workspace): AgentWorkflow; summary(state: State): PrWorkflow | "mixed" | null }) {
  let last: string | null = null;
  return async (state: State): Promise<void> => {
    const text = JSON.stringify(workflow ? { version: 1, agents: scopes(state, w => workflow.agent(w)), workflows: workflow.summary(state) } : { version: 1, agents: scopes(state) });
    if (text === last) return;
    if (last === null && await readFile(join(directory, "scopes.json"), "utf8").catch(() => null) === text) { last = text; return; }
    const temporary = join(directory, `scopes.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, join(directory, "scopes.json"));
    last = text;
  };
}
