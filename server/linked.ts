import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { liveSources, mcpproxyText } from "./about";
import { LIMITS, LINKED_FULL, TEAMS_TTL_MS, applyCheck, classifyLink, emptyWorkspaceLinks, excludeItem, linkedView, noteCandidate, noteRefs, setTeams, dueChecks, emptyLinkedFile, linkedFileSchema, linkedSearchIndex, migrateAboutLinks, takeBudget, teamOf, toneOf, unexcludeItem, upsertItem, type LinearIssueFacts, type LinkedFile, type LinkedItem, type LinkRef, type LinkedView } from "../shared/linked";

/**
 * linked.json beside state.json (see shared/linked.ts). Read from disk on each use and never held whole in the worker:
 * it is small and read rarely (a panel open, one drain per observe cycle). Writes are serialized and atomic.
 */
export class LinkedStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private get path() { return join(this.directory, "linked.json"); }
  async read(): Promise<LinkedFile> {
    try { return linkedFileSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); } catch { return emptyLinkedFile(); }
  }
  mutate<T>(fn: (file: LinkedFile) => T): Promise<T> {
    const next = this.tail.then(async () => {
      const file = await this.read();
      const result = fn(file);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Daemon-side Linear reads. `issue` returns null for "not found" and throws when Linear couldn't be read. */
export type LinkedSources = {
  issue(key: string): Promise<LinearIssueFacts | null>;
  teams(): Promise<string[]>;
};

/** `linear:list_teams` text: JSON with team objects carrying `key`, or anything with "key": "HER" pairs. */
export function parseLinearTeams(text: string): string[] {
  const keys = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== "object") return;
    const k = (v as { key?: unknown }).key;
    if (typeof k === "string" && /^[A-Z][A-Z0-9]{1,9}$/.test(k)) keys.add(k);
    for (const x of Object.values(v)) if (x && typeof x === "object") visit(x);
  };
  try { visit(JSON.parse(text)); } catch { for (const m of text.matchAll(/"key"\s*:\s*"([A-Z][A-Z0-9]{1,9})"/g)) keys.add(m[1]); }
  return [...keys].sort();
}

export type LinkedDeps = {
  store: LinkedStore;
  sources: LinkedSources;
  /** The resource governor's background threshold: no checks while the VM is short of room. */
  roomForBackground?(): Promise<boolean>;
  now?: () => number;
};

/**
 * The Linear check queue. Drained on the observe cadence: nothing to do (the steady state) costs one small file read;
 * otherwise at most LIMITS.checksPerDrain reads, within a daily budget, plus the team list once a day.
 */
export class LinkedService {
  private draining: Promise<{ checked: number; skipped: string | null }> | null = null;
  constructor(private deps: LinkedDeps) {}
  private now() { return (this.deps.now ?? Date.now)(); }

  drain(): Promise<{ checked: number; skipped: string | null }> {
    this.draining ??= this.run().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async run(): Promise<{ checked: number; skipped: string | null }> {
    const file = await this.deps.store.read();
    const pending = Object.values(file.workspaces).some(w => w.candidates.length);
    if (!pending) return { checked: 0, skipped: null };
    if (this.deps.roomForBackground && !await this.deps.roomForBackground().catch(() => true)) return { checked: 0, skipped: "memory" };
    const now = this.now();
    if (!file.teams || now - Date.parse(file.teams.at) > TEAMS_TTL_MS) {
      const keys = await this.deps.sources.teams().catch(() => null);
      // An unreadable team list keeps the old one; without any, candidates wait (they never render meanwhile).
      if (keys?.length) await this.deps.store.mutate(f => setTeams(f, keys, now));
    }
    const due = dueChecks(await this.deps.store.read(), now);
    let checked = 0;
    for (const { key } of due) {
      if (!await this.deps.store.mutate(f => takeBudget(f, this.now()))) return { checked, skipped: "daily-cap" };
      const result = await this.deps.sources.issue(key).then(found => ({ found }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      await this.deps.store.mutate(f => applyCheck(f, key, result, this.now()));
      checked++;
    }
    return { checked, skipped: null };
  }

  /**
   * An explicit link: an agent's link_item (origin registered, by its id) or the developer's Add link (manual). A Linear
   * key is confirmed with Linear first: unknown keys and non-team prefixes are refused, not stored. When Linear can't be
   * read the key waits as a candidate and the drain adds it later. A PR is refused: it has register_pr.
   */
  async link(workspaceId: string, raw: string, opts: { origin: "registered" | "manual"; by: string; why?: string | null; title?: string | null }): Promise<LinkResult> {
    const c = classifyLink(raw, true);
    if (!c) return { ok: false, reason: "Not a link or a Linear key. Give an http(s) URL or a key like HER-1312." };
    if (c.kind === "pr") return { ok: false, reason: `${c.key} is a pull request, not a linked item. Register it with register_pr.` };
    const now = this.now();
    let facts: LinearIssueFacts | null = null;
    if (c.kind === "linear") {
      const file = await this.deps.store.read();
      if (file.rejected[c.key]) return { ok: false, reason: `Linear has no issue ${c.key}.` };
      if (file.teams && !file.teams.keys.includes(teamOf(c.key))) return { ok: false, reason: `${teamOf(c.key)} isn't a Linear team here (teams: ${file.teams.keys.join(", ") || "none"}).` };
      const known = file.workspaces[workspaceId]?.items.some(i => i.key === c.key);
      if (!known) {
        const result = await this.deps.sources.issue(c.key).then(found => ({ found }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
        if ("found" in result && !result.found) { await this.deps.store.mutate(f => applyCheck(f, c.key, result, now)); return { ok: false, reason: `Linear has no issue ${c.key}.` }; }
        if ("error" in result) {
          const excluded = await this.deps.store.mutate(f => {
            if (opts.origin === "manual") { const ws = f.workspaces[workspaceId] ??= emptyWorkspaceLinks(); ws.excluded = ws.excluded.filter(e => e.key !== c.key); }
            return !noteCandidate(f, workspaceId, c.key, now, true) && !!f.workspaces[workspaceId]?.excluded.some(e => e.key === c.key);
          });
          if (excluded) return { ok: false, reason: excludedReason(c.key) };
          return { ok: true, pending: true, key: c.key, message: `Linear couldn't be read just now. ${c.key} is queued and shows once Linear confirms it.` };
        }
        facts = result.found;
      }
    }
    return this.deps.store.mutate(f => {
      const ws = f.workspaces[workspaceId] ??= emptyWorkspaceLinks();
      const r = upsertItem(ws, {
        key: c.key, kind: c.kind, url: facts?.url ?? c.url, title: facts?.title ?? opts.title ?? null, origin: opts.origin, by: opts.by, why: opts.why ?? null,
        ...(facts ? { status: facts.state, statusTone: toneOf(facts.state), checkedAt: new Date(now).toISOString() } : {}),
      }, now);
      if (!r.ok) return { ok: false as const, reason: r.reason === "excluded" ? excludedReason(c.key) : LINKED_FULL };
      return { ok: true as const, pending: false, key: c.key, item: r.item, created: r.created };
    });
  }

  /** Removes an item and remembers it, so nothing adds it back (only the developer re-adding it, or Undo). */
  unlink(workspaceId: string, raw: string, by: string, reason: string | null): Promise<{ removed: LinkedItem | null; key: string }> {
    const key = classifyLink(raw, true)?.key ?? raw.trim();
    return this.deps.store.mutate(f => ({ removed: excludeItem(f.workspaces[workspaceId] ??= emptyWorkspaceLinks(), key, by, reason, this.now()), key }));
  }

  /** Undo a removal: the exclusion goes and the item comes back as it was. */
  undo(workspaceId: string, key: string): Promise<boolean> {
    return this.deps.store.mutate(f => {
      const ws = f.workspaces[workspaceId];
      if (!ws?.excluded.some(e => e.key === key)) return false;
      unexcludeItem(ws, key);
      return true;
    });
  }

  async view(workspaceId: string, derived: Parameters<typeof linkedView>[2]): Promise<LinkedView> {
    return linkedView(workspaceId, (await this.deps.store.read()).workspaces[workspaceId], derived);
  }

  /** Home's search index: one read of linked.json, made only while the developer searches. */
  async searchIndex(): Promise<ReturnType<typeof linkedSearchIndex>> {
    return linkedSearchIndex(await this.deps.store.read());
  }

  /** Passive sightings (shared/linked-extract.ts), one write for the whole batch. Nothing to note costs nothing. */
  note(batch: ReadonlyMap<string, readonly LinkRef[]>): Promise<{ items: number; candidates: number }> {
    if (![...batch.values()].some(r => r.length)) return Promise.resolve({ items: 0, candidates: 0 });
    return this.deps.store.mutate(f => {
      let items = 0, candidates = 0;
      for (const [workspaceId, refs] of batch) { const n = noteRefs(f, workspaceId, refs, this.now()); items += n.items; candidates += n.candidates; }
      return { items, candidates };
    });
  }

  /** One-time carry-over of verified Summary links (shared/linked.ts migrateAboutLinks). */
  migrate(about: () => Promise<Record<string, { links: { kind: string; key: string; url: string | null; title: string | null; state?: string | null }[] }>>): Promise<{ items: number; candidates: number }> {
    return this.deps.store.read().then(async file => {
      if (file.migrations.includes("about-links-1")) return { items: 0, candidates: 0 };
      const entries = await about().catch(() => ({}));
      return this.deps.store.mutate(f => migrateAboutLinks(f, entries, this.now()));
    });
  }
}

export type LinkResult = { ok: false; reason: string } | { ok: true; pending: true; key: string; message: string } | { ok: true; pending: false; key: string; item: LinkedItem; created: boolean };
const excludedReason = (key: string) => `${key} was removed from this workspace's linked items, so it stays out. The developer can add it back in the Linked items list.`;

const exec = promisify(execFile);
/** The live reads, through mcpproxy like the Summary: Linear's get_issue and list_teams. */
export function liveLinkedSources(run: (command: string, args: string[], timeoutMs: number) => Promise<string> = async (c, a, t) => (await exec(c, a, { timeout: t, maxBuffer: 4 * 1024 * 1024 })).stdout): LinkedSources {
  const about = liveSources(run);
  return {
    async issue(key) { const i = await about.linear(key); return i ? { title: i.title, state: i.state, url: i.url } : null; },
    async teams() {
      const out = await run("mcpproxy", ["call", "tool-read", "--tool-name=linear:list_teams", "--json_args={}", "--reason=Follow-up: which Linear keys are real", "--log-level=error", "-o", "json"], 45_000);
      return parseLinearTeams(mcpproxyText(out));
    },
  };
}
