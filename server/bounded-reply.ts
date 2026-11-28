import { compact } from "./mcp.mjs";
import { agentView } from "../shared/history";
import { TOOL_BUDGET } from "../shared/paged";
import type { Workspace } from "../shared/model";

/**
 * An agent tool's answer stays under TOOL_BUDGET (invariant 63). A stored workspace record grows with use: every PR it
 * ever had, every task and question, every batch. A reply that carries one whole (a planned action's confirm returns the
 * workspace it changed) gets it as workspace_status's summary instead (`agentView`, then `compact`): live work whole
 * while it fits, finished items as the newest few and a count with how to page them, fitted to the room the rest of the
 * reply leaves. AgentActions.run passes every action's reply through here; tests/bounded-tools.test.ts scans every tool.
 */
export const isWorkspaceRecord = (x: unknown): x is Workspace => {
  const w = x as Partial<Workspace> | null;
  return !!w && typeof w === "object" && typeof w.id === "string" && Array.isArray(w.prs) && Array.isArray(w.obligations) && Array.isArray(w.questions) && Array.isArray(w.batches);
};

const PLACEHOLDER = Symbol("workspace");

/** Replace each workspace record (to depth 4) with `swap(w)`; the same object back when there is none. */
function replace(value: unknown, swap: (w: Workspace) => unknown, depth = 0): unknown {
  if (isWorkspaceRecord(value)) return swap(value);
  if (depth >= 4 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out = value.map(v => replace(v, swap, depth + 1));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) { out[k] = replace(v, swap, depth + 1); if (out[k] !== v) changed = true; }
  return changed ? out : value;
}

export function boundReply(reply: unknown, budget = TOOL_BUDGET): unknown {
  let count = 0;
  const shell = replace(reply, () => { count++; return PLACEHOLDER; });
  if (!count) return reply;
  const rest = JSON.stringify(shell, (_k, v) => v === PLACEHOLDER ? {} : v)?.length ?? 0;
  const room = Math.max(2_000, Math.floor((budget - rest) / count));
  const summary = (w: Workspace) => compact("workspace_status", {}, agentView(w, { budget: room }, undefined, v => compact("workspace_status", {}, v)));
  return replace(reply, summary);
}
