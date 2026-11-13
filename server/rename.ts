import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename as move, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { dailyBudget } from "../shared/about";
import type { RoleConfig } from "../shared/agent-settings";
import {
  checkName, EMPTY_RENAME_FILE, freshEntries, lastRename, RENAME_DAILY_CAP, RENAME_SYSTEM, renameFileSchema, renamePrompt, renameReplySchema, undoRefusal,
  type RenameFile, type RenameInputs, type RenameResult, type RenameStatus,
} from "../shared/rename";
import type { AiJobs, JobResult } from "./ai-jobs";

/**
 * Rename with AI (docs/ai-roles.md#rename-with-ai). The suggestion is one small job on Summaries' model, built from
 * stored data only (state, the Summary record, linked items, the cached directory's agent titles), so it never reads
 * a chat or loads an agent. The rename itself is Paseo's own workspace title, and every rename is kept in
 * `rename.json` for 24 hours so it can be undone.
 */

/** Paseo's workspace title, read and written. The only daemon calls a rename makes (renameDaemon). */
export type WorkspaceTitles = {
  get(workspaceId: string): Promise<{ title: string | null; name: string } | null>;
  set(workspaceId: string, title: string | null): Promise<void>;
};

/**
 * The daemon side of WorkspaceTitles: fetch_workspaces narrowed to one id, and set_workspace_title. Nothing else is
 * reachable from here: no agent fetch, no timeline (rename-never-wakes-an-agent, tests/rename.test.ts).
 */
type TitleDaemon = {
  fetchWorkspaces(options?: unknown): Promise<{ entries: { id: string; name: string; title?: string | null }[] }>;
  setWorkspaceTitle(workspaceId: string, title: string | null): Promise<unknown>;
};
export function renameDaemon(connect: <T>(work: (client: TitleDaemon) => Promise<T>) => Promise<T>, onChange?: () => void): WorkspaceTitles {
  return {
    get: id => connect(async client => {
      const page = await client.fetchWorkspaces({ filter: { idPrefix: id }, page: { limit: 5 } });
      const row = page.entries.find(e => e.id === id);
      return row ? { title: typeof row.title === "string" && row.title.trim() ? row.title : null, name: row.name } : null;
    }),
    set: async (id, title) => { await connect(client => client.setWorkspaceTitle(id, title)); onChange?.(); },
  };
}

export class RenameStore extends JsonFileStore<RenameFile> {
  constructor(directory: string) {
    super({ path: join(directory, "rename.json"), schema: renameFileSchema as never, empty: () => structuredClone(EMPTY_RENAME_FILE), move });
  }
}

export type RenameDeps = {
  store: RenameStore;
  jobs: Pick<AiJobs, "run">;
  /** Summaries' agent (Settings → Agents): provider and model. */
  role(): Promise<RoleConfig>;
  titles: WorkspaceTitles;
  /** Stored data for the prompt; null for a workspace Follow-up can't see. */
  inputs(workspaceId: string, current: string): Promise<RenameInputs | null>;
  /** The governor: null when there's room for an on-demand job, else why not. */
  room(): Promise<string | null>;
  now?: () => number;
};

export class RenameService {
  constructor(private d: RenameDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  private async current(workspaceId: string) {
    const t = await this.d.titles.get(workspaceId);
    if (!t) throw new Error("Paseo doesn't know that workspace. Refresh and try again.");
    return { ...t, shown: t.title ?? t.name };
  }

  /** The dialog's state: the name now, linked keys, the undoable rename; with `suggest`, one model suggestion. */
  async status(workspaceId: string, suggest: boolean): Promise<RenameStatus> {
    const cur = await this.current(workspaceId);
    const inputs = await this.d.inputs(workspaceId, cur.shown);
    const keys = (inputs?.linked ?? []).map(l => l.key).slice(0, 20);
    const last = lastRename(await this.d.store.read(), workspaceId, this.now());
    const suggestion = suggest ? await this.suggest(inputs ?? empty(cur.shown), keys, cur.shown) : null;
    return { workspaceId, current: cur.shown, suggestion, keys, last: last ? { from: last.from ?? cur.name, to: last.to, at: last.at } : null };
  }

  private async suggest(inputs: RenameInputs, keys: string[], current: string): Promise<string> {
    const busy = await this.d.room();
    if (busy) throw new Error(busy);
    const role = await this.d.role();
    let rejected: { name: string; reason: string } | null = null;
    // One retry with the reason; never a bigger model or more effort.
    for (let attempt = 0; attempt < 2; attempt++) {
      const allowed = await this.d.store.mutate(file => { const b = dailyBudget(file.daily, this.now(), RENAME_DAILY_CAP); if (b.allowed) file.daily = b.next; return b.allowed; });
      if (!allowed) throw new Error(`Rename with AI has made its ${RENAME_DAILY_CAP} suggestions for today. Type a name instead.`);
      const r: JobResult<{ name: string }> = await this.d.jobs.run({ name: "rename", prompt: renamePrompt(inputs, rejected), schema: renameReplySchema, system: RENAME_SYSTEM,
        provider: role.provider, model: role.model ?? undefined, thinking: role.thinking, timeoutMs: 45_000, maxPromptChars: 8000, maxOutputChars: 600 });
      if (!r.ok) { if (r.reason === "invalid-json" || r.reason === "invalid-shape") { rejected = { name: "", reason: "It wasn't the JSON object asked for." }; continue; } throw new Error(`Couldn't suggest a name: ${r.error}`); }
      const check = checkName(r.value.name, { keys, current });
      if (check.ok) return check.name;
      rejected = { name: r.value.name, reason: check.reason };
    }
    throw new Error(`Couldn't suggest a usable name: ${rejected?.reason ?? "no reply"}`);
  }

  /** Renames (the dialog's Rename, ai_rename's confirm) or undoes the newest rename. Recorded for 24 h either way. */
  async rename(workspaceId: string, input: { title?: string; undo?: boolean }, by: string): Promise<RenameResult> {
    const cur = await this.current(workspaceId);
    const now = this.now();
    if (input.undo) {
      const entry = lastRename(await this.d.store.read(), workspaceId, now);
      const refusal = undoRefusal(entry, cur.title);
      if (refusal) throw new Error(refusal);
      await this.d.titles.set(workspaceId, entry!.from);
      await this.d.store.mutate(file => { file.entries = freshEntries(file.entries, now).filter(e => !(e.workspaceId === workspaceId && e.at === entry!.at && e.to === entry!.to)); });
      return { workspaceId, title: entry!.from ?? cur.name, previous: entry!.to, undone: true };
    }
    if (input.title === undefined) throw new Error("Give the new name, or undo.");
    const keys = ((await this.d.inputs(workspaceId, cur.shown))?.linked ?? []).map(l => l.key);
    const check = checkName(input.title, { keys, current: cur.shown });
    if (!check.ok) throw new Error(check.reason);
    await this.d.titles.set(workspaceId, check.name);
    // Recorded after the title is set, so an entry always names a rename that happened; pruned past 24 h on write.
    await this.d.store.mutate(file => { file.entries = [...freshEntries(file.entries, now), { workspaceId, from: cur.title, to: check.name, at: new Date(now).toISOString(), by }].slice(-500); });
    return { workspaceId, title: check.name, previous: cur.shown, undone: false };
  }
}

const empty = (current: string): RenameInputs => ({ current, branch: null, goal: null, summary: null, spec: null, prs: [], linked: [], agents: [] });
