import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { History } from "./discovery";
import type { Submission } from "./submissions";
import type { Artifact } from "../shared/spec";

/** What discovery keeps per agent: the distilled history, never raw timeline items. */
/** `cursor` is the newest timeline position read, so a live agent's next read fetches only what's new. */
export type HistoryEntry = { messageAt: string | null; at: number; failures: number; retryAt: number; history: History; submissions: Submission[]; artifacts: Artifact[]; cursor?: { epoch: string; seq: number } | null };

/**
 * Discovery's per-agent history, persisted so a worker or daemon restart doesn't rescan every timeline.
 * Keyed by agent id and valid while the agent's lastUserMessageAt is unchanged. Only successful reads are
 * saved; failures stay in memory with their backoff. A missing or unreadable file means an empty cache.
 */
export class HistoryCache {
  private entries = new Map<string, HistoryEntry>();
  private loaded: Promise<void> | null = null;
  private changed = false;
  constructor(private path: string | null) {}
  static at(directory: string): HistoryCache { return new HistoryCache(join(directory, "history-cache.json")); }
  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.path) return;
      try {
        const file = JSON.parse(await readFile(this.path, "utf8"));
        if (file?.version !== 1 || !file.agents || typeof file.agents !== "object") return;
        for (const [id, value] of Object.entries(file.agents as Record<string, Partial<HistoryEntry>>)) {
          if (!value || typeof value !== "object" || !value.history || !Array.isArray(value.history.candidates)) continue;
          this.entries.set(id, { messageAt: value.messageAt ?? null, at: Number(value.at) || 0, failures: 0, retryAt: 0, history: value.history as History, submissions: Array.isArray(value.submissions) ? value.submissions : [], artifacts: Array.isArray(value.artifacts) ? value.artifacts : [], cursor: value.cursor && typeof value.cursor.epoch === "string" && Number.isInteger(value.cursor.seq) ? value.cursor : null });
        }
      } catch { /* absent or unreadable: start empty */ }
    })();
    return this.loaded;
  }
  get(id: string): HistoryEntry | undefined { return this.entries.get(id); }
  set(id: string, entry: HistoryEntry): void { this.entries.set(id, entry); if (!entry.history.error) this.changed = true; }
  delete(id: string): void { if (this.entries.delete(id)) this.changed = true; }
  keys(): string[] { return [...this.entries.keys()]; }
  async save(): Promise<void> {
    if (!this.path || !this.changed) return;
    this.changed = false;
    const agents: Record<string, Omit<HistoryEntry, "failures" | "retryAt">> = {};
    for (const [id, e] of this.entries) if (!e.history.error) agents[id] = { messageAt: e.messageAt, at: e.at, history: e.history, submissions: e.submissions, artifacts: e.artifacts, cursor: e.cursor ?? null };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, agents }), { mode: 0o600 });
      await rename(temporary, this.path);
    } catch { this.changed = true; }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}
