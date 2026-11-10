import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { liveSources, mcpproxyText } from "./about";
import { TEAMS_TTL_MS, applyCheck, setTeams, dueChecks, emptyLinkedFile, linkedFileSchema, migrateAboutLinks, takeBudget, type LinearIssueFacts, type LinkedFile } from "../shared/linked";

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

  /** One-time carry-over of verified Summary links (shared/linked.ts migrateAboutLinks). */
  migrate(about: () => Promise<Record<string, { links: { kind: string; key: string; url: string | null; title: string | null; state?: string | null }[] }>>): Promise<{ items: number; candidates: number }> {
    return this.deps.store.read().then(async file => {
      if (file.migrations.includes("about-links-1")) return { items: 0, candidates: 0 };
      const entries = await about().catch(() => ({}));
      return this.deps.store.mutate(f => migrateAboutLinks(f, entries, this.now()));
    });
  }
}

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
