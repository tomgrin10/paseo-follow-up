/**
 * Done's Undo windows, one per agent (client/brief.tsx opens one per Done). Kept apart from the inbox store's single
 * `recent` move, so a sign-off, a Later or another agent's Done inside the window can't take it over: each agent's
 * pill keeps saying Done, and keeps its Undo, until that agent's own toast ends.
 */
export function createDoneWindows(onChange: () => void) {
  const open = new Map<string, () => void>();
  return {
    /** The window opened; `cancel` is its toast's Undo. */
    note(agentId: string, cancel: () => void) { open.set(agentId, cancel); onChange(); },
    /** The toast ended (sent, failed or undone from the toast itself). */
    end(agentId: string) { if (open.delete(agentId)) onChange(); },
    has: (agentId: string) => open.has(agentId),
    /** Undo from the pill: cancels each listed agent's window. True when any was open. */
    undo(agentIds: string[]): boolean {
      const hit = agentIds.filter(id => open.has(id));
      for (const id of hit) { const cancel = open.get(id)!; open.delete(id); cancel(); }
      if (hit.length) onChange();
      return hit.length > 0;
    },
  };
}
