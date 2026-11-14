import type { State, Workspace } from "../shared/model";
import { listEntry, type ListEntry } from "../shared/list";

/**
 * Diffed answers for follow.list (1.3.0-beta.4). Clients send the revision they hold and get back only the
 * workspaces that changed since then, plus the ids that left the list, instead of every tracked workspace's full
 * state on every poll. Work is done once per saved-state change (the store hands out the same object until a
 * mutation), not once per client or poll.
 *
 * Each workspace goes out in its list form (shared/list.ts, a-list-carries-only-what-lists-draw). The store keeps an
 * unchanged workspace's saved object across mutations (a-mutation-copies-only-what-it-changes), so the list form and
 * its JSON are computed once per changed workspace, not for every workspace on every change.
 */
export class ListCache {
  private state: State | null = null;
  // Revisions start at boot time, so a token from before a worker restart is always older than `floor`.
  private revision = Date.now();
  private json = new Map<string, string>();
  /** The workspace object each `json` entry was serialised from: the same frozen object needs no new serialisation. */
  private objects = new Map<string, Workspace>();
  private changedAt = new Map<string, number>();
  private removedAt = new Map<string, number>();
  private current: ListEntry[] = [];
  /** Each listed workspace's list form, as last projected from `objects`. */
  private entries = new Map<string, ListEntry>();
  /** The oldest revision a diff can be computed from; older clients get the full list. */
  private floor = this.revision;
  constructor(private select: (state: State) => Workspace[] = state => state.workspaces.filter(w => w.enable_tracking)) {}
  private update(state: State): void {
    if (state === this.state) return;
    this.state = state;
    const next: ListEntry[] = [];
    const seen = new Set<string>();
    let changed = false;
    const revision = this.revision + 1;
    for (const w of this.select(state)) {
      seen.add(w.id);
      // a-list-answer-serializes-only-what-changed: the store keeps an unchanged workspace's frozen object
      // (a-mutation-copies-only-what-it-changes), so the same object is the same workspace and isn't projected or
      // serialised again. 2026-11-13 (run W, live copy under live load): every state change stringified every tracked
      // workspace (1.4 MB) to find the one a turn touched, 23 MB of garbage every 5 minutes.
      const held = this.entries.get(w.id);
      if (held && this.objects.get(w.id) === w && Object.isFrozen(w)) { next.push(held); continue; }
      this.objects.set(w.id, w);
      const entry = listEntry(w);
      const text = JSON.stringify(entry);
      this.entries.set(w.id, entry);
      next.push(entry);
      if (this.json.get(w.id) !== text) { this.json.set(w.id, text); this.changedAt.set(w.id, revision); this.removedAt.delete(w.id); changed = true; }
    }
    for (const id of [...this.json.keys()]) if (!seen.has(id)) { this.json.delete(id); this.objects.delete(id); this.entries.delete(id); this.changedAt.delete(id); this.removedAt.set(id, revision); changed = true; }
    // Removal records are kept for a while so slow clients still learn about them; past that they resync fully.
    if (this.removedAt.size > 500) { const cut = [...this.removedAt.values()].sort((a, b) => a - b)[this.removedAt.size - 500]; for (const [id, at] of this.removedAt) if (at < cut) this.removedAt.delete(id); this.floor = cut; }
    this.current = next;
    if (changed) this.revision = revision;
  }
  /** Everything when `since` is absent, unknown or too old; otherwise only what changed after it. */
  answer(state: State, since?: number): { revision: number; full: boolean; workspaces: ListEntry[]; removed: string[] } {
    this.update(state);
    if (since === undefined || since > this.revision || since < this.floor) return { revision: this.revision, full: true, workspaces: this.current, removed: [] };
    return {
      revision: this.revision, full: false,
      workspaces: this.current.filter(w => (this.changedAt.get(w.id) ?? 0) > since),
      removed: [...this.removedAt].filter(([, at]) => at > since).map(([id]) => id),
    };
  }
}
