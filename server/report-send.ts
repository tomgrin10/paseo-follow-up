import { randomUUID } from "node:crypto";
import type { DirectoryRows } from "./directory";
import { reportPrompt } from "./report-issue-adapter";
import { reportWorkspaceTitle, type ReportKind } from "../shared/report-send";

/**
 * Report an issue's Send (follow.report-issue-send, and an agent's report_send): the developer's words go to an
 * agent, to a new agent in a workspace, or to a new workspace with an agent in it (docs/report-issue.md).
 *
 * A new workspace is what Paseo's own New workspace creates by default: a `directory` workspace on the project's root
 * (its "local" isolation), never a new worktree or branch. Several directory workspaces on one root need the host's
 * `features.workspaceMultiplicity`; without it the option is hidden (`newWorkspaceTarget` answers null) and a direct
 * call is refused, so the developer is never offered a start the host would turn down. Follow-up then tracks the new
 * workspace through the project's normal follow settings; nothing here enrolls it.
 */
export type ReportSendInput = { kind: ReportKind; text: string; error?: string | null; agentId?: string; newAgentWorkspaceId?: string; newWorkspaceProjectId?: string; /** The workspace the report is about (the panel's ⋯ entry): the prompt names it. */ workspaceId?: string | null };
/** `queued`: handed to an existing agent through the message queue (sent in the background, retried until it lands). */
export type ReportSendResult = { agentId: string; title: string; started: boolean; workspaceId?: string; queued?: boolean };
type AgentHandle = { id: string };
type AgentCreate = { config: unknown; title?: string; prompt?: string };
export type ReportSendDeps = {
  rows: () => Promise<DirectoryRows | null>;
  multiplicity: () => Promise<boolean>;
  /** The agent config a new agent starts with (the Overseer role's provider, its default model). */
  provider: () => Promise<unknown>;
  sendTo: (agentId: string, prompt: string, messageId: string) => Promise<unknown>;
  agentTitle: (agentId: string) => Promise<string | null>;
  paseo: {
    workspaces: {
      ref(id: string): { agents: { create(o: AgentCreate): Promise<AgentHandle> } };
      create(o: { title?: string; source: { kind: "directory"; path: string; projectId?: string } }): Promise<{ id: string; archive(): Promise<unknown>; agents: { create(o: AgentCreate): Promise<AgentHandle> } }>;
    };
  };
};

const projectName = (p: DirectoryRows["projects"][number]) => p.projectCustomName || p.projectDisplayName;

/** The project a report's new workspace would start in: the one `workspaceId` (the sheet's, or Home's pick) belongs to. */
export function newWorkspaceTarget(rows: DirectoryRows | null, workspaceId: string | null | undefined, multiplicity: boolean): { projectId: string; title: string } | null {
  if (!multiplicity || !rows || !workspaceId) return null;
  const projectId = rows.workspaces.find(w => w.id === workspaceId)?.projectId;
  const project = projectId ? rows.projects.find(p => p.projectId === projectId) : undefined;
  return project ? { projectId: project.projectId, title: projectName(project) } : null;
}

export const agentTitleFor = (kind: ReportKind) => kind === "bug" ? "Report a Follow-up bug" : kind === "feature" ? "Follow-up feature request" : "Follow-up feedback";

export async function sendReport(d: ReportSendDeps, input: ReportSendInput): Promise<ReportSendResult> {
  const { kind, text, error, agentId, newAgentWorkspaceId, newWorkspaceProjectId, workspaceId } = input;
  const prompt = reportPrompt(kind, text, error, workspaceId);
  if (agentId) {
    await d.sendTo(agentId, prompt, randomUUID());
    return { agentId, title: (await d.agentTitle(agentId).catch(() => null)) ?? "the agent", started: false, queued: true };
  }
  if (newWorkspaceProjectId) {
    const project = (await d.rows())?.projects.find(p => p.projectId === newWorkspaceProjectId);
    if (!project) throw new Error("That project isn't available any more. Pick another target.");
    if (!await d.multiplicity()) throw new Error("This Paseo can't start another workspace in the same project folder. Pick an agent or a new agent instead.");
    const title = reportWorkspaceTitle(kind, text, error);
    const config = await d.provider();
    const workspace = await d.paseo.workspaces.create({ title, source: { kind: "directory", path: project.projectRootPath, projectId: project.projectId } });
    // An agent that can't start (a disabled provider, a refused model) would leave an empty workspace behind, and each
    // retry another: archive it again and show the error, so the sheet keeps the text and nothing is left over.
    const agent = await workspace.agents.create({ config, title: agentTitleFor(kind), prompt }).catch(async (error: unknown) => {
      await workspace.archive().catch(() => undefined);
      throw error;
    });
    return { agentId: agent.id, title, started: true, workspaceId: workspace.id };
  }
  if (!newAgentWorkspaceId) throw new Error("Pick an agent, or a workspace to start a new one in.");
  const title = agentTitleFor(kind);
  const agent = await d.paseo.workspaces.ref(newAgentWorkspaceId).agents.create({ config: await d.provider(), title, prompt });
  return { agentId: agent.id, title, started: true };
}
