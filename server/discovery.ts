import type { Submission } from "./submissions";
import type { Artifact } from "../shared/spec";
import { mergeArtifacts } from "./spec";
import type { State, Workspace } from "../shared/model";

export type History = { candidates: string[]; goal: string | null; complete: boolean; error: string | null };
export type DiscoveredWorkspace = { id: string; title: string; mainAgentId: string; messageAt: string | null; projectId?: string | null; enable_default_tracking?: boolean; history?: History; contributorAgentIds?: string[]; submissions?: Submission[]; artifacts?: Artifact[] };

export function extractHistory(items: readonly unknown[], complete = true, error: string | null = null): History {
  const candidates = new Set<string>();
  let goal: string | null = null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = item as { type?: string; text?: string };
    if (value.type === "reasoning" || value.type === "plugin") continue;
    const text = typeof value.text === "string" ? value.text : JSON.stringify(item);
    if (/^(Workspace follow-through batch|Follow-through batch|Follow-through recovery|Follow-up answer) /.test(text)) continue;
    if (!goal && value.type === "user_message" && value.text && !value.text.trimStart().startsWith("<"))
      goal = value.text.trim().replace(/\s+/g, " ").slice(0, 350) || null;
    for (const match of text.matchAll(/https:\/\/(?:github\.com|app\.graphite\.(?:com|dev)\/github\/pr)\/([\w.-]+)\/([\w.-]+)\/(?:pull\/)?(\d+)(?=[/?#\s)\]"'.,;:<>}]|$)/g))
      candidates.add(`${match[1]}/${match[2]}#${Number(match[3])}`);
  }
  return { candidates: [...candidates].sort(), goal, complete, error };
}

/**
 * 1.2.0-beta.1: review threads and red CI are the agent's work, so a workspace tracked for the first time sends its
 * repair batches on its own. "First time" means it has never held PRs, tasks or batches; a workspace tracked before
 * keeps whatever auto-send it had (the store can't tell "never set" from "turned off", so nothing is flipped).
 */
export function firstTracking(w: Pick<Workspace, "enable_tracking" | "prs" | "obligations" | "batches">): boolean {
  return !w.enable_tracking && !w.prs.length && !w.obligations.length && !w.batches.length;
}

export function applyDiscovery(state: State, discovered: DiscoveredWorkspace[], now: number): void {
  for (const row of discovered) {
    let w = state.workspaces.find(w => w.id === row.id);
    if (!w) {
      w = { id: row.id, title: row.title, goal: row.history?.goal ?? row.title, mainAgentId: row.mainAgentId,
        enable_tracking: false, enable_auto_sends: false, hold: null, archived: false, prs: [], obligations: [], batches: [], excludedStacks: [], prActions: [], questions: [], spec: null, artifacts: [], completion: null,
        updatedAt: new Date(now).toISOString(), managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false, inventory: null };
      state.workspaces.push(w);
    }
    w.title = row.title;
    // An unavailable original owner is surfaced instead of silently transferring its authority.
    if (w.mainAgentId !== row.mainAgentId || w.archived) continue;
    if (row.contributorAgentIds) w.contributorAgentIds = row.contributorAgentIds;
    if (row.enable_default_tracking && !w.enable_tracking && (!row.projectId || state.projectDefaults?.[row.projectId] !== false)) { w.enable_auto_sends = firstTracking(w); w.enable_tracking = true; }
    if (!w.inventory) {
      w.inventory = { revision: 1, syncedRevision: 0, candidates: [], historyComplete: false, historyError: null, scannedMessageAt: null };
      w.completion = null;
    }
    if (row.history) {
      if (w.goal === row.title && row.history.goal) w.goal = row.history.goal;
      applyHistory(w, row.history, row.messageAt);
    }
    if (w.enable_tracking && row.artifacts) mergeArtifacts(w, row.artifacts, now);
    for (const receipt of row.submissions ?? []) {
      const key = `${receipt.repo}#${receipt.number}`;
      if (!w.enable_tracking || w.prs.some(p => p.key === key) ||
        w.excludedStacks.some(stack => stack.prs.some(p => p.key === key)) ||
        state.workspaces.some(other => other.id !== w.id && other.enable_tracking && !other.archived && other.prs.some(p => p.key === key))) continue;
      w.prs.push({ key, repo: receipt.repo, number: receipt.number, registeredAgentId: receipt.agentId,
        discoveredFromSubmission: true, stack: receipt.branch ?? `PR #${receipt.number}`, parent: null, disposition: null, snapshot: null, error: null });
      w.completion = null; w.updatedAt = new Date(now).toISOString();
    }
  }
}

export function applyHistory(w: Workspace, history: History, messageAt: string | null): void {
  const inventory = w.inventory;
  if (!inventory) return;
  const added = history.candidates.filter(key => !inventory.candidates.includes(key));
  const excludedKeys = new Set(w.excludedStacks.flatMap(stack => stack.prs.map(p => p.key)));
  if (added.some(key => !excludedKeys.has(key) && !w.prs.some(pr => pr.key === key))) {
    inventory.revision++;
    w.completion = null;
  }
  inventory.candidates = [...new Set([...inventory.candidates, ...added])].sort();
  inventory.historyComplete = history.complete;
  inventory.historyError = history.error;
  inventory.scannedMessageAt = messageAt;
}
