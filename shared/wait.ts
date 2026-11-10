import { z } from "zod";

/**
 * Wait for background jobs (Settings → Agents), stored as `enable_wait` in agents.json; on unless saved false.
 * `reason` says why Wait isn't attached while the switch is on: the standalone paseo-wait plugin is installed and
 * enabled on this daemon (so nothing is attached twice), the host doesn't serve plugin tools to agents, or the host is
 * Paseo 0.16+, which runs background jobs itself (`host`: no tools; the hook tells agents to end the turn instead).
 */
export const waitStatusSchema = z.object({
  enable_wait: z.boolean(),
  active: z.boolean(),
  reason: z.enum(["off", "standalone", "no-agent-tools", "host"]).nullable(),
});
export type WaitStatus = z.infer<typeof waitStatusSchema>;

export const WAIT_TITLE = "Wait for background jobs";
export const WAIT_HINT = "Claude agents keep working through long commands, checking at least once a minute instead of ending the turn. Applies to new sessions.";
export const WAIT_STANDALONE_NOTE = "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait.";
export const WAIT_NO_TOOLS_NOTE = "Paseo's agent tools are off on this host (daemon.mcp in Paseo's config.json, or the Claude provider's Paseo tools). Turn them on, then open a new session.";
export const WAIT_HOST_NOTE = "This version of Paseo runs background jobs itself: agents start long commands in the background, end the turn, and are woken when the job finishes. Wait's tools aren't needed here.";
/** Shown before either note while the switch is on: the outcome first. */
export const WAIT_NOT_ATTACHED = "On, but not attached.";

export function waitNote(status: WaitStatus): string | null {
  return status.reason === "standalone" ? WAIT_STANDALONE_NOTE : status.reason === "no-agent-tools" ? WAIT_NO_TOOLS_NOTE : status.reason === "host" ? WAIT_HOST_NOTE : null;
}
