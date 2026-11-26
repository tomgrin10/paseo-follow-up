import type { Brief } from "../shared/brief";
import { isLoaded, type LoadSignals } from "../shared/agent-load";

/** Brief rows wait for discovery, never resume an agent and never run a retry timer. */
export class BriefTimeline {
  private pending = new Map<string, { brief: Brief; deferred: boolean }>();
  private running = new Map<string, Promise<void>>();
  constructor(private o: { loaded(id: string): Promise<LoadSignals | null>; current(id: string): Promise<Brief | null>; append(id: string, brief: Brief): Promise<void> }) {}

  async sink(id: string, brief: Brief): Promise<void> {
    const previous = this.pending.get(id);
    this.pending.set(id, { brief, deferred: previous?.brief.id === brief.id && previous.deferred || false });
    await this.deliver(id);
  }
  async changed(): Promise<void> { await Promise.all([...this.pending.keys()].map(id => this.deliver(id))); }

  private deliver(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) return running;
    const run = this.flush(id).finally(() => { this.running.delete(id); });
    this.running.set(id, run);
    return run;
  }
  private async flush(id: string): Promise<void> {
    while (this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      try {
        // Metadata only, freshly fetched: a cached loaded row can outlive a close or a compaction reload.
        const agent = await this.o.loaded(id);
        const current = await this.o.current(id);
        if (this.pending.get(id) !== pending) continue;
        const replaced = !current || current.id !== pending.brief.id;
        // A collapsed update emitted by the inbox still updates the old row while loaded. Once delivery has
        // waited, an obsolete card is dropped; it must not appear for the first time after a newer brief.
        if (replaced && (pending.deferred || pending.brief.state === "open")) { this.pending.delete(id); continue; }
        if (!isLoaded(agent)) { pending.deferred = true; return; }
        await this.o.append(id, replaced ? pending.brief : current!);
        if (this.pending.get(id) === pending) this.pending.delete(id);
      } catch {
        pending.deferred = true;
        // The session may not exist yet, or the runtime unloaded between metadata and append. Keep the row;
        // discovery's next update (or the first session handle) retries it, without a per-agent poll.
        return;
      }
    }
  }
}
