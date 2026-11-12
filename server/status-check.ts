import { appendFile, rename, stat } from "node:fs/promises";
import type { Workspace } from "../shared/model";
import { violations } from "../shared/status-invariants";

const MAX_BYTES = 256 * 1024;
/** The longest an unchanged workspace goes unchecked (invariants that depend on the clock run then). */
export const STATUS_SWEEP_MS = 300_000;

/**
 * The worker's cheap runtime self-check: after each refresh, a workspace whose surfaces contradict each other
 * (shared/status-invariants.ts) is logged once to plugin-data/follow-up/status-diagnostics.jsonl with its id.
 * Logged again only when the set of violations changes. No UI, no polling, one small map of workspace ids.
 */
export function statusCheck(file: string, check: typeof violations = violations) {
  const last = new Map<string, string>();
  const checked = new Map<string, { w: Workspace; inputs: string; at: number }>();
  /**
   * `inputs`: what the tick read beside the workspace (its runtime: agent states, busy, guard). The invariants are pure
   * over (workspace, clock), and agents and PR reads reach them only through fields the tick writes into the workspace,
   * so an unchanged workspace object with unchanged inputs is skipped (2026-11-12: every invariant over every workspace
   * each tick was the idle worker's second-biggest allocator). Time-based invariants run on the sweep every
   * STATUS_SWEEP_MS. Invariant a-tick-copies-the-state-at-most-once.
   */
  return async (w: Workspace, now: number, inputs = ""): Promise<void> => {
    const seen = checked.get(w.id);
    if (seen && seen.w === w && seen.inputs === inputs && now - seen.at < STATUS_SWEEP_MS) return;
    checked.set(w.id, { w, inputs, at: now });
    const found = check(w, now);
    const signature = found.map(v => v.id).join(",");
    if ((last.get(w.id) ?? "") === signature) return;
    if (signature) last.set(w.id, signature); else last.delete(w.id);
    if (!found.length) return;
    if (((await stat(file).catch(() => null))?.size ?? 0) > MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
    await appendFile(file, JSON.stringify({ at: new Date(now).toISOString(), workspaceId: w.id, violations: found }) + "\n", { mode: 0o600 });
  };
}
