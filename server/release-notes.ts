import type { ZodType } from "zod";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "../shared/version";
import { parseChangelog, LEGACY_BASELINE, type InstallKind, type ReleaseNote } from "../shared/changelog";

/**
 * Follow-up's own install, as Paseo describes it: where it lives, which version, and from what source. Read from the
 * daemon's plugin list (one request per worker), never by guessing from this process's paths.
 */
export type SelfInstall = { path: string | null; version: string; installKind: InstallKind; status: string | null; error: string | null };
export type PluginRow = { id: string; path: string; status?: string; error?: string; source?: string; installation?: { identity: { kind: string; registry?: unknown }; currentRevision?: string } };

export function describeSelf(rows: readonly PluginRow[], id = "follow-through"): Omit<SelfInstall, "version"> & { version: string | null } {
  const row = rows.find(r => r.id === id);
  if (!row) return { path: null, version: null, installKind: "unknown", status: null, error: null };
  const identity = row.installation?.identity;
  const installKind: InstallKind = identity?.registry ? "registry" : identity?.kind === "npm" ? "npm" : identity?.kind === "git" || row.source === "git" ? "git" : identity?.kind === "directory" || row.source === "directory" ? "directory" : "unknown";
  return { path: row.path, version: row.installation?.currentRevision ?? null, installKind, status: row.status ?? null, error: row.error ?? null };
}

/** The installed package's version and its CHANGELOG.md, read from the plugin's own folder. */
export async function readPackage(path: string): Promise<{ version: string | null; notes: ReleaseNote[] }> {
  const pkg = await readFile(join(path, "package.json"), "utf8").then(t => JSON.parse(t) as { version?: string }, () => null);
  const notes = await readFile(join(path, "CHANGELOG.md"), "utf8").then(parseChangelog, () => []);
  return { version: pkg?.version ?? null, notes };
}

/** versions.json: which version this host runs, the one before it, and the host-wide What's new record. */
export type VersionsFile = {
  running?: string;
  previous?: string | null;
  /** When `running` first started after a different version (ms). */
  startedAt?: number | null;
  hostSeen?: string | null;
};

export class VersionsStore {
  private cache: VersionsFile | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly now = Date.now) {}
  private get file() { return join(this.directory, "versions.json"); }
  async read(): Promise<VersionsFile> {
    if (this.cache) return this.cache;
    this.cache = await readFile(this.file, "utf8").then(t => JSON.parse(t) as VersionsFile, () => ({}));
    return this.cache;
  }
  private mutate(work: (file: VersionsFile) => VersionsFile | null): Promise<VersionsFile> {
    const next = this.tail.then(async () => {
      const file = await this.read();
      const out = work(file);
      if (!out) return file;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
      this.cache = out;
      return out;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  /**
   * Records the version this worker runs as. A change moves the old one to `previous`. With no record at all, an
   * existing install (Follow-up ran here before) starts from LEGACY_BASELINE, so its first update with release notes
   * shows them; a fresh install has no previous version, so What's new stays quiet and setup speaks instead.
   */
  started(version: string, existingInstall: boolean): Promise<VersionsFile> {
    return this.mutate(file => {
      if (file.running === version) return null;
      const previous = file.running ?? (existingInstall && compareVersions(version, LEGACY_BASELINE) > 0 ? LEGACY_BASELINE : null);
      return { ...file, running: version, previous, startedAt: previous ? this.now() : null };
    });
  }
  /** Someone closed What's new for `version`. Only moves forward. */
  seen(version: string): Promise<VersionsFile> {
    return this.mutate(file => file.hostSeen && compareVersions(file.hostSeen, version) >= 0 ? null : { ...file, hostSeen: version });
  }
}

/**
 * Harness only: with FOLLOW_UP_UPDATES_DEMO=1, `<name>-demo.json` in plugin-data overrides parts of a view, so an
 * isolated daemon can show every state for screenshots. Never set on a real install. Relative times ("-120000")
 * become absolute, so a fixture stays fresh.
 */
export async function demoOverride<T extends object>(directory: string, name: string, schema: ZodType<T>, view: T, env: Record<string, string | undefined> = process.env): Promise<T> {
  if (env.FOLLOW_UP_UPDATES_DEMO !== "1") return view;
  const raw = await readFile(join(directory, `${name}-demo.json`), "utf8").then(t => JSON.parse(t) as Record<string, unknown>, () => null);
  if (!raw) return view;
  const now = Date.now();
  const fix = (v: unknown): unknown => typeof v === "string" && /^[+-]\d+$/.test(v) ? now + Number(v) : Array.isArray(v) ? v.map(fix) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v;
  return schema.parse({ ...view, ...(fix(raw) as object) });
}
