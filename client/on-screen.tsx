import { useEffect, useSyncExternalStore } from "react";
import { timelineOnScreen } from "../shared/peek";

/**
 * Which agents' turns are already drawn on screen, so nothing peeks at them again (shared/peek.ts `timelineOnScreen`,
 * Q180 A). A surface that draws an agent's turn marks it while it does: Home's detail pane for its selected row (its
 * Recent steps), and the workspace view for its selected agent. Counted, so two surfaces marking one agent both hold it.
 * One registry per client: the panel and Home run in one app.
 */
const marks = new Map<string, number>();
let marked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const changed = () => { marked = new Set(marks.keys()); for (const f of listeners) f(); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => marked;
const NONE: ReadonlySet<string> = new Set();

/** Mark `agentId`'s turn as drawn by this surface while mounted (null marks nothing). */
export function useMarkTimelineOnScreen(agentId: string | null | undefined): void {
  useEffect(() => {
    if (!agentId) return;
    marks.set(agentId, (marks.get(agentId) ?? 0) + 1); changed();
    return () => { const n = (marks.get(agentId) ?? 1) - 1; if (n > 0) marks.set(agentId, n); else marks.delete(agentId); changed(); };
  }, [agentId]);
}

/** The agents marked on screen now. */
export const useMarkedOnScreen = (): ReadonlySet<string> => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Whether a surface marks `agentId`; re-renders only when that answer changes (one per list row). */
export function useMarked(agentId: string | null | undefined): boolean {
  const get = () => !!agentId && marked.has(agentId);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Whether `agentId`'s turn is already on screen: marked by a surface, or the chat beside the caller (`chatBeside`: the
 * host's active agent where the surface knows it, e.g. a sidebar view's `active.agent`; a workspace panel isn't told).
 */
export function useTimelineOnScreen(agentId: string | null | undefined, chatBeside: string | null = null): boolean {
  const on = useMarked(agentId);
  return timelineOnScreen(agentId, { marked: on && agentId ? new Set([agentId]) : NONE, chatBeside });
}
