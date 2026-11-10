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
  /** The host runs background jobs itself (Paseo 0.16), whether the switch is on or off. Absent from older workers. */
  host: z.boolean().optional(),
});
export type WaitStatus = z.infer<typeof waitStatusSchema>;

export const WAIT_TITLE = "Wait for background jobs";
export const WAIT_HINT = "Claude agents keep working through long commands, checking at least once a minute instead of ending the turn. Applies to new sessions.";
export const WAIT_STANDALONE_NOTE = "The separate Wait plugin is installed. Disable it to use Follow-up's built-in Wait.";
export const WAIT_NO_TOOLS_NOTE = "Paseo's agent tools are off on this host (daemon.mcp in Paseo's config.json, or the Claude provider's Paseo tools). Turn them on, then open a new session.";
/**
 * Paseo 0.16 (reason `host`): the card leads with what the host does, shown whether the switch is on or off, and the
 * switch is named for what it still controls there: the hook's "background it, end the turn" guidance.
 */
export const WAIT_HOST_NOTE = "Paseo runs background jobs itself. It shows them with Stop and wakes the agent when one finishes.";
export const WAIT_HOST_TITLE = "Use Paseo background jobs";
export const WAIT_HOST_HINT = "Adds a short instruction to new Claude sessions: run long commands in the background and end the turn.";
/** The switch's label and hint for this host: Wait's own on Paseo 0.15, the host's on 0.16. */
export function waitSwitchCopy(status: WaitStatus | null | undefined): { title: string; hint: string } {
  return status?.host ? { title: WAIT_HOST_TITLE, hint: WAIT_HOST_HINT } : { title: WAIT_TITLE, hint: WAIT_HINT };
}
/** Shown before either note while the switch is on: the outcome first. */
export const WAIT_NOT_ATTACHED = "On, but not attached.";

export function waitNote(status: WaitStatus): string | null {
  return status.reason === "standalone" ? WAIT_STANDALONE_NOTE : status.reason === "no-agent-tools" ? WAIT_NO_TOOLS_NOTE : status.reason === "host" ? WAIT_HOST_NOTE : null;
}
