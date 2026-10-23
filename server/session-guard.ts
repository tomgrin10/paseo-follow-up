import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const pauseSchema = z.object({
  id: z.string(), agentId: z.string(), workspaceId: z.string().optional(),
  phase: z.enum(["pausing", "waiting", "resuming", "attention", "resumed", "cancelled"]),
  turnId: z.string().nullable().optional(), pausedAt: z.string().optional(), settledAt: z.string().nullable().optional(),
  stoppedByUser: z.boolean().optional(), dismissed: z.boolean().optional(),
  suspension: z.unknown().optional(),
});
const stateSchema = z.object({ version: z.literal(1), pauses: z.array(pauseSchema) });
export type GuardPause = z.infer<typeof pauseSchema>;
export type GuardScope = { agentIds: string[]; workspaceId?: string; excludedAgentIds?: string[] };
const pending = (p: GuardPause) => ["pausing", "waiting", "resuming", "attention"].includes(p.phase);

export class SessionGuard {
  constructor(private directory: string, private now = Date.now) {}
  async read(): Promise<GuardPause[] | null> {
    try { return stateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"))).pauses; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Session Guard state is unavailable; follow-up will wait and retry.");
    }
  }
  waiting(pauses: GuardPause[] | null, scope: GuardScope): GuardPause | undefined {
    return pauses?.find(p => !scope.excludedAgentIds?.includes(p.agentId) &&
      (scope.agentIds.includes(p.agentId) || !!scope.workspaceId && p.workspaceId === scope.workspaceId) &&
      (pending(p) || p.phase === "resumed" && (!p.settledAt || !Number.isFinite(Date.parse(p.settledAt)) || this.now() - Date.parse(p.settledAt) < 5_000)));
  }
  ownsInterruption(pauses: GuardPause[] | null, agentId: string, interruption?: { turnId: string | null; at: string; kind?: "canceled" | "failed" }): GuardPause | undefined {
    if (!interruption?.turnId) return;
    return pauses?.find(p => p.agentId === agentId && p.turnId === interruption.turnId && !p.stoppedByUser && !p.dismissed &&
      !(interruption.kind === "canceled" && (p.suspension || p.phase === "resumed")) &&
      (pending(p) || p.phase === "resumed") && !!p.pausedAt && Math.abs(Date.parse(p.pausedAt) - Date.parse(interruption.at)) <= 60_000);
  }
}
