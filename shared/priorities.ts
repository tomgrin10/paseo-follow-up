import { z } from "zod";

/**
 * Externally supplied priorities (1.3.0-beta.2). A ranker (the next build's Overseer, reading Linear, Slack and the
 * CPO's planning artifact) calls `set_priorities`; Home's Priority sort uses them while they're fresh. Follow-up never
 * makes one up: with none, or only stale ones, Priority falls back to urgency and says so.
 */
export const PRIORITY_SOURCES = ["linear", "slack", "planning", "github", "paseo"] as const;
export type PrioritySourceKind = typeof PRIORITY_SOURCES[number];
export const PRIORITY_SOURCE_LABEL: Record<PrioritySourceKind, string> = { linear: "Linear", slack: "Slack", planning: "Planning", github: "GitHub", paseo: "Paseo" };

export const prioritySourceSchema = z.strictObject({
  kind: z.enum(PRIORITY_SOURCES),
  label: z.string().trim().min(1).max(60),
  url: z.string().url().max(2000).optional(),
});
export const priorityInputSchema = z.strictObject({
  workspace: z.string().trim().min(1).max(200),
  score: z.number().int().min(0).max(100),
  /** One line, shown muted under the row. */
  reason: z.string().trim().min(1).max(140).refine(s => !/[\r\n]/.test(s), "reason is one line"),
  sources: z.array(prioritySourceSchema).max(5).default([]),
});
export const prioritySchema = z.object({
  workspaceId: z.string().min(1), score: z.number().int().min(0).max(100), reason: z.string(),
  sources: z.array(z.object({ kind: z.enum(PRIORITY_SOURCES), label: z.string(), url: z.string().optional() })),
  at: z.string(),
  /** Who set it: "agent:<id>". */
  by: z.string().optional(),
  /**
   * The Home row the ranker read (`agent:<id>` or `ws:<id>`). A workspace can have several rows (one per flagged root
   * agent), and the reason is about the one it was ranked from, so only that row shows it. Absent: set for the
   * workspace as a whole (set_priorities, or stored before 1.4.0-beta.34).
   */
  row: z.string().optional(),
});
export type Priority = z.infer<typeof prioritySchema>;
export const prioritiesFileSchema = z.object({ version: z.literal(1), items: z.array(prioritySchema) });
export type PrioritiesFile = z.infer<typeof prioritiesFileSchema>;

/** Priorities older than this don't steer the list. */
export const PRIORITY_FRESH_MS = 6 * 3_600_000;

/** The fresh priorities by workspace, and when the newest was ranked. */
export function freshPriorities(items: readonly Priority[], now: number): { byWorkspace: Map<string, Priority>; rankedAt: string | null } {
  const byWorkspace = new Map<string, Priority>();
  let rankedAt: string | null = null;
  for (const p of items) {
    const t = Date.parse(p.at);
    if (!Number.isFinite(t) || now - t >= PRIORITY_FRESH_MS || t - now > 5 * 60_000) continue;
    const prior = byWorkspace.get(p.workspaceId);
    if (!prior || prior.at < p.at) byWorkspace.set(p.workspaceId, p);
    if (!rankedAt || p.at > rankedAt) rankedAt = p.at;
  }
  return { byWorkspace, rankedAt };
}

/**
 * The one row that shows a priority's reason, out of its workspace's rows: the row it was ranked from; else (a
 * priority for the whole workspace) its only row, the workspace's own row, or its main agent's row. A ranked row
 * that's gone shows it nowhere: that reason described a row the developer no longer sees, and the next ranking runs
 * because the rows changed. The score still orders every row of the workspace; only the line has one owner.
 */
export function priorityRow(p: Pick<Priority, "workspaceId" | "row">, rows: readonly { key: string; agentId: string | null }[], mainAgentId: string | null = null): string | null {
  if (p.row) return rows.some(r => r.key === p.row) ? p.row : null;
  if (rows.length === 1) return rows[0].key;
  return rows.find(r => r.key === `ws:${p.workspaceId}`)?.key ?? (mainAgentId ? rows.find(r => r.agentId === mainAgentId)?.key ?? null : null);
}

/** Merge a ranker's batch into the stored list: newest per workspace wins; `replace` drops the ones it didn't list. */
export function mergePriorities(current: readonly Priority[], batch: readonly Priority[], replace: boolean): Priority[] {
  const by = new Map<string, Priority>(replace ? [] : current.map(p => [p.workspaceId, p]));
  for (const p of batch) by.set(p.workspaceId, p);
  return [...by.values()].sort((a, b) => b.score - a.score || a.workspaceId.localeCompare(b.workspaceId));
}

/** The header note for the Priority sort: "Ranked 12m ago" with fresh priorities, else "By urgency". */
export function priorityNote(rankedAt: string | null, now: number): string {
  if (!rankedAt) return "By urgency";
  const m = Math.max(0, Math.round((now - Date.parse(rankedAt)) / 60_000));
  return m < 1 ? "Ranked just now" : m < 60 ? `Ranked ${m}m ago` : `Ranked ${Math.floor(m / 60)}h ago`;
}
