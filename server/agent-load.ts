import { settled, type Workspace } from "../shared/model";

export { backgroundCount, isLive, isLoaded, liveStatus, LIVE_STATUSES, type LoadSignals } from "../shared/agent-load";
import { isLoaded, type LoadSignals } from "../shared/agent-load";

export const DAY_MS = 86_400_000;
export const DEFAULT_ACTIVE_WINDOW_DAYS = 3;
export const activeWindowMs = (state: { activeWindowDays?: number }): number => (state.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS) * DAY_MS;

/** A user message within the active window. */
export function recentlyUsed(agent: { lastUserMessageAt: string | null }, windowMs: number, now: number): boolean {
  if (!agent.lastUserMessageAt) return false;
  const at = Date.parse(agent.lastUserMessageAt);
  return Number.isFinite(at) && now - at < windowMs;
}

/** A PR this workspace owns that isn't merged or closed. An unobserved PR counts as open until it's seen. */
export function ownsOpenPr(w: Pick<Workspace, "prs"> | undefined): boolean {
  return !!w?.prs.some(p => !settled(p) && (p.snapshot ? p.snapshot.state === "OPEN" : true));
}

/**
 * The active scope: Follow-up polls a followed workspace only while it has a loaded agent, a user message in
 * the active window, or an open PR it owns. Everything else stays listed and costs nothing until a turn starts
 * there (the turn hooks mark it dirty and the next discovery sees the loaded agent).
 */
export function workspaceActive(agents: (LoadSignals & { lastUserMessageAt: string | null })[], saved: Pick<Workspace, "prs"> | undefined, windowMs: number, now: number): boolean {
  return agents.some(a => isLoaded(a) || recentlyUsed(a, windowMs, now)) || ownsOpenPr(saved);
}

/** The provider no longer has this conversation, so every send to it fails. */
export function conversationGone(error: unknown): boolean {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return /no conversation found|conversation (?:not found|no longer exists)|session (?:id )?(?:not found|does not exist|no longer exists)|no (?:such )?session/i.test(text);
}
