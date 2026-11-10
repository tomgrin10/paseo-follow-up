import type { Submission } from "./submissions";
import type { Artifact } from "../shared/spec";
import { mergeArtifacts } from "./spec";
import type { State, Workspace } from "../shared/model";
import { autoSendsByDefault, followsByDefault } from "../shared/settings";
import { interruptionHold } from "../shared/status";

export type History = { candidates: string[]; goal: string | null; complete: boolean; error: string | null };
export type DiscoveredWorkspace = { id: string; title: string; mainAgentId: string; /** Set when mainAgentId is a live successor to this closed or gone main agent. */ replacesMainAgentId?: string; /** The replacement is the original main agent taking the workspace back (Workspace.handover). */ handBack?: boolean; /** The recorded main agent reads "closed" right now. */ mainClosed?: boolean; messageAt: string | null; projectId?: string | null; enable_default_tracking?: boolean; history?: History; contributorAgentIds?: string[]; submissions?: Submission[]; artifacts?: Artifact[]; /** In the active scope (see workspaceActive). Undefined means unknown, treated as active. */ active?: boolean };

export { interruptionHold };

/**
 * Moves the workspace to another main agent: automatic handover, hand-back, or the developer's "Make main agent".
 * A stop hold raised by another agent's turn doesn't carry over to the new main (a hold from before 1.4.0-beta.16
 * names no agent, so only the developer's explicit choice clears it).
 */
/** Main-agent claim rules (~/paseo-harness/main-agent-claim.md, approved 2026-11-10). */
export const MAIN_CHANGE_COOLDOWN_MS = 30 * 60_000;
export const MAIN_RECLAIM_MS = 2 * 60 * 60_000;
export const MAIN_IDLE_MS = 24 * 60 * 60_000;
export const MAIN_NOTICE_MS = 24 * 60 * 60_000;
export type MainChange = NonNullable<Workspace["mainHistory"]>[number];

/** The newest change of main agent, if any. */
export const lastMainChange = (w: Pick<Workspace, "mainHistory">): MainChange | undefined => w.mainHistory?.at(-1);
/** Within the cooldown after any change: no self-claim and no automatic handover (the developer is exempt). */
export const inMainCooldown = (w: Pick<Workspace, "mainHistory">, now: number) => { const last = lastMainChange(w); return !!last && now - Date.parse(last.at) < MAIN_CHANGE_COOLDOWN_MS; };

/**
 * Moves the workspace to another main agent: automatic handover or hand-back, the developer's "Make main agent",
 * or an agent's claim (make_main_agent). Recorded in mainHistory. A stop hold raised by another agent's turn
 * doesn't carry over (a hold from before 1.4.0-beta.16 names no agent, so only the developer's choice clears it).
 */
export function setMainAgent(w: Workspace, to: string, kind: "handover" | "handBack" | "developer" | "claim", now: number, meta: { by?: string; reason?: string | null } = {}): void {
  const from = w.mainAgentId;
  if (from === to) return;
  const by = meta.by ?? (kind === "developer" ? "developer" : "auto");
  const reason = meta.reason ?? (kind === "handover" ? "The main agent was closed for 30 minutes" : kind === "handBack" ? "The original main agent is back" : null);
  w.mainHistory = [...(w.mainHistory ?? []), { from, to, by, reason, at: new Date(now).toISOString() }].slice(-20);
  delete w.mainWorkAt;
  w.mainAgentId = to; w.runtimeReason = null; delete w.mainClosedSince;
  w.contributorAgentIds = [...new Set([...(w.contributorAgentIds ?? []).filter(id => id !== to), from])];
  for (const b of w.batches) if (b.state === "pending" && b.recipientAgentId === from) b.recipientAgentId = null;
  if (kind === "handover") w.handover = { from, at: new Date(now).toISOString(), worked: false }; else delete w.handover;
  const stop = w.interruption;
  if (stop && w.hold === interruptionHold(stop.kind) && (stop.agentId ? stop.agentId !== to : kind === "developer")) { w.hold = null; delete w.interruption; w.completion = null; w.declaration = null; }
  w.updatedAt = new Date(now).toISOString();
}

const MAIN_WORK_MARK_MS = 60 * 60_000;
/** Whether a main-agent call by `agentId` has something to record: an open handover, or an hour-old mainWorkAt. */
export function mainWorkDue(w: Workspace, agentId: string, now: number): boolean {
  return w.mainAgentId === agentId && (!!w.handover && !w.handover.worked || !w.mainWorkAt || now - Date.parse(w.mainWorkAt) >= MAIN_WORK_MARK_MS);
}
/**
 * A main agent's main-agent call: a successor's handover is in use and no longer goes back, and mainWorkAt (hourly
 * at most, so a sync per turn doesn't write state every time) feeds the 24-hour idle rule of a claim.
 */
export function markMainWork(state: State, agentId: string, now = Date.now()): boolean {
  let changed = false;
  for (const w of state.workspaces) {
    if (!mainWorkDue(w, agentId, now)) continue;
    if (w.handover && !w.handover.worked) w.handover.worked = true;
    w.mainWorkAt = new Date(now).toISOString(); changed = true;
  }
  return changed;
}

/** What a claim needs to know about the current main, from the agent list (metadata; never loads an agent). Null: gone. */
export type MainAgentInfo = { status: string; activeTurn?: unknown; pendingPermissions?: unknown[] | null; archivedAt?: string | null } | null;

/**
 * Rules 1-4 of a main-agent claim. Who may claim (the workspace's root agents) is checked by the caller. A claim the
 * developer asked for is refused only while the main is mid-turn; a self-claim also needs the main archived, gone or
 * closed 30 minutes, or every open PR registered by the claimant while the main has been idle 24 hours, and respects
 * the cooldown and the 2-hour reclaim limit.
 */
export function checkMainClaim(w: Workspace, target: string, requested: "developer" | "self", main: MainAgentInfo, now: number): { blockers: string[]; rule: string | null } {
  const blockers: string[] = [];
  if (target === w.mainAgentId) return { blockers: ["Already the main agent."], rule: null };
  if (!(w.contributorAgentIds ?? []).includes(target)) return { blockers: ["Not one of this workspace's root agents."], rule: null };
  if (main && !main.archivedAt && (["running", "initializing"].includes(main.status) || !!main.activeTurn || !!main.pendingPermissions?.length)) blockers.push("The main agent is mid-turn. Try again after its turn ends.");
  if (requested === "developer") return { blockers, rule: blockers.length ? null : "asked by the developer" };
  if (inMainCooldown(w, now)) blockers.push("The main agent changed less than 30 minutes ago. Ask the developer if it should change again.");
  if (w.mainHistory?.some(c => c.from === target && now - Date.parse(c.at) < MAIN_RECLAIM_MS)) blockers.push("This agent lost the main role less than 2 hours ago and can't take it back on its own. Ask the developer.");
  const open = w.prs.filter(p => !p.disposition && !["MERGED", "CLOSED"].includes(p.snapshot?.state ?? "OPEN"));
  const rule = !main || main.archivedAt ? "the main agent is archived or gone"
    : main.status === "closed" && w.mainClosedSince && now - Date.parse(w.mainClosedSince) >= MAIN_CHANGE_COOLDOWN_MS ? "the main agent has been closed for 30 minutes"
    : open.length && open.every(p => p.registeredAgentId === target) && !!w.mainWorkAt && now - Date.parse(w.mainWorkAt) >= MAIN_IDLE_MS ? "it registered every open PR and the main agent has been idle for 24 hours"
    : null;
  if (!rule) blockers.push("An agent can claim the main role on its own only when the main agent is archived, gone or closed for 30 minutes, or when it registered every open PR and the main has been idle for 24 hours. Otherwise ask the developer.");
  return { blockers, rule: blockers.length ? null : rule };
}

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
    // A long-closed, archived or gone main agent hands the workspace to its live successor, and an unused handover
    // goes back to the original main once it's live (discovery decides; see successorMainAgent, handBackMainAgent).
    // Any other mismatch keeps the recorded owner.
    if (row.replacesMainAgentId && row.replacesMainAgentId === w.mainAgentId && !w.archived) setMainAgent(w, row.mainAgentId, row.handBack ? "handBack" : "handover", now);
    // How long the recorded main has read closed without a break: a reopen resets it.
    if (row.mainAgentId === w.mainAgentId && !row.replacesMainAgentId && row.mainClosed !== undefined) {
      if (!row.mainClosed) delete w.mainClosedSince; else w.mainClosedSince ??= new Date(now).toISOString();
    }
    if (w.mainAgentId !== row.mainAgentId || w.archived) continue;
    // A new main agent, or a new message to the gone one, means its conversation can be tried again.
    if (w.goneAgent && (w.goneAgent.agentId !== w.mainAgentId || (row.messageAt && row.messageAt > w.goneAgent.at))) w.goneAgent = null;
    if (row.contributorAgentIds) w.contributorAgentIds = row.contributorAgentIds;
    if (!w.enable_tracking && followsByDefault(state, row)) { w.enable_auto_sends = startsWithAutoSend(state, w); w.enable_tracking = true; }
    if (!w.inventory) {
      w.inventory = { revision: 1, syncedRevision: 0, candidates: [], historyComplete: false, historyError: null, scannedMessageAt: null };
      w.completion = null; w.declaration = null;
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
      w.completion = null; w.declaration = null; w.updatedAt = new Date(now).toISOString();
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
    w.completion = null; w.declaration = null;
  }
  inventory.candidates = [...new Set([...inventory.candidates, ...added])].sort();
  inventory.historyComplete = history.complete;
  inventory.historyError = history.error;
  inventory.scannedMessageAt = messageAt;
}
