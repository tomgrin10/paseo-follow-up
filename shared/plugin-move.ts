import { z } from "zod";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "./legacy";

/**
 * 2.0's one-time move to its new plugin id (server/plugin-move.ts). Shown as one quiet line in Settings → General and
 * in updates_status; never a popup.
 *  - none: nothing to do (fresh 2.0 install, or moved more than a week ago).
 *  - waiting: still under the old id, waiting for a quiet moment (the same rule as an update).
 *  - moving: the move is running.
 *  - moved: done, within the last week.
 *  - rolled-back / failed: the new id didn't come up, so the old id runs again. Not retried by itself; Retry asks again.
 *  - manual: not installed from npm, so Follow-up can't reinstall itself.
 */
export const MOVE_PHASES = ["none", "waiting", "moving", "moved", "rolled-back", "failed", "manual"] as const;
export const moveViewSchema = z.object({
  phase: z.enum(MOVE_PHASES),
  oldId: z.string(),
  newId: z.string(),
  at: z.number().nullable(),
  reason: z.string().nullable(),
});
export type MoveView = z.infer<typeof moveViewSchema>;
export const MOVE_SHOWN_MS = 7 * 24 * 3_600_000;

type MoveEvent = { at: number; event: string; reason?: string };
const TERMINAL = new Set(["moved", "move-failed", "move-rolled-back", "move-rollback-failed"]);

/** The latest finished move, if any, from updates.jsonl. */
export function lastMove(events: readonly MoveEvent[]): MoveEvent | null {
  return [...events].reverse().find(e => TERMINAL.has(e.event)) ?? null;
}

export function moveView(input: { id: string | null | undefined; installKind: string; events: readonly MoveEvent[]; moving: boolean; now: number; retryAsked: boolean }): MoveView {
  const base = { oldId: LEGACY_PLUGIN_ID, newId: PLUGIN_ID };
  const last = lastMove(input.events);
  if (input.id !== LEGACY_PLUGIN_ID) {
    return last?.event === "moved" && input.now - last.at < MOVE_SHOWN_MS ? { ...base, phase: "moved", at: last.at, reason: null } : { ...base, phase: "none", at: null, reason: null };
  }
  if (input.installKind !== "npm") return { ...base, phase: "manual", at: null, reason: null };
  if (input.moving) return { ...base, phase: "moving", at: null, reason: null };
  if (last && last.event !== "moved" && !input.retryAsked) return { ...base, phase: last.event === "move-failed" ? "failed" : "rolled-back", at: last.at, reason: last.reason ?? null };
  return { ...base, phase: "waiting", at: null, reason: null };
}

/** Settings → General's line for the move; null when there's nothing to say. */
export function moveLine(view: MoveView): string | null {
  switch (view.phase) {
    case "none": return null;
    case "waiting": return "Moving to Follow-up's new plugin id at the next quiet moment.";
    case "moving": return "Moving to Follow-up's new plugin id…";
    case "moved": return "Moved to Follow-up's new plugin id.";
    case "rolled-back": return `Couldn't move to Follow-up's new plugin id, so it went back to the old one.${view.reason ? ` ${view.reason}` : ""}`;
    case "failed": return `Couldn't move to Follow-up's new plugin id.${view.reason ? ` ${view.reason}` : ""}`;
    case "manual": return `Follow-up runs under its old plugin id. To move it, run paseo plugin remove ${view.oldId}, then install it again.`;
  }
}
