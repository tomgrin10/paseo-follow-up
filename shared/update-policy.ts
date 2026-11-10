/**
 * When Follow-up may replace itself, and whether a new version stuck. Pure: callers pass what they observed.
 *
 * A plugin reload detaches Follow-up's native tools from every open agent session until it reopens, so an update
 * waits for a quiet moment: no agent mid-turn and no Follow-up work in flight, for `quietMs` in a row. After
 * `capMs` of waiting it settles for any idle moment, so a busy machine still updates within a day or so.
 */

export const QUIET_MS = 5 * 60_000;
export const CAP_MS = 24 * 60 * 60_000;

export type Busy =
  | { kind: "agent"; count: number }
  | { kind: "ranker" } | { kind: "about" } | { kind: "pr-action"; count: number } | { kind: "repair"; count: number };

export type QuietInput = {
  now: number;
  /** When this update became ready to install (found, verified, allowed by the mode). */
  readySince: number;
  /** The last time anything below was busy; null when nothing has been busy since `readySince`. */
  lastBusyAt: number | null;
  /** What is busy right now. Agent status comes from Paseo's agent list, never from timelines. */
  busy: readonly Busy[];
  quietMs?: number;
  capMs?: number;
};
export type QuietDecision =
  | { install: true; why: "quiet" | "cap" }
  | { install: false; why: "busy"; busy: readonly Busy[]; capped: boolean }
  /** Idle, but not for long enough yet; `at` is when it will be. */
  | { install: false; why: "settling"; at: number };

export function quietWindow({ now, readySince, lastBusyAt, busy, quietMs = QUIET_MS, capMs = CAP_MS }: QuietInput): QuietDecision {
  const capped = now - readySince >= capMs;
  if (busy.length) return { install: false, why: "busy", busy, capped };
  if (capped) return { install: true, why: "cap" };
  const quietFrom = Math.max(readySince, lastBusyAt ?? readySince);
  // Waiting starts quiet: an update found while nothing ran still waits `quietMs`, so a turn about to start can.
  if (now - quietFrom >= quietMs) return { install: true, why: "quiet" };
  return { install: false, why: "settling", at: quietFrom + quietMs };
}

/** Agents that count as mid-turn: running ones Follow-up attached tools to. Archived and closed agents never count. */
export function busyAgents(agents: readonly { status: string; archivedAt?: string | null; hasFollowTools: boolean }[]): number {
  return agents.filter(a => a.hasFollowTools && !a.archivedAt && a.status === "running").length;
}

/** "2 agents are mid-turn", "the priority ranker is running": what Settings says it's waiting on. */
export function busyText(busy: readonly Busy[]): string {
  const parts = busy.map(b => {
    switch (b.kind) {
      case "agent": return b.count === 1 ? "1 agent is mid-turn" : `${b.count} agents are mid-turn`;
      case "ranker": return "the priority ranker is running";
      case "about": return "an overview is being written";
      case "pr-action": return b.count === 1 ? "a PR action is finishing" : `${b.count} PR actions are finishing`;
      case "repair": return b.count === 1 ? "a repair batch is being sent" : `${b.count} repair batches are being sent`;
    }
  });
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Probation (did the new version stick) lives in server/update-watchdog.mjs: the detached installer runs it.
