/**
 * What the Paseo host says it can do, from the daemon's server_info `features` (the daemon client keeps the last one
 * it got while connecting: `getLastServerInfoMessage()`). Paseo 0.16 advertises `agentBackgroundWork`: it tracks an
 * agent's background shell jobs, shows them with Stop, and wakes the agent when one finishes. Follow-up retires Wait
 * there (docs/wait.md). Paseo 0.15 doesn't advertise it.
 *
 * The answer can't change without a daemon restart, which restarts this worker too, so the first real answer is
 * kept. A failed or empty read answers false (Wait stays as on 0.15) and is asked again next time.
 */
export type ServerInfo = { features?: Record<string, unknown> | null } | null | undefined;

export function hostFeature(feature: string, read: () => Promise<ServerInfo>): () => Promise<boolean> {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    let info: ServerInfo;
    try { info = await read(); } catch { return false; }
    if (!info) return false;
    return known = info.features?.[feature] === true;
  };
}
