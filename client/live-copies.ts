import type { Workspace } from "../shared/model";

/** A copy only replaces one it is newer than (updatedAt): a late diff or poll never undoes a fresher read. */
export const newer = (held: Workspace | undefined, w: Workspace) => !held || Date.parse(w.updatedAt) >= Date.parse(held.updatedAt) ? w : held;
export const opened = new Set<(w: Workspace) => void>();
/**
 * A fresh read of one workspace (useWorkspace's read, a merge's read before its toast) reaches every live store, so
 * Home, the pill, the sidebar count and the panel read one copy (a-merge-outcome-reads-the-same-everywhere). Before,
 * Home's Needs you kept "#151 is approved" beside a "Merged" button until the next feed push or poll.
 */
export function acceptWorkspace(w: Workspace): void { for (const accept of opened) accept(w); }
