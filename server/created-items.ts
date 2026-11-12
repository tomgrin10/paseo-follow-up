import type { CreatedLive, FollowLine } from "../shared/created";
import type { Workspace } from "../shared/model";
import { isOpen as questionOpen } from "../shared/questions";
import { liveLine, prTone, stackOrder } from "../shared/attention";
import { prPresentation } from "../shared/presentation";
import { settled } from "../shared/model";
import { taskAgentStates } from "../shared/task-status";
import type { DirectoryRows } from "./directory";

/**
 * Live facts for the chat's created cards, from the directory snapshot the engine already keeps (metadata only, so
 * nothing is woken and no extra daemon list call is made) and the store. Agent state goes through taskAgentStates,
 * the same mapping the task lines use; a directory that couldn't be read says nothing (the card shows no state).
 */
export function createdItems(input: { agentIds: readonly string[]; workspaceIds: readonly string[] }, rows: DirectoryRows | null, tracked: readonly Workspace[]): CreatedLive {
  const out: CreatedLive = { agents: {}, workspaces: {} };
  if (!rows) return out;
  const byId = new Map(rows.agents.map(r => [r.agent.id, r.agent]));
  const states = taskAgentStates(input.agentIds, rows.agents.map(r => r.agent));
  const store = new Map(tracked.filter(w => !w.archived).map(w => [w.id, w]));
  const names = new Map(rows.workspaces.map(w => [w.id, w.name]));
  const wsIds = new Set(input.workspaceIds);
  for (const id of input.agentIds) {
    const a = byId.get(id); const live = states[id];
    if (!a || !live) continue; // Not listed: unknown, so the card is words only.
    const workspaceId = a.workspaceId ?? null;
    out.agents[id] = { title: live.title, state: live.state, workspaceId, main: !!workspaceId && store.get(workspaceId)?.mainAgentId === id };
    if (workspaceId) wsIds.add(workspaceId);
  }
  for (const id of wsIds) out.workspaces[id] = { name: names.get(id) ?? store.get(id)?.title ?? null, follow: followLine(store.get(id)) };
  return out;
}

/** What Follow-up says about a tracked workspace: its first open question, else up to two PR chips, else its live line. */
export function followLine(w: Workspace | undefined, now = Date.now()): FollowLine | null {
  if (!w || !w.enable_tracking) return null;
  const q = (w.questions ?? []).find(questionOpen);
  if (q) return { question: { id: q.id, title: q.title }, chips: [], line: null };
  const ordered = stackOrder(w.prs);
  const shown = [...ordered.filter(p => !settled(p)), ...ordered.filter(settled).reverse()].slice(0, 2);
  const chips = shown.map(p => {
    const view = prPresentation(p); const tone = prTone(p);
    return { text: `#${p.number} ${view.label.toLowerCase()}`, tone: tone === "danger" ? "danger" as const : view.tone === "approved" ? "success" as const : view.tone === "neutral" ? "muted" as const : view.tone };
  });
  const live = liveLine(w, now);
  const line = live.icon === "idle" ? null : live.text;
  return chips.length || line ? { question: null, chips, line } : null;
}
