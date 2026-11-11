import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Batch, Workspace } from "../shared/model";

/** Never-sent cancelled batches kept in state.json per workspace; older ones move to the archive. */
export const KEEP_UNSENT_CANCELLED = 3;
/**
 * A batch cancelled before it went out ("Conditions resolved before delivery") records nothing about delivery:
 * dedupe and repair limits only look at batches that were sent, and the activity log only at settled ones. The
 * completion check flips with every turn, so these piled up to ~290 per workspace (82% of state.json on the VM).
 * Removes all but the newest few from `w` and returns them for the archive.
 */
export function pruneUnsent(w: Pick<Workspace, "batches">, keep = KEEP_UNSENT_CANCELLED): Batch[] {
  const unsent = w.batches.filter(b => b.state === "cancelled" && !b.sentAt && !b.settledAt);
  if (unsent.length <= keep) return [];
  const drop = new Set(unsent.slice(0, unsent.length - keep));
  w.batches = w.batches.filter(b => !drop.has(b));
  return [...drop];
}

/** Appends pruned batches to plugin-data/follow-up/archive/<workspace>.jsonl (kept, never read back). */
export function batchArchive(directory: string) {
  return async (workspaceId: string, batches: Batch[]): Promise<void> => {
    if (!batches.length) return;
    const folder = join(directory, "archive");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await appendFile(join(folder, `${workspaceId.replace(/[^\w.-]/g, "_")}.jsonl`), batches.map(b => JSON.stringify(b)).join("\n") + "\n", { mode: 0o600 });
  };
}
