import { z } from "zod";

export const projectSchema = z.object({ id: z.string().min(1), name: z.string(), key: z.string(), path: z.string(), enable_default_tracking: z.boolean() });
export type ProjectSetting = z.infer<typeof projectSchema>;
export type Project = { projectId: string; projectKey: string; projectDisplayName: string; projectCustomName?: string | null; projectRootPath: string; projectKind: string };

/**
 * Whether a project's workspaces are followed. With Follow every workspace on (the default since 1.3.0-beta.2)
 * every project is, except the ones opted out; off, the old rule applies (explicit choices, else acme-poc only).
 */
/** The repository basename that tracks by default when Follow every workspace is off (Q55 moves it to host settings). */
export const DEFAULT_TRACKED_BASENAME = "acme-poc";
export function defaultTracking(project: Project, overrides: Record<string, boolean> = {}, followEvery = true): boolean {
  if (followEvery) return overrides[project.projectId] !== false;
  if (Object.hasOwn(overrides, project.projectId)) return overrides[project.projectId];
  return project.projectKind === "git" && project.projectKey.startsWith("remote:") && project.projectKey.replace(/\.git$/, "").split("/").at(-1) === DEFAULT_TRACKED_BASENAME;
}
export function projectSetting(project: Project, overrides: Record<string, boolean> = {}, followEvery = true): ProjectSetting {
  return { id: project.projectId, name: project.projectCustomName || project.projectDisplayName, key: project.projectKey, path: project.projectRootPath, enable_default_tracking: defaultTracking(project, overrides, followEvery) };
}

type FollowState = { enable_follow_every?: boolean; enable_auto_sends_default?: boolean; workspaceOptOuts?: string[]; projectDefaults?: Record<string, boolean> };
export const followsEvery = (state: FollowState): boolean => state.enable_follow_every !== false;
export const autoSendsByDefault = (state: FollowState): boolean => state.enable_auto_sends_default !== false;
export const optedOut = (state: FollowState, workspaceId: string): boolean => !!state.workspaceOptOuts?.includes(workspaceId);
/** Whether discovery may start following this workspace on its own. */
export function followsByDefault(state: FollowState, row: { id: string; projectId?: string | null; enable_default_tracking?: boolean }): boolean {
  return !!row.enable_default_tracking && !optedOut(state, row.id) && (!row.projectId || state.projectDefaults?.[row.projectId] !== false);
}

export const FOLLOW_EVERY_MIGRATION = "follow-every-1";
/**
 * 1.3.0-beta.2 migration: tracking becomes invisible, so every workspace Follow-up knows is followed with
 * auto-send on. Runs once; opted-out and archived workspaces are left alone. Returns how many changed.
 */
export function migrateFollowEvery(state: { workspaces: { id: string; archived: boolean; enable_tracking: boolean; enable_auto_sends: boolean }[] } & FollowState & { migrations?: string[] }): { tracked: number; autoSends: number } | null {
  if (state.migrations?.includes(FOLLOW_EVERY_MIGRATION)) return null;
  state.migrations = [...state.migrations ?? [], FOLLOW_EVERY_MIGRATION];
  if (!followsEvery(state)) return { tracked: 0, autoSends: 0 };
  let tracked = 0, autoSends = 0;
  for (const w of state.workspaces) {
    if (w.archived || optedOut(state, w.id)) continue;
    if (!w.enable_tracking) { w.enable_tracking = true; tracked++; }
    if (!w.enable_auto_sends && autoSendsByDefault(state)) { w.enable_auto_sends = true; autoSends++; }
  }
  return { tracked, autoSends };
}

export const ACTIVE_SCOPE_MIGRATION = "active-scope-1";
/**
 * 1.3.0-beta.3: undo the beta.2 blast radius. Once, turn auto-send off for followed workspaces outside the active
 * scope and remember them; each turns back on when its workspace becomes active (see applyDiscovery).
 * `active` holds the workspace ids discovery found active. Returns how many were parked, or null if already applied.
 */
export function migrateActiveScope(state: { workspaces: { id: string; archived: boolean; enable_tracking: boolean; enable_auto_sends: boolean }[]; migrations?: string[]; autoSendsParked?: string[] }, active: Set<string>): number | null {
  if (state.migrations?.includes(ACTIVE_SCOPE_MIGRATION)) return null;
  state.migrations = [...state.migrations ?? [], ACTIVE_SCOPE_MIGRATION];
  const parked = new Set(state.autoSendsParked ?? []);
  for (const w of state.workspaces) {
    if (w.archived || !w.enable_tracking || !w.enable_auto_sends || active.has(w.id)) continue;
    w.enable_auto_sends = false; parked.add(w.id);
  }
  if (parked.size) state.autoSendsParked = [...parked];
  return parked.size;
}

/** 1.3.0-beta.4: never-sent cancelled batches moved out of state.json to the per-workspace archive. */
export const PRUNE_MIGRATION = "prune-unsent-1";
