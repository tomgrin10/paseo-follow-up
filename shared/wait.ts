import { z } from "zod";

/**
 * Wait for background jobs (Settings → Agents), stored as `enable_wait` in agents.json; on unless saved false.
 * `reason` says why Wait isn't attached while the switch is on: the standalone paseo-wait plugin is installed and
 * enabled on this daemon (so nothing is attached twice), or the host doesn't serve plugin tools to agents.
 */
export const waitStatusSchema = z.object({
  enable_wait: z.boolean(),
  active: z.boolean(),
  reason: z.enum(["off", "standalone", "no-agent-tools"]).nullable(),
});
export type WaitStatus = z.infer<typeof waitStatusSchema>;

export const WAIT_TITLE = "Wait for background jobs";
export const WAIT_HINT = "Claude agents keep working through long commands, checking at least once a minute instead of ending the turn. Applies to new sessions.";
export const WAIT_STANDALONE_NOTE = "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait.";
export const WAIT_NO_TOOLS_NOTE = "Paseo's agent tools are off on this host (daemon.mcp in Paseo's config.json, or the Claude provider's Paseo tools). Turn them on, then open a new session.";
/** Shown before either note while the switch is on: the outcome first. */
export const WAIT_NOT_ATTACHED = "On, but not attached.";

export function waitNote(status: WaitStatus): string | null {
  return status.reason === "standalone" ? WAIT_STANDALONE_NOTE : status.reason === "no-agent-tools" ? WAIT_NO_TOOLS_NOTE : null;
}
