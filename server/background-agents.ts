/**
 * Paseo 0.16 background agents (`background: true` at creation): helpers another plugin runs for itself, with no
 * tab, no notifications and no sidebar row. Follow-up gives them no root-agent treatment: no action tools, no Wait,
 * no needs_you or Stop-hook nudge, no inbox rows and no directory row. Paseo sends the flag only in the agent
 * snapshot (fetch_agent / agents.ref(id).refresh()), not in lifecycle events or session_open, so callers read it from
 * a snapshot they already have or from one refresh. On Paseo 0.15 the field is absent and nothing changes.
 */
export const isBackgroundAgent = (agent: { background?: unknown } | null | undefined): boolean => agent?.background === true;

/** Whether an agent is a background agent, read once per agent: the flag is fixed when the agent is created. */
export class BackgroundAgents {
  private known = new Map<string, boolean>();
  constructor(private limit = 2000) {}
  async check(agentId: string, refresh: (id: string) => Promise<{ background?: unknown } | null | undefined>): Promise<boolean> {
    const known = this.known.get(agentId);
    if (known !== undefined) return known;
    let snapshot;
    // Unknown is not background: a failed read keeps today's behaviour and is asked again next time.
    try { snapshot = await refresh(agentId); } catch { return false; }
    if (snapshot === null || snapshot === undefined) return false;
    const background = isBackgroundAgent(snapshot);
    if (this.known.size >= this.limit) this.known.delete(this.known.keys().next().value!);
    this.known.set(agentId, background);
    return background;
  }
}
