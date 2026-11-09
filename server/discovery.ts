import type { Submission } from "./submissions";
import type { Artifact } from "../shared/spec";
import { mergeArtifacts } from "./spec";
import type { State, Workspace } from "../shared/model";
import { autoSendsByDefault, followsByDefault } from "../shared/settings";

export type History = { candidates: string[]; goal: string | null; complete: boolean; error: string | null };
export type DiscoveredWorkspace = { id: string; title: string; mainAgentId: string; /** Set when mainAgentId is a live successor to this closed or gone main agent. */ replacesMainAgentId?: string; messageAt: string | null; projectId?: string | null; enable_default_tracking?: boolean; history?: History; contributorAgentIds?: string[]; submissions?: Submission[]; artifacts?: Artifact[]; /** In the active scope (see workspaceActive). Undefined means unknown, treated as active. */ active?: boolean };

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

/** Auto-send for a workspace Follow-up starts following: the global "Send repairs automatically" (default on). */
export function startsWithAutoSend(state: Pick<State, "enable_auto_sends_default">, _w?: unknown): boolean {
  return autoSendsByDefault(state);
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
    if (row.active !== undefined) {
      if (row.active) delete w.dormant; else w.dormant = true;
      // Auto-send parked by the active-scope migration comes back once the workspace is active again.
      if (row.active && state.autoSendsParked?.includes(w.id)) {
        if (w.enable_tracking && !w.archived) w.enable_auto_sends = true;
        state.autoSendsParked = state.autoSendsParked.filter(id => id !== w.id);
        if (!state.autoSendsParked.length) delete state.autoSendsParked;
      }
    }
    // A closed or gone main agent hands the workspace to its live successor (discovery decides; see
    // successorMainAgent). Any other mismatch keeps the recorded owner.
    if (row.replacesMainAgentId && row.replacesMainAgentId === w.mainAgentId && !w.archived) {
      w.mainAgentId = row.mainAgentId; w.runtimeReason = null;
      for (const b of w.batches) if (b.state === "pending" && b.recipientAgentId === row.replacesMainAgentId) b.recipientAgentId = null;
    }
    if (w.mainAgentId !== row.mainAgentId || w.archived) continue;
    // A new main agent, or a new message to the gone one, means its conversation can be tried again.
    if (w.goneAgent && (w.goneAgent.agentId !== w.mainAgentId || (row.messageAt && row.messageAt > w.goneAgent.at))) w.goneAgent = null;
    if (row.contributorAgentIds) w.contributorAgentIds = row.contributorAgentIds;
    if (!w.enable_tracking && followsByDefault(state, row)) { w.enable_auto_sends = startsWithAutoSend(state, w); w.enable_tracking = true; }
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
