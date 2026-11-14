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
/** Archived agents the directory remembers across re-reads (Paseo's list leaves them out), least recently used first out. */
export const ARCHIVED_MEMO_MAX = 500;
/** At most this many ids looked up by one call (the created-items RPC caps its input at 40 too). */
export const LOOKUP_MAX = 40;

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
  private rows: (DirectoryRows & { at: number; agentsAt: number; projectsAt: number }) | null = null;
  /**
   * In-flight reads, joined by every concurrent caller (concurrent-readers-share-one-request): one request per list,
   * whatever the number of readers. 2026-11-14 live: each repository's PR-workflow detection read the project list
   * itself, ~19 project.list requests back to back every 10 minutes.
   */
  private loading: Promise<DirectoryRows> | null = null;
  private loadingProjects: Promise<DirectoryRows> | null = null;
  private loadingAgents: Promise<DirectoryRows> | null = null;
  private dirty = false;
  private projectsStale = false;
  /**
   * Archived agents, remembered across re-reads: Paseo's fetch_agents leaves archived agents out, so without this an
   * archived agent a chat card or task line names would read unknown after the next re-read instead of "archived".
   * In memory, bounded (ARCHIVED_MEMO_MAX, LRU), fed by the archive event, by rows that carry archivedAt and by lookups.
   */
  private archived = new Map<string, Agent>();
  /** Ids `lookup` has asked Paseo about: each at most once per worker, including ones Paseo reported gone. */
  private looked = new Set<string>();
  /**
   * The engine's tick (a-send-lists-agents-at-most-once-per-tick). A decision that needs current status (`fresh:
   * "agents"`: a send) re-lists agents at most once per tick, then reads that list, which lifecycle events keep patched.
   * Within that tick a "loaded" row is trusted without a fetch_agent, and each agent's subagents are listed at most once.
   * 2026-11-13: each send listed every agent three times and fetched its recipient. Tick 0 (no engine) memoizes nothing.
   */
  private tick = 0;
  private agentsTick = -1;
  private subagents = new Map<string, { tick: number; running: boolean }>();
  tickStarted(): void { this.tick++; this.subagents.clear(); }
  /** Whether the agent rows were listed during this engine tick. */
  listedThisTick(): boolean { return this.tick > 0 && this.agentsTick === this.tick; }
  /** An agent's subagent answer from earlier in this tick, or undefined. */
  subagentsThisTick(id: string): boolean | undefined { const m = this.subagents.get(id); return this.tick > 0 && m?.tick === this.tick ? m.running : undefined; }
  rememberSubagents(id: string, running: boolean): void { if (this.tick > 0) this.subagents.set(id, { tick: this.tick, running }); }
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
   * for a decision that must see current status. `fresh: true` re-reads everything. `force` re-lists agents even when
   * this tick already did: only for a caller whose list lacks an agent it must find (Track; tracking-waits-for-a-new-agent).
   */
  async read(options: { fresh?: boolean | "agents"; force?: boolean } = {}): Promise<DirectoryRows> {
    if (this.loading) { await this.loading.catch(() => undefined); if (!options.fresh) return this.read(); }
    const now = this.now();
    const rows = this.rows;
    const due = !rows || options.fresh === true || now - rows.at >= BACKSTOP_REFRESH_MS || (this.dirty && now - rows.at >= DIRTY_REFRESH_MS);
    if (!due && rows && options.fresh === "agents") return this.listedThisTick() && !options.force ? rows : this.refreshAgents(options.force === true);
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
      this.rememberArchived(this.rows?.agents); this.rememberArchived(fresh.agents);
      const at = this.now();
      this.rows = { ...fresh, at, agentsAt: at, projectsAt: at }; this.agentsTick = this.tick;
      if (failedProjects) this.projectsStale = true;
      return this.rows;
    } catch (error) { this.dirty = true; throw error; }
    finally { if (this.loading === loading) this.loading = null; }
  }

  /** Joins a list already in flight, except for `force`: that caller needs a list started after it asked. */
  private refreshAgents(force: boolean): Promise<DirectoryRows> {
    if (this.loadingAgents && !force) return this.loadingAgents;
    const loading = this.listAgents().finally(() => { if (this.loadingAgents === loading) this.loadingAgents = null; });
    this.loadingAgents = loading; return loading;
  }
  private async listAgents(): Promise<DirectoryRows> {
    const agents = await this.connect(client => this.list("fetch_agents_request", cursor => client.fetchAgents({ page: { limit: 100, ...(cursor ? { cursor } : {}) } })));
    this.rememberArchived(this.rows?.agents); this.rememberArchived(agents);
    if (this.rows) { this.rows.agents = agents; this.rows.agentsAt = this.now(); this.agentsTick = this.tick; }
    return this.rows!;
  }
  private refreshProjects(): Promise<DirectoryRows> {
    if (this.loadingProjects) return this.loadingProjects;
    const loading = (async () => {
      const catalog = await this.connect(client => { this.count("project.list.request"); return client.listProjects(); });
      this.projectsStale = false;
      if (this.rows) { this.rows.projects = catalog.projects; this.rows.projectsAt = this.now(); }
      return this.rows!;
    })().finally(() => { if (this.loadingProjects === loading) this.loadingProjects = null; });
    this.loadingProjects = loading; return loading;
  }

  /** The project list, re-read when older than `maxAgeMs` (Settings opening it), else the cached one. */
  async projects(maxAgeMs = BACKSTOP_REFRESH_MS): Promise<Project[]> {
    const rows = await this.read();
    // Judged by when the projects were listed, not the whole directory: a project re-read doesn't refresh `at`, so this
    // used to re-list on every call once the directory was a minute old.
    if (this.rows && this.now() - this.rows.projectsAt >= maxAgeMs) { this.projectsStale = true; return (await this.read()).projects; }
    return rows.projects;
  }

  /** The cached snapshot of one agent, if the directory has it. */
  /** The rows the engine last read, without waiting or asking the daemon (null before the first read). */
  snapshot(): DirectoryRows | null { return this.rows; }

  private remember(agent: Agent): void {
    if (!agent.archivedAt) return;
    this.archived.delete(agent.id); this.archived.set(agent.id, agent);
    for (const id of this.archived.keys()) { if (this.archived.size <= ARCHIVED_MEMO_MAX) break; this.archived.delete(id); }
  }
  private rememberArchived(rows: readonly { agent: Agent }[] | undefined): void { for (const { agent } of rows ?? []) this.remember(agent); }

  /**
   * `agents` plus the remembered archived agents among `ids` that it lacks, for the surfaces that name a specific agent
   * (created cards, task lines). Everything else reads the plain rows, which hold no archived agent after a re-read.
   */
  withArchived<T extends { id: string }>(ids: readonly string[], agents: readonly T[]): (T | Agent)[] {
    const have = new Set(agents.map(a => a.id));
    const extra = ids.flatMap(id => { const a = this.archived.get(id); if (!a || have.has(id)) return []; this.archived.delete(id); this.archived.set(id, a); return [a]; });
    return extra.length ? [...agents, ...extra] : [...agents];
  }
  /** The rows as they stand (never waits or asks the daemon), plus the remembered archived agents among `ids`. */
  snapshotFor(ids: readonly string[]): DirectoryRows | null {
    const rows = this.rows;
    if (!rows) return null;
    const agents = this.withArchived(ids, rows.agents.map(r => r.agent));
    return agents.length === rows.agents.length ? rows : { ...rows, agents: agents.map(agent => ({ agent: agent as Agent })) };
  }

  /**
   * Asks Paseo about agents a card or task line names that the directory lacks: one fetch_agent each (metadata only:
   * Paseo projects an unloaded agent's stored record and never loads it), at most once per id for this worker's life,
   * including ids Paseo reports gone. On demand only (never on a timer); it never waits the caller, and the answer
   * lands in the rows (a live agent) or the archived memo for the next read. Before the first read it does nothing.
   */
  lookup(ids: readonly string[]): void {
    if (!this.rows) return;
    const missing = [...new Set(ids)].filter(id => !this.looked.has(id) && !this.archived.has(id) && !this.cached(id)).slice(0, LOOKUP_MAX);
    if (!missing.length) return;
    for (const id of missing) this.looked.add(id);
    void this.connect(async client => { for (const id of missing) await this.live(client, id).catch(() => null); }).catch(() => undefined);
  }
  cached(id: string): Agent | undefined { return this.rows?.agents.find(row => row.agent.id === id)?.agent; }

  /**
   * One agent as Paseo has it now (a single fetch_agent), patched into the directory. Call before anything that
   * would wake an unloaded agent, since the cached snapshot may predate the daemon unloading it.
   */
  async live(client: Daemon, id: string): Promise<Agent | null> {
    this.count("fetch_agent_request");
    const agent = (await client.fetchAgent(id))?.agent ?? null;
    if (agent?.archivedAt) this.remember(agent);
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
    // Listed this tick and patched by events since: the daemon's own answer, no older than the tick.
    if (this.listedThisTick() && this.cached(agent.id) === agent) return isLoaded(agent) ? agent : null;
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
  agentArchived(agentId: string, at: string): void { this.patch(agentId, a => { a.archivedAt = at; this.remember(a); }); }
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
