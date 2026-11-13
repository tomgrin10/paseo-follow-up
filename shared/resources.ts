import { z } from "zod";

/**
 * 1.3.0-beta.4: the VM's memory and CPU, as the resource governor sees them. Null means unreadable. memoryBytes is
 * Paseo's cgroup working set (memory.current minus inactive_file and slab_reclaimable), not raw memory.current.
 */
export const resourceLevels = ["ok", "constrained", "critical"] as const;
export type ResourceLevel = typeof resourceLevels[number];
/** The Follow-up worker's own memory (process.memoryUsage, MB), so its footprint is visible next to the VM's. */
export const workerMemorySchema = z.object({ rssMb: z.number(), heapUsedMb: z.number(), heapTotalMb: z.number(), externalMb: z.number(), arrayBuffersMb: z.number() });
export type WorkerMemory = z.infer<typeof workerMemorySchema>;
export const resourcesSchema = z.object({
  memoryPct: z.number().nullable(), memoryBytes: z.number().nullable(), memoryHighBytes: z.number().nullable(),
  cpuPct: z.number().nullable(), memoryPressure: z.number().nullable(), cpuPressure: z.number().nullable(),
  level: z.enum(resourceLevels), at: z.string().nullable(),
  worker: workerMemorySchema.nullable().optional(),
});
export type Resources = z.infer<typeof resourcesSchema>;

/** Percent of memory.high at which background work pauses, and at which non-essential RPC work stops too. */
export const MEMORY_CONSTRAINED = 75;
export const MEMORY_CRITICAL = 85;
/** Sustained pressure (PSI some avg60, percent of time stalled) that also counts as constrained. */
export const MEMORY_PRESSURE_CONSTRAINED = 10;
export const CPU_PRESSURE_CONSTRAINED = 60;

export function governorLevel(r: Pick<Resources, "memoryPct" | "memoryPressure" | "cpuPressure">): ResourceLevel {
  if (r.memoryPct !== null && r.memoryPct >= MEMORY_CRITICAL) return "critical";
  if ((r.memoryPct !== null && r.memoryPct >= MEMORY_CONSTRAINED) || (r.memoryPressure ?? 0) >= MEMORY_PRESSURE_CONSTRAINED || (r.cpuPressure ?? 0) >= CPU_PRESSURE_CONSTRAINED) return "constrained";
  return "ok";
}

/** Readings older than three Home usage polls (60 s each) are shown as old. */
export const RESOURCES_STALE_MS = 3 * 60_000;
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0);

/** "Paseo memory 72% · CPU 40%", leaving out what's unreadable; null when nothing is. Memory is Paseo's cgroup working set against its memory.high; CPU is host-wide. */
export function resourceText(r: Pick<Resources, "memoryPct" | "cpuPct">): string | null {
  const parts = [r.memoryPct !== null ? `Paseo memory ${r.memoryPct}%` : null, r.cpuPct !== null ? `CPU ${r.cpuPct}%` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type ResourceMeter = {
  /** Visible line: "Paseo memory 72% · CPU 40%" plus "· as of 14:02" when old. */
  text: string;
  /** "· paused" when the governor is holding work back, else null. Shown in the tone colour. */
  suffix: string | null;
  /** Full sentence for screen readers, with bytes and a severity word. */
  label: string;
  /** Follows the governor level, so the colour and "paused" always agree. */
  tone: "ok" | "warning" | "danger";
  /** Bar fill: the value that is driving the level (CPU only when CPU pressure alone is). */
  pct: number;
  stale: boolean;
};

/**
 * Everything the Home meter shows, or null when nothing is readable. `holdShown`: Home's Sending group already says
 * auto-sends are paused (shared/sending.ts autoSendHold), so the meter keeps its reading and drops "· paused" (say it once).
 */
export function resourceMeter(r: Resources, now: number, clock: (ms: number) => string = ms => new Date(ms).toTimeString().slice(0, 5), o: { holdShown?: boolean } = {}): ResourceMeter | null {
  const base = resourceText(r);
  if (!base) return null;
  const tone = r.level === "critical" ? "danger" : r.level === "constrained" ? "warning" : "ok";
  const memoryDriven = (r.memoryPct ?? 0) >= MEMORY_CONSTRAINED || (r.memoryPressure ?? 0) >= MEMORY_PRESSURE_CONSTRAINED;
  const cpuDriven = !memoryDriven && (r.cpuPressure ?? 0) >= CPU_PRESSURE_CONSTRAINED;
  const pct = (cpuDriven ? r.cpuPct ?? r.memoryPct : r.memoryPct ?? r.cpuPct) ?? 0;
  const at = r.at ? Date.parse(r.at) : NaN;
  const stale = Number.isFinite(at) && now - at > RESOURCES_STALE_MS;
  const text = stale ? `${base} · as of ${clock(at)}` : base;
  const paused = r.level === "critical" ? "Follow-up paused background work and extras" : r.level === "constrained" ? "Follow-up paused background work" : null;
  const memory = r.memoryPct === null ? null : r.memoryBytes && r.memoryHighBytes ? `Paseo memory ${gb(r.memoryBytes)} of ${gb(r.memoryHighBytes)} GB` : `Paseo memory ${r.memoryPct}%`;
  const label = [
    [memory, r.cpuPct !== null ? `CPU ${r.cpuPct}%` : null].filter(Boolean).join(", ") + (tone === "danger" ? ", critical" : tone === "warning" ? ", high" : ""),
    paused, stale ? `Last read at ${clock(at)}` : null,
  ].filter(Boolean).join(". ");
  return { text, suffix: paused && !o.holdShown ? "· paused" : null, label, tone, pct, stale };
}
