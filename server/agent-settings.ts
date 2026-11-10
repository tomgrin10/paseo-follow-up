import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGENT_ROLES, EMPTY_AGENT_SETTINGS, JOB_PROVIDERS, isJobRole, parseAgentSettings, resolveAll, resolveRole,
  type AgentRole, type AgentSettingsFile, type Catalog, type CatalogProvider, type RoleConfig, type SavedRole,
} from "../shared/agent-settings";

/**
 * The role settings file (`agents.json`), its own small file next to state.json. Read once and cached; writes are
 * serialized, atomic and owner-only, and only happen when the developer changes something.
 */
export class AgentSettingsStore {
  private tail: Promise<unknown> = Promise.resolve();
  private cached: { file: AgentSettingsFile; invalid: AgentRole[] } | null = null;
  constructor(readonly directory: string) {}
  private get path() { return join(this.directory, "agents.json"); }

  async load(): Promise<{ file: AgentSettingsFile; invalid: AgentRole[] }> {
    if (this.cached) return this.cached;
    let raw: unknown = null;
    try { raw = JSON.parse(await readFile(this.path, "utf8")); } catch { /* missing or unreadable: defaults */ }
    this.cached = raw === null ? { file: structuredClone(EMPTY_AGENT_SETTINGS), invalid: [] } : parseAgentSettings(raw);
    return this.cached;
  }
  async role(role: AgentRole): Promise<RoleConfig> { return resolveRole((await this.load()).file, role); }
  async all(): Promise<Record<AgentRole, RoleConfig>> { return resolveAll((await this.load()).file); }

  /** Replace one role's saved entry; null resets it to the default. */
  save(role: AgentRole, entry: SavedRole | null): Promise<AgentSettingsFile> {
    const next = this.tail.then(async () => {
      const { file } = await this.load();
      const copy: AgentSettingsFile = structuredClone(file);
      if (entry === null) delete copy.roles[role];
      else {
        const parsed = parseAgentSettings({ roles: { [role]: entry } });
        if (parsed.invalid.length) throw new Error(`That ${role} setting isn't valid.`);
        copy.roles[role] = clean(role, parsed.file.roles[role] ?? {});
        if (!Object.keys(copy.roles[role]!).length) delete copy.roles[role];
      }
      await this.write(copy);
      this.cached = { file: copy, invalid: (this.cached?.invalid ?? []).filter(r => r !== role) };
      return copy;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Wait for background jobs: on unless the developer turned it off. */
  async waitEnabled(): Promise<boolean> { return (await this.load()).file.enable_wait !== false; }
  setWait(enabled: boolean): Promise<AgentSettingsFile> {
    const next = this.tail.then(async () => {
      const { file, invalid } = await this.load();
      const copy: AgentSettingsFile = { ...structuredClone(file), enable_wait: enabled };
      if (enabled) delete copy.enable_wait;
      await this.write(copy);
      this.cached = { file: copy, invalid };
      return copy;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async write(file: AgentSettingsFile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `agents.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(file, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

/** Fields a role doesn't use aren't stored. */
function clean(role: AgentRole, entry: SavedRole): SavedRole {
  const out: SavedRole = { ...entry };
  if (isJobRole(role)) { delete out.mode; delete out.same; } else { delete out.dailyCap; delete out.maxPromptChars; }
  if (role !== "ranker") delete out.cadenceMinutes;
  if (role !== "recovery") delete out.same;
  return out;
}

type SnapshotEntry = { provider: string; status?: string; enabled?: boolean; error?: string; label?: string;
  models?: { id: string; label?: string; isDefault?: boolean; isSelectable?: boolean; thinkingOptions?: { id: string; label?: string; isDefault?: boolean }[] }[];
  modes?: { id: string; label?: string }[]; defaultModeId?: string | null };
export type CatalogSource = () => Promise<{ entries?: SnapshotEntry[] } | null>;

/** Turns Paseo's provider snapshot into the picker's catalog. Unavailable providers stay listed with the reason. */
export function catalogFrom(entries: SnapshotEntry[]): CatalogProvider[] {
  return entries.filter(e => e && typeof e.provider === "string").map(e => {
    const ready = e.status === "ready" || e.status === "available";
    const reason = e.enabled === false ? "Turned off in Paseo" : ready ? null : e.status === "loading" ? "Still loading" : e.error ? e.error.slice(0, 120) : "Not installed";
    return {
      id: e.provider, label: e.label || e.provider, available: !reason, reason,
      models: (e.models ?? []).filter(m => m.isSelectable !== false && !/\[1m\]/.test(m.id)).map(m => ({ id: m.id, label: m.label || m.id, isDefault: !!m.isDefault,
        thinking: (m.thinkingOptions ?? []).map(t => ({ id: t.id, label: t.label || t.id, isDefault: !!t.isDefault })) })),
      modes: (e.modes ?? []).map(m => ({ id: m.id, label: m.label || m.id })), defaultMode: e.defaultModeId ?? null,
    };
  });
}

/** For a role: which providers it can use. Jobs need a headless CLI, so only Claude and Codex. */
export function providersFor(role: AgentRole, catalog: CatalogProvider[]): CatalogProvider[] {
  if (!isJobRole(role)) return catalog;
  return catalog.map(p => (JOB_PROVIDERS as readonly string[]).includes(p.id) ? p : { ...p, available: false, reason: p.reason ?? "Can't run one-shot jobs; only Claude and Codex can" });
}

/**
 * The live provider catalog, fetched only when Settings asks (never polled), cached for ten minutes. A failure is
 * returned as an error with an empty list and retried after a minute; it never throws to the screen.
 */
export class ProviderCatalog {
  private cache: { until: number; value: Promise<Catalog> } | null = null;
  private last: Catalog | null = null;
  /** The last catalog read, if any, without reading: for labels on cheap status polls. */
  peek(): Catalog | null { return this.last; }
  constructor(private source: CatalogSource, private now = Date.now) {}
  read(fresh = false): Promise<Catalog> {
    if (!fresh && this.cache && this.cache.until > this.now()) return this.cache.value;
    const value = this.load();
    const entry = { until: this.now() + 600_000, value };
    this.cache = entry;
    // A failure, or providers still loading, isn't kept for ten minutes.
    void value.then(c => { if (!c.error) this.last = c; if (this.cache !== entry) return; if (c.error) entry.until = this.now() + 60_000; else if (c.providers.some(p => p.reason === "Still loading")) entry.until = this.now() + 10_000; });
    return value;
  }
  private async load(): Promise<Catalog> {
    try {
      const snapshot = await this.source();
      const providers = catalogFrom(snapshot?.entries ?? []);
      return { providers, error: providers.length ? null : "Paseo returned no providers.", fetchedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      return { providers: [], error: `Couldn't read Paseo's providers: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`, fetchedAt: null };
    }
  }
}

export { AGENT_ROLES };
