import type { Workspace } from "../shared/model";
import { errorText } from "../shared/errors";

/** A copy only replaces one it is newer than (updatedAt): a late diff or poll never undoes a fresher read. */
export const newer = <T extends { updatedAt: string }>(held: T | undefined, w: T): T => !held || Date.parse(w.updatedAt) >= Date.parse(held.updatedAt) ? w : held;
export const opened = new Set<(w: Workspace) => void>();
/**
 * A fresh read of one workspace (useWorkspace's read, a merge's read before its toast) reaches every live store, so
 * Home, the pill, the sidebar count and the panel read one copy (a-merge-outcome-reads-the-same-everywhere). Before,
 * Home's Needs you kept "#151 is approved" beside a "Merged" button until the next feed push or poll.
 */
export function acceptWorkspace(w: Workspace): void { for (const accept of opened) accept(w); }

/** Why a read left nothing to show: its error, or its answer's. Null while it reads, once it has the workspace, or while disabled. */
export function detailFailure(q: { enabled: boolean; workspace: Workspace | null; error: unknown; reply: { workspace: Workspace | null; error: string | null } | undefined }): string | null {
  if (!q.enabled || q.workspace) return null;
  if (q.error) return errorText(q.error);
  if (q.reply) return q.reply.error ?? "Follow-up has no record of this workspace.";
  return null;
}

/**
 * What a list surface draws (Home's open row, the pill's popover): the newer of its list copy and its full read
 * (updatedAt). After the full read, a list change listed later (a merge, a turn) draws at once instead of waiting for
 * the re-read it triggers; the sheets keep the full read. 2.0.1: the open row drew `full ?? listed` and lagged.
 */
export function openRowCopy<T extends { updatedAt: string }>(listed: T | null | undefined, full: T | null | undefined): T | undefined {
  return listed && full ? newer(listed, full) : full ?? listed ?? undefined;
}
