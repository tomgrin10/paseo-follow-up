/** React Query keys shared by every surface that reads Follow-up state. */
export const workspaceKey = (id: string) => ["follow-through", "workspace", id];
export const overviewKey = ["follow-through", "overview"];
/** The browser extension's connection status: one shared query for every surface (1.4.0: 15 s, was 5 s). */
export const browserKey = ["follow-through", "browser"];
export const BROWSER_POLL_MS = 15_000;
