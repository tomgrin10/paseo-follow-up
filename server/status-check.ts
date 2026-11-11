import { appendFile, rename, stat } from "node:fs/promises";
import type { Workspace } from "../shared/model";
import { violations } from "../shared/status-invariants";

const MAX_BYTES = 256 * 1024;

/**
 * The worker's cheap runtime self-check: after each refresh, a workspace whose surfaces contradict each other
 * (shared/status-invariants.ts) is logged once to plugin-data/follow-up/status-diagnostics.jsonl with its id.
 * Logged again only when the set of violations changes. No UI, no polling, one small map of workspace ids.
 */
export function statusCheck(file: string, check: typeof violations = violations) {
  const last = new Map<string, string>();
  return async (w: Workspace, now: number): Promise<void> => {
    const found = check(w, now);
    const signature = found.map(v => v.id).join(",");
    if ((last.get(w.id) ?? "") === signature) return;
    if (signature) last.set(w.id, signature); else last.delete(w.id);
    if (!found.length) return;
    if (((await stat(file).catch(() => null))?.size ?? 0) > MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
    await appendFile(file, JSON.stringify({ at: new Date(now).toISOString(), workspaceId: w.id, violations: found }) + "\n", { mode: 0o600 });
  };
}
