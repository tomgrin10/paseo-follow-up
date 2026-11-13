/** React Query keys shared by every surface that reads Follow-up state. */
export const workspaceKey = (id: string) => ["follow-up", "workspace", id];
export const overviewKey = ["follow-up", "overview"];
/** The browser extension's connection status: one shared query, read when a PR sheet, the panel or the pill opens (never polled). */
export const browserKey = ["follow-up", "browser"];
/** An agent's live brief (follow.inbox-brief): one query per agent, shared by every brief card in its chat. */
export const liveBriefKey = (agentId: string) => ["follow-up", "live-brief", agentId];
/** How often a card that still looks open re-checks it (only while Paseo is visible; React Query pauses when hidden). */
export const LIVE_BRIEF_POLL_MS = 30_000;
