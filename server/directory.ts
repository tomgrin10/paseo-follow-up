import type { Project } from "../shared/settings";
import { pages, withDaemon, type Agent, type Daemon } from "./daemon";
import { isBackgroundAgent } from "./background-agents";
import { isLoaded } from "./agent-load";

/** A row of Paseo's workspace list. fetch_workspaces carries more (git and GitHub runtime) for the Overseer. */
export type WorkspaceRow = { id: string; name: string; projectId?: string | null; labels?: string[]; archivingAt?: string | null; [key: string]: unknown };
export type DirectoryRows = { agents: { agent: Agent }[]; workspaces: WorkspaceRow[]; projects: Project[] };
type HookAgent = { id: string; workspaceId: string | null; parentAgentId?: string | null; provider: string; cwd: string; title: string | null };

/** How often the directory may go back to Paseo: a dirty directory at most once a minute, a clean one every 10 min. */
export const DIRTY_REFRESH_MS = 60_000;
export const BACKSTOP_REFRESH_MS = 600_000;

/**
 * Follow-up's one view of Paseo's agents, workspaces and projects, shared by discovery, runtime observation, the
 * Needs-you inbox, the Overseer and every client RPC.
 *
 * Listing workspaces is expensive for the daemon (each fetch_workspaces reads every workspace's paseo.json through a
 * two-wide pool), so nothing polls it. The directory is read once at start, then kept current from lifecycle events:
 * turns, permissions, archives and creations patch it in place and mark it dirty. A dirty directory re-reads at
 * most once a minute; a clean one re-reads every ten minutes as a backstop for changes no event reports (titles,
 * renames, the daemon unloading an idle agent). Callers that are about to act (a send) ask for fresh agents.
 *
 * A cached snapshot can still say "loaded" after the daemon unloaded an idle agent, so anything that would wake an
 * agent (a timeline or subagent read) re-checks that one agent first: see `live`.
 */
export class DaemonDirectory {
  private rows: (DirectoryRows & { at: number; agentsAt: number }) | null = null;
  private loading: Promise<DirectoryRows> | null = null;
  private dirty = false;
  private projectsStale = false;
  /** Requests this directory has sent, by daemon request type. For tests and the scale check. */
  readonly requests: Record<string, number> = {};
  constructor(private connect: <T>(work: (client: Daemon) => Promise<T>) => Promise<T> = withDaemon, private now = Date.now) {}

  private count(type: string, n = 1) { this.requests[type] = (this.requests[type] ?? 0) + n; }
  private async list<T>(type: string, fetch: (cursor?: string) => Promise<{ entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>): Promise<T[]> {
    return pages(cursor => { this.count(type); return fetch(cursor); });
  }

  /** Something changed that events don't fully describe: re-read on the next read at least a minute after the last. */
  markDirty(): void { this.dirty = true; }

  /**
   * The cached rows, re-read when due. `fresh: "agents"` re-reads only the agent list (cheap; no paseo.json reads),
   * for a decision that must see current status. `fresh: true` re-reads everything.
   */
  async read(options: { fresh?: boolean | "agents" } = {}): Promise<DirectoryRows> {
    if (this.loading) { await this.loading.catch(() => undefined); if (!options.fresh) return this.read(); }
    const now = this.now();
    const rows = this.rows;
    const due = !rows || options.fresh === true || now - rows.at >= BACKSTOP_REFRESH_MS || (this.dirty && now - rows.at >= DIRTY_REFRESH_MS);
    if (!due && rows && options.fresh === "agents") return this.refreshAgents();
    if (!due && rows && !this.projectsStale) return rows;
    if (!due && rows) return this.refreshProjects();
    let failedProjects = false;
    const loading = this.connect(async client => {
      const [agents, workspaces, catalog] = await Promise.all([
        this.list("fetch_agents_request", cursor => client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } })),
        this.list("fetch_workspaces_request", cursor => client.fetchWorkspaces({ page: { limit: 100, ...(cursor ? { cursor } : {}) } }) as Promise<{ entries: WorkspaceRow[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>),
        // Projects only matter to discovery's defaults; a failed read keeps the last list and retries next time.
        Promise.resolve().then(() => { this.count("project.list.request"); return client.listProjects(); }).then(c => c.projects, () => { failedProjects = true; return this.rows?.projects ?? []; }),
      ]);
      return { agents, workspaces, projects: catalog };
    });
    this.loading = loading;
    this.dirty = false; this.projectsStale = false;
    try {
      const fresh = await loading;
      const at = this.now();
      this.rows = { ...fresh, at, agentsAt: at };
      if (failedProjects) this.projectsStale = true;
      return this.rows;
    } catch (error) { this.dirty = true; throw error; }
    finally { if (this.loading === loading) this.loading = null; }
  }

  private async refreshAgents(): Promise<DirectoryRows> {
    const agents = await this.connect(client => this.list("fetch_agents_request", cursor => client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } })));
    if (this.rows) { this.rows.agents = agents; this.rows.agentsAt = this.now(); }
    return this.rows!;
  }
  private async refreshProjects(): Promise<DirectoryRows> {
    const catalog = await this.connect(client => { this.count("project.list.request"); return client.listProjects(); });
    this.projectsStale = false;
    if (this.rows) this.rows.projects = catalog.projects;
    return this.rows!;
  }

  /** The project list, re-read when older than `maxAgeMs` (Settings opening it), else the cached one. */
  async projects(maxAgeMs = BACKSTOP_REFRESH_MS): Promise<Project[]> {
    const rows = await this.read();
    if (this.rows && this.now() - this.rows.at >= maxAgeMs) { this.projectsStale = true; return (await this.read()).projects; }
    return rows.projects;
  }

  /** The cached snapshot of one agent, if the directory has it. */
  cached(id: string): Agent | undefined { return this.rows?.agents.find(row => row.agent.id === id)?.agent; }

  /**
   * One agent as Paseo has it now (a single fetch_agent), patched into the directory. Call before anything that
   * would wake an unloaded agent, since the cached snapshot may predate the daemon unloading it.
   */
  async live(client: Daemon, id: string): Promise<Agent | null> {
    this.count("fetch_agent_request");
    const agent = (await client.fetchAgent(id))?.agent ?? null;
    // Paseo's own lists leave background agents out, so a row for one would only flicker until the next re-read.
    if (agent && isBackgroundAgent(agent)) { if (this.rows) this.rows.agents = this.rows.agents.filter(row => row.agent.id !== id); return agent; }
    if (agent && this.rows) {
      const i = this.rows.agents.findIndex(row => row.agent.id === id);
      if (i >= 0) this.rows.agents[i] = { agent }; else this.rows.agents.push({ agent });
    }
    return agent;
  }

  /**
   * The agent if it is loaded right now, else null. A running agent can't be unloaded mid-turn, so its snapshot is
   * trusted; any other "loaded" snapshot is confirmed with one fetch_agent first.
   */
  async confirmLoaded(client: Daemon, agent: Agent): Promise<Agent | null> {
    if (["running", "initializing"].includes(agent.status)) return agent;
    const current = await this.live(client, agent.id);
    return current && isLoaded(current) ? current : null;
  }

  private patch(id: string, change: (agent: Agent) => void): boolean {
    const agent = this.cached(id);
    if (!agent) { this.dirty = true; return false; }
    change(agent);
    return true;
  }

  // Lifecycle events. Each patches what it knows; anything it can't know (titles, message times) waits for the
  // next due re-read.
  turnStarted(agent: HookAgent, turnId: string | null): void {
    this.patch(agent.id, a => { a.status = "running"; a.activeTurn = { id: turnId }; if (agent.title) a.title = agent.title; });
    this.dirty = true;
  }
  turnEnded(agent: HookAgent, outcome: { kind: string }): void {
    // A failed turn may leave the agent in error; until the re-read says so, keep it busy rather than guess idle.
    this.patch(agent.id, a => { if (outcome.kind !== "failed") a.status = "idle"; a.activeTurn = null; if (agent.title) a.title = agent.title; });
    this.dirty = true;
  }
  permissionRequested(agentId: string, request: { id?: string }): void {
    this.patch(agentId, a => { if (request.id && !a.pendingPermissions.some(p => (p as { id?: string })?.id === request.id)) a.pendingPermissions = [...a.pendingPermissions, { id: request.id }]; });
  }
  permissionResolved(agentId: string, requestId: string): void {
    this.patch(agentId, a => { a.pendingPermissions = a.pendingPermissions.filter(p => (p as { id?: string })?.id !== requestId); });
  }
  agentArchived(agentId: string, at: string): void { this.patch(agentId, a => { a.archivedAt = at; }); }
  agentClosed(agentId: string): void { this.patch(agentId, a => { a.status = "closed"; delete a.activeTurn; }); }
  /** A new agent: its full snapshot (labels, parent) comes from one fetch_agent, so discovery can place it. */
  async agentCreated(agent: HookAgent): Promise<void> {
    if (!this.rows) return;
    await this.connect(client => this.live(client, agent.id)).catch(() => { this.dirty = true; });
  }
  workspaceCreated(workspace: { id: string; projectId: string; name: string | null }): void {
    if (!this.rows) return;
    if (!this.rows.workspaces.some(w => w.id === workspace.id)) this.rows.workspaces.push({ id: workspace.id, name: workspace.name ?? "", projectId: workspace.projectId, labels: [] });
    if (!this.rows.projects.some(p => p.projectId === workspace.projectId)) this.projectsStale = true;
    this.dirty = true;
  }
  workspaceArchived(workspaceId: string): void {
    const row = this.rows?.workspaces.find(w => w.id === workspaceId);
    if (row) row.archivingAt = row.archivingAt ?? new Date(this.now()).toISOString();
  }
}
