import type { Workspace } from "../shared/model";
import type { Agent, Daemon } from "./daemon";

async function userMessages(client: Daemon, agentId: string): Promise<string[]> {
  const entries: { item: unknown; seqStart: number }[] = [];
  let cursor: { epoch: string; seq: number } | null = null;
  for (let i = 0; i < 100; i++) {
    const page = await client.fetchAgentTimeline(agentId, { direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: 500, projection: "canonical", timeout: 15_000 });
    if (page.error || page.gap || page.staleCursor) throw new Error("Recovery handoff history is unavailable");
    entries.push(...page.entries);
    if (!page.hasOlder) return entries.sort((a, b) => a.seqStart - b.seqStart).flatMap(e => {
      const item = e.item as { type?: string; text?: string };
      return item.type === "user_message" && typeof item.text === "string" ? [item.text] : [];
    });
    if (!page.startCursor || (cursor && page.startCursor.epoch === cursor.epoch && page.startCursor.seq >= cursor.seq)) throw new Error("Recovery handoff history is incomplete");
    cursor = page.startCursor;
  }
  throw new Error("Recovery handoff history exceeded the recovery window");
}

export async function recoveryHandoff(client: Daemon, w: Workspace, caller: Agent): Promise<{ batchId: string; fromAgentId: string } | null> {
  if (!w.enable_tracking || w.archived || caller.archivedAt || caller.workspaceId !== w.id || caller.id === w.mainAgentId || caller.labels["paseo.parent-agent-id"]) return null;
  const candidates = w.batches.filter(b => b.recipientAgentId && b.recipientAgentId !== w.mainAgentId && b.recipientAgentId !== caller.id && b.tasks.every(t => t.kind === "inventory") && ["sending", "sent", "uncertain", "blocked"].includes(b.state) && !b.settledAt);
  if (!candidates.length) return null;
  const initialTask = (await userMessages(client, caller.id))[0];
  if (!initialTask) return null;
  for (const b of candidates) {
    if (!initialTask.startsWith(`Follow-through recovery ${b.id}\n`)) continue;
    const prior = (await client.fetchAgent(b.recipientAgentId!))?.agent;
    if (!prior?.archivedAt || prior.workspaceId !== w.id || Date.parse(caller.createdAt) < Date.parse(b.sentAt ?? b.createdAt)) continue;
    // An archived recipient plus the exact initial user task proves a handoff, not a historical mention.
    if ((await userMessages(client, prior.id)).includes(initialTask)) return { batchId: b.id, fromAgentId: prior.id };
  }
  return null;
}
