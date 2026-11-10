export type WorkspaceAgent = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  labels: Record<string, string>;
  /** Paseo 0.16: a helper another plugin runs for itself. Never a root (server/background-agents.ts). */
  background?: boolean;
};

/** Parent labels record who launched an agent, including launches into another workspace. */
export async function isWorkspaceRoot(
  agent: WorkspaceAgent,
  findParent: (id: string) => Promise<WorkspaceAgent | null | undefined>,
): Promise<boolean> {
  if (!agent.workspaceId || agent.archivedAt || agent.background === true) return false;
  const parentId = agent.labels["paseo.parent-agent-id"];
  if (!parentId) return true;
  if (parentId === agent.id) return false;
  const parent = await findParent(parentId).catch(() => null);
  // Unknown parent membership does not grant a new ownership or tool scope.
  return !!parent && parent.id === parentId && !!parent.workspaceId && parent.workspaceId !== agent.workspaceId;
}
