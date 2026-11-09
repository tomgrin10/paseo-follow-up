import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { governorLevel, type Resources, type ResourceLevel } from "../shared/resources";

type Read = (path: string) => Promise<string>;
const readText: Read = path => readFile(path, "utf8");
/** PSI "some avg60" (percent of time at least one task stalled). Null when unreadable. */
export function pressure(text: string | null, kind: "some" | "full" = "some"): number | null {
  const m = text?.match(new RegExp(`^${kind} .*?avg60=([\\d.]+)`, "m"));
  return m ? Number(m[1]) : null;
}
/** One field of memory.stat, in bytes; null when absent. */
export function statField(text: string | null, field: string): number | null {
  const m = text?.match(new RegExp(`^${field} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
}
/**
 * The working set: memory.current minus reclaimable cache (inactive_file and slab_reclaimable), the kubelet's
 * measure. A disk scan can charge tens of GB of page cache to the cgroup without any real pressure, so
 * memory.current alone reads as over the limit when nothing is wrong. Falls back to memory.current without memory.stat.
 */
export function workingSet(current: number | null, stat: string | null): number | null {
  if (current === null) return null;
  const reclaimable = (statField(stat, "inactive_file") ?? 0) + (statField(stat, "slab_reclaimable") ?? 0);
  return Math.max(0, current - reclaimable);
}
const number = (text: string | null): number | null => { const v = text?.trim(); if (!v || v === "max") return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * Watches the VM so Follow-up backs off before Paseo runs out of memory (2026-11-09: systemd-oomd killed
 * paseo.service at 28.5 GB against MemoryHigh=28G). Reads the cgroup Paseo runs in (its working set from
 * memory.current and memory.stat, memory.high, memory.pressure) and the host's CPU (/proc/stat for the meter, /proc/pressure/cpu for sustained pressure).
 * Every source is optional: unreadable means unknown, never "over budget".
 *
 * Levels: "constrained" at 75% of memory.high or under sustained pressure pauses background scans, auto-sends and
 * AI jobs; "critical" at 85% also stops non-essential RPC work. Transitions are logged.
 */
export class Governor {
  private last: Resources = { memoryPct: null, memoryBytes: null, memoryHighBytes: null, cpuPct: null, memoryPressure: null, cpuPressure: null, level: "ok", at: null };
  private cpu: { idle: number; total: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cgroup: Promise<string | null> | null = null;
  constructor(private read: Read = readText, private log: (line: string) => void = line => console.warn(line), private root = "/sys/fs/cgroup", private fallback = "/sys/fs/cgroup/system.slice/paseo.service") {}
  /** The memory-limited cgroup this process runs in: the nearest ancestor with a memory.high, else paseo.service. */
  private async group(): Promise<string | null> {
    this.cgroup ??= (async () => {
      const self = await this.read("/proc/self/cgroup").catch(() => "");
      const path = /^0::(\/.*)$/m.exec(self)?.[1];
      for (let dir = path; dir && dir !== "/"; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
        const full = join(this.root, dir);
        if (number(await this.read(join(full, "memory.high")).catch(() => null))) return full;
      }
      return number(await this.read(join(this.fallback, "memory.high")).catch(() => null)) ? this.fallback : null;
    })();
    return this.cgroup;
  }
  async sample(): Promise<Resources> {
    const group = await this.group();
    const [current, memStat, high, memPressure, stat, cpuPressure] = await Promise.all([
      group ? this.read(join(group, "memory.current")).catch(() => null) : null,
      group ? this.read(join(group, "memory.stat")).catch(() => null) : null,
      group ? this.read(join(group, "memory.high")).catch(() => null) : null,
      group ? this.read(join(group, "memory.pressure")).catch(() => null) : null,
      this.read("/proc/stat").catch(() => null),
      this.read("/proc/pressure/cpu").catch(() => null),
    ]);
    const memoryBytes = workingSet(number(current), memStat), memoryHighBytes = number(high);
    const memoryPct = memoryBytes && memoryHighBytes ? Math.round(memoryBytes / memoryHighBytes * 100) : null;
    let cpuPct: number | null = null;
    const fields = stat?.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
    if (fields && fields.length >= 4 && fields.every(Number.isFinite)) {
      const idle = fields[3] + (fields[4] ?? 0); const total = fields.reduce((a, b) => a + b, 0);
      if (this.cpu && total > this.cpu.total) cpuPct = Math.round((1 - (idle - this.cpu.idle) / (total - this.cpu.total)) * 100);
      this.cpu = { idle, total };
    }
    const next: Resources = { memoryPct, memoryBytes, memoryHighBytes, cpuPct: cpuPct ?? this.last.cpuPct, memoryPressure: pressure(memPressure), cpuPressure: pressure(cpuPressure), level: "ok", at: new Date().toISOString() };
    next.level = governorLevel(next);
    if (next.level !== this.last.level) this.log(`[follow-up] resource governor: ${this.last.level} → ${next.level} (memory ${memoryPct ?? "?"}% of memory.high, memory pressure ${next.memoryPressure ?? "?"}, cpu pressure ${next.cpuPressure ?? "?"})`);
    this.last = next;
    return next;
  }
  /** The last sample; a fresh one is taken every `ms` once started. */
  current(): Resources { return this.last; }
  level(): ResourceLevel { return this.last.level; }
  /** Background work (scans, auto-sends, AI jobs) waits while the VM is constrained. */
  allowsBackground(): boolean { return this.last.level === "ok"; }
  /** Non-essential RPC work stops when the VM is critical. */
  allowsExtras(): boolean { return this.last.level !== "critical"; }
  start(ms = 5_000): void {
    if (this.timer) return;
    void this.sample().catch(() => undefined);
    this.timer = setInterval(() => void this.sample().catch(() => undefined), ms);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
