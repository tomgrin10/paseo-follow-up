import { getHeapSpaceStatistics, setFlagsFromString } from "node:v8";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

type Gc = (options?: { type?: "major" | "minor"; execution?: "sync" | "async"; flavor?: "regular" | "last-resort" }) => void;
let cached: Gc | null | undefined;
function gcFunction(): Gc | null {
  if (cached !== undefined) return cached;
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    setFlagsFromString("--no-expose-gc");
    cached = typeof gc === "function" ? gc as Gc : null;
  } catch { cached = null; }
  return cached;
}

/**
 * One memory-reducing garbage collection: a full, compacting collection that also shrinks V8's young generation and
 * releases the pages V8 keeps pooled. A plain `gc()` does neither (Node 24: RSS 108 → 108 MB after a burst; the
 * memory-reducing flavor: 108 → 54). Paseo starts plugin processes itself, so there's no --expose-gc: the flag is set
 * for one fresh context only, which leaves no `gc` global behind. Returns false where the runtime refuses.
 */
export function compactHeap(): boolean {
  const gc = gcFunction();
  if (!gc) return false;
  try { gc({ type: "major", execution: "sync", flavor: "last-resort" }); } catch { try { gc(); } catch { return false; } }
  return true;
}

/** One settle: `forced` when the 10-minute fallback ran it, not a quiet minute. */
export type Settle = { at: number; beforeMb: number; afterMb: number; ms: number; cpuMs: number; forced: boolean };
export type SettlerOptions = { growthMb?: number; minGapMs?: number; quietSamples?: number; quietUtilization?: number; maxWaitMs?: number; now?: () => number; rssMb?: () => number; compact?: () => boolean; cpuMs?: () => number };
/**
 * Memory a burst grows comes back when the burst ends (memory-returns-after-a-burst). Under a burst of work V8 grows its
 * young generation to its cap (128 MB on Node 24) and keeps it, or its pages pooled, for as long as anything
 * allocates; the worker always does, so RSS stepped up with every busy period and never came down. `observe` gets the
 * worker's RSS and event-loop utilization every 5 s. One memory-reducing collection (60-100 ms, the event loop
 * blocked) runs when RSS is `growthMb` over where the last one left it, `minGapMs` has passed, and the worker is quiet:
 * the median of the last 12 samples (a minute) under 1 %. Mid-burst the young generation would grow straight back, and
 * a burst's samples sit at 2-14 % (minute medians 3-6 %, harness 2026-11-25). The gate reads the minute's typical
 * sample, not its mean: the worker's own ticks spike once or twice a minute (6-12 %) over a 0.1-0.3 % floor, so a quiet
 * minute's mean read 1.2-1.6 % and a mean gate opened only when a window missed a spike, 98-133 s into a gap or not at
 * all (scale-live failed ~1 in 20 from 2026-11-23, as the worker's background work grew; on 2026-11-16 gaps ran at
 * 0.2 %). The median opens about 35 s into a gap. A median lags a burst's start by half a minute, so the latest sample
 * has to be under 1 % too (a burst's are 1.2 % and up). Busy for `maxWaitMs` past the threshold, it runs anyway. A collection that gives back under 8 MB (a runtime that ignores the memory-reducing flavor,
 * or growth outside V8) doubles the gap, up to an hour, so a futile one doesn't repeat.
 */
const medianOf = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export class HeapSettler {
  private baseline: number | null = null;
  private last = -Infinity;
  private gap: number;
  private recent: number[] = [];
  private overSince: number | null = null;
  readonly settles: Settle[] = [];
  /** Settles since start, by what let them run: a quiet minute, or the fallback (live verification, heartbeat.json). */
  quietSettles = 0;
  forcedSettles = 0;
  /** The last minute's per-sample utilizations, oldest first (heartbeat.json: how close the gate is). */
  recentSamples(): number[] { return [...this.recent]; }
  /** The last minute's typical event-loop utilization (its median sample: the quiet gate's reading), or null before the first. */
  utilization(): number | null { return this.recent.length ? medianOf(this.recent) : null; }
  constructor(private o: SettlerOptions = {}) { this.gap = o.minGapMs ?? 120_000; }
  observe(rssMb: number, utilization = 0): Settle | null {
    const now = (this.o.now ?? Date.now)();
    const window = this.o.quietSamples ?? 12;
    this.recent.push(utilization); if (this.recent.length > window) this.recent.shift();
    if (this.baseline === null || rssMb < this.baseline) { this.baseline = rssMb; this.overSince = null; return null; }
    if (rssMb < this.baseline + (this.o.growthMb ?? 48)) { this.overSince = null; return null; }
    this.overSince ??= now;
    if (now - this.last < this.gap) return null;
    const q = this.o.quietUtilization ?? 0.01;
    const quiet = this.recent.length >= window && medianOf(this.recent) < q && utilization < q;
    if (!quiet && now - this.overSince < (this.o.maxWaitMs ?? 600_000)) return null;
    const cpu = this.o.cpuMs ?? (() => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; });
    const t0 = performance.now(); const c0 = cpu();
    const ran = (this.o.compact ?? compactHeap)();
    const ms = Math.round(performance.now() - t0); const cpuMs = Math.round(cpu() - c0);
    this.last = now; this.overSince = null;
    if (!ran) return null;
    const after = (this.o.rssMb ?? (() => process.memoryUsage().rss / 1048576))();
    const settle = { at: now, beforeMb: Math.round(rssMb), afterMb: Math.round(after), ms, cpuMs, forced: !quiet };
    if (quiet) this.quietSettles++; else this.forcedSettles++;
    this.gap = rssMb - after < 8 ? Math.min(this.gap * 2, 3_600_000) : (this.o.minGapMs ?? 120_000);
    this.baseline = after; this.settles.push(settle); if (this.settles.length > 20) this.settles.shift();
    console.error(`[follow-up] memory settled: ${settle.beforeMb} → ${settle.afterMb} MB, ${ms} ms (cpu ${cpuMs} ms)`);
    return settle;
  }
}

export type MemoryBeat = { at: number; samples: number[]; rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number; youngMb: number | null; utilization: number | null; quietSettles: number; forcedSettles: number; settles: Settle[] };
const mb = (n: number) => Math.round(n / 1048576 * 10) / 10;
const round = (u: number | null) => u === null ? null : Math.round(u * 10000) / 10000;
/**
 * The worker's memory as heartbeat.json reports it: process.memoryUsage(), V8's young generation, the last minute's
 * median event-loop utilization and its samples (is the 1 % quiet gate reachable on this host?), and the settles, quiet
 * and forced counted.
 */
export function memoryBeat(settler: HeapSettler): MemoryBeat {
  const m = process.memoryUsage();
  const young = getHeapSpaceStatistics().find(x => x.space_name === "new_space");
  return { at: Date.now(), samples: settler.recentSamples().map(u => Math.round(u * 10000) / 10000), rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers), youngMb: young ? mb(young.space_size) : null, utilization: round(settler.utilization()), quietSettles: settler.quietSettles, forcedSettles: settler.forcedSettles, settles: settler.settles.slice(-5) };
}

/**
 * The worker's memory watch, from the end of startup: the settler gets RSS and event-loop utilization every 5 s, and
 * heartbeat.json gets a `memory` field every minute, so live numbers need no /proc. The rest of the heartbeat
 * (`version`, `at`, `error`: the installer's probation) is kept as written.
 */
const heartbeatChains = new Map<string, Promise<unknown>>();
/**
 * The one writer of heartbeat.json (the probation beat and the memory beat): merges `patch` into what is there, one
 * write at a time per file, through a unique temporary file and a rename, so a reader (the installer, the watchdog, the
 * next beat) never sees a partial file and neither beat drops the other's fields. 2026-11-25 CI: two memory beats 30 ms
 * apart shared one temporary name, and a reader got "Unexpected end of JSON input".
 */
export function writeHeartbeat(file: string, patch: Record<string, unknown>): Promise<void> {
  const run = (heartbeatChains.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const current = await readFile(file, "utf8").then(raw => JSON.parse(raw) as Record<string, unknown>, () => ({}));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  });
  heartbeatChains.set(file, run);
  void run.finally(() => { if (heartbeatChains.get(file) === run) heartbeatChains.delete(file); }).catch(() => undefined);
  return run;
}

export function watchMemory(o: { heartbeatFile: string; settler?: HeapSettler; sampleMs?: number; beatMs?: number }): { settler: HeapSettler; stop(): Promise<void> } {
  const settler = o.settler ?? new HeapSettler();
  let elu = performance.eventLoopUtilization();
  settler.observe(process.memoryUsage().rss / 1048576);
  const sample = setInterval(() => {
    const next = performance.eventLoopUtilization();
    settler.observe(process.memoryUsage().rss / 1048576, performance.eventLoopUtilization(next, elu).utilization);
    elu = next;
  }, o.sampleMs ?? 5_000);
  // The beat being written, so stop() resolves only once nothing more touches the heartbeat's folder.
  let writing: Promise<unknown> = Promise.resolve();
  const beat = setInterval(() => { writing = writeHeartbeat(o.heartbeatFile, { memory: memoryBeat(settler) }).catch(() => undefined); }, o.beatMs ?? 60_000);
  sample.unref?.(); beat.unref?.();
  return { settler, stop: async () => { clearInterval(sample); clearInterval(beat); await writing; } };
}
