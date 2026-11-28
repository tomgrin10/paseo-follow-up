/**
 * Archived is Paseo's state, never a latch Follow-up keeps (invariant 111, `an-ask-from-a-live-agent-reaches-the-developer`).
 *
 * Paseo archives a workspace with its agents, and unarchives an agent when anyone prompts it, but leaves the workspace
 * record archived and sends no event for either unarchive. So Follow-up reads a workspace as live when Paseo lists it
 * (not mid-archive) or, with its record still archived, when its main agent is unarchived in it: the developer is
 * talking to that agent again. Every path that can see this (a main-agent turn, a needs_you or other write tool call,
 * the engine's pass over archived workspaces) reopens the workspace and its Needs-you row. Where Paseo still has the
 * workspace archived, a tool that would record an ask nobody sees refuses with this module's text instead of
 * answering ok. 2026-11-25: a Done, archived workspace's agent got new scope in chat and called needs_you
 * kind=decision twice; nothing reached the developer and the agent heard no error.
 */

/** Paseo's workspace row as the directory lists it; absent once the workspace record is archived. */
export type PaseoWorkspaceRow = { archivingAt?: string | null } | null | undefined;
/** The main agent's Paseo snapshot (Paseo's own agent list leaves archived agents out). */
export type PaseoMainAgent = { archivedAt?: string | null; workspaceId?: string | null } | null | undefined;

/** Whether Paseo shows the workspace live: listed and not being archived, or its main agent unarchived in it. */
export function paseoShowsLive(workspaceId: string, row: PaseoWorkspaceRow, main: PaseoMainAgent): boolean {
  if (row) return !row.archivingAt;
  return !!main && !main.archivedAt && main.workspaceId === workspaceId;
}

/** The error a write tool gives when Paseo still has the caller's workspace archived: why, and what to call. */
export function archivedAskError(workspaceId: string): string {
  return `Workspace ${workspaceId} is archived in Paseo, so Follow-up isn't following it and nothing recorded here would reach the developer. Call needs_you kind=decision at the turn's end with your ask, and ask the developer to unarchive the workspace in Paseo.`;
}

/** needs_you's note when Paseo still has the workspace archived: the ask reaches Needs you, Follow-up's tracking doesn't. */
export const ARCHIVED_NEEDS_YOU_NOTE = "This workspace is archived in Paseo. Your ask still reaches the developer's Needs you, but Follow-up doesn't follow the workspace's PRs or tasks until the developer unarchives it: say so in your reply.";

/** What a write tool may do in a workspace: null when it acts, else the refusal it answers with. */
export function askRefusal(w: { id: string; archived: boolean }): string | null {
  return w.archived ? archivedAskError(w.id) : null;
}

/** One workspace as Follow-up and Paseo each read it, for the invariant. */
export type ReopenRow = { workspaceId: string; mainAgentId: string; archived: boolean; inboxGone: boolean; paseoLive: boolean };

/**
 * `an-ask-from-a-live-agent-reaches-the-developer`: a workspace Paseo shows live is never archived in Follow-up and
 * its main agent's Needs-you row is never gone, so the agent's asks show. (A Done workspace goes back to working on
 * the main agent's next turn: turn-events.ts turnStarted.)
 */
export function reopenViolations(rows: readonly ReopenRow[]): { id: string; detail: string }[] {
  const id = "an-ask-from-a-live-agent-reaches-the-developer";
  return rows.filter(r => r.paseoLive && (r.archived || r.inboxGone)).map(r => ({ id,
    detail: `${r.workspaceId} is live in Paseo but Follow-up ${r.archived ? "reads it archived" : `hides ${r.mainAgentId}'s Needs-you row`}` }));
}
