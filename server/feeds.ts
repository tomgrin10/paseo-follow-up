import type { ListCache } from "./list-cache";
import type { State } from "../shared/model";
import type { ListEntry } from "../shared/list";

/**
 * Pushes instead of client polling (Paseo 0.16 subscriptions, plan item 6). A feed is one shared serve per topic: a
 * change in state the worker already holds (a store save, a tick, a settings write) calls `changed()`, the feed reads
 * its value once, and pushes it only to subscribers whose last value differs. An unchanged change pushes nothing, and
 * nothing here runs on a timer of its own: no polling on the server, no per-subscriber timers.
 */
type Push<E> = (event: E) => Promise<void>;

export class ValueFeed<E> {
  private subs = new Set<{ push: Push<E>; key: string | null }>();
  private reading: Promise<void> | null = null;
  private again = false;
  constructor(private o: {
    read: () => Promise<E>;
    /** What a subscriber would see: two values with the same key push nothing. */
    key?: (value: E) => string;
    /** The first subscriber arrived, or the last one left (start or stop a watcher that only matters while watched). */
    onFirst?: () => void; onLast?: () => void;
  }) {}
  get size() { return this.subs.size; }
  private key(value: E) { return this.o.key ? this.o.key(value) : JSON.stringify(value); }

  /** Serves one subscriber: the current value at once, then each change, until `signal` aborts. Never throws. */
  serve(push: Push<E>, signal: AbortSignal): void {
    if (signal.aborted) return;
    const sub = { push, key: null as string | null };
    this.subs.add(sub);
    if (this.subs.size === 1) this.o.onFirst?.();
    signal.addEventListener("abort", () => { if (this.subs.delete(sub) && !this.subs.size) this.o.onLast?.(); }, { once: true });
    void this.o.read().then(value => { if (!this.subs.has(sub)) return; sub.key = this.key(value); return push(value); }).catch(() => undefined);
  }

  /** Something the value is made of may have changed. Calls during a read coalesce into one more read. */
  changed(): Promise<void> {
    if (!this.subs.size) return Promise.resolve();
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      do {
        this.again = false;
        const value = await this.o.read();
        const key = this.key(value);
        await Promise.all([...this.subs].map(sub => {
          if (sub.key === key) return undefined;
          sub.key = key;
          return sub.push(value).catch(() => undefined);
        }));
      } while (this.again && this.subs.size);
    })().catch(() => undefined).finally(() => { this.reading = null; });
    return this.reading;
  }
}

export type WorkspacesEvent = { revision: number; full: boolean; workspaces: ListEntry[]; removed: string[]; error: string | null };

/**
 * follow.list as a feed: each subscriber holds a revision, and a change sends it only the workspaces changed since,
 * computed once per distinct revision (normally one, since every subscriber is caught up). The worker's error rides
 * along, so a banner appears or clears without a poll.
 */
export class WorkspacesFeed {
  private subs = new Set<{ push: Push<WorkspacesEvent>; revision: number | undefined; error: string | null }>();
  private reading: Promise<void> | null = null;
  private again = false;
  constructor(private cache: ListCache, private state: () => Promise<State>, private error: () => string | null) {}
  get size() { return this.subs.size; }

  serve(since: number | undefined, push: Push<WorkspacesEvent>, signal: AbortSignal): void {
    if (signal.aborted) return;
    const sub = { push, revision: since, error: null as string | null };
    this.subs.add(sub);
    signal.addEventListener("abort", () => { this.subs.delete(sub); }, { once: true });
    void this.state().then(state => {
      if (!this.subs.has(sub)) return;
      const answer = this.cache.answer(state, sub.revision);
      sub.revision = answer.revision; sub.error = this.error();
      return push({ ...answer, error: sub.error });
    }).catch(() => undefined);
  }

  changed(): Promise<void> {
    if (!this.subs.size) return Promise.resolve();
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      do {
        this.again = false;
        const state = await this.state();
        const error = this.error();
        const answers = new Map<number | undefined, ReturnType<ListCache["answer"]>>();
        await Promise.all([...this.subs].map(sub => {
          let answer = answers.get(sub.revision);
          if (!answer) { answer = this.cache.answer(state, sub.revision); answers.set(sub.revision, answer); }
          const empty = !answer.full && !answer.workspaces.length && !answer.removed.length;
          if (empty && sub.error === error) { sub.revision = answer.revision; return undefined; }
          sub.revision = answer.revision; sub.error = error;
          return sub.push({ ...answer, error }).catch(() => undefined);
        }));
      } while (this.again && this.subs.size);
    })().catch(() => undefined).finally(() => { this.reading = null; });
    return this.reading;
  }
}
