import { z } from "zod";

/** 1.3.0-beta.4: the VM's memory and CPU, as the resource governor sees them. Null means unreadable. */
export const resourceLevels = ["ok", "constrained", "critical"] as const;
export type ResourceLevel = typeof resourceLevels[number];
export const resourcesSchema = z.object({
  memoryPct: z.number().nullable(), memoryBytes: z.number().nullable(), memoryHighBytes: z.number().nullable(),
  cpuPct: z.number().nullable(), memoryPressure: z.number().nullable(), cpuPressure: z.number().nullable(),
  level: z.enum(resourceLevels), at: z.string().nullable(),
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

/** The meter's tone for one value: amber from the constrained threshold, red from the critical one. */
export function resourceTone(kind: "memory" | "cpu", pct: number | null, level: ResourceLevel): "ok" | "warning" | "danger" {
  if (pct === null) return "ok";
  if (kind === "memory") return pct >= MEMORY_CRITICAL ? "danger" : pct >= MEMORY_CONSTRAINED ? "warning" : "ok";
  return pct >= 95 ? "danger" : pct >= 75 ? "warning" : "ok";
}

/** "VM memory 72% · CPU 40%", leaving out what's unreadable; null when nothing is. */
export function resourceText(r: Pick<Resources, "memoryPct" | "cpuPct">): string | null {
  const parts = [r.memoryPct !== null ? `VM memory ${r.memoryPct}%` : null, r.cpuPct !== null ? `CPU ${r.cpuPct}%` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
