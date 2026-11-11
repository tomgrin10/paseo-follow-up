import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

/**
 * Which RPCs are slow, and whether the worker's event loop was the reason (2026-11-11: Paseo's daemon logs a slow
 * `plugin.rpc.invoke.request` without naming the plugin or method). Every handler runs through `timed`; one that takes
 * longer than `slowMs` logs one line to the plugin's output (daemon.log "Plugin output"):
 *
 *   [follow-up] slow rpc follow.brief-action 31204 ms (event loop since last: p99 21 ms, max 48 ms)
 *
 * A long duration with a small event-loop delay means the handler awaited something (Paseo, GitHub, a file); a large
 * delay means synchronous work blocked every RPC. Nothing runs between calls: no timer, no polling.
 */
export class RpcTiming {
  private loop: IntervalHistogram | null = null;
  constructor(private slowMs = 1_000, private log: (line: string) => void = line => console.warn(line)) {}
  start(): void { if (!this.loop) { this.loop = monitorEventLoopDelay({ resolution: 20 }); this.loop.enable(); } }
  stop(): void { this.loop?.disable(); this.loop = null; }
  timed<A extends unknown[], R>(name: string, run: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      const start = performance.now();
      try { return await run(...args); }
      finally { this.note(name, performance.now() - start); }
    };
  }
  private note(name: string, ms: number): void {
    if (ms < this.slowMs) return;
    const loop = this.loop;
    const delay = loop && loop.count ? ` (event loop since last: p99 ${Math.round(loop.percentile(99) / 1e6)} ms, max ${Math.round(loop.max / 1e6)} ms)` : "";
    loop?.reset();
    this.log(`[follow-up] slow rpc ${name} ${Math.round(ms)} ms${delay}`);
  }
}
