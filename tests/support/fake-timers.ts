import type { Timers } from "../../server/delivery";

/**
 * Timers that never fire on their own: a test fires them, earliest first, so retry schedules and attempt deadlines are
 * deterministic (no sleeps racing the store's disk writes; 2026-11-11, beta.67's publish run).
 * Pattern: `await box.idle()` (background work settles), then `await timers.fire()` (the next timer runs), repeat.
 */
export class FakeTimers implements Timers {
  private seq = 0;
  private due: { id: number; at: number; fn: () => void }[] = [];
  private waiting: (() => void)[] = [];
  /** Virtual ms since the start; moves only when a timer fires. */
  now = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.push({ id, at: this.now + ms, fn });
    for (const w of this.waiting.splice(0)) w();
    return id;
  }
  clear(handle: unknown): void { this.due = this.due.filter(t => t.id !== handle); }
  /** Delays of the timers still pending, in firing order. */
  get pending(): number[] { return this.order().map(t => t.at - this.now); }
  /** Fire the earliest pending timer, waiting (on promises, not time) for one to be set. Returns its delay. */
  async fire(): Promise<number> {
    while (!this.due.length) await new Promise<void>(r => this.waiting.push(r));
    const next = this.order()[0];
    this.due = this.due.filter(t => t !== next);
    const delay = next.at - this.now;
    this.now = next.at;
    next.fn();
    return delay;
  }
  private order() { return [...this.due].sort((a, b) => a.at - b.at || a.id - b.id); }
}
