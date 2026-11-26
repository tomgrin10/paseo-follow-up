import type { MessageQueue, Resolution } from "./message-queue";
import type { QueueItem } from "../shared/queue";
import type { State, Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { pendingAt, scheduledText } from "../shared/task-trigger";

/** What the channel needs to know about the agent when the message goes: nothing here loads it. */
export type ScheduledAgent = { status: string; archived: boolean; workspaceId: string | null } | null;
export const scheduledItemId = (workspaceId: string, obligationId: string, at: string) => `scheduled:${workspaceId}:${obligationId}:${at}`;
/** Why a time trigger didn't go out, as the task row says it ("Not sent · the agent was archived"). */
export const NOT_SENT = { archived: "the agent was archived", closed: "the agent was closed", workspace: "the workspace was archived", none: "the workspace has no main agent" } as const;

/**
 * Scheduled tasks (a-scheduled-task-arrives-once-at-its-time): a task whose trigger is a time goes to its main agent
 * once, at that time, whether Auto-send is on or not: someone named the time (the developer in the sheet, or the agent
 * for its own check-back). `evaluate` runs after each engine pass, whose untouched-pass skip already ends at the
 * earliest due time (engine nextDue), so it fires within a tick and never before. A due trigger is saved as one
 * `scheduled` queue message first (a-message-is-saved-before-sent-and-arrives-once) and then marked `queuedAt` on the
 * task, so a crash between the two re-enqueues the same id, which the queue returns as it is. A closed or archived
 * agent gets nothing, and the task row says why (`notSent`); a worker down at the time fires once, late, on its first
 * pass. The channel resolves the agent when it goes, waits for a running turn to end, and sends to an idle one even
 * when Paseo unloaded it: it asked for this message, as with wait_for_checks (the one exception to invariant 1).
 */
export class ScheduledTasks {
  private queue: MessageQueue | null = null;
  /** Fired triggers (tests). */
  readonly fired: { workspaceId: string; obligationId: string; at: string; sent: boolean; why: string }[] = [];
  constructor(private deps: {
    snapshot: () => Promise<State>;
    mutateWorkspace: (id: string, work: (w: Workspace) => void) => Promise<unknown>;
    agent: (agentId: string) => Promise<ScheduledAgent>;
    now?: () => number;
  }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** After an engine pass: every due time trigger in those workspaces (all when `ids` is absent). */
  async evaluate(ids?: ReadonlySet<string>): Promise<void> {
    const state = await this.deps.snapshot();
    const now = this.now();
    for (const w of state.workspaces) {
      if (ids && !ids.has(w.id) || !w.enable_tracking) continue;
      const due = followUpObligations(w).filter(o => o.enable_follow_up && !["done", "waived"].includes(o.status) && pendingAt(o.trigger) && Date.parse(o.trigger!.at!) <= now);
      for (const o of due) await this.fire(w, o.id, o.trigger!.at!, now);
    }
  }

  private async fire(w: Workspace, obligationId: string, at: string, now: number): Promise<void> {
    const o = w.obligations.find(x => x.id === obligationId)!;
    const agent = w.archived ? null : await this.deps.agent(w.mainAgentId).catch(() => undefined);
    // Unknown (Paseo unreachable): try on the next pass; never a guess either way.
    if (agent === undefined) return;
    const why = w.archived ? NOT_SENT.workspace : !w.mainAgentId ? NOT_SENT.none : !agent || agent.archived ? NOT_SENT.archived : agent.status === "closed" ? NOT_SENT.closed : null;
    if (!why && this.queue) {
      this.queue.enqueue({ id: scheduledItemId(w.id, o.id, at), kind: "scheduled", key: w.id, ref: { workspaceId: w.id, obligationId: o.id, agentId: w.mainAgentId, at },
        messageId: `scheduled-${o.id}-${Date.parse(at).toString(36)}`, text: scheduledText(o, at, now), priority: "now", state: "queued" });
    }
    if (!why && !this.queue) return;
    await this.mark(w.id, o.id, at, t => { if (why) t.notSent = why; else t.queuedAt = new Date(now).toISOString(); });
    this.fired.push({ workspaceId: w.id, obligationId: o.id, at, sent: !why, why: why ?? "queued" });
  }

  /** Writes onto the task's trigger only while it is still the same time (an edit since wins). */
  private async mark(workspaceId: string, obligationId: string, at: string, edit: (t: NonNullable<Workspace["obligations"][number]["trigger"]>) => void): Promise<void> {
    await this.deps.mutateWorkspace(workspaceId, w => {
      const o = w.obligations.find(x => x.id === obligationId);
      if (o?.trigger?.event === "at" && o.trigger.at === at) edit(o.trigger);
    }).catch(error => console.warn(`[follow-up] couldn't record a scheduled task: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The queue's `scheduled` channel: the main agent, resolved when it goes; never woken from closed or archived. */
  attachQueue(queue: MessageQueue): void {
    this.queue = queue;
    queue.register("scheduled", {
      resolve: async (item): Promise<Resolution> => {
        let agent: ScheduledAgent;
        try { agent = await this.deps.agent(item.ref.agentId!); }
        catch { return { defer: "Paseo unreachable" }; }
        if (!agent || agent.archived) return { cancel: NOT_SENT.archived };
        if (agent.status === "closed") return { cancel: NOT_SENT.closed };
        if (item.state === "queued" && ["running", "initializing"].includes(agent.status)) return { defer: "waits for the agent's turn to end" };
        return { target: { workspaceId: agent.workspaceId, recipients: [item.ref.agentId!] } };
      },
      // The task row mirrors the message: Sent once it left, Not sent (and why) if it was cancelled.
      project: async (item: QueueItem) => {
        const { workspaceId, obligationId, at } = item.ref;
        if (!workspaceId || !obligationId || !at) return;
        if (item.state === "sent") await this.mark(workspaceId, obligationId, at, t => { t.sentAt = item.envelope?.at ?? new Date(this.now()).toISOString(); });
        else if (item.state === "cancelled") await this.mark(workspaceId, obligationId, at, t => { t.notSent = (item.reason ?? "it was cancelled").slice(0, 200); });
      },
    });
  }
}
