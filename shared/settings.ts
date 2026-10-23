import { z } from "zod";

export const projectSchema = z.object({ id: z.string().min(1), name: z.string(), key: z.string(), path: z.string(), enable_default_tracking: z.boolean() });
export type ProjectSetting = z.infer<typeof projectSchema>;
export type Project = { projectId: string; projectKey: string; projectDisplayName: string; projectCustomName?: string | null; projectRootPath: string; projectKind: string };

export function defaultTracking(project: Project, overrides: Record<string, boolean> = {}): boolean {
  if (Object.hasOwn(overrides, project.projectId)) return overrides[project.projectId];
  return project.projectKind === "git" && project.projectKey.startsWith("remote:") && project.projectKey.replace(/\.git$/, "").split("/").at(-1) === "hero-poc";
}
export function projectSetting(project: Project, overrides: Record<string, boolean> = {}): ProjectSetting {
  return { id: project.projectId, name: project.projectCustomName || project.projectDisplayName, key: project.projectKey, path: project.projectRootPath, enable_default_tracking: defaultTracking(project, overrides) };
}
