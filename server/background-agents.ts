import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Paseo 0.16 background agents (`background: true` at creation): helpers another plugin runs for itself, with no
 * tab, no notifications and no sidebar row. Follow-up gives them no root-agent treatment: no action tools, no Wait,
 * no needs_you or Stop-hook nudge, no inbox rows and no directory row. Paseo sends the flag only in the agent
 * snapshot (fetch_agent / agents.ref(id).refresh()), not in lifecycle events or session_open, so callers read it from
 * a snapshot they already have or from one refresh. On Paseo 0.15 the field is absent and nothing changes.
 */
export const isBackgroundAgent = (agent: { background?: unknown } | null | undefined): boolean => agent?.background === true;

/**
 * Whether an agent is a background agent. Only "yes" is remembered (the flag is fixed when the agent is created):
 * on Paseo 0.16 a brand-new agent's snapshot doesn't exist yet at session_open, so an early "no" must not stick.
 * `onFound` hears each agent the first time it turns out to be a background agent.
 */
export class BackgroundAgents {
  private known = new Set<string>();
  constructor(private onFound: (agentId: string) => void | Promise<void> = () => {}, private limit = 2000) {}
  async check(agentId: string, refresh: (id: string) => Promise<{ background?: unknown } | null | undefined>): Promise<boolean> {
    if (this.known.has(agentId)) return true;
    let snapshot;
    // Unknown is not background: a failed read keeps today's behaviour and is asked again next time.
    try { snapshot = await refresh(agentId); } catch { return false; }
    if (!isBackgroundAgent(snapshot)) return false;
    if (this.known.size >= this.limit) this.known.delete(this.known.values().next().value!);
    this.known.add(agentId);
    await this.onFound(agentId);
    return true;
  }
  get ids() { return [...this.known]; }
  /** Agents found before a restart (background-agents.json), so the hook keeps skipping them. */
  seed(ids: unknown) { if (Array.isArray(ids)) for (const id of ids.slice(-this.limit)) if (typeof id === "string") this.known.add(id); }
}

/** background-agents.json, which the agent hook reads so a helper's turns get no context and no Stop-hook nudge. */
export function backgroundAgentsFile(directory: string, agents: () => string[]) {
  let writing = Promise.resolve();
  return () => {
    writing = writing.then(async () => {
      const temporary = join(directory, `background-agents.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ version: 1, agents: agents() }), { mode: 0o600 });
      await rename(temporary, join(directory, "background-agents.json"));
    }).catch(() => undefined);
    return writing;
  };
}
