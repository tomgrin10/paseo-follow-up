import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultChannel, isChannel, type Channel } from "../shared/version";
import type { UpdateMode } from "../shared/updates";

/** updates.json: the developer's update choices. A new file; missing fields mean defaults. */
export type UpdatesFile = {
  mode?: UpdateMode;
  channel?: Channel;
  /** Home notices the developer closed, by id. */
  dismissed?: string[];
  /** A newer version allowed to install, waiting for a quiet moment. `manual`: Install now asked for it. */
  ready?: { version: string; since: number; manual: boolean; lastBusyAt: number | null };
  /** Provenance verdicts by version (the last ten), so a version is checked once. */
  provenance?: Record<string, { ok: true; integrity: string; tarball: string; workflow: string } | { ok: false; reason: string }>;
};

export class UpdatesStore {
  private cache: UpdatesFile | null = null;
  constructor(private readonly directory: string) {}
  private get file() { return join(this.directory, "updates.json"); }
  async read(): Promise<UpdatesFile> {
    if (this.cache) return this.cache;
    this.cache = await readFile(this.file, "utf8").then(t => JSON.parse(t) as UpdatesFile, () => ({}));
    return this.cache;
  }
  async write(next: UpdatesFile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    this.cache = next;
  }
}

/**
 * Defaults: the channel follows the installed version. An existing install starts at Tell me; a fresh one at Install
 * automatically, which setup shows pre-selected and saves when passed or skipped.
 */
export function settingsOf(file: UpdatesFile, version: string, fallback: UpdateMode = "notify"): { mode: UpdateMode; channel: Channel } {
  return { mode: file.mode ?? fallback, channel: isChannel(file.channel) ? file.channel : defaultChannel(version) };
}

